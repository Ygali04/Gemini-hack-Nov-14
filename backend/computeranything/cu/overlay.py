"""The blue cursor. Owns the Swift overlay process and talks to it over an inherited pipe
(no path on disk, so nothing else on the machine can send it clicks)."""
import json, os, subprocess, threading

BACKEND = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
BIN = os.path.join(BACKEND, "overlay", "overlay")
SRC = os.path.join(BACKEND, "overlay", "Overlay.swift")
_proc, _lock = None, threading.Lock()


def start():
    global _proc
    if not os.path.exists(BIN) or os.path.getmtime(BIN) < os.path.getmtime(SRC):
        subprocess.run(["swiftc", "-O", SRC, "-o", BIN], check=True)
    if _proc is None or _proc.poll() is not None:
        _proc = subprocess.Popen([BIN], stdin=subprocess.PIPE, text=True)
    return _proc


def send(*ops):
    """point/draw/highlight in global top-left screen points. Silently no-op if not started."""
    with _lock:
        if _proc is None or _proc.poll() is not None:
            return False
        for o in ops:
            _proc.stdin.write(json.dumps(o) + "\n")
        _proc.stdin.flush()
        return True


def point_at(bounds, label):
    if not bounds:
        return False
    x, y = bounds["x"] + bounds["width"] / 2, bounds["y"] + bounds["height"] / 2
    return send({"op": "point", "x": x, "y": y, "label": label[:40]},
                {"op": "draw", "shape": "rect", "x": bounds["x"] - 4, "y": bounds["y"] - 4,
                 "w": bounds["width"] + 8, "h": bounds["height"] + 8})


def stop():
    if _proc and _proc.poll() is None:
        send({"op": "quit"})
        _proc.terminate()
