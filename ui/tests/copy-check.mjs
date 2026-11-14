#!/usr/bin/env node
/**
 * Mechanical check for UI wording and style defects across:
 *   - ui/index.html
 *   - ui/workspace.html
 *   - ui/workspace/app.js
 *   - ui/workspace/styles.css
 *   - ui/demo/index.html
 *
 * Node built-ins only; no browser.
 * Exits 0 on CHECK PASS, 1 on CHECK FAIL.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(__dirname, "../..");

function parseArgs(argv) {
  let root = process.env.COPY_CHECK_ROOT || DEFAULT_ROOT;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root" && argv[i + 1]) {
      root = path.resolve(argv[++i]);
    }
  }
  return { root };
}

const TARGET_FILES = [
  "ui/index.html",
  "ui/workspace.html",
  "ui/workspace/app.js",
  "ui/workspace/styles.css",
  "ui/demo/index.html",
];

const findings = [];

function addFinding(file, line, rule, text) {
  const clean = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  const snippet = clean.length > 120 ? clean.slice(0, 117) + "..." : clean;
  findings.push({ file, line, rule, text: snippet });
}

function lineAt(source, index) {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) {
    if (source.charCodeAt(i) === 10) line++;
  }
  return line;
}

function preserveNewlines(str) {
  return str.replace(/[^\n]/g, " ");
}

function decodeHtmlEntities(str) {
  return str
    .replace(/&middot;/g, "·")
    .replace(/&times;/g, "×")
    .replace(/&hellip;/g, "…")
    .replace(/&oslash;/g, "ø")
    .replace(/&cir;/g, "○")
    .replace(/&mdash;/g, "—")
    .replace(/&ge;/g, "≥")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#9684;/g, "◔")
    .replace(/&nbsp;/g, " ");
}

/* ============================================================================
   VISIBLE TEXT RULES (1, 2, 3, 4, 7)
   ============================================================================ */

const INTERNAL_FIELDS_RE = /\b(task_id|run\.id|root_id|claimed_by|n_events|help_kind)\b/;
const SECTION_ID_RE = /\b(?:A[1-9][a-z]?|B[1-9][a-z]?)\b/;
const FILE_PATH_RE =
  /(?:~\/|\/(?:tmp|Users|var|etc|opt|home|ui|backend|notch|docs)\/[A-Za-z0-9_.\-/]*|\b[A-Za-z0-9_.-]+\.(?:sqlite|db|py|mjs|html|css)\b)/;
const ALL_CAPS_RE = /(?<![A-Za-z])[A-Z]{4,}(?![A-Za-z])/g;
const EMOJI_RE =
  /(?:\p{Emoji_Presentation}|(?![▶◀▲▼])\p{Extended_Pictographic}\uFE0F?)/u;

function checkVisibleText(file, line, rawText, context = {}) {
  const decoded = decodeHtmlEntities(rawText)
    .replace(/__EXPR__/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!decoded) return;

  // Strip URLs before checking file paths / all-caps so placeholder="https://example.com" isn't flagged
  const withoutUrls = decoded.replace(/https?:\/\/[^\s"'`<>)]+/gi, " ");

  // (1) API path, file path or .json, fixtures/, or internal section id like B1b, A4
  if (
    /\/api\//.test(decoded) ||
    /fixtures\//.test(decoded) ||
    /\.json\b/i.test(decoded) ||
    FILE_PATH_RE.test(withoutUrls) ||
    SECTION_ID_RE.test(withoutUrls)
  ) {
    addFinding(file, line, "internal-ref-in-copy", decoded);
  }

  // (2) 'Always allow' or 'Always asks' on an approval control
  // (onboarding rules table may say "Always asks. Can't be changed." for locked kinds only)
  if (/\bAlways allow\b/i.test(decoded)) {
    addFinding(file, line, "disallowed-approval-label", decoded);
  } else if (/\bAlways asks\b/i.test(decoded)) {
    const isAllowedLockedNote =
      context.isLockedRuleNote &&
      decoded.includes("Always asks. Can't be changed.");
    if (!isAllowedLockedNote) {
      addFinding(file, line, "disallowed-approval-label", decoded);
    }
  }

  // (3) Internal field names shown to users
  if (INTERNAL_FIELDS_RE.test(decoded)) {
    addFinding(file, line, "internal-field-name", decoded);
  }

  // (4) ALL-CAPS words longer than 3 letters
  const capsMatches = withoutUrls.match(ALL_CAPS_RE);
  if (capsMatches && capsMatches.length > 0) {
    addFinding(file, line, "all-caps-word", decoded);
  }

  // (7) Emoji in visible text
  if (EMOJI_RE.test(decoded)) {
    addFinding(file, line, "emoji-in-copy", decoded);
  }
}

/* ============================================================================
   CSS RULES (5, 6)
   ============================================================================ */

function parseRgbOrHex(token) {
  const hex = token.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) {
      h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    }
    const n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const rgb = token.match(
    /^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)/i
  );
  if (rgb) {
    return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  }
  return null;
}

