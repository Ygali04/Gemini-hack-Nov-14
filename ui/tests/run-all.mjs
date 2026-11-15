#!/usr/bin/env node
/**
 * Runs syntax-check, adapter-check, workspace-check, copy-check,
 * demo-check, bridge-check, and a11y-check.
 * a11y-check is evaluated per file: files already at 0 findings must stay at 0
 * (FAIL on regression), while files still being fixed are reported as WARN with count.
 * Prints summary lines per check and a final PASS/FAIL line.
 * Exits 0 if all required checks pass, 1 otherwise.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CHECKS = [
  { name: "syntax-check", file: "syntax-check.mjs" },
  { name: "adapter-check", file: "adapter-check.mjs" },
  { name: "workspace-check", file: "workspace-check.mjs" },
  { name: "copy-check", file: "copy-check.mjs" },
  { name: "demo-check", file: "demo-check.mjs" },
  { name: "bridge-check", file: "bridge-check.mjs" },
  { name: "cleanup-check", file: "cleanup-check.mjs" },
  { name: "replay-check", file: "replay-check.mjs" },
  { name: "screen-words-check", file: "screen-words-check.mjs" },
  { name: "static-bundle-check", file: "static-bundle-check.mjs" },
];

const A11Y_FILES = [
  { file: "ui/index.html", mustBeZero: false },
  { file: "ui/workspace.html", mustBeZero: true },
  { file: "ui/workspace/app.js", mustBeZero: true },
  { file: "ui/workspace/styles.css", mustBeZero: false },
  { file: "ui/demo/index.html", mustBeZero: true },
];

let failedCount = 0;

for (const check of CHECKS) {
  const scriptPath = path.join(__dirname, check.file);
  const res = spawnSync(process.execPath, [scriptPath, ...process.argv.slice(2)], {
    encoding: "utf8",
  });

  const ok = res.status === 0 && !res.error;
  const outputLines = `${res.stdout || ""}\n${res.stderr || ""}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const summary = outputLines[outputLines.length - 1] || (res.error ? res.error.message : `exit ${res.status}`);

  if (ok) {
    console.log(`PASS ${check.name}: ${summary}`);
  } else {
    failedCount++;
    console.log(`FAIL ${check.name} (exit ${res.status ?? 1}): ${summary}`);
  }
}

// Run a11y-check and evaluate per file
const a11yScript = path.join(__dirname, "a11y-check.mjs");
const a11yRes = spawnSync(process.execPath, [a11yScript, ...process.argv.slice(2)], {
  encoding: "utf8",
});
const a11yLines = `${a11yRes.stdout || ""}\n${a11yRes.stderr || ""}`
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean);

const countsByFile = new Map();
let totalParsedFindings = 0;
for (const line of a11yLines) {
  const m = line.match(/^([^:\s]+):(\d+):\s+[^:]+:/);
  if (m) {
    const file = m[1];
    countsByFile.set(file, (countsByFile.get(file) || 0) + 1);
    totalParsedFindings++;
  }
}

const knownFiles = new Set(A11Y_FILES.map((entry) => entry.file));
let a11yFailed = false;

if (a11yRes.error || (a11yRes.status !== 0 && totalParsedFindings === 0)) {
  a11yFailed = true;
  console.log(`FAIL a11y-check (exit ${a11yRes.status ?? 1}): ${a11yRes.error ? a11yRes.error.message : a11yLines[a11yLines.length - 1] || "failed"}`);
} else {
  for (const { file, mustBeZero } of A11Y_FILES) {
    const count = countsByFile.get(file) || 0;
    const label = `${count} finding${count === 1 ? "" : "s"}`;
    if (count === 0) {
      console.log(`PASS a11y-check (${file}): ${label}`);
    } else if (mustBeZero) {
      a11yFailed = true;
      console.log(`FAIL a11y-check (${file}): ${label}`);
    } else {
      console.log(`WARN a11y-check (${file}): ${label}`);
    }
  }

  for (const [file, count] of countsByFile.entries()) {
    if (!knownFiles.has(file)) {
      a11yFailed = true;
      console.log(`FAIL a11y-check (${file}): ${count} finding${count === 1 ? "" : "s"}`);
    }
  }
}

if (a11yFailed) {
  failedCount++;
}

const totalChecks = CHECKS.length + 1;
if (failedCount === 0) {
  console.log("PASS");
  process.exit(0);
} else {
  console.log(`FAIL (${failedCount}/${totalChecks} failed)`);
  process.exit(1);
}
