"""Orchestrator: one prompt in, a multi-agent pipeline out.

route() picks a role (qa | marketing | cu), submit() runs it on a daemon thread under a parent Run,
and the parent's result carries a digest of every child run. Money and sign-in steps are handled
inside cu_agent (it calls runs.ask_human); this module only passes goals through.
"""

import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import time

from ..core import llm, runs

ROLES = ("qa", "marketing", "cu")
TEST_TIMEOUT = 300
MAX_FILES, FILE_CHARS, OUT_TAIL = 6, 6000, 4000

MAX_PARALLEL = 4  # concurrent CU agents; each one drives its own app with its own cursor

ROUTER_SYS = """You route one user request for a macOS computer agent to a role.
Roles:
- qa: test a software project or web app, find bugs, fix them (needs a repo path and/or a localhost url)
- marketing: make launch/promo material (tagline, launch video script, shot list) for an app or url
- cu: anything else done by operating a Mac app (mail, calendar, browser, settings, files)
Reply with JSON only: {"role": "qa"|"marketing"|"cu", "app": str|null, "repo": str|null (absolute or ~ path),
"url": str|null, "goal": str (one clear sentence),
"subtasks": [{"goal": str, "app": str}] (cu only: when the request has independent parts in different apps,
one entry per part so separate agents can run them in parallel; otherwise [])}."""

QA_SYS = """You are a QA engineer. From test output and UI check notes, list real bugs only.
Reply with JSON only: {"bugs": [{"id": str, "title": str, "severity": "high"|"med"|"low",
"evidence": str, "file_hint": str|null (path relative to the repo)}]}. If everything passes, {"bugs": []}."""

DEV_SYS = """You are a senior developer. Fix the listed bugs with the smallest correct change.
Reply with JSON only: {"patch": str (a unified diff with a/ and b/ prefixes, paths relative to the repo root,
applicable with `git apply`), "explanation": str}."""

MKT_SYS = """You are a product marketer. From the screenshots and goal, write a launch brief.
Reply with JSON only: {"tagline": str, "launch_script": str (60-second voice-over narration),
"shot_list": [str], "palette": [str (hex colours taken from the screenshots)]}."""


# ---------------------------------------------------------------- routing


def _keyword_route(prompt):
    p = prompt.lower()
    if re.search(r"\b(test|tests|testing|qa|bug|bugs|debug|fix)\b", p):
        role = "qa"
    elif re.search(r"market|launch video|promo|tagline|\bads?\b|\badvert", p):
        role = "marketing"
    else:
        role = "cu"
    url = re.search(r"https?://\S+|localhost:\d+\S*", prompt)
    repo = re.search(r"(~?/[\w.\-/]+)", prompt)
    url = url.group(0) if url else None
    if url and not url.startswith("http"):
        url = "http://" + url
    return {
        "role": role,
        "app": None,
        "repo": repo.group(1) if repo and role == "qa" else None,
        "url": url,
        "goal": prompt.strip(),
    }


def route(prompt, attachments=()):
    """LLM router with a keyword fallback when the call raises or returns junk."""
    try:
        user = prompt + ("\nAttachments: " + ", ".join(map(str, attachments)) if attachments else "")
        r = llm.chat(ROUTER_SYS, user, json_mode=True, max_tokens=400)
        if not isinstance(r, dict) or r.get("role") not in ROLES:
            raise ValueError("bad router reply: %r" % (r,))
    except Exception as e:  # noqa: BLE001 - any failure falls back to keywords
        r = _keyword_route(prompt)
        r["fallback"] = str(e)[:200]
    out = {k: r.get(k) or None for k in ("role", "app", "repo", "url", "goal")}
    subs = r.get("subtasks") if out["role"] == "cu" else None
    out["subtasks"] = [
        {"goal": str(t["goal"]), "app": t.get("app") or None}
        for t in (subs if isinstance(subs, list) else [])
        if isinstance(t, dict) and t.get("goal")
    ][:MAX_PARALLEL]
    out["goal"] = out["goal"] or prompt.strip()
    if out["repo"]:
        out["repo"] = os.path.abspath(os.path.expanduser(out["repo"]))
    if "fallback" in r:
        out["fallback"] = r["fallback"]
    return out


# ---------------------------------------------------------------- pipeline


def submit(prompt, attachments=()):
    """Start the pipeline on a daemon thread; return the parent Run at once (.thread to join)."""
    parent = runs.Run(prompt, role="orchestrator")
    t = threading.Thread(target=_pipeline, args=(parent, prompt, tuple(attachments)), daemon=True)
    parent.thread = t
    t.start()
    return parent


