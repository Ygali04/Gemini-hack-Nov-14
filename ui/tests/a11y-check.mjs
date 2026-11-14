#!/usr/bin/env node
/**
 * Mechanical accessibility and contrast check across:
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

const TARGET_FILES = [
  "ui/index.html",
  "ui/workspace.html",
  "ui/workspace/app.js",
  "ui/workspace/styles.css",
  "ui/demo/index.html",
];

function parseArgs(argv) {
  let root = process.env.A11Y_CHECK_ROOT || DEFAULT_ROOT;
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

function preserveNewlines(str) {
  return str.replace(/[^\n]/g, " ");
}

function addFinding(findings, file, line, rule, detail) {
  const clean = String(detail || "").replace(/\s+/g, " ").trim();
  const snippet = clean.length > 140 ? clean.slice(0, 137) + "..." : clean;
  findings.push({ file, line, rule, detail: snippet });
}

/* ============================================================================
   WCAG 2.1 COLOR PARSING & CONTRAST RATIO
   ============================================================================ */

const NAMED_COLORS = {
  black: [0, 0, 0, 1],
  white: [255, 255, 255, 1],
  red: [255, 0, 0, 1],
  green: [0, 128, 0, 1],
  blue: [0, 0, 255, 1],
  yellow: [255, 255, 0, 1],
  gray: [128, 128, 128, 1],
  grey: [128, 128, 128, 1],
  silver: [192, 192, 192, 1],
  navy: [0, 0, 128, 1],
  teal: [0, 128, 128, 1],
  orange: [255, 165, 0, 1],
};

function parseHexColor(hex) {
  const h = hex.slice(1).trim();
  if (h.length === 3 || h.length === 4) {
    const r = parseInt(h[0] + h[0], 16);
    const g = parseInt(h[1] + h[1], 16);
    const b = parseInt(h[2] + h[2], 16);
    const a = h.length === 4 ? parseInt(h[3] + h[3], 16) / 255 : 1;
    return [r, g, b, a];
  }
  if (h.length === 6 || h.length === 8) {
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    return [r, g, b, a];
  }
  return null;
}

