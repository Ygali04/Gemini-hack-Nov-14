#!/usr/bin/env node
/**
 * Starts AgentNotch with CA_INSPECT=1, optionally opens the panel (when --open,
 * --scenario, CA_FIXTURE, or CA_URL is set), prints bounds and page text, and quits cleanly.
 * Always terminates only the spawned app even on error or timeout (< 30s total).
 *
 * Usage:
 *   node notch/inspect-check.mjs
 *   CA_FIXTURE=working-live node notch/inspect-check.mjs
 *   CA_URL="http://127.0.0.1:8765/?t=TOKEN" node notch/inspect-check.mjs
 *   node notch/inspect-check.mjs --fixture working-live --open
 *   node notch/inspect-check.mjs --scenario --fixture working-live --view graph file1.txt file2.png
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const defaultBin = path.join(repoRoot, "notch/build/AgentNotch.app/Contents/MacOS/AgentNotch");
const binPath = process.env.NOTCH_BIN || defaultBin;

function parseArgs(argv) {
  let openPanel = false;
  let scenario = false;
  let fixture = process.env.CA_FIXTURE || "";
  let url = process.env.CA_URL || "";
  let view = "graph";
  let captureDir = "";
  const dropFiles = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--open") {
      openPanel = true;
    } else if (arg === "--scenario") {
      scenario = true;
      openPanel = true;
    } else if (arg === "--fixture" && argv[i + 1]) {
      fixture = argv[++i];
      openPanel = true;
    } else if (arg === "--url" && argv[i + 1]) {
      url = argv[++i];
      openPanel = true;
    } else if (arg === "--view" && argv[i + 1]) {
      view = argv[++i];
    } else if (arg === "--capture-dir" && argv[i + 1]) {
      captureDir = argv[++i];
    } else if (arg === "--drop" && argv[i + 1]) {
      dropFiles.push(path.resolve(argv[++i]));
    } else if (!arg.startsWith("-")) {
      dropFiles.push(path.resolve(arg));
    }
  }

  if (fixture.trim() || url.trim()) {
    openPanel = true;
  }

  return {
    openPanel,
    scenario,
    fixture: fixture.trim(),
    url: url.trim(),
    view: view.trim() || "graph",
    captureDir: captureDir.trim(),
    dropFiles,
  };
}

if (!fs.existsSync(binPath)) {
  console.error(`Missing binary: ${binPath}. Run: bash notch/package/package.sh`);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pollUntil(fn, timeoutMs, intervalMs = 120, label = "condition") {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const val = await fn();
      if (val) return val;
    } catch (err) {
      lastErr = err;
    }
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label}${lastErr ? `: ${lastErr.message}` : ""}`);
}

function assertValidPng(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Capture file missing: ${filePath}`);
  }
  const stat = fs.statSync(filePath);
  if (stat.size < 16) {
    throw new Error(`Capture file too small (${stat.size} bytes): ${filePath}`);
  }
  const head = fs.readFileSync(filePath).subarray(0, 8);
  const pngSig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!head.equals(pngSig)) {
    throw new Error(`Capture file is not a valid PNG: ${filePath}`);
  }
  return stat.size;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const timeoutMs = opts.scenario ? 25_000 : 15_000;
  const env = { ...process.env, CA_INSPECT: "1" };
  if (opts.fixture) env.CA_FIXTURE = opts.fixture;
  if (opts.url) env.CA_URL = opts.url;

  const child = spawn(binPath, [], {
    cwd: repoRoot,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const pending = new Map();
  let stderrBuf = "";
  child.stderr.on("data", (chunk) => {
    stderrBuf += chunk.toString("utf8");
  });

  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on("line", (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const resolver = pending.get(msg.id);
    if (resolver) {
      pending.delete(msg.id);
      resolver(msg);
    }
  });

  let nextId = 0;
  const send = (payload, cmdTimeoutMs = 5000) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out waiting for inspect response id=${id} (${payload.cmd})`));
      }, cmdTimeoutMs);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`);
    });
  };

  const hardTimer = setTimeout(() => {
    try { child.kill("SIGKILL"); } catch {}
  }, timeoutMs);
  hardTimer.unref();

  try {
    // Wait until WKWebView has loaded ui/index.html (not about:blank) and initialized body.dataset.state.
    await pollUntil(async () => {
      const res = await send({
        cmd: "eval",
        target: "notch",
        js: "({ ready: document.readyState, href: location.href, state: document.body?.dataset?.state || null, hasTrigger: Boolean(document.getElementById('pill-trigger')), textLen: (document.body?.innerText || '').trim().length })",
      }, 2000);
      if (!res.ok || !res.result || typeof res.result !== "object") return false;
      const r = res.result;
      if (r.ready !== "complete" || !r.hasTrigger || !r.state || String(r.href).startsWith("about:")) {
        return false;
      }
      if ((opts.fixture || opts.url) && r.textLen === 0) {
        return false;
      }
      return r;
    }, opts.url ? 8000 : 6000, 120, "notch webview ready");

    if (opts.openPanel) {
      const openRes = await send({ cmd: "open" });
      if (!openRes.ok) {
        throw new Error(`Failed to open panel: ${JSON.stringify(openRes)}`);
      }
      await pollUntil(async () => {
        const stateRes = await send({
          cmd: "eval",
          target: "notch",
          js: "if (document.body?.dataset?.state !== 'expanded') { document.getElementById('pill-trigger')?.click(); } document.body?.dataset?.state || null;",
        }, 2000);
        return stateRes.ok && stateRes.result === "expanded" ? stateRes : false;
      }, 4000, 100, "panel expanded");
      await sleep(300);
    }

    const bounds = await send({ cmd: "bounds" });
    console.log("bounds:", JSON.stringify(bounds));
    if (!bounds.ok || !bounds.panel) {
      throw new Error(`Invalid bounds response: ${JSON.stringify(bounds)}`);
    }

    if (opts.scenario) {
      const capDir = opts.captureDir || path.join(os.tmpdir(), `agentnotch-inspect-${process.pid}`);
      fs.mkdirSync(capDir, { recursive: true });

      if (opts.dropFiles.length > 0) {
        const dropRes = await send({ cmd: "drop", target: "notch", paths: opts.dropFiles });
        console.log("drop:", JSON.stringify(dropRes));
        if (!dropRes.ok) {
          throw new Error(`Drop failed: ${JSON.stringify(dropRes)}`);
        }
        await sleep(400);
      }

      const panelTextRes = await send({ cmd: "eval", target: "notch", js: "document.body.innerText" });
      console.log("pageText:", JSON.stringify(panelTextRes));
      if (!panelTextRes.ok || !String(panelTextRes.result || "").trim()) {
        throw new Error(`Notch page text empty or eval failed: ${JSON.stringify(panelTextRes)}`);
      }

      const panelPng = path.join(capDir, "panel.png");
      const capPanelRes = await send({ cmd: "capture", surface: "panel", path: panelPng });
      if (!capPanelRes.ok) {
        throw new Error(`Panel capture failed: ${JSON.stringify(capPanelRes)}`);
      }
      const panelBytes = assertValidPng(panelPng);
      console.log("panelCapture:", JSON.stringify({ ...capPanelRes, bytes: panelBytes }));

      const wsOpenPayload = {
        cmd: "openWorkspace",
        mode: "sheet",
        view: opts.view,
        instant: true,
      };
      if (opts.fixture) wsOpenPayload.fixture = opts.fixture;
      const wsOpenRes = await send(wsOpenPayload);
      if (!wsOpenRes.ok) {
        throw new Error(`Failed to open workspace sheet: ${JSON.stringify(wsOpenRes)}`);
      }

      await pollUntil(async () => {
        const wsReady = await send({
          cmd: "eval",
          target: "workspace",
          js: "({ ready: document.readyState, href: location.href, textLen: (document.body?.innerText || '').trim().length })",
        }, 2000);
        if (!wsReady.ok || !wsReady.result || typeof wsReady.result !== "object") return false;
        const r = wsReady.result;
        return r.ready === "complete" && !String(r.href).startsWith("about:") && r.textLen > 0 ? r : false;
      }, 6000, 120, "workspace sheet ready");
      await sleep(300);

      const wsTextRes = await send({ cmd: "eval", target: "workspace", js: "document.body.innerText" });
      console.log("workspaceText:", JSON.stringify(wsTextRes));
      if (!wsTextRes.ok || !String(wsTextRes.result || "").trim()) {
        throw new Error(`Workspace text empty or eval failed: ${JSON.stringify(wsTextRes)}`);
      }

      const wsPng = path.join(capDir, "workspace-sheet.png");
      const capWsRes = await send({ cmd: "capture", surface: "workspace", path: wsPng });
      if (!capWsRes.ok) {
        throw new Error(`Workspace capture failed: ${JSON.stringify(capWsRes)}`);
      }
      const wsBytes = assertValidPng(wsPng);
      console.log("workspaceCapture:", JSON.stringify({ ...capWsRes, bytes: wsBytes }));
    } else {
      let textRes = await send({ cmd: "eval", target: "notch", js: "document.body.innerText" });
      if (textRes.ok && (!textRes.result || String(textRes.result).trim() === "")) {
        await sleep(800);
        textRes = await send({ cmd: "eval", target: "notch", js: "document.body.innerText" });
      }
      console.log("pageText:", JSON.stringify(textRes));
      if (!textRes.ok || !String(textRes.result || "").trim()) {
        throw new Error(`Notch page text empty or eval failed: ${JSON.stringify(textRes)}`);
      }
    }

    const quitRes = await send({ cmd: "quit" }, 2000).catch(() => null);
    if (quitRes) console.log("quit:", JSON.stringify(quitRes));
  } finally {
    clearTimeout(hardTimer);
    rl.close();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => {
        const t = setTimeout(() => {
          try { child.kill("SIGKILL"); } catch {}
          resolve();
        }, 1500);
        child.once("exit", () => {
          clearTimeout(t);
          resolve();
        });
      });
    }
    if (stderrBuf.trim()) {
      console.error("stderr:", stderrBuf.trim());
    }
  }
}

main().catch((err) => {
  console.error("FAIL:", err.message || err);
  process.exit(1);
});
