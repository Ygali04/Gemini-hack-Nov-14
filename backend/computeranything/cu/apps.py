"""Opening apps behind the user's work, and knowing when they are really open.

Agents never take the user's focus or keyboard. open_app reuses a running window, else finds the .app on
disk or in Spotlight's index (mdfind, no Spotlight UI, no keystrokes) and launches it with `open -g`, which
starts it in the background. Then it waits until a window answers with accessibility elements and moves
that window into the agent's lane, without activating it. All later actions go to refs, headless.

AppleScript: agents may run scripts on purpose (run_applescript, gated and logged). Text that is
data (app names, typed text) is always passed as argv, never pasted into script source, so words
read off a web page can't turn into code.
"""

import glob
import os
import re
import subprocess
import time

from . import desktop

APP_DIRS = [
    "/Applications",
    "/Applications/Utilities",
    "/System/Applications",
    "/System/Applications/Utilities",
    os.path.expanduser("~/Applications"),
]


def _osa(lines, *args, timeout=20):
    """Run AppleScript with data passed as argv (item n of argv), never interpolated."""
    cmd = ["osascript", "-e", "on run argv"]
    for ln in lines:
        cmd += ["-e", ln]
    cmd += ["-e", "end run", *map(str, args)]
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    return p.returncode, (p.stdout + p.stderr).strip()


def find_app(name):
    """Path of the .app that best matches `name` (exact, prefix, contains), then Spotlight's index."""
    want = (name or "").lower().removesuffix(".app").strip()
    if not want:
        return None
    apps = [p for d in APP_DIRS for p in glob.glob(os.path.join(d, "*.app"))]
    stem = lambda p: os.path.basename(p)[:-4].lower()
    for test in (lambda s: s == want, lambda s: s.startswith(want), lambda s: want in s):
        hits = sorted((p for p in apps if test(stem(p))), key=lambda p: len(stem(p)))
        if hits:
            return hits[0]
    safe = re.sub(r"[^\w .-]", "", want)
    q = "kMDItemContentType == 'com.apple.application-bundle' && kMDItemFSName == '*%s*'c" % safe
    out = subprocess.run(["mdfind", q], capture_output=True, text=True, timeout=20).stdout.split("\n")
    out = [p for p in out if p.endswith(".app")]
    return min(out, key=len) if out else None


def windows(app):
    try:
        d = desktop.run("list-windows", "--app", app, timeout=20)
    except (desktop.DesktopError, subprocess.TimeoutExpired):
        return []
    ws = d if isinstance(d, list) else (d.get("windows") or [])
    return [w for w in ws if w.get("visible", True) and not w.get("minimized") and (w.get("bounds") or {}).get("width")]


def wait_ready(app, timeout=30):
    """Poll until `app` has a visible window whose accessibility tree has elements. Returns (window, seconds)."""
    t0 = time.time()
    while time.time() - t0 < timeout:
        ws = windows(app)
        if ws:
            w = next((w for w in ws if w.get("is_focused")), ws[0])
            try:
                _, _, els = desktop.snapshot(app, window_id=w["id"])
                if els:
                    return w, round(time.time() - t0, 1)
            except desktop.DesktopError:
                pass
        time.sleep(0.5)
    raise TimeoutError("%s did not open a usable window within %ds" % (app, timeout))


def place(pid, lane):
    """Move (and size, if the window allows it) the app's front window into this agent's lane."""
    code, out = _osa(
        [
            'tell application "System Events"',
            "set p to first process whose unix id is ((item 1 of argv) as integer)",
            "set position of window 1 of p to {(item 2 of argv) as integer, (item 3 of argv) as integer}",
            "try",
            "set size of window 1 of p to {(item 4 of argv) as integer, (item 5 of argv) as integer}",
            "end try",
            "end tell",
        ],
        pid,
        int(lane["x"]),
        int(lane["y"]),
        int(lane["w"]),
        int(lane["h"]),
    )
    return code == 0, out


def open_app(agent, name, method="auto", lane=None, timeout=30):
    """Open `name` in the background and wait until it is usable. Never activates it, never types.
    method: auto | finder (file system) | spotlight (Spotlight's index). Returns
    {"app", "window", "method", "seconds", "ready_after", "path"}."""
    t0 = time.time()
    path = find_app(name)  # file system first, then the Spotlight index (mdfind)
    if not path:
        raise FileNotFoundError("no app named %r on disk or in the Spotlight index" % name)
    app = os.path.basename(path)[:-4]
    used = "running"
    if not windows(app):
        subprocess.run(["open", "-g", path], check=False, timeout=30)  # -g: launch without coming to the front
        used = "spotlight" if method == "spotlight" else "finder"
    win, waited = wait_ready(app, timeout)
    if lane:
        place(win["pid"], lane)  # moving a window does not activate its app
        win = next(iter(windows(app)), win)
    return {
        "app": app,
        "window": win,
        "method": used,
        "seconds": round(time.time() - t0, 1),
        "ready_after": waited,
        "path": path,
    }


def run_applescript(script, timeout=30):
    """An agent's deliberate script. Gating happens in the CU loop before this is called."""
    p = subprocess.run(["osascript", "-e", script], capture_output=True, text=True, timeout=timeout)
    return p.returncode == 0, (p.stdout or p.stderr).strip()[:2000]


def selftest():
    assert find_app("calculator").endswith("Calculator.app")
    assert find_app("system settings").endswith("System Settings.app")
    assert find_app("") is None
    code, out = _osa(["return (item 1 of argv)"], 'x" & (do shell script "echo pwned") & "')
    assert code == 0 and out == 'x" & (do shell script "echo pwned") & "', out  # data stayed data
    print("apps selftest OK")


if __name__ == "__main__":
    selftest()
