"""The computer-use loop for one goal in one macOS app.

Each step: observe (accessibility tree) -> decide (skill replay, else Gemini) -> gate (policy)
-> show (blue cursor) -> act (headless, by ref) -> record (action graph). A "done" claim is
checked by a separate verifier call before the run counts as a success.
"""

import os
import re
import subprocess
import tempfile
import time

from ..core import llm, runs
from . import desktop, graph, overlay

SENSITIVE_APP = re.compile(
    r"bank|chase|wells|schwab|fidelity|vanguard|robinhood|coinbase|venmo|paypal|"
    r"cash app|zelle|wallet|1password|bitwarden|lastpass|keychain|authenticator",
    re.I,
)
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


def _gate(run, app, kind, el, text, els=()):
    """Code decides what needs a person; the model never gets to skip this."""
    label = "%s %s %s" % (kind, el["name"] if el else "", text or "")
    if kind == "launch" and SENSITIVE_APP.search(text or ""):
        return runs.ask_human(run, "money", "Let the agent open %s?" % text) == "approve"
    if kind == "press":
        # Any key can submit the focused form (return, space, shift+return...), so fail closed: judge
        # every key press by what is on screen, not by the key name.
        label += " " + " ".join(e["name"] for e in els if e.get("ref"))
    if CAPTCHA.search(label):
        return (
            runs.ask_human(run, "captcha", "Please solve the captcha in %s, then press done." % app, ("done", "cancel"))
            == "done"
        )
    if MONEY.search(label):
        return (
            runs.ask_human(run, "money", "Allow '%s' in %s? This may move money." % (label.strip(), app)) == "approve"
        )
    if SIGN_IN.search(label) and kind in ("click", "type", "set_value"):
        return runs.ask_human(run, "sign_in", "Allow signing in to %s ('%s')?" % (app, label.strip())) == "approve"
    if graph.DESTRUCTIVE.search(label):
        return runs.ask_human(run, "destructive", "Allow '%s' in %s?" % (label.strip(), app)) == "approve"
    return True


def _decide(goal, app, title, els, history, hints, shot):
    user = "Goal: %s\nApp: %s  Window: %s\n\nScreen:\n%s\n\nRecent steps:\n%s\n\nRemembered actions here:\n%s" % (
        goal,
        app,
        title,
        desktop.table(els, 150),
        "\n".join(history[-8:]) or "(none)",
        "\n".join(hints) or "(none)",
    )
    return llm.chat(SYSTEM, user, images=[shot] if shot else (), json_mode=True, max_tokens=600)


def _verify(goal, app, title, els):
    if os.environ.get("CA_MOCK") == "1":
        return True, "mock"
    try:
        v = llm.chat(
            VERIFY,
            "Goal: %s\nApp: %s  Window: %s\n\nScreen:\n%s" % (goal, app, title, desktop.table(els, 200)),
            json_mode=True,
            max_tokens=300,
        )
        return bool(v.get("achieved")), v.get("evidence", "")
    except Exception as e:  # a failed verifier call is not a yes
        return False, "verifier error: %s" % e


def agent_name(run):
    """Name on the agent's cursor tag and in the graph log, e.g. "QA 3f2" or a name the orchestrator set."""
    return getattr(run, "agent_name", None) or "%s %s" % (run.role.upper(), run.id[-3:])


def run_task(run, goal, app=None, max_steps=25):
    """Drive `app` until `goal` is met with this agent's own cursor. Every action, executed or not, is
    logged in the state-machine graph under this agent. Returns {"ok", "summary", "steps"}."""
    me = agent_name(run)
    overlay.claim(run.id, me)
    try:
        return _run(run, goal, app, max_steps, me)
    finally:
        overlay.release(run.id)


