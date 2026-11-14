#!/usr/bin/env node
/**
 * Mechanical check for ui/demo/index.html:
 *   - Only uses relative URLs (excluding data: and # fragments)
 *   - Every state (fixture) and view it links to exists as a file/view in the repo
 *   - Play sequence (DEMO_STEPS) durations add up to 55-60 seconds
 *   - Every caption (initial caption and DEMO_STEPS captions) passes the copy rules
 *
 * Node built-ins only; no browser.
 * Exits 0 on CHECK PASS, 1 on CHECK FAIL.
 */

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(__dirname, "../..");

const DEMO_REL_PATH = "ui/demo/index.html";
const WORKSPACE_REL_PATH = "ui/workspace.html";
const NOTCH_REL_PATH = "ui/index.html";

function parseArgs(argv) {
  let root = process.env.DEMO_CHECK_ROOT || DEFAULT_ROOT;
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

function addFinding(findings, file, line, rule, detail) {
  const clean = String(detail || "").replace(/\s+/g, " ").trim();
  const snippet = clean.length > 140 ? clean.slice(0, 137) + "..." : clean;
  findings.push({ file, line, rule, detail: snippet });
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
   COPY RULES (aligned with copy-check.mjs)
   ============================================================================ */

const INTERNAL_FIELDS_RE = /\b(task_id|run\.id|root_id|claimed_by|n_events|help_kind)\b/;
const SECTION_ID_RE = /\b(?:A[1-9][a-z]?|B[1-9][a-z]?)\b/;
const FILE_PATH_RE =
  /(?:~\/|\/(?:tmp|Users|var|etc|opt|home|ui|backend|notch|docs)\/[A-Za-z0-9_.\-/]*|\b[A-Za-z0-9_.-]+\.(?:sqlite|db|py|mjs|html|css)\b)/;
const ALL_CAPS_RE = /(?<![A-Za-z])[A-Z]{4,}(?![A-Za-z])/g;
const EMOJI_RE =
  /(?:\p{Emoji_Presentation}|(?![▶◀▲▼])\p{Extended_Pictographic}\uFE0F?)/u;

function checkCaptionCopy(findings, file, line, rawCaption) {
  const decoded = decodeHtmlEntities(String(rawCaption || ""))
    .replace(/\s+/g, " ")
    .trim();

  if (!decoded) {
    addFinding(findings, file, line, "empty-caption", "Caption text is empty");
    return;
  }

  const withoutUrls = decoded.replace(/https?:\/\/[^\s"'`<>)]+/gi, " ");

  if (
    /\/api\//.test(decoded) ||
    /fixtures\//.test(decoded) ||
    /\.json\b/i.test(decoded) ||
    FILE_PATH_RE.test(withoutUrls) ||
    SECTION_ID_RE.test(withoutUrls)
  ) {
    addFinding(findings, file, line, "internal-ref-in-copy", decoded);
  }

  if (/\bAlways allow\b/i.test(decoded) || /\bAlways asks\b/i.test(decoded)) {
    addFinding(findings, file, line, "disallowed-approval-label", decoded);
  }

  if (INTERNAL_FIELDS_RE.test(decoded)) {
    addFinding(findings, file, line, "internal-field-name", decoded);
  }

  const capsMatches = withoutUrls.match(ALL_CAPS_RE);
  if (capsMatches && capsMatches.length > 0) {
    addFinding(findings, file, line, "all-caps-word", decoded);
  }

  if (EMOJI_RE.test(decoded)) {
    addFinding(findings, file, line, "emoji-in-copy", decoded);
  }
}

/* ============================================================================
   URL & REPO TARGET HELPERS
   ============================================================================ */

function isRelativeUrl(url) {
  const trimmed = url.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("#")) return true;
  if (/^(?:[a-zA-Z][a-zA-Z0-9+.-]*:|\/\/)/.test(trimmed)) return false;
  if (trimmed.startsWith("/")) return false;
  return true;
}

function fileExistsInRepo(root, absPath) {
  const rel = path.relative(root, absPath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return false;
  try {
    return fs.statSync(absPath).isFile();
  } catch {
    return false;
  }
}

function loadWorkspaceViews(root) {
  const views = new Set();
  const wsPath = path.join(root, WORKSPACE_REL_PATH);
  if (!fs.existsSync(wsPath)) return views;
  const content = fs.readFileSync(wsPath, "utf8");
  const re = /data-view-panel=["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    views.add(m[1]);
  }
  return views;
}

function stripScriptAndStyle(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, (m) => m.replace(/[^\n]/g, " "))
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, (m) => m.replace(/[^\n]/g, " "));
}

function extractScriptBlocks(html) {
  const blocks = [];
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const bodyStart = m.index + m[0].indexOf(">") + 1;
    blocks.push({
      code: m[1],
      baseLine: lineAt(html, bodyStart),
    });
  }
  return blocks;
}

function extractDemoSteps(scriptCode, baseLine) {
  const declMatch = scriptCode.match(/\bconst\s+DEMO_STEPS\s*=\s*(\[[\s\S]*?\n\s*\])\s*;/);
  if (!declMatch) return null;
  const line = baseLine + lineAt(scriptCode, declMatch.index) - 1;
  const steps = vm.runInNewContext(`(${declMatch[1]})`, Object.create(null), {
    timeout: 200,
  });
  return { steps, line, raw: declMatch[1] };
}

/* ============================================================================
   MAIN
   ============================================================================ */

function main() {
  const { root } = parseArgs(process.argv.slice(2));
  const findings = [];
  const demoPath = path.join(root, DEMO_REL_PATH);

  if (!fileExistsInRepo(root, demoPath)) {
    addFinding(findings, DEMO_REL_PATH, 1, "missing-file", `Target file not found: ${DEMO_REL_PATH}`);
    for (const f of findings) {
      console.log(`${f.file}:${f.line}: ${f.rule}: ${f.detail}`);
    }
    console.log(`CHECK FAIL (${findings.length} finding${findings.length === 1 ? "" : "s"})`);
    process.exit(1);
  }

  const html = fs.readFileSync(demoPath, "utf8");
  const demoDir = path.dirname(demoPath);
  const workspaceViews = loadWorkspaceViews(root);

  // 1. Check HTML href/src attributes (relative URLs + target file/fixture/view existence)
  const htmlOnly = stripScriptAndStyle(html);
  const attrUrlRe = /\b(href|src)\s*=\s*["']([^"']*)["']/gi;
  let attrMatch;
  while ((attrMatch = attrUrlRe.exec(htmlOnly)) !== null) {
    const attrName = attrMatch[1].toLowerCase();
    const rawVal = decodeHtmlEntities(attrMatch[2]).trim();
    const line = lineAt(html, attrMatch.index);

    if (rawVal.startsWith("data:") || rawVal.startsWith("#")) {
      continue;
    }

    if (!isRelativeUrl(rawVal)) {
      addFinding(
        findings,
        DEMO_REL_PATH,
        line,
        "non-relative-url",
        `${attrName}="${rawVal}" is not a relative URL`
      );
      continue;
    }

    const [withoutHash] = rawVal.split("#");
    const [urlPath, queryStr = ""] = withoutHash.split("?");
    if (urlPath) {
      const targetAbs = path.resolve(demoDir, urlPath);
      if (!fileExistsInRepo(root, targetAbs)) {
        addFinding(
          findings,
          DEMO_REL_PATH,
          line,
          "missing-target-file",
          `${attrName}="${rawVal}" points to missing file "${path.relative(root, targetAbs)}"`
        );
      }
    }

    const params = new URLSearchParams(queryStr);
    const fixture = params.get("fixture");
    if (fixture) {
      const fixturePath = path.join(root, "ui/fixtures", `${fixture}.json`);
      if (!fileExistsInRepo(root, fixturePath)) {
        addFinding(
          findings,
          DEMO_REL_PATH,
          line,
          "missing-fixture",
          `${attrName}="${rawVal}" references missing fixture "ui/fixtures/${fixture}.json"`
        );
      }
    }

    const view = params.get("view");
    if (view && workspaceViews.size > 0 && !workspaceViews.has(view)) {
      addFinding(
        findings,
        DEMO_REL_PATH,
        line,
        "missing-view",
        `${attrName}="${rawVal}" references unknown workspace view "${view}"`
      );
    }
  }

  // 2. Check data-sample and data-view controls in HTML
  const sampleBtnRe = /\bdata-sample\s*=\s*["']([^"']+)["']/gi;
  let sampleMatch;
  while ((sampleMatch = sampleBtnRe.exec(htmlOnly)) !== null) {
    const sampleName = sampleMatch[1].trim();
    const line = lineAt(html, sampleMatch.index);
    const fixturePath = path.join(root, "ui/fixtures", `${sampleName}.json`);
    if (!fileExistsInRepo(root, fixturePath)) {
      addFinding(
        findings,
        DEMO_REL_PATH,
        line,
        "missing-fixture",
        `data-sample="${sampleName}" references missing fixture "ui/fixtures/${sampleName}.json"`
      );
    }
  }

  const viewLinkRe = /\bdata-view\s*=\s*["']([^"']+)["']/gi;
  let viewMatch;
  while ((viewMatch = viewLinkRe.exec(htmlOnly)) !== null) {
    const viewName = viewMatch[1].trim();
    const line = lineAt(html, viewMatch.index);
    if (workspaceViews.size > 0 && !workspaceViews.has(viewName)) {
      addFinding(
        findings,
        DEMO_REL_PATH,
        line,
        "missing-view",
        `data-view="${viewName}" is not present in ${WORKSPACE_REL_PATH}`
      );
    }
  }

  // 3. Check initial caption copy in #demo-caption
  const initialCaptionMatch = htmlOnly.match(/<p\b[^>]*id=["']demo-caption["'][^>]*>([\s\S]*?)<\/p>/i);
  if (!initialCaptionMatch) {
    addFinding(findings, DEMO_REL_PATH, 1, "missing-caption", "Initial #demo-caption element not found");
  } else {
    const line = lineAt(html, initialCaptionMatch.index);
    checkCaptionCopy(findings, DEMO_REL_PATH, line, initialCaptionMatch[1]);
  }

  // 4. Inspect <script> blocks: non-relative URLs + DEMO_STEPS checks
  const scripts = extractScriptBlocks(html);
  let demoStepsInfo = null;

  for (const script of scripts) {
    const absUrlRe = /["'`]((?:https?:)?\/\/[^"'`\s]+|file:\/\/[^"'`\s]+)["'`]/gi;
    let absMatch;
    while ((absMatch = absUrlRe.exec(script.code)) !== null) {
      const line = script.baseLine + lineAt(script.code, absMatch.index) - 1;
      addFinding(
        findings,
        DEMO_REL_PATH,
        line,
        "non-relative-url",
        `Script contains non-relative URL ${absMatch[1]}`
      );
    }

    const rootSlashUrlRe = /(?:src|href)\s*=\s*["'`]\/[^/"'`][^"'`]*["'`]/gi;
    let slashMatch;
    while ((slashMatch = rootSlashUrlRe.exec(script.code)) !== null) {
      const line = script.baseLine + lineAt(script.code, slashMatch.index) - 1;
      addFinding(
        findings,
        DEMO_REL_PATH,
        line,
        "non-relative-url",
        `Script assigns root-relative URL (${slashMatch[0]})`
      );
    }

    if (!demoStepsInfo) {
      try {
        demoStepsInfo = extractDemoSteps(script.code, script.baseLine);
      } catch (err) {
        addFinding(
          findings,
          DEMO_REL_PATH,
          script.baseLine,
          "invalid-demo-steps",
          `Failed to parse DEMO_STEPS: ${err.message}`
        );
      }
    }
  }

  if (!demoStepsInfo || !Array.isArray(demoStepsInfo.steps) || demoStepsInfo.steps.length === 0) {
    addFinding(
      findings,
      DEMO_REL_PATH,
      1,
      "missing-demo-steps",
      "DEMO_STEPS array is missing or empty"
    );
  } else {
    const { steps, line: stepsLine } = demoStepsInfo;
    let totalDuration = 0;

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i] || {};
      const stepLabel = `Step ${i + 1} (${step.label || "unnamed"})`;

      // Duration check
      if (typeof step.duration !== "number" || !Number.isFinite(step.duration) || step.duration <= 0) {
        addFinding(
          findings,
          DEMO_REL_PATH,
          stepsLine,
          "invalid-step-duration",
          `${stepLabel} has invalid duration: ${step.duration}`
        );
      } else {
        totalDuration += step.duration;
      }

      // Target existence check
      if (step.target === "notch") {
        if (!fileExistsInRepo(root, path.join(root, NOTCH_REL_PATH))) {
          addFinding(
            findings,
            DEMO_REL_PATH,
            stepsLine,
            "missing-target-file",
            `${stepLabel} targets missing ${NOTCH_REL_PATH}`
          );
        }
        const fixturePath = path.join(root, "ui/fixtures", `${step.fixture || ""}.json`);
        if (!step.fixture || !fileExistsInRepo(root, fixturePath)) {
          addFinding(
            findings,
            DEMO_REL_PATH,
            stepsLine,
            "missing-fixture",
            `${stepLabel} references missing fixture "ui/fixtures/${step.fixture || ""}.json"`
          );
        }
      } else if (step.target === "workspace") {
        if (!fileExistsInRepo(root, path.join(root, WORKSPACE_REL_PATH))) {
          addFinding(
            findings,
            DEMO_REL_PATH,
            stepsLine,
            "missing-target-file",
            `${stepLabel} targets missing ${WORKSPACE_REL_PATH}`
          );
        }
        const wsFixturePath = path.join(root, "ui/fixtures/workspace-demo.json");
        if (!fileExistsInRepo(root, wsFixturePath)) {
          addFinding(
            findings,
            DEMO_REL_PATH,
            stepsLine,
            "missing-fixture",
            `${stepLabel} requires missing fixture "ui/fixtures/workspace-demo.json"`
          );
        }
        if (!step.view || (workspaceViews.size > 0 && !workspaceViews.has(step.view))) {
          addFinding(
            findings,
            DEMO_REL_PATH,
            stepsLine,
            "missing-view",
            `${stepLabel} references unknown workspace view "${step.view || ""}"`
          );
        }
      } else {
        addFinding(
          findings,
          DEMO_REL_PATH,
          stepsLine,
          "invalid-step-target",
          `${stepLabel} has unknown target "${step.target}"`
        );
      }

      // Caption copy check
      checkCaptionCopy(findings, DEMO_REL_PATH, stepsLine, step.caption);
    }

    if (totalDuration < 55 || totalDuration > 60) {
      addFinding(
        findings,
        DEMO_REL_PATH,
        stepsLine,
        "duration-out-of-range",
        `DEMO_STEPS total duration is ${totalDuration}s (expected 55-60s)`
      );
    }
  }

  for (const f of findings) {
    console.log(`${f.file}:${f.line}: ${f.rule}: ${f.detail}`);
  }

  if (findings.length === 0) {
    const durationSummary =
      demoStepsInfo && Array.isArray(demoStepsInfo.steps)
        ? `${demoStepsInfo.steps.length} steps, ${demoStepsInfo.steps.reduce((s, x) => s + (x.duration || 0), 0)}s`
        : "0 findings";
    console.log(`CHECK PASS (${durationSummary})`);
    process.exit(0);
  } else {
    console.log(`CHECK FAIL (${findings.length} finding${findings.length === 1 ? "" : "s"})`);
    process.exit(1);
  }
}

main();
