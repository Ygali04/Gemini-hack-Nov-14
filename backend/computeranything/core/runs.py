"""Runs, live events and help requests: the one bus every agent, the orchestrator and the UI share.

A help request blocks the asking agent until a person answers in the UI. No answer before the
timeout counts as deny (money, sign-in and destructive steps must never default to yes).
"""

import itertools
import json
import os
import threading
import time

from . import store

HOME = os.path.expanduser(os.environ.get("CA_HOME", "~/.computeranything"))
RUNS_DIR = os.path.join(HOME, "runs")
_ids = itertools.count(1)
_lock = threading.Lock()
RUNS = {}  # id -> Run
HELP = {}  # help id -> request dict
_help_ids = itertools.count(1)


def _store(fn, *a):
    """Write to the durable store; a storage failure is reported, never allowed to stop an agent."""
    try:
        return fn(*a)
    except Exception as e:  # noqa: BLE001
        print("store warning: %s: %s" % (getattr(fn, "__name__", fn), e), flush=True)
        return None


class Run:
    def __init__(self, goal, role="cu", parent=None):
        self.id = "r%d-%d-%s" % (int(time.time()), next(_ids), os.urandom(2).hex())  # unique across processes
        self.goal, self.role, self.parent = goal, role, parent
        self.state, self.started, self.ended = "queued", time.time(), None
        self.events, self.result = [], None
        self.stop_requested = False
        self.usage = {"calls": 0, "prompt_tokens": 0, "completion_tokens": 0, "cost": 0.0, "ms": 0}
        with _lock:
            RUNS[self.id] = self
        _store(store.run_upsert, self)

    def emit(self, _kind, **data):
        ev = {"t": round(time.time() - self.started, 2), **data, "kind": _kind}
        self.events.append(ev)
        _store(store.event, self.id, len(self.events) - 1, ev["t"], _kind, data)
        os.makedirs(RUNS_DIR, exist_ok=True)
        with open(os.path.join(RUNS_DIR, self.id + ".jsonl"), "a") as f:
            f.write(json.dumps(ev, default=str) + "\n")
        print("[%s %s] %s %s" % (self.id, self.role, _kind, json.dumps(data, default=str)[:220]), flush=True)
        return ev

    def set(self, state):
        self.state = state
        self.emit("state", state=state)
        if state in ("done", "failed"):
            self.ended = time.time()
        _store(store.run_upsert, self)

    def view(self, since=0):
        return {
            "id": self.id,
            "goal": self.goal,
            "role": self.role,
            "parent": self.parent,
            "state": self.state,
            "elapsed": round((self.ended or time.time()) - self.started, 1),
            "events": self.events[since:],
            "n_events": len(self.events),
            "result": self.result,
        }


def say(run, role, kind, text, **meta):
    """Add one turn to the task's chat transcript (also emitted as a "msg" event for live views).
    role: user | assistant | agent. Never pass secrets: transcripts are stored."""
    agent = getattr(run, "agent_name", None) or {"orchestrator": "ComputerAnything"}.get(run.role, run.role)
    text = str(text or "").strip()
    run.emit("msg", role=role, agent=agent, msg_kind=kind, text=text)
    _store(store.message, run.id, role, agent, kind, text, meta)


def ask_human(run, kind, question, options=("approve", "deny"), timeout=300, detail=None):
    """Block until the UI answers. kind: captcha | sign_in | money | destructive | clarify.
    Returns the chosen option, 'deny' on timeout. In CA_AUTO_APPROVE=1 test mode returns options[0]."""
    hid = "h%d" % next(_help_ids)
    req = {
        "id": hid,
        "run": run.id,
        "kind": kind,
        "question": question,
        "options": list(options),
        "detail": detail,
        "answer": None,
        "event": threading.Event(),
        "asked": time.time(),
    }
    HELP[hid] = req
    run.set("awaiting_human")
    run.emit("help", id=hid, help_kind=kind, question=question, options=list(options))
    say(run, "agent", "ask", question, help=hid, help_kind=kind, options=list(options))  # detail stays out
    if os.environ.get("CA_AUTO_APPROVE") == "1":
        answer(hid, options[0])
    got = req["event"].wait(timeout)
    ans = req["answer"] if got else "deny"
    run.emit("help_answer", id=hid, answer=ans, timed_out=not got)
    say(run, "user", "answer", ans + (" (no answer in %ds, counted as deny)" % timeout if not got else ""), help=hid)
    run.set("acting")
    return ans


def answer(hid, choice):
    req = HELP.get(hid)
    if not req or req["answer"] is not None:
        return False
    req["answer"] = choice
    req["event"].set()
    return True


def request_stop(rid):
    """Flag a run and its children to stop, and deny any pending help requests for them."""
    with _lock:
        if rid not in RUNS:
            return False
        ids = {rid}
        all_runs = list(RUNS.values())
    changed = True
    while changed:
        changed = False
        for r in all_runs:
            if r.parent in ids and r.id not in ids:
                ids.add(r.id)
                changed = True
    for r in all_runs:
        if r.id in ids:
            r.stop_requested = True
    for hid, req in list(HELP.items()):
        if req["run"] in ids and req["answer"] is None:
            answer(hid, "deny")
    return True


def pending_help():
    out = []
    for r in list(HELP.values()):
        if r["answer"] is None:
            run = RUNS.get(r["run"])
            item = {k: v for k, v in r.items() if k != "event"}
            item["agent"] = getattr(run, "agent_name", None) or (run.role if run else "")
            item["thread"] = _store(store.root, r["run"]) or r["run"]
            out.append(item)
    return out


def digest(run, children=()):
    """End-of-task report: what it did, how long, how many steps, cost, outcome."""
    acts = [e for e in run.events if e["kind"] == "act"]

    return {
        "run": run.id,
        "goal": run.goal,
        "role": run.role,
        "ok": bool(run.result and run.result.get("ok")),
        "summary": (run.result or {}).get("summary", ""),
        "seconds": round((run.ended or time.time()) - run.started, 1),
        "steps": len(acts),
        "help_requests": sum(e["kind"] == "help" for e in run.events),
        "memory_steps": sum(e.get("source") == "memory" for e in acts),
        "llm": dict(run.usage),
        "task_cost": _store(store.task_cost, run.id),
        "children": [c.id for c in children],
    }
