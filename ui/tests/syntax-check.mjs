#!/usr/bin/env node
/**
 * Syntax-checks every .js/.mjs file under ui/ (excluding ui/vendor/) and every
 * inline <script> block in ui/index.html, ui/workspace.html, and ui/demo/index.html
 * using `node --check` (Node built-ins only).
 * Reports failures as `file:line: message` and exits non-zero on any error.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const UI_DIR = path.resolve(__dirname, "..");
const REPO_DIR = path.resolve(UI_DIR, "..");

const HTML_FILES = [
  "ui/index.html",
  "ui/workspace.html",
  "ui/demo/index.html",
];

function collectJsFiles(dir, out = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "vendor" || entry.name === "node_modules") {
        continue;
      }
      collectJsFiles(fullPath, out);
    } else if (entry.isFile() && (entry.name.endsWith(".js") || entry.name.endsWith(".mjs"))) {
      out.push(fullPath);
    }
  }
  return out;
}

function countNewlines(text) {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) count++;
  }
  return count;
}

function parseNodeCheckError(stderr, checkedPath) {
  const text = (stderr || "").trim();
  const lines = text.split(/\r?\n/);
  let lineNum = 1;

  for (const line of lines) {
    if (line.startsWith(checkedPath + ":")) {
      const m = line.slice(checkedPath.length + 1).match(/^(\d+)/);
      if (m) {
        lineNum = Number(m[1]);
        break;
      }
    }
  }

  const syntaxLine = lines.find((l) => /^(SyntaxError|Error):/.test(l.trim()));
  const message = syntaxLine ? syntaxLine.trim() : (lines[lines.length - 1] || "syntax error").trim();
  return { lineNum, message };
}

function runNodeCheck(filePath) {
  return spawnSync(process.execPath, ["--check", filePath], { encoding: "utf8" });
}

function isJsScriptType(attrs) {
  const srcMatch = attrs.match(/\bsrc\s*=/i);
  if (srcMatch) return { inline: false, isModule: false };

  const typeMatch = attrs.match(/\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
  if (!typeMatch) return { inline: true, isModule: false };

  const rawType = (typeMatch[1] || typeMatch[2] || typeMatch[3] || "").trim().toLowerCase();
  if (!rawType) return { inline: true, isModule: false };
  if (rawType === "module") return { inline: true, isModule: true };
  if (/^(text|application)\/(javascript|ecmascript|x-javascript)$/.test(rawType)) {
    return { inline: true, isModule: false };
  }
  return { inline: false, isModule: false };
}

function main() {
  const jsFiles = collectJsFiles(UI_DIR).sort();
  const failures = [];
  let inlineCount = 0;

  for (const fullPath of jsFiles) {
    const res = runNodeCheck(fullPath);
    if (res.status !== 0 || res.error) {
      const relPath = path.relative(REPO_DIR, fullPath).replace(/\\/g, "/");
      if (res.error) {
        failures.push({ location: `${relPath}:1`, message: res.error.message });
      } else {
        const { lineNum, message } = parseNodeCheckError(res.stderr, fullPath);
        failures.push({ location: `${relPath}:${lineNum}`, message });
      }
    }
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ui-syntax-check-"));
  try {
    let blockIdx = 0;
    for (const relHtml of HTML_FILES) {
      const fullHtml = path.join(REPO_DIR, relHtml);
      if (!fs.existsSync(fullHtml)) {
        failures.push({ location: `${relHtml}:1`, message: "Missing HTML file" });
        continue;
      }

      const html = fs.readFileSync(fullHtml, "utf8");
      const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
      let match;
      while ((match = scriptRe.exec(html)) !== null) {
        const attrs = match[1] || "";
        const code = match[2] || "";
        const { inline, isModule } = isJsScriptType(attrs);
        if (!inline) continue;

        inlineCount++;
        blockIdx++;

        const openTagEnd = match[0].indexOf(">") + 1;
        const innerOffset = match.index + openTagEnd;
        const startLine = 1 + countNewlines(html.slice(0, innerOffset));

        const ext = isModule ? ".mjs" : ".js";
        const tmpFile = path.join(tmpDir, `inline-${blockIdx}${ext}`);
        fs.writeFileSync(tmpFile, code, "utf8");

        const res = runNodeCheck(tmpFile);
        if (res.status !== 0 || res.error) {
          if (res.error) {
            failures.push({ location: `${relHtml}:${startLine}`, message: res.error.message });
          } else {
            const { lineNum, message } = parseNodeCheckError(res.stderr, tmpFile);
            const htmlLine = startLine + Math.max(0, lineNum - 1);
            failures.push({ location: `${relHtml}:${htmlLine}`, message });
          }
        }
      }
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    for (const f of failures) {
      console.error(`${f.location}: ${f.message}`);
    }
    console.error(`CHECK FAIL (${failures.length} syntax error${failures.length === 1 ? "" : "s"})`);
    process.exit(1);
  }

  console.log(`CHECK PASS (${jsFiles.length} JS/MJS files, ${inlineCount} inline scripts)`);
  process.exit(0);
}

main();
