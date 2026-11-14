"""The computer-use loop for one goal in one macOS app.

Each step: observe (accessibility tree) -> decide (skill replay, else Gemini) -> gate (policy)
-> show (blue cursor) -> act (headless, by ref) -> record (action graph). A "done" claim is
checked by a separate verifier call before the run counts as a success.
"""
import os, re, subprocess, tempfile, time

from . import desktop, graph, llm, overlay, runs

SENSITIVE_APP = re.compile(r"bank|chase|wells|schwab|fidelity|vanguard|robinhood|coinbase|venmo|paypal|"
                           r"cash app|zelle|wallet|1password|bitwarden|lastpass|keychain|authenticator", re.I)
MONEY = re.compile(r"\b(pay|buy|purchase|checkout|transfer|withdraw|wire|place order|trade|sell)\b", re.I)
SIGN_IN = re.compile(r"\b(sign in|log in|login|password|passkey|verification code|2fa)\b", re.I)
CAPTCHA = re.compile(r"captcha|i'?m not a robot|verify you are human", re.I)

SYSTEM = """You operate a macOS app for the user through its accessibility tree. Each turn you get the goal,
the current screen as a numbered element table, your recent steps, and remembered actions from earlier runs
(with reliability P). Reply with ONE JSON object:
{"thought": "<one short sentence>",
 "action": "click|double_click|type|set_value|press|scroll|launch|done|ask_human",
 "index": <element number for click/double_click/type/set_value/scroll>,
 "target": "<that element's exact label, as a cross-check>",
 "text": "<text to type, or app name for launch>",
 "key": "<key combo for press, e.g. return, cmd+l, cmd+t>",
 "help": "captcha|sign_in|money|clarify (only with ask_human)",
 "summary": "<with done: what you achieved, with the key values you read off the screen>"}
Rules: one action per turn; prefer elements by their label; type into a field by its index, then press return
if needed; use done only when the screen shows the goal is met; use ask_human for captchas, sign-ins,
payments or real ambiguity. Never invent an index that is not in the table."""

VERIFY = """Given a goal and the app's current screen (element table), decide if the goal is achieved.
Reply JSON {"achieved": true|false, "evidence": "<the exact on-screen values that show it>"}"""


def _screenshot():
    p = os.path.join(tempfile.mkdtemp(prefix="ca-"), "s.png")
    subprocess.run(["screencapture", "-x", "-C", p], check=False)
    subprocess.run(["sips", "-Z", "1280", p], capture_output=True)
    return p if os.path.exists(p) else None


def _gate(run, app, kind, el, text):
    """Code decides what needs a person; the model never gets to skip this."""
    label = "%s %s %s" % (kind, el["name"] if el else "", text or "")
    if CAPTCHA.search(label):
        return runs.ask_human(run, "captcha", "Please solve the captcha in %s, then press done." % app,
                              ("done", "cancel")) == "done"
    if MONEY.search(label):
        return runs.ask_human(run, "money", "Allow '%s' in %s? This may move money." % (label.strip(), app)) == "approve"
    if SIGN_IN.search(label) and kind in ("click", "type", "set_value"):
        return runs.ask_human(run, "sign_in", "Allow signing in to %s ('%s')?" % (app, label.strip())) == "approve"
    if graph.DESTRUCTIVE.search(label):
        return runs.ask_human(run, "destructive", "Allow '%s' in %s?" % (label.strip(), app)) == "approve"
    return True


def _decide(goal, app, title, els, history, hints, shot):
    user = "Goal: %s\nApp: %s  Window: %s\n\nScreen:\n%s\n\nRecent steps:\n%s\n\nRemembered actions here:\n%s" % (
        goal, app, title, desktop.table(els, 150), "\n".join(history[-8:]) or "(none)", "\n".join(hints) or "(none)")
    return llm.chat(SYSTEM, user, images=[shot] if shot else (), json_mode=True, max_tokens=600)


def _verify(goal, app, title, els):
    if os.environ.get("CA_MOCK") == "1":
        return True, "mock"
    try:
        v = llm.chat(VERIFY, "Goal: %s\nApp: %s  Window: %s\n\nScreen:\n%s" % (goal, app, title, desktop.table(els, 200)),
                     json_mode=True, max_tokens=300)
        return bool(v.get("achieved")), v.get("evidence", "")
    except Exception as e:                                   # a failed verifier call is not a yes
        return False, "verifier error: %s" % e


