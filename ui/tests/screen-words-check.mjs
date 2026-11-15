#!/usr/bin/env node
/**
 * Screen-words check (Node-only, no browser).
 *
 * Reads user-visible text (HTML markup text, accessible attributes, and
 * screen-reaching JS string literals) across:
 *   - ui/index.html
 *   - ui/workspace.html
 *   - ui/workspace/app.js
 *   - ui/demo/index.html
 *
 * Fails on:
 *   - internal tokens such as `[click:button:2]`, `open_app`, `P=0.`
 *   - accessibility role names (`statictext`, `AXButton`, `AXTextField`, ...)
 *   - API paths (`/api/`) reaching visible text
 *   - environment variable names (`CA_...`)
 *   - forbidden words `"backend"`, `"endpoint"`, `"fixture"`, `"mock"`
 *   - standing `"× Failed"` / `"✕ Failed"` / `"Failed"` state labels
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const UI_ROOT = path.resolve(__dirname, "..");

const DEFAULT_TARGETS = [
  "index.html",
  "workspace.html",
  "workspace/app.js",
  "demo/index.html",
];

/**
 * Explicit allow-list for true exceptions, each with a documented reason.
 */
export const ALLOW_LIST = [
  {
    file: "index.html",
    pattern: /^(?:open_app|click_element|type_text|key_press|press_key|take_screenshot)$/,
    contextRe: /ACTION_LABELS|STEP_VERB|humanize|translate|RAW_TOKEN/i,
    reason: "Translator map key converting raw tool names into plain English verbs.",
  },
  {
    file: "index.html",
    pattern: /^fixture:\s*$/,
    contextRe: /getProbeConnectionKey|fixtureParam\s*\?\s*`fixture:/,
    reason: "Internal connection-probe cache key (never rendered to the DOM).",
  },
  {
    file: "workspace/app.js",
    pattern: /^(?:open_app|click_element|type_text|key_press|press_key|take_screenshot)$/,
    contextRe: /ACTION_LABELS|STEP_VERB|humanize|translate|RAW_TOKEN/i,
    reason: "Translator map key converting raw tool names into plain English verbs.",
  },
  {
    file: "workspace/app.js",
    pattern: /^(?:load-fixture|connect-backend)$/,
    contextRe: /data-action|action|dataset|case\s+["']/,
    reason: "Internal data-action attribute identifier for click delegation, not visible copy.",
  },
];

const RULES = [
  {
    id: "internal-bracket-token",
    description: "Internal bracket action token (e.g. [click:button:2])",
    re: /\[(?:click|type|key|press|scroll|wait|open|tap|move|drag):[^\]]+\]/i,
  },
  {
    id: "internal-tool-token",
    description: "Internal tool identifier (e.g. open_app)",
    re: /\b(?:open_app|click_element|type_text|press_key|key_press|mouse_move)\b/,
  },
  {
    id: "internal-prob-token",
    description: "Internal probability token (P=0.x)",
    re: /\bP=0\.\d+/,
  },
  {
    id: "role-name",
    description: "Accessibility role token (statictext, AXButton, ...)",
    re: /\b(?:statictext|AXButton|AXTextField|AXWindow|AXGroup|AXStaticText|AXScrollArea|AXWebArea|AXCheckBox|AXRadioButton|AXPopUpButton|AXMenuButton|AXMenuItem|AXToolbar|AXTable|AXRow|AXCell|AXLink|AXImage|AXSheet|AXDialog)\b/,
  },
  {
    id: "api-path",
    description: "Raw API path (/api/)",
    re: /\/api\//,
  },
  {
    id: "env-name",
    description: "Environment variable name (CA_...)",
    re: /\bCA_[A-Z0-9_]{2,}\b/,
  },
  {
    id: "word-backend",
    description: 'Forbidden technical word "backend"',
    re: /\bbackend\b/i,
  },
  {
    id: "word-endpoint",
    description: 'Forbidden technical word "endpoint"',
    re: /\bendpoint\b/i,
  },
  {
    id: "word-fixture",
    description: 'Forbidden technical word "fixture"',
    re: /\bfixture\b/i,
  },
  {
    id: "word-mock",
    description: 'Forbidden technical word "mock"',
    re: /\bmock\b/i,
  },
  {
    id: "standing-failed-label",
    description: 'Standing "× Failed" / "Failed" state label',
    re: /(?:[×✕✗]\s*Failed\b|^\s*Failed\s*$)/,
  },
];

function lineAtOffset(source, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source.charCodeAt(i) === 10) line++;
  }
  return line;
}

function getLineText(sourceLines, lineNumber) {
  return sourceLines[lineNumber - 1] || "";
}

function isAllowed(relFile, text, lineText) {
  for (const entry of ALLOW_LIST) {
    if (entry.file !== relFile) continue;
    if (!entry.pattern.test(text)) continue;
    if (entry.contextRe && !entry.contextRe.test(lineText)) continue;
    return true;
  }
  return false;
}

/**
 * Determines whether a JS string literal on a given source line is an internal
 * non-screen literal (e.g. URL/fetch path, query param key, DOM selector, CSS
 * class list, storage key) rather than text that can reach the screen.
 */
function isNonScreenJsLiteral(text, lineText) {
  const trimmed = text.trim();
  if (!trimmed) return true;

  // Pure URLs, relative file paths, or query parameter fragments
  if (
    /^(?:\.\.?\/|https?:\/\/|ws:\/\/|wss:\/\/|data:|blob:|#)/.test(trimmed) ||
    /^[a-z0-9_.-]+\.html(?:\?.*)?$/i.test(trimmed) ||
    /^\?[a-z0-9_=&%-]+$/i.test(trimmed) ||
    /^(?:\?|&)?[a-z0-9_-]+=$/i.test(trimmed)
  ) {
    return true;
  }

  // Bare API route path arguments in transport/fetch calls (not prose or HTML)
  if (
    /^\/api\/[a-z0-9_/?&=\s-]*$/i.test(trimmed) &&
    !/\b(?:textContent|innerText|innerHTML|insertAdjacentHTML)\b/.test(lineText)
  ) {
    return true;
  }

  // URLSearchParams.get("fixture") / dataset / getAttribute / setAttribute / querySelector
  if (
    /\b(?:params\.get|searchParams\.get|getAttribute|setAttribute|removeAttribute|hasAttribute|querySelector|querySelectorAll|closest|matches|classList|addEventListener|removeEventListener|dispatchEvent|CustomEvent|createElement|createElementNS)\s*\(/.test(
      lineText
    ) &&
    !/\b(?:textContent|innerText|innerHTML|insertAdjacentHTML|setAttribute\s*\(\s*["'](?:aria-label|title|placeholder|alt)["'])\b/.test(
      lineText
    )
  ) {
    return true;
  }

  // Internal state enum comparisons or assignments (e.g. state === "failed", case "failed":)
  if (
    /^[a-z_]+$/.test(trimmed) &&
    (/===?\s*["']|!==?\s*["']|\bcase\s+["']|\bstate\s*:\s*["']|\bstate\s*=\s*["']|\bkind\s*===?\s*["']|\bmode\s*===?\s*["']/.test(
      lineText
    ) ||
      /\.\s*(?:includes|indexOf|has|get|set|delete)\s*\(\s*["']/.test(lineText))
  ) {
    return true;
  }

  return false;
}

/**
 * Strip JS comments while preserving newlines and character offsets.
 */
function stripJsCommentsPreserveOffsets(code) {
  const chars = Array.from(code);
  let i = 0;
  const len = chars.length;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;

  while (i < len) {
    const ch = chars[i];
    const next = chars[i + 1];

    if (inSingle) {
      if (ch === "\\" && i + 1 < len) {
        i += 2;
        continue;
      }
      if (ch === "'") inSingle = false;
      i++;
      continue;
    }

    if (inDouble) {
      if (ch === "\\" && i + 1 < len) {
        i += 2;
        continue;
      }
      if (ch === '"') inDouble = false;
      i++;
      continue;
    }

    if (inTemplate) {
      if (ch === "\\" && i + 1 < len) {
        i += 2;
        continue;
      }
      if (ch === "`") inTemplate = false;
      i++;
      continue;
    }

    if (ch === "/" && next === "/") {
      while (i < len && chars[i] !== "\n") {
        chars[i] = " ";
        i++;
      }
      continue;
    }

    if (ch === "/" && next === "*") {
      chars[i] = " ";
      chars[i + 1] = " ";
      i += 2;
      while (i < len && !(chars[i] === "*" && chars[i + 1] === "/")) {
        if (chars[i] !== "\n") chars[i] = " ";
        i++;
      }
      if (i < len) {
        chars[i] = " ";
        if (i + 1 < len) chars[i + 1] = " ";
        i += 2;
      }
      continue;
    }

    if (ch === "'") inSingle = true;
    else if (ch === '"') inDouble = true;
    else if (ch === "`") inTemplate = true;
    i++;
  }

  return chars.join("");
}

