"""Primitive local testing UI for the computer-use backend (the real UI is built separately).

Run: cd backend && python3 -m computeranything   (port from CA_PORT, default 8765; binds 127.0.0.1 only)
Every /api call needs the startup token (header X-CA-Token or query t=), because runs can click
on this machine. Requests with a foreign Origin header are refused.
"""

import atexit
import hmac
import json
import os
import re
import secrets
import subprocess
import sys
import time
import traceback
from email.parser import BytesParser
from email.policy import default as email_default
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from ..core import runs

PORT = int(os.environ.get("CA_PORT", "8765"))
TOKEN = secrets.token_urlsafe(16)
ORIGIN = "http://127.0.0.1:%d" % PORT
UPLOADS = os.path.join(runs.HOME, "uploads")
MAX_FILE = 50 * 1024 * 1024
MAX_BODY = 10 * MAX_FILE

PAGE = r"""<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>ca test console</title>
<style>
body{font:14px -apple-system,system-ui,sans-serif;margin:16px;max-width:1100px;color:#111}
h2{font-size:15px;margin:18px 0 6px}
textarea{width:100%;height:80px;font:inherit}
pre{background:#f4f4f4;padding:8px;max-height:420px;overflow:auto;white-space:pre-wrap;font-size:12px}
table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:3px 6px;border-bottom:1px solid #ddd}
tr.run{cursor:pointer}tr.run:hover{background:#f0f0f0}tr.sel{background:#e6eefc}
#help{border:1px solid #c33;padding:8px;display:none}#help button{margin-right:6px}
.err{color:#c33}
</style></head><body>
<div id="help"><h2>Needs you</h2><div id="helplist"></div></div>
<h2>Task</h2>
<textarea id="prompt" placeholder="What should the agent do?"></textarea><br>
<input type="file" id="files" multiple> <button id="go">Run</button> <span id="msg"></span>
<h2>Runs</h2>
<table><thead><tr><th>role</th><th>state</th><th>elapsed</th><th>goal</th></tr></thead><tbody id="runs"></tbody></table>
<h2 id="logtitle">Event log</h2><pre id="log">(click a run)</pre>
<h2>Result / digest</h2><pre id="result"></pre>
<h2>Memory</h2><pre id="graph"></pre>
<script>
const T = new URLSearchParams(location.search).get("t") || "";
const H = {"X-CA-Token": T};
let sel = null, since = 0;
const $ = id => document.getElementById(id);
async function api(path, opts) {
  opts = opts || {}; opts.headers = Object.assign({}, H, opts.headers || {});
  const r = await fetch(path, opts); const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(r.status + " " + (j.error || ""));
  return j;
}
$("go").onclick = async () => {
  const fd = new FormData(); fd.append("prompt", $("prompt").value);
  for (const f of $("files").files) fd.append("files", f, f.name);
  $("msg").textContent = "submitting...";
  try { const j = await api("/api/task", {method: "POST", body: fd}); $("msg").textContent = "started " + j.run; pick(j.run); }
  catch (e) { $("msg").textContent = e.message; $("msg").className = "err"; }
};
function pick(id) { sel = id; since = 0; $("log").textContent = ""; $("logtitle").textContent = "Event log " + id; refresh(); }
function fmt(e) { const d = Object.assign({}, e); delete d.t; delete d.kind; return e.t + "s " + e.kind + " " + JSON.stringify(d); }
async function refresh() {
  try {
    const list = await api("/api/runs");
    const kids = {}; list.forEach(r => { (kids[r.parent || ""] = kids[r.parent || ""] || []).push(r); });
    const ids = new Set(list.map(r => r.id)); const rows = [];
    const walk = (r, depth) => { rows.push([r, depth]); (kids[r.id] || []).forEach(c => walk(c, depth + 1)); };
    list.filter(r => !r.parent || !ids.has(r.parent)).forEach(r => walk(r, 0));
    const tb = $("runs"); tb.innerHTML = "";
    rows.forEach(([r, d]) => {
      const tr = document.createElement("tr"); tr.className = "run" + (r.id === sel ? " sel" : "");
      [r.role, r.state, r.elapsed + "s", r.goal].forEach((v, i) => {
        const td = document.createElement("td"); td.textContent = v;
        if (i === 0) td.style.paddingLeft = (6 + 20 * d) + "px"; tr.appendChild(td); });
      tr.onclick = () => pick(r.id); tb.appendChild(tr);
    });
    const help = await api("/api/help"); const hl = $("helplist"); hl.innerHTML = "";
    $("help").style.display = help.length ? "block" : "none";
    help.forEach(h => {
      const div = document.createElement("div"); const p = document.createElement("p");
      p.textContent = "[" + h.kind + "] run " + h.run + ": " + h.question + (h.detail ? " (" + JSON.stringify(h.detail) + ")" : "");
      div.appendChild(p);
      h.options.forEach(o => { const b = document.createElement("button"); b.textContent = o;
        b.onclick = () => api("/api/help/" + h.id, {method: "POST", headers: {"Content-Type": "application/json"},
          body: JSON.stringify({choice: o})}).then(refresh); div.appendChild(b); });
      hl.appendChild(div);
    });
    if (sel) {
      const v = await api("/api/runs/" + sel + "?since=" + since);
      if (v.events.length) { $("log").textContent += v.events.map(fmt).join("\n") + "\n"; $("log").scrollTop = 1e9; }
      since = v.n_events;
      $("result").textContent = v.result ? JSON.stringify(v.result, null, 2) : "(none yet)";
    }
  } catch (e) { $("msg").textContent = e.message; $("msg").className = "err"; }
}
async function graph() { try { $("graph").textContent = JSON.stringify(await api("/api/graph"), null, 2); } catch (e) {} }
setInterval(refresh, 1000); setInterval(graph, 5000); refresh(); graph();
</script></body></html>
"""


