"""Observe and act on macOS apps through the accessibility tree (vercel-labs/agent-desktop).

Actions go to element refs, headless: the user's real pointer and focus are never moved.
"""
import json, re, subprocess

BIN = "agent-desktop"
KEEP_ROLES = {"button", "textfield", "textarea", "searchfield", "link", "menuitem", "menubaritem", "checkbox",
              "radiobutton", "popupbutton", "combobox", "tab", "cell", "row", "treeitem", "slider", "switch",
              "statictext", "heading", "image", "scrollarea", "incrementor", "colorwell", "disclosure"}


class DesktopError(RuntimeError):
    def __init__(self, err):
        super().__init__("%s: %s" % (err.get("code"), err.get("message")))
        self.code, self.err = err.get("code"), err


def run(*args, stdin=None, timeout=45):
    p = subprocess.run([BIN, *args], input=stdin, capture_output=True, text=True, timeout=timeout)
    try:
        env = json.loads(p.stdout or "{}")
    except ValueError:
        raise DesktopError({"code": "BAD_OUTPUT", "message": (p.stdout + p.stderr)[:300]})
    if not env.get("ok"):
        raise DesktopError(env.get("error") or {"code": "UNKNOWN", "message": p.stderr[:300]})
    return env.get("data") or {}


def frontmost_app():
    out = subprocess.run(["osascript", "-e", 'tell application "System Events" to get name of first '
                          'application process whose frontmost is true'], capture_output=True, text=True)
    return out.stdout.strip() or "Finder"


def _window_args(app):
    """Pick one window when an app has several (AMBIGUOUS_TARGET otherwise): focused, else first visible."""
    try:
        d = run("list-windows", "--app", app)
        wins = d if isinstance(d, list) else (d.get("windows") or [])
    except DesktopError:
        return []
    wins = [w for w in wins if not w.get("minimized")]
    if len(wins) <= 1:
        return []
    w = next((w for w in wins if w.get("is_focused")), wins[0])
    return ["--window-id", w["id"]]


def flatten(tree):
    """Tree -> [{ref, role, name, value, bounds, actions}] for elements an agent can use or read."""
    out = []

    def walk(n, ctx):
        role = (n.get("role") or "").lower()
        name = (n.get("name") or n.get("description") or "").replace("\u200e", "").strip()
        if n.get("ref_id") or (role in KEEP_ROLES and name):
            out.append({"ref": n.get("ref_id"), "role": role, "name": name[:80], "value": str(n.get("value") or "").replace("\u200e", "")[:80],
                        "bounds": n.get("bounds"), "actions": n.get("available_actions") or [], "ctx": ctx})
        for c in n.get("children") or []:
            walk(c, name or ctx)
    walk(tree, "")
    return out


def snapshot(app=None, interactive=True):
    """(app, window title, elements). Retries once on a stale/timeout envelope."""
    app = app or frontmost_app()
    args = ["snapshot", "--app", app, "--compact", "--include-bounds", *_window_args(app)]
    if interactive:
        args.append("-i")
    for attempt in (0, 1):
        try:
            d = run(*args)
            return app, (d.get("tree") or {}).get("name") or "", flatten(d.get("tree") or {})
        except DesktopError as e:
            if attempt or e.code not in ("TIMEOUT", "STALE_REF"):
                raise
    return app, "", []


def table(els, limit=120):
    """One line per element, the format the model and the memory both read:  [12] button "Save" (=value)"""
    lines = []
    for i, e in enumerate(els[:limit]):
        v = ' = "%s"' % e["value"] if e["value"] and e["value"] != e["name"] else ""
        lines.append('[%d] %s "%s"%s%s' % (i, e["role"], e["name"], v, "" if e["ref"] else " (read-only)"))
    return "\n".join(lines)


def act(kind, ref=None, text=None, app=None, key=None, direction="down"):
    """kind: click | double_click | type | set_value | press | scroll | launch. Returns the agent-desktop data."""
    if kind == "launch":
        return run("launch", app or text, timeout=60)
    if kind == "press":
        return run("press", key or text, *(["--app", app] if app else []))
    if kind == "type":
        return run("type", ref, "--stdin", stdin=text or "")
    if kind == "set_value":
        return run("set-value", ref, "--stdin", stdin=text or "")
    if kind == "scroll":
        return run("scroll", ref, "--direction", direction)
    if kind in ("click", "double_click"):
        return run(kind.replace("_", "-"), ref)
    raise ValueError("unknown action %r" % kind)


def selftest():
    tree = {"role": "window", "name": "Calc", "children": [
        {"role": "button", "name": "7", "ref_id": "@s1:e6", "bounds": {"x": 1, "y": 2, "width": 3, "height": 4},
         "available_actions": ["Click"]},
        {"role": "statictext", "name": "42", "children": []}]}
    els = flatten(tree)
    assert [e["name"] for e in els] == ["7", "42"] and els[0]["ref"] == "@s1:e6", els
    assert table(els).splitlines() == ['[0] button "7"', '[1] statictext "42" (read-only)'], table(els)
    print("desktop selftest OK")


if __name__ == "__main__":
    selftest()
