"""End-to-end test of the workspace UI in a real (headless) browser against a real backend in mock mode.

Covers: file upload, file search, prompt submit, help request answered from a notification, the chat window
transcript (hellos, steps, results), a follow-up in the same chat, dismissing a notification, analytics,
settings, and that the user's frontmost app never changed. No model spend, no clicks on the desktop:
the scripted task is a QA/dev loop on a throwaway git repo.

    python3 scripts/ui_e2e.py [screenshot_dir]
"""

import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request

from playwright.sync_api import expect, sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
SHOTS = sys.argv[1] if len(sys.argv) > 1 else tempfile.mkdtemp(prefix="ca_ui_shots_")
PORT = 8799


def sh(*cmd, cwd=None):
    subprocess.run(cmd, cwd=cwd, check=True, capture_output=True)


def fixture():
    home = tempfile.mkdtemp(prefix="ca_home_")
    repo = tempfile.mkdtemp(prefix="ca_repo_")
    with open(os.path.join(repo, "calc.py"), "w") as f:
        f.write("def add(a, b):\n    return a - b\n")
    sh("git", "init", "-q", cwd=repo)
    sh("git", "-C", repo, "config", "user.email", "qa@example.com")
    sh("git", "-C", repo, "config", "user.name", "qa")
    patch = (
        "diff --git a/calc.py b/calc.py\n--- a/calc.py\n+++ b/calc.py\n@@ -1,2 +1,2 @@\n"
        " def add(a, b):\n-    return a - b\n+    return a + b\n"
    )
    bug = {"id": "B1", "title": "add subtracts", "severity": "high", "evidence": "add(2,2)==0", "file_hint": "calc.py"}
    route = {
        "role": "qa",
        "app": None,
        "repo": repo,
        "url": None,
        "goal": "test and fix calc",
        "names": ["Quinn", "Devi"],
    }
    replies = [route, {"bugs": [bug]}, {"patch": patch, "explanation": "use +"}, {"bugs": []}, route, {"bugs": []}]
    path = os.path.join(home, "replies.json")
    with open(path, "w") as f:
        json.dump(replies, f)
    files = os.path.join(home, "upload")
    os.makedirs(files)
    with open(os.path.join(files, "notes.txt"), "w") as f:
        f.write("ship it after the tests pass")
    return home, repo, path, os.path.join(files, "notes.txt")


def api(base, tok, path):
    with urllib.request.urlopen(urllib.request.Request(base + path, headers={"X-CA-Token": tok}), timeout=5) as r:
        return json.loads(r.read())


