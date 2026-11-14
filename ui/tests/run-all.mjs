#!/usr/bin/env node
/**
 * Runs adapter-check, workspace-check, copy-check, and a11y-check (warn-only).
 * Prints one summary line per check and a final PASS/FAIL line.
 * Exits 0 if all required checks pass, 1 otherwise.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CHECKS = [
  { name: "adapter-check", file: "adapter-check.mjs" },
  { name: "workspace-check", file: "workspace-check.mjs" },
  { name: "copy-check", file: "copy-check.mjs" },
  { name: "a11y-check", file: "a11y-check.mjs", warnOnly: true },
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
  } else if (check.warnOnly) {
    console.log(`WARN ${check.name} (exit ${res.status ?? 1}): ${summary}`);
  } else {
    failedCount++;
    console.log(`FAIL ${check.name} (exit ${res.status ?? 1}): ${summary}`);
  }
}

if (failedCount === 0) {
  console.log("PASS");
  process.exit(0);
} else {
  console.log(`FAIL (${failedCount}/${CHECKS.length} failed)`);
  process.exit(1);
}
