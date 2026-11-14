// ComputerAnything overlay: a click-through panel per screen with one cursor per agent.
// Reads newline-delimited JSON on stdin. Coordinates: top-left-origin global screen points.
// Every op may carry "cursor" (agent id, default "main"), "name" (tag text) and "color" ("#RRGGBB").
//   {"op":"cursor","cursor":"cu-2","name":"QA","color":"#FF7A00"}   create / rename / recolor
//   {"op":"remove","cursor":"cu-2"}
//   {"op":"point","x":100,"y":200,"label":"Save"}
//   {"op":"draw","shape":"circle|rect|arrow","x":..,"y":..,"w":..,"h":..}
//   {"op":"highlight","x":..,"y":..,"w":..,"h":..}
//   {"op":"click","x":..,"y":..}   (CGEvent; needs Accessibility permission)
//   {"op":"quit"}
// Build: swiftc -O Overlay.swift -o overlay
import AppKit

let blue = NSColor(calibratedRed: 0.20, green: 0.50, blue: 1.0, alpha: 1.0)

func color(_ hex: String?) -> NSColor {
    guard var h = hex?.trimmingCharacters(in: .whitespaces), h.hasPrefix("#"), h.count == 7 else { return blue }
    h.removeFirst()
    let v = UInt32(h, radix: 16) ?? 0x3380FF
    return NSColor(calibratedRed: CGFloat((v >> 16) & 0xFF) / 255, green: CGFloat((v >> 8) & 0xFF) / 255,
                   blue: CGFloat(v & 0xFF) / 255, alpha: 1)
}

// One agent's cursor: a colored triangle plus a name tag that follows it.
final class Cursor {
    let layer = CAShapeLayer()
    let label = CATextLayer()
    var pos: CGPoint
    var name: String
    var tint: NSColor

    init(name: String, tint: NSColor, start: CGPoint) {
        self.name = name; self.tint = tint; self.pos = start
        let path = CGMutablePath()
        path.move(to: .zero)
        path.addLine(to: CGPoint(x: 8, y: -22))
        path.addLine(to: CGPoint(x: 20, y: -14))
        path.closeSubpath()
        layer.path = path
        layer.strokeColor = NSColor.white.cgColor
        layer.lineWidth = 1.5
        layer.shadowOpacity = 0.4
        layer.shadowRadius = 4
        label.fontSize = 13
        label.foregroundColor = NSColor.white.cgColor
        label.cornerRadius = 6
        label.alignmentMode = .center
        label.contentsScale = NSScreen.main?.backingScaleFactor ?? 2
        label.isHidden = true
        recolor(tint)
    }

    func recolor(_ c: NSColor) {
        tint = c
        layer.fillColor = c.cgColor
        label.backgroundColor = c.cgColor
    }
}

final class Overlay {
    var panels: [(NSPanel, NSView)] = []
    var cursors: [String: Cursor] = [:]
    let primaryHeight = NSScreen.screens.first?.frame.height ?? 0

    init() {
        for screen in NSScreen.screens {
            let p = NSPanel(contentRect: screen.frame, styleMask: [.borderless, .nonactivatingPanel],
                            backing: .buffered, defer: false)
            p.isOpaque = false
            p.backgroundColor = .clear
            p.hasShadow = false
            p.ignoresMouseEvents = true
            p.level = .screenSaver
            p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
            let v = NSView(frame: NSRect(origin: .zero, size: screen.frame.size))
            v.wantsLayer = true
            p.contentView = v
            p.setFrame(screen.frame, display: true)
            p.orderFrontRegardless()
            panels.append((p, v))
        }
    }

    // Each agent id gets its own cursor; new ones start staggered so they don't stack.
    func cursor(_ id: String, name: String? = nil, hex: String? = nil) -> Cursor {
        if let c = cursors[id] {
            if let n = name, !n.isEmpty { c.name = n }
            if hex != nil { c.recolor(color(hex)) }
            return c
        }
        let start = CGPoint(x: 200 + Double(cursors.count) * 60, y: 200)
        let c = Cursor(name: name ?? (id == "main" ? "" : id), tint: color(hex), start: start)
        cursors[id] = c
        return c
    }

    func remove(_ id: String) {
        guard let c = cursors.removeValue(forKey: id) else { return }
        c.layer.removeFromSuperlayer(); c.label.removeFromSuperlayer()
    }

    // top-left global -> AppKit bottom-left global
    func appKit(_ x: Double, _ y: Double) -> CGPoint { CGPoint(x: x, y: primaryHeight - y) }

    func host(for p: CGPoint) -> (NSPanel, NSView)? {
        panels.first { $0.0.frame.contains(p) } ?? panels.first
    }
    func local(_ p: CGPoint, _ panel: NSPanel) -> CGPoint {
        CGPoint(x: p.x - panel.frame.minX, y: p.y - panel.frame.minY)
    }

