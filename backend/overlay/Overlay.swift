// ComputerAnything overlay: a click-through panel per screen with one sea-glass cursor per agent.
// Reads newline-delimited JSON on stdin. Coordinates: top-left-origin global screen points.
// Every op may carry "cursor" (agent id, default "main"), "name" (tag text) and a sea-glass palette:
// "color" (body, #RRGGBB), optional "edge" and "ink"; missing ones are derived from the body.
//   {"op":"cursor","cursor":"cu-2","name":"QA","color":"#B5D0EB","edge":"#D6E9FF","ink":"#2F647C"}
//   {"op":"remove","cursor":"cu-2"}
//   {"op":"point","x":100,"y":200,"label":"Save"}
//   {"op":"draw","shape":"circle|rect|arrow","x":..,"y":..,"w":..,"h":..}
//   {"op":"highlight","x":..,"y":..,"w":..,"h":..}
//   {"op":"click","x":..,"y":..}   (CGEvent; needs Accessibility permission)
//   {"op":"quit"}
// Material after Sea Glass (github.com/mttmcknn/sea-glass, Apache-2.0): frosted body, luminous rim from
// a fixed overhead light, soft specular, tinted contact shadow. Build: swiftc -O Overlay.swift -o overlay
import AppKit

func hex(_ s: String?, _ fallback: NSColor) -> NSColor {
    guard var h = s?.trimmingCharacters(in: .whitespaces), h.hasPrefix("#"), h.count == 7 else { return fallback }
    h.removeFirst()
    let v = UInt32(h, radix: 16) ?? 0
    return NSColor(srgbRed: CGFloat((v >> 16) & 0xFF) / 255, green: CGFloat((v >> 8) & 0xFF) / 255,
                   blue: CGFloat(v & 0xFF) / 255, alpha: 1)
}

func mix(_ a: NSColor, _ b: NSColor, _ t: CGFloat) -> NSColor {
    let a = a.usingColorSpace(.sRGB)!, b = b.usingColorSpace(.sRGB)!
    return NSColor(srgbRed: a.redComponent + (b.redComponent - a.redComponent) * t,
                   green: a.greenComponent + (b.greenComponent - a.greenComponent) * t,
                   blue: a.blueComponent + (b.blueComponent - a.blueComponent) * t, alpha: 1)
}

struct Glass {
    var body: NSColor, edge: NSColor, ink: NSColor
    static let lagoon = Glass(body: hex("#B5D0EB", .gray), edge: hex("#D6E9FF", .white), ink: hex("#2F647C", .black))
    init(body: NSColor, edge: NSColor, ink: NSColor) { self.body = body; self.edge = edge; self.ink = ink }
    init(_ j: [String: Any]) {
        let b = hex(j["color"] as? String, Glass.lagoon.body)
        body = b
        edge = hex(j["edge"] as? String, mix(b, .white, 0.6))
        ink = hex(j["ink"] as? String, mix(b, .black, 0.62))
    }
}

let reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion

// A pointer with softly tumbled corners, tip at (0,0), pointing up-left (layer coords, y up).
func pebblePath(scale s: CGFloat = 1.0) -> CGPath {
    let pts = [CGPoint(x: 0, y: 0), CGPoint(x: 7 * s, y: -22 * s), CGPoint(x: 11.5 * s, y: -15 * s),
               CGPoint(x: 21 * s, y: -11.5 * s)]
    // each radius's tangent run must fit its short notch edges, else the arcs loop past each other
    let radii: [CGFloat] = [1.6, 2.0, 1.0, 2.0].map { $0 * s }
    let p = CGMutablePath()
    let n = pts.count
    let mid = CGPoint(x: (pts[n - 1].x + pts[0].x) / 2, y: (pts[n - 1].y + pts[0].y) / 2)
    p.move(to: mid)
    for i in 0..<n {
        p.addArc(tangent1End: pts[i], tangent2End: pts[(i + 1) % n], radius: radii[i])
    }
    p.closeSubpath()
    return p
}