def _run(run, goal, app, max_steps, me):
    g = graph.load()
    app = app or desktop.frontmost_app()
    nid = None  # current screen node

    def log(akey, outcome, dst=None, ms=0, source="llm", detail=None):
        g.record(
            nid or "%s:?" % app, akey, dst, outcome, ms, run=run.id, agent=me, app=app, source=source, detail=detail
        )
        run.emit("graph", action=akey, outcome=outcome, node=nid, to=dst)

    run.set("planning")
    if SENSITIVE_APP.search(app) and runs.ask_human(run, "money", "Let the agent use %s?" % app) != "approve":
        log("launch:%s" % app.lower(), "denied", source="policy")
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
    pending = None  # (node, action_key, t0, source): an executed action waiting to see where it led
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
        if pending:  # the last action worked; now we know which screen it led to
            src, akey, t0, source = pending
            g.record(src, akey, nid, "ok", (t_obs - t0) * 1000, run=run.id, agent=me, app=app, source=source)
            run.emit("graph", action=akey, outcome="ok", node=src, to=nid)
            pending = None
        obs_ms = int((time.time() - t_obs) * 1000)
        source, d = "llm", None
        if replay:  # tier 1: replay a remembered step by label
            want = replay[0]
            el = next((e for e in els if e["ref"] and graph.action_key(want.split(":")[0], e) == want), None)
            if el:
                replay.pop(0)
                d = {"action": want.split(":")[0], "index": els.index(el), "thought": "replay " + want}
                source = "memory"
            else:
                run.emit("memory", msg="saved step not on screen, asking the model", step=want)
                replay = []
        if d is None:  # tier 2: Gemini decides
            shot = _screenshot() if (step == 0 or len(els) < 4 or (history and "FAILED" in history[-1])) else None
            t0 = time.time()
            plan = g.plan(nid, goal)
            try:
                d = _decide(goal, app, title, els, history, g.hints(nid) + ([str(plan)] if plan else []), shot)
            except Exception as e:
                run.emit("error", msg="decide: %s" % e)
                break
            run.emit("decide", ms=int((time.time() - t0) * 1000), thought=d.get("thought"), action=d.get("action"))
        kind = d.get("action")
        if kind == "done":
            achieved, evidence = _verify(goal, app, title, els)
            run.emit("verify", achieved=achieved, evidence=evidence)
            log("done", "done_verified" if achieved else "done_rejected", source=source, detail=evidence[:200])
            if achieved:
                ok, summary = True, d.get("summary") or evidence
                break
            history.append("done was claimed but the verifier says no: %s" % evidence)
            continue
        if kind == "ask_human":
            ans = runs.ask_human(
                run, d.get("help") or "clarify", d.get("thought") or "Need your help", ("done", "cancel")
            )
            log("ask_human:%s" % (d.get("help") or "clarify"), "help", source=source, detail=ans)
            history.append("asked the user (%s): %s" % (d.get("help"), ans))
            if ans != "done":
                summary = "Stopped: you cancelled at a %s step." % d.get("help")
                break
            continue
        idx = d.get("index")
        el = els[idx] if isinstance(idx, int) and 0 <= idx < len(els) else None
        tgt = (d.get("target") or "").strip().lower()
        if tgt and not (el and el["name"].lower() == tgt):  # index and label disagree: trust the label
            el = next((e for e in els if e["ref"] and e["name"].lower() == tgt), el)
        if kind in ("click", "double_click", "type", "set_value", "scroll") and not (el and el["ref"]):
            log("%s:invalid-target" % kind, "failed", source=source, detail=str(idx))
            history.append("step %d FAILED: index %r is not an actionable element" % (step, idx))
            continue
        key = (d.get("key") or d.get("text")) if kind == "press" else None  # one value for gate and act
        if kind == "press" and not key:
            log("press:no-key", "failed", source=source)
            history.append("step %d FAILED: press needs a key" % step)
            continue
        akey = graph.action_key(kind, el, d.get("text"), key)
        if not _gate(run, app, kind, el, key if kind == "press" else d.get("text"), els):
            log(akey, "denied", source=source)
            history.append("step %d: the user denied %s" % (step, kind))
            summary = "Stopped: you denied %s." % kind
            break
        if el:
            overlay.point_at(el.get("bounds"), el["name"] or kind, cursor=run.id)
        t_act = time.time()
        try:
            desktop.act(
                kind,
                ref=el and el["ref"],
                text=None if kind == "press" else d.get("text"),
                key=key,
                app=(d.get("text") or app) if kind == "launch" else app,
            )
            history.append("step %d: %s %s" % (step, akey, "'%s'" % d["text"] if d.get("text") else ""))
            trail.append(akey)
            pending = (nid, akey, t_act, source)
        except desktop.DesktopError as e:
            log(akey, "failed", ms=(time.time() - t_act) * 1000, source=source, detail=str(e)[:200])
            history.append("step %d FAILED: %s -> %s" % (step, akey, e))
        run.emit(
            "act",
            step=step,
            source=source,
            action=akey,
            observe_ms=obs_ms,
            act_ms=int((time.time() - t_act) * 1000),
            node=nid,
            agent=me,
        )
    if pending:  # last executed action never got a follow-up observation
        src, akey, t0, source = pending
        g.record(src, akey, None, "ok", (time.time() - t0) * 1000, run=run.id, agent=me, app=app, source=source)
    if ok and trail and not skill:
        g.save_skill(app, goal, [a for a in trail if not a.startswith("type:")])
    g.save()
    run.result = {"ok": ok, "summary": summary or "Not finished after %d steps." % max_steps, "steps": len(trail)}
    run.emit("result", **run.result)
    run.set("done" if ok else "failed")
    return run.result
