"""Durable store for everything the agents do: runs, events, model calls, graph actions.

One SQLite file (CA_HOME/ca.sqlite, WAL mode) so analytics are SQL queries, not log parsing.
The JSONL files stay as an append-only audit copy.
"""

import json
import os
import sqlite3
import threading
import time

HOME = os.path.expanduser(os.environ.get("CA_HOME", "~/.computeranything"))
PATH = os.path.join(HOME, "ca.sqlite")
_lock = threading.Lock()
_db = None

SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, parent TEXT, role TEXT, agent TEXT, goal TEXT, state TEXT,
  started REAL, ended REAL, ok INTEGER, summary TEXT);
CREATE TABLE IF NOT EXISTS events (
  run TEXT, seq INTEGER, t REAL, kind TEXT, data TEXT, PRIMARY KEY (run, seq));
CREATE TABLE IF NOT EXISTS llm_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL, run TEXT, agent TEXT, purpose TEXT, model TEXT,
  ms INTEGER, prompt_tokens INTEGER, completion_tokens INTEGER, cost REAL, ok INTEGER, error TEXT);
CREATE TABLE IF NOT EXISTS actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL, run TEXT, agent TEXT, app TEXT, from_node TEXT,
  action TEXT, to_node TEXT, outcome TEXT, ms INTEGER, source TEXT, detail TEXT);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL, run TEXT, role TEXT, agent TEXT, kind TEXT, text TEXT,
  meta TEXT);