def _pipeline(parent, prompt, attachments):
    children = []
    try:
        parent.set("planning")
        r = route(prompt, attachments)
        parent.emit("route", **r)
        parent.set("acting")
        if r["role"] == "qa":
            repo = r["repo"] or next((os.path.abspath(a) for a in attachments if os.path.isdir(str(a))), None)
            res, children = qa_loop(parent, repo, r["url"], r["goal"])
        elif r["role"] == "marketing":
            res, children = marketing(parent, r["url"] or r["app"], r["goal"])
        else:
            res, children = cu(parent, r["goal"], r["app"], r.get("subtasks"))
        parent.result = {"ok": bool(res.get("ok")), "summary": res.get("summary", "")}
        parent.result["digest"] = runs.digest(parent, children)
        parent.set("done" if parent.result["ok"] else "failed")
    except Exception as e:  # noqa: BLE001
        parent.emit("error", error="%s: %s" % (type(e).__name__, e))
        parent.result = {"ok": False, "summary": "orchestrator error: %s" % e}
        try:
            parent.result["digest"] = runs.digest(parent, children)
        except Exception:  # noqa: BLE001
            pass
        parent.set("failed")


def _cu():
    from ..cu import cu_agent  # written in parallel; import lazily

    return cu_agent


def _finish(run, ok, summary, **extra):
    run.result = {"ok": ok, "summary": summary, **extra}
    if run.state not in ("done", "failed"):
        run.set("done" if ok else "failed")
    return run.result


# ---------------------------------------------------------------- cu role


def cu(parent, goal, app=None, subtasks=None):
    """One CU agent, or several in parallel (one per independent subtask). Each child is its own agent:
    own Run, own cursor on screen, own trail in the action graph."""
    tasks = subtasks if subtasks and len(subtasks) > 1 else [{"goal": goal, "app": app}]
    children, results = [], [None] * len(tasks)

    def work(i, t):
        child = children[i]
        child.set("acting")
        try:
            res = _cu().run_task(child, t["goal"], app=t.get("app"))
        except Exception as e:  # noqa: BLE001 - one agent failing must not kill its siblings
            child.emit("error", error="%s: %s" % (type(e).__name__, e))
            res = {"ok": False, "summary": "agent error: %s" % e, "steps": 0}
        _finish(child, bool(res.get("ok")), res.get("summary", ""), steps=res.get("steps", 0))
        results[i] = res

    for i, t in enumerate(tasks):
        child = runs.Run(t["goal"], role="cu", parent=parent.id)
        child.agent_name = "CU %d" % (i + 1)
        children.append(child)
    threads = [threading.Thread(target=work, args=(i, t), daemon=True) for i, t in enumerate(tasks)]
    for th in threads:
        th.start()
    for th in threads:
        th.join()
    if len(tasks) == 1:
        return results[0], children
    ok = all(r.get("ok") for r in results)
    summary = " | ".join(
        "%s: %s" % (c.agent_name, r.get("summary", "")) for c, r in zip(children, results, strict=True)
    )
    return {"ok": ok, "summary": summary, "steps": sum(r.get("steps", 0) for r in results)}, children


# ---------------------------------------------------------------- qa role


def _sh(cmd, cwd, timeout=TEST_TIMEOUT):
    try:
        p = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout)
        return p.returncode, (p.stdout or "") + (p.stderr or "")
    except subprocess.TimeoutExpired as e:
        out = (e.stdout or b"") + (e.stderr or b"")
        return -1, (out.decode(errors="replace") if isinstance(out, bytes) else out) + "\n[timeout %ss]" % timeout
    except OSError as e:
        return -2, str(e)


def detect_tests(repo):
    """Test command for the repo, or None."""
    pj = os.path.join(repo, "package.json")
    if os.path.exists(pj):
        try:
            test = (json.load(open(pj)).get("scripts") or {}).get("test", "")
        except ValueError:
            test = ""
        if test and "no test specified" not in test:
            return ["npm", "test", "--silent"]
    names = os.listdir(repo)
    if {"pyproject.toml", "pytest.ini", "setup.cfg", "tox.ini", "tests"} & set(names) or any(
        re.match(r"test_.*\.py$|.*_test\.py$", n) for n in names
    ):
        return [sys.executable or "python3", "-m", "pytest", "-q", "-x"]
    return None


def _browser():
    return "Google Chrome" if os.path.exists("/Applications/Google Chrome.app") else "Safari"


