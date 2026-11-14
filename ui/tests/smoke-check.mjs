#!/usr/bin/env node
/**
 * Headless Chrome smoke check (no npm packages, Node built-ins only).
 * Serves ui/ on 127.0.0.1 on a free port, launches headless Chrome via CDP, and loads:
 *   - ui/index.html with every non-backend-shape, non-workspace fixture (?fixture=<name>&state=expanded)
 *   - ui/workspace.html with every workspace-* fixture and every view (?fixture=<name>&view=<view>)
 *   - ui/demo/index.html
 * Fails if the page throws an uncaught exception, logs a console/browser error (ignoring missing
 * favicon.ico), or if document.body.innerText lacks expected text for that state.
 * Prints one line per page and a final CHECK PASS/FAIL line.
 * If Google Chrome is not installed, prints SKIP with the reason and exits 0.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupAll, killProcessTree, registerCleanup, spawnManaged } from "./process-cleanup.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const UI_DIR = path.resolve(__dirname, "..");
const FIXTURES_DIR = path.join(UI_DIR, "fixtures");

const PAGE_TIMEOUT_MS = 5000;
const TOTAL_BUDGET_MS = 60000;

const WORKSPACE_VIEWS = [
  "graph",
  "state-machine",
  "logs",
  "analytics",
  "onboarding",
  "history-settings",
];

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function findChrome() {
  if (process.env.CHROME_PATH !== undefined) {
    const envPath = process.env.CHROME_PATH.trim();
    if (!envPath) return null;
    return fs.existsSync(envPath) ? envPath : null;
  }

  const macCandidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ];
  for (const candidate of macCandidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  for (const cmd of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
    const res = spawnSync("which", [cmd], { encoding: "utf8" });
    if (res.status === 0 && res.stdout.trim()) {
      return res.stdout.trim().split(/\r?\n/)[0];
    }
  }
  return null;
}

function startStaticServer(rootDir) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const reqUrl = new URL(req.url || "/", "http://127.0.0.1");
        let relPath = decodeURIComponent(reqUrl.pathname);
        if (relPath === "/") relPath = "/index.html";
        if (relPath.endsWith("/")) relPath += "index.html";

        const resolved = path.resolve(rootDir, "." + relPath);
        if (!resolved.startsWith(rootDir + path.sep) && resolved !== rootDir) {
          res.writeHead(403, { "Content-Type": "text/plain" });
          res.end("Forbidden");
          return;
        }

        if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("Not found");
          return;
        }

        const ext = path.extname(resolved).toLowerCase();
        const mime = MIME_TYPES[ext] || "application/octet-stream";
        res.writeHead(200, { "Content-Type": mime, "Cache-Control": "no-store" });
        fs.createReadStream(resolved).pipe(res);
      } catch (err) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end(err.message);
      }
    });

    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, port: addr.port });
    });
  });
}

function launchChrome(chromePath, userDataDir) {
  return new Promise((resolve, reject) => {
    const args = [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--disable-background-networking",
      "about:blank",
    ];

    const proc = spawnManaged(chromePath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderrBuf = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        killProcessTree(proc, "SIGKILL");
        reject(new Error(`Timed out waiting for Chrome DevTools port. stderr: ${stderrBuf.slice(-400)}`));
      }
    }, 15000);

    proc.stderr.on("data", (chunk) => {
      stderrBuf += chunk.toString("utf8");
      const m = stderrBuf.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:(\d+)\/[^\s]+)/);
      if (m && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ proc, debugPort: Number(m[2]), browserWsUrl: m[1] });
      }
    });

    proc.on("exit", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`Chrome exited early (${code}). stderr: ${stderrBuf.slice(-400)}`));
      }
    });

    proc.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });
  });
}

function createCdpClient(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let nextId = 1;
    const pending = new Map();
    const listeners = new Map();

    ws.addEventListener("open", () => {
      resolve({
        send(method, params = {}) {
          const id = nextId++;
          return new Promise((res, rej) => {
            pending.set(id, { res, rej, method });
            ws.send(JSON.stringify({ id, method, params }));
          });
        },
        on(event, fn) {
          if (!listeners.has(event)) listeners.set(event, new Set());
          listeners.get(event).add(fn);
        },
        off(event, fn) {
          if (listeners.has(event)) listeners.get(event).delete(fn);
        },
        close() {
          try { ws.close(); } catch {}
        },
      });
    });

    ws.addEventListener("message", (evt) => {
      const msg = JSON.parse(typeof evt.data === "string" ? evt.data : evt.data.toString());
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { res, rej, method } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) {
          rej(new Error(`CDP ${method} failed: ${msg.error.message}`));
        } else {
          res(msg.result);
        }
        return;
      }
      if (msg.method && listeners.has(msg.method)) {
        for (const fn of listeners.get(msg.method)) {
          fn(msg.params || {});
        }
      }
    });

    ws.addEventListener("error", (err) => {
      reject(new Error(`CDP WebSocket error: ${err.message || "connection failed"}`));
    });
  });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function buildTestCases(fullMode) {
  const files = fs.readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".json")).sort();
  const notchFixtures = files.filter((f) => !f.startsWith("backend-shape-") && !f.startsWith("workspace-"));
  const workspaceFixtures = files.filter((f) => f.startsWith("workspace-"));

  const selectedNotch = fullMode
    ? notchFixtures
    : notchFixtures.filter((f) => f === "working-live.json" || f === "empty.json");

  const cases = [];

  for (const file of selectedNotch) {
    const name = file.replace(/\.json$/, "");
    const data = readJson(path.join(FIXTURES_DIR, file));
    const runs = Array.isArray(data.runs) ? data.runs : [];
    const firstGoal = runs[0]?.goal ? String(runs[0].goal) : "";

    cases.push({
      label: `notch:${name}`,
      urlPath: `/index.html?fixture=${encodeURIComponent(name)}&state=expanded`,
      isLoadingFixture: false,
      check(text) {
        if (!text.includes("Sample data")) {
          return "missing 'Sample data' banner";
        }
        if (firstGoal && !text.includes(firstGoal)) {
          return `missing run title "${firstGoal}"`;
        }
        if (!runs.length && text.trim().length < 10) {
          return "empty body text for empty notch fixture";
        }
        return null;
      },
    });
  }

  for (const file of workspaceFixtures) {
    const name = file.replace(/\.json$/, "");
    const data = readJson(path.join(FIXTURES_DIR, file));
    const wsStatus = data.workspaceState?.status || "";
    const runs = Array.isArray(data.runs) ? data.runs : [];
    const firstGoal = runs[0]?.goal ? String(runs[0].goal) : "";

    const viewsToRun = fullMode
      ? WORKSPACE_VIEWS
      : (name === "workspace-demo" ? ["graph", "logs", "analytics", "onboarding"] : ["graph"]);

    for (const view of viewsToRun) {
      cases.push({
        label: `workspace:${name}:${view}`,
        urlPath: `/workspace.html?fixture=${encodeURIComponent(name)}&view=${encodeURIComponent(view)}`,
        isLoadingFixture: wsStatus === "loading",
        check(text) {
          if (wsStatus === "disconnected") {
            if (!text.includes("Not connected")) {
              return "missing 'Not connected' state line";
            }
            return null;
          }
          if (wsStatus === "loading") {
            if (!text.includes("Loading") && !text.includes("Sample data")) {
              return "missing 'Loading' or 'Sample data' state";
            }
            return null;
          }
          if (!text.includes("Sample data")) {
            return "missing 'Sample data' label";
          }
          if (wsStatus === "stale" && view !== "onboarding" && !text.includes("May be out of date")) {
            return "missing stale warning 'May be out of date'";
          }
          if (runs.length > 0 && (view === "graph" || view === "logs") && firstGoal && !text.includes(firstGoal)) {
            return `missing run title "${firstGoal}"`;
          }
          return null;
        },
      });
    }
  }

  cases.push({
    label: "demo:index",
    urlPath: "/demo/index.html",
    isLoadingFixture: false,
    check(text) {
      if (!text.includes("Sample data") && !text.includes("sample data")) {
        return "missing 'sample data' text on demo page";
      }
      if (text.trim().length < 40) {
        return "demo page body text unexpectedly short";
      }
      return null;
    },
  });

  return cases;
}

function findForbiddenRenderedTerms(text) {
  const hits = [];
  if (/\/api\//i.test(text)) {
    const m = text.match(/\/api\/[^\s,)]*/i);
    hits.push(`'/api/' (${m ? m[0] : "/api/"})`);
  }
  if (/\b[\w.-]+\.json\b/i.test(text)) {
    const m = text.match(/\b[\w.-]+\.json\b/i);
    hits.push(`'.json' file name (${m[0]})`);
  }
  if (/fixtures\//i.test(text)) {
    hits.push("'fixtures/'");
  }
  if (/\bCA_[A-Z0-9_]{2,}\b/.test(text)) {
    const m = text.match(/\bCA_[A-Z0-9_]{2,}\b/);
    hits.push(`env var (${m[0]})`);
  }
  return hits;
}

