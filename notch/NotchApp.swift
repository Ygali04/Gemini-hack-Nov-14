import Cocoa
import WebKit
import QuartzCore
import UniformTypeIdentifiers
import Carbon

// Option-Space reaches the delegate through this pointer (a Carbon handler cannot capture).
nonisolated(unsafe) weak var hotkeyTarget: AppDelegate?

// A web view that accepts the first click (notifications work without focusing first) and turns dropped
// Finder files into real paths for the page (WebKit alone hides paths from the page).
@MainActor
final class ShellWebView: WKWebView {
    var onFiles: (([[String: String]]) -> Void)?
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        let urls = sender.draggingPasteboard.readObjects(forClasses: [NSURL.self],
                                                         options: [.urlReadingFileURLsOnly: true]) as? [URL] ?? []
        if let onFiles, !urls.isEmpty {
            onFiles(urls.map { ["name": $0.lastPathComponent, "path": $0.path] })
            return true
        }
        return super.performDragOperation(sender)
    }
}

@MainActor
final class ChatWindow {
    let panel: NotchPanel
    let web: ShellWebView
    var open = true
    init(panel: NotchPanel, web: ShellWebView) { self.panel = panel; self.web = web }
}

@MainActor
final class NotchPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKScriptMessageHandler {
    private var statusItem: NSStatusItem!
    private var panel: NotchPanel!
    private var webView: WKWebView!
    private var workspaceWindow: NSWindow?
    private var workspaceWebView: WKWebView?
    private var sharedContentController: WKUserContentController!
    private var notesPanel: NotchPanel!
    private var notesWeb: ShellWebView!
    private var notesHeight: CGFloat = 0
    private var chats: [String: ChatWindow] = [:]
    private var allHidden = false
    private var expanded = false
    private var prevApp: NSRunningApplication?
    private var currentSize = NSSize(width: 280, height: 36)

    // Session-only connection state (never persisted to disk)
    private var connectionBaseURL: URL?
    private var connectionToken: String?

    private lazy var uiFileURL: URL? = resolveUIFileURL()

