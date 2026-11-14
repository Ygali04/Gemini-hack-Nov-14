"""Action-graph memory: a state machine per app that grows with every run.

Nodes are screens. A screen's identity is L0 = (app, window title) plus its element labels; two visits
with the same L0 and label-set Jaccard >= MERGE are the same node, so clocks and counters don't split it.
Edges are (screen, action) with n tries, k successes and latencies. Reliability is the Beta(1,1)
posterior mean P = (1+k)/(2+n). The planner runs Dijkstra on cost -log P + LAMBDA * latency_s and
never routes through destructive edges. Successful runs are also saved as skills (goal -> action
labels) and replayed next time without a model call.
"""

import hashlib
import heapq
import json
import math
import os
import re
import threading
import time

HOME = os.path.expanduser(os.environ.get("CA_HOME", "~/.computeranything"))
PATH = os.path.join(HOME, "graph.json")
LOG = os.path.join(HOME, "actions.jsonl")  # append-only: every action by every agent
MERGE = 0.8
LAMBDA = 0.05
DESTRUCTIVE = re.compile(
    r"\b(send|pay|buy|purchase|order|checkout|delete|remove|erase|post|publish|transfer|"
    r"confirm|submit|unsubscribe|sign out|log out|reset|empty trash|wire|withdraw)\b",
    re.I,
)
STOP = {
    "the",
    "a",
    "an",
    "to",
    "in",
    "on",
    "of",
    "and",
    "my",
    "me",
    "please",
    "open",
    "go",
    "app",
    "for",
    "it",
    "then",
    "check",
    "show",
    "see",
    "find",
    "get",
    "view",
    "look",
    "at",
}
_lock = threading.Lock()
EXECUTED = {"ok", "failed"}  # only these move reliability; denied/help/done are logged, not scored


def clean(s):
    s = re.sub(r"\d+([:.,/]\d+)*\s*(%|am|pm|s|m|h|gb|mb|kb)?", "#", (s or "").lower())
    return re.sub(r"\s+", " ", s).strip()


def toks(s):
    return {t for t in re.findall(r"[a-z0-9]+", (s or "").lower()) if t not in STOP}


def action_key(kind, el=None, text=None, key=None):
    """Refs change every snapshot, so an action is remembered by what it targets, not by its ref."""
    lab = lambda v: re.sub(r"\s+", " ", (v or "").lower()).strip()[:50]  # keep digits: "7" != "6"
    if el is not None:
        return "%s:%s:%s" % (kind, el["role"], lab(el["name"]))
    return "%s:%s" % (kind, lab(key or text))


