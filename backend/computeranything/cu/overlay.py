"""Agent cursors. Owns the Swift overlay process and talks to it over an inherited pipe (no path on disk,
so nothing else on the machine can send it clicks). Every CU agent claims its own cursor: own color,
own name tag, own position, so parallel agents are visibly separate on screen."""

import itertools
import json
import os
import subprocess
import threading

BACKEND = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
BIN = os.path.join(BACKEND, "overlay", "overlay")
SRC = os.path.join(BACKEND, "overlay", "Overlay.swift")
# Sea-glass palettes (body, edge, ink) after github.com/mttmcknn/sea-glass; the n-th agent gets PALETTE[n % len].
# Body is the frosted fill, edge the luminous rim, ink the label text and target outline.
PALETTE = [
    ("#B5D0EB", "#D6E9FF", "#2F647C"),  # lagoon
    ("#EECED6", "#FFF0F1", "#963F59"),  # rose
    ("#C0DED0", "#E6FFF0", "#396C5A"),  # mint
    ("#E1CDE8", "#FBE8F7", "#71388B"),  # lilac
    ("#F0D9BE", "#FFFCE0", "#865733"),  # amber
]
_proc, _lock = None, threading.Lock()
_next = itertools.count()
CURSORS = {}  # agent id -> {"name", "color"}


def start():
    global _proc
    if not os.path.exists(BIN) or os.path.getmtime(BIN) < os.path.getmtime(SRC):
        subprocess.run(["swiftc", "-O", SRC, "-o", BIN], check=True)
    if _proc is None or _proc.poll() is not None:
        _proc = subprocess.Popen([BIN], stdin=subprocess.PIPE, text=True)
    return _proc


def send(*ops):
    """Write ops in global top-left screen points. No-op (False) when the overlay isn't running."""
    with _lock:
        if _proc is None or _proc.poll() is not None:
            return False
        for o in ops:
            _proc.stdin.write(json.dumps(o) + "\n")
        _proc.stdin.flush()
        return True


def claim(agent_id, name):
    """Give an agent its own cursor. Returns its color."""
    with _lock:
        if agent_id not in CURSORS:
            body, edge, ink = PALETTE[next(_next) % len(PALETTE)]
            CURSORS[agent_id] = {"name": name, "color": body, "edge": edge, "ink": ink}
        c = CURSORS[agent_id]
    send({"op": "cursor", "cursor": agent_id, **c})
    return c["color"]


def release(agent_id):
    with _lock:
        CURSORS.pop(agent_id, None)
    send({"op": "remove", "cursor": agent_id})


def point_at(bounds, label, cursor="main"):
    """Fly this agent's cursor to the element's center and box it in the agent's color."""
    if not bounds:
        return False
    x, y = bounds["x"] + bounds["width"] / 2, bounds["y"] + bounds["height"] / 2
    me = CURSORS.get(cursor) or {}
    hello = bool(me) and not me.get("greeted")  # the first time this agent shows up, it says hi
    if hello:
        me["greeted"] = True
    pt = {"op": "point", "cursor": cursor, "x": x, "y": y, "label": label[:40]}
    if hello and me.get("name"):
        pt.update(label="Hi, I'm %s!" % me["name"], bare=True)
    return send(
        pt,
        {
            "op": "draw",
            "cursor": cursor,
            "shape": "rect",
            "x": bounds["x"],  # the overlay adds its own 4 pt margin
            "y": bounds["y"],
            "w": bounds["width"],
            "h": bounds["height"],
        },
    )


def stop():
    if _proc and _proc.poll() is None:
        send({"op": "quit"})
        _proc.terminate()