function isIgnoredError(text, url) {
  const combined = `${text || ""} ${url || ""}`.toLowerCase();
  return combined.includes("favicon.ico");
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function runPageCheck(cdp, baseUrl, testCase) {
  const errors = [];
  let loadFired = false;

  const onException = (params) => {
    const details = params.exceptionDetails || {};
    const msg = details.exception?.description || details.text || "Uncaught exception";
    if (!isIgnoredError(msg, details.url)) {
      errors.push(`exception: ${msg.split("\n")[0]}`);
    }
  };

  const onConsole = (params) => {
    if (params.type === "error") {
      const text = (params.args || [])
        .map((a) => a.value ?? a.description ?? "")
        .join(" ")
        .trim();
      if (!isIgnoredError(text, "")) {
        errors.push(`console.error: ${text || "unknown error"}`);
      }
    }
  };

  const onLog = (params) => {
    const entry = params.entry || {};
    if (entry.level === "error") {
      if (!isIgnoredError(entry.text, entry.url)) {
        errors.push(`browser error: ${entry.text || "unknown"} (${entry.url || ""})`);
      }
    }
  };

  const onLoad = () => {
    loadFired = true;
  };

  cdp.on("Runtime.exceptionThrown", onException);
  cdp.on("Runtime.consoleAPICalled", onConsole);
  cdp.on("Log.entryAdded", onLog);
  cdp.on("Page.loadEventFired", onLoad);

  try {
    const targetUrl = `${baseUrl}${testCase.urlPath}`;
    await cdp.send("Page.navigate", { url: targetUrl });

    let bodyText = "";
    let settled = false;
    const pageDeadline = Date.now() + PAGE_TIMEOUT_MS;
    while (Date.now() < pageDeadline) {
      const evalRes = await cdp.send("Runtime.evaluate", {
        expression: `(() => {
          if (window.location.href !== ${JSON.stringify(targetUrl)}) return "__NAVIGATING__";
          if (document.readyState !== "complete") return "__NOT_READY__";
          return document.body ? document.body.innerText : "";
        })()`,
        returnByValue: true,
      });
      const val = evalRes.result?.value;
      if (typeof val === "string" && val !== "__NAVIGATING__" && val !== "__NOT_READY__") {
        bodyText = val;
        const trimmed = val.trim();
        const stillLoadingOnly = /^(\u2026|\.\.\.)?\s*Loading$/i.test(trimmed);
        if (trimmed.length > 0 && (testCase.isLoadingFixture || !stillLoadingOnly)) {
          await sleep(120);
          const finalRes = await cdp.send("Runtime.evaluate", {
            expression: "document.body ? document.body.innerText : ''",
            returnByValue: true,
          });
          if (typeof finalRes.result?.value === "string") {
            bodyText = finalRes.result.value;
          }
          settled = true;
          break;
        }
      }
      await sleep(50);
    }

    if (!settled) {
      return { ok: false, reason: `page timeout after ${PAGE_TIMEOUT_MS}ms` };
    }

    if (errors.length > 0) {
      return { ok: false, reason: errors[0] };
    }

    const forbidden = findForbiddenRenderedTerms(bodyText);
    if (forbidden.length > 0) {
      return { ok: false, reason: `rendered internal term: ${forbidden.join(", ")}` };
    }

    const checkFail = testCase.check(bodyText);
    if (checkFail) {
      return { ok: false, reason: checkFail };
    }

    return { ok: true, reason: null };
  } finally {
    cdp.off("Runtime.exceptionThrown", onException);
    cdp.off("Runtime.consoleAPICalled", onConsole);
    cdp.off("Log.entryAdded", onLog);
    cdp.off("Page.loadEventFired", onLoad);
  }
}

async function main() {
  const chromePath = findChrome();
  if (!chromePath) {
    console.log("SKIP: Google Chrome is not installed");
    process.exit(0);
  }

  const { server, port } = await startStaticServer(UI_DIR);
  registerCleanup(() => {
    try { server.closeAllConnections?.(); } catch {}
    try { server.close(); } catch {}
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  const tmpProfile = fs.mkdtempSync(path.join(os.tmpdir(), "ui-smoke-chrome-"));
  registerCleanup(() => {
    fs.rmSync(tmpProfile, { recursive: true, force: true });
  });

  let cdp = null;

  try {
    const launched = await launchChrome(chromePath, tmpProfile);

    const targetRes = await fetch(`http://127.0.0.1:${launched.debugPort}/json/new?about:blank`, {
      method: "PUT",
    });
    if (!targetRes.ok) {
      throw new Error(`Failed to open CDP page target: HTTP ${targetRes.status}`);
    }
    const targetInfo = await targetRes.json();
    cdp = await createCdpClient(targetInfo.webSocketDebuggerUrl);
    registerCleanup(() => {
      try { cdp.close(); } catch {}
    });

    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable");

    const fullMode = process.argv.includes("--full");
    const cases = buildTestCases(fullMode);
    const totalStart = Date.now();
    let failCount = 0;
    let budgetExceeded = false;

    for (let i = 0; i < cases.length; i++) {
      const tc = cases[i];
      if (Date.now() - totalStart >= TOTAL_BUDGET_MS) {
        budgetExceeded = true;
        console.error(`FAIL budget: total budget ${TOTAL_BUDGET_MS / 1000}s exceeded before [${i + 1}/${cases.length}] ${tc.label}; stopping`);
        break;
      }
      const res = await runPageCheck(cdp, baseUrl, tc);
      if (res.ok) {
        console.log(`[${i + 1}/${cases.length}] PASS ${tc.label} (${tc.urlPath})`);
      } else {
        failCount++;
        console.log(`[${i + 1}/${cases.length}] FAIL ${tc.label} (${tc.urlPath}): ${res.reason}`);
      }
    }

    if (budgetExceeded || failCount > 0) {
      console.error(`CHECK FAIL (${failCount}/${cases.length} pages failed${budgetExceeded ? ", total budget exceeded" : ""})`);
      process.exitCode = 1;
    } else {
      console.log(`CHECK PASS (${cases.length} pages)`);
    }
  } finally {
    cleanupAll();
  }
}

main().catch((err) => {
  console.error(`CHECK FAIL: ${err.message}`);
  process.exit(1);
});
