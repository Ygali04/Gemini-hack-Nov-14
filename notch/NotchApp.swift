import Cocoa
import WebKit
import QuartzCore
import UniformTypeIdentifiers
import Carbon
import Speech
import AVFoundation

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
final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKScriptMessageHandler,
                         SFSpeechRecognizerDelegate, AVSpeechSynthesizerDelegate {
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
    private var usr1Source: DispatchSourceSignal?
    private var currentSize = NSSize(width: 280, height: 36)

    // Session-only connection state (never persisted to disk)
    private var connectionBaseURL: URL?
    private var connectionToken: String?

    // On-device voice (Apple Speech framework STT + AVSpeechSynthesizer TTS)
    private var speechRecognizer: SFSpeechRecognizer?
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private lazy var audioEngine = AVAudioEngine()
    private var isDictating = false
    private var hasSpeechTap = false
    private let speechSynthesizer = AVSpeechSynthesizer()
    private var isSpeaking = false
    private var currentSpeakText = ""

    private lazy var uiFileURL: URL? = resolveUIFileURL()

    func applicationDidFinishLaunching(_ notification: Notification) {
        if let envURL = ProcessInfo.processInfo.environment["CA_URL"], !envURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            _ = applyConnectionString(envURL)
        }
        setupVoice()
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
        if ProcessInfo.processInfo.environment["CA_INSPECT"] == "1" {
            startInspectLoop()
        }
    }

    private func resolveUIFileURL() -> URL? {
        let fm = FileManager.default
        var candidates: [URL] = []

        if let envPath = ProcessInfo.processInfo.environment["UI_FILE"], !envPath.isEmpty {
            candidates.append(URL(fileURLWithPath: envPath))
        }

        if let resourceURL = Bundle.main.resourceURL {
            candidates.append(resourceURL.appendingPathComponent("ui/index.html"))
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

    private func resolveWorkspaceFileURL() -> URL? {
        let fm = FileManager.default
        var candidates: [URL] = []

        if let resourceURL = Bundle.main.resourceURL {
            candidates.append(resourceURL.appendingPathComponent("ui/workspace.html"))
        }

        if let indexURL = uiFileURL {
            candidates.append(indexURL.deletingLastPathComponent().appendingPathComponent("workspace.html"))
        }

        let cwd = URL(fileURLWithPath: fm.currentDirectoryPath, isDirectory: true)
        candidates.append(cwd.appendingPathComponent("ui/workspace.html"))

        if let execURL = Bundle.main.executableURL {
            let execDir = execURL.deletingLastPathComponent()
            candidates.append(execDir.appendingPathComponent("../../ui/workspace.html").standardizedFileURL)
            candidates.append(execDir.appendingPathComponent("../ui/workspace.html").standardizedFileURL)
            candidates.append(execDir.appendingPathComponent("ui/workspace.html").standardizedFileURL)
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
            let vc = currentVoiceCapability()
            postToWeb([
                "type": "config",
                "id": body["id"] as? String ?? "",
                "connected": (connectionBaseURL != nil && connectionToken != nil),
                "baseUrl": connectionBaseURL?.absoluteString ?? "",
                "speechAvailable": vc.available,
                "onDeviceSpeech": vc.onDevice,
                "speechAuth": vc.auth,
                "isDictating": isDictating,
                "isSpeaking": isSpeaking,
                "speakText": currentSpeakText
            ], to: senderWebView)
        case "startDictation":
            handleStartDictation()
        case "stopDictation":
            stopDictationInternal(silent: false)
        case "speak":
            let text = (body["text"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            handleSpeak(text)
        case "stopSpeaking":
            handleStopSpeaking()
        case "openPrivacySettings":
            let section = body["section"] as? String ?? "Privacy_SpeechRecognition"
            if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(section)") {
                NSWorkspace.shared.open(url)
            }
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
            if let wsFileURL = resolveWorkspaceFileURL() {
                let uiDir = wsFileURL.deletingLastPathComponent()
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
        // Second trigger for scripts and other launchers: `pkill -USR1 AgentNotch` toggles like Option-Space.
        signal(SIGUSR1, SIG_IGN)
        let src = DispatchSource.makeSignalSource(signal: SIGUSR1, queue: .main)
        src.setEventHandler { [weak self] in self?.toggleAll() }
        src.resume()
        usr1Source = src
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

    // MARK: On-device voice (Apple Speech STT + AVSpeechSynthesizer TTS)

    private func setupVoice() {
        let recognizer = SFSpeechRecognizer(locale: Locale.current) ?? SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
        recognizer?.delegate = self
        speechRecognizer = recognizer
        speechSynthesizer.delegate = self
    }

    private func speechAuthString(_ status: SFSpeechRecognizerAuthorizationStatus) -> String {
        switch status {
        case .authorized: return "authorized"
        case .denied: return "denied"
        case .restricted: return "restricted"
        case .notDetermined: return "notDetermined"
        @unknown default: return "unknown"
        }
    }

    private func currentVoiceCapability() -> (available: Bool, onDevice: Bool, auth: String) {
        if ProcessInfo.processInfo.environment["CA_SPEECH_UNAVAILABLE"] == "1" {
            return (false, false, "unavailable")
        }
        guard let recognizer = speechRecognizer else {
            return (false, false, "unavailable")
        }
        let status = SFSpeechRecognizer.authorizationStatus()
        let auth = speechAuthString(status)
        let micStatus = AVCaptureDevice.authorizationStatus(for: .audio)
        let micDenied = (micStatus == .denied || micStatus == .restricted)
        let allowedOrAskable = (status == .authorized || status == .notDetermined)
        let isDeniedState = (status == .denied || status == .restricted || micDenied)
        let available = isDeniedState ? true : (recognizer.isAvailable && allowedOrAskable)
        return (available, recognizer.supportsOnDeviceRecognition, auth)
    }

    private func broadcastVoiceState(state: String, reason: String = "", nextStep: String = "", onDevice: Bool = false) {
        let vc = currentVoiceCapability()
        broadcastToWeb([
            "type": "voiceState",
            "state": state,
            "reason": reason,
            "nextStep": nextStep,
            "onDevice": onDevice || vc.onDevice,
            "speechAvailable": vc.available,
            "speechAuth": vc.auth,
            "isDictating": isDictating
        ])
    }

    private func handleStartDictation() {
        if isDictating {
            stopDictationInternal(silent: false)
            return
        }
        let vc = currentVoiceCapability()
        guard vc.available, let recognizer = speechRecognizer else {
            broadcastVoiceState(
                state: "unavailable",
                reason: "Speech recognition is unavailable on this Mac.",
                nextStep: "Enable Dictation in System Settings → Keyboard to dictate prompts."
            )
            return
        }

        let speechStatus = SFSpeechRecognizer.authorizationStatus()
        let micStatus = AVCaptureDevice.authorizationStatus(for: .audio)

        if speechStatus == .notDetermined {
            broadcastVoiceState(
                state: "requesting_permission",
                reason: "Allow Speech Recognition and Microphone access to dictate prompts on this Mac."
            )
            SFSpeechRecognizer.requestAuthorization { [weak self] newStatus in
                Task { @MainActor [weak self] in
                    guard let self = self else { return }
                    if newStatus == .authorized {
                        self.checkMicAndBeginDictation(recognizer: recognizer)
                    } else if newStatus == .restricted {
                        self.broadcastVoiceState(
                            state: "denied",
                            reason: "Speech Recognition is restricted on this Mac.",
                            nextStep: "Check Screen Time or device profile restrictions to allow Speech Recognition."
                        )
                    } else {
                        self.broadcastVoiceState(
                            state: "denied",
                            reason: "Speech Recognition permission was denied.",
                            nextStep: "Open System Settings → Privacy & Security → Speech Recognition and allow Agent Workspace."
                        )
                    }
                }
            }
            return
        }

        if speechStatus == .restricted {
            broadcastVoiceState(
                state: "denied",
                reason: "Speech Recognition is restricted on this Mac.",
                nextStep: "Check Screen Time or device profile restrictions to allow Speech Recognition."
            )
            return
        }

        if speechStatus == .denied {
            broadcastVoiceState(
                state: "denied",
                reason: "Speech Recognition permission is denied.",
                nextStep: "Open System Settings → Privacy & Security → Speech Recognition and allow Agent Workspace."
            )
            return
        }

        if micStatus == .notDetermined {
            broadcastVoiceState(
                state: "requesting_permission",
                reason: "Allow Microphone access to capture your voice on this Mac."
            )
        }
        checkMicAndBeginDictation(recognizer: recognizer)
    }

    private func checkMicAndBeginDictation(recognizer: SFSpeechRecognizer) {
        let micStatus = AVCaptureDevice.authorizationStatus(for: .audio)
        switch micStatus {
        case .authorized:
            beginAudioRecognition(recognizer: recognizer)
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .audio) { [weak self] granted in
                Task { @MainActor [weak self] in
                    guard let self = self else { return }
                    if granted {
                        self.beginAudioRecognition(recognizer: recognizer)
                    } else {
                        self.broadcastVoiceState(
                            state: "denied",
                            reason: "Microphone permission was denied.",
                            nextStep: "Open System Settings → Privacy & Security → Microphone and allow Agent Workspace."
                        )
                    }
                }
            }
        case .restricted:
            broadcastVoiceState(
                state: "denied",
                reason: "Microphone access is restricted on this Mac.",
                nextStep: "Check Screen Time or device profile restrictions to allow the microphone."
            )
        case .denied:
            broadcastVoiceState(
                state: "denied",
                reason: "Microphone permission is denied.",
                nextStep: "Open System Settings → Privacy & Security → Microphone and allow Agent Workspace."
            )
        @unknown default:
            broadcastVoiceState(
                state: "denied",
                reason: "Microphone permission is unavailable.",
                nextStep: "Check System Settings → Privacy & Security → Microphone."
            )
        }
    }

    private func beginAudioRecognition(recognizer: SFSpeechRecognizer) {
        guard recognizer.isAvailable else {
            broadcastVoiceState(
                state: "unavailable",
                reason: "Speech recognizer is temporarily unavailable.",
                nextStep: "Check microphone availability or Dictation settings in System Settings."
            )
            return
        }

        stopDictationInternal(silent: true)

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        let useOnDevice = recognizer.supportsOnDeviceRecognition
        if useOnDevice {
            request.requiresOnDeviceRecognition = true
        }
        recognitionRequest = request

        let inputNode = audioEngine.inputNode
        let format = inputNode.outputFormat(forBus: 0)
        guard format.sampleRate > 0 && format.channelCount > 0 else {
            recognitionRequest = nil
            broadcastVoiceState(
                state: "error",
                reason: "No microphone input device is available.",
                nextStep: "Connect or select an input device in System Settings → Sound."
            )
            return
        }

        if hasSpeechTap {
            inputNode.removeTap(onBus: 0)
            hasSpeechTap = false
        }
        inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            request.append(buffer)
        }
        hasSpeechTap = true

        do {
            audioEngine.prepare()
            try audioEngine.start()
        } catch {
            stopDictationInternal(silent: true)
            broadcastVoiceState(
                state: "error",
                reason: "Could not start microphone capture.",
                nextStep: "Check microphone permissions and System Settings → Sound."
            )
            return
        }

        isDictating = true
        broadcastVoiceState(
            state: "listening",
            reason: useOnDevice ? "Listening on this Mac — click mic to stop." : "Listening — click mic to stop.",
            onDevice: useOnDevice
        )

        recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
            let transcript = result?.bestTranscription.formattedString
            let isFinal = result?.isFinal ?? false
            let errText = error?.localizedDescription
            Task { @MainActor [weak self] in
                guard let self = self else { return }
                if let transcript {
                    self.postToWeb([
                        "type": "voiceTranscript",
                        "text": transcript,
                        "isFinal": isFinal
                    ], to: self.webView)
                }
                if isFinal {
                    self.stopDictationInternal(silent: false)
                } else if let errText, self.isDictating {
                    self.stopDictationInternal(silent: true)
                    self.broadcastVoiceState(
                        state: "error",
                        reason: errText,
                        nextStep: "Click the mic button to try again."
                    )
                }
            }
        }
    }

    private func stopDictationInternal(silent: Bool) {
        let wasDictating = isDictating
        isDictating = false
        if audioEngine.isRunning {
            audioEngine.stop()
        }
        if hasSpeechTap {
            audioEngine.inputNode.removeTap(onBus: 0)
            hasSpeechTap = false
        }
        recognitionRequest?.endAudio()
        recognitionRequest = nil
        recognitionTask?.cancel()
        recognitionTask = nil
        if !silent && wasDictating {
            broadcastVoiceState(state: "idle")
        }
    }

    private func handleSpeak(_ text: String) {
        guard !text.isEmpty else { return }
        if speechSynthesizer.isSpeaking {
            speechSynthesizer.stopSpeaking(at: .immediate)
        }
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = AVSpeechSynthesisVoice(language: Locale.current.identifier)
            ?? AVSpeechSynthesisVoice(language: "en-US")
        currentSpeakText = text
        isSpeaking = true
        broadcastToWeb([
            "type": "ttsState",
            "speaking": true,
            "text": text
        ])
        speechSynthesizer.speak(utterance)
    }

    private func handleStopSpeaking() {
        if speechSynthesizer.isSpeaking {
            speechSynthesizer.stopSpeaking(at: .immediate)
        }
        isSpeaking = false
        currentSpeakText = ""
        broadcastToWeb([
            "type": "ttsState",
            "speaking": false,
            "text": ""
        ])
    }

    nonisolated func speechRecognizer(_ speechRecognizer: SFSpeechRecognizer, availabilityDidChange available: Bool) {
        Task { @MainActor [weak self] in
            guard let self = self else { return }
            let vc = self.currentVoiceCapability()
            self.broadcastToWeb([
                "type": "voiceState",
                "state": self.isDictating ? "listening" : "idle",
                "speechAvailable": vc.available,
                "onDevice": vc.onDevice,
                "speechAuth": vc.auth,
                "isDictating": self.isDictating
            ])
        }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) {
        let text = utterance.speechString
        Task { @MainActor [weak self] in
            guard let self = self else { return }
            self.isSpeaking = true
            self.currentSpeakText = text
            self.broadcastToWeb([
                "type": "ttsState",
                "speaking": true,
                "text": text
            ])
        }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor [weak self] in
            guard let self = self else { return }
            self.isSpeaking = false
            self.currentSpeakText = ""
            self.broadcastToWeb([
                "type": "ttsState",
                "speaking": false,
                "text": ""
            ])
        }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        Task { @MainActor [weak self] in
            guard let self = self else { return }
            self.isSpeaking = false
            self.currentSpeakText = ""
            self.broadcastToWeb([
                "type": "ttsState",
                "speaking": false,
                "text": ""
            ])
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
        if ProcessInfo.processInfo.environment["CA_INSPECT"] == "1" {
            startInspectLoop()
        }
    }

    @objc private func quitApp(_ sender: Any?) {
        NSApplication.shared.terminate(nil)
    }

    private func startInspectLoop() {
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            while let line = readLine(strippingNewline: true) {
                guard let data = line.data(using: .utf8),
                      let req = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                    continue
                }
                DispatchQueue.main.async {
                    self?.handleInspectCommand(req)
                }
            }
        }
    }

    private func writeInspectResponse(_ payload: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: payload, options: []),
              let text = String(data: data, encoding: .utf8) else {
            return
        }
        print(text)
        fflush(stdout)
    }

    private func quartzRectDict(for win: NSWindow?) -> [String: Any]? {
        guard let win = win else { return nil }
        let f = win.frame
        let primaryMaxY = NSScreen.screens.first?.frame.maxY ?? f.maxY
        return [
            "x": f.origin.x,
            "y": primaryMaxY - f.maxY,
            "width": f.size.width,
            "height": f.size.height,
            "cocoaX": f.origin.x,
            "cocoaY": f.origin.y,
            "windowNumber": win.windowNumber,
            "visible": win.isVisible,
            "isKey": win.isKeyWindow,
            "title": win.title
        ]
    }

    private func handleInspectCommand(_ req: [String: Any]) {
        let reqId = req["id"] ?? NSNull()
        let cmd = req["cmd"] as? String ?? ""
        switch cmd {
        case "bounds":
            writeInspectResponse([
                "id": reqId,
                "ok": true,
                "panel": quartzRectDict(for: panel) ?? NSNull(),
                "workspace": quartzRectDict(for: workspaceWindow) ?? NSNull()
            ])
        case "eval":
            let target = req["target"] as? String ?? "notch"
            let js = req["js"] as? String ?? ""
            let wv: WKWebView? = (target == "workspace") ? workspaceWebView : webView
            guard let targetWebView = wv else {
                writeInspectResponse([
                    "id": reqId,
                    "ok": false,
                    "error": "Target webView not available"
                ])
                return
            }
            targetWebView.evaluateJavaScript(js) { [weak self] value, error in
                let safeVal: Any
                if let val = value, JSONSerialization.isValidJSONObject(["v": val]) {
                    safeVal = val
                } else if let val = value {
                    safeVal = String(describing: val)
                } else {
                    safeVal = NSNull()
                }
                self?.writeInspectResponse([
                    "id": reqId,
                    "ok": error == nil,
                    "result": safeVal,
                    "error": error?.localizedDescription ?? ""
                ])
            }
        case "quit":
            writeInspectResponse(["id": reqId, "ok": true])
            NSApplication.shared.terminate(nil)
        default:
            writeInspectResponse(["id": reqId, "ok": false, "error": "Unknown cmd"])
        }
    }
}

MainActor.assumeIsolated {
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    app.setActivationPolicy(.accessory)
    app.run()
}