function resolveColorValue(raw, vars, depth = 0) {
  if (!raw || depth > 8) return null;
  let val = raw.replace(/!important/gi, "").trim();
  if (!val) return null;

  // Handle var(--name) or var(--name, fallback)
  const varMatch = val.match(/^var\(\s*(--[A-Za-z0-9_-]+)\s*(?:,\s*(.+))?\)$/);
  if (varMatch) {
    const varName = varMatch[1];
    const fallback = varMatch[2];
    if (vars[varName]) {
      const resolved = resolveColorValue(vars[varName], vars, depth + 1);
      if (resolved) return resolved;
    }
    if (fallback) {
      return resolveColorValue(fallback, vars, depth + 1);
    }
    return null;
  }

  // Handle shorthand `background:` values by extracting a single color token if present
  const lower = val.toLowerCase();
  if (
    lower === "transparent" ||
    lower === "none" ||
    lower === "inherit" ||
    lower === "initial" ||
    lower === "unset" ||
    lower === "currentcolor" ||
    lower.includes("gradient(") ||
    lower.includes("url(")
  ) {
    return null;
  }

  if (/^#[0-9a-f]{3,8}$/i.test(val)) {
    return parseHexColor(val);
  }

  const rgbMatch = val.match(
    /^rgba?\(\s*([0-9.]+)\s*[,\s]\s*([0-9.]+)\s*[,\s]\s*([0-9.]+)\s*(?:[,/]\s*([0-9.]+%?)\s*)?\)$/i
  );
  if (rgbMatch) {
    const r = Math.max(0, Math.min(255, Number(rgbMatch[1])));
    const g = Math.max(0, Math.min(255, Number(rgbMatch[2])));
    const b = Math.max(0, Math.min(255, Number(rgbMatch[3])));
    let a = 1;
    if (rgbMatch[4] !== undefined) {
      a = rgbMatch[4].endsWith("%")
        ? parseFloat(rgbMatch[4]) / 100
        : parseFloat(rgbMatch[4]);
      a = Math.max(0, Math.min(1, a));
    }
    return [r, g, b, a];
  }

  if (NAMED_COLORS[lower]) {
    return NAMED_COLORS[lower];
  }

  // Try extracting a color token from shorthand (e.g. "var(--bg-raised) no-repeat")
  const tokenMatch = val.match(
    /(#[0-9a-f]{3,8}|rgba?\([^)]+\)|var\([^)]+\))/i
  );
  if (tokenMatch && tokenMatch[1] !== val) {
    return resolveColorValue(tokenMatch[1], vars, depth + 1);
  }

  return null;
}

function compositeOver(fg, bg) {
  const a = fg[3];
  if (a >= 0.999) return [fg[0], fg[1], fg[2]];
  return [
    a * fg[0] + (1 - a) * bg[0],
    a * fg[1] + (1 - a) * bg[1],
    a * fg[2] + (1 - a) * bg[2],
  ];
}

function relativeLuminance([r, g, b]) {
  const toLinear = (c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

function contrastRatio(fgRgba, bgRgba) {
  // If background itself has alpha < 1, composite over dark default (#0c0d10)
  const bgOpaque = bgRgba[3] < 0.999 ? compositeOver(bgRgba, [12, 13, 16]) : [bgRgba[0], bgRgba[1], bgRgba[2]];
  const fgOpaque = compositeOver(fgRgba, bgOpaque);
  const l1 = relativeLuminance(fgOpaque);
  const l2 = relativeLuminance(bgOpaque);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

function formatColor([r, g, b, a = 1]) {
  const hex =
    "#" +
    [r, g, b]
      .map((n) => Math.round(n).toString(16).padStart(2, "0"))
      .join("");
  return a < 0.999 ? `${hex} (alpha ${a.toFixed(2)})` : hex;
}

/* ============================================================================
   CSS SCANNER (Rules 3, 4, 5)
   ============================================================================ */

function stripCssComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, preserveNewlines);
}

function parseCssBlocks(css) {
  const clean = stripCssComments(css);
  const vars = {};
  const rules = [];
  let i = 0;
  const n = clean.length;

  function scanBlock(inMedia) {
    while (i < n) {
      // Skip whitespace
      while (i < n && /\s/.test(clean[i])) i++;
      if (i >= n) break;
      if (clean[i] === "}") {
        i++;
        return;
      }

      const headerStart = i;
      while (i < n && clean[i] !== "{" && clean[i] !== "}" && clean[i] !== ";") {
        i++;
      }
      if (i >= n) break;

      if (clean[i] === ";") {
        i++;
        continue;
      }
      if (clean[i] === "}") {
        i++;
        return;
      }

      const selector = clean.slice(headerStart, i).trim();
      const selectorLine = lineAt(clean, headerStart);
      i++; // skip '{'

      if (selector.startsWith("@media") || selector.startsWith("@supports") || selector.startsWith("@layer")) {
        scanBlock(selector);
        continue;
      }

      if (selector.startsWith("@keyframes") || selector.startsWith("@-webkit-keyframes")) {
        let depth = 1;
        while (i < n && depth > 0) {
          if (clean[i] === "{") depth++;
          else if (clean[i] === "}") depth--;
          i++;
        }
        continue;
      }

      const bodyStart = i;
      let depth = 1;
      while (i < n && depth > 0) {
        if (clean[i] === "{") depth++;
        else if (clean[i] === "}") depth--;
        i++;
      }
      const bodyEnd = i - 1;
      const body = clean.slice(bodyStart, bodyEnd);

      const declarations = [];
      // Split declarations on ';' outside parens
      let dStart = 0;
      let parenDepth = 0;
      for (let k = 0; k <= body.length; k++) {
        const ch = body[k];
        if (ch === "(") parenDepth++;
        else if (ch === ")" && parenDepth > 0) parenDepth--;
        if ((ch === ";" && parenDepth === 0) || k === body.length) {
          const decl = body.slice(dStart, k);
          const colonIdx = decl.indexOf(":");
          if (colonIdx !== -1) {
            const prop = decl.slice(0, colonIdx).trim().toLowerCase();
            const val = decl.slice(colonIdx + 1).trim();
            const declLine = lineAt(clean, bodyStart + dStart + decl.search(/\S|$/));
            if (prop.startsWith("--")) {
              vars[prop] = val.replace(/!important/gi, "").trim();
            }
            declarations.push({ prop, val, line: declLine });
          }
          dStart = k + 1;
        }
      }

      rules.push({ selector, selectorLine, declarations, inMedia: inMedia || null });
    }
  }

  scanBlock(null);
  return { vars, rules, clean };
}

function scanCss(cssText, file, baseLine, findings, sharedVars = {}) {
  const { vars, rules } = parseCssBlocks(cssText);
  const mergedVars = { ...sharedVars, ...vars };

  const hasReducedMotionMedia = /@media[^{]*prefers-reduced-motion\s*:\s*reduce/i.test(cssText);

  // Determine default surface background from body / :root
  let defaultBg = null;
  for (const r of rules) {
    if (/\bbody\b/.test(r.selector)) {
      const bgDecl = r.declarations.find((d) => d.prop === "background" || d.prop === "background-color");
      if (bgDecl) {
        defaultBg = resolveColorValue(bgDecl.val, mergedVars);
      }
    }
  }
  if (!defaultBg && mergedVars["--bg-app"]) {
    defaultBg = resolveColorValue(mergedVars["--bg-app"], mergedVars);
  }

  // Rule 3a: Check custom property text/background pairs defined in :root
  const textVarNames = Object.keys(vars).filter((k) => /^--text-/.test(k));
  const bgVarNames = Object.keys(vars).filter((k) => /^--bg-(app|raised|surface|card|panel)/.test(k));
  for (const tv of textVarNames) {
    const fg = resolveColorValue(vars[tv], mergedVars);
    if (!fg) continue;
    for (const bv of bgVarNames) {
      const bg = resolveColorValue(vars[bv], mergedVars);
      if (!bg) continue;
      const ratio = contrastRatio(fg, bg);
      if (ratio < 4.5) {
        // Find line of tv definition
        const idx = cssText.indexOf(tv);
        const line = idx >= 0 ? baseLine + lineAt(cssText, idx) - 1 : baseLine;
        addFinding(
          findings,
          file,
          line,
          "low-contrast",
          `${tv} (${formatColor(fg)}) on ${bv} (${formatColor(bg)}) has contrast ${ratio.toFixed(2)}:1 (< 4.5:1)`
        );
      }
    }
  }
  if (vars["--ink-text"] && vars["--ink-fill"]) {
    const fg = resolveColorValue(vars["--ink-text"], mergedVars);
    const bg = resolveColorValue(vars["--ink-fill"], mergedVars);
    if (fg && bg) {
      const ratio = contrastRatio(fg, bg);
      if (ratio < 4.5) {
        const idx = cssText.indexOf("--ink-text");
        const line = idx >= 0 ? baseLine + lineAt(cssText, idx) - 1 : baseLine;
        addFinding(
          findings,
          file,
          line,
          "low-contrast",
          `--ink-text (${formatColor(fg)}) on --ink-fill (${formatColor(bg)}) has contrast ${ratio.toFixed(2)}:1 (< 4.5:1)`
        );
      }
    }
  }

  // Rule 3b, 4, 5 on CSS rules
  for (const rule of rules) {
    const colorDecls = rule.declarations.filter((d) => d.prop === "color");
    const bgDecls = rule.declarations.filter((d) => d.prop === "background" || d.prop === "background-color");
    const explicitBg = bgDecls.length > 0 ? resolveColorValue(bgDecls[bgDecls.length - 1].val, mergedVars) : null;

    for (const cd of colorDecls) {
      if (!explicitBg && /--(?:glass|chip)-ink\b/.test(cd.val)) continue;
      const fg = resolveColorValue(cd.val, mergedVars);
      if (!fg) continue;
      const bg = explicitBg || defaultBg;
      if (!bg) continue;
      // Skip if this exact color+bg pair was already reported via --text-* on --bg-app
      const isTextVarOnDefaultBg =
        !explicitBg &&
        /^var\(\s*--text-/.test(cd.val) &&
        vars["--bg-app"] &&
        textVarNames.some((tv) => cd.val.includes(tv));
      if (isTextVarOnDefaultBg) continue;

      const ratio = contrastRatio(fg, bg);
      if (ratio < 4.5) {
        addFinding(
          findings,
          file,
          baseLine + cd.line - 1,
          "low-contrast",
          `rule "${rule.selector}" color ${cd.val} (${formatColor(fg)}) on ${
            explicitBg ? bgDecls[bgDecls.length - 1].val : "default bg"
          } (${formatColor(bg)}) has contrast ${ratio.toFixed(2)}:1 (< 4.5:1)`
        );
      }
    }

    // Rule 4: outline: none / outline: 0 without replacement focus style in the same rule set
    const outlineRemoval = rule.declarations.find(
      (d) => d.prop === "outline" && /^(none|0)(\s*!important)?$/i.test(d.val.trim())
    );
    if (outlineRemoval) {
      const hasReplacement = rule.declarations.some((d) => {
        if (d === outlineRemoval) return false;
        const v = d.val.replace(/!important/gi, "").trim().toLowerCase();
        if (!v || v === "none" || v === "0" || v === "transparent") return false;
        return (
          d.prop === "box-shadow" ||
          d.prop === "border" ||
          d.prop === "border-color" ||
          d.prop === "background" ||
          d.prop === "background-color" ||
          d.prop === "text-decoration"
        );
      });
      if (!hasReplacement) {
        addFinding(
          findings,
          file,
          baseLine + outlineRemoval.line - 1,
          "outline-without-focus-style",
          `"${rule.selector}" sets outline: ${outlineRemoval.val} without a replacement focus style in the same rule set`
        );
      }
    }

    // Rule 5: animations or transitions with no prefers-reduced-motion alternative in file
    if (!hasReducedMotionMedia) {
      for (const d of rule.declarations) {
        if (
          (d.prop === "animation" ||
            d.prop === "animation-name" ||
            d.prop === "transition" ||
            d.prop === "transition-property") &&
          !/^none(\s*!important)?$/i.test(d.val.trim())
        ) {
          addFinding(
            findings,
            file,
            baseLine + d.line - 1,
            "no-reduced-motion",
            `"${rule.selector}" uses ${d.prop}: ${d.val} with no @media (prefers-reduced-motion: reduce) in file`
          );
        }
      }
    }
  }

  return mergedVars;
}

/* ============================================================================
   HTML / TEMPLATE FRAGMENT SCANNER (Rules 1, 2, 6 + inline <style>)
   ============================================================================ */

function parseAttributes(attrStr) {
  const attrs = {};
  const re = /([a-zA-Z_:][a-zA-Z0-9_.:-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(attrStr)) !== null) {
    const name = m[1].toLowerCase();
    const val = m[2] ?? m[3] ?? m[4] ?? "";
    attrs[name] = val;
  }
  return attrs;
}

function hasAccessibleContent(innerHtml) {
  // Check for <img alt="..."> or <svg aria-label="..."> or __EXPR__ or non-empty text
  if (/aria-label\s*=\s*["'][^"']+["']/i.test(innerHtml)) return true;
  if (/<img\b[^>]*\balt\s*=\s*["'][^"']+["']/i.test(innerHtml)) return true;
  const textOnly = innerHtml
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .trim();
  return textOnly.length > 0;
}

function scanHtmlFragment(html, file, baseLine, findings, options = {}) {
  const { isTemplate = false, sharedVars = {} } = options;

  // Mask <script> and <style> when scanning HTML tags (for full HTML documents)
  let htmlForTags = html;
  if (!isTemplate) {
    // Scan <style> blocks with CSS scanner
    const styleRe = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
    let sm;
    while ((sm = styleRe.exec(html)) !== null) {
      const styleStart = sm.index + sm[0].indexOf(">") + 1;
      const styleLine = baseLine + lineAt(html, styleStart) - 1;
      scanCss(sm[1], file, styleLine, findings, sharedVars);
    }

    // Scan <script> blocks with JS scanner
    const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
    let jsm;
    while ((jsm = scriptRe.exec(html)) !== null) {
      if (/\bsrc\s*=/i.test(jsm[1])) continue;
      const scriptStart = jsm.index + jsm[0].indexOf(">") + 1;
      const scriptLine = baseLine + lineAt(html, scriptStart) - 1;
      scanJs(jsm[2], file, scriptLine, findings, html);
    }

    htmlForTags = html
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, preserveNewlines)
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, preserveNewlines)
      .replace(/<!--[\s\S]*?-->/g, preserveNewlines);
  } else {
    htmlForTags = html.replace(/<!--[\s\S]*?-->/g, preserveNewlines);
  }

  // Collect <label for="..."> IDs and <label>...</label> ranges
  const labelForIds = new Set();
  const labelRanges = [];
  const labelRe = /<label\b([^>]*)>([\s\S]*?)<\/label>/gi;
  let lm;
  while ((lm = labelRe.exec(htmlForTags)) !== null) {
    const attrs = parseAttributes(lm[1]);
    if (attrs.for) labelForIds.add(attrs.for);
    labelRanges.push([lm.index, lm.index + lm[0].length]);
  }
  const isInsideLabel = (idx) => labelRanges.some(([s, e]) => idx >= s && idx <= e);

  // Rule 1: <button> and <a> without accessible name
  const pairTagRe = /<(button|a)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  let pm;
  while ((pm = pairTagRe.exec(htmlForTags)) !== null) {
    const tag = pm[1].toLowerCase();
    const attrs = parseAttributes(pm[2]);
    const inner = pm[3];
    const line = baseLine + lineAt(htmlForTags, pm.index) - 1;

    const hasAriaLabel = Boolean((attrs["aria-label"] || "").trim());
    const hasAriaLabelledBy = Boolean((attrs["aria-labelledby"] || "").trim());
    const hasTitle = Boolean((attrs.title || "").trim());
    const hasText = hasAccessibleContent(inner);

    if (!hasAriaLabel && !hasAriaLabelledBy && !hasTitle && !hasText) {
      addFinding(
        findings,
        file,
        line,
        "accessible-name",
        `<${tag}> has no accessible name (text, aria-label, aria-labelledby, or title)`
      );
    }
  }

  // Rule 1: <input> without label or aria-label
  const inputRe = /<input\b([^>]*)\/?>/gi;
  let im;
  while ((im = inputRe.exec(htmlForTags)) !== null) {
    const attrs = parseAttributes(im[1]);
    const type = (attrs.type || "text").toLowerCase();
    if (type === "hidden") continue;
    if ("hidden" in attrs) continue;

    const line = baseLine + lineAt(htmlForTags, im.index) - 1;
    const hasAriaLabel = Boolean((attrs["aria-label"] || "").trim());
    const hasAriaLabelledBy = Boolean((attrs["aria-labelledby"] || "").trim());
    const hasForLabel = Boolean(attrs.id && labelForIds.has(attrs.id));
    const hasWrappingLabel = isInsideLabel(im.index);
    const hasButtonValue =
      (type === "submit" || type === "button" || type === "reset") &&
      Boolean((attrs.value || "").trim());

    if (!hasAriaLabel && !hasAriaLabelledBy && !hasForLabel && !hasWrappingLabel && !hasButtonValue) {
      addFinding(
        findings,
        file,
        line,
        "accessible-name",
        `<input type="${type}"> has no associated <label> or aria-label`
      );
    }
  }

  // Rule 2: onclick on non-interactive div/span without role and tabindex
  // Rule 6: positive tabindex values on any tag
  const anyTagRe = /<([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/g;
  let tm;
  while ((tm = anyTagRe.exec(htmlForTags)) !== null) {
    const tag = tm[1].toLowerCase();
    const attrs = parseAttributes(tm[2]);
    const line = baseLine + lineAt(htmlForTags, tm.index) - 1;

    if ((tag === "div" || tag === "span") && "onclick" in attrs) {
      const hasRole = Boolean((attrs.role || "").trim());
      const hasTabindex = "tabindex" in attrs && attrs.tabindex.trim() !== "";
      if (!hasRole || !hasTabindex) {
        addFinding(
          findings,
          file,
          line,
          "clickable-non-interactive",
          `<${tag}> has onclick without ${!hasRole && !hasTabindex ? "role and tabindex" : !hasRole ? "role" : "tabindex"}`
        );
      }
    }

    if ("tabindex" in attrs) {
      const rawTi = attrs.tabindex.trim();
      if (/^[+]?\d+$/.test(rawTi) && Number(rawTi) > 0) {
        addFinding(
          findings,
          file,
          line,
          "positive-tabindex",
          `<${tag} tabindex="${rawTi}"> uses a positive tabindex`
        );
      }
    }
  }
}

/* ============================================================================
   JAVASCRIPT SCANNER (Rules 1, 2, 6)
   ============================================================================ */

function scanJs(jsText, file, baseLine, findings, hostHtml = "") {
  // 1. Scan HTML template literals (using a lightweight tokenizer so comments/strings are respected)
  const n = jsText.length;
  let idx = 0;

  while (idx < n) {
    const ch = jsText[idx];
    // Line comment
    if (ch === "/" && jsText[idx + 1] === "/") {
      const nl = jsText.indexOf("\n", idx);
      idx = nl === -1 ? n : nl + 1;
      continue;
    }
    // Block comment
    if (ch === "/" && jsText[idx + 1] === "*") {
      const end = jsText.indexOf("*/", idx + 2);
      idx = end === -1 ? n : end + 2;
      continue;
    }
    // Single/double string
    if (ch === "'" || ch === '"') {
      const q = ch;
      const start = idx + 1;
      idx++;
      while (idx < n) {
        if (jsText[idx] === "\\") {
          idx += 2;
          continue;
        }
        if (jsText[idx] === q) {
          idx++;
          break;
        }
        idx++;
      }
      const val = jsText.slice(start, idx - 1);
      if (/<(?:button|a|input|div|span)\b/i.test(val)) {
        const strLine = baseLine + lineAt(jsText, start) - 1;
        scanHtmlFragment(val, file, strLine, findings, { isTemplate: true });
      }
      continue;
    }
    // Template literal
    if (ch === "`") {
      const tplStart = idx;
      idx++;
      let masked = "";
      while (idx < n) {
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
          idx += 2;
          let depth = 1;
          let expr = "";
          while (idx < n && depth > 0) {
            if (jsText[idx] === "{") depth++;
            else if (jsText[idx] === "}") depth--;
            if (depth > 0) expr += jsText[idx];
            idx++;
          }
          masked += "__EXPR__" + expr.replace(/[^\n]/g, "");
          continue;
        }
        masked += c;
        idx++;
      }
      if (/<[a-zA-Z][^>]*>/.test(masked)) {
        const tplLine = baseLine + lineAt(jsText, tplStart) - 1;
        scanHtmlFragment(masked, file, tplLine, findings, { isTemplate: true });
      }
      continue;
    }
    idx++;
  }

  // 2. Scan document.createElement("button" | "a" | "input" | "div" | "span")
  const lines = jsText.split(/\r?\n/);
  const createRe = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*document\.createElement\(\s*["'](button|a|input|div|span)["']\s*\)/;

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(createRe);
    if (!m) continue;
    const varName = m[1];
    const tag = m[2].toLowerCase();
    const lineNum = baseLine + i;

    // Collect window of lines in the same block until next createElement or return or 30 lines
    const windowLines = [];
    for (let j = i; j < Math.min(lines.length, i + 30); j++) {
      if (j > i && createRe.test(lines[j])) break;
      windowLines.push(lines[j]);
      if (j > i && /^\s*return\b/.test(lines[j])) break;
    }
    const block = windowLines.join("\n");
    const esc = varName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    if (tag === "button" || tag === "a") {
      const hasName =
        new RegExp(`\\b${esc}\\.(?:textContent|innerText|innerHTML|ariaLabel|title)\\s*=`).test(block) ||
        new RegExp(`\\b${esc}\\.setAttribute\\(\\s*["'](?:aria-label|aria-labelledby|title)["']`).test(block) ||
        new RegExp(`\\b${esc}\\.appendChild\\(`).test(block) ||
        new RegExp(`\\b${esc}\\.append\\(`).test(block);
      if (!hasName) {
        addFinding(
          findings,
          file,
          lineNum,
          "accessible-name",
          `document.createElement("${tag}") (${varName}) has no accessible name`
        );
      }
    } else if (tag === "input") {
      const isHidden = new RegExp(`\\b${esc}\\.type\\s*=\\s*["']hidden["']`).test(block);
      if (!isHidden) {
        const hasName =
          new RegExp(`\\b${esc}\\.ariaLabel\\s*=`).test(block) ||
          new RegExp(`\\b${esc}\\.setAttribute\\(\\s*["'](?:aria-label|aria-labelledby)["']`).test(block) ||
          /label\.(?:htmlFor|appendChild|append|setAttribute\(\s*["']for["'])/.test(block);
        if (!hasName) {
          addFinding(
            findings,
            file,
            lineNum,
            "accessible-name",
            `document.createElement("input") (${varName}) has no label or aria-label`
          );
        }
      }
    } else if (tag === "div" || tag === "span") {
      const clickMatch = block.match(
        new RegExp(`\\b${esc}\\.(?:addEventListener\\(\\s*["']click["']|onclick\\s*=)`)
      );
      if (clickMatch) {
        const hasRole =
          new RegExp(`\\b${esc}\\.setAttribute\\(\\s*["']role["']`).test(block) ||
          new RegExp(`\\b${esc}\\.role\\s*=`).test(block);
        const hasTabindex =
          new RegExp(`\\b${esc}\\.setAttribute\\(\\s*["']tabindex["']`).test(block) ||
          new RegExp(`\\b${esc}\\.tabIndex\\s*=`).test(block);
        if (!hasRole || !hasTabindex) {
          addFinding(
            findings,
            file,
            lineNum,
            "clickable-non-interactive",
            `document.createElement("${tag}") (${varName}) has click handler without ${
              !hasRole && !hasTabindex ? "role and tabindex" : !hasRole ? "role" : "tabindex"
            }`
          );
        }
      }
    }
  }

  // 3. Positive tabindex in JS (.tabIndex = N or .setAttribute("tabindex", "N"))
  for (let i = 0; i < lines.length; i++) {
    const lineNum = baseLine + i;
    const propMatch = lines[i].match(/\.tabIndex\s*=\s*(\d+)/);
    if (propMatch && Number(propMatch[1]) > 0) {
      addFinding(
        findings,
        file,
        lineNum,
        "positive-tabindex",
        `tabIndex = ${propMatch[1]} uses a positive tabindex`
      );
    }
    const attrMatch = lines[i].match(/\.setAttribute\(\s*["']tabindex["']\s*,\s*["']?(\d+)["']?\s*\)/i);
    if (attrMatch && Number(attrMatch[1]) > 0) {
      addFinding(
        findings,
        file,
        lineNum,
        "positive-tabindex",
        `setAttribute("tabindex", "${attrMatch[1]}") uses a positive tabindex`
      );
    }
  }
}

/* ============================================================================
   MAIN
   ============================================================================ */

function main() {
  const { root } = parseArgs(process.argv.slice(2));
  const findings = [];

  // Load workspace/styles.css vars first if available so workspace.html / app.js can reference them if needed
  let workspaceVars = {};
  const stylesPath = path.join(root, "ui/workspace/styles.css");
  if (fs.existsSync(stylesPath)) {
    workspaceVars = parseCssBlocks(fs.readFileSync(stylesPath, "utf8")).vars;
  }

  for (const relPath of TARGET_FILES) {
    const absPath = path.join(root, relPath);
    if (!fs.existsSync(absPath)) {
      addFinding(findings, relPath, 1, "missing-file", `Target file not found: ${relPath}`);
      continue;
    }
    const content = fs.readFileSync(absPath, "utf8");
    if (relPath.endsWith(".css")) {
      scanCss(content, relPath, 1, findings);
    } else if (relPath.endsWith(".js")) {
      scanJs(content, relPath, 1, findings);
    } else if (relPath.endsWith(".html")) {
      scanHtmlFragment(content, relPath, 1, findings, { sharedVars: workspaceVars });
    }
  }

  for (const f of findings) {
    console.log(`${f.file}:${f.line}: ${f.rule}: ${f.detail}`);
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
