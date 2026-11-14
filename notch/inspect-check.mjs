#!/usr/bin/env node
/**
 * Starts AgentNotch with CA_INSPECT=1, queries `bounds` and collapsed notch
 * page text via JSON lines on stdin/stdout, prints them, and quits cleanly.
 * Always terminates the spawned app even on error or timeout (< 20s total).
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

if (!fs.existsSync(binPath)) {
  console.error(`Missing binary: ${binPath}. Run: bash notch/package/package.sh`);
  process.exit(1);
}

const TIMEOUT_MS = 12_000;

async function main() {
  const child = spawn(binPath, [], {
    cwd: repoRoot,
    env: { ...process.env, CA_INSPECT: "1" },
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

  const send = (id, payload, timeoutMs = 4000) =>
    new Promise((resolve, reject) => {
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

  const hardTimer = setTimeout(() => {
    try { child.kill("SIGKILL"); } catch {}
  }, TIMEOUT_MS);
  hardTimer.unref();

  try {
    // Wait briefly for WKWebView to load initial page, then query bounds + text.
    await new Promise((r) => setTimeout(r, 1500));

    const bounds = await send(0, { cmd: "bounds" });
    console.log("bounds:", JSON.stringify(bounds));
    if (!bounds.ok || !bounds.panel) {
      throw new Error(`Invalid bounds response: ${JSON.stringify(bounds)}`);
    }

    let textRes = await send(1, { cmd: "eval", target: "notch", js: "document.body.innerText" });
    if (textRes.ok && (!textRes.result || String(textRes.result).trim() === "")) {
      await new Promise((r) => setTimeout(r, 1000));
      textRes = await send(2, { cmd: "eval", target: "notch", js: "document.body.innerText" });
    }
    console.log("pageText:", JSON.stringify(textRes));
    if (!textRes.ok || !String(textRes.result || "").trim()) {
      throw new Error(`Notch page text empty or eval failed: ${JSON.stringify(textRes)}`);
    }

    const quitRes = await send(3, { cmd: "quit" }, 2000).catch(() => null);
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