function isBlueColorValue(value) {
  if (/\bblue\b/i.test(value)) return true;
  if (/var\(\s*--state-working\s*\)/i.test(value)) return true;

  const colorTokens =
    value.match(/#[0-9a-f]{3,6}\b|rgba?\([^)]+\)/gi) || [];
  for (const tok of colorTokens) {
    const rgb = parseRgbOrHex(tok);
    if (!rgb) continue;
    const [r, g, b] = rgb;
    if (b >= 140 && b > r + 40 && b > g + 25) {
      return true;
    }
  }
  const hslMatches =
    value.match(/hsla?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)%/gi) || [];
  for (const tok of hslMatches) {
    const m = tok.match(/hsla?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)%/i);
    if (m) {
      const h = Number(m[1]);
      const s = Number(m[2]);
      if (h >= 195 && h <= 255 && s >= 25) return true;
    }
  }
  return false;
}

function isWorkingOrRunningSelector(selector) {
  return /working|running/i.test(selector);
}

function checkCssDeclarations(file, baseLine, selector, bodyText, bodyStartOffset, fullCss) {
  const decls = bodyText.split(";");
  let offsetInBody = 0;
  for (const rawDecl of decls) {
    const decl = rawDecl.trim();
    const declLine = baseLine + lineAt(fullCss, bodyStartOffset + offsetInBody) - 1;
    offsetInBody += rawDecl.length + 1;
    if (!decl) continue;

    const colonIdx = decl.indexOf(":");
    if (colonIdx === -1) continue;
    const prop = decl.slice(0, colonIdx).trim().toLowerCase();
    const val = decl.slice(colonIdx + 1).trim();

    // (5) font-size below 12px
    if (prop === "font-size") {
      const pxMatch = val.match(/^(\d+(?:\.\d+)?)\s*px\b/i);
      if (pxMatch && parseFloat(pxMatch[1]) < 12) {
        addFinding(file, declLine, "font-size-below-12px", `${prop}: ${val}`);
      }
    }

    // (6) blue outside working/running state selector
    // Allow defining --state-working itself in :root
    if (prop === "--state-working") continue;
    if (isBlueColorValue(val) && !isWorkingOrRunningSelector(selector)) {
      addFinding(file, declLine, "blue-outside-working-state", `${selector || "(inline)"} { ${prop}: ${val} }`);
    }
  }
}