def run_task(run, goal, app=None, max_steps=25):
    """Drive `app` until `goal` is met. Returns {"ok", "summary", "steps"} and records everything on `run`."""
    g = graph.load()
    app = app or desktop.frontmost_app()
    run.set("planning")
    if SENSITIVE_APP.search(app) and runs.ask_human(run, "money", "Let the agent use %s?" % app) != "approve":
        run.result = {"ok": False, "summary": "You declined access to %s." % app, "steps": 0}
        run.set("failed")
        return run.result
    try:
        desktop.act("launch", app=app)
    except desktop.DesktopError as e:
        run.emit("warn", msg="launch: %s" % e)
    skill = g.find_skill(app, goal)
    replay = list(skill["steps"]) if skill else []
    if skill:
        run.emit("memory", msg="replaying a saved skill", goal=skill["goal"], steps=len(replay))
    history, trail, summary, ok = [], [], "", False
    prev = None                                               # (node, action_key, t0)
    run.set("acting")
    for step in range(max_steps):
        t_obs = time.time()
        try:
            _, title, els = desktop.snapshot(app, interactive=False)
        except desktop.DesktopError as e:
            run.emit("error", msg="observe: %s" % e)
            time.sleep(0.5)
            continue
        nid = g.identify(app, title, els)
        if prev:
            g.record(prev[0], prev[1], nid, True, (t_obs - prev[2]) * 1000)
        obs_ms = int((time.time() - t_obs) * 1000)
        source, d = "llm", None
        if replay:                                            # tier 1: replay a remembered step by label
            want = replay[0]
            el = next((e for e in els if e["ref"] and graph.action_key(want.split(":")[0], e) == want), None)
            if el:
                replay.pop(0)
                d = {"action": want.split(":")[0], "index": els.index(el), "thought": "replay " + want}
                source = "memory"
            else:
                run.emit("memory", msg="saved step not on screen, asking the model", step=want)
                replay = []
        if d is None:                                         # tier 2: Gemini decides
            shot = _screenshot() if (step == 0 or len(els) < 4 or (history and "FAILED" in history[-1])) else None
            t0 = time.time()
            try:
                d = _decide(goal, app, title, els, history, g.hints(nid) + ([str(g.plan(nid, goal))] if g.plan(nid, goal) else []), shot)
            except Exception as e:
                run.emit("error", msg="decide: %s" % e)
                break
            run.emit("decide", ms=int((time.time() - t0) * 1000), thought=d.get("thought"), action=d.get("action"))
        kind = d.get("action")
        if kind == "done":
            achieved, evidence = _verify(goal, app, title, els)
            run.emit("verify", achieved=achieved, evidence=evidence)
            if achieved:
                ok, summary = True, d.get("summary") or evidence
                break
            history.append("done was claimed but the verifier says no: %s" % evidence)
            continue
        if kind == "ask_human":
            ans = runs.ask_human(run, d.get("help") or "clarify", d.get("thought") or "Need your help",
                                 ("done", "cancel"))
            history.append("asked the user (%s): %s" % (d.get("help"), ans))
            if ans != "done":
                summary = "Stopped: you cancelled at a %s step." % d.get("help")
                break
            continue
        idx = d.get("index")
        el = els[idx] if isinstance(idx, int) and 0 <= idx < len(els) else None
        tgt = (d.get("target") or "").strip().lower()
        if tgt and not (el and el["name"].lower() == tgt):    # index and label disagree: trust the label
            el = next((e for e in els if e["ref"] and e["name"].lower() == tgt), el)
        if kind in ("click", "double_click", "type", "set_value", "scroll") and not (el and el["ref"]):
            history.append("step %d FAILED: index %r is not an actionable element" % (step, idx))
            continue
        if not _gate(run, app, kind, el, d.get("text") or d.get("key")):
            history.append("step %d: the user denied %s" % (step, kind))
            summary = "Stopped: you denied %s." % kind
            break
        if el:
            overlay.point_at(el.get("bounds"), el["name"] or kind)
        akey = graph.action_key(kind, el, d.get("text"), d.get("key"))
        t_act = time.time()
        try:
            desktop.act(kind, ref=el and el["ref"], text=d.get("text"), key=d.get("key"),
                        app=(d.get("text") or app) if kind == "launch" else app)
            history.append("step %d: %s %s" % (step, akey, "'%s'" % d["text"] if d.get("text") else ""))
            trail.append(akey)
            prev = (nid, akey, t_act)
        except desktop.DesktopError as e:
            g.record(nid, akey, None, False, (time.time() - t_act) * 1000)
            history.append("step %d FAILED: %s -> %s" % (step, akey, e))
            prev = None
        run.emit("act", step=step, source=source, action=akey, observe_ms=obs_ms,
                 act_ms=int((time.time() - t_act) * 1000), node=nid)
    if ok and trail and not skill:
        g.save_skill(app, goal, [a for a in trail if not a.startswith("type:")])
    g.save()
    run.result = {"ok": ok, "summary": summary or "Not finished after %d steps." % max_steps, "steps": len(trail)}
    run.emit("result", **run.result)
    run.set("done" if ok else "failed")
    return run.result
