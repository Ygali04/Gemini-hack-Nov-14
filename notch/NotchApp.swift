import Cocoa
import WebKit
import QuartzCore
import UniformTypeIdentifiers
import Carbon
import Speech
import AVFoundation
import PDFKit
import ImageIO

// Option-Space reaches the delegate through this pointer (a Carbon handler cannot capture).
nonisolated(unsafe) weak var hotkeyTarget: AppDelegate?

// Bridge contract for `filesDropped` (shell -> page):
// Each item in `files` is a dictionary with:
//   - path: String (local or temp file path)
//   - name: String (file or folder display name)
//   - size: Int (bytes; 0 for folders)
//   - kind: String ("image" | "text" | "pdf" | "folder" | "other")
//   - thumbnail: String? (optional; data URL <= 128 px on longest side when kind == "image")
//   - pageCount: Int? (optional; PDF page count when kind == "pdf")
//   - textExtracted: Bool? (optional; true when PDFKit extracted text for upload when kind == "pdf")
//
// Surface & bridge contract (every surface comes out from under the notch):
// All surfaces anchor centered horizontally on the notch screen (first screen with
// `safeAreaInsets.top > 0`, falling back to `NSScreen.main ?? NSScreen.screens.first`)
// and grow downward with 180 ms ease-out motion (or a 180 ms alpha fade when Reduce Motion
// is enabled). No new bridge message types are added; existing messages carry all surfaces:
//   1. Panel (pill / expanded thread):
//      - `resize` { width, height, state: "collapsed" | "expanded", instant? }
//      - Anchored at top center of the notch screen; clamps to 200..640 x 32..640.
//   2. Chat per task:
//      - Rendered as threads inside the panel under the notch (no separate window needed).
//      - Legacy `openChat` { run } and `closeWindow` remain reachable until pages migrate.
//   3. Notifications (`?shell=notes`):
//      - `resize` { width?, height, state: "notes", fresh? } from `notesWeb`
//      - Anchored directly under the notch (below `safeAreaInsets.top` / menu bar, or
//        below the panel when visible), centered horizontally, growing downward.
//   4. Workspace sheet (6 tabs + inline approvals):
//      - Either `resize` { width, height, state: "sheet", instant? } to grow the panel into
//        a large under-notch sheet (clamped to screen visibleFrame, up to 1040 x 740),
//        or `openWorkspace` { mode: "sheet", fixture?, width?, height? } to present
//        `ui/workspace.html` in an under-notch sheet panel (Esc / Option-Space / `closeWindow`
//        folds it back). Legacy `openWorkspace` without `mode: "sheet"` keeps the normal
//        window reachable until pages migrate.
//
// A web view that accepts the first click (notifications work without focusing first) and turns dropped
// Finder files, file promises, image data, and Cmd+V pastes into `filesDropped` events for the page.
@MainActor
final class ShellWebView: WKWebView {
    var onFiles: (([[String: Any]]) -> Void)?
    var onFileURLs: (([URL]) -> Void)?

    private let promiseQueue: OperationQueue = {
        let q = OperationQueue()
        q.qualityOfService = .userInitiated
        return q
    }()

