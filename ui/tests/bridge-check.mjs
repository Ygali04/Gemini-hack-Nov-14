#!/usr/bin/env node
/**
 * Static check that every message type posted to the WKWebView shell bridge
 * (window.webkit.messageHandlers.shell.postMessage({type: ...})) in
 * ui/index.html and ui/workspace/app.js is handled in notch/NotchApp.swift,
 * and every type handled in notch/NotchApp.swift is posted by the pages.
 *
 * Node built-ins only; no browser.
 * Exits 0 on CHECK PASS, 1 on CHECK FAIL.
 *
 * Shell -> page `filesDropped` item shape (kept in sync with notch/NotchApp.swift):
 *   - path: string (local or temp file path)
 *   - name: string (file or folder display name)
 *   - size: number (bytes; 0 for folders)
 *   - kind: "image" | "text" | "pdf" | "folder" | "other"
 *   - thumbnail?: string (data URL <= 128 px on longest side when kind === "image")
 *   - pageCount?: number (PDF page count when kind === "pdf")
 *   - textExtracted?: boolean (true when PDFKit extracted text for upload when kind === "pdf")
 *
 * Page -> shell `openSettingsPane` contract (kept in sync with notch/NotchApp.swift):
 *   Request:  { type: "openSettingsPane", id: string, pane: "accessibility" | "screenRecording" | "microphone" | "speechRecognition" | "automation" }
 *   Response: { type: "settingsPaneOpened", id: string, pane: string, ok: boolean, error: string }
 *   Shell maps each allowed pane name to its System Settings URL itself; unknown names return ok: false with an error and open nothing.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(__dirname, "../..");

const PAGE_FILES = ["ui/index.html", "ui/workspace/app.js"];
const SWIFT_FILE = "notch/NotchApp.swift";
// Shell-handled message types whose page caller is being wired concurrently;
// still required to be handled in NotchApp.swift.
const PENDING_PAGE_TYPES = new Set(["openSettingsPane"]);

function parseArgs(argv) {
  let root = process.env.BRIDGE_CHECK_ROOT || DEFAULT_ROOT;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root" && argv[i + 1]) {
      root = path.resolve(argv[++i]);
    }
  }
  return { root };
}

function lineAt(source, index) {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) {
    if (source.charCodeAt(i) === 10) line++;
  }
  return line;
}

function stripJsComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:\\])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(m.length - p1.length));
}

function extractPostedTypes(source, relPath) {
  const clean = stripJsComments(source);
  const posted = new Map();

  const record = (type, index) => {
    if (!posted.has(type)) {
      posted.set(type, { file: relPath, line: lineAt(clean, index) });
    }
  };

  // Direct postMessage({ type: "..." })
  const directRe = /window\.webkit\.messageHandlers\.shell\.postMessage\(\s*\{[^}]*\btype\s*:\s*["']([^"']+)["']/gs;
  for (const m of clean.matchAll(directRe)) {
    record(m[1], m.index);
  }

  // Helper calls: callShell("...") and Transport.post("...") / post("...")
  const helperRe = /\b(?:callShell|(?:Transport\.)?post)\(\s*["']([^"']+)["']/g;
  for (const m of clean.matchAll(helperRe)) {
    record(m[1], m.index);
  }

  return posted;
}

function extractSwiftBlock(source, markerRe) {
  const match = markerRe.exec(source);
  if (!match) return null;
  const openIdx = source.indexOf("{", match.index);
  if (openIdx === -1) return null;
  let depth = 0;
  for (let i = openIdx; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return { text: source.slice(openIdx, i + 1), startIndex: openIdx };
      }
    }
  }
  return null;
}

function extractSwiftHandledTypes(source) {
  const fnBlock = extractSwiftBlock(
    source,
    /func\s+userContentController\s*\([^)]*didReceive\s+message:\s*WKScriptMessage\s*\)/
  );
  if (!fnBlock) return null;

  const switchBlock = extractSwiftBlock(fnBlock.text, /\bswitch\s+type\b/);
  if (!switchBlock) return null;

  const handled = new Map();
  const caseRe = /\bcase\s+([^:]+):/g;
  for (const m of switchBlock.text.matchAll(caseRe)) {
    const header = m[1];
    for (const lit of header.matchAll(/"([^"]+)"/g)) {
      const type = lit[1];
      if (!handled.has(type)) {
        const absIdx = fnBlock.startIndex + switchBlock.startIndex + m.index;
        handled.set(type, { file: SWIFT_FILE, line: lineAt(source, absIdx) });
      }
    }
  }
  return handled;
}

function main() {
  const { root } = parseArgs(process.argv.slice(2));
  const findings = [];

  const postedAll = new Map();
  for (const relPath of PAGE_FILES) {
    const absPath = path.join(root, relPath);
    if (!fs.existsSync(absPath)) {
      findings.push(`${relPath}:1: missing-file: Target file not found: ${relPath}`);
      continue;
    }
    const content = fs.readFileSync(absPath, "utf8");
    const pageTypes = extractPostedTypes(content, relPath);
    for (const [type, loc] of pageTypes.entries()) {
      if (!postedAll.has(type)) postedAll.set(type, []);
      postedAll.get(type).push(loc);
    }
  }

  const swiftAbs = path.join(root, SWIFT_FILE);
  let handled = null;
  if (!fs.existsSync(swiftAbs)) {
    findings.push(`${SWIFT_FILE}:1: missing-file: Target file not found: ${SWIFT_FILE}`);
  } else {
    const swiftSrc = fs.readFileSync(swiftAbs, "utf8");
    handled = extractSwiftHandledTypes(swiftSrc);
    if (!handled) {
      findings.push(
        `${SWIFT_FILE}:1: missing-switch: Could not locate switch type in userContentController(_:didReceive:)`
      );
    }
  }

  if (handled) {
    for (const [type, locs] of postedAll.entries()) {
      if (!handled.has(type)) {
        for (const loc of locs) {
          findings.push(
            `${loc.file}:${loc.line}: unhandled-bridge-type: Page posts "${type}" but ${SWIFT_FILE} does not handle it`
          );
        }
      }
    }

    for (const [type, loc] of handled.entries()) {
      if (!postedAll.has(type) && !PENDING_PAGE_TYPES.has(type)) {
        findings.push(
          `${loc.file}:${loc.line}: unused-bridge-handler: ${SWIFT_FILE} handles "${type}" but neither page posts it`
        );
      }
    }

    for (const type of PENDING_PAGE_TYPES) {
      if (!handled.has(type)) {
        findings.push(
          `${SWIFT_FILE}:1: missing-bridge-handler: ${SWIFT_FILE} must handle "${type}"`
        );
      }
    }
  }

  for (const line of findings) {
    console.log(line);
  }

  if (findings.length === 0) {
    console.log(`CHECK PASS (${postedAll.size} bridge types matched)`);
    process.exit(0);
  } else {
    console.log(`CHECK FAIL (${findings.length} finding${findings.length === 1 ? "" : "s"})`);
    process.exit(1);
  }
}

main();