class Graph:
    def __init__(self):
        self.nodes, self.edges, self.skills = {}, {}, {}
        self.mu = threading.RLock()  # several CU agents share one graph

    # ---------- identity
    def identify(self, app, title, els):
        with self.mu:
            return self._identify(app, title, els)

    def _identify(self, app, title, els):
        l0 = "%s|%s" % (app, clean(title)[:60])
        labels = {"%s:%s" % (e["role"], clean(e["name"])[:40]) for e in els if e["name"]}
        best, best_j = None, 0.0
        for nid, n in self.nodes.items():
            if n["l0"] == l0:
                j = len(labels & n["labels"]) / max(1, len(labels | n["labels"]))
                if j > best_j:
                    best, best_j = nid, j
        if best and best_j >= MERGE:
            self.nodes[best]["visits"] += 1
            return best
        nid = "%s:%s" % (app, hashlib.sha1((l0 + "|" + "|".join(sorted(labels))).encode()).hexdigest()[:10])
        self.nodes.setdefault(nid, {"l0": l0, "app": app, "title": clean(title)[:60], "labels": labels, "visits": 0})
        self.nodes[nid]["visits"] += 1
        return nid

    # ---------- edges
    def record(self, src, akey, dst, outcome, ms, run=None, agent=None, app=None, source=None, detail=None, log=LOG):
        """Log one action taken from screen `src`. outcome: ok | failed | denied | help | done_verified |
        done_rejected. Every call lands in the edge and in the append-only log; only executed actions
        (ok/failed) change n and k, so a person saying no never makes a button look unreliable."""
        if outcome is True or outcome is False:
            outcome = "ok" if outcome else "failed"
        with self.mu:
            e = self.edges.setdefault(src, {}).setdefault(
                akey,
                {"n": 0, "k": 0, "ms": [], "to": {}, "destructive": bool(DESTRUCTIVE.search(akey))},
            )
            e.setdefault("outcomes", {})
            e.setdefault("agents", {})
            e["outcomes"][outcome] = e["outcomes"].get(outcome, 0) + 1
            if agent:
                e["agents"][agent] = e["agents"].get(agent, 0) + 1
            if outcome in EXECUTED:
                e["n"] += 1
                e["k"] += int(outcome == "ok")
                e["ms"] = (e["ms"] + [int(ms)])[-50:]
            if dst:
                e["to"][dst] = e["to"].get(dst, 0) + 1
            if log:
                os.makedirs(os.path.dirname(log), exist_ok=True)
                row = {
                    "ts": round(time.time(), 3),
                    "run": run,
                    "agent": agent,
                    "app": app,
                    "from": src,
                    "action": akey,
                    "to": dst,
                    "outcome": outcome,
                    "ms": int(ms),
                    "source": source,
                }
                if detail:
                    row["detail"] = detail
                with open(log, "a") as f:
                    f.write(json.dumps(row) + "\n")

    @staticmethod
    def p(e):
        return (1 + e["k"]) / (2 + e["n"])

    @staticmethod
    def p50(e):
        s = sorted(e["ms"]) or [0]
        return s[len(s) // 2]

    def hints(self, nid, limit=8):
        """Known actions from this screen, most reliable first, for the model to consider."""
        rows = sorted(self.edges.get(nid, {}).items(), key=lambda kv: -self.p(kv[1]) * math.log(2 + kv[1]["n"]))
        return [
            "%s  P=%.2f n=%d p50=%dms%s"
            % (a, self.p(e), e["n"], self.p50(e), " DESTRUCTIVE" if e["destructive"] else "")
            for a, e in rows[:limit]
        ]

    def plan(self, start, goal, max_depth=8):
        """First action on the most reliable known path to a screen whose title names the goal."""
        want = toks(goal)
        if not want or start not in self.nodes:
            return None
        dist, heap = {start: 0.0}, [(0.0, 0, start, None)]
        while heap:
            d, depth, nid, first = heapq.heappop(heap)
            if d > dist.get(nid, math.inf):
                continue
            if depth and want <= toks(self.nodes[nid]["title"]):
                return {"action": first, "hops": depth, "cost": round(d, 3), "target": nid}
            if depth >= max_depth:
                continue
            for a, e in self.edges.get(nid, {}).items():
                if e["destructive"] or not e["to"]:
                    continue
                nxt = max(e["to"], key=e["to"].get)
                c = d - math.log(self.p(e)) + LAMBDA * self.p50(e) / 1000
                if c < dist.get(nxt, math.inf):
                    dist[nxt] = c
                    heapq.heappush(heap, (c, depth + 1, nxt, first or a))
        return None

    # ---------- skills (macro replay)
    def save_skill(self, app, goal, steps):
        with self.mu:
            self._save_skill(app, goal, steps)

    def _save_skill(self, app, goal, steps):
        self.skills.setdefault(app, []).append(
            {"goal": goal, "toks": sorted(toks(goal)), "steps": steps, "ok": 1, "saved": time.time()}
        )

    def find_skill(self, app, goal, min_j=0.75):
        g, best, best_j = toks(goal), None, 0.0
        for s in self.skills.get(app, []):
            st = set(s["toks"])
            j = len(g & st) / max(1, len(g | st))
            if j > best_j:
                best, best_j = s, j
        return best if best_j >= min_j else None

    def stats(self):
        es = [e for v in self.edges.values() for e in v.values()]
        return {
            "screens": len(self.nodes),
            "transitions": len(es),
            "skills": sum(map(len, self.skills.values())),
            "apps": sorted({n["app"] for n in self.nodes.values()}),
            "mean_edge_p": round(sum(map(self.p, es)) / len(es), 3) if es else None,
            "destructive_edges": sum(e["destructive"] for e in es),
            "actions_logged": sum(sum(e.get("outcomes", {}).values()) for e in es),
            "agents": sorted({a for e in es for a in e.get("agents", {})}),
        }

    # ---------- persistence
    def save(self, path=PATH):
        with self.mu:
            self._save(path)

    def _save(self, path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        nodes = {k: {**v, "labels": sorted(v["labels"])} for k, v in self.nodes.items()}
        tmp = "%s.%d.tmp" % (path, threading.get_ident())
        with open(tmp, "w") as f:
            json.dump({"nodes": nodes, "edges": self.edges, "skills": self.skills}, f)
        os.replace(tmp, path)


_g = None


def load(path=PATH):
    global _g
    with _lock:
        if _g is None:
            _g = Graph()
            try:
                d = json.load(open(path))
                _g.nodes = {k: {**v, "labels": set(v["labels"])} for k, v in d["nodes"].items()}
                _g.edges, _g.skills = d["edges"], d["skills"]
            except (OSError, ValueError, KeyError):
                pass
        return _g


def selftest():
    g = Graph()
    home = [
        {"role": "button", "name": "Battery"},
        {"role": "button", "name": "General"},
        {"role": "statictext", "name": "Settings 87%"},
    ]
    home2 = [dict(e, name=e["name"].replace("87", "86")) for e in home]
    batt = [{"role": "statictext", "name": "Battery"}, {"role": "button", "name": "Battery Health"}]
    health = [{"role": "statictext", "name": "Maximum Capacity 98%"}]
    a, a2 = g.identify("S", "Settings", home), g.identify("S", "Settings", home2)
    assert a == a2, "same screen with a changed number must be one node"
    b, h = g.identify("S", "Battery", batt), g.identify("S", "Battery Health", health)
    g.record(a, action_key("click", home[0]), b, True, 300)
    g.record(b, action_key("click", batt[1]), h, True, 400)
    g.record(b, "click:button:delete all data", h, True, 100)  # shorter but destructive
    tmplog = os.path.join(__import__("tempfile").mkdtemp(), "actions.jsonl")
    g.record(b, "click:button:delete all data", None, "denied", 0, run="r9", agent="QA", log=tmplog)
    e = g.edges[b]["click:button:delete all data"]
    assert e["n"] == 1 and e["outcomes"] == {"ok": 1, "denied": 1} and e["agents"] == {"QA": 1}, e
    assert json.loads(open(tmplog).read())["outcome"] == "denied"
    p = g.plan(a, "check battery health")
    assert p and p["action"] == "click:button:battery" and p["hops"] == 2, p
    assert abs(Graph.p(g.edges[a]["click:button:battery"]) - 2 / 3) < 1e-9  # (1+1)/(2+1)
    g.save_skill("S", "check my battery health", ["click:button:battery", "click:button:battery health"])
    assert g.find_skill("S", "check battery health") and not g.find_skill("S", "open wifi")
    path = os.path.join(__import__("tempfile").gettempdir(), "ca_graph_selftest.json")
    g.save(path)
    d = json.load(open(path))
    assert len(d["nodes"]) == 3 and d["skills"]["S"][0]["steps"][1] == "click:button:battery health"
    print("graph selftest OK", g.stats())


if __name__ == "__main__":
    selftest()
