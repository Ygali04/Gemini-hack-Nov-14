/**
 * Robustly extracts WorkspaceAdapter (and its pure helpers) from ui/index.html
 * and ui/workspace/app.js without depending on exact `return { ... }` formatting.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(__dirname, "../..");

function isRegexStart(src, idx) {
  let j = idx - 1;
  while (j >= 0 && /[ \t\r\n]/.test(src[j])) j--;
  if (j < 0) return true;
  const ch = src[j];
  if ("=(,[!&|?:;{}\n".includes(ch)) return true;
  if (/[a-zA-Z0-9_$]/.test(ch)) {
    let k = j;
    while (k >= 0 && /[a-zA-Z0-9_$]/.test(src[k])) k--;
    const word = src.slice(k + 1, j + 1);
    return word === "return" || word === "typeof" || word === "case" || word === "in" || word === "of";
  }
  return false;
}

/**
 * Extracts a single JS declaration (`const X = ...;` or `function X(...) { ... }`)
 * starting at the first match of `declRegex`, using JS-aware delimiter balancing.
 */
export function extractStatement(src, declRegex, label) {
  const match = declRegex.exec(src);
  assert.ok(match, `Could not locate ${label}`);

  const startIdx = match.index;
  const isFuncDecl = /^\s*function\b/.test(match[0]);
  let braceDepth = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  let sawDelimiter = false;
  const templateBraceStack = [];

  for (let i = startIdx; i < src.length; i++) {
    const ch = src[i];
    const next = src[i + 1];

    // Line comment
    if (ch === "/" && next === "/") {
      const nl = src.indexOf("\n", i + 2);
      if (nl === -1) break;
      i = nl;
      continue;
    }

    // Block comment
    if (ch === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      assert.ok(end !== -1, `Unterminated block comment while extracting ${label}`);
      i = end + 1;
      continue;
    }

    // String literals
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i++;
      while (i < src.length) {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        if (src[i] === quote) break;
        i++;
      }
      continue;
    }

    // Template literals
    if (ch === "`") {
      i++;
      while (i < src.length) {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        if (src[i] === "$" && src[i + 1] === "{") {
          templateBraceStack.push(braceDepth);
          braceDepth++;
          sawDelimiter = true;
          i += 1;
          break;
        }
        if (src[i] === "`") break;
        i++;
      }
      continue;
    }

    // Regex literal
    if (ch === "/" && isRegexStart(src, i)) {
      i++;
      let inClass = false;
      while (i < src.length) {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        if (src[i] === "[") inClass = true;
        else if (src[i] === "]" && inClass) inClass = false;
        else if (src[i] === "/" && !inClass) break;
        i++;
      }
      continue;
    }

    if (ch === "{") {
      braceDepth++;
      sawDelimiter = true;
    } else if (ch === "}") {
      braceDepth--;
      if (templateBraceStack.length > 0 && braceDepth === templateBraceStack[templateBraceStack.length - 1]) {
        templateBraceStack.pop();
        // Resume scanning the outer template literal
        i++;
        while (i < src.length) {
          if (src[i] === "\\") {
            i += 2;
            continue;
          }
          if (src[i] === "$" && src[i + 1] === "{") {
            templateBraceStack.push(braceDepth);
            braceDepth++;
            i += 1;
            break;
          }
          if (src[i] === "`") break;
          i++;
        }
        continue;
      }
      if (isFuncDecl && sawDelimiter && braceDepth === 0 && parenDepth === 0 && bracketDepth === 0) {
        return src.slice(startIdx, i + 1);
      }
    } else if (ch === "(") {
      parenDepth++;
      sawDelimiter = true;
    } else if (ch === ")") {
      parenDepth--;
    } else if (ch === "[") {
      bracketDepth++;
      sawDelimiter = true;
    } else if (ch === "]") {
      bracketDepth--;
    } else if (ch === ";" && sawDelimiter && braceDepth === 0 && parenDepth === 0 && bracketDepth === 0) {
      return src.slice(startIdx, i + 1);
    }
  }

  throw new Error(`Could not find end of ${label}`);
}

export function loadNotchAdapterFromIndexHtml(indexHtmlPath = path.join(DEFAULT_ROOT, "ui/index.html")) {
  const html = fs.readFileSync(indexHtmlPath, "utf8");
  const adapterSource =
    extractStatement(html, /\bconst\s+WorkspaceAdapter\s*=/, "WorkspaceAdapter in ui/index.html") +
    "\n;WorkspaceAdapter;";

  const context = vm.createContext({
    Date,
    Math,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Map,
    Set,
    RegExp,
    parseInt,
    parseFloat,
    isNaN,
  });

  const adapter = vm.runInContext(adapterSource, context, {
    filename: "ui/index.html#WorkspaceAdapter",
  });
  assert.equal(typeof adapter?.mapRuns, "function", "Notch WorkspaceAdapter.mapRuns must be a function");
  return adapter;
}

export function loadWorkspaceAdapterFromAppJs(options = {}) {
  const {
    appJsPath = path.join(DEFAULT_ROOT, "ui/workspace/app.js"),
    DateClass = Date,
  } = options;

  assert.ok(fs.existsSync(appJsPath), `Missing ${appJsPath}`);
  const src = fs.readFileSync(appJsPath, "utf8");

  const parts = [];
  if (/\bconst\s+SharedGlass\s*=/.test(src)) {
    parts.push(extractStatement(src, /\bconst\s+SharedGlass\s*=/, "SharedGlass in ui/workspace/app.js"));
  } else {
    parts.push(extractStatement(src, /\bconst\s+QUIET_PRESET\s*=/, "QUIET_PRESET in ui/workspace/app.js"));
  }

  parts.push(extractStatement(src, /\bconst\s+AGENT_SWATCHES\s*=/, "AGENT_SWATCHES in ui/workspace/app.js"));

  if (/\bfunction\s+stableSeed\s*\(/.test(src)) {
    parts.push(extractStatement(src, /\bfunction\s+stableSeed\s*\(/, "stableSeed in ui/workspace/app.js"));
  }

  const onboardingMatch = /\bconst\s+OnboardingState\s*=/.exec(src);
  assert.ok(onboardingMatch, "Could not locate OnboardingState in ui/workspace/app.js");

  const adapterStatement = extractStatement(src, /\bconst\s+WorkspaceAdapter\s*=/, "WorkspaceAdapter in ui/workspace/app.js");
  const adapterIdx = src.indexOf(adapterStatement);
  assert.ok(adapterIdx > onboardingMatch.index, "WorkspaceAdapter must appear after OnboardingState in ui/workspace/app.js");

  parts.push(src.slice(onboardingMatch.index, adapterIdx + adapterStatement.length));
  parts.push("({ WorkspaceAdapter, OnboardingState, AGENT_SWATCHES });");

  const extractedSource = parts.join("\n\n");

  const context = vm.createContext({
    window: {},
    Date: DateClass,
    Math,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Map,
    Set,
    RegExp,
    parseInt,
    parseFloat,
    isNaN,
    Transport: {
      getSampleLabel: () => "Sample data (backend-shape)",
    },
  });

  const exported = vm.runInContext(extractedSource, context, {
    filename: "ui/workspace/app.js#WorkspaceAdapter",
  });
  assert.equal(
    typeof exported?.WorkspaceAdapter?.buildViewModel,
    "function",
    "WorkspaceAdapter.buildViewModel must be a function"
  );
  return exported;
}
