#!/usr/bin/env node
/**
 * GET-only live backend recorder for ComputerAnything.
 * Polls a running local backend on 127.0.0.1 every 500ms and appends JSONL
 * snapshots to --out (which must be outside the repository).
 *
 * Usage:
 *   CA_URL="http://127.0.0.1:8765/?t=..." node ui/tests/record-live.mjs --out /tmp/ca-run.jsonl [--max-seconds 180]
 *
 * Safety:
 *   - 127.0.0.1 only.
 *   - GET requests only (never POST).
 *   - Injects X-CA-Token from CA_URL; never logs or writes the token.
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installCleanupHandlers } from "./process-cleanup.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_DIR = path.resolve(__dirname, "..", "..");

const POLL_INTERVAL_MS = 500;
const DEFAULT_MAX_SECONDS = 180;
const FINISHED_STATES = new Set(["done", "failed"]);

function printUsage() {
  console.log(
    "Usage: CA_URL=http://127.0.0.1:8765/?t=... node ui/tests/record-live.mjs --out /path/outside/repo.jsonl [--max-seconds 180]"
  );
}

function parseArgs(argv) {
  let outPath = "";
  let maxSeconds = DEFAULT_MAX_SECONDS;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--out" && argv[i + 1]) {
      outPath = argv[++i];
    } else if (arg.startsWith("--out=")) {
      outPath = arg.slice("--out=".length);
    } else if (arg === "--max-seconds" && argv[i + 1]) {
      maxSeconds = Number(argv[++i]);
    } else if (arg.startsWith("--max-seconds=")) {
      maxSeconds = Number(arg.slice("--max-seconds=".length));
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!outPath) {
    throw new Error("--out <path> is required");
  }
  const resolvedOut = path.resolve(outPath);
  if (resolvedOut === REPO_DIR || resolvedOut.startsWith(REPO_DIR + path.sep)) {
    throw new Error(`--out must be outside the repository (${REPO_DIR}); got ${resolvedOut}`);
  }
  if (!Number.isFinite(maxSeconds) || maxSeconds <= 0) {
    throw new Error(`Invalid --max-seconds value: ${maxSeconds}`);
  }

  return { outPath: resolvedOut, maxSeconds };
}

function parseCaUrl() {
  const raw = process.env.CA_URL;
  if (!raw) {
    throw new Error("CA_URL environment variable is required (e.g. http://127.0.0.1:8765/?t=...)");
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("CA_URL is not a valid URL");
  }
  if (parsed.protocol !== "http:") {
    throw new Error(`Unsupported CA_URL protocol: ${parsed.protocol} (expected http:)`);
  }
  if (parsed.hostname !== "127.0.0.1") {
    throw new Error(`Refusing host "${parsed.hostname}"; only 127.0.0.1 is allowed`);
  }
  const token = parsed.searchParams.get("t") || "";
  if (!token) {
    throw new Error("CA_URL is missing the ?t= token parameter");
  }
  return {
    hostname: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 80,
    token,
  };
}

function getJson(backend, reqPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: backend.hostname,
        port: backend.port,
        method: "GET",
        path: reqPath,
        headers: {
          "X-CA-Token": backend.token,
          Accept: "application/json",
        },
        timeout: 4000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if ((res.statusCode || 500) < 200 || (res.statusCode || 500) >= 300) {
            reject(new Error(`GET ${reqPath} returned HTTP ${res.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(text));
          } catch (err) {
            reject(new Error(`GET ${reqPath} returned invalid JSON: ${err.message}`));
          }
        });
      }
    );
    req.on("timeout", () => {
      req.destroy(new Error(`GET ${reqPath} timed out`));
    });
    req.on("error", (err) => {
      reject(new Error(`GET ${reqPath} failed: ${err.code || err.message}`));
    });
    req.end();
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  installCleanupHandlers();
  const options = parseArgs(process.argv.slice(2));
  const backend = parseCaUrl();

  fs.mkdirSync(path.dirname(options.outPath), { recursive: true });
  fs.writeFileSync(options.outPath, "", "utf8");

  const startMs = Date.now();
  const deadlineMs = startMs + options.maxSeconds * 1000;
  const sinceByRunId = new Map();
  const finishedSynced = new Set();
  let snapshotCount = 0;

  console.log(`Recording from http://${backend.hostname}:${backend.port} -> ${options.outPath} (max ${options.maxSeconds}s)`);

  while (Date.now() < deadlineMs) {
    const pollStartMs = Date.now();
    const tSec = pollStartMs / 1000;
    const ts = new Date(pollStartMs).toISOString();

    const [runs, help, agents, notifications] = await Promise.all([
      getJson(backend, "/api/runs"),
      getJson(backend, "/api/help"),
      getJson(backend, "/api/agents"),
      getJson(backend, "/api/notifications"),
    ]);

    const runsList = Array.isArray(runs) ? runs : [];
    const runDeltas = {};

    const toFetch = runsList.filter((r) => {
      if (!r || !r.id) return false;
      if (!FINISHED_STATES.has(r.state)) return true;
      if (!finishedSynced.has(r.id)) return true;
      const seen = sinceByRunId.get(r.id) || 0;
      return typeof r.n_events === "number" && r.n_events > seen;
    });

    await Promise.all(
      toFetch.map(async (r) => {
        const since = sinceByRunId.get(r.id) || 0;
        const detail = await getJson(backend, `/api/runs/${encodeURIComponent(r.id)}?since=${since}`);
        runDeltas[r.id] = { since, ...detail };
        const evCount = Array.isArray(detail?.events) ? detail.events.length : 0;
        const nextSince = typeof detail?.n_events === "number" ? detail.n_events : since + evCount;
        sinceByRunId.set(r.id, nextSince);
        if (FINISHED_STATES.has(detail?.state || r.state)) {
          finishedSynced.add(r.id);
        }
      })
    );

    const snapshot = {
      ts,
      t: tSec,
      runs: runsList,
      help: Array.isArray(help) ? help : [],
      agents: agents && typeof agents === "object" ? agents : {},
      notifications: Array.isArray(notifications) ? notifications : [],
      run_deltas: runDeltas,
    };

    fs.appendFileSync(options.outPath, JSON.stringify(snapshot) + "\n", "utf8");
    snapshotCount++;

    const allFinished =
      runsList.length > 0 &&
      runsList.every((r) => FINISHED_STATES.has(r.state) && finishedSynced.has(r.id));
    if (allFinished) {
      console.log(`All ${runsList.length} run(s) finished; wrote ${snapshotCount} snapshots to ${options.outPath}`);
      return;
    }

    const elapsedPollMs = Date.now() - pollStartMs;
    const waitMs = Math.max(0, POLL_INTERVAL_MS - elapsedPollMs);
    if (waitMs > 0 && Date.now() + waitMs < deadlineMs) {
      await sleep(waitMs);
    }
  }

  console.log(`Reached max-seconds (${options.maxSeconds}s); wrote ${snapshotCount} snapshots to ${options.outPath}`);
}

main().catch((err) => {
  console.error(`record-live error: ${err.message}`);
  process.exit(1);
});
