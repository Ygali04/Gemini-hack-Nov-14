"""Primitive local testing UI for the computer-use backend (the real UI is built separately).

Run: cd app && python3 -m ca.server   (port from CA_PORT, default 8765; binds 127.0.0.1 only)
Every /api call needs the startup token (header X-CA-Token or query t=), because runs can click
on this machine. Requests with a foreign Origin header are refused.
"""
import atexit, hmac, json, os, re, secrets, sys, traceback
from email.parser import BytesParser
from email.policy import default as email_default
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from . import runs

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
            if p == "/api/runs":
                views = []
                for r in sorted(list(runs.RUNS.values()), key=lambda r: r.started, reverse=True):
                    v = r.view(len(r.events))
                    v.pop("events", None)
                    views.append(v)
                return self._send(200, views)
            if p.startswith("/api/runs/"):
                r = runs.RUNS.get(p[len("/api/runs/"):])
                if not r:
                    return self._send(404, {"error": "no such run"})
                since = int((parse_qs(u.query).get("since") or ["0"])[0] or 0)
                return self._send(200, r.view(max(0, since)))
            if p == "/api/help":
                return self._send(200, runs.pending_help())
            if p == "/api/graph":
                try:
                    from . import graph
                    return self._send(200, graph.load().stats() or {})
                except ImportError:
                    return self._send(200, {})
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
            if p.startswith("/api/help/"):
                hid = p[len("/api/help/"):]
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

    def _task(self):
        ctype = self.headers.get("Content-Type", "")
        body = self._body()
        prompt, files = "", []
        if ctype.startswith("multipart/form-data"):
            msg = BytesParser(policy=email_default).parsebytes(
                b"Content-Type: " + ctype.encode() + b"\r\nMIME-Version: 1.0\r\n\r\n" + body)
            for part in msg.iter_parts():
                field = part.get_param("name", header="content-disposition")
                fname = part.get_filename()
                data = part.get_payload(decode=True) or b""
                if fname is not None:
                    if not fname and not data:
                        continue      # empty file input
                    name = _safe_name(fname)
                    if not name:
                        return self._send(400, {"error": "bad file name"})
                    if len(data) > MAX_FILE:
                        return self._send(413, {"error": "%s over 50 MB" % name})
                    files.append((name, data))
                elif field == "prompt":
                    prompt = data.decode("utf-8", "replace")
        else:
            prompt = (json.loads(body or b"{}").get("prompt") or "")
        prompt = prompt.strip()
        if not prompt:
            return self._send(400, {"error": "empty prompt"})
        try:
            from . import orchestrator
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
        run = orchestrator.submit(prompt, paths)
        return self._send(200, {"run": run.id})


def main():
    try:
        from . import overlay
        overlay.start()
        atexit.register(overlay.stop)
    except Exception as e:
        print("overlay start failed: %s" % e, flush=True)
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    srv.daemon_threads = True
    print("ca console: %s/?t=%s" % (ORIGIN, TOKEN), flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()


if __name__ == "__main__":
    main()