    override init(frame: CGRect, configuration: WKWebViewConfiguration) {
        super.init(frame: frame, configuration: configuration)
        let promiseTypes = NSFilePromiseReceiver.readableDraggedTypes.map { NSPasteboard.PasteboardType($0) }
        registerForDraggedTypes([.fileURL, .png, .tiff, .URL, .string] + promiseTypes)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        let superOp = super.draggingEntered(sender)
        if superOp.isEmpty && canAcceptPasteboard(sender.draggingPasteboard) {
            return .copy
        }
        return superOp
    }

    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
        let superOp = super.draggingUpdated(sender)
        if superOp.isEmpty && canAcceptPasteboard(sender.draggingPasteboard) {
            return .copy
        }
        return superOp
    }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        if handlePasteboard(sender.draggingPasteboard) {
            return true
        }
        return super.performDragOperation(sender)
    }

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        if event.type == .keyDown,
           event.modifierFlags.intersection(.deviceIndependentFlagsMask) == .command,
           event.charactersIgnoringModifiers?.lowercased() == "v",
           window?.isKeyWindow == true,
           isDescendantResponder(window?.firstResponder) {
            if handlePasteboard(NSPasteboard.general) {
                return true
            }
        }
        return super.performKeyEquivalent(with: event)
    }

    private func isDescendantResponder(_ responder: NSResponder?) -> Bool {
        var cur = responder
        while let r = cur {
            if r === self { return true }
            if let view = r as? NSView {
                cur = view.superview
            } else {
                break
            }
        }
        return false
    }

    private func canAcceptPasteboard(_ pb: NSPasteboard) -> Bool {
        if pb.canReadObject(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) {
            return true
        }
        if pb.canReadObject(forClasses: [NSFilePromiseReceiver.self], options: nil) {
            return true
        }
        if pb.types?.contains(.png) == true || pb.types?.contains(.tiff) == true {
            return true
        }
        return pb.canReadObject(forClasses: [NSImage.self], options: nil)
    }

    private func handlePasteboard(_ pb: NSPasteboard) -> Bool {
        // 1. Finder / local file URLs
        let urls = pb.readObjects(forClasses: [NSURL.self],
                                  options: [.urlReadingFileURLsOnly: true]) as? [URL] ?? []
        if !urls.isEmpty {
            deliverURLs(urls)
            return true
        }

        // 2. File promises (Photos, Mail, screenshot thumbnail)
        let receivers = pb.readObjects(forClasses: [NSFilePromiseReceiver.self], options: nil) as? [NSFilePromiseReceiver] ?? []
        if !receivers.isEmpty {
            let destDir = FileManager.default.temporaryDirectory
                .appendingPathComponent("ca-drop-\(UUID().uuidString)", isDirectory: true)
            try? FileManager.default.createDirectory(at: destDir, withIntermediateDirectories: true)

            let group = DispatchGroup()
            let lock = NSLock()
            var receivedURLs: [URL] = []

            for receiver in receivers {
                group.enter()
                receiver.receivePromisedFiles(atDestination: destDir, options: [:], operationQueue: promiseQueue) { fileURL, error in
                    if error == nil {
                        lock.lock()
                        receivedURLs.append(fileURL)
                        lock.unlock()
                    }
                    group.leave()
                }
            }

            group.notify(queue: .main) { [weak self] in
                if !receivedURLs.isEmpty {
                    self?.deliverURLs(receivedURLs)
                }
            }
            return true
        }

        // 3. Raw image data (screenshot clipboard, browser image drags — takes image data, ignores link)
        if let pngURL = writeTempPNG(from: pb) {
            deliverURLs([pngURL])
            return true
        }

        return false
    }

    private func deliverURLs(_ urls: [URL]) {
        if let onFileURLs {
            onFileURLs(urls)
        } else if let onFiles {
            onFiles(urls.map { ["name": $0.lastPathComponent, "path": $0.path] })
        }
    }

    private func writeTempPNG(from pb: NSPasteboard) -> URL? {
        var pngData: Data?
        if let rawPNG = pb.data(forType: .png), !rawPNG.isEmpty {
            pngData = rawPNG
        } else if let tiffData = pb.data(forType: .tiff),
                  let rep = NSBitmapImageRep(data: tiffData),
                  let converted = rep.representation(using: .png, properties: [:]) {
            pngData = converted
        } else if pb.canReadObject(forClasses: [NSImage.self], options: nil),
                  let images = pb.readObjects(forClasses: [NSImage.self], options: nil) as? [NSImage],
                  let img = images.first,
                  let tiff = img.tiffRepresentation,
                  let rep = NSBitmapImageRep(data: tiff),
                  let converted = rep.representation(using: .png, properties: [:]) {
            pngData = converted
        }

        guard let data = pngData, !data.isEmpty else { return nil }
        let dest = FileManager.default.temporaryDirectory
            .appendingPathComponent("image-\(UUID().uuidString.prefix(8)).png")
        do {
            try data.write(to: dest)
            return dest
        } catch {
            return nil
        }
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
    var onCancel: (() -> Void)?
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }

    override func cancelOperation(_ sender: Any?) {
        if let onCancel = onCancel {
            onCancel()
        } else {
            super.cancelOperation(sender)
        }
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKScriptMessageHandler,
                         SFSpeechRecognizerDelegate, AVSpeechSynthesizerDelegate {
    private var statusItem: NSStatusItem!
    private var panel: NotchPanel!
    private var webView: WKWebView!
    private var workspaceWindow: NSWindow?
    private var workspaceWebView: WKWebView?
    private var workspaceSheetPanel: NotchPanel?
    private var workspaceSheetWebView: ShellWebView?
    private var workspaceSheetSize = NSSize(width: 960, height: 680)
    private var sharedContentController: WKUserContentController!
    private var notesPanel: NotchPanel!
    private var notesWeb: ShellWebView!
    private var notesWidth: CGFloat = 320
    private var notesHeight: CGFloat = 0
    private var chats: [String: ChatWindow] = [:]
    private var allHidden = false
    private var expanded = false
    private var panelState = "collapsed"
    private var prevApp: NSRunningApplication?
    private var usr1Source: DispatchSourceSignal?
    private var currentSize = NSSize(width: 280, height: 36)
    private let motionDuration: TimeInterval = 0.18

    // Session-only connection state (never persisted to disk)
    private var connectionBaseURL: URL?
    private var connectionToken: String?

    // Attachment metadata & PDF text sidecars (mirroring backend/computeranything/core/attach.py)
    private let imageExtensions: Set<String> = ["png", "jpg", "jpeg", "gif", "webp", "heic", "tiff", "bmp"]
    private let maxTextProbeBytes = 4096
    private let maxTextFileSize = 1_000_000
    private let maxThumbnailPixelSize = 128
    private let maxPDFPages = 50
    private let multipartTimeoutSeconds: TimeInterval = 120.0
    private var pendingPDFTextFiles: [String: URL] = [:]

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
    private var inspectLoopStarted = false

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
            candidates.append(resourceURL.appendingPathComponent("ui/index.html").standardizedFileURL)
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
            candidates.append(resourceURL.appendingPathComponent("ui/workspace.html").standardizedFileURL)
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

    private func notchScreen() -> NSScreen? {
        if let notched = NSScreen.screens.first(where: { $0.safeAreaInsets.top > 0 }) {
            return notched
        }
        return NSScreen.main ?? NSScreen.screens.first
    }

    private func topCenteredFrame(for size: NSSize, on targetScreen: NSScreen? = nil) -> NSRect {
        let screen = targetScreen ?? notchScreen()
        let screenFrame = screen?.frame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let x = round(screenFrame.midX - (size.width / 2.0))
        let y = round(screenFrame.maxY - size.height)
        return NSRect(x: x, y: y, width: size.width, height: size.height)
    }

    private func notesFrame(for width: CGFloat, height: CGFloat, on targetScreen: NSScreen? = nil) -> NSRect {
        let screen = targetScreen ?? notchScreen()
        let screenFrame = screen?.frame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let vis = screen?.visibleFrame ?? screenFrame
        let notchClearance = max(screen?.safeAreaInsets.top ?? 0, 36.0)
        let baseTopY = min(vis.maxY, screenFrame.maxY - notchClearance) - 8.0
        let panelBottomY = (panel != nil && panel.isVisible) ? (panel.frame.minY - 8.0) : baseTopY
        let anchorTopY = min(baseTopY, panelBottomY)
        let clampedW = min(max(width, 240.0), max(240.0, vis.width - 32.0))
        let maxAvailH = max(80.0, anchorTopY - vis.minY - 8.0)
        let clampedH = min(height, maxAvailH)
        let x = round(screenFrame.midX - (clampedW / 2.0))
        let y = round(anchorTopY - clampedH)
        return NSRect(x: x, y: y, width: clampedW, height: clampedH)
    }

    private func animateWindow(
        _ win: NSWindow,
        to targetFrame: NSRect,
        instant: Bool,
        reveal: Bool = false,
        completion: (() -> Void)? = nil
    ) {
        if instant {
            win.setFrame(targetFrame, display: true)
            win.alphaValue = 1.0
            completion?()
            return
        }

        if NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
            win.setFrame(targetFrame, display: true)
            win.alphaValue = reveal ? 0.0 : 0.72
            NSAnimationContext.runAnimationGroup({ context in
                context.duration = motionDuration
                context.timingFunction = CAMediaTimingFunction(name: .easeOut)
                win.animator().alphaValue = 1.0
            }, completionHandler: {
                Task { @MainActor in completion?() }
            })
            return
        }

        win.alphaValue = 1.0
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = motionDuration
            context.timingFunction = CAMediaTimingFunction(controlPoints: 0.22, 1.0, 0.36, 1.0)
            win.animator().setFrame(targetFrame, display: true)
        }, completionHandler: {
            Task { @MainActor in completion?() }
        })
    }

    private func hideWindowWithMotion(_ win: NSWindow, shrinkTo anchorFrame: NSRect? = nil, instant: Bool = false) {
        guard win.isVisible else { return }
        if instant {
            win.orderOut(nil)
            win.alphaValue = 1.0
            return
        }
        if NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
            NSAnimationContext.runAnimationGroup({ context in
                context.duration = motionDuration
                context.timingFunction = CAMediaTimingFunction(name: .easeOut)
                win.animator().alphaValue = 0.0
            }, completionHandler: {
                Task { @MainActor in
                    win.orderOut(nil)
                    win.alphaValue = 1.0
                }
            })
            return
        }
        if let anchor = anchorFrame {
            NSAnimationContext.runAnimationGroup({ context in
                context.duration = motionDuration
                context.timingFunction = CAMediaTimingFunction(controlPoints: 0.22, 1.0, 0.36, 1.0)
                win.animator().setFrame(anchor, display: true)
            }, completionHandler: {
                Task { @MainActor in
                    win.orderOut(nil)
                }
            })
        } else {
            win.orderOut(nil)
        }
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
        wireDropTarget(notchWeb)
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

        var components = URLComponents(url: fileURL, resolvingAgainstBaseURL: true)
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
        workspaceSheetWebView?.evaluateJavaScript(script, completionHandler: nil)
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
            let w = CGFloat((body["width"] as? NSNumber)?.doubleValue ?? Double(notesWidth))
            let h = CGFloat((body["height"] as? NSNumber)?.doubleValue ?? 0)
            notesWidth = min(max(w, 240.0), 480.0)
            layoutNotes(height: h, fresh: body["fresh"] as? Bool ?? false, instant: body["instant"] as? Bool ?? false)
        case "resize":
            guard senderWebView === webView else { return }
            handleResize(body)
        case "openChat":
            if let run = body["run"] as? String, !run.isEmpty { openChat(run) }
        case "closeWindow":
            if senderWebView === workspaceSheetWebView {
                foldWorkspaceSheet(instant: body["instant"] as? Bool ?? false)
            } else {
                for c in chats.values where c.web === senderWebView { c.open = false; c.panel.orderOut(nil) }
            }
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

    private func workspaceTargetURL(fixtureName: String?) -> URL? {
        guard let wsFileURL = resolveWorkspaceFileURL() else { return nil }
        var components = URLComponents(url: wsFileURL, resolvingAgainstBaseURL: true)
        var queryItems = [URLQueryItem(name: "shell", value: "notch")]
        if let fixtureName = fixtureName {
            queryItems.append(URLQueryItem(name: "fixture", value: fixtureName))
        }
        components?.queryItems = queryItems
        return components?.url ?? wsFileURL
    }

    private func loadWorkspaceContent(into wv: WKWebView, fixtureName: String?) {
        if let wsFileURL = resolveWorkspaceFileURL(),
           let targetURL = workspaceTargetURL(fixtureName: fixtureName) {
            let uiDir = wsFileURL.deletingLastPathComponent()
            if wv.url?.standardizedFileURL != targetURL.standardizedFileURL {
                wv.loadFileURL(targetURL, allowingReadAccessTo: uiDir)
            }
        } else {
            let html = "<!doctype html><html><body style='background:#f6f7f8;color:#111418;font:14px -apple-system;padding:24px;'>ui/workspace.html is not present yet.</body></html>"
            wv.loadHTMLString(html, baseURL: nil)
        }
    }

    private func foldWorkspaceSheet(instant: Bool = false) {
        guard let sheet = workspaceSheetPanel, sheet.isVisible else { return }
        let shrinkFrame = topCenteredFrame(for: currentSize)
        hideWindowWithMotion(sheet, shrinkTo: shrinkFrame, instant: instant)
        returnFocus()
    }

    private func handleOpenWorkspace(_ body: [String: Any], to senderWebView: WKWebView?) {
        let reqId = body["id"] as? String ?? ""
        let reqFixture = (body["fixture"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let envFixture = ProcessInfo.processInfo.environment["CA_FIXTURE"]?.trimmingCharacters(in: .whitespacesAndNewlines)
        let fixtureName = (reqFixture?.isEmpty == false ? reqFixture : (envFixture?.isEmpty == false ? envFixture : nil))
        let mode = (body["mode"] as? String ?? "").lowercased()

        if mode == "sheet" {
            let screen = notchScreen()
            let vis = screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
            let reqW = (body["width"] as? NSNumber)?.doubleValue ?? 960.0
            let reqH = (body["height"] as? NSNumber)?.doubleValue ?? 680.0
            let maxW = max(480.0, Double(vis.width - 48.0))
            let maxH = max(320.0, Double(vis.height - 16.0))
            workspaceSheetSize = NSSize(
                width: CGFloat(min(max(reqW, 480.0), min(1040.0, maxW))),
                height: CGFloat(min(max(reqH, 320.0), min(740.0, maxH)))
            )
            let targetFrame = topCenteredFrame(for: workspaceSheetSize, on: screen)

            if workspaceSheetPanel == nil || workspaceSheetWebView == nil {
                let startFrame = panel != nil ? panel.frame : targetFrame
                let sheet = floatingPanel(startFrame, level: .statusBar)
                sheet.onCancel = { [weak self] in self?.foldWorkspaceSheet() }
                let wv = makeWebView(startFrame.size)
                sheet.contentView = wv
                workspaceSheetPanel = sheet
                workspaceSheetWebView = wv
            }

            if let sheet = workspaceSheetPanel, let wv = workspaceSheetWebView {
                let wasHidden = !sheet.isVisible
                loadWorkspaceContent(into: wv, fixtureName: fixtureName)
                if wasHidden {
                    rememberFrontApp()
                    if !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
                        let startFrame = panel != nil ? panel.frame : NSRect(x: targetFrame.origin.x, y: targetFrame.maxY - 36, width: targetFrame.width, height: 36)
                        sheet.setFrame(startFrame, display: true)
                    }
                }
                NSApp.activate(ignoringOtherApps: true)
                sheet.makeKeyAndOrderFront(nil)
                animateWindow(sheet, to: targetFrame, instant: body["instant"] as? Bool ?? false, reveal: wasHidden)
            }

            postToWeb([
                "type": "workspaceOpened",
                "id": reqId,
                "ok": true,
                "mode": "sheet"
            ], to: senderWebView)
            return
        }

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

            let wv = ShellWebView(frame: NSRect(origin: .zero, size: initialRect.size), configuration: config)
            wv.autoresizingMask = [.width, .height]
            wv.navigationDelegate = self
            wireDropTarget(wv)
            win.contentView = wv

            workspaceWindow = win
            workspaceWebView = wv
        }

        if let workspaceWebView = workspaceWebView {
            loadWorkspaceContent(into: workspaceWebView, fixtureName: fixtureName)
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

        let screen = notchScreen()
        let vis = screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let isSheet = (state == "sheet")
        let maxW = isSheet ? min(1040.0, max(480.0, Double(vis.width - 48.0))) : 640.0
        let maxH = isSheet ? min(740.0, max(320.0, Double(vis.height - 16.0))) : 640.0
        let minW = isSheet ? 480.0 : 200.0
        let minH = isSheet ? 320.0 : 32.0

        let clampedWidth = CGFloat(min(max(rawWidth, minW), maxW))
        let clampedHeight = CGFloat(min(max(rawHeight, minH), maxH))
        currentSize = NSSize(width: clampedWidth, height: clampedHeight)
        let prevState = panelState
        panelState = state

        let targetFrame = topCenteredFrame(for: currentSize, on: screen)
        animateWindow(panel, to: targetFrame, instant: instant, reveal: (state != prevState))

        let isOpen = (state == "expanded" || state == "sheet")
        let wasExpanded = expanded
        expanded = isOpen
        if isOpen {
            if !wasExpanded { rememberFrontApp() }
            NSApp.activate(ignoringOtherApps: true)
            panel.makeKeyAndOrderFront(nil)
        } else if wasExpanded {
            returnFocus()
        }

        if notesHeight > 0 && notesPanel.isVisible {
            layoutNotes(height: notesHeight, fresh: false, instant: instant)
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
        wireDropTarget(wv)
        return wv
    }

    private func loadView(_ wv: WKWebView, _ items: [URLQueryItem]) {
        guard let fileURL = uiFileURL, var components = URLComponents(url: fileURL, resolvingAgainstBaseURL: true) else { return }
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

    // Persistent notifications, stacked directly under the notch, centered on the notch screen.
    private func setupNotes() {
        let initialFrame = notesFrame(for: notesWidth, height: 1)
        notesPanel = floatingPanel(initialFrame, level: .statusBar)
        notesPanel.hasShadow = false  // each card draws its own edge
        notesWeb = makeWebView(NSSize(width: notesWidth, height: 1))
        notesPanel.contentView = notesWeb
        loadView(notesWeb, [URLQueryItem(name: "shell", value: "notes")])
    }

    private func layoutNotes(height: CGFloat, fresh: Bool, instant: Bool = false) {
        notesHeight = height
        guard height > 0 else {
            hideWindowWithMotion(notesPanel, instant: instant)
            return
        }
        let targetFrame = notesFrame(for: notesWidth, height: height)
        let shouldShow = !allHidden || fresh
        let wasHidden = !notesPanel.isVisible
        if shouldShow {
            if wasHidden {
                if !instant && !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
                    notesPanel.setFrame(NSRect(x: targetFrame.origin.x, y: targetFrame.maxY - 1, width: targetFrame.width, height: 1), display: true)
                }
                notesPanel.orderFrontRegardless()
            }
            animateWindow(notesPanel, to: targetFrame, instant: instant, reveal: wasHidden)
        } else {
            notesPanel.setFrame(targetFrame, display: true)
        }
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
        if let sheet = workspaceSheetPanel, sheet.isVisible {
            foldWorkspaceSheet()
            return
        }
        if allHidden || !expanded {
            allHidden = false
            rememberFrontApp()
            panel.setFrame(topCenteredFrame(for: currentSize), display: true)
            panel.orderFrontRegardless()
            postToWeb(["type": "hotkey"], to: webView)  // the page expands, then asks for focus via resize
            for c in chats.values where c.open { c.panel.orderFrontRegardless() }
            if notesHeight > 0 { layoutNotes(height: notesHeight, fresh: false, instant: true) }
        } else {
            allHidden = true
            panel.orderOut(nil)
            workspaceWindow?.orderOut(nil)
            workspaceSheetPanel?.orderOut(nil)
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

        let filePaths = body["filePaths"] as? [String] ?? []
        let timeout: TimeInterval = filePaths.isEmpty ? 15.0 : multipartTimeoutSeconds
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        request.httpMethod = method
        request.setValue(token, forHTTPHeaderField: "X-CA-Token")
        // Ensure no Origin header is sent (backend rejects foreign Origin headers)
        request.setValue(nil, forHTTPHeaderField: "Origin")

        var tempTextURLsToDelete: [URL] = []
        if !filePaths.isEmpty {
            let boundary = "Boundary-\(UUID().uuidString)"
            var data = Data()
            let prompt = body["prompt"] as? String ?? ""

            data.append("--\(boundary)\r\n".data(using: .utf8)!)
            data.append("Content-Disposition: form-data; name=\"prompt\"\r\n\r\n".data(using: .utf8)!)
            data.append("\(prompt)\r\n".data(using: .utf8)!)

            if let thread = (body["thread"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
               !thread.isEmpty {
                data.append("--\(boundary)\r\n".data(using: .utf8)!)
                data.append("Content-Disposition: form-data; name=\"thread\"\r\n\r\n".data(using: .utf8)!)
                data.append("\(thread)\r\n".data(using: .utf8)!)
            }

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

                if fileURL.pathExtension.lowercased() == "pdf" {
                    let stdPath = fileURL.standardizedFileURL.path
                    let txtURL = pendingPDFTextFiles.removeValue(forKey: stdPath) ?? extractPDFText(for: fileURL).txtURL
                    if let txtURL, let txtData = try? Data(contentsOf: txtURL), !txtData.isEmpty {
                        let txtFilename = fileURL.deletingPathExtension().lastPathComponent
                            .replacingOccurrences(of: "\"", with: "_") + ".txt"
                        data.append("--\(boundary)\r\n".data(using: .utf8)!)
                        data.append("Content-Disposition: form-data; name=\"files\"; filename=\"\(txtFilename)\"\r\n".data(using: .utf8)!)
                        data.append("Content-Type: text/plain; charset=utf-8\r\n\r\n".data(using: .utf8)!)
                        data.append(txtData)
                        data.append("\r\n".data(using: .utf8)!)
                        tempTextURLsToDelete.append(txtURL)
                    }
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
            for txtURL in tempTextURLsToDelete {
                try? FileManager.default.removeItem(at: txtURL)
            }
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
        var picked: [[String: Any]] = []
        if response == .OK {
            picked = describeFiles(for: openPanel.urls)
        }
        postToWeb([
            "type": "filesPicked",
            "id": reqId,
            "files": picked
        ], to: senderWebView)
    }

    private func wireDropTarget(_ wv: ShellWebView) {
        wv.onFileURLs = { [weak self, weak wv] urls in
            guard let self, let wv else { return }
            let items = self.describeFiles(for: urls)
            if !items.isEmpty {
                self.postToWeb(["type": "filesDropped", "files": items], to: wv)
            }
        }
    }

    private func describeFiles(for urls: [URL]) -> [[String: Any]] {
        urls.map { describeFile(at: $0) }
    }

    private func describeFile(at url: URL) -> [String: Any] {
        let fm = FileManager.default
        var isDir: ObjCBool = false
        let exists = fm.fileExists(atPath: url.path, isDirectory: &isDir)
        if exists && isDir.boolValue {
            return [
                "path": url.path,
                "name": url.lastPathComponent,
                "size": 0,
                "kind": "folder"
            ]
        }

        let size = (try? fm.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.intValue ?? 0
        let ext = url.pathExtension.lowercased()

        if imageExtensions.contains(ext) {
            var item: [String: Any] = [
                "path": url.path,
                "name": url.lastPathComponent,
                "size": size,
                "kind": "image"
            ]
            if let thumb = makeThumbnailDataURL(for: url) {
                item["thumbnail"] = thumb
            }
            return item
        }

        if ext == "pdf" {
            let extracted = extractPDFText(for: url)
            if let txtURL = extracted.txtURL {
                pendingPDFTextFiles[url.standardizedFileURL.path] = txtURL
            }
            return [
                "path": url.path,
                "name": url.lastPathComponent,
                "size": size,
                "kind": "pdf",
                "pageCount": extracted.pageCount,
                "textExtracted": extracted.txtURL != nil
            ]
        }

        let kind = isTextFile(at: url, size: size) ? "text" : "other"
        return [
            "path": url.path,
            "name": url.lastPathComponent,
            "size": size,
            "kind": kind
        ]
    }

    private func makeThumbnailDataURL(for url: URL) -> String? {
        guard let src = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
        let opts: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxThumbnailPixelSize
        ]
        guard let cgImage = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else {
            return nil
        }
        let rep = NSBitmapImageRep(cgImage: cgImage)
        guard let jpegData = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.8]) else {
            return nil
        }
        return "data:image/jpeg;base64,\(jpegData.base64EncodedString())"
    }

    private func isTextFile(at url: URL, size: Int) -> Bool {
        guard size <= maxTextFileSize else { return false }
        guard let handle = try? FileHandle(forReadingFrom: url) else { return false }
        defer { try? handle.close() }
        guard let probe = try? handle.read(upToCount: maxTextProbeBytes) else { return false }
        return !probe.contains(0)
    }

    private func extractPDFText(for url: URL) -> (pageCount: Int, txtURL: URL?) {
        guard let doc = PDFDocument(url: url) else { return (0, nil) }
        let totalPages = doc.pageCount
        let limit = min(totalPages, maxPDFPages)
        var chunks: [String] = []
        for idx in 0..<limit {
            if let text = doc.page(at: idx)?.string,
               !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                chunks.append(text)
            }
        }
        let joined = chunks.joined(separator: "\n\n").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !joined.isEmpty else { return (totalPages, nil) }

        let baseName = url.deletingPathExtension().lastPathComponent
        let txtURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("ca-pdf-\(UUID().uuidString.prefix(8))-\(baseName).txt")
        do {
            try joined.write(to: txtURL, atomically: true, encoding: .utf8)
            return (totalPages, txtURL)
        } catch {
            return (totalPages, nil)
        }
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
        let screen = notchScreen()
        let targetFrame = topCenteredFrame(for: currentSize, on: screen)
        panel.setFrame(targetFrame, display: true)
        if let sheet = workspaceSheetPanel, sheet.isVisible {
            let vis = screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
            let clamped = NSSize(
                width: min(workspaceSheetSize.width, max(480.0, vis.width - 48.0)),
                height: min(workspaceSheetSize.height, max(320.0, vis.height - 16.0))
            )
            sheet.setFrame(topCenteredFrame(for: clamped, on: screen), display: true)
        }
        if notesHeight > 0 && notesPanel.isVisible {
            notesPanel.setFrame(notesFrame(for: notesWidth, height: notesHeight, on: screen), display: true)
        }
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
        guard !inspectLoopStarted else { return }
        inspectLoopStarted = true
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
                "notes": quartzRectDict(for: notesPanel) ?? NSNull(),
                "workspace": quartzRectDict(for: (workspaceSheetPanel?.isVisible == true ? workspaceSheetPanel : nil) ?? workspaceWindow) ?? NSNull()
            ])
        case "eval":
            let target = req["target"] as? String ?? "notch"
            let js = req["js"] as? String ?? ""
            let wv: WKWebView? = (target == "workspace") ? ((workspaceSheetPanel?.isVisible == true ? workspaceSheetWebView : nil) ?? workspaceWebView) : webView
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