function scanCss(cssText, file, baseLine = 1) {
  const cleaned = cssText.replace(/\/\*[\s\S]*?\*\//g, preserveNewlines);
  let i = 0;
  let selectorStart = 0;
  const stack = [];

  while (i < cleaned.length) {
    const ch = cleaned[i];
    if (ch === "{") {
      const header = cleaned.slice(selectorStart, i).trim();
      stack.push({ header, bodyStart: i + 1 });
      selectorStart = i + 1;
    } else if (ch === "}") {
      const top = stack.pop();
      if (top) {
        const body = cleaned.slice(top.bodyStart, i);
        // Only inspect declaration blocks (not @media / @keyframes wrappers that contain '{')
        if (!body.includes("{")) {
          checkCssDeclarations(file, baseLine, top.header, body, top.bodyStart, cleaned);
        }
      }
      selectorStart = i + 1;
    }
    i++;
  }
}

/* ============================================================================
   HTML SCANNER (text nodes, aria-label/title/placeholder, inline style)
   ============================================================================ */

function scanHtmlFragment(html, file, baseLine = 1, options = {}) {
  const cleaned = html.replace(/<!--[\s\S]*?-->/g, preserveNewlines);
  let i = 0;
  let lastTagEnd = 0;
  let currentTag = "";
  let inStyle = false;
  let inScript = false;

  while (i < cleaned.length) {
    if (cleaned[i] === "<") {
      // Check text node before '<'
      if (!inStyle && !inScript && i > lastTagEnd) {
        const textNode = cleaned.slice(lastTagEnd, i);
        const textLine = baseLine + lineAt(cleaned, lastTagEnd) - 1;
        const isLockedRuleNote = /class\s*=\s*["'][^"']*rule-locked-note/.test(currentTag);
        checkVisibleText(file, textLine, textNode, { isLockedRuleNote });
      }

      // Find end of tag '>' respecting quotes
      let j = i + 1;
      let quote = null;
      while (j < cleaned.length) {
        const c = cleaned[j];
        if (quote) {
          if (c === quote) quote = null;
        } else {
          if (c === '"' || c === "'") quote = c;
          else if (c === ">") break;
        }
        j++;
      }
      if (j >= cleaned.length) break;

      const tagText = cleaned.slice(i, j + 1);
      const tagLower = tagText.toLowerCase();
      currentTag = tagText;

      if (!options.templateFragment) {
        if (/^<style\b/.test(tagLower)) {
          inStyle = true;
          const closeIdx = cleaned.toLowerCase().indexOf("</style>", j + 1);
          if (closeIdx !== -1) {
            const styleContent = cleaned.slice(j + 1, closeIdx);
            const styleLine = baseLine + lineAt(cleaned, j + 1) - 1;
            scanCss(styleContent, file, styleLine);
            inStyle = false;
            i = closeIdx + "</style>".length;
            lastTagEnd = i;
            continue;
          }
        } else if (/^<script\b/.test(tagLower)) {
          inScript = true;
          const closeIdx = cleaned.toLowerCase().indexOf("</script>", j + 1);
          if (closeIdx !== -1) {
            const scriptContent = cleaned.slice(j + 1, closeIdx);
            const scriptLine = baseLine + lineAt(cleaned, j + 1) - 1;
            scanJs(scriptContent, file, scriptLine);
            inScript = false;
            i = closeIdx + "</script>".length;
            lastTagEnd = i;
            continue;
          }
        }
      }

      // Check aria-label, title, placeholder, and inline style attributes on the tag
      const attrRe = /\b(aria-label|title|placeholder|style)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
      let am;
      while ((am = attrRe.exec(tagText)) !== null) {
        const attrName = am[1].toLowerCase();
        const attrVal = am[2] !== undefined ? am[2] : am[3];
        const attrLine = baseLine + lineAt(cleaned, i + am.index) - 1;
        if (attrName === "style") {
          checkCssDeclarations(file, attrLine, "", attrVal, 0, attrVal);
        } else {
          checkVisibleText(file, attrLine, attrVal);
        }
      }

      lastTagEnd = j + 1;
      i = j + 1;
      continue;
    }
    i++;
  }

  if (!inStyle && !inScript && lastTagEnd < cleaned.length) {
    const trailing = cleaned.slice(lastTagEnd);
    const trailingLine = baseLine + lineAt(cleaned, lastTagEnd) - 1;
    checkVisibleText(file, trailingLine, trailing);
  }
}

/* ============================================================================
   JS SCANNER (HTML template literals + user-visible string literals)
   ============================================================================ */

const NON_VISIBLE_CALL_RE =
  /(?:Transport\.request|fetch|new\s+URL|querySelector(?:All)?|getElementById|closest|setAttribute|getAttribute|classList\.\w+|addEventListener|import|RegExp|Error)\s*\(\s*$/;

const COMPARISON_OP_RE = /(?:===|!==|==|!=)\s*$/;

const VISIBLE_CONTEXT_RE =
  /(?:\.(?:textContent|innerText|placeholder|title|innerHTML)\s*=\s*$|\b(?:connectionError|sendErrorText|provenanceDescription|reliabilityText|stateFact|stateSymbolWord|shortSymbolWord|mockNote|timeoutNote|latestSummary|phrase|sampleLabel|caption)\s*(?:=|\?|:)\s*$|(?:^|[{,\s])(?:warning|when|tagline|note|sampleLabel|question|summary|mockNote|timeoutNote|caption)\s*:[\s\S]{0,240}$|\breturn\s+$)/;

function isRegexStart(jsText, slashIdx) {
  let k = slashIdx - 1;
  while (k >= 0 && /\s/.test(jsText[k])) k--;
  if (k < 0) return true;
  const prev = jsText[k];
  if ("=(,:[!&|?;{}~^+-*%<>".includes(prev)) return true;
  const tail = jsText.slice(Math.max(0, k - 10), k + 1);
  if (/(?:\breturn|\bthrow|\bcase|\btypeof|\bvoid|\bdelete|\bin|\bof)\s*$/.test(tail)) {
    return true;
  }
  return false;
}

function skipRegexLiteral(jsText, startIdx, end) {
  let idx = startIdx + 1;
  let inClass = false;
  while (idx < end) {
    const c = jsText[idx];
    if (c === "\\") {
      idx += 2;
      continue;
    }
    if (c === "\n") return idx;
    if (c === "[") {
      inClass = true;
    } else if (c === "]") {
      inClass = false;
    } else if (c === "/" && !inClass) {
      idx++;
      while (idx < end && /[a-z]/i.test(jsText[idx])) idx++;
      return idx;
    }
    idx++;
  }
  return idx;
}

function hasHtmlTags(str) {
  return /<(?:div|span|button|p|h[1-6]|tr|td|th|table|thead|tbody|svg|g|text|tspan|rect|line|polygon|path|circle|label|input|textarea|section|header|nav|a|ul|li|strong|em)\b/i.test(
    str
  );
}

function isNonVisibleAttrExpr(maskedPrefix) {
  const tail = maskedPrefix.slice(-80);
  return /\b(?:class|id|type|role|href|src|style|data-[a-z0-9-]+|aria-(?:selected|expanded|pressed|controls|haspopup|hidden|live))\s*=\s*"[^"]*$/i.test(
    tail
  );
}

function scanJs(jsText, file, baseLine = 1) {
  let i = 0;
  const n = jsText.length;

  function scanRange(start, end, inHtmlTextExpr = false) {
    let idx = start;
    while (idx < end) {
      const ch = jsText[idx];

      // Line comment
      if (ch === "/" && jsText[idx + 1] === "/") {
        const nl = jsText.indexOf("\n", idx);
        idx = nl === -1 || nl >= end ? end : nl + 1;
        continue;
      }

      // Block comment
      if (ch === "/" && jsText[idx + 1] === "*") {
        const close = jsText.indexOf("*/", idx + 2);
        idx = close === -1 || close >= end ? end : close + 2;
        continue;
      }

      // Regex literal
      if (ch === "/" && isRegexStart(jsText, idx)) {
        idx = skipRegexLiteral(jsText, idx, end);
        continue;
      }

      // Single or double quoted string
      if (ch === "'" || ch === '"') {
        const quote = ch;
        const strStart = idx;
        idx++;
        let val = "";
        while (idx < end) {
          const c = jsText[idx];
          if (c === "\\") {
            val += jsText.slice(idx, idx + 2);
            idx += 2;
            continue;
          }
          if (c === quote) {
            idx++;
            break;
          }
          val += c;
          idx++;
        }
        const strLine = baseLine + lineAt(jsText, strStart) - 1;
        const before = jsText.slice(Math.max(0, strStart - 160), strStart);
        const isComparison = COMPARISON_OP_RE.test(before);
        const isVisible =
          !NON_VISIBLE_CALL_RE.test(before) &&
          !isComparison &&
          (VISIBLE_CONTEXT_RE.test(before) ||
            (inHtmlTextExpr && /(?:\?|:|\|\||\(|\+)\s*$/.test(before)));
        if (isVisible) {
          checkVisibleText(file, strLine, val);
        }
        continue;
      }

      // Template literal
      if (ch === "`") {
        const tplStart = idx;
        idx++;
        let masked = "";
        const exprRanges = [];

        while (idx < end) {
          const c = jsText[idx];
          if (c === "\\") {
            masked += jsText.slice(idx, idx + 2);
            idx += 2;
            continue;
          }
          if (c === "`") {
            idx++;
            break;
          }
          if (c === "$" && jsText[idx + 1] === "{") {
            const exprStart = idx + 2;
            idx += 2;
            let depth = 1;
            while (idx < end && depth > 0) {
              const ec = jsText[idx];
              if (ec === "'" || ec === '"' || ec === "`") {
                // Skip nested string/template inside expression
                const q = ec;
                idx++;
                while (idx < end) {
                  if (jsText[idx] === "\\") {
                    idx += 2;
                    continue;
                  }
                  if (jsText[idx] === q) {
                    idx++;
                    break;
                  }
                  if (q === "`" && jsText[idx] === "$" && jsText[idx + 1] === "{") {
                    // Nested template interpolation
                    idx += 2;
                    let nd = 1;
                    while (idx < end && nd > 0) {
                      if (jsText[idx] === "{") nd++;
                      else if (jsText[idx] === "}") nd--;
                      idx++;
                    }
                    continue;
                  }
                  idx++;
                }
                continue;
              }
              if (ec === "{") depth++;
              else if (ec === "}") depth--;
              if (depth > 0) idx++;
            }
            const exprEnd = idx;
            if (jsText[idx] === "}") idx++;
            const exprInVisibleHtml = !isNonVisibleAttrExpr(masked);
            exprRanges.push({ start: exprStart, end: exprEnd, inVisibleHtml: exprInVisibleHtml });
            const rawExpr = jsText.slice(exprStart, exprEnd);
            masked += "__EXPR__" + rawExpr.replace(/[^\n]/g, "");
            continue;
          }
          masked += c;
          idx++;
        }

        const tplLine = baseLine + lineAt(jsText, tplStart) - 1;
        const before = jsText.slice(Math.max(0, tplStart - 160), tplStart);

        const isHtml = hasHtmlTags(masked);
        if (isHtml) {
          scanHtmlFragment(masked, file, tplLine, { templateFragment: true });
        } else if (!NON_VISIBLE_CALL_RE.test(before) && VISIBLE_CONTEXT_RE.test(before)) {
          checkVisibleText(file, tplLine, masked);
        }

        // Recursively scan expressions inside ${...}
        for (const r of exprRanges) {
          scanRange(r.start, r.end, isHtml && r.inVisibleHtml);
        }
        continue;
      }

      idx++;
    }
  }

  scanRange(0, n);
}

/* ============================================================================
   MAIN
   ============================================================================ */

function main() {
  const { root } = parseArgs(process.argv.slice(2));

  for (const relPath of TARGET_FILES) {
    const absPath = path.join(root, relPath);
    if (!fs.existsSync(absPath)) {
      addFinding(relPath, 1, "missing-file", `Target file not found: ${relPath}`);
      continue;
    }
    const content = fs.readFileSync(absPath, "utf8");
    if (relPath.endsWith(".css")) {
      scanCss(content, relPath, 1);
    } else if (relPath.endsWith(".js")) {
      scanJs(content, relPath, 1);
    } else if (relPath.endsWith(".html")) {
      scanHtmlFragment(content, relPath, 1);
    }
  }

  for (const f of findings) {
    console.log(`${f.file}:${f.line}: ${f.rule}: ${f.text}`);
  }

  if (findings.length === 0) {
    console.log("CHECK PASS (0 findings)");
    process.exit(0);
  } else {
    console.log(`CHECK FAIL (${findings.length} finding${findings.length === 1 ? "" : "s"})`);
    process.exit(1);
  }
}

main();