def main():
    home, repo, replies, upload = fixture()
    env = dict(
        os.environ,
        CA_HOME=home,
        CA_MOCK="1",
        CA_MOCK_REPLIES=replies,
        CA_PORT=str(PORT),
        CA_NO_NOTCH="1",
        CA_NO_OVERLAY="1",
    )
    srv = subprocess.Popen(
        [sys.executable, "-m", "computeranything"],
        cwd=os.path.dirname(HERE),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    url = None
    for line in srv.stdout:
        if line.startswith("ca console: "):
            url = line.split("ca console: ", 1)[1].strip()
            break
    threading.Thread(target=lambda: [None for _ in srv.stdout], daemon=True).start()  # drain logs
    base, tok = url.split("/?t=")
    front, done = [], threading.Event()

    def probe():
        while not done.is_set():
            front.append(subprocess.run(["lsappinfo", "front"], capture_output=True, text=True).stdout.strip())
            time.sleep(0.2)

    threading.Thread(target=probe, daemon=True).start()
    checks = []

    def ok(name, cond=True):
        assert cond, name
        checks.append(name)
        print("PASS", name, flush=True)

    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            page = browser.new_page(viewport={"width": 520, "height": 760})
            page.goto("%s/ui?t=%s&state=expanded" % (base, tok))
            expect(page.locator("#prompt-input")).to_be_visible()

            page.set_input_files("#file-input", [upload])
            expect(page.locator(".attachment-token")).to_have_count(1)
            ok("upload: file chosen in the picker shows as an attachment")

            page.click("#attach-btn")
            page.click("[data-attach-kind=search]")
            page.fill("#file-search-input", os.path.basename(upload))
            hit = page.locator(".file-hit").first
            try:
                hit.wait_for(timeout=6000)
                ok("file search: Spotlight returns a match")
            except Exception:  # noqa: BLE001 - a just-written temp file may not be indexed yet
                print("note: temp file not in the Spotlight index yet; searching for README instead")
                page.fill("#file-search-input", "README")
                hit.wait_for(timeout=6000)
                ok("file search: Spotlight returns a match (README)")
            page.screenshot(path=os.path.join(SHOTS, "1_file_search.png"))
            hit.click()
            expect(page.locator(".attachment-token")).to_have_count(2)
            ok("file search: picking a result attaches it")

            page.fill("#prompt-input", "test my calculator at %s" % repo)
            page.press("#prompt-input", "Enter")
            parent = None
            for _ in range(50):
                runs = api(base, tok, "/api/runs")
                parent = next((r for r in runs if r["role"] == "orchestrator"), None)
                if parent:
                    break
                time.sleep(0.2)
            ok("submit: the task reached the backend", parent is not None)
            thread = parent["id"]

            notes = browser.new_page(viewport={"width": 340, "height": 700})
            for pg in (page, notes):
                pg.on("console", lambda m: m.type in ("error", "warning") and print("console:", m.text))
                pg.on("pageerror", lambda e: print("pageerror:", e))
            notes.goto("%s/ui?shell=notes&t=%s" % (base, tok))
            expect(notes.get_by_text("needs you")).to_be_visible(timeout=10000)
            notes.screenshot(path=os.path.join(SHOTS, "2_notifications_help.png"))
            notes.get_by_role("button", name="Approve").click()
            ok("notification: the help request was approved from its card")

            chat = browser.new_page(viewport={"width": 420, "height": 540})
            chat.goto("%s/ui?shell=chat&run=%s&t=%s" % (base, thread, tok))
            expect(chat.locator("#chat-log")).to_contain_text("Hi, I'm Quinn!", timeout=10000)
            expect(chat.locator("#chat-log")).to_contain_text("clean after 2 round", timeout=15000)
            expect(chat.locator("#chat-state")).to_contain_text("Done")
            ok("chat: transcript shows hellos, steps and the result")
            ok("qa loop: the approved patch fixed the bug", "a + b" in open(os.path.join(repo, "calc.py")).read())

            chat.fill("#chat-input", "run the tests again")
            chat.press("#chat-input", "Enter")
            expect(chat.locator("#chat-log")).to_contain_text("run the tests again", timeout=5000)
            expect(chat.locator("#chat-log")).to_contain_text("clean after 1 round", timeout=15000)
            chat.screenshot(path=os.path.join(SHOTS, "3_chat_followup.png"))
            ok("chat: a follow-up joins the same conversation")

            notes.reload()
            cards = notes.locator(".note")
            expect(cards.first).to_be_visible(timeout=5000)
            n = cards.count()
            notes.screenshot(path=os.path.join(SHOTS, "4_notifications.png"))
            notes.get_by_role("button", name="Dismiss").first.click()
            expect(cards).to_have_count(n - 1, timeout=5000)
            ok("notifications: persistent until dismissed (%d -> %d)" % (n, n - 1))

            page.click("[data-side=analytics]")
            expect(page.locator("#side-view")).to_contain_text("Spend", timeout=5000)
            expect(page.locator("#side-view")).to_contain_text("2 tasks")
            page.screenshot(path=os.path.join(SHOTS, "5_analytics.png"))
            ok("analytics: tasks and spend shown")

            page.click("[data-close-side]")
            page.click("[data-side=settings]")
            page.fill("input[name=call_me]", "Yahvin")
            page.click("text=Save settings")
            expect(page.locator("#settings-msg")).to_contain_text("Saved")
            page.screenshot(path=os.path.join(SHOTS, "6_settings.png"))
            ok("settings: saved and read back", api(base, tok, "/api/profile")["call_me"] == "Yahvin")
            browser.close()
        done.set()
        ok("focus: the frontmost app never changed (%d samples)" % len(front), len(set(front)) == 1)
    except Exception:
        print("help:", json.dumps(api(base, tok, "/api/help"))[:600])
        print("runs:", [(r["role"], r["state"]) for r in api(base, tok, "/api/runs")])
        raise
    finally:
        done.set()
        srv.terminate()
    print("\nui e2e: %d checks passed; screenshots in %s" % (len(checks), SHOTS))


if __name__ == "__main__":
    main()
