"""Render every sea-glass palette in the overlay, capture only the overlay window, and composite it on mock
light and dark UIs. Writes PNGs to the output dir (default ../docs/img/seaglass). Never captures the user's screen.

    python3 scripts/shoot_overlay.py [out_dir]
"""

import json
import os
import subprocess
import sys
import tempfile
import threading
import time

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "..", "..", "docs", "img", "seaglass")
X = 2  # capture is at 2x on Retina
PAL = [
    ("#B5D0EB", "#D6E9FF", "#2F647C"),  # lagoon
    ("#EECED6", "#FFF0F1", "#963F59"),  # rose
    ("#C0DED0", "#E6FFF0", "#396C5A"),  # mint
    ("#E1CDE8", "#FBE8F7", "#71388B"),  # lilac
    ("#F0D9BE", "#FFFCE0", "#865733"),  # amber
]
NAMES = [("CU 1", "Save"), ("QA", "Run tests"), ("Marketing", "Export"), ("CU 2", "Search"), ("Dev", "Commit")]
BTN_Y, FIELD_Y, ICON_Y = 320, 450, 530

# Lists the overlay's own windows (id, x, y) so screencapture -l grabs that window alone.
WINDOWS_SWIFT = """
import CoreGraphics
let l = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as! [[String: Any]]
for w in l where (w[kCGWindowOwnerName as String] as? String) == "overlay" {
  let b = w[kCGWindowBounds as String] as! [String: Any]
  print(w[kCGWindowNumber as String]!, b["X"]!, b["Y"]!)
}
"""


def capture(path):
    tmp = tempfile.mkdtemp()
    src, exe = os.path.join(tmp, "w.swift"), os.path.join(tmp, "w")
    with open(src, "w") as f:
        f.write(WINDOWS_SWIFT)
    subprocess.run(["swiftc", "-O", src, "-o", exe], check=True)
    rows = [r.split() for r in subprocess.run([exe], capture_output=True, text=True).stdout.splitlines()]
    wid = next(r[0] for r in rows if r[1:3] == ["0", "0"])  # the panel on the primary display
    subprocess.run(["screencapture", "-x", "-o", "-l", wid, path], check=True)


def render(panel_png):
    """Drive the overlay; returns how many distinct frontmost apps were seen (1 = focus never moved)."""
    front, done = [], threading.Event()

    def probe():
        while not done.is_set():
            out = subprocess.run(["lsappinfo", "front"], capture_output=True, text=True).stdout
            front.append(out.strip())
            time.sleep(0.1)

    threading.Thread(target=probe, daemon=True).start()
    p = subprocess.Popen([os.path.join(HERE, "..", "overlay", "overlay")], stdin=subprocess.PIPE, text=True)

    def send(**op):
        p.stdin.write(json.dumps(op) + "\n")
        p.stdin.flush()

    for i, (body, edge, ink) in enumerate(PAL):
        for cid, name in (("p%d" % i, ""), ("a%d" % i, NAMES[i][0]), ("f%d" % i, "")):
            send(op="cursor", cursor=cid, name=name, color=body, edge=edge, ink=ink)
    time.sleep(0.3)
    for i in range(5):
        send(op="point", cursor="p%d" % i, x=300 + i * 70, y=200, label="")
        send(op="point", cursor="a%d" % i, x=344 + i * 200, y=BTN_Y + 22, label=NAMES[i][1])
    time.sleep(0.4)
    for i in range(5):
        send(op="highlight", cursor="a%d" % i, x=260 + i * 200, y=BTN_Y, w=110, h=32)
        send(op="draw", cursor="f%d" % i, shape="rect", x=240 + i * 200, y=FIELD_Y, w=160, h=30)
        send(op="draw", cursor="f%d" % i, shape="circle", x=307 + i * 200, y=ICON_Y, w=26, h=26)
    time.sleep(0.9)  # marks fade after 1.8 s
    capture(panel_png)
    send(op="quit")
    p.wait(3)
    done.set()
    return len(set(front))


def font(size):
    for f in ("/System/Library/Fonts/SFNS.ttf", "/System/Library/Fonts/Helvetica.ttc"):
        try:
            return ImageFont.truetype(f, size * X)
        except OSError:
            pass
    return ImageFont.load_default()


def backdrop(size, dark):
    bg, card, line, ink, mute = (
        ("#1C1C1E", "#2C2C2E", "#3A3A3C", "#F2F2F7", "#8E8E93")
        if dark
        else ("#F2F2F4", "#FFFFFF", "#D1D1D6", "#1C1C1E", "#8E8E93")
    )
    im = Image.new("RGBA", size, bg)
    d = ImageDraw.Draw(im)
    big, small = font(13), font(12)

    def box(x, y, w, h, r):
        d.rounded_rectangle([x * X, y * X, (x + w) * X, (y + h) * X], r * X, fill=card, outline=line, width=X)

    for i in range(5):
        x, fx, cx = 260 + i * 200, 240 + i * 200, 307 + i * 200
        box(x, BTN_Y, 110, 32, 8)
        d.text(((x + 55) * X, (BTN_Y + 16) * X), NAMES[i][1], font=big, fill=ink, anchor="mm")
        box(fx, FIELD_Y, 160, 30, 6)
        d.text(((fx + 10) * X, (FIELD_Y + 15) * X), "Search files", font=small, fill=mute, anchor="lm")
        d.ellipse([cx * X, ICON_Y * X, (cx + 26) * X, (ICON_Y + 26) * X], fill=line)
    return im


def crop(im, x0, y0, x1, y1, zoom=1):
    c = im.crop((x0 * X, y0 * X, x1 * X, y1 * X))
    return c.resize((c.width * zoom, c.height * zoom), Image.LANCZOS) if zoom > 1 else c


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    panel = os.path.join(tempfile.mkdtemp(), "panel.png")
    distinct = render(panel)
    ov = Image.open(panel).convert("RGBA")
    for theme, dark in (("light", False), ("dark", True)):
        scene = Image.alpha_composite(backdrop(ov.size, dark), ov)
        plain = Image.alpha_composite(Image.new("RGBA", ov.size, "#1C1C1E" if dark else "#F2F2F4"), ov)
        crop(scene, 200, 295, 1300, 575).save(os.path.join(OUT, "scene_%s.png" % theme))
        crop(plain, 285, 185, 640, 250, zoom=2).save(os.path.join(OUT, "pointers_%s.png" % theme))
        crop(scene, 330, 330, 760, 390, zoom=2).save(os.path.join(OUT, "pills_%s.png" % theme))
        crop(scene, 230, 300, 640, 570).save(os.path.join(OUT, "bubbles_%s.png" % theme))
    print("wrote", OUT, "| frontmost apps seen:", distinct)
    assert distinct == 1, "the overlay changed the frontmost app"
