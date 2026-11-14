#!/usr/bin/env node
/**
 * Snapshot-by-snapshot replay checker for recorded (or synthetic) live backend sessions.
 * Replays each JSONL snapshot through both:
 *   1) Notch WorkspaceAdapter (from ui/index.html)
 *   2) Workspace WorkspaceAdapter (from ui/workspace/app.js)
 *
 * Usage:
 *   node ui/tests/replay-check.mjs [path/to/recording.jsonl]
 * Defaults to ui/tests/recordings/synthetic-qa-approval.jsonl.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const UI_DIR = path.resolve(__dirname, "..");
const INDEX_HTML_PATH = path.join(UI_DIR, "index.html");
const APP_JS_PATH = path.join(UI_DIR, "workspace", "app.js");
const DEFAULT_RECORDING = path.join(__dirname, "recordings", "synthetic-qa-approval.jsonl");

function loadNotchAdapterFromIndexHtml() {
  const html = fs.readFileSync(INDEX_HTML_PATH, "utf8");
  const startMarker = "const WorkspaceAdapter = (function () {";
  const startIdx = html.indexOf(startMarker);
  assert.ok(startIdx !== -1, "Could not locate WorkspaceAdapter in ui/index.html");

  const returnMarker = "return { mapRuns };";
  const returnIdx = html.indexOf(returnMarker, startIdx);
  assert.ok(returnIdx !== -1, "Could not locate WorkspaceAdapter return statement in ui/index.html");

  const endMarker = "})();";
  const endIdx = html.indexOf(endMarker, returnIdx);
  assert.ok(endIdx !== -1, "Could not locate end of WorkspaceAdapter IIFE in ui/index.html");

  const adapterSource = html.slice(startIdx, endIdx + endMarker.length) + "\n;WorkspaceAdapter;";
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

  const adapter = vm.runInContext(adapterSource, context, { filename: "ui/index.html#WorkspaceAdapter" });
  assert.equal(typeof adapter?.mapRuns, "function", "Notch WorkspaceAdapter.mapRuns must be a function");
  return adapter;
}

function loadWorkspaceAdapterFromAppJs(nowMsRef) {
  const src = fs.readFileSync(APP_JS_PATH, "utf8");

  let presetStart = src.indexOf("const SharedGlass =");
  if (presetStart === -1) {
    presetStart = src.indexOf("const QUIET_PRESET =");
  }
  assert.ok(presetStart !== -1, "Could not locate SharedGlass or QUIET_PRESET in ui/workspace/app.js");

  const mountedMarker = "const mountedGlassByContainer = new Map();";
  const mountedIdx = src.indexOf(mountedMarker, presetStart);
  assert.ok(mountedIdx !== -1, "Could not locate mountedGlassByContainer in ui/workspace/app.js");

  const onboardingStart = src.indexOf("const OnboardingState = {", mountedIdx);
  assert.ok(onboardingStart !== -1, "Could not locate OnboardingState in ui/workspace/app.js");

  const adapterStart = src.indexOf("const WorkspaceAdapter = (function () {", onboardingStart);
  assert.ok(adapterStart !== -1, "Could not locate WorkspaceAdapter in ui/workspace/app.js");

  const returnMarker = "return {\n      buildViewModel,\n      formatSeconds,\n    };";
  const returnIdx = src.indexOf(returnMarker, adapterStart);
  assert.ok(returnIdx !== -1, "Could not locate WorkspaceAdapter return block in ui/workspace/app.js");

  const endMarker = "})();";
  const endIdx = src.indexOf(endMarker, returnIdx);
  assert.ok(endIdx !== -1, "Could not locate end of WorkspaceAdapter IIFE in ui/workspace/app.js");

  const extractedSource = [
    src.slice(presetStart, mountedIdx),
    src.slice(onboardingStart, endIdx + endMarker.length),
    "({ WorkspaceAdapter, OnboardingState, AGENT_SWATCHES });",
  ].join("\n\n");

  class MutableFixedDate extends Date {
    static now() {
      return nowMsRef.value;
    }
  }

  const context = vm.createContext({
    window: {},
    Date: MutableFixedDate,
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
  return exported.WorkspaceAdapter;
}

function parseElapsedText(text) {
  const s = String(text || "").trim();
  if (!s || s === "—") return null;
  let total = 0;
  let matched = false;
  const hMatch = s.match(/(\d+(?:\.\d+)?)h/);
  if (hMatch) {
    total += Number(hMatch[1]) * 3600;
    matched = true;
  }
  const mMatch = s.match(/(\d+(?:\.\d+)?)m/);
  if (mMatch) {
    total += Number(mMatch[1]) * 60;
    matched = true;
  }
  const sMatch = s.match(/(\d+(?:\.\d+)?)s/);
  if (sMatch) {
    total += Number(sMatch[1]);
    matched = true;
  }
  return matched ? total : null;
}

function hasNullCostForRun(runId, detailsById, costsById) {
  const costEntry = costsById?.[runId];
  if (costEntry && costEntry.cost_usd === null) return true;
  const evs = Array.isArray(detailsById?.[runId]?.events) ? detailsById[runId].events : [];
  const llmEvs = evs.filter((e) => e && e.kind === "llm");
  if (llmEvs.length > 0 && llmEvs.some((e) => e.cost === null) && llmEvs.every((e) => e.cost == null || e.cost === 0)) {
    return true;
  }
  return false;
}

function loadSnapshots(filePath) {
  assert.ok(fs.existsSync(filePath), `Recording file not found: ${filePath}`);
  const lines = fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  assert.ok(lines.length > 0, `Recording file is empty: ${filePath}`);
  return lines.map((line, idx) => {
    try {
      return JSON.parse(line);
    } catch (err) {
      throw new Error(`Invalid JSON on line ${idx + 1} of ${filePath}: ${err.message}`);
    }
  });
}

function runReplay(filePath) {
  const snapshots = loadSnapshots(filePath);
  const nowMsRef = { value: (snapshots[0].t || Date.now() / 1000) * 1000 };
  const notchAdapter = loadNotchAdapterFromIndexHtml();
  const wsAdapter = loadWorkspaceAdapterFromAppJs(nowMsRef);

  const detailsById = {};
  const rememberedAgentsById = {};
  const notchIdentityByStepId = new Map();
  const wsIdentityByRunId = new Map();
  const lastRawElapsedById = new Map();
  const lastNotchElapsedById = new Map();
  const lastWsElapsedById = new Map();

  let sawEmptyAgentsAfterNonEmpty = false;
  let sawAnyAgents = false;

  for (let i = 0; i < snapshots.length; i++) {
    const snap = snapshots[i];
    const stepLabel = `snapshot[${i}] (${snap.ts || snap.t || i})`;
    const nowSec = typeof snap.t === "number" ? snap.t : nowMsRef.value / 1000;
    nowMsRef.value = nowSec * 1000;

    const runs = Array.isArray(snap.runs) ? snap.runs : [];
    const help = Array.isArray(snap.help) ? snap.help : [];
    const agents = snap.agents && typeof snap.agents === "object" ? snap.agents : {};
    const costsById = snap.costs && typeof snap.costs === "object" ? snap.costs : {};
    const transcriptsById = snap.transcripts && typeof snap.transcripts === "object" ? snap.transcripts : {};

    if (Object.keys(agents).length > 0) {
      sawAnyAgents = true;
      for (const [k, v] of Object.entries(agents)) {
        if (v && typeof v === "object") {
          rememberedAgentsById[k] = { ...v };
        }
      }
    } else if (sawAnyAgents) {
      sawEmptyAgentsAfterNonEmpty = true;
    }

    for (const [runId, delta] of Object.entries(snap.run_deltas || {})) {
      const prev = detailsById[runId] || { events: [] };
      const since = typeof delta.since === "number" ? delta.since : 0;
      const incoming = Array.isArray(delta.events) ? delta.events : [];
      const mergedEvents = prev.events.slice(0, since).concat(incoming);
      detailsById[runId] = { ...prev, ...delta, events: mergedEvents };
    }
    for (const r of runs) {
      if (r && r.id && detailsById[r.id]) {
        detailsById[r.id] = {
          ...detailsById[r.id],
          state: r.state,
          elapsed: r.elapsed,
          result: r.result,
          n_events: r.n_events,
        };
      }
    }

    const notchVm = notchAdapter.mapRuns(runs, detailsById, help, {
      connectionStatus: "connected",
      isSampleData: false,
      agentsById: agents,
      rememberedAgentsById,
      costsById,
      transcriptsById,
      nowSec,
    });

    const wsVm = wsAdapter.buildViewModel({
      rawRuns: runs,
      detailsById,
      pendingHelp: help,
      rawAgents: agents,
      rawActions: [],
      rawGraph: null,
      rawAnalytics: null,
      costsById,
      transcriptsByRunId: transcriptsById,
      searchedTranscriptRows: null,
      sentAttachmentsByRunId: new Map(),
      connectionStatus: "connected",
      connectionError: "",
      isSampleData: false,
      selectedTaskRunId: null,
      selectedAgentId: null,
      selectedAppFilter: "all",
      logSearchQuery: "",
      logStatusFilter: "all",
    });

    const rawRunById = new Map(runs.map((r) => [r.id, r]));

    // 1. No check mark before lead run is done with result.ok === true
    for (const mappedRun of notchVm.runs) {
      const rawLead = rawRunById.get(mappedRun.id);
      const leadOk = Boolean(rawLead && rawLead.state === "done" && rawLead.result && rawLead.result.ok === true);
      if (!leadOk) {
        assert.ok(
          !String(mappedRun.stateSymbolWord || "").includes("✓"),
          `${stepLabel} notch run ${mappedRun.id} has check mark before lead done+ok: ${mappedRun.stateSymbolWord}`
        );
        assert.ok(
          !String(mappedRun.stateFact || "").includes("✓"),
          `${stepLabel} notch run ${mappedRun.id} stateFact has check mark before lead done+ok: ${mappedRun.stateFact}`
        );
        assert.ok(
          !String(mappedRun.pillFact || "").includes("✓"),
          `${stepLabel} notch run ${mappedRun.id} pillFact has check mark before lead done+ok: ${mappedRun.pillFact}`
        );
      }
    }
    for (const group of wsVm.taskGroups) {
      const rawLead = rawRunById.get(group.id);
      const leadOk = Boolean(rawLead && rawLead.state === "done" && rawLead.result && rawLead.result.ok === true);
      if (!leadOk) {
        assert.ok(
          !String(group.overallStatus?.word || "").includes("✓"),
          `${stepLabel} workspace group ${group.id} has check mark before lead done+ok: ${group.overallStatus?.word}`
        );
        assert.ok(
          !String(group.overallStatus?.symbol || "").includes("✓"),
          `${stepLabel} workspace group ${group.id} symbol has check mark before lead done+ok: ${group.overallStatus?.symbol}`
        );
      }
    }

    // 2. Approval shown only while its help request is pending
    const pendingHelpIds = new Set(help.filter((h) => h && h.answer == null).map((h) => h.id));
    const notchShownHelpIds = new Set();
    for (const mappedRun of notchVm.runs) {
      for (const h of mappedRun.pendingHelp || []) {
        assert.ok(
          pendingHelpIds.has(h.id),
          `${stepLabel} notch showed non-pending approval ${h.id}`
        );
        notchShownHelpIds.add(h.id);
      }
    }
    for (const h of help) {
      if (h && h.answer == null && rawRunById.has(h.run)) {
        assert.ok(
          notchShownHelpIds.has(h.id),
          `${stepLabel} notch omitted pending approval ${h.id}`
        );
      }
    }
    const wsShownHelpIds = new Set();
    for (const a of wsVm.approvals) {
      assert.ok(
        pendingHelpIds.has(a.id),
        `${stepLabel} workspace showed non-pending approval ${a.id}`
      );
      wsShownHelpIds.add(a.id);
    }
    assert.equal(
      wsShownHelpIds.size,
      pendingHelpIds.size,
      `${stepLabel} workspace approvals count (${wsShownHelpIds.size}) != pending help count (${pendingHelpIds.size})`
    );

    // 3. Agent keeps its name and colors for the whole run, also after /api/agents becomes empty
    for (const mappedRun of notchVm.runs) {
      for (const step of mappedRun.steps || []) {
        const name = step.agentIdentity?.name || "";
        const color = step.agentIdentity?.color || "";
        const prev = notchIdentityByStepId.get(step.id);
        if (prev) {
          assert.equal(
            name,
            prev.name,
            `${stepLabel} notch step ${step.id} agent name changed from "${prev.name}" to "${name}"`
          );
          assert.equal(
            color,
            prev.color,
            `${stepLabel} notch step ${step.id} agent color changed from "${prev.color}" to "${color}"`
          );
        } else if (name && color) {
          notchIdentityByStepId.set(step.id, { name, color });
        }
      }
    }
    for (const group of wsVm.taskGroups) {
      for (const node of group.childNodes || []) {
        const name = node.agentName || "";
        const color = node.palette?.bg || node.palette?.accent || node.palette?.border || "";
        const prev = wsIdentityByRunId.get(node.runId);
        if (prev) {
          assert.equal(
            name,
            prev.name,
            `${stepLabel} workspace node ${node.runId} agent name changed from "${prev.name}" to "${name}"`
          );
          assert.equal(
            color,
            prev.color,
            `${stepLabel} workspace node ${node.runId} agent color changed from "${prev.color}" to "${color}"`
          );
        } else if (name && color) {
          wsIdentityByRunId.set(node.runId, { name, color });
        }
      }
    }

    // 4. Elapsed time never goes backwards
    for (const r of runs) {
      if (typeof r.elapsed === "number") {
        const prev = lastRawElapsedById.get(r.id);
        if (prev !== undefined) {
          assert.ok(
            r.elapsed >= prev,
            `${stepLabel} raw elapsed for ${r.id} went backwards: ${prev} -> ${r.elapsed}`
          );
        }
        lastRawElapsedById.set(r.id, r.elapsed);
      }
    }
    for (const mappedRun of notchVm.runs) {
      const parsed = parseElapsedText(mappedRun.elapsedText);
      if (parsed !== null) {
        const prev = lastNotchElapsedById.get(mappedRun.id);
        if (prev !== undefined) {
          assert.ok(
            parsed >= prev,
            `${stepLabel} notch elapsedText for ${mappedRun.id} went backwards: ${prev}s -> ${parsed}s (${mappedRun.elapsedText})`
          );
        }
        lastNotchElapsedById.set(mappedRun.id, parsed);
      }
    }
    for (const group of wsVm.taskGroups) {
      for (const node of group.allNodes || []) {
        const parsed = parseElapsedText(node.elapsedText);
        if (parsed !== null) {
          const prev = lastWsElapsedById.get(node.runId);
          if (prev !== undefined) {
            assert.ok(
              parsed >= prev,
              `${stepLabel} workspace elapsedText for ${node.runId} went backwards: ${prev}s -> ${parsed}s (${node.elapsedText})`
            );
          }
          lastWsElapsedById.set(node.runId, parsed);
        }
      }
    }

    // 5. A null cost is never shown as 0
    for (const mappedRun of notchVm.runs) {
      const childIds = (mappedRun.steps || []).map((s) => s.id);
      const anyNullCost = [mappedRun.id, ...childIds].some((id) => hasNullCostForRun(id, detailsById, costsById));
      if (anyNullCost && mappedRun.digest) {
        const costText = String(mappedRun.digest.costText || "");
        assert.ok(
          costText !== "$0.00" && costText !== "0" && costText !== "$0",
          `${stepLabel} notch run ${mappedRun.id} showed null cost as "${costText}"`
        );
      }
    }
    for (const group of wsVm.taskGroups) {
      if (group.cost && group.cost.cost_usd === null) {
        assert.equal(group.cost.cost_usd, null, `${stepLabel} workspace group ${group.id} cost_usd mutated from null`);
      }
    }
  }

  return {
    snapshots: snapshots.length,
    sawEmptyAgentsAfterNonEmpty,
    fileName: path.basename(filePath),
  };
}

function main() {
  const argPath = process.argv.slice(2).find((a) => !a.startsWith("-"));
  const targetPath = argPath ? path.resolve(argPath) : DEFAULT_RECORDING;
  const res = runReplay(targetPath);
  console.log(
    `CHECK PASS (${res.snapshots} snapshots replayed from ${res.fileName}${res.sawEmptyAgentsAfterNonEmpty ? ", verified empty-agents retention" : ""})`
  );
}

main();
