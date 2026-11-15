#!/usr/bin/env node
/**
 * Starts AgentNotch with CA_INSPECT=1, optionally opens the panel (when --open,
 * --scenario, CA_FIXTURE, or CA_URL is set), prints bounds and page text, and quits cleanly.
 * Always terminates only the spawned app even on error or timeout (< 30s total).
 *
 * Usage:
 *   node notch/inspect-check.mjs
 *   CA_FIXTURE=working-live node notch/inspect-check.mjs
 *   CA_URL="http://127.0.0.1:8765/?t=TOKEN" node notch/inspect-check.mjs
 *   node notch/inspect-check.mjs --fixture working-live --open
 *   node notch/inspect-check.mjs --scenario --fixture working-live --view graph file1.txt file2.png
 *   node notch/inspect-check.mjs --scenario --all-surfaces --out /tmp/ca-surfaces
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const defaultBin = path.join(repoRoot, "notch/build/AgentNotch.app/Contents/MacOS/AgentNotch");
const binPath = process.env.NOTCH_BIN || defaultBin;

const ALL_WORKSPACE_VIEWS = [
  "graph",
  "state-machine",
  "logs",
  "analytics",
  "artifacts",
  "memory",
  "agent-settings",
  "app-settings",
  "onboarding",
];

function parseArgs(argv) {
  let openPanel = false;
  let scenario = false;
  let allSurfaces = false;
  let fixture = process.env.CA_FIXTURE || "";
  let url = process.env.CA_URL || "";
  let view = "graph";
  let captureDir = "";
  const dropFiles = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--open") {
      openPanel = true;
    } else if (arg === "--scenario") {
      scenario = true;
      openPanel = true;
    } else if (arg === "--all-surfaces") {
      allSurfaces = true;
      scenario = true;
      openPanel = true;
    } else if (arg === "--fixture" && argv[i + 1]) {
      fixture = argv[++i];
      openPanel = true;
    } else if (arg === "--url" && argv[i + 1]) {
      url = argv[++i];
      openPanel = true;
    } else if (arg === "--view" && argv[i + 1]) {
      view = argv[++i];
    } else if ((arg === "--capture-dir" || arg === "--out") && argv[i + 1]) {
      captureDir = argv[++i];
    } else if (arg === "--drop" && argv[i + 1]) {
      dropFiles.push(path.resolve(argv[++i]));
    } else if (!arg.startsWith("-")) {
      dropFiles.push(path.resolve(arg));
    }
  }

  if (allSurfaces && !fixture.trim() && !url.trim()) {
    fixture = "workspace-demo";
  }

  if (fixture.trim() || url.trim()) {
    openPanel = true;
  }

  return {
    openPanel,
    scenario,
    allSurfaces,
    fixture: fixture.trim(),
    url: url.trim(),
    view: view.trim() || "graph",
    captureDir: captureDir.trim(),
    dropFiles,
  };
}

if (!fs.existsSync(binPath)) {
  console.error(`Missing binary: ${binPath}. Run: bash notch/package/package.sh`);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pollUntil(fn, timeoutMs, intervalMs = 120, label = "condition") {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const val = await fn();
      if (val) return val;
    } catch (err) {
      lastErr = err;
    }
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label}${lastErr ? `: ${lastErr.message}` : ""}`);
}

function assertValidPng(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Capture file missing: ${filePath}`);
  }
  const stat = fs.statSync(filePath);
  if (stat.size < 16) {
    throw new Error(`Capture file too small (${stat.size} bytes): ${filePath}`);
  }
  const head = fs.readFileSync(filePath).subarray(0, 8);
  const pngSig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!head.equals(pngSig)) {
    throw new Error(`Capture file is not a valid PNG: ${filePath}`);
  }
  return stat.size;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const timeoutMs = opts.allSurfaces ? 55_000 : opts.scenario ? 25_000 : 15_000;
  const env = { ...process.env, CA_INSPECT: "1" };
  if (opts.fixture) env.CA_FIXTURE = opts.fixture;
  if (opts.url) env.CA_URL = opts.url;

  const child = spawn(binPath, [], {
    cwd: repoRoot,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const pending = new Map();
  let stderrBuf = "";
  child.stderr.on("data", (chunk) => {
    stderrBuf += chunk.toString("utf8");
  });

  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on("line", (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const resolver = pending.get(msg.id);
    if (resolver) {
      pending.delete(msg.id);
      resolver(msg);
    }
  });

  let nextId = 0;
  const send = (payload, cmdTimeoutMs = 5000) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out waiting for inspect response id=${id} (${payload.cmd})`));
      }, cmdTimeoutMs);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`);
    });
  };

  const hardTimer = setTimeout(() => {
    try { child.kill("SIGKILL"); } catch {}
  }, timeoutMs);
  hardTimer.unref();

  try {
    const notchStartMs = Date.now();
    // Wait until WKWebView has loaded ui/index.html (not about:blank) and initialized body.dataset.state.
    await pollUntil(async () => {
      const res = await send({
        cmd: "eval",
        target: "notch",
        js: "({ ready: document.readyState, href: location.href, state: document.body?.dataset?.state || null, hasTrigger: Boolean(document.getElementById('pill-trigger')), textLen: (document.body?.innerText || '').trim().length })",
      }, 6000);
      if (!res.ok || !res.result || typeof res.result !== "object") return false;
      const r = res.result;
      if (r.ready !== "complete" || !r.hasTrigger || !r.state || String(r.href).startsWith("about:")) {
        return false;
      }
      if ((opts.fixture || opts.url) && r.textLen === 0) {
        return false;
      }
      return r;
    }, 15000, 150, "notch webview ready");

    if (opts.openPanel) {
      const openRes = await send({ cmd: "open" });
      if (!openRes.ok) {
        throw new Error(`Failed to open panel: ${JSON.stringify(openRes)}`);
      }
      await pollUntil(async () => {
        const stateRes = await send({
          cmd: "eval",
          target: "notch",
          js: "if (document.body?.dataset?.state !== 'expanded') { document.getElementById('pill-trigger')?.click(); } document.body?.dataset?.state || null;",
        }, 2000);
        return stateRes.ok && stateRes.result === "expanded" ? stateRes : false;
      }, 4000, 100, "panel expanded");
    }

    // Wait (bounded) until the notch page has left its initial "… Loading" skeleton state.
    let notchLoadInfo = { dataArrived: false, leftLoadingState: false, elapsedMs: 0 };
    try {
      const loaded = await pollUntil(async () => {
        const res = await send({
          cmd: "eval",
          target: "notch",
          js: `(() => {
            const tl = document.getElementById('timeline-scroll');
            const tlText = (tl?.innerText || '').trim();
            const bodyText = (document.body?.innerText || '').trim();
            const hasSkeleton = Boolean(tl?.querySelector('.skeleton-line'));
            const stillLoading = hasSkeleton || /^(\\u2026|\\.{3})\\s*Loading$/i.test(tlText) || bodyText.includes('\\u2026 Loading');
            if (stillLoading) return false;
            return {
              leftLoadingState: true,
              dataArrived: tlText.length > 0 && !tlText.includes('Paste the address the backend printed'),
              timelinePreview: tlText.slice(0, 160),
            };
          })()`,
        }, 2000);
        return res.ok && res.result ? res.result : false;
      }, 8000, 100, "notch left loading state");
      notchLoadInfo = {
        dataArrived: Boolean(loaded.dataArrived),
        leftLoadingState: true,
        elapsedMs: Date.now() - notchStartMs,
      };
    } catch (err) {
      notchLoadInfo = {
        dataArrived: false,
        leftLoadingState: false,
        elapsedMs: Date.now() - notchStartMs,
        error: err.message,
      };
    }
    console.log("notchLoad:", JSON.stringify(notchLoadInfo));

    if (opts.openPanel) {
      await sleep(220);
    }

    const bounds = await send({ cmd: "bounds" });
    console.log("bounds:", JSON.stringify(bounds));
    if (!bounds.ok || !bounds.panel) {
      throw new Error(`Invalid bounds response: ${JSON.stringify(bounds)}`);
    }
    if (bounds.panel.isKey !== false) {
      throw new Error(`Inspect mode panel stole key focus without focus:true: ${JSON.stringify(bounds.panel)}`);
    }

    if (opts.scenario) {
      const capDir = opts.captureDir || path.join(os.tmpdir(), `agentnotch-inspect-${process.pid}`);
      fs.mkdirSync(capDir, { recursive: true });

      if (opts.dropFiles.length > 0) {
        const dropRes = await send({ cmd: "drop", target: "notch", paths: opts.dropFiles });
        console.log("drop:", JSON.stringify(dropRes));
        if (!dropRes.ok) {
          throw new Error(`Drop failed: ${JSON.stringify(dropRes)}`);
        }
        await sleep(400);
      }

      const panelTextRes = await send({ cmd: "eval", target: "notch", js: "document.body.innerText" });
      console.log("pageText:", JSON.stringify(panelTextRes));
      if (!panelTextRes.ok || !String(panelTextRes.result || "").trim()) {
        throw new Error(`Notch page text empty or eval failed: ${JSON.stringify(panelTextRes)}`);
      }

      const panelPng = path.join(capDir, "panel.png");
      const capPanelRes = await send({ cmd: "capture", surface: "panel", path: panelPng });
      if (!capPanelRes.ok) {
        throw new Error(`Panel capture failed: ${JSON.stringify(capPanelRes)}`);
      }
      const panelBytes = assertValidPng(panelPng);
      console.log("panelCapture:", JSON.stringify({ ...capPanelRes, bytes: panelBytes }));
      if (opts.allSurfaces) {
        const openNotchPng = path.join(capDir, "notch-open.png");
        fs.copyFileSync(panelPng, openNotchPng);
        const openNotchBounds = await send({ cmd: "bounds" });
        console.log("openNotchFrame:", JSON.stringify(openNotchBounds.panel));
        console.log("openNotchCapture:", JSON.stringify({ path: openNotchPng, bytes: panelBytes }));

        // Capture collapsed notch pill
        await send({ cmd: "collapse" });
        await pollUntil(async () => {
          const st = await send({
            cmd: "eval",
            target: "notch",
            js: "document.body?.dataset?.state || null",
          }, 2000);
          return st.ok && st.result === "collapsed" ? st : false;
        }, 3000, 80, "notch collapsed");
        await sleep(120);
        const collapsedBounds = await send({ cmd: "bounds" });
        console.log("collapsedNotchFrame:", JSON.stringify(collapsedBounds.panel));
        const collapsedNotchPng = path.join(capDir, "notch-collapsed.png");
        const capCollapsedRes = await send({ cmd: "capture", surface: "panel", path: collapsedNotchPng });
        if (!capCollapsedRes.ok) {
          throw new Error(`Collapsed notch capture failed: ${JSON.stringify(capCollapsedRes)}`);
        }
        const collapsedBytes = assertValidPng(collapsedNotchPng);
        console.log("collapsedNotchCapture:", JSON.stringify({ ...capCollapsedRes, bytes: collapsedBytes }));

        // Re-open notch so full-screen capture shows the open notch alongside the other surfaces
        await send({ cmd: "open" });
        await pollUntil(async () => {
          const st = await send({
            cmd: "eval",
            target: "notch",
            js: "document.body?.dataset?.state || null",
          }, 2000);
          return st.ok && st.result === "expanded" ? st : false;
        }, 3000, 80, "notch re-expanded");
        await sleep(100);
      }

      // Check if notes / pending-approval card surface has rendered cards at top right.
      if (opts.allSurfaces) {
        await pollUntil(async () => {
          const b = await send({ cmd: "bounds" });
          return b.ok && b.notes && b.notes.visible && b.notes.height > 20 ? b.notes : false;
        }, 4000, 100, "approval card visible at top right").catch(() => null);
      }
      const notesEval = await send({
        cmd: "eval",
        target: "notes",
        js: "({ text: (document.body?.innerText || '').trim(), cards: document.querySelectorAll('.note, .note-card, [data-help-card], [data-help-id], button').length })",
      }, 2000).catch(() => null);
      const latestBoundsBeforeWs = await send({ cmd: "bounds" });
      if (latestBoundsBeforeWs.ok && latestBoundsBeforeWs.notes && latestBoundsBeforeWs.notes.visible) {
        console.log("notesBounds:", JSON.stringify(latestBoundsBeforeWs.notes));
        if (opts.allSurfaces) {
          console.log("approvalCardFrame:", JSON.stringify(latestBoundsBeforeWs.notes));
        }
        if (notesEval?.ok) {
          console.log("notesText:", JSON.stringify(notesEval.result));
        }
        const notesPng = path.join(capDir, "notes.png");
        const capNotesRes = await send({ cmd: "capture", surface: "notes", path: notesPng });
        if (capNotesRes.ok) {
          const notesBytes = assertValidPng(notesPng);
          console.log("notesCapture:", JSON.stringify({ ...capNotesRes, bytes: notesBytes }));
          if (opts.allSurfaces) {
            const approvalPng = path.join(capDir, "approval-card.png");
            fs.copyFileSync(notesPng, approvalPng);
            console.log("approvalCardCapture:", JSON.stringify({ path: approvalPng, bytes: notesBytes }));
          }
        } else if (opts.allSurfaces) {
          throw new Error(`Approval card capture failed: ${JSON.stringify(capNotesRes)}`);
        }
      } else if (opts.allSurfaces) {
        throw new Error(`Approval card surface not visible for --all-surfaces: ${JSON.stringify(latestBoundsBeforeWs.notes)}`);
      }

      const wsStartMs = Date.now();
      const wsFixture = opts.allSurfaces ? (opts.fixture || "workspace-demo") : opts.fixture;
      const wsOpenPayload = {
        cmd: "openWorkspace",
        mode: "window",
        view: opts.allSurfaces ? "graph" : opts.view,
        instant: true,
      };
      if (wsFixture) wsOpenPayload.fixture = wsFixture;
      const wsOpenRes = await send(wsOpenPayload);
      if (!wsOpenRes.ok) {
        throw new Error(`Failed to open workspace window: ${JSON.stringify(wsOpenRes)}`);
      }

      await pollUntil(async () => {
        const wsReady = await send({
          cmd: "eval",
          target: "workspace",
          js: "({ ready: document.readyState, href: location.href, textLen: (document.body?.innerText || '').trim().length })",
        }, 2000);
        if (!wsReady.ok || !wsReady.result || typeof wsReady.result !== "object") return false;
        const r = wsReady.result;
        return r.ready === "complete" && !String(r.href).startsWith("about:") && r.textLen > 0 ? r : false;
      }, 6000, 120, "workspace window ready");

      // Wait (bounded) until the workspace page has left its initial "Loading…" state.
      let wsLoadInfo = { dataArrived: false, leftLoadingState: false, elapsedMs: 0 };
      try {
        const wsLoaded = await pollUntil(async () => {
          const res = await send({
            cmd: "eval",
            target: "workspace",
            js: `(() => {
              const pill = (document.getElementById('conn-pill')?.innerText || '').trim();
              const sub = (document.getElementById('HeaderSubtext')?.innerText || '').trim();
              const bodyText = (document.body?.innerText || '').trim();
              const stillLoading =
                pill.includes('Loading') ||
                sub === 'Loading\\u2026' ||
                bodyText.includes('Loading workspace') ||
                bodyText.includes('\\u2026 Loading');
              if (stillLoading) return false;
              const dataArrived =
                !bodyText.includes('Paste the address the backend printed') &&
                !bodyText.includes('Not connected') &&
                bodyText.length > 0;
              return {
                leftLoadingState: true,
                dataArrived,
                connPill: pill,
                headerSubtext: sub,
              };
            })()`,
          }, 2000);
          return res.ok && res.result ? res.result : false;
        }, 8000, 100, "workspace left loading state");
        wsLoadInfo = {
          dataArrived: Boolean(wsLoaded.dataArrived),
          leftLoadingState: true,
          elapsedMs: Date.now() - wsStartMs,
          connPill: wsLoaded.connPill || "",
          headerSubtext: wsLoaded.headerSubtext || "",
        };
      } catch (err) {
        wsLoadInfo = {
          dataArrived: false,
          leftLoadingState: false,
          elapsedMs: Date.now() - wsStartMs,
          error: err.message,
        };
      }
      console.log("workspaceLoad:", JSON.stringify(wsLoadInfo));
      await sleep(150);

      const wsBounds = await send({ cmd: "bounds" });
      console.log("workspaceBounds:", JSON.stringify(wsBounds.workspace));
      if (
        !wsBounds.ok ||
        !wsBounds.workspace ||
        wsBounds.workspace.isKey !== false ||
        wsBounds.workspace.width < 560 ||
        wsBounds.workspace.title !== "" ||
        wsBounds.workspace.fullSizeContentView !== true ||
        wsBounds.workspace.titlebarAppearsTransparent !== true ||
        wsBounds.workspace.titleVisibilityHidden !== true ||
        wsBounds.workspace.trafficLights?.close?.x !== 16 ||
        wsBounds.workspace.trafficLights?.close?.y !== 12 ||
        wsBounds.workspace.trafficLights?.close?.visible !== true
      ) {
        throw new Error(`Invalid workspace window bounds/title/trafficLights: ${JSON.stringify(wsBounds.workspace)}`);
      }

      const wsTextRes = await send({ cmd: "eval", target: "workspace", js: "document.body.innerText" });
      console.log("workspaceText:", JSON.stringify(wsTextRes));
      if (!wsTextRes.ok || !String(wsTextRes.result || "").trim()) {
        throw new Error(`Workspace text empty or eval failed: ${JSON.stringify(wsTextRes)}`);
      }

      const wsPng = path.join(capDir, "workspace-sheet.png");
      const capWsRes = await send({ cmd: "capture", surface: "workspace", path: wsPng });
      if (!capWsRes.ok) {
        throw new Error(`Workspace capture failed: ${JSON.stringify(capWsRes)}`);
      }
      const wsBytes = assertValidPng(wsPng);
      console.log("workspaceCapture:", JSON.stringify({ ...capWsRes, bytes: wsBytes }));

      if (opts.allSurfaces) {
        for (const vName of ALL_WORKSPACE_VIEWS) {
          await send({
            cmd: "eval",
            target: "workspace",
            js: `(() => {
              if (window.location.hash !== "#${vName}") {
                window.location.hash = "#${vName}";
              }
              const item = document.querySelector('[data-view="${vName}"]');
              if (item) item.click();
              return window.location.hash;
            })()`,
          }, 2000);
          await sleep(180);
          const vBounds = await send({ cmd: "bounds" });
          console.log(`workspaceFrame[${vName}]:`, JSON.stringify(vBounds.workspace));
          const vPng = path.join(capDir, `workspace-${vName}.png`);
          const vCap = await send({ cmd: "capture", surface: "workspace", path: vPng });
          if (!vCap.ok) {
            throw new Error(`Workspace view capture failed (${vName}): ${JSON.stringify(vCap)}`);
          }
          const vBytes = assertValidPng(vPng);
          console.log(`workspaceCapture[${vName}]:`, JSON.stringify({ ...vCap, view: vName, bytes: vBytes }));
        }
        // Return workspace to graph view so the full-screen capture shows graph + open notch + approval card
        await send({
          cmd: "eval",
          target: "workspace",
          js: `(() => { window.location.hash = "#graph"; document.querySelector('[data-view="graph"]')?.click(); return true; })()`,
        }, 2000);
        await sleep(150);
        const fullBounds = await send({ cmd: "bounds" });
        console.log("fullScreenFrames:", JSON.stringify({
          panel: fullBounds.panel,
          notes: fullBounds.notes,
          workspace: fullBounds.workspace,
        }));
        const fullScreenPng = path.join(capDir, "full-screen.png");
        const capScreenRes = await send({ cmd: "capture", surface: "screen", path: fullScreenPng }, 8000);
        if (!capScreenRes.ok) {
          throw new Error(`Full-screen capture failed: ${JSON.stringify(capScreenRes)}`);
        }
        const screenBytes = assertValidPng(fullScreenPng);
        const altFullScreenPng = path.join(capDir, "fullscreen.png");
        fs.copyFileSync(fullScreenPng, altFullScreenPng);
        console.log("fullScreenCapture:", JSON.stringify({ ...capScreenRes, bytes: screenBytes }));
      }

      // Opening workspace on agent-settings then requesting app-settings must switch the visible view.
      const openAgentRes = await send({
        cmd: "openWorkspace",
        mode: "window",
        view: "agent-settings",
        instant: true,
        ...(wsFixture ? { fixture: wsFixture } : {}),
      });
      if (!openAgentRes.ok) {
        throw new Error(`Failed to open workspace on agent-settings: ${JSON.stringify(openAgentRes)}`);
      }
      await pollUntil(async () => {
        const res = await send({
          cmd: "eval",
          target: "workspace",
          js: `(() => {
            const p = document.querySelector('[data-view-panel="agent-settings"]');
            const label = (document.getElementById('view-menu-label')?.innerText || '').trim();
            const q = new URLSearchParams(window.location.search).get('view');
            return Boolean(p && !p.hidden && label === 'Agent settings' && q === 'agent-settings');
          })()`,
        }, 2000);
        return res.ok && res.result === true ? true : false;
      }, 4000, 100, "workspace visible view is agent-settings");

      const openAppRes = await send({
        cmd: "openWorkspace",
        mode: "window",
        view: "app-settings",
        instant: true,
        ...(wsFixture ? { fixture: wsFixture } : {}),
      });
      if (!openAppRes.ok) {
        throw new Error(`Failed to switch workspace to app-settings: ${JSON.stringify(openAppRes)}`);
      }
      const switchedView = await pollUntil(async () => {
        const res = await send({
          cmd: "eval",
          target: "workspace",
          js: `(() => {
            const agentP = document.querySelector('[data-view-panel="agent-settings"]');
            const appP = document.querySelector('[data-view-panel="app-settings"]');
            const label = (document.getElementById('view-menu-label')?.innerText || '').trim();
            const q = new URLSearchParams(window.location.search).get('view');
            if (appP && !appP.hidden && agentP && agentP.hidden && label === 'App settings' && q === 'app-settings') {
              return { label, view: q };
            }
            return false;
          })()`,
        }, 2000);
        return res.ok && res.result ? res.result : false;
      }, 3000, 100, "workspace visible view changed from agent-settings to app-settings");
      console.log("workspaceViewSwitch:", JSON.stringify(switchedView));
    } else {
      let textRes = await send({ cmd: "eval", target: "notch", js: "document.body.innerText" });
      if (textRes.ok && (!textRes.result || String(textRes.result).trim() === "")) {
        await sleep(800);
        textRes = await send({ cmd: "eval", target: "notch", js: "document.body.innerText" });
      }
      console.log("pageText:", JSON.stringify(textRes));
      if (!textRes.ok || !String(textRes.result || "").trim()) {
        throw new Error(`Notch page text empty or eval failed: ${JSON.stringify(textRes)}`);
      }
    }

    const quitRes = await send({ cmd: "quit" }, 2000).catch(() => null);
    if (quitRes) console.log("quit:", JSON.stringify(quitRes));
  } finally {
    clearTimeout(hardTimer);
    rl.close();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => {
        const t = setTimeout(() => {
          try { child.kill("SIGKILL"); } catch {}
          resolve();
        }, 1500);
        child.once("exit", () => {
          clearTimeout(t);
          resolve();
        });
      });
    }
    if (stderrBuf.trim()) {
      console.error("stderr:", stderrBuf.trim());
    }
  }
}

main().catch((err) => {
  console.error("FAIL:", err.message || err);
  process.exit(1);
});