def qa_round(qa, repo, url, goal, rnd):
    cmd = detect_tests(repo)
    if cmd:
        code, out = _sh(cmd, repo)
        tail = out[-OUT_TAIL:]
    else:
        code, tail = None, "no test runner detected"
    qa.emit("tests", round=rnd, cmd=" ".join(cmd) if cmd else None, exit=code, tail=tail[-600:])
    ui = None
    if url and re.match(r"https?://(localhost|127\.0\.0\.1)", url):
        ui = _cu().run_task(qa, "open %s and check the main page works" % url, app=_browser(), max_steps=12)
        qa.emit("ui_check", round=rnd, ok=ui.get("ok"), summary=ui.get("summary"))
    user = "Goal: %s\nRepo: %s\nRound %d\nTest command: %s (exit %s)\nTest output tail:\n%s\n\nUI check: %s" % (
        goal,
        repo,
        rnd,
        " ".join(cmd) if cmd else "none",
        code,
        tail,
        json.dumps(ui) if ui else "not run",
    )
    report = llm.chat(QA_SYS, user, json_mode=True, max_tokens=1500)
    bugs = report.get("bugs") if isinstance(report, dict) else None
    bugs = [b for b in (bugs or []) if isinstance(b, dict) and b.get("title")]
    return bugs, tail


def _inside(repo, path):
    full = os.path.realpath(os.path.join(repo, path))
    return full if full.startswith(os.path.realpath(repo) + os.sep) and os.path.isfile(full) else None


def gather_files(repo, bugs, test_out):
    picks = [b.get("file_hint") for b in bugs if b.get("file_hint")]
    picks += re.findall(r"[\w./\-]+\.(?:py|js|jsx|ts|tsx|mjs|cjs|vue|svelte|go|rb|rs)\b", test_out)
    files, seen = {}, set()
    for p in picks:
        p = p.strip()
        full = _inside(repo, os.path.relpath(p, repo) if os.path.isabs(p) else p)
        if not full or full in seen:
            continue
        seen.add(full)
        try:
            files[os.path.relpath(full, os.path.realpath(repo))] = open(full, errors="replace").read()[:FILE_CHARS]
        except OSError:
            continue
        if len(files) >= MAX_FILES:
            break
    return files


def apply_patch(repo, patch):
    with tempfile.NamedTemporaryFile("w", suffix=".diff", delete=False) as f:
        f.write(patch if patch.endswith("\n") else patch + "\n")
    try:
        code, out = _sh(["git", "-C", repo, "apply", "--whitespace=nowarn", f.name], repo, timeout=60)
    finally:
        os.unlink(f.name)
    return code == 0, out.strip()


def dev_fix(dev, repo, bugs, test_out, rnd):
    files = gather_files(repo, bugs, test_out)
    user = "Bugs:\n%s\n\nTest output tail:\n%s\n\nFiles:\n%s" % (
        json.dumps(bugs, indent=1),
        test_out[-2000:],
        "\n\n".join("=== %s ===\n%s" % (k, v) for k, v in files.items()) or "(none found)",
    )
    err = None
    for attempt in (1, 2):
        ask = (
            user if not err else user + "\n\nYour previous patch failed `git apply`:\n%s\nSend a corrected patch." % err
        )
        r = llm.chat(DEV_SYS, ask, json_mode=True, max_tokens=4000)
        patch = (r.get("patch") or "") if isinstance(r, dict) else ""
        if not patch.strip():
            dev.emit("patch", round=rnd, attempt=attempt, applied=False, error="empty patch")
            return False
        if os.environ.get("CA_CONFIRM_PATCH", "1") != "0":  # model-written code needs a yes by default
            if (
                runs.ask_human(
                    dev,
                    "destructive",
                    "Apply patch to %s?" % repo,
                    ("approve", "deny"),
                    timeout=300,
                    detail=patch[:4000],
                )
                != "approve"
            ):
                dev.emit("patch", round=rnd, attempt=attempt, applied=False, error="denied by user")
                return False
        ok, out = apply_patch(repo, patch)
        dev.emit(
            "patch",
            round=rnd,
            attempt=attempt,
            applied=ok,
            files=sorted(files),
            explanation=r.get("explanation", ""),
            diff=patch[:3000],
            error=None if ok else out[:1000],
        )
        if ok:
            commit_patch(dev, repo, patch, r.get("explanation", ""), rnd)
            return True
        err = out
    return False