    func point(_ c: Cursor, _ x: Double, _ y: Double, _ text: String?) {
        let target = appKit(x, y)
        guard let (panel, view) = host(for: target), let root = view.layer else { return }
        if c.layer.superlayer !== root { root.addSublayer(c.layer); root.addSublayer(c.label) }
        let from = local(c.pos, panel), to = local(target, panel)
        // Quadratic bezier flight with an arc.
        let mid = CGPoint(x: (from.x + to.x) / 2, y: max(from.y, to.y) + 120)
        let path = CGMutablePath()
        path.move(to: from)
        path.addQuadCurve(to: to, control: mid)
        let anim = CAKeyframeAnimation(keyPath: "position")
        anim.path = path
        anim.duration = 0.7
        anim.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        c.layer.position = to
        c.layer.add(anim, forKey: "fly")
        let parts = [c.name, text ?? ""].filter { !$0.isEmpty }
        if !parts.isEmpty {
            let t = parts.joined(separator: ": ")
            c.label.string = " \(t) "
            c.label.frame = CGRect(x: to.x + 22, y: to.y - 40, width: CGFloat(t.count) * 8 + 20, height: 20)
            c.label.isHidden = false
        } else { c.label.isHidden = true }
        CATransaction.commit()
        c.pos = target
    }

    func shape(_ kind: String, _ x: Double, _ y: Double, _ w: Double, _ h: Double, fill: Bool, tint: NSColor = blue) {
        let tl = appKit(x, y)
        guard let (panel, view) = host(for: tl), let root = view.layer else { return }
        let o = local(tl, panel)
        let rect = CGRect(x: o.x, y: o.y - h, width: w, height: h)
        let layer = CAShapeLayer()
        let path = CGMutablePath()
        switch kind {
        case "circle": path.addEllipse(in: rect.insetBy(dx: -6, dy: -6))
        case "arrow":
            let a = CGPoint(x: rect.minX, y: rect.maxY), b = CGPoint(x: rect.maxX, y: rect.minY)
            path.move(to: a); path.addLine(to: b)
            let ang = atan2(b.y - a.y, b.x - a.x), len: CGFloat = 18
            path.move(to: b); path.addLine(to: CGPoint(x: b.x - len * cos(ang - .pi / 7), y: b.y - len * sin(ang - .pi / 7)))
            path.move(to: b); path.addLine(to: CGPoint(x: b.x - len * cos(ang + .pi / 7), y: b.y - len * sin(ang + .pi / 7)))
        default: path.addRoundedRect(in: rect.insetBy(dx: -4, dy: -4), cornerWidth: 6, cornerHeight: 6)
        }
        layer.path = path
        layer.strokeColor = tint.cgColor
        layer.lineWidth = fill ? 2 : 4
        layer.lineCap = .round
        layer.fillColor = fill ? tint.withAlphaComponent(0.18).cgColor : NSColor.clear.cgColor
        root.insertSublayer(layer, at: 0)   // shapes sit under every cursor
        let draw = CABasicAnimation(keyPath: "strokeEnd")
        draw.fromValue = 0; draw.toValue = 1; draw.duration = 0.6
        layer.add(draw, forKey: "draw")
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) {
            CATransaction.begin()
            CATransaction.setCompletionBlock { layer.removeFromSuperlayer() }
            let fade = CABasicAnimation(keyPath: "opacity")
            fade.fromValue = 1; fade.toValue = 0; fade.duration = 0.5
            layer.opacity = 0
            layer.add(fade, forKey: "fade")
            CATransaction.commit()
        }
    }

    func click(_ x: Double, _ y: Double) {
        let p = CGPoint(x: x, y: y)  // CGEvent uses top-left global coords already
        let src = CGEventSource(stateID: .hidSystemState)
        for t in [CGEventType.mouseMoved, .leftMouseDown, .leftMouseUp] {
            CGEvent(mouseEventSource: src, mouseType: t, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
            usleep(30_000)
        }
    }

    func handle(_ line: String) {
        guard let data = line.data(using: .utf8),
              let j = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let op = j["op"] as? String else { return }
        let d = { (k: String) in (j[k] as? NSNumber)?.doubleValue ?? 0 }
        let c = cursor(j["cursor"] as? String ?? "main", name: j["name"] as? String, hex: j["color"] as? String)
        switch op {
        case "cursor": break   // create or rename/recolor only
        case "remove": remove(j["cursor"] as? String ?? "")
        case "point": point(c, d("x"), d("y"), j["label"] as? String)
        case "draw": shape(j["shape"] as? String ?? "rect", d("x"), d("y"), d("w"), d("h"), fill: false, tint: c.tint)
        case "highlight": shape("rect", d("x"), d("y"), d("w"), d("h"), fill: true, tint: c.tint)
        case "click": point(c, d("x"), d("y"), nil); DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { self.click(d("x"), d("y")) }
        case "quit": NSApp.terminate(nil)
        default: break
        }
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)  // never becomes the active app: the user keeps focus and keyboard
let overlay = Overlay()
DispatchQueue.global().async {
    while let line = readLine() {
        DispatchQueue.main.async { overlay.handle(line) }
    }
    DispatchQueue.main.async { NSApp.terminate(nil) }
}
app.run()