def _safe_name(name):
    name = os.path.basename((name or "").replace("\\", "/")).strip()
    name = re.sub(r"[^A-Za-z0-9._ -]", "_", name).lstrip(".")
    return name[:200]


STARTED = time.time()
DISMISSED = set()
RUNS_LIMIT = 200
_RUN_COLS = (
    "r.id, r.parent, r.role, r.goal, r.state, r.started, r.ended, r.ok, r.summary, "
    "(SELECT COUNT(*) FROM events e WHERE e.run=r.id)"
)


def _stored_view(row, events=None):
    rid, parent, role, goal, state, started, ended, ok, summary, n_events = row
    elapsed = round(((ended if ended is not None else started) or 0) - (started or 0), 1)
    result = None if (ok is None and summary is None) else {"ok": bool(ok), "summary": summary or ""}
    v = {
        "id": rid,
        "goal": goal,
        "role": role,
        "parent": parent,
        "state": state,
        "elapsed": elapsed,
        "n_events": n_events,
        "result": result,
    }
    if events is not None:
        v["events"] = events
    return v


def _list_runs(limit=RUNS_LIMIT):
    """Live runs plus finished root runs and their stored children so chats keep their agents across restarts."""
    from ..core import store

    live = sorted(list(runs.RUNS.values()), key=lambda r: r.started, reverse=True)
    items = []
    seen = set()
    for r in live:
        v = r.view(len(r.events))
        v.pop("events", None)
        items.append((r.started, v))
        seen.add(r.id)
    db = store.db()
    with store._lock:
        rows = db.execute(
            f"SELECT {_RUN_COLS} FROM runs r WHERE r.parent IS NULL AND r.state IN ('done','failed') "
            "ORDER BY r.started DESC LIMIT ?",
            (limit,),
        ).fetchall()
        for row in rows:
            if row[0] not in seen:
                items.append((row[5] or 0, _stored_view(row)))
                seen.add(row[0])
        root_ids = [v["id"] for _, v in items if not v.get("parent")][:limit]
        if root_ids:
            marks = ",".join("?" for _ in root_ids)
            for row in db.execute(
                f"SELECT {_RUN_COLS} FROM runs r WHERE r.parent IN ({marks}) ORDER BY r.started DESC LIMIT ?",
                (*root_ids, limit),
            ).fetchall():
                if row[0] not in seen:
                    items.append((row[5] or 0, _stored_view(row)))
                    seen.add(row[0])
    items.sort(key=lambda pair: pair[0], reverse=True)
    return [v for _, v in items[:limit]]


