#!/usr/bin/env node
/**
 * Mechanical check for the self-contained static demo bundle:
 *   1. Builds the bundle via ui/deploy/build-static.sh into a temp folder
 *      (or inspects --bundle-dir <dir> when testing negative controls).
 *   2. Verifies bundle hygiene (no dotfiles, tests, deploy files, backend/, notch/,
 *      or files over 2 MB).
 *   3. Serves the bundle with an in-process Node HTTP server mounted under a sub-path
 *      (/agent-monitor-demo), returning 404 outside that sub-path.
 *   4. Requests the top page and every referenced page, script, stylesheet, and
 *      sample JSON file (parsing src, href, CSS url(), and sample fetch() calls),
 *      failing on any 404 or path escaping the sub-path.
 *   5. Fails on any absolute /... reference, token-looking string, /Users/ path,
 *      or forbidden screen words from ui/tests/screen-words-check.mjs.
 *   6. Always stops its HTTP server and deletes the temp folder.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { runScreenWordsCheck } from "./screen-words-check.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const UI_ROOT = path.resolve(__dirname, "..");
const BUILD_SCRIPT = path.join(UI_ROOT, "deploy", "build-static.sh");

const SUBPATH = "/agent-monitor-demo";
const MAX_FILE_BYTES = 2 * 1024 * 1024;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".txt": "text/plain; charset=utf-8",
};

const TOKEN_PATTERNS = [
  { name: "api-key-sk", re: /\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{20,}\b/g },
  { name: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{30,}\b/g },
  { name: "github-token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g },
  { name: "github-pat", re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { name: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: "aws-key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "bearer-token", re: /\bBearer\s+[A-Za-z0-9._-]{20,}\b/g },
  { name: "private-key", re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g },
  { name: "query-token", re: /[?&](?:t|token)=[A-Za-z0-9._-]{16,}/g },
];

const FORBIDDEN_DIRS = new Set(["tests", "deploy", "backend", "notch", "docs", "node_modules"]);
const FORBIDDEN_FILES = new Set(["Dockerfile", "nginx.conf", "deploy.sh", "build-static.sh"]);

function parseArgs(argv) {
  let bundleDir = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--bundle-dir" && argv[i + 1]) {
      bundleDir = path.resolve(argv[++i]);
    }
  }
  return { bundleDir };
}

function addFinding(findings, target, rule, detail) {
  findings.push({
    target,
    rule,
    detail: String(detail || "").replace(/\s+/g, " ").trim(),
  });
}

function decodeHtmlEntities(str) {
  return String(str || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function lineAt(source, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source.charCodeAt(i) === 10) line++;
  }
  return line;
}

function walkFiles(dir, baseDir = dir, out = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    const rel = path.relative(baseDir, abs).replace(/\\/g, "/");
    if (entry.isDirectory()) {
      out.push({ abs, rel, isDir: true, name: entry.name });
      walkFiles(abs, baseDir, out);
    } else if (entry.isFile()) {
      const stat = fs.statSync(abs);
      out.push({ abs, rel, isDir: false, name: entry.name, size: stat.size });
    }
  }
  return out;
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

function isSkippableRef(val) {
  const s = val.trim();
  return !s || s.startsWith("data:") || s.startsWith("#") || s.startsWith("mailto:") || s.startsWith("javascript:");
}

function isAbsoluteOrExternalRef(val) {
  const s = val.trim();
  if (s.startsWith("/")) return true;
  if (/^(?:[a-zA-Z][a-zA-Z0-9+.-]*:|\/\/)/.test(s)) return true;
  return false;
}

function checkHygieneAndSizes(entries, findings) {
  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      addFinding(findings, entry.rel, "dotfile-in-bundle", `Unexpected dot-entry "${entry.rel}"`);
    }
    const topSeg = entry.rel.split("/")[0];
    if (entry.isDir && FORBIDDEN_DIRS.has(topSeg)) {
      addFinding(findings, entry.rel, "forbidden-dir", `Forbidden directory "${entry.rel}" in bundle`);
    }
    if (!entry.isDir) {
      if (FORBIDDEN_FILES.has(entry.name) || entry.name.endsWith(".mjs") || entry.name.endsWith(".md")) {
        addFinding(findings, entry.rel, "forbidden-file", `Forbidden file "${entry.rel}" in bundle`);
      }
      if (entry.size > MAX_FILE_BYTES) {
        addFinding(
          findings,
          entry.rel,
          "file-too-large",
          `File size ${entry.size} bytes exceeds ${MAX_FILE_BYTES} bytes`
        );
      }
    }
  }
}

function checkForbiddenContent(bundleDir, files, findings) {
  for (const file of files) {
    if (file.isDir) continue;
    const text = fs.readFileSync(file.abs, "utf8");
    const lines = text.split(/\r?\n/);

    for (const pat of TOKEN_PATTERNS) {
      pat.re.lastIndex = 0;
      let m;
      while ((m = pat.re.exec(text)) !== null) {
        const ln = lineAt(text, m.index);
        addFinding(
          findings,
          `${file.rel}:${ln}`,
          `token-looking-string (${pat.name})`,
          `Matched "${m[0].slice(0, 24)}..."`
        );
      }
    }

    lines.forEach((lineText, idx) => {
      const lineNum = idx + 1;
      // Fail on any /Users/<name> path or bare /Users/ outside the sanitizer guard in workspace/app.js
      if (/\/Users\/[^\s"'`<>)]+/.test(lineText)) {
        addFinding(findings, `${file.rel}:${lineNum}`, "users-path", lineText.trim().slice(0, 120));
      } else if (/\/Users\//.test(lineText)) {
        const isSanitizerGuard =
          file.rel === "workspace/app.js" &&
          /!s\.startsWith\(\s*["']\/Users\/["']\s*\)/.test(lineText);
        if (!isSanitizerGuard) {
          addFinding(findings, `${file.rel}:${lineNum}`, "users-path", lineText.trim().slice(0, 120));
        }
      }
    });
  }

  // Check words listed in ui/tests/screen-words-check.mjs across bundled HTML & non-vendor JS
  const screenWordTargets = [];
  for (const file of files) {
    if (file.isDir) continue;
    if (file.rel.startsWith("vendor/")) continue;
    if (!file.rel.endsWith(".html") && !file.rel.endsWith(".js")) continue;

    let checkRel = file.rel;
    if (file.rel === "index.html") checkRel = "demo/index.html";
    else if (file.rel === "notch.html") checkRel = "index.html";

    screenWordTargets.push({ rel: checkRel, abs: file.abs, bundleRel: file.rel });
  }

  const swFindings = runScreenWordsCheck(
    screenWordTargets.map((t) => ({ rel: t.rel, abs: t.abs }))
  );
  const relToBundle = new Map(screenWordTargets.map((t) => [t.rel, t.bundleRel]));
  for (const sw of swFindings) {
    const bundleRel = relToBundle.get(sw.file) || sw.file;
    addFinding(
      findings,
      `${bundleRel}:${sw.line}`,
      `screen-word (${sw.rule})`,
      `${sw.description}: ${JSON.stringify(sw.text)}`
    );
  }
}

function scanReferencesInHtml(html, relFile, findings) {
  const refs = [];
  const markup = stripScriptAndStyle(html);
  const attrRe = /\b(src|href|action)\s*=\s*["']([^"']*)["']/gi;
  let m;
  while ((m = attrRe.exec(markup)) !== null) {
    const attrName = m[1].toLowerCase();
    const val = decodeHtmlEntities(m[2]).trim();
    const ln = lineAt(html, m.index);
    if (isSkippableRef(val)) continue;
    if (isAbsoluteOrExternalRef(val)) {
      addFinding(
        findings,
        `${relFile}:${ln}`,
        "absolute-reference",
        `${attrName}="${val}" must be relative`
      );
      continue;
    }
    refs.push({ ref: val, line: ln, kind: attrName });
  }

  const scripts = extractScriptBlocks(html);
  for (const block of scripts) {
    // Check literal src/href assignments or template HTML src/href
    const assignRe = /(?:^|[^\w$])(?:src|href)\s*=\s*(["'`])([^"'`\r\n]+)\1/gi;
    let am;
    while ((am = assignRe.exec(block.code)) !== null) {
      const val = decodeHtmlEntities(am[2]).trim();
      const ln = block.baseLine + lineAt(block.code, am.index) - 1;
      if (isSkippableRef(val) || val.includes("${")) continue;
      if (isAbsoluteOrExternalRef(val)) {
        addFinding(
          findings,
          `${relFile}:${ln}`,
          "absolute-reference",
          `Script reference "${val}" must be relative`
        );
      } else if (/\.(?:html|js|css|json)(?:[?#]|$)/i.test(val)) {
        refs.push({ ref: val, line: ln, kind: "script-attr" });
      }
    }

    // Check template strings assigning page paths like `./notch.html?fixture=...`
    const tplPageRe = /`([^`\r\n]*\.(?:html|js|css|json)[^`\r\n]*)`/gi;
    let tm;
    while ((tm = tplPageRe.exec(block.code)) !== null) {
      const raw = tm[1].trim();
      const ln = block.baseLine + lineAt(block.code, tm.index) - 1;
      if (raw.startsWith("/")) {
        addFinding(
          findings,
          `${relFile}:${ln}`,
          "absolute-reference",
          `Template URL "${raw}" must be relative`
        );
      }
      // Capture static prefix before ${...} if it points to an HTML page
      const staticHtml = raw.match(/^([^$`]+\.html)(?:\?|$)/i);
      if (staticHtml && !isAbsoluteOrExternalRef(staticHtml[1])) {
        refs.push({ ref: staticHtml[1], line: ln, kind: "script-template" });
      }
    }

    // Check literal fetch(...) calls and new URL("./...", ...)
    scanJsFetchAndUrlCalls(block.code, block.baseLine, relFile, refs, findings);
  }

  return refs;
}

function scanJsFetchAndUrlCalls(code, baseLine, relFile, refs, findings) {
  const fetchLitRe = /\bfetch\s*\(\s*(["'`])([^"'`\r\n]+)\1/g;
  let fm;
  while ((fm = fetchLitRe.exec(code)) !== null) {
    const val = fm[2].trim();
    const ln = baseLine + lineAt(code, fm.index) - 1;
    if (isSkippableRef(val)) continue;
    if (val.startsWith("/") || /^(?:https?:|\/\/)/i.test(val)) {
      addFinding(
        findings,
        `${relFile}:${ln}`,
        "absolute-fetch",
        `fetch("${val}") must use a relative path`
      );
      continue;
    }
    if (!val.includes("${")) {
      refs.push({ ref: val, line: ln, kind: "fetch" });
    }
  }

  const newUrlRe = /\bnew\s+URL\s*\(\s*(["'])([^"'\r\n]+)\1/g;
  let um;
  while ((um = newUrlRe.exec(code)) !== null) {
    const val = um[2].trim();
    const ln = baseLine + lineAt(code, um.index) - 1;
    if (isSkippableRef(val)) continue;
    if (val.startsWith("/")) {
      addFinding(
        findings,
        `${relFile}:${ln}`,
        "absolute-reference",
        `new URL("${val}") must use a relative path`
      );
      continue;
    }
    if (!isAbsoluteOrExternalRef(val)) {
      refs.push({ ref: val, line: ln, kind: "new-URL" });
    }
  }
}

function scanCssUrls(css, relFile, findings) {
  const refs = [];
  const urlRe = /url\(\s*(?:(["'])([^"']+)\1|([^)\s]+))\s*\)/gi;
  let m;
  while ((m = urlRe.exec(css)) !== null) {
    const val = (m[2] || m[3] || "").trim();
    const ln = lineAt(css, m.index);
    if (isSkippableRef(val)) continue;
    if (isAbsoluteOrExternalRef(val)) {
      addFinding(
        findings,
        `${relFile}:${ln}`,
        "absolute-css-url",
        `CSS url(${val}) must be relative`
      );
      continue;
    }
    refs.push({ ref: val, line: ln, kind: "css-url" });
  }
  return refs;
}

function extractDemoSampleNames(demoHtml) {
  const samples = new Set();
  for (const m of demoHtml.matchAll(/fixture=([A-Za-z0-9_-]+)/g)) samples.add(m[1]);
  for (const m of demoHtml.matchAll(/data-(?:pill-)?sample=["']([^"']+)["']/g)) samples.add(m[1]);
  for (const m of demoHtml.matchAll(/select(?:Notch|Pill)Sample\(["']([^"']+)["']\)/g)) samples.add(m[1]);

  const declMatch = demoHtml.match(/\bconst\s+DEMO_STEPS\s*=\s*(\[[\s\S]*?\n\s*\])\s*;/);
  if (declMatch) {
    const steps = vm.runInNewContext(`(${declMatch[1]})`, Object.create(null), { timeout: 200 });
    for (const s of steps) {
      if (s?.fixture) samples.add(s.fixture);
      if (s?.pillFixture) samples.add(s.pillFixture);
    }
  }
  return [...samples].sort();
}

function extractSampleFetchTemplates(text) {
  const templates = [];
  const re = /\bfetch\s*\(\s*`([^`]*\$\{[^}]+\}[^`]*)`/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    templates.push(m[1]);
  }
  return templates;
}

function startStaticServer(bundleDir) {
  const resolvedRoot = path.resolve(bundleDir);
  const server = http.createServer((req, res) => {
    const reqUrl = new URL(req.url || "/", "http://127.0.0.1");
    const pathname = decodeURIComponent(reqUrl.pathname);

    if (pathname === SUBPATH) {
      res.writeHead(301, { Location: `${SUBPATH}/` });
      res.end();
      return;
    }
    if (!pathname.startsWith(`${SUBPATH}/`)) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found outside sub-path");
      return;
    }

    let relPath = pathname.slice(`${SUBPATH}/`.length);
    if (!relPath || relPath.endsWith("/")) {
      relPath += "index.html";
    }

    const filePath = path.resolve(resolvedRoot, relPath);
    if (filePath !== resolvedRoot && !filePath.startsWith(resolvedRoot + path.sep)) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Forbidden");
      return;
    }

    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    if (!stat.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
    fs.createReadStream(filePath).pipe(res);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, port: addr.port });
    });
  });
}

async function fetchChecked(urlObj, sourceDesc, findings, fetchedMap) {
  const key = `${urlObj.origin}${urlObj.pathname}`;
  if (!urlObj.pathname.startsWith(`${SUBPATH}/`)) {
    addFinding(
      findings,
      sourceDesc,
      "subpath-escape",
      `Resolved URL "${urlObj.pathname}" escapes sub-path "${SUBPATH}/"`
    );
    return null;
  }
  if (fetchedMap.has(key)) {
    return fetchedMap.get(key);
  }

  const res = await fetch(urlObj.toString());
  const body = await res.text();
  if (res.status !== 200) {
    addFinding(
      findings,
      sourceDesc,
      "http-not-200",
      `GET ${urlObj.pathname}${urlObj.search} returned HTTP ${res.status}`
    );
    fetchedMap.set(key, null);
    return null;
  }
  fetchedMap.set(key, body);
  return body;
}

async function main() {
  const { bundleDir: providedDir } = parseArgs(process.argv.slice(2));
  const ownsTempDir = !providedDir;
  const tempRoot = ownsTempDir
    ? fs.mkdtempSync(path.join(os.tmpdir(), "static-bundle-check-"))
    : null;
  const bundleDir = providedDir || path.join(tempRoot, "out");

  let server = null;
  const findings = [];

  try {
    if (ownsTempDir) {
      const buildRes = spawnSync("bash", [BUILD_SCRIPT, bundleDir], {
        encoding: "utf8",
      });
      if (buildRes.status !== 0 || buildRes.error) {
        addFinding(
          findings,
          "ui/deploy/build-static.sh",
          "build-failed",
          buildRes.error ? buildRes.error.message : (buildRes.stderr || buildRes.stdout || `exit ${buildRes.status}`)
        );
      }
    }

    if (!fs.existsSync(bundleDir) || !fs.statSync(bundleDir).isDirectory()) {
      addFinding(findings, bundleDir, "missing-bundle-dir", "Bundle directory does not exist");
    } else {
      const entries = walkFiles(bundleDir);
      checkHygieneAndSizes(entries, findings);
      checkForbiddenContent(bundleDir, entries, findings);

      const started = await startStaticServer(bundleDir);
      server = started.server;
      const baseUrl = `http://127.0.0.1:${started.port}${SUBPATH}/`;
      const fetched = new Map();

      const topUrl = new URL(baseUrl);
      const topHtml = await fetchChecked(topUrl, "index.html", findings, fetched);

      if (topHtml !== null) {
        const htmlQueue = [{ url: topUrl, rel: "index.html", html: topHtml }];
        const visitedHtml = new Set([topUrl.pathname]);
        const sampleNames = extractDemoSampleNames(topHtml);
        const sampleFetchHosts = new Map();

        while (htmlQueue.length > 0) {
          const current = htmlQueue.shift();
          const refs = scanReferencesInHtml(current.html, current.rel, findings);
          const tplFetches = extractSampleFetchTemplates(current.html);
          if (tplFetches.length > 0) {
            sampleFetchHosts.set(current.url.pathname, { url: current.url, templates: tplFetches, rel: current.rel });
          }

          for (const item of refs) {
            let targetUrl;
            try {
              targetUrl = new URL(item.ref, current.url);
            } catch {
              addFinding(findings, `${current.rel}:${item.line}`, "invalid-url", `Invalid URL "${item.ref}"`);
              continue;
            }

            if (targetUrl.origin !== topUrl.origin) {
              addFinding(findings, `${current.rel}:${item.line}`, "external-url", `External URL "${item.ref}"`);
              continue;
            }

            const body = await fetchChecked(targetUrl, `${current.rel}:${item.line}`, findings, fetched);
            if (body === null) continue;

            if (targetUrl.pathname.endsWith(".html") && !visitedHtml.has(targetUrl.pathname)) {
              visitedHtml.add(targetUrl.pathname);
              const targetRel = targetUrl.pathname.slice(`${SUBPATH}/`.length);
              htmlQueue.push({ url: targetUrl, rel: targetRel, html: body });
            } else if (targetUrl.pathname.endsWith(".css")) {
              const cssRel = targetUrl.pathname.slice(`${SUBPATH}/`.length);
              const cssRefs = scanCssUrls(body, cssRel, findings);
              for (const cr of cssRefs) {
                const cssTarget = new URL(cr.ref, targetUrl);
                await fetchChecked(cssTarget, `${cssRel}:${cr.line}`, findings, fetched);
              }
            } else if (targetUrl.pathname.endsWith(".js")) {
              const jsRel = targetUrl.pathname.slice(`${SUBPATH}/`.length);
              const jsRefs = [];
              if (!jsRel.startsWith("vendor/")) {
                scanJsFetchAndUrlCalls(body, 1, jsRel, jsRefs, findings);
                for (const jr of jsRefs) {
                  const jsTarget = new URL(jr.ref, current.url);
                  await fetchChecked(jsTarget, `${jsRel}:${jr.line}`, findings, fetched);
                }
                const jsTpl = extractSampleFetchTemplates(body);
                if (jsTpl.length > 0) {
                  sampleFetchHosts.set(current.url.pathname, {
                    url: current.url,
                    templates: [...(sampleFetchHosts.get(current.url.pathname)?.templates || []), ...jsTpl],
                    rel: jsRel,
                  });
                }
              }
            }
          }
        }

        // Verify every sample fetch template resolves and returns valid 200 JSON under the sub-path
        for (const host of sampleFetchHosts.values()) {
          for (const tpl of host.templates) {
            if (tpl.startsWith("/")) {
              addFinding(findings, host.rel, "absolute-fetch", `fetch(\`${tpl}\`) must be relative`);
              continue;
            }
            for (const sample of sampleNames) {
              const resolvedPath = tpl.replace(/\$\{[^}]+\}/g, sample);
              const sampleUrl = new URL(resolvedPath, host.url);
              const jsonText = await fetchChecked(
                sampleUrl,
                `${host.rel} (sample "${sample}")`,
                findings,
                fetched
              );
              if (jsonText !== null) {
                try {
                  JSON.parse(jsonText);
                } catch (err) {
                  addFinding(
                    findings,
                    sampleUrl.pathname,
                    "invalid-sample-json",
                    `Invalid JSON in ${resolvedPath}: ${err.message}`
                  );
                }
              }
            }
          }
        }
      }

      if (findings.length === 0) {
        console.log(
          `CHECK PASS (${fetched.size} URLs verified under ${SUBPATH}/, ${entries.filter((e) => !e.isDir).length} bundle files)`
        );
      }
    }
  } finally {
    if (server) {
      await new Promise((resolve) => server.close(() => resolve()));
    }
    if (ownsTempDir && tempRoot) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }

  if (findings.length > 0) {
    for (const f of findings) {
      console.error(`${f.target}: ${f.rule}: ${f.detail}`);
    }
    console.error(`CHECK FAIL (${findings.length} finding${findings.length === 1 ? "" : "s"})`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