/**
 * Extract HTML text nodes inside a template literal chunk, or return the plain chunk
 * if it does not contain HTML tags.
 */
function extractScreenSegmentsFromChunk(rawChunk) {
  if (!rawChunk || !rawChunk.trim()) return [];
  const segments = [];

  if (/<[a-zA-Z!/]/.test(rawChunk)) {
    // Extract visible text between tags
    const strippedTags = rawChunk
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ");
    const textParts = strippedTags.split(/<[^>]*>/g);
    for (const part of textParts) {
      const clean = part.replace(/\s+/g, " ").trim();
      if (clean) segments.push(clean);
    }
    // Also extract accessible attributes inside template markup
    const attrRe = /\b(?:aria-label|title|placeholder|alt)\s*=\s*["']([^"']+)["']/gi;
    let m;
    while ((m = attrRe.exec(rawChunk)) !== null) {
      const val = m[1].trim();
      if (val) segments.push(val);
    }
  } else {
    segments.push(rawChunk);
  }

  return segments;
}

function scanJsRegion(jsCode, baseOffset, fullSource, sourceLines, relFile, findings) {
  const cleanCode = stripJsCommentsPreserveOffsets(jsCode);
  const literalRe = /(["'])(?:\\.|(?!\1)[^\\\r\n])*\1|`(?:\\.|[^\\`])*`/g;
  let match;

  while ((match = literalRe.exec(cleanCode)) !== null) {
    const rawLiteral = match[0];
    const absOffset = baseOffset + match.index;
    const lineNum = lineAtOffset(fullSource, absOffset);
    const lineText = getLineText(sourceLines, lineNum);

    // Skip lines that are regex literals or pure translator replacements
    if (/\.replace\s*\(\s*\//.test(lineText)) continue;

    const inner = rawLiteral.slice(1, -1);
    // Replace ${...} interpolations with a neutral placeholder
    const withoutInterp = rawLiteral.startsWith("`")
      ? inner.replace(/\$\{[^}]*\}/g, " ")
      : inner;

    if (isNonScreenJsLiteral(withoutInterp, lineText)) continue;

    const segments = extractScreenSegmentsFromChunk(withoutInterp);
    for (const seg of segments) {
      if (isNonScreenJsLiteral(seg, lineText)) continue;
      if (isAllowed(relFile, seg, lineText)) continue;

      for (const rule of RULES) {
        if (rule.re.test(seg)) {
          findings.push({
            file: relFile,
            line: lineNum,
            rule: rule.id,
            description: rule.description,
            text: seg.slice(0, 140),
          });
        }
      }
    }
  }
}

function scanHtmlFile(fullSource, relFile) {
  const findings = [];
  const sourceLines = fullSource.split(/\r?\n/);

  // 1. Scan <script> blocks as JS
  const scriptRe = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let scriptMatch;
  while ((scriptMatch = scriptRe.exec(fullSource)) !== null) {
    const tagOpenEnd = scriptMatch.index + scriptMatch[0].indexOf(">") + 1;
    const scriptBody = scriptMatch[1];
    scanJsRegion(scriptBody, tagOpenEnd, fullSource, sourceLines, relFile, findings);
  }

  // 2. Scan visible HTML markup outside <script>, <style>, and comments
  const markupOnly = fullSource
    .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, (m) => m.replace(/[^\n]/g, " "))
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, (m) => m.replace(/[^\n]/g, " "));

  // Accessible attributes
  const attrRe = /\b(?:aria-label|title|placeholder|alt)\s*=\s*(["'])([\s\S]*?)\1/gi;
  let attrMatch;
  while ((attrMatch = attrRe.exec(markupOnly)) !== null) {
    const val = attrMatch[2].replace(/\s+/g, " ").trim();
    if (!val) continue;
    const lineNum = lineAtOffset(fullSource, attrMatch.index);
    const lineText = getLineText(sourceLines, lineNum);
    if (isAllowed(relFile, val, lineText)) continue;

    for (const rule of RULES) {
      if (rule.re.test(val)) {
        findings.push({
          file: relFile,
          line: lineNum,
          rule: rule.id,
          description: rule.description,
          text: val.slice(0, 140),
        });
      }
    }
  }

  // Visible text nodes between > and <
  const textNodeRe = />([^<]+)</g;
  let textMatch;
  while ((textNodeRe.lastIndex < markupOnly.length) && (textMatch = textNodeRe.exec(markupOnly)) !== null) {
    const rawText = textMatch[1];
    const clean = rawText.replace(/\s+/g, " ").trim();
    if (!clean) continue;
    const firstNonWs = rawText.search(/\S/);
    const offset = textMatch.index + 1 + (firstNonWs >= 0 ? firstNonWs : 0);
    const lineNum = lineAtOffset(fullSource, offset);
    const lineText = getLineText(sourceLines, lineNum);
    if (isAllowed(relFile, clean, lineText)) continue;

    for (const rule of RULES) {
      if (rule.re.test(clean)) {
        findings.push({
          file: relFile,
          line: lineNum,
          rule: rule.id,
          description: rule.description,
          text: clean.slice(0, 140),
        });
      }
    }
  }

  return findings;
}

export function runScreenWordsCheck(customFiles = null) {
  const targets = customFiles || DEFAULT_TARGETS.map((rel) => ({
    rel,
    abs: path.join(UI_ROOT, rel),
  }));

  const allFindings = [];

  for (const item of targets) {
    const rel = typeof item === "string" ? path.relative(UI_ROOT, item) : item.rel;
    const abs = typeof item === "string" ? path.resolve(item) : item.abs;

    if (!fs.existsSync(abs)) {
      allFindings.push({
        file: rel,
        line: 1,
        rule: "missing-file",
        description: "Target file does not exist",
        text: abs,
      });
      continue;
    }

    const content = fs.readFileSync(abs, "utf8");
    if (abs.endsWith(".html")) {
      allFindings.push(...scanHtmlFile(content, rel));
    } else {
      const lines = content.split(/\r?\n/);
      scanJsRegion(content, 0, content, lines, rel, allFindings);
    }
  }

  // Deduplicate identical (file, line, rule, text)
  const seen = new Set();
  const deduped = [];
  for (const f of allFindings) {
    const key = `${f.file}:${f.line}:${f.rule}:${f.text}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(f);
    }
  }

  return deduped;
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const cliArgs = process.argv.slice(2);
  const customTargets =
    cliArgs.length > 0
      ? cliArgs.map((arg) => ({
          rel: path.relative(UI_ROOT, path.resolve(arg)) || path.basename(arg),
          abs: path.resolve(arg),
        }))
      : null;

  const findings = runScreenWordsCheck(customTargets);
  if (findings.length === 0) {
    console.log("PASS screen-words-check: 0 forbidden screen words or tokens found.");
    process.exit(0);
  } else {
    console.error(`FAIL screen-words-check: ${findings.length} finding(s):`);
    for (const f of findings) {
      console.error(`  - ${f.file}:${f.line} [${f.rule}] (${f.description}): ${JSON.stringify(f.text)}`);
    }
    process.exit(1);
  }
}