def _stored_run(rid, since=0):
    """Single-run view from SQLite when a stored run is no longer in runs.RUNS."""
    from ..core import store

    db = store.db()
    with store._lock:
        row = db.execute(f"SELECT {_RUN_COLS} FROM runs r WHERE r.id=?", (rid,)).fetchone()
        if not row:
            return None
        ev_rows = db.execute(
            "SELECT t, kind, data FROM events WHERE run=? AND seq>=? ORDER BY seq",
            (rid, since),
        ).fetchall()
    events = [{"t": t, **json.loads(data or "{}"), "kind": kind} for t, kind, data in ev_rows]
    return _stored_view(row, events=events)


def find_files(q, limit=12):
    """Name search over the home folder through the Spotlight index (mdfind; q is an argument, never a
    shell string). Newest first, skipping Library, hidden folders and dependency trees."""
    q = (q or "").strip()[:100]
    if len(q) < 2:
        return []
    home = os.path.expanduser("~")
    try:
        out = subprocess.run(
            ["mdfind", "-onlyin", home, "-name", q], capture_output=True, text=True, timeout=3
        ).stdout.splitlines()
    except (subprocess.TimeoutExpired, OSError):
        return []
    skip = ("/Library/", "/.", "/node_modules/", "/__pycache__/")
    hits = [h for h in out if not any(x in h for x in skip)][:300]

    def mtime(h):
        try:
            return os.path.getmtime(h)
        except OSError:
            return 0

    hits.sort(key=mtime, reverse=True)
    return [
        {
            "name": os.path.basename(h),
            "path": h,
            "dir": os.path.isdir(h),
            "where": os.path.dirname(h).replace(home, "~"),
        }
        for h in hits[:limit]
    ]


def notifications():
    """Persistent notifications: agent hellos and task results/errors from this session, minus dismissed."""
    from ..core import store
    from ..cu import overlay

    out = []
    for m in store.notifiable(STARTED):
        nid = "m%d" % m["id"]
        if nid in DISMISSED:
            continue
        body, edge, ink = overlay.palette_for(m["agent"]) if m["role"] == "agent" else (None, None, None)
        info = store.run_info(m["run"])
        out.append(
            {
                "id": nid,
                "kind": m["kind"],
                "title": (info.get("goal") or m["agent"])[:80],
                "text": info.get("summary") or m["text"],
                "ok": False if m["kind"] == "error" else (None if info.get("ok") is None else bool(info["ok"])),
                "thread": store.root(m["run"]),
                "ts": m["ts"],
                "body": body,
                "edge": edge,
                "ink": ink,
            }
        )
    return out