def commit_patch(dev, repo, patch, explanation, rnd):
    """Commit only the files this patch touched. Gemini wrote the patch, so the commit credits it."""
    if os.environ.get("CA_DEV_COMMIT", "1") == "0":
        return
    touched = sorted(set(re.findall(r"^\+\+\+ b/(\S+)", patch, re.M)))
    if not touched:
        return
    msg = "fix(qa round %d): %s\n\nCo-Authored-By: Gemini 4 Argon <noreply@openrouter.ai>\n" % (
        rnd,
        (explanation or "patch from the dev agent").splitlines()[0][:72],
    )
    _sh(["git", "-C", repo, "add", "--", *touched], repo, timeout=60)
    code, out = _sh(["git", "-C", repo, "commit", "-q", "-m", msg, "--", *touched], repo, timeout=60)
    dev.emit("commit", files=touched, ok=code == 0, out=out.strip()[:300])


def qa_loop(parent, repo, url, goal, max_rounds=5):
    """QA agent finds bugs, dev agent patches them, until clean, stuck, or out of rounds."""
    qa = runs.Run(goal, role="qa", parent=parent.id)
    qa.agent_name = "QA"
    dev = runs.Run(goal, role="dev", parent=parent.id)
    dev.agent_name = "Dev"
    children = [qa, dev]
    if not repo or not os.path.isdir(repo):
        msg = "no project folder to test (got %r)" % repo
        _finish(qa, False, msg), _finish(dev, False, msg)
        return {"ok": False, "summary": msg, "rounds": 0}, children
    qa.set("acting")
    prev, ok, why, rnd, fixes = None, False, "max rounds reached", 0, 0
    for rnd in range(1, max_rounds + 1):
        bugs, tail = qa_round(qa, repo, url, goal, rnd)
        qa.emit("bug_report", round=rnd, bugs=bugs)
        if not bugs:
            ok, why = True, "clean after %d round(s), %d patch(es) applied" % (rnd, fixes)
            break
        titles = sorted(b["title"].strip().lower() for b in bugs)
        if titles == prev:
            why = "stuck: same bugs reported twice in a row (%s)" % "; ".join(titles)[:300]
            break
        prev = titles
        dev.set("acting")
        if dev_fix(dev, repo, bugs, tail, rnd):
            fixes += 1
    res = {"ok": ok, "summary": "QA %s: %s" % (repo, why), "rounds": rnd, "patches": fixes}
    _finish(qa, ok, res["summary"], rounds=rnd)
    _finish(dev, ok, "%d patch(es) applied" % fixes, patches=fixes)
    return res, children


# ---------------------------------------------------------------- marketing role


def _shot(path):
    if os.environ.get("CA_MOCK") == "1":
        return None  # no real screen in tests
    code, _ = _sh(["screencapture", "-x", path], None, timeout=20)
    return path if code == 0 and os.path.exists(path) else None


def marketing(parent, url_or_app, goal):
    child = runs.Run(goal, role="marketing", parent=parent.id)
    child.agent_name = "Marketing"
    child.set("acting")
    out_dir = os.path.join(runs.HOME, "marketing", child.id)
    os.makedirs(out_dir, exist_ok=True)
    target = url_or_app or ""
    is_url = bool(re.match(r"https?://|localhost", target))
    app = _browser() if is_url or not target else target
    if target and not is_url:
        try:
            from ..cu import desktop

            desktop.act("launch", app=app)
        except Exception as e:  # noqa: BLE001
            child.emit("warn", error="launch failed: %s" % e)
    tours = [
        "open %s and show its main screen" % (target or "the frontmost app"),
        "in %s, open the most impressive feature screen" % (target or "the app"),
        "in %s, show one more distinct screen that a new user would love" % (target or "the app"),
    ]
    shots = []
    for i, g in enumerate(tours, 1):
        try:
            r = _cu().run_task(child, g, app=app, max_steps=8)
            child.emit("tour", step=i, ok=r.get("ok"), summary=r.get("summary"))
        except Exception as e:  # noqa: BLE001
            child.emit("warn", error="tour %d: %s" % (i, e))
        time.sleep(0.5)
        p = _shot(os.path.join(out_dir, "shot%d.png" % i))
        if p:
            shots.append(p)
            child.emit("artifact", path=p, type="screenshot")
    brief = llm.chat(
        MKT_SYS, "Goal: %s\nProduct: %s" % (goal, target or app), images=shots, json_mode=True, max_tokens=2000
    )
    brief = (
        {k: brief.get(k) for k in ("tagline", "launch_script", "shot_list", "palette")}
        if isinstance(brief, dict)
        else {}
    )
    brief["screenshots"] = shots
    path = os.path.join(out_dir, "brief.json")
    with open(path, "w") as f:
        json.dump(brief, f, indent=2)
    # ponytail: the brief is JSON + screenshots; a Remotion launch-video render is the upgrade path.
    child.emit("artifact", path=path, type="brief", tagline=brief.get("tagline"))
    ok = bool(brief.get("tagline") and brief.get("launch_script"))
    res = {"ok": ok, "summary": "launch brief at %s: %s" % (path, brief.get("tagline")), "brief": path}
    _finish(child, ok, res["summary"], brief=path)
    return res, [child]


