#!/usr/bin/env node
/**
 * B1b-L & A8 state machine layout overlap check.
 * Renders ?fixture=workspace-state-loop&view=state-machine and ?fixture=workspace-demo&view=state-machine
 * at 560, 720, 900, and 1280 px widths in headless Chrome, reads the bounding boxes of every
 * node (.sm-node-rect), label (.sm-edge-pill), and self-loop (.sm-self-loop), and fails if any
 * two intersect or if the page overflows horizontally.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  cleanupAll,
  killProcessTree,
  registerCleanup,
  spawnManaged,
} from "../tests/process-cleanup.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const UI_DIR = path.resolve(__dirname, "..");

const WIDTHS = [560, 720, 900, 1280];
const FIXTURES = ["workspace-state-loop", "workspace-demo", "workspace-state-branches", "workspace-state-filters"];
const NEGATIVE_CONTROL = process.argv.includes("--negative-control");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function findChrome() {
  const macCandidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ];
  for (const c of macCandidates) {
    if (fs.existsSync(c)) return c;
  }
  const res = spawnSync("which", ["google-chrome"], { encoding: "utf8" });
  return res.status === 0 ? res.stdout.trim() : null;
}

function startStaticServer(rootDir) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const reqUrl = new URL(req.url || "/", "http://127.0.0.1");
      let relPath = decodeURIComponent(reqUrl.pathname);
      if (relPath === "/") relPath = "/index.html";
      if (relPath.endsWith("/")) relPath += "index.html";
      const resolved = path.resolve(rootDir, "." + relPath);
      if (!resolved.startsWith(rootDir + path.sep) && resolved !== rootDir) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      const ext = path.extname(resolved).toLowerCase();
      res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream", "Cache-Control": "no-store" });
      fs.createReadStream(resolved).pipe(res);
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

function launchChrome(chromePath, userDataDir) {
  return new Promise((resolve, reject) => {
    const proc = spawnManaged(
      chromePath,
      [
        "--headless=new",
        "--remote-debugging-port=0",
        `--user-data-dir=${userDataDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-gpu",
        "--disable-background-networking",
        "about:blank",
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    let stderrBuf = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        killProcessTree(proc, "SIGKILL");
        reject(new Error("Timed out launching Chrome"));
      }
    }, 15000);
    proc.stderr.on("data", (chunk) => {
      stderrBuf += chunk.toString("utf8");
      const m = stderrBuf.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:(\d+)\/[^\s]+)/);
      if (m && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ proc, browserWsUrl: m[1] });
      }
    });
  });
}

function createCdpClient(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let nextId = 1;
    const pending = new Map();
    ws.addEventListener("open", () => {
      resolve({
        send(method, params = {}) {
          const id = nextId++;
          return new Promise((res, rej) => {
            pending.set(id, { res, rej, method });
            ws.send(JSON.stringify({ id, method, params }));
          });
        },
        close() {
          try { ws.close(); } catch {}
        },
      });
    });
    ws.addEventListener("message", (evt) => {
      const msg = JSON.parse(typeof evt.data === "string" ? evt.data : evt.data.toString());
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { res, rej, method } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(`${method}: ${msg.error.message}`));
        else res(msg.result);
      }
    });
    ws.addEventListener("error", (err) => reject(err));
  });
}

const CHECK_EXPR = `(() => {
  const vw = window.innerWidth;
  const docSw = document.documentElement.scrollWidth;
  const hOverflow = docSw > vw + 1;

  const nodes = Array.from(document.querySelectorAll(".sm-node-rect")).map((el, i) => ({
    kind: "node",
    id: el.getAttribute("data-node-id") || ("node-" + i),
    name: el.closest("g")?.querySelector("title")?.textContent || ("node-" + i),
    r: el.getBoundingClientRect(),
  }));
  const labels = Array.from(document.querySelectorAll(".sm-edge-pill")).map((el, i) => ({
    kind: "label",
    edgeId: el.closest("g")?.getAttribute("data-edge-id") || ("edge-" + i),
    name: el.closest("g")?.getAttribute("aria-label") || ("label-" + i),
    r: el.getBoundingClientRect(),
  }));
  const loops = Array.from(document.querySelectorAll(".sm-self-loop")).map((el, i) => ({
    kind: "self-loop",
    name: el.closest("g")?.getAttribute("aria-label") || ("loop-" + i),
    r: el.getBoundingClientRect(),
  }));
  const edges = Array.from(document.querySelectorAll(".sm-edge-group")).map((g, i) => ({
    edgeId: g.getAttribute("data-edge-id") || ("edge-" + i),
    fromId: g.getAttribute("data-from-id") || "",
    toId: g.getAttribute("data-to-id") || "",
    name: g.getAttribute("aria-label") || ("edge-" + i),
    path: g.querySelector(".sm-edge-path"),
  })).filter((e) => e.path);

  function rectsIntersect(a, b) {
    return a.left < b.right - 0.5 && a.right > b.left + 0.5 && a.top < b.bottom - 0.5 && a.bottom > b.top + 0.5;
  }

  function pointInRect(x, y, r, margin = 1) {
    return x > r.left + margin && x < r.right - margin && y > r.top + margin && y < r.bottom - margin;
  }

  const intersections = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      if (rectsIntersect(nodes[i].r, nodes[j].r)) {
        intersections.push(["node-node", nodes[i].name, nodes[j].name]);
      }
    }
  }
  for (const lbl of labels) {
    for (const nd of nodes) {
      if (rectsIntersect(lbl.r, nd.r)) {
        intersections.push(["label-node", lbl.name, nd.name]);
      }
    }
  }
  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++) {
      if (rectsIntersect(labels[i].r, labels[j].r)) {
        intersections.push(["label-label", labels[i].name, labels[j].name]);
      }
    }
  }
  for (const lbl of labels) {
    for (const lp of loops) {
      if (rectsIntersect(lbl.r, lp.r)) {
        intersections.push(["label-self-loop", lbl.name, lp.name]);
      }
    }
  }

  for (const ed of edges) {
    const ctm = ed.path.getScreenCTM();
    const totalLen = ed.path.getTotalLength();
    if (!ctm || !(totalLen > 16)) continue;
    const samples = 28;
    for (let s = 1; s < samples; s++) {
      const dist = (totalLen * s) / samples;
      if (dist < 6 || dist > totalLen - 6) continue;
      const pt = ed.path.getPointAtLength(dist);
      const cx = pt.x * ctm.a + pt.y * ctm.c + ctm.e;
      const cy = pt.x * ctm.b + pt.y * ctm.d + ctm.f;
      for (const nd of nodes) {
        if (nd.id === ed.fromId || nd.id === ed.toId) continue;
        if (pointInRect(cx, cy, nd.r, 1)) {
          intersections.push(["edge-node", ed.name, nd.name]);
          break;
        }
      }
      for (const lbl of labels) {
        if (lbl.edgeId === ed.edgeId) continue;
        if (pointInRect(cx, cy, lbl.r, 1)) {
          intersections.push(["edge-label", ed.name, lbl.name]);
          break;
        }
      }
    }
  }

  return {
    vw,
    docSw,
    hOverflow,
    nodeCount: nodes.length,
    labelCount: labels.length,
    loopCount: loops.length,
    intersections,
  };
})()`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const chromePath = findChrome();
  if (!chromePath) {
    console.error("Chrome not found");
    process.exit(1);
  }
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sm-layout-check-"));
  registerCleanup(() => fs.rmSync(userDataDir, { recursive: true, force: true }));

  const { server, port } = await startStaticServer(UI_DIR);
  registerCleanup(() => { try { server.close(); } catch {} });

  const { browserWsUrl } = await launchChrome(chromePath, userDataDir);
  const browserCdp = await createCdpClient(browserWsUrl);
  registerCleanup(() => browserCdp.close());

  const { targetId } = await browserCdp.send("Target.createTarget", { url: "about:blank" });
  const listRes = await fetch(`http://127.0.0.1:${browserWsUrl.match(/:(\d+)\//)[1]}/json/list`);
  const targets = await listRes.json();
  const pageTarget = targets.find((t) => t.id === targetId);
  const pageCdp = await createCdpClient(pageTarget.webSocketDebuggerUrl);
  registerCleanup(() => pageCdp.close());

  await pageCdp.send("Page.enable");
  await pageCdp.send("Runtime.enable");

  let failed = false;
  for (const fixture of FIXTURES) {
    for (const width of WIDTHS) {
      await pageCdp.send("Emulation.setDeviceMetricsOverride", {
        width,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      const url = `http://127.0.0.1:${port}/workspace.html?fixture=${encodeURIComponent(fixture)}&view=state-machine`;
      await pageCdp.send("Page.navigate", { url });
      for (let attempt = 0; attempt < 30; attempt++) {
        await sleep(100);
        const readyRes = await pageCdp.send("Runtime.evaluate", {
          expression: `document.querySelectorAll(".sm-node-rect").length > 0`,
          returnByValue: true,
        });
        if (readyRes.result.value) break;
      }
      await sleep(100);
      if (NEGATIVE_CONTROL) {
        await pageCdp.send("Runtime.evaluate", {
          expression: `(() => {
            const node = document.querySelector(".sm-node-rect");
            const pill = document.querySelector(".sm-edge-pill");
            if (node && pill) {
              pill.setAttribute("x", node.getAttribute("x"));
              pill.setAttribute("y", node.getAttribute("y"));
            }
          })()`,
        });
      }
      const evalRes = await pageCdp.send("Runtime.evaluate", {
        expression: CHECK_EXPR,
        returnByValue: true,
      });
      const d = evalRes.result.value;
      const ok = !d.hOverflow && d.nodeCount > 0 && d.labelCount > 0 && d.intersections.length === 0;
      const status = ok ? "PASS" : "FAIL";
      console.log(
        `${status} ${fixture} @ ${width}px: nodes=${d.nodeCount} labels=${d.labelCount} selfLoops=${d.loopCount} hOverflow=${d.hOverflow} intersections=${d.intersections.length}`
      );
      if (!ok) {
        failed = true;
        if (d.intersections.length) {
          console.log("  intersections:", JSON.stringify(d.intersections.slice(0, 5)));
        }
      }
    }
  }

  // Verify state-machine app and agent filters on workspace-state-filters at 900px
  await pageCdp.send("Emulation.setDeviceMetricsOverride", {
    width: 900,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await pageCdp.send("Page.navigate", {
    url: `http://127.0.0.1:${port}/workspace.html?fixture=workspace-state-filters&view=state-machine`,
  });
  for (let attempt = 0; attempt < 30; attempt++) {
    await sleep(100);
    const readyRes = await pageCdp.send("Runtime.evaluate", {
      expression: `document.querySelectorAll(".sm-node-rect").length > 0 && document.querySelector("#sm-app-select") !== null`,
      returnByValue: true,
    });
    if (readyRes.result.value) break;
  }
  await sleep(100);

  const filterListsRes = await pageCdp.send("Runtime.evaluate", {
    expression: `(() => ({
      apps: Array.from(document.querySelectorAll("#sm-app-select option")).map((o) => o.value),
      agents: Array.from(document.querySelectorAll("#sm-agent-select option")).map((o) => o.value),
    }))()`,
    returnByValue: true,
  });
  const filterLists = filterListsRes.result.value;
  let filterChecks = 0;

  async function runFilterCheck(appVal, agentVal, expectEmpty = false) {
    filterChecks += 1;
    await pageCdp.send("Runtime.evaluate", {
      expression: `(() => {
        const appSel = document.getElementById("sm-app-select");
        if (appSel) {
          appSel.value = ${JSON.stringify(appVal)};
          appSel.dispatchEvent(new Event("change", { bubbles: true }));
        }
        const agSel = document.getElementById("sm-agent-select");
        if (agSel) {
          agSel.value = ${JSON.stringify(agentVal)};
          agSel.dispatchEvent(new Event("change", { bubbles: true }));
        }
      })()`,
    });
    await sleep(80);
    const res = await pageCdp.send("Runtime.evaluate", {
      expression: `(() => {
        const check = ${CHECK_EXPR};
        const emptyMsg = document.querySelector("#b1b-content")?.textContent?.includes("No screen transitions recorded for this filter") || false;
        const remainingAgents = Array.from(document.querySelectorAll("#sm-agent-select option")).map((o) => o.value);
        return { ...check, emptyMsg, remainingAgents };
      })()`,
      returnByValue: true,
    });
    const d = res.result.value;
    const ok = expectEmpty
      ? !d.hOverflow && d.emptyMsg && d.nodeCount === 0
      : !d.hOverflow && d.nodeCount > 0 && d.labelCount > 0 && d.intersections.length === 0 && d.remainingAgents.length >= 4;
    console.log(
      `${ok ? "PASS" : "FAIL"} filter(app=${appVal}, agent=${agentVal || "all"}): nodes=${d.nodeCount} labels=${d.labelCount} emptyMsg=${d.emptyMsg} agentsInSelect=${d.remainingAgents.length} intersections=${d.intersections.length}`
    );
    if (!ok) failed = true;
  }

  for (const appVal of filterLists.apps.filter((v) => v !== "all")) {
    await runFilterCheck(appVal, "", false);
  }
  for (const agentVal of filterLists.agents.filter((v) => v !== "")) {
    await runFilterCheck("all", agentVal, false);
  }
  await runFilterCheck("Calculator", "Nora", true);

  cleanupAll();
  if (failed) {
    console.log("B1b-L CHECK FAIL");
    process.exit(1);
  }
  const totalChecks = FIXTURES.length * WIDTHS.length + filterChecks;
  console.log(`B1b-L CHECK PASS (${totalChecks}/${totalChecks} fixture x width & filter checks)`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  cleanupAll();
  process.exit(1);
});