class Handler(BaseHTTPRequestHandler):
    server_version = "ca"

    def log_message(self, fmt, *args):
        sys.stderr.write("[http] %s\n" % (fmt % args))

    def _send(self, code, obj=None, body=None, ctype="application/json"):
        data = body if body is not None else json.dumps(obj, default=str).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.end_headers()
        self.wfile.write(data)

    def _guard(self):
        origin = self.headers.get("Origin")
        if origin is not None and origin != ORIGIN:
            self._send(403, {"error": "bad origin"})
            return False
        if self.path.startswith("/api"):
            q = parse_qs(urlparse(self.path).query)
            tok = self.headers.get("X-CA-Token") or (q.get("t") or [""])[0]
            if not hmac.compare_digest(tok.encode(), TOKEN.encode()):
                self._send(403, {"error": "bad token"})
                return False
        return True

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_BODY:
            raise ValueError("body too large")
        return self.rfile.read(n) if n else b""

    def do_GET(self):
        if not self._guard():
            return
        u = urlparse(self.path)
        p = u.path
        try:
            if p == "/":
                return self._send(200, body=PAGE.encode(), ctype="text/html; charset=utf-8")
            if p == "/ui":  # the workspace UI in a browser (the notch app loads the same file)
                with open(os.path.join(os.path.dirname(__file__), "..", "..", "..", "ui", "index.html"), "rb") as f:
                    return self._send(200, body=f.read(), ctype="text/html; charset=utf-8")
            if p == "/api/runs":
                return self._send(200, _list_runs())
            if p.startswith("/api/runs/") and p.endswith("/transcript"):  # the task's chat, all its agents
                from ..core import store
                from ..cu import overlay

                rows = store.transcript(p[len("/api/runs/") : -len("/transcript")])
                for m in rows:  # the agent's name colour, matching its cursor and notifications
                    m["color"] = overlay.palette_for(m["agent"])[0] if m["role"] == "agent" else None
                return self._send(200, rows)
            if p == "/api/transcripts":  # search every conversation: ?q=lunch
                from ..core import store

                q = (parse_qs(u.query).get("q") or [""])[0].strip()
                return self._send(200, store.search_messages(q) if q else [])
            if p.startswith("/api/runs/") and not p.endswith(("/cost", "/transcript")):
                rid = p[len("/api/runs/") :]
                since = max(0, int((parse_qs(u.query).get("since") or ["0"])[0] or 0))
                r = runs.RUNS.get(rid)
                v = r.view(since) if r else _stored_run(rid, since=since)
                if not v:
                    return self._send(404, {"error": "no such run"})
                return self._send(200, v)
            if p == "/api/help":
                return self._send(200, runs.pending_help())
            if p == "/api/files":  # Spotlight search over the user's home folder: ?q=invoice
                return self._send(200, find_files((parse_qs(u.query).get("q") or [""])[0]))
            if p == "/api/profile":
                from ..core import profile

                return self._send(200, profile.view())
            if p == "/api/memory":
                from ..core import memory

                return self._send(200, memory.list_facts())
            if p == "/api/notifications":  # hellos, results and errors since this server started
                return self._send(200, notifications())
            if p == "/api/graph":
                try:
                    from ..cu import graph

                    return self._send(200, graph.load().stats() or {})
                except ImportError:
                    return self._send(200, {})
            if p == "/api/actions":  # the state-machine graph's action log, every agent
                from ..cu import graph

                q = parse_qs(urlparse(self.path).query)
                since = int((q.get("since") or ["0"])[0] or 0)
                agent = (q.get("agent") or [None])[0]
                try:
                    with open(graph.LOG) as f:
                        rows = [json.loads(ln) for ln in f]
                except OSError:
                    rows = []
                sel = [r for r in rows[since:] if not agent or r.get("agent") == agent]
                return self._send(200, {"total": len(rows), "actions": sel[-500:]})
            if p == "/api/analytics":  # spend, success and effort across tasks, per role / purpose / app
                from ..core import store

                q = parse_qs(urlparse(self.path).query)
                return self._send(200, store.summary(float((q.get("since") or ["0"])[0] or 0)))
            if p.startswith("/api/runs/") and p.endswith("/cost"):  # one task, all its child agents
                from ..core import store

                return self._send(200, store.task_cost(p[len("/api/runs/") : -len("/cost")]))
            if p == "/api/agents":  # live cursors: which agents are on screen, in which color
                from ..cu import overlay

                return self._send(200, overlay.CURSORS)
            return self._send(404, {"error": "not found"})
        except Exception as e:
            traceback.print_exc()
            return self._send(500, {"error": str(e)})

    def do_POST(self):
        if not self._guard():
            return
        p = urlparse(self.path).path
        try:
            if p == "/api/task":
                return self._task()
            if p == "/api/profile":
                from ..core import profile

                return self._send(200, profile.save(json.loads(self._body() or b"{}")))
            if p.startswith("/api/notifications/") and p.endswith("/dismiss"):
                DISMISSED.add(p[len("/api/notifications/") : -len("/dismiss")])
                return self._send(200, {"ok": True})
            if p.startswith("/api/runs/") and p.endswith("/stop"):
                rid = p[len("/api/runs/") : -len("/stop")]
                if not runs.request_stop(rid):
                    return self._send(404, {"error": "no such run"})
                return self._send(200, {"ok": True})
            if p.startswith("/api/help/"):
                hid = p[len("/api/help/") :]
                if hid not in runs.HELP:
                    return self._send(404, {"ok": False, "error": "no such help request"})
                choice = json.loads(self._body() or b"{}").get("choice")
                if choice not in runs.HELP[hid]["options"]:
                    return self._send(400, {"ok": False, "error": "choice not in options"})
                return self._send(200, {"ok": runs.answer(hid, choice)})
            return self._send(404, {"error": "not found"})
        except ValueError as e:
            return self._send(400, {"error": str(e)})
        except Exception as e:
            traceback.print_exc()
            return self._send(500, {"error": str(e)})

    def do_DELETE(self):
        if not self._guard():
            return
        p = urlparse(self.path).path
        try:
            from ..core import memory

            if p == "/api/memory":
                memory.forget_all()
                return self._send(200, {"ok": True})
            if p.startswith("/api/memory/"):
                fid = p[len("/api/memory/") :]
                if not memory.delete(fid):
                    return self._send(404, {"ok": False, "error": "no such memory"})
                return self._send(200, {"ok": True})
            return self._send(404, {"error": "not found"})
        except Exception as e:
            traceback.print_exc()
            return self._send(500, {"error": str(e)})

    def _task(self):
        ctype = self.headers.get("Content-Type", "")
        body = self._body()
        prompt, files, thread, local = "", [], None, []
        if ctype.startswith("multipart/form-data"):
            msg = BytesParser(policy=email_default).parsebytes(
                b"Content-Type: " + ctype.encode() + b"\r\nMIME-Version: 1.0\r\n\r\n" + body
            )
            for part in msg.iter_parts():
                field = part.get_param("name", header="content-disposition")
                fname = part.get_filename()
                data = part.get_payload(decode=True) or b""
                if fname is not None:
                    if not fname and not data:
                        continue  # empty file input
                    name = _safe_name(fname)
                    if not name:
                        return self._send(400, {"error": "bad file name"})
                    if len(data) > MAX_FILE:
                        return self._send(413, {"error": "%s over 50 MB" % name})
                    files.append((name, data))
                elif field == "prompt":
                    prompt = data.decode("utf-8", "replace")
                elif field == "paths":  # files the user picked from search: read in place, home folder only
                    path = os.path.realpath(data.decode("utf-8", "replace").strip())
                    if not (path.startswith(os.path.expanduser("~") + os.sep) and os.path.isfile(path)):
                        return self._send(400, {"error": "not a file in your home folder"})
                    local.append(path)
                elif field == "thread":
                    thread = data.decode("utf-8", "replace").strip() or None
        else:
            j = json.loads(body or b"{}")
            prompt, thread = j.get("prompt") or "", j.get("thread") or None
        prompt = prompt.strip()
        if not prompt:
            return self._send(400, {"error": "empty prompt"})
        try:
            from ..agents import orchestrator
        except ImportError:
            return self._send(503, {"error": "orchestrator unavailable"})
        paths = []
        if files:
            d = os.path.join(UPLOADS, secrets.token_hex(8))
            os.makedirs(d, exist_ok=True)
            for name, data in files:
                path = os.path.join(d, name)
                with open(path, "wb") as f:
                    f.write(data)
                paths.append(path)
        run = orchestrator.submit(prompt, paths + local, thread=thread)
        return self._send(200, {"run": run.id, "thread": thread or run.id})