// Paints the pebble once per palette: domed radial body, soft specular near the crown, a luminous rim
// inside the edge (bright on top, fading below), and a faint ink hairline so it still reads on white.
func pebbleImage(_ g: Glass, _ path: CGPath, _ box: CGRect, _ px: CGFloat) -> CGImage? {
    let cs = CGColorSpace(name: CGColorSpace.sRGB)!
    guard let ctx = CGContext(data: nil, width: Int(ceil(box.width * px)), height: Int(ceil(box.height * px)),
                              bitsPerComponent: 8, bytesPerRow: 0, space: cs,
                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
    ctx.scaleBy(x: px, y: px)
    ctx.translateBy(x: -box.minX, y: -box.minY)
    let pb = path.boundingBoxOfPath
    let crown = CGPoint(x: pb.minX + pb.width * 0.32, y: pb.maxY - pb.height * 0.3)
    func grad(_ c: [NSColor], _ loc: [CGFloat]) -> CGGradient {
        CGGradient(colorsSpace: cs, colors: c.map { $0.cgColor } as CFArray, locations: loc)!
    }
    ctx.saveGState()
    ctx.addPath(path); ctx.clip()
    ctx.drawRadialGradient(grad([mix(g.body, .white, 0.45), g.body, mix(g.body, g.ink, 0.45)], [0, 0.45, 1]),
                           startCenter: crown, startRadius: 0, endCenter: crown,
                           endRadius: max(pb.width, pb.height) * 0.9, options: [.drawsAfterEndLocation])
    let spot = CGPoint(x: crown.x + 1, y: crown.y + 3)
    ctx.drawRadialGradient(grad([NSColor(white: 1, alpha: 0.85), NSColor(white: 1, alpha: 0)], [0, 1]),
                           startCenter: spot, startRadius: 0, endCenter: spot, endRadius: pb.width * 0.3, options: [])
    ctx.addPath(path); ctx.setLineWidth(3); ctx.replacePathWithStrokedPath(); ctx.clip()  // inner half of the edge
    ctx.drawLinearGradient(grad([g.edge, g.edge.withAlphaComponent(0.15)], [0, 1]),
                           start: CGPoint(x: 0, y: pb.maxY), end: CGPoint(x: 0, y: pb.minY), options: [])
    ctx.restoreGState()
    ctx.addPath(path)
    ctx.setStrokeColor(g.ink.withAlphaComponent(0.25).cgColor); ctx.setLineWidth(0.75); ctx.strokePath()
    return ctx.makeImage()
}

let pixelScale = NSScreen.screens.map { $0.backingScaleFactor }.max() ?? 2

// One agent's cursor: a 3D sea-glass pebble plus a frosted name tag that follows it.
final class Cursor {
    let root = CALayer()
    let shadow = CAShapeLayer()
    let glyph = CALayer()
    let tag = CALayer()
    let tagRim = CAGradientLayer()
    let text = CATextLayer()
    let path = pebblePath(scale: 1.4)
    let box: CGRect
    var pos: CGPoint
    var name: String
    var glass: Glass

    init(name: String, glass: Glass, start: CGPoint) {
        self.name = name; self.glass = glass; self.pos = start
        box = path.boundingBoxOfPath.insetBy(dx: -2, dy: -2)
        root.bounds = CGRect(x: 0, y: 0, width: 1, height: 1)
        root.anchorPoint = .zero
        // contact shadow: fixed overhead light, so it always falls straight below the body
        shadow.path = path
        shadow.position = CGPoint(x: 1.5, y: -4.5)
        shadow.fillColor = NSColor.clear.cgColor
        shadow.shadowPath = path
        shadow.shadowOffset = .zero
        shadow.shadowRadius = 5
        shadow.shadowOpacity = 0.45
        glyph.frame = box
        glyph.contentsScale = pixelScale
        // frosted name tag
        tag.cornerRadius = 10
        tag.borderWidth = 0.5
        tag.shadowOpacity = 0.18; tag.shadowRadius = 6; tag.shadowOffset = CGSize(width: 0, height: -2)
        tagRim.startPoint = CGPoint(x: 0.5, y: 1); tagRim.endPoint = CGPoint(x: 0.5, y: 0)
        tagRim.cornerRadius = 10
        text.fontSize = 12
        text.font = NSFont.systemFont(ofSize: 12, weight: .semibold)
        text.contentsScale = pixelScale
        text.alignmentMode = .center
        tag.addSublayer(tagRim); tag.addSublayer(text)
        tag.isHidden = true
        for l in [shadow, glyph, tag] as [CALayer] { root.addSublayer(l) }
        apply(glass)
    }

    func apply(_ g: Glass) {
        glass = g
        shadow.shadowColor = mix(g.body, g.ink, 0.55).cgColor
        glyph.contents = pebbleImage(g, path, box, pixelScale)
        tag.backgroundColor = mix(g.body, .white, 0.45).withAlphaComponent(0.88).cgColor
        tag.borderColor = g.edge.withAlphaComponent(0.9).cgColor
        tag.shadowColor = g.ink.cgColor
        tagRim.colors = [NSColor(white: 1, alpha: 0.55).cgColor, NSColor(white: 1, alpha: 0).cgColor]
        text.foregroundColor = g.ink.cgColor
    }

    func setTag(_ s: String?) {
        let parts = [name, s ?? ""].filter { !$0.isEmpty }
        guard !parts.isEmpty else { tag.isHidden = true; return }
        let t = parts.joined(separator: ": ")
        let w = (t as NSString).size(withAttributes: [.font: NSFont.systemFont(ofSize: 12, weight: .semibold)]).width
        tag.frame = CGRect(x: 22, y: -42, width: ceil(w) + 22, height: 22)
        tagRim.frame = CGRect(x: 0, y: 11, width: tag.frame.width, height: 11)
        text.frame = CGRect(x: 0, y: 3, width: tag.frame.width, height: 16)
        text.string = t
        tag.isHidden = false
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
    func cursor(_ id: String, _ j: [String: Any]) -> Cursor {
        if let c = cursors[id] {
            if let n = j["name"] as? String, !n.isEmpty { c.name = n }
            if j["color"] != nil { c.apply(Glass(j)) }
            return c
        }
        let start = CGPoint(x: 200 + Double(cursors.count) * 60, y: 200)
        let c = Cursor(name: (j["name"] as? String) ?? (id == "main" ? "" : id), glass: j["color"] != nil ? Glass(j) : .lagoon,
                       start: start)
        cursors[id] = c
        return c
    }

    func remove(_ id: String) {
        guard let c = cursors.removeValue(forKey: id) else { return }
        CATransaction.begin()
        CATransaction.setCompletionBlock { c.root.removeFromSuperlayer() }
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 1; fade.toValue = 0; fade.duration = 0.35
        c.root.opacity = 0
        c.root.add(fade, forKey: "out")
        CATransaction.commit()
    }

    // top-left global -> AppKit bottom-left global
    func appKit(_ x: Double, _ y: Double) -> CGPoint { CGPoint(x: x, y: primaryHeight - y) }

    func host(for p: CGPoint) -> (NSPanel, NSView)? {
        panels.first { $0.0.frame.contains(p) } ?? panels.first
    }
    func local(_ p: CGPoint, _ panel: NSPanel) -> CGPoint {
        CGPoint(x: p.x - panel.frame.minX, y: p.y - panel.frame.minY)
    }

    func point(_ c: Cursor, _ x: Double, _ y: Double, _ label: String?) {
        let target = appKit(x, y)
        guard let (panel, view) = host(for: target), let root = view.layer else { return }
        let fresh = c.root.superlayer !== root
        if fresh { root.addSublayer(c.root) }
        let from = local(c.pos, panel), to = local(target, panel)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        c.root.position = to
        c.setTag(label)
        CATransaction.commit()
        if reduceMotion || fresh {
            // no travel: the cursor appears at the target, so the change is still visible without motion
            let fade = CABasicAnimation(keyPath: "opacity")
            fade.fromValue = 0; fade.toValue = 1; fade.duration = 0.2
            c.root.add(fade, forKey: "in")
        } else {
            // a short, low arc that settles, then a small squash on arrival
            let dx = to.x - from.x, dy = to.y - from.y
            let lift = min(80, hypot(dx, dy) * 0.18)
            let path = CGMutablePath()
            path.move(to: from)
            path.addQuadCurve(to: to, control: CGPoint(x: from.x + dx * 0.5, y: max(from.y, to.y) + lift))
            let fly = CAKeyframeAnimation(keyPath: "position")
            fly.path = path
            fly.duration = 0.5
            fly.timingFunction = CAMediaTimingFunction(controlPoints: 0.22, 0.9, 0.28, 1)
            let squash = CAKeyframeAnimation(keyPath: "transform.scale")
            squash.values = [1, 1, 0.9, 1.04, 1]
            squash.keyTimes = [0, 0.82, 0.9, 0.96, 1]
            squash.duration = 0.62
            c.root.add(fly, forKey: "fly")
            c.root.add(squash, forKey: "settle")
        }
        c.pos = target
    }

    // Target marks: a thin rounded outline in the agent's ink with a faint glass tint. No glow.
    func shape(_ kind: String, _ x: Double, _ y: Double, _ w: Double, _ h: Double, fill: Bool, glass g: Glass) {
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
            let ang = atan2(b.y - a.y, b.x - a.x), len: CGFloat = 14
            path.move(to: b); path.addLine(to: CGPoint(x: b.x - len * cos(ang - .pi / 7), y: b.y - len * sin(ang - .pi / 7)))
            path.move(to: b); path.addLine(to: CGPoint(x: b.x - len * cos(ang + .pi / 7), y: b.y - len * sin(ang + .pi / 7)))
        default:
            let r = min(10, min(rect.width, rect.height) * 0.3)
            path.addRoundedRect(in: rect.insetBy(dx: -4, dy: -4), cornerWidth: r, cornerHeight: r)
        }
        layer.frame = root.bounds
        layer.path = path
        layer.strokeColor = g.ink.withAlphaComponent(0.55).cgColor
        layer.lineWidth = 1.25
        layer.lineCap = .round
        layer.lineJoin = .round
        layer.fillColor = (kind == "arrow" ? NSColor.clear : g.body.withAlphaComponent(fill ? 0.28 : 0.14)).cgColor
        root.insertSublayer(layer, at: 0)  // marks sit under every cursor
        // appear: settle from slightly larger, with the outline drawing itself
        let center = CGPoint(x: rect.midX, y: rect.midY)
        layer.anchorPoint = CGPoint(x: center.x / max(1, root.bounds.width), y: center.y / max(1, root.bounds.height))
        layer.position = center
        if !reduceMotion {
            let grow = CABasicAnimation(keyPath: "transform.scale")
            grow.fromValue = 1.06; grow.toValue = 1; grow.duration = 0.35
            grow.timingFunction = CAMediaTimingFunction(name: .easeOut)
            let draw = CABasicAnimation(keyPath: "strokeEnd")
            draw.fromValue = 0; draw.toValue = 1; draw.duration = 0.45
            layer.add(grow, forKey: "grow"); layer.add(draw, forKey: "draw")
        }
        let fadeIn = CABasicAnimation(keyPath: "opacity")
        fadeIn.fromValue = 0; fadeIn.toValue = 1; fadeIn.duration = 0.2
        layer.add(fadeIn, forKey: "in")
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.8) {
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
        let id = j["cursor"] as? String ?? "main"
        if op == "remove" { remove(id); return }
        if op == "quit" { NSApp.terminate(nil); return }
        let c = cursor(id, j)
        switch op {
        case "point": point(c, d("x"), d("y"), j["label"] as? String)
        case "draw": shape(j["shape"] as? String ?? "rect", d("x"), d("y"), d("w"), d("h"), fill: false, glass: c.glass)
        case "highlight": shape("rect", d("x"), d("y"), d("w"), d("h"), fill: true, glass: c.glass)
        case "click": point(c, d("x"), d("y"), nil); DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { self.click(d("x"), d("y")) }
        default: break  // "cursor": create, rename or recolor only
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
