#!/usr/bin/env node
/**
 * Verifies process-cleanup.mjs kills managed child processes when the parent
 * Node process receives SIGTERM.
 * Spawns a separate Node process that starts `sleep 300` via spawnManaged,
 * sends SIGTERM to that Node process, and asserts the child is gone within 2s.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HELPER_URL = pathToFileURL(path.join(__dirname, "process-cleanup.mjs")).href;

const MAX_WAIT_CHILD_EXIT_MS = 2000;
const SPAWN_READY_TIMEOUT_MS = 5000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code !== "ESRCH";
  }
}

async function main() {
  const childScript = [
    `import { spawnManaged } from ${JSON.stringify(HELPER_URL)};`,
    `const child = spawnManaged("sleep", ["300"], { stdio: "ignore" });`,
    `process.stdout.write("CHILD_PID=" + child.pid + "\\n");`,
    `setInterval(() => {}, 1000);`,
  ].join("\n");

  const nodeProc = spawn(process.execPath, ["--input-type=module", "-e", childScript], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  let childPid = null;

  nodeProc.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  nodeProc.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  try {
    const startReady = Date.now();
    while (Date.now() - startReady < SPAWN_READY_TIMEOUT_MS) {
      const m = stdout.match(/CHILD_PID=(\d+)/);
      if (m) {
        childPid = Number(m[1]);
        break;
      }
      if (nodeProc.exitCode !== null) {
        throw new Error(`Parent node exited early (${nodeProc.exitCode}): ${stderr}`);
      }
      await sleep(25);
    }

    assert.ok(Number.isInteger(childPid) && childPid > 0, `Did not receive CHILD_PID. stdout=${stdout} stderr=${stderr}`);
    assert.ok(isPidAlive(childPid), `Expected sleep child pid ${childPid} to be alive before SIGTERM`);

    const sigStart = Date.now();
    nodeProc.kill("SIGTERM");

    let goneAtMs = null;
    while (Date.now() - sigStart <= MAX_WAIT_CHILD_EXIT_MS) {
      if (!isPidAlive(childPid)) {
        goneAtMs = Date.now() - sigStart;
        break;
      }
      await sleep(50);
    }

    assert.notEqual(
      goneAtMs,
      null,
      `Child pid ${childPid} was still alive ${MAX_WAIT_CHILD_EXIT_MS}ms after parent SIGTERM`
    );

    console.log(`CHECK PASS (child pid ${childPid} terminated in ${goneAtMs}ms on parent SIGTERM)`);
  } finally {
    if (childPid && isPidAlive(childPid)) {
      try { process.kill(childPid, "SIGKILL"); } catch {}
    }
    if (nodeProc.exitCode === null) {
      try { nodeProc.kill("SIGKILL"); } catch {}
    }
  }
}

main().catch((err) => {
  console.error(`CHECK FAIL: ${err.message}`);
  process.exit(1);
});