# ---------------------------------------------------------------- selftest


def selftest():
    os.environ["CA_MOCK"] = "1"
    os.environ["CA_AUTO_APPROVE"] = "1"  # the patch-approval prompt answers itself in tests
    import types

    calls = []

    def stub(run, goal, app=None, max_steps=25):
        calls.append((goal, app))
        return {"ok": True, "summary": "stub did: " + goal, "steps": 1}

    try:
        from ..cu import cu_agent as mod
    except Exception:  # noqa: BLE001 - not written yet: inject a stub module
        mod = types.ModuleType(__package__ + ".cu_agent")
        sys.modules[mod.__name__] = mod
        sys.modules[__package__].cu_agent = mod
    mod.run_task = stub

    # 1. keyword fallback when the LLM raises
    real_chat = llm.chat
    llm.chat = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("offline"))
    try:
        assert route("please test my app and fix bugs")["role"] == "qa"
        assert route("make a launch video for Notes")["role"] == "marketing"
        assert route("archive my unread mail")["role"] == "cu"
    finally:
        llm.chat = real_chat

    # 2. full QA pipeline on a temp git repo: round 1 one bug -> patch -> round 2 clean
    repo = tempfile.mkdtemp(prefix="ca_qa_")
    with open(os.path.join(repo, "calc.py"), "w") as f:
        f.write("def add(a, b):\n    return a - b\n")
    _sh(["git", "init", "-q"], repo, 30)
    _sh(["git", "-C", repo, "config", "user.email", "qa@example.com"], repo, 30)
    _sh(["git", "-C", repo, "config", "user.name", "qa"], repo, 30)
    patch = (
        "diff --git a/calc.py b/calc.py\n--- a/calc.py\n+++ b/calc.py\n@@ -1,2 +1,2 @@\n"
        " def add(a, b):\n-    return a - b\n+    return a + b\n"
    )
    llm.mock(
        json.dumps({"role": "qa", "app": None, "repo": repo, "url": None, "goal": "test and fix calc"}),
        json.dumps(
            {
                "bugs": [
                    {
                        "id": "B1",
                        "title": "add subtracts",
                        "severity": "high",
                        "evidence": "add(2,2) == 0",
                        "file_hint": "calc.py",
                    }
                ]
            }
        ),
        json.dumps({"patch": patch, "explanation": "use +"}),
        json.dumps({"bugs": []}),
    )
    parent = submit("test my calculator at " + repo)
    parent.thread.join(30)
    assert parent.state == "done", (parent.state, parent.events[-3:])
    assert parent.result["ok"] and "2 round" in parent.result["summary"], parent.result
    assert "a + b" in open(os.path.join(repo, "calc.py")).read()
    assert len(parent.result["digest"]["children"]) == 2
    qa = next(r for r in runs.RUNS.values() if r.parent == parent.id and r.role == "qa")
    assert sum(e["kind"] == "bug_report" for e in qa.events) == 2

    # 3. stuck detection: same bug twice -> stop, not ok
    bug = json.dumps({"bugs": [{"id": "B9", "title": "never fixed", "severity": "low", "evidence": "x"}]})
    llm.mock(bug, json.dumps({"patch": "", "explanation": "none"}), bug)
    res, _ = qa_loop(runs.Run("stuck", role="orchestrator"), repo, None, "stuck check")
    assert not res["ok"] and "stuck" in res["summary"] and res["rounds"] == 2, res

    # 4. cu and marketing roles through the stub
    llm.mock(json.dumps({"role": "cu", "app": "Calendar", "repo": None, "url": None, "goal": "add lunch at noon"}))
    p2 = submit("add lunch at noon to my calendar")
    p2.thread.join(10)
    assert p2.state == "done" and calls[-1] == ("add lunch at noon", "Calendar"), (p2.state, calls)
    llm.mock(
        json.dumps(
            {"tagline": "Math, fixed.", "launch_script": "Meet calc.", "shot_list": ["hero"], "palette": ["#112233"]}
        )
    )
    res, (m,) = marketing(runs.Run("promo", role="orchestrator"), "http://localhost:3000", "promo for calc")
    assert res["ok"] and json.load(open(res["brief"]))["tagline"] == "Math, fixed."
    print("orchestrator selftest OK")


if __name__ == "__main__":
    selftest()