def start_notch(url):
    """Launch the notch workspace (Option-Space) already connected. Built by notch/build.sh."""
    repo = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
    app = os.path.join(repo, "notch", "build", "AgentNotch")
    if os.environ.get("CA_NO_NOTCH") == "1":
        return None
    if not os.path.exists(app):
        print("notch not built: run notch/build.sh from the repo root", flush=True)
        return None
    env = dict(os.environ, CA_URL=url, UI_FILE=os.path.join(repo, "ui", "index.html"))
    proc = subprocess.Popen([app], cwd=repo, env=env)  # the token travels in the env, never on argv
    atexit.register(proc.terminate)
    return proc


def main():
    try:
        from ..cu import overlay

        if os.environ.get("CA_NO_OVERLAY") == "1":
            raise RuntimeError("disabled by CA_NO_OVERLAY")
        overlay.start()
        atexit.register(overlay.stop)
    except Exception as e:
        print("overlay start failed: %s" % e, flush=True)
    from ..core import profile

    profile.apply()
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    srv.daemon_threads = True
    url = "%s/?t=%s" % (ORIGIN, TOKEN)
    print("ca console: %s" % url, flush=True)
    start_notch(url)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()


def selftest():
    import tempfile

    from ..core import store

    if "CA_HOME" not in os.environ:
        sys.exit("run with a throwaway home: CA_HOME=$(mktemp -d) python3 -m computeranything.api.server --selftest")
    with tempfile.TemporaryDirectory(prefix="ca_srv_") as tmp:
        prev_home, prev_path, prev_db = store.HOME, store.PATH, store._db
        prev_runs = dict(runs.RUNS)
        store.HOME, store.PATH, store._db = tmp, os.path.join(tmp, "ca.sqlite"), None
        runs.RUNS.clear()
        try:
            db = store.db()
            with store._lock:
                db.execute(
                    "INSERT INTO runs VALUES (?,?,?,?,?,?,?,?,?,?)",
                    ("r-old", None, "orchestrator", None, "old task", "done", 100.0, 105.5, 1, "done ok"),
                )
                db.execute(
                    "INSERT INTO runs VALUES (?,?,?,?,?,?,?,?,?,?)",
                    ("r-child", "r-old", "cu", "Ava", "step", "done", 101.0, 104.0, 1, "sub ok"),
                )
                db.execute(
                    "INSERT INTO runs VALUES (?,?,?,?,?,?,?,?,?,?)",
                    ("r-live", None, "orchestrator", None, "live task", "done", 200.0, 202.0, 1, "mem"),
                )
                db.execute("INSERT INTO events VALUES (?,?,?,?,?)", ("r-old", 0, 0.1, "state", '{"state":"done"}'))
            live = runs.Run("live task", role="orchestrator")
            live.id = "r-live"
            runs.RUNS.clear()
            runs.RUNS[live.id] = live
            listed = _list_runs()
            ids = [r["id"] for r in listed]
            assert ids == ["r-live", "r-child", "r-old"], ids
            child = listed[1]
            assert set(child) == {"id", "goal", "role", "parent", "state", "elapsed", "n_events", "result"}, child
            assert child["parent"] == "r-old" and child["elapsed"] == 3.0
            old = listed[2]
            assert set(old) == {"id", "goal", "role", "parent", "state", "elapsed", "n_events", "result"}, old
            assert old["elapsed"] == 5.5 and old["n_events"] == 1
            assert old["result"] == {"ok": True, "summary": "done ok"}
            detail = _stored_run("r-old", since=0)
            assert detail and detail["n_events"] == 1 and detail["events"][0]["kind"] == "state", detail
        finally:
            if store._db is not None:
                store._db.close()
            store.HOME, store.PATH, store._db = prev_home, prev_path, prev_db
            runs.RUNS.clear()
            runs.RUNS.update(prev_runs)
    print("server selftest OK")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
    else:
        main()
