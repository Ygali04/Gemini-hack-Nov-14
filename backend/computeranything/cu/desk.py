"""How several agents share one Mac without stepping on each other.

- Foreground lock: only one agent at a time may change focus, use Spotlight or type with physical keys.
  Ref clicks are headless, so the others keep working while one holds it.
- App leases: one agent per app, so two agents never drive the same window.
- Lanes: each agent's window is placed in its own tile on the stage display, so raising one window
  never covers another agent's work.
"""

import contextlib
import json
import os
import subprocess
import threading
import time

_fg = threading.Lock()
_fg_owner = {"agent": None, "since": 0.0}
_cv = threading.Condition()
LEASES = {}  # app name (lower) -> agent
LANES = {}  # agent -> {"x","y","w","h","display"}
_layout = {"n": 1, "free": [0]}
TOP_INSET = 32  # menu bar


class Busy(RuntimeError):
    pass


@contextlib.contextmanager
def foreground(agent, timeout=60):
    """Hold the screen's focus for a short sequence (Spotlight, activate, physical keys)."""
    if not _fg.acquire(timeout=timeout):
        raise Busy("foreground held by %s for %.0fs" % (_fg_owner["agent"], time.time() - _fg_owner["since"]))
    _fg_owner.update(agent=agent, since=time.time())
    try:
        yield
    finally:
        _fg_owner.update(agent=None, since=0.0)
        _fg.release()


def lease(app, agent, timeout=120):
    """Block until no other agent is driving `app`, then take it."""
    key = app.lower()
    with _cv:
        if not _cv.wait_for(lambda: LEASES.get(key) in (None, agent), timeout=timeout):
            raise Busy("%s is in use by %s" % (app, LEASES.get(key)))
        LEASES[key] = agent


def unlease(app, agent):
    with _cv:
        if LEASES.get(app.lower()) == agent:
            del LEASES[app.lower()]
        _cv.notify_all()


def displays():
    try:
        out = subprocess.run(["agent-desktop", "list-displays"], capture_output=True, text=True, timeout=20).stdout
        return json.loads(out).get("data") or []
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return []


def stage():
    """The display agents work on: CA_STAGE_DISPLAY id, else a secondary display, else the primary."""
    ds = displays()
    want = os.environ.get("CA_STAGE_DISPLAY")
    pick = next((d for d in ds if want and str(d["id"]) == want), None)
    pick = pick or next((d for d in ds if not d.get("is_primary")), None) or (ds[0] if ds else None)
    return pick["bounds"] if pick else {"x": 0, "y": 0, "width": 1440, "height": 900}


def plan(n):
    """Lay out lanes for n agents: whole stage (1), two columns (2), 2x2 grid (3-4)."""
    with _cv:
        _layout["n"] = max(1, min(4, n))
        _layout["free"] = list(range(_layout["n"] if _layout["n"] != 3 else 4))


def rect(slot, n, b):
    x, y, w, h = b["x"], b["y"] + TOP_INSET, b["width"], b["height"] - TOP_INSET
    if n == 1:
        return {"x": x + 20, "y": y + 10, "w": w - 40, "h": h - 30}
    if n == 2:
        return {"x": x + slot * w / 2 + 10, "y": y + 10, "w": w / 2 - 20, "h": h - 30}
    col, row = slot % 2, slot // 2
    return {"x": x + col * w / 2 + 10, "y": y + row * h / 2 + 10, "w": w / 2 - 20, "h": h / 2 - 20}


def lane(agent):
    """This agent's tile; assigned on first call and kept until release()."""
    with _cv:
        if agent not in LANES:
            slot = _layout["free"].pop(0) if _layout["free"] else len(LANES) % 4
            LANES[agent] = dict(rect(slot, _layout["n"], stage()), slot=slot)
        return LANES[agent]


def release(agent):
    with _cv:
        ln = LANES.pop(agent, None)
        if ln is not None:
            _layout["free"].append(ln["slot"])
        for k in [k for k, v in LEASES.items() if v == agent]:
            del LEASES[k]
        _cv.notify_all()


def selftest():
    plan(2)
    a, b = (
        rect(0, 2, {"x": 1728, "y": 0, "width": 1920, "height": 1080}),
        rect(1, 2, {"x": 1728, "y": 0, "width": 1920, "height": 1080}),
    )
    assert a["x"] + a["w"] <= b["x"], "two lanes must not overlap"
    lease("Calculator", "CU 1")
    t0 = time.time()
    threading.Timer(0.3, lambda: unlease("Calculator", "CU 1")).start()
    lease("Calculator", "CU 2", timeout=5)  # waits for CU 1 to let go
    assert LEASES["calculator"] == "CU 2" and time.time() - t0 >= 0.25
    with foreground("CU 1"):
        got = []
        th = threading.Thread(target=lambda: got.append(_fg.acquire(timeout=0.1)))
        th.start()
        th.join()
        assert got == [False], "a second agent must not get the foreground while one holds it"
    release("CU 2")
    assert "calculator" not in LEASES
    print("desk selftest OK")


if __name__ == "__main__":
    selftest()