CREATE INDEX IF NOT EXISTS msg_run ON messages(run);
CREATE INDEX IF NOT EXISTS llm_run ON llm_calls(run);
CREATE INDEX IF NOT EXISTS act_run ON actions(run);
CREATE INDEX IF NOT EXISTS runs_parent ON runs(parent);
"""


def db():
    global _db
    with _lock:
        if _db is None:
            os.makedirs(HOME, exist_ok=True)
            _db = sqlite3.connect(PATH, check_same_thread=False, isolation_level=None)
            _db.execute("PRAGMA journal_mode=WAL")
            _db.executescript(SCHEMA)
        return _db


def _x(sql, args=()):
    c = db()
    with _lock:
        return c.execute(sql, args)


def run_upsert(r):
    res = r.result or {}
    _x(
        "INSERT INTO runs VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state, "
        "ended=excluded.ended, ok=excluded.ok, summary=excluded.summary, agent=excluded.agent",
        (
            r.id,
            r.parent,
            r.role,
            getattr(r, "agent_name", None),
            r.goal,
            r.state,
            r.started,
            r.ended,
            None if not res else int(bool(res.get("ok"))),
            res.get("summary"),
        ),
    )


def event(run_id, seq, t, kind, data):
    _x("INSERT OR REPLACE INTO events VALUES (?,?,?,?,?)", (run_id, seq, t, kind, json.dumps(data, default=str)))


def llm_call(run_id, agent, purpose, model, ms, usage, ok=True, error=None):
    _x(
        "INSERT INTO llm_calls (ts,run,agent,purpose,model,ms,prompt_tokens,completion_tokens,cost,ok,error) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        (
            time.time(),
            run_id,
            agent,
            purpose,
            model,
            int(ms),
            usage.get("prompt_tokens", 0),
            usage.get("completion_tokens", 0),
            float(usage.get("cost") or 0),
            int(ok),
            error,
        ),
    )


def action(row):
    _x(
        "INSERT INTO actions (ts,run,agent,app,from_node,action,to_node,outcome,ms,source,detail) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        (
            row["ts"],
            row.get("run"),
            row.get("agent"),
            row.get("app"),
            row.get("from"),
            row["action"],
            row.get("to"),
            row["outcome"],
            row.get("ms", 0),
            row.get("source"),
            json.dumps(row.get("detail"), default=str),
        ),
    )


def message(run_id, role, agent, kind, text, meta=None):
    """One chat-transcript turn. role: user | assistant | agent. kind: prompt | plan | step | ask | answer |
    result | error."""
    _x(
        "INSERT INTO messages (ts,run,role,agent,kind,text,meta) VALUES (?,?,?,?,?,?,?)",
        (time.time(), run_id, role, agent, kind, text, json.dumps(meta or {}, default=str)),
    )


def _msg_rows(rows):
    keys = ("id", "ts", "run", "role", "agent", "kind", "text", "meta")
    return [dict(zip(keys, r[:7] + (json.loads(r[7] or "{}"),), strict=True)) for r in rows]


def transcript(run_id):
    """The whole conversation of a task: the parent run and every child agent, in time order."""
    ids = _tree(run_id)
    q = "SELECT * FROM messages WHERE run IN (%s) ORDER BY ts, id" % ",".join("?" * len(ids))
    return _msg_rows(_x(q, ids).fetchall())


def search_messages(q, limit=50):
    """Substring search over every transcript, newest first."""
    # ponytail: LIKE scan; switch to an FTS5 table when transcripts reach ~100k rows
    rows = _x(
        "SELECT * FROM messages WHERE text LIKE ? ESCAPE '\\' ORDER BY ts DESC LIMIT ?",
        ("%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%", int(limit)),
    ).fetchall()
    return _msg_rows(rows)


def root(run_id):
    """The conversation a run belongs to: walk parents to the top."""
    seen = 0
    while seen < 50:
        row = _x("SELECT parent FROM runs WHERE id=?", (run_id,)).fetchone()
        if not row or not row[0]:
            return run_id
        run_id, seen = row[0], seen + 1
    return run_id


def run_info(run_id):
    row = _x("SELECT goal, ok, summary FROM runs WHERE id=?", (run_id,)).fetchone()
    return dict(zip(("goal", "ok", "summary"), row, strict=True)) if row else {}


def notifiable(since_ts, limit=40):
    """Transcript turns worth a persistent notification: a task's result or error. (Hellos live in the chat
    and on the cursor tag; help requests come from /api/help.)"""
    rows = _x(
        "SELECT * FROM messages WHERE ts>=? AND role='assistant' AND kind IN ('result','error') "
        "ORDER BY id DESC LIMIT ?",
        (since_ts, int(limit)),
    ).fetchall()
    return _msg_rows(rows)


def _tree(run_id):
    """The run and all its descendants (a task's child agents)."""
    ids, frontier = [run_id], [run_id]
    while frontier:
        q = "SELECT id FROM runs WHERE parent IN (%s)" % ",".join("?" * len(frontier))
        frontier = [r[0] for r in _x(q, frontier).fetchall()]
        ids += frontier
    return ids


def task_cost(run_id):
    """Spend and effort for one task, including every child agent."""
    ids = _tree(run_id)
    ph = ",".join("?" * len(ids))
    calls, pt, ct, cost, ms = _x(
        "SELECT COUNT(*), COALESCE(SUM(prompt_tokens),0), COALESCE(SUM(completion_tokens),0), "
        "COALESCE(SUM(cost),0), COALESCE(SUM(ms),0) FROM llm_calls WHERE run IN (%s)" % ph,
        ids,
    ).fetchone()
    acts = dict(_x("SELECT outcome, COUNT(*) FROM actions WHERE run IN (%s) GROUP BY outcome" % ph, ids).fetchall())
    by_agent = [
        dict(zip(("agent", "calls", "cost", "ms"), r, strict=True))
        for r in _x(
            "SELECT COALESCE(agent,'-'), COUNT(*), SUM(cost), SUM(ms) FROM llm_calls WHERE run IN (%s) GROUP BY agent"
            % ph,
            ids,
        ).fetchall()
    ]
    return {
        "run": run_id,
        "agents": len(ids),
        "llm_calls": calls,
        "prompt_tokens": pt,
        "completion_tokens": ct,
        "cost_usd": round(cost, 6),
        "model_seconds": round(ms / 1000, 1),
        "actions": acts,
        "by_agent": by_agent,
    }


def summary(since=0):
    """Totals across tasks: per role and per agent, success rate, mean cost and time per task."""
    roles = [
        dict(zip(("role", "runs", "ok", "mean_seconds"), r, strict=True))
        for r in _x(
            "SELECT role, COUNT(*), SUM(ok), AVG(ended-started) FROM runs WHERE started>=? AND ended IS NOT NULL "
            "GROUP BY role",
            (since,),
        ).fetchall()
    ]
    spend = [
        dict(zip(("purpose", "calls", "cost_usd", "mean_ms"), r, strict=True))
        for r in _x(
            "SELECT purpose, COUNT(*), ROUND(SUM(cost),6), ROUND(AVG(ms)) FROM llm_calls WHERE ts>=? GROUP BY purpose",
            (since,),
        ).fetchall()
    ]
    apps = [
        dict(zip(("app", "actions", "ok", "failed", "denied"), r, strict=True))
        for r in _x(
            "SELECT app, COUNT(*), SUM(outcome='ok'), SUM(outcome='failed'), SUM(outcome='denied') FROM actions "
            "WHERE ts>=? GROUP BY app ORDER BY 2 DESC",
            (since,),
        ).fetchall()
    ]
    # every prompt you send is a task, follow-ups in a chat included (they are orchestrator runs under the chat root)
    tasks = _x("SELECT COUNT(*) FROM runs WHERE role='orchestrator' AND started>=?", (since,)).fetchone()[0]
    total = _x("SELECT COALESCE(SUM(cost),0), COUNT(*) FROM llm_calls WHERE ts>=?", (since,)).fetchone()
    return {
        "tasks": tasks,
        "cost_usd": round(total[0], 6),
        "llm_calls": total[1],
        "mean_cost_per_task": round(total[0] / tasks, 6) if tasks else None,
        "by_role": roles,
        "by_purpose": spend,
        "by_app": apps,
    }
