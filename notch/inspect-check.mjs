#!/usr/bin/env node
/**
 * Starts AgentNotch with CA_INSPECT=1, optionally opens the panel (when --open,
 * CA_FIXTURE, or CA_URL is set), prints the panel bounds and page text, and quits cleanly.
 * Always terminates the spawned app even on error or timeout (< 20s total).
 *
 * Usage:
 *   node notch/inspect-check.mjs
 *   CA_FIXTURE=sample node notch/inspect-check.mjs
 *   CA_URL="http://127.0.0.1:8765/?t=TOKEN" node notch/inspect-check.mjs
 *   node notch/inspect-check.mjs --fixture sample --open
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const defaultBin = path.join(repoRoot, "notch/build/AgentNotch.app/Contents/MacOS/AgentNotch");
const binPath = process.env.NOTCH_BIN || defaultBin;

function parseArgs(argv) {
  let openPanel = false;
  let fixture = process.env.CA_FIXTURE || "";
  let url = process.env.CA_URL || "";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--open") {
      openPanel = true;
    } else if (arg === "--fixture" && argv[i + 1]) {
      fixture = argv[++i];
      openPanel = true;
    } else if (arg === "--url" && argv[i + 1]) {
      url = argv[++i];
      openPanel = true;
    }
  }
  if (fixture.trim() || url.trim()) {
    openPanel = true;
  }
  return { openPanel, fixture: fixture.trim(), url: url.trim() };
}

if (!fs.existsSync(binPath)) {
  console.error(`Missing binary: ${binPath}. Run: bash notch/package/package.sh`);
  process.exit(1);
}

const TIMEOUT_MS = 15_000;

async function main() {
  const opts = parseArgs(process.argv.slice(2));
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
  const send = (payload, timeoutMs = 4000) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out waiting for inspect response id=${id} (${payload.cmd})`));
      }, timeoutMs);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`);
    });
  };

  const hardTimer = setTimeout(() => {
    try { child.kill("SIGKILL"); } catch {}
  }, TIMEOUT_MS);
  hardTimer.unref();

  try {
    // Wait briefly for WKWebView to load initial page (and backend data if CA_URL is set).
    await new Promise((r) => setTimeout(r, opts.url ? 2200 : 1500));

    if (opts.openPanel) {
      const openRes = await send({ cmd: "open" });
      if (!openRes.ok) {
        throw new Error(`Failed to open panel: ${JSON.stringify(openRes)}`);
      }
      const stateRes = await send({
        cmd: "eval",
        target: "notch",
        js: "if (document.body.dataset.state !== 'expanded') { document.getElementById('pill-trigger')?.click(); } document.body.dataset.state;",
      });
      if (!stateRes.ok || stateRes.result !== "expanded") {
        throw new Error(`Failed to expand panel: ${JSON.stringify(stateRes)}`);
      }
      await new Promise((r) => setTimeout(r, 350));
    }

    const bounds = await send({ cmd: "bounds" });
    console.log("bounds:", JSON.stringify(bounds));
    if (!bounds.ok || !bounds.panel) {
      throw new Error(`Invalid bounds response: ${JSON.stringify(bounds)}`);
    }

    let textRes = await send({ cmd: "eval", target: "notch", js: "document.body.innerText" });
    if (textRes.ok && (!textRes.result || String(textRes.result).trim() === "")) {
      await new Promise((r) => setTimeout(r, 1000));
      textRes = await send({ cmd: "eval", target: "notch", js: "document.body.innerText" });
    }
    console.log("pageText:", JSON.stringify(textRes));
    if (!textRes.ok || !String(textRes.result || "").trim()) {
      throw new Error(`Notch page text empty or eval failed: ${JSON.stringify(textRes)}`);
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