    func applicationDidFinishLaunching(_ notification: Notification) {
        if let envURL = ProcessInfo.processInfo.environment["CA_URL"], !envURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            _ = applyConnectionString(envURL)
        }
        setupStatusItem()
        setupPanel()
        setupNotes()
        hotkeyTarget = self
        registerHotKey()
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(screenParametersDidChange(_:)),
            name: NSApplication.didChangeScreenParametersNotification,
            object: nil
        )
        loadPage()
    }

    private func resolveUIFileURL() -> URL? {
        let fm = FileManager.default
        var candidates: [URL] = []

        if let envPath = ProcessInfo.processInfo.environment["UI_FILE"], !envPath.isEmpty {
            candidates.append(URL(fileURLWithPath: envPath))
        }

        let cwd = URL(fileURLWithPath: fm.currentDirectoryPath, isDirectory: true)
        candidates.append(cwd.appendingPathComponent("ui/index.html"))

        if let execURL = Bundle.main.executableURL {
            let execDir = execURL.deletingLastPathComponent()
            candidates.append(execDir.appendingPathComponent("../../ui/index.html").standardizedFileURL)
            candidates.append(execDir.appendingPathComponent("../ui/index.html").standardizedFileURL)
            candidates.append(execDir.appendingPathComponent("ui/index.html").standardizedFileURL)
        }

        for candidate in candidates {
            if fm.fileExists(atPath: candidate.path) {
                return candidate
            }
        }
        return nil
    }

    private func applyConnectionString(_ raw: String) -> (ok: Bool, error: String?) {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              let components = URLComponents(string: trimmed),
              let scheme = components.scheme?.lowercased(),
              (scheme == "http" || scheme == "https"),
              let host = components.host, !host.isEmpty else {
            return (false, "Invalid address")
        }

        let token = components.queryItems?.first(where: { $0.name == "t" })?.value ?? ""
        guard !token.isEmpty else {
            return (false, "Missing ?t= token")
        }

        var baseComp = URLComponents()
        baseComp.scheme = scheme
        baseComp.host = host
        baseComp.port = components.port
        guard let base = baseComp.url else {
            return (false, "Invalid base URL")
        }

        connectionBaseURL = base
        connectionToken = token
        return (true, nil)
    }

    private func setupStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let button = statusItem.button {
            button.image = NSImage(systemSymbolName: "sparkles", accessibilityDescription: "Agent Workspace")
        }

        let menu = NSMenu()
        let toggleItem = NSMenuItem(title: "Show/Hide", action: #selector(togglePanel(_:)), keyEquivalent: "")
        toggleItem.target = self
        menu.addItem(toggleItem)

        let reloadItem = NSMenuItem(title: "Reload", action: #selector(reloadPage(_:)), keyEquivalent: "r")
        reloadItem.target = self
        menu.addItem(reloadItem)

        menu.addItem(.separator())

        let quitItem = NSMenuItem(title: "Quit", action: #selector(quitApp(_:)), keyEquivalent: "q")
        quitItem.target = self
        menu.addItem(quitItem)

        statusItem.menu = menu
    }

    private func topCenteredFrame(for size: NSSize) -> NSRect {
        let screen = NSScreen.main ?? NSScreen.screens.first
        let screenFrame = screen?.frame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let x = round(screenFrame.midX - (size.width / 2.0))
        let y = round(screenFrame.maxY - size.height)
        return NSRect(x: x, y: y, width: size.width, height: size.height)
    }

    private func setupPanel() {
        let initialFrame = topCenteredFrame(for: currentSize)
        panel = NotchPanel(
            contentRect: initialFrame,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.hidesOnDeactivate = false
        panel.isMovable = false

        sharedContentController = WKUserContentController()
        sharedContentController.add(self, name: "shell")

        let config = WKWebViewConfiguration()
        config.userContentController = sharedContentController

        let notchWeb = ShellWebView(frame: NSRect(origin: .zero, size: currentSize), configuration: config)
        notchWeb.onFiles = { [weak self, weak notchWeb] files in
            self?.postToWeb(["type": "filesDropped", "files": files], to: notchWeb)
        }
        webView = notchWeb
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self
        webView.setValue(false, forKey: "drawsBackground")

        panel.contentView = webView
        panel.orderFrontRegardless()
    }

    private func loadPage() {
        guard let fileURL = uiFileURL else {
            let html = "<!doctype html><html><body style='background:#0c0d10;color:#f2f4f8;font:13px -apple-system;padding:12px;'>ui/index.html not found</body></html>"
            webView.loadHTMLString(html, baseURL: nil)
            return
        }

        var components = URLComponents(url: fileURL, resolvingAgainstBaseURL: false)
        var queryItems = [URLQueryItem(name: "shell", value: "notch")]
        if let fixture = ProcessInfo.processInfo.environment["CA_FIXTURE"], !fixture.isEmpty {
            queryItems.append(URLQueryItem(name: "fixture", value: fixture))
        }
        components?.queryItems = queryItems
        let targetURL = components?.url ?? fileURL
        let readRoot = fileURL.deletingLastPathComponent()
        webView.loadFileURL(targetURL, allowingReadAccessTo: readRoot)
    }

    private func postToWeb(_ payload: [String: Any], to target: WKWebView? = nil) {
        guard let data = try? JSONSerialization.data(withJSONObject: payload, options: []),
              let json = String(data: data, encoding: .utf8) else {
            return
        }
        let script = "window.__notchBridgeReceive && window.__notchBridgeReceive(\(json));"
        let destination = target ?? webView
        destination?.evaluateJavaScript(script, completionHandler: nil)
    }

    private func broadcastToWeb(_ payload: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: payload, options: []),
              let json = String(data: data, encoding: .utf8) else {
            return
        }
        let script = "window.__notchBridgeReceive && window.__notchBridgeReceive(\(json));"
        webView?.evaluateJavaScript(script, completionHandler: nil)
        workspaceWebView?.evaluateJavaScript(script, completionHandler: nil)
        notesWeb?.evaluateJavaScript(script, completionHandler: nil)
        chats.values.forEach { $0.web.evaluateJavaScript(script, completionHandler: nil) }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "shell",
              let body = message.body as? [String: Any],
              let type = body["type"] as? String else {
            return
        }
        let senderWebView = message.webView ?? webView

        switch type {
        case "resize" where senderWebView === notesWeb:
            let h = CGFloat((body["height"] as? NSNumber)?.doubleValue ?? 0)
            layoutNotes(height: h, fresh: body["fresh"] as? Bool ?? false)
        case "resize":
            guard senderWebView === webView else { return }
            handleResize(body)
        case "openChat":
            if let run = body["run"] as? String, !run.isEmpty { openChat(run) }
        case "closeWindow":
            for c in chats.values where c.web === senderWebView { c.open = false; c.panel.orderOut(nil) }
        case "getConfig":
            postToWeb([
                "type": "config",
                "id": body["id"] as? String ?? "",
                "connected": (connectionBaseURL != nil && connectionToken != nil),
                "baseUrl": connectionBaseURL?.absoluteString ?? ""
            ], to: senderWebView)
        case "setConnection":
            let rawURL = body["url"] as? String ?? ""
            let result = applyConnectionString(rawURL)
            broadcastToWeb([
                "type": "connectionUpdated",
                "id": body["id"] as? String ?? "",
                "ok": result.ok,
                "baseUrl": connectionBaseURL?.absoluteString ?? "",
                "error": result.error ?? ""
            ])
        case "http":
            handleHTTP(body, to: senderWebView)
        case "pickFiles":
            handlePickFiles(body, to: senderWebView)
        case "readFixture":
            handleReadFixture(body, to: senderWebView)
        case "openWorkspace":
            handleOpenWorkspace(body, to: senderWebView)
        default:
            break
        }
    }

    private func handleOpenWorkspace(_ body: [String: Any], to senderWebView: WKWebView?) {
        let reqId = body["id"] as? String ?? ""
        let reqFixture = (body["fixture"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let envFixture = ProcessInfo.processInfo.environment["CA_FIXTURE"]?.trimmingCharacters(in: .whitespacesAndNewlines)
        let fixtureName = (reqFixture?.isEmpty == false ? reqFixture : (envFixture?.isEmpty == false ? envFixture : nil))

        if workspaceWindow == nil || workspaceWebView == nil {
            let initialRect = NSRect(x: 0, y: 0, width: 960, height: 680)
            let win = NSWindow(
                contentRect: initialRect,
                styleMask: [.titled, .closable, .miniaturizable, .resizable],
                backing: .buffered,
                defer: false
            )
            win.title = "Agent Workspace"
            win.minSize = NSSize(width: 640, height: 480)
            win.isReleasedWhenClosed = false
            win.center()

            let config = WKWebViewConfiguration()
            config.userContentController = sharedContentController

            let wv = WKWebView(frame: NSRect(origin: .zero, size: initialRect.size), configuration: config)
            wv.autoresizingMask = [.width, .height]
            wv.navigationDelegate = self
            win.contentView = wv

            workspaceWindow = win
            workspaceWebView = wv
        }

        if let workspaceWebView = workspaceWebView {
            if let indexURL = uiFileURL {
                let uiDir = indexURL.deletingLastPathComponent()
                let wsFileURL = uiDir.appendingPathComponent("workspace.html")
                if FileManager.default.fileExists(atPath: wsFileURL.path) {
                    var components = URLComponents(url: wsFileURL, resolvingAgainstBaseURL: false)
                    var queryItems = [URLQueryItem(name: "shell", value: "notch")]
                    if let fixtureName = fixtureName {
                        queryItems.append(URLQueryItem(name: "fixture", value: fixtureName))
                    }
                    components?.queryItems = queryItems
                    let targetURL = components?.url ?? wsFileURL
                    if workspaceWebView.url?.standardizedFileURL != targetURL.standardizedFileURL {
                        workspaceWebView.loadFileURL(targetURL, allowingReadAccessTo: uiDir)
                    }
                } else {
                    let html = "<!doctype html><html><body style='background:#f6f7f8;color:#111418;font:14px -apple-system;padding:24px;'>ui/workspace.html is not present yet.</body></html>"
                    workspaceWebView.loadHTMLString(html, baseURL: nil)
                }
            } else {
                let html = "<!doctype html><html><body style='background:#f6f7f8;color:#111418;font:14px -apple-system;padding:24px;'>ui/ directory not found.</body></html>"
                workspaceWebView.loadHTMLString(html, baseURL: nil)
            }
        }

        NSApp.activate(ignoringOtherApps: true)
        workspaceWindow?.makeKeyAndOrderFront(nil)
        postToWeb([
            "type": "workspaceOpened",
            "id": reqId,
            "ok": true
        ], to: senderWebView)
    }

    private func handleResize(_ body: [String: Any]) {
        let rawWidth = (body["width"] as? NSNumber)?.doubleValue ?? Double(currentSize.width)
        let rawHeight = (body["height"] as? NSNumber)?.doubleValue ?? Double(currentSize.height)
        let state = body["state"] as? String ?? ""
        let instant = (body["instant"] as? Bool) ?? false

        let clampedWidth = CGFloat(min(max(rawWidth, 200.0), 640.0))
        let clampedHeight = CGFloat(min(max(rawHeight, 32.0), 640.0))
        currentSize = NSSize(width: clampedWidth, height: clampedHeight)

        let targetFrame = topCenteredFrame(for: currentSize)
        if instant {
            panel.setFrame(targetFrame, display: true)
        } else {
            let duration = (state == "collapsed") ? 0.117 : 0.18
            NSAnimationContext.runAnimationGroup { context in
                context.duration = duration
                context.timingFunction = CAMediaTimingFunction(controlPoints: 0.22, 1.0, 0.36, 1.0)
                panel.animator().setFrame(targetFrame, display: true)
            }
        }

        let wasExpanded = expanded
        expanded = (state == "expanded")
        if state == "expanded" {
            if !wasExpanded { rememberFrontApp() }
            NSApp.activate(ignoringOtherApps: true)
            panel.makeKeyAndOrderFront(nil)
        } else if wasExpanded {
            returnFocus()
        }
    }

    // MARK: Option-Space, chat windows, notifications

    private func makeWebView(_ size: NSSize) -> ShellWebView {
        let config = WKWebViewConfiguration()
        config.userContentController = sharedContentController
        let wv = ShellWebView(frame: NSRect(origin: .zero, size: size), configuration: config)
        wv.autoresizingMask = [.width, .height]
        wv.navigationDelegate = self
        wv.setValue(false, forKey: "drawsBackground")
        return wv
    }

    private func loadView(_ wv: WKWebView, _ items: [URLQueryItem]) {
        guard let fileURL = uiFileURL, var components = URLComponents(url: fileURL, resolvingAgainstBaseURL: false) else { return }
        components.queryItems = items
        wv.loadFileURL(components.url ?? fileURL, allowingReadAccessTo: fileURL.deletingLastPathComponent())
    }

    private func floatingPanel(_ frame: NSRect, level: NSWindow.Level) -> NotchPanel {
        let p = NotchPanel(contentRect: frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        p.level = level
        p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        p.isOpaque = false
        p.backgroundColor = .clear
        p.hasShadow = true
        p.hidesOnDeactivate = false
        p.isReleasedWhenClosed = false
        return p
    }

    // Persistent notifications, stacked at the top left of the main screen.
    private func setupNotes() {
        let vis = (NSScreen.main ?? NSScreen.screens[0]).visibleFrame
        notesPanel = floatingPanel(NSRect(x: vis.minX + 12, y: vis.maxY - 8, width: 320, height: 1), level: .statusBar)
        notesPanel.hasShadow = false  // each card draws its own edge
        notesWeb = makeWebView(NSSize(width: 320, height: 1))
        notesPanel.contentView = notesWeb
        loadView(notesWeb, [URLQueryItem(name: "shell", value: "notes")])
    }

    private func layoutNotes(height: CGFloat, fresh: Bool) {
        notesHeight = height
        guard height > 0 else { notesPanel.orderOut(nil); return }
        let vis = (NSScreen.main ?? NSScreen.screens[0]).visibleFrame
        let h = min(height, vis.height - 40)
        notesPanel.setFrame(NSRect(x: vis.minX + 12, y: vis.maxY - 8 - h, width: 320, height: h), display: true)
        if !allHidden || fresh { notesPanel.orderFrontRegardless() }  // a new notification shows itself
    }

    // One floating chat window per conversation, cascading down from the top right.
    private func openChat(_ run: String) {
        if let c = chats[run] {
            c.open = true
            c.panel.orderFrontRegardless()
            return
        }
        let vis = (NSScreen.main ?? NSScreen.screens[0]).visibleFrame
        let k = CGFloat(chats.count % 6)
        let size = NSSize(width: 420, height: 540)
        let frame = NSRect(x: vis.maxX - size.width - 16 - 28 * k, y: vis.maxY - size.height - 48 - 28 * k,
                           width: size.width, height: size.height)
        let p = floatingPanel(frame, level: .floating)
        let wv = makeWebView(size)
        p.contentView = wv
        loadView(wv, [URLQueryItem(name: "shell", value: "chat"), URLQueryItem(name: "run", value: run)])
        chats[run] = ChatWindow(panel: p, web: wv)
        p.orderFrontRegardless()
    }

    // Option-Space: show everything and focus the prompt; again: hide everything.
    private func registerHotKey() {
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, _, _ in
            MainActor.assumeIsolated { hotkeyTarget?.toggleAll() }
            return noErr
        }, 1, &spec, nil, nil)
        var ref: EventHotKeyRef?
        let id = EventHotKeyID(signature: OSType(0x4341_4E59), id: 1)
        let status = RegisterEventHotKey(UInt32(kVK_Space), UInt32(optionKey), id, GetApplicationEventTarget(), 0, &ref)
        if status != noErr { NSLog("Option-Space is taken by another app (status %d)", status) }
    }

    func toggleAll() {
        if allHidden || !expanded {
            allHidden = false
            rememberFrontApp()
            panel.setFrame(topCenteredFrame(for: currentSize), display: true)
            panel.orderFrontRegardless()
            postToWeb(["type": "hotkey"], to: webView)  // the page expands, then asks for focus via resize
            for c in chats.values where c.open { c.panel.orderFrontRegardless() }
            if notesHeight > 0 { notesPanel.orderFrontRegardless() }
        } else {
            allHidden = true
            panel.orderOut(nil)
            workspaceWindow?.orderOut(nil)
            chats.values.forEach { $0.panel.orderOut(nil) }
            notesPanel.orderOut(nil)
            returnFocus()
        }
    }

    private func rememberFrontApp() {
        if let front = NSWorkspace.shared.frontmostApplication, front != NSRunningApplication.current { prevApp = front }
    }

    // Like Spotlight: when the workspace closes, typing goes back to the app you were in.
    private func returnFocus() {
        if NSApp.isActive, let p = prevApp, !p.isTerminated { p.activate() }
    }

    private func handleHTTP(_ body: [String: Any], to senderWebView: WKWebView?) {
        let reqId = body["id"] as? String ?? ""
        let method = (body["method"] as? String ?? "GET").uppercased()
        let path = body["path"] as? String ?? "/"

        guard let baseURL = connectionBaseURL, let token = connectionToken else {
            postToWeb([
                "type": "httpResponse",
                "id": reqId,
                "status": 0,
                "ok": false,
                "error": "Not connected"
            ], to: senderWebView)
            return
        }

        guard let url = URL(string: path, relativeTo: baseURL)?.absoluteURL else {
            postToWeb([
                "type": "httpResponse",
                "id": reqId,
                "status": 0,
                "ok": false,
                "error": "Invalid request path"
            ], to: senderWebView)
            return
        }

        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15.0)
        request.httpMethod = method
        request.setValue(token, forHTTPHeaderField: "X-CA-Token")
        // Ensure no Origin header is sent (backend rejects foreign Origin headers)
        request.setValue(nil, forHTTPHeaderField: "Origin")

        let filePaths = body["filePaths"] as? [String] ?? []
        if !filePaths.isEmpty {
            let boundary = "Boundary-\(UUID().uuidString)"
            var data = Data()
            let prompt = body["prompt"] as? String ?? ""

            data.append("--\(boundary)\r\n".data(using: .utf8)!)
            data.append("Content-Disposition: form-data; name=\"prompt\"\r\n\r\n".data(using: .utf8)!)
            data.append("\(prompt)\r\n".data(using: .utf8)!)

            for filePath in filePaths {
                let fileURL = URL(fileURLWithPath: filePath)
                if let fileData = try? Data(contentsOf: fileURL) {
                    let filename = fileURL.lastPathComponent.replacingOccurrences(of: "\"", with: "_")
                    data.append("--\(boundary)\r\n".data(using: .utf8)!)
                    data.append("Content-Disposition: form-data; name=\"files\"; filename=\"\(filename)\"\r\n".data(using: .utf8)!)
                    data.append("Content-Type: application/octet-stream\r\n\r\n".data(using: .utf8)!)
                    data.append(fileData)
                    data.append("\r\n".data(using: .utf8)!)
                }
            }
            data.append("--\(boundary)--\r\n".data(using: .utf8)!)
            request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
            request.httpBody = data
        } else if let rawBody = body["body"] as? String, !rawBody.isEmpty {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = rawBody.data(using: .utf8)
        }

        let task = URLSession.shared.dataTask(with: request) { [weak self, weak senderWebView] data, response, error in
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            let bodyText = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
            let errText = error?.localizedDescription ?? ""
            Task { @MainActor in
                guard let self = self else { return }
                self.postToWeb([
                    "type": "httpResponse",
                    "id": reqId,
                    "status": status,
                    "ok": (200..<300).contains(status),
                    "body": bodyText,
                    "error": errText
                ], to: senderWebView)
            }
        }
        task.resume()
    }

    private func handlePickFiles(_ body: [String: Any], to senderWebView: WKWebView?) {
        let reqId = body["id"] as? String ?? ""
        let kind = body["kind"] as? String ?? "files"

        let openPanel = NSOpenPanel()
        openPanel.canChooseFiles = true
        openPanel.canChooseDirectories = false
        openPanel.allowsMultipleSelection = true
        if kind == "photo" {
            openPanel.allowedContentTypes = [.image]
        } else if kind == "video" {
            openPanel.allowedContentTypes = [.movie]
        }

        NSApp.activate(ignoringOtherApps: true)
        let response = openPanel.runModal()
        var picked: [[String: String]] = []
        if response == .OK {
            picked = openPanel.urls.map { ["name": $0.lastPathComponent, "path": $0.path] }
        }
        postToWeb([
            "type": "filesPicked",
            "id": reqId,
            "files": picked
        ], to: senderWebView)
    }

    private func handleReadFixture(_ body: [String: Any], to senderWebView: WKWebView?) {
        let reqId = body["id"] as? String ?? ""
        let name = body["name"] as? String ?? ""
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-")
        guard !name.isEmpty,
              name.unicodeScalars.allSatisfy({ allowed.contains($0) }),
              let uiDir = uiFileURL?.deletingLastPathComponent() else {
            postToWeb([
                "type": "fixtureResponse",
                "id": reqId,
                "ok": false,
                "body": ""
            ], to: senderWebView)
            return
        }

        let fixtureURL = uiDir.appendingPathComponent("fixtures/\(name).json")
        if let content = try? String(contentsOf: fixtureURL, encoding: .utf8) {
            postToWeb([
                "type": "fixtureResponse",
                "id": reqId,
                "ok": true,
                "body": content
            ], to: senderWebView)
        } else {
            postToWeb([
                "type": "fixtureResponse",
                "id": reqId,
                "ok": false,
                "body": ""
            ], to: senderWebView)
        }
    }

    @objc private func screenParametersDidChange(_ notification: Notification) {
        let targetFrame = topCenteredFrame(for: currentSize)
        panel.setFrame(targetFrame, display: true)
    }

    @objc private func togglePanel(_ sender: Any?) {
        if panel.isVisible {
            panel.orderOut(nil)
        } else {
            let targetFrame = topCenteredFrame(for: currentSize)
            panel.setFrame(targetFrame, display: true)
            panel.orderFrontRegardless()
        }
    }

    @objc private func reloadPage(_ sender: Any?) {
        loadPage()
    }

    @objc private func quitApp(_ sender: Any?) {
        NSApplication.shared.terminate(nil)
    }
}

MainActor.assumeIsolated {
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    app.setActivationPolicy(.accessory)
    app.run()
}
