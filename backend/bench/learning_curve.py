"""Does the agent get better with practice?

The same tasks are repeated R times under two conditions:
  stateful  (sf): one memory (CA_HOME/graph.json) carried across every trial
  stateless (sl): a fresh, empty memory for every trial
Per trial, gain g = r_sf - r_sl (the CL-Bench gain metric, arXiv 2606.05661): whatever makes a task easy or
hard appears in both terms, so the difference is what memory bought. We also log the cost side, because a
replayed skill should make the same success cheaper: steps, model calls, dollars and seconds.

Reward r = 1 only when the agent says it finished AND the expected answer is in its summary (Calculator),
or the verifier accepted it (no fixed answer). Conditions are interleaved within each repetition so app
state drift hits both arms alike. Agents act in the background; the run also records whether your
frontmost app ever changed.

    python3 bench/learning_curve.py --reps 3 --out bench/results/argon   [--model google/gemini-4-argon]
"""

import argparse
import csv
import json
import os
import subprocess
import sys
import tempfile
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
TASKS = [
    {
        "id": "calc-23x19",
        "goal": "In Calculator, compute 23 × 19 and read the result",
        "app": "Calculator",
        "expect": ["437"],
    },
    {
        "id": "calc-48x25",
        "goal": "In Calculator, compute 48 × 25 and read the result",
        "app": "Calculator",
        "expect": ["1200", "1,200"],
    },
    {
        "id": "calc-144/12",
        "goal": "In Calculator, compute 144 ÷ 12 and read the result",
        "app": "Calculator",
        "expect": ["12"],
    },
    {
        "id": "settings-appearance",
        "goal": "In System Settings, open the Appearance pane",
        "app": "System Settings",
        "expect": None,
    },
]
FIELDS = ["model", "cond", "rep", "task", "r", "ok", "steps", "memory_steps", "calls", "cost", "seconds", "summary"]


def trial(task):
    """One run inside a child process (CA_HOME already set). Prints one JSON line."""
    sys.path.insert(0, os.path.dirname(HERE))
    from computeranything.core import runs
    from computeranything.cu import cu_agent

    run = runs.Run(task["goal"], role="cu")
    run.agent_name = "Bench"
    t0 = time.time()
    res = cu_agent.run_task(run, task["goal"], app=task["app"], max_steps=20)
    summary = (res.get("summary") or "").replace("‎", "")
    hit = task["expect"] is None or any(e in summary.replace(" ", "") for e in task["expect"])
    acts = [e for e in run.events if e["kind"] == "act"]
    print(
        "RESULT "
        + json.dumps(
            {
                "r": int(bool(res.get("ok")) and hit),
                "ok": int(bool(res.get("ok"))),
                "steps": len(acts),
                "memory_steps": sum(e.get("source") == "memory" for e in acts),
                "calls": run.usage["calls"],
                "cost": round(run.usage["cost"], 6),
                "seconds": round(time.time() - t0, 1),
                "summary": summary[:200],
            }
        ),
        flush=True,
    )


def run_one(task, home, model):
    env = dict(os.environ, CA_HOME=home)
    if model:
        env["CA_MODEL"] = model
    p = subprocess.run(
        [sys.executable, __file__, "--trial", json.dumps(task)], env=env, capture_output=True, text=True, timeout=600
    )
    line = next((x for x in p.stdout.splitlines() if x.startswith("RESULT ")), None)
    if not line:
        return {
            "r": 0,
            "ok": 0,
            "steps": 0,
            "memory_steps": 0,
            "calls": 0,
            "cost": 0,
            "seconds": 0,
            "summary": "crashed: " + (p.stderr or p.stdout)[-200:].replace("\n", " "),
        }
    return json.loads(line[len("RESULT ") :])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--reps", type=int, default=3)
    ap.add_argument("--model", default=None)
    ap.add_argument("--out", default=os.path.join(HERE, "results", "run"))
    ap.add_argument("--trial")
    a = ap.parse_args()
    if a.trial:
        return trial(json.loads(a.trial))
    os.makedirs(a.out, exist_ok=True)
    sf_home = os.path.join(a.out, "sf_home")  # the one memory that persists across the stateful trials
    model = a.model or "default"
    front, done = [], threading.Event()

    def probe():
        while not done.is_set():
            front.append(subprocess.run(["lsappinfo", "front"], capture_output=True, text=True).stdout.strip())
            time.sleep(0.5)

    threading.Thread(target=probe, daemon=True).start()
    path = os.path.join(a.out, "trials.csv")
    with open(path, "w", newline="") as f:
        w = csv.DictWriter(f, FIELDS, lineterminator="\n")
        w.writeheader()
        for rep in range(1, a.reps + 1):
            for task in TASKS:
                for cond in ("sf", "sl"):
                    home = sf_home if cond == "sf" else tempfile.mkdtemp(prefix="ca_sl_")
                    row = run_one(task, home, a.model)
                    row.update(model=model, cond=cond, rep=rep, task=task["id"])
                    w.writerow({k: row.get(k) for k in FIELDS})
                    f.flush()
                    print(
                        "rep %d %-20s %s r=%d steps=%d mem=%d calls=%d $%.4f %.0fs"
                        % (
                            rep,
                            task["id"],
                            cond,
                            row["r"],
                            row["steps"],
                            row["memory_steps"],
                            row["calls"],
                            row["cost"],
                            row["seconds"],
                        ),
                        flush=True,
                    )
    done.set()
    meta = {
        "model": model,
        "reps": a.reps,
        "tasks": [t["id"] for t in TASKS],
        "frontmost_apps_seen": len(set(front)),
        "probe_samples": len(front),
    }
    with open(os.path.join(a.out, "meta.json"), "w") as f:
        json.dump(meta, f, indent=2)
    print("wrote", path, json.dumps(meta))


if __name__ == "__main__":
    main()
