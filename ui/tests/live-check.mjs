#!/usr/bin/env node
/**
 * Live backend contract check (NOT part of run-all.mjs; requires a running backend).
 *
 * Usage:
 *   CA_URL="http://127.0.0.1:8765/?t=..." node ui/tests/live-check.mjs
 *
 * Safety:
 *   - GET requests only (never sends POST).
 *   - Refuses to run against any host other than 127.0.0.1.
 *   - Uses Node built-ins only.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadNotchAdapterFromIndexHtml as loadNotchAdapter,
  loadWorkspaceAdapterFromAppJs as loadWorkspaceAdapter,
} from "./adapter-loader.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const UI_DIR = path.resolve(__dirname, "..");
const INDEX_HTML_PATH = path.join(UI_DIR, "index.html");
const APP_JS_PATH = path.join(UI_DIR, "workspace", "app.js");
const FIXTURES_DIR = path.join(UI_DIR, "fixtures");

// ---------------------------------------------------------------------------
// 1. Validate CA_URL (127.0.0.1 only) & GET-only fetch helper
// ---------------------------------------------------------------------------

function parseCaUrl() {
  const raw = process.env.CA_URL;
  if (!raw) {
    throw new Error("CA_URL environment variable is required (e.g. http://127.0.0.1:8765/?t=...)");
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("CA_URL is not a valid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsupported CA_URL protocol: ${parsed.protocol}`);
  }
  if (parsed.hostname !== "127.0.0.1") {
    throw new Error(`Refusing to run against host "${parsed.hostname}"; only 127.0.0.1 is allowed`);
  }
  return {
    origin: parsed.origin,
    token: parsed.searchParams.get("t") || "",
  };
}

async function fetchGetJson(conn, apiPath) {
  const sep = apiPath.includes("?") ? "&" : "?";
  const url = conn.token
    ? `${conn.origin}${apiPath}${sep}t=${encodeURIComponent(conn.token)}`
    : `${conn.origin}${apiPath}`;
  const res = await fetch(url, { method: "GET" });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`GET ${apiPath} failed with HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`GET ${apiPath} did not return valid JSON: ${err.message}`);
  }
}

function readFixtureJson(fileName) {
  const fullPath = path.join(FIXTURES_DIR, fileName);
  assert.ok(fs.existsSync(fullPath), `Missing fixture file: ui/fixtures/${fileName}`);
  return JSON.parse(fs.readFileSync(fullPath, "utf8"));
}

// ---------------------------------------------------------------------------
// 2. Shape comparison helpers (missing in fixture, missing live, type mismatch)
// ---------------------------------------------------------------------------

function valueType(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Build a merged field->Set<type> map from an array of sample objects.
 */
function collectObjectFieldTypes(objects) {
  const map = new Map();
  for (const obj of objects) {
    if (!isPlainObject(obj)) continue;
    for (const [k, v] of Object.entries(obj)) {
      if (!map.has(k)) map.set(k, new Set());
      map.get(k).add(valueType(v));
    }
  }
  return map;
}

/**
 * Compare a list of live objects against a list of fixture objects at `label`.
 * Reports missing in fixture, missing live, and type mismatches, and recurses
 * into nested plain objects / arrays of plain objects.
 */
function compareObjectLists(label, liveObjs, fxObjs, diffs, depth = 0) {
  if (depth > 4) return;
  if (liveObjs.length === 0) {
    diffs.push(`[info] ${label}: live returned 0 items (cannot verify item fields)`);
    return;
  }
  if (fxObjs.length === 0) {
    diffs.push(`[info] ${label}: fixture has 0 items`);
    return;
  }

  const liveFields = collectObjectFieldTypes(liveObjs);
  const fxFields = collectObjectFieldTypes(fxObjs);

  for (const [field, liveTypes] of liveFields.entries()) {
    if (!fxFields.has(field)) {
      diffs.push(`missing in fixture: ${label}.${field} (live types: ${[...liveTypes].join("|")})`);
      continue;
    }
    const fxTypes = fxFields.get(field);
    for (const lt of liveTypes) {
      if (!fxTypes.has(lt)) {
        diffs.push(
          `type mismatch: ${label}.${field} (live=${lt}, fixture=${[...fxTypes].join("|")})`
        );
      }
    }
    // Recurse into nested objects / arrays of objects
    const nestedLiveObjs = [];
    const nestedFxObjs = [];
    const nestedLiveArrItems = [];
    const nestedFxArrItems = [];
    for (const o of liveObjs) {
      if (!isPlainObject(o) || !(field in o)) continue;
      if (isPlainObject(o[field])) nestedLiveObjs.push(o[field]);
      else if (Array.isArray(o[field])) {
        for (const item of o[field]) {
          if (isPlainObject(item)) nestedLiveArrItems.push(item);
        }
      }
    }
    for (const o of fxObjs) {
      if (!isPlainObject(o) || !(field in o)) continue;
      if (isPlainObject(o[field])) nestedFxObjs.push(o[field]);
      else if (Array.isArray(o[field])) {
        for (const item of o[field]) {
          if (isPlainObject(item)) nestedFxArrItems.push(item);
        }
      }
    }
    if (nestedLiveObjs.length > 0 && nestedFxObjs.length > 0) {
      compareObjectLists(`${label}.${field}`, nestedLiveObjs, nestedFxObjs, diffs, depth + 1);
    }
    if (nestedLiveArrItems.length > 0 && nestedFxArrItems.length > 0) {
      compareObjectLists(`${label}.${field}[]`, nestedLiveArrItems, nestedFxArrItems, diffs, depth + 1);
    }
  }

  for (const [field, fxTypes] of fxFields.entries()) {
    if (!liveFields.has(field)) {
      diffs.push(`missing live: ${label}.${field} (fixture types: ${[...fxTypes].join("|")})`);
    }
  }
}

function compareEndpointShape(label, liveData, fxData, diffs, options = {}) {
  const liveType = valueType(liveData);
  const fxType = valueType(fxData);
  if (liveType !== fxType) {
    diffs.push(`type mismatch: ${label} (live=${liveType}, fixture=${fxType})`);
    return;
  }

  if (options.dynamicKeyMap && isPlainObject(liveData) && isPlainObject(fxData)) {
    const liveVals = Object.values(liveData);
    const fxVals = Object.values(fxData);
    compareObjectLists(`${label}[*]`, liveVals, fxVals, diffs);
    return;
  }

  if (Array.isArray(liveData) && Array.isArray(fxData)) {
    compareObjectLists(`${label}[]`, liveData, fxData, diffs);
    return;
  }

  if (isPlainObject(liveData) && isPlainObject(fxData)) {
    compareObjectLists(label, [liveData], [fxData], diffs);
  }
}

function compareRunEventsByKind(liveDetails, fxRunDetail, diffs) {
  const liveEvents = liveDetails.flatMap((d) => (Array.isArray(d?.events) ? d.events : []));
  const fxEvents = Array.isArray(fxRunDetail?.events) ? fxRunDetail.events : [];

  const liveByKind = new Map();
  for (const ev of liveEvents) {
    const k = ev?.kind || "<unknown>";
    if (!liveByKind.has(k)) liveByKind.set(k, []);
    liveByKind.get(k).push(ev);
  }

  const fxByKind = new Map();
  for (const ev of fxEvents) {
    const k = ev?.kind || "<unknown>";
    if (!fxByKind.has(k)) fxByKind.set(k, []);
    fxByKind.get(k).push(ev);
  }

  for (const [kind, list] of liveByKind.entries()) {
    if (!fxByKind.has(kind)) {
      diffs.push(`missing in fixture: /api/runs/<id>.events[kind=${kind}] (${list.length} live events)`);
      continue;
    }
    compareObjectLists(`/api/runs/<id>.events[kind=${kind}]`, list, fxByKind.get(kind), diffs);
  }

  for (const kind of fxByKind.keys()) {
    if (!liveByKind.has(kind)) {
      diffs.push(`missing live: /api/runs/<id>.events[kind=${kind}]`);
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Load Notch Adapter (ui/index.html) & Workspace Adapter (ui/workspace/app.js)
// ---------------------------------------------------------------------------

function loadNotchAdapterFromIndexHtml() {
  return loadNotchAdapter(INDEX_HTML_PATH);
}

function loadWorkspaceAdapterFromAppJs() {
  return loadWorkspaceAdapter({ appJsPath: APP_JS_PATH });
}

// ---------------------------------------------------------------------------
// 4. View-model assertions on live data
// ---------------------------------------------------------------------------

function assertNotchViewModel(notchAdapter, runs, detailsById, help, agents, nowSec) {
  const vmOut = notchAdapter.mapRuns(runs, detailsById, help, {
    connectionStatus: "connected",
    isSampleData: false,
    agentsById: agents,
    nowSec,
  });

  assert.ok(vmOut && Array.isArray(vmOut.runs), "Notch view model must have runs array");
  const expectedParentCount = runs.filter((r) => !r.parent).length;
  assert.equal(vmOut.runs.length, expectedParentCount, "Notch view model must have one group per parent run");

  for (const group of vmOut.runs) {
    assert.ok(group.id, "Notch run group must have id");
    assert.ok(typeof group.state === "string" && group.state.length > 0, `Notch run ${group.id} must have state`);
    assert.ok(
      typeof group.stateSymbolWord === "string" && group.stateSymbolWord.length > 0,
      `Notch run ${group.id} must have stateSymbolWord`
    );
    assert.ok(!group.stateSymbolWord.includes("(mock)"), `Notch run ${group.id} must not include (mock) in live mode`);
    assert.ok(
      typeof group.stateColorClass === "string" && group.stateColorClass.startsWith("state-"),
      `Notch run ${group.id} must have stateColorClass`
    );

    if (group.state === "verified") {
      assert.ok(group.stateSymbolWord.includes("✓"), `Notch verified run ${group.id} must include ✓`);
      assert.equal(group.stateColorClass, "state-success");
    } else if (group.state === "failed" || group.state === "waiting") {
      assert.ok(!group.stateSymbolWord.includes("✓"), `Notch ${group.state} run ${group.id} must NOT include ✓`);
    }

    assert.ok(Array.isArray(group.steps), `Notch run ${group.id} must have steps array`);
    assert.ok(Array.isArray(group.pendingHelp), `Notch run ${group.id} must have pendingHelp array`);
    for (const step of group.steps) {
      assert.ok(step.id, "Notch child step must have id");
      assert.ok(step.agentIdentity && typeof step.agentIdentity.name === "string", "Notch step must have agentIdentity.name");
      assert.ok(typeof step.stateSymbolWord === "string" && step.stateSymbolWord.length > 0, "Notch step must have stateSymbolWord");
    }
  }
  return vmOut;
}

function assertWorkspaceViewModel(
  WorkspaceAdapter,
  { runs, detailsById, help, agents, actions, graph, analytics, costsById, transcriptsByRunId }
) {
  const parentRuns = runs.filter((r) => !r.parent);
  const selectedTaskRunId = parentRuns[0]?.id || runs[0]?.id || null;
  const childRuns = runs.filter((r) => r.parent === selectedTaskRunId);
  const selectedAgentId = childRuns[0]?.id || selectedTaskRunId;

  const vmOut = WorkspaceAdapter.buildViewModel({
    rawRuns: runs,
    detailsById,
    pendingHelp: help,
    rawAgents: agents,
    rawActions: Array.isArray(actions?.actions) ? actions.actions : [],
    rawGraph: graph,
    rawAnalytics: analytics,
    costsById,
    transcriptsByRunId,
    searchedTranscriptRows: null,
    sentAttachmentsByRunId: new Map(),
    connectionStatus: "connected",
    connectionError: "",
    isSampleData: false,
    selectedTaskRunId,
    selectedAgentId,
    smAgentFilter: "",
    selectedAppFilter: "all",
    logSearchQuery: "",
    logStatusFilter: "all",
  });

  assert.ok(Array.isArray(vmOut.taskGroups), "Workspace view model must have taskGroups");
  assert.equal(vmOut.taskGroups.length, parentRuns.length, "Workspace taskGroups must match parent runs");

  for (const g of vmOut.taskGroups) {
    assert.ok(g.id && g.goal, `Task group ${g.id} must have id and goal`);
    assert.ok(g.overallStatus?.symbolWord, `Task group ${g.id} must have overallStatus.symbolWord`);
    assert.ok(g.overallStatus?.filterKey, `Task group ${g.id} must have overallStatus.filterKey`);
    assert.ok(g.primaryNode && g.primaryNode.isPrimary === true, `Task group ${g.id} must have primaryNode with isPrimary=true`);
    assert.ok(Array.isArray(g.allNodes) && g.allNodes.length >= 1, `Task group ${g.id} must have allNodes`);
    for (const n of g.allNodes) {
      if (n.hasGlass) {
        assert.ok(n.palette?.body && n.palette?.edge && n.palette?.ink, `Node ${n.runId} must have glass palette when hasGlass=true`);
      }
      assert.ok(Array.isArray(n.steps), `Node ${n.runId} must have steps array`);
    }
    assert.ok(Array.isArray(g.combinedEvents), `Task group ${g.id} must have combinedEvents`);
    if (costsById[g.id]) {
      assert.ok(g.cost, `Task group ${g.id} must attach per-task cost from costsById`);
    }
  }

  assert.ok(Array.isArray(vmOut.approvals), "Workspace view model must have approvals array");
  assert.equal(vmOut.approvals.length, help.length, "Workspace approvals length must match /api/help");

  const sm = vmOut.stateMachine;
  assert.ok(sm && Array.isArray(sm.screens) && Array.isArray(sm.edges), "Workspace stateMachine must have screens and edges");
  assert.equal(sm.totalFilteredActions, (actions?.actions || []).length, "Workspace totalFilteredActions must match /api/actions");
  for (const edge of sm.edges) {
    assert.ok(edge.statusSymbolWord, "State machine edge must have statusSymbolWord");
    assert.ok(typeof edge.trailColor === "string" && edge.trailColor.startsWith("#"), "State machine edge must have hex trailColor");
  }

  assert.ok(vmOut.graphStats, "Workspace view model must have graphStats");
  assert.equal(vmOut.graphStats.screens, graph.screens, "graphStats.screens must match /api/graph");
  assert.equal(vmOut.graphStats.transitions, graph.transitions, "graphStats.transitions must match /api/graph");
  assert.equal(vmOut.graphStats.skills, graph.skills, "graphStats.skills must match /api/graph");
  assert.equal(vmOut.graphStats.mean_edge_p, graph.mean_edge_p, "graphStats.mean_edge_p must match /api/graph");

  assert.ok(Array.isArray(vmOut.filteredTranscriptRuns), "Workspace view model must have filteredTranscriptRuns");
  assert.equal(vmOut.filteredTranscriptRuns.length, parentRuns.length, "Unfiltered transcript runs must match parent runs");
  for (const row of vmOut.filteredTranscriptRuns) {
    assert.ok(row.id && row.goal && row.elapsedText, "Transcript row must have id, goal, elapsedText");
    assert.ok(row.overallStatus?.symbolWord, "Transcript row must have status symbol+word");
  }

  assert.ok(vmOut.analytics, "Workspace view model must have analytics");
  assert.equal(vmOut.analytics.tasks, analytics.tasks);
  assert.equal(vmOut.analytics.cost_usd, analytics.cost_usd);
  assert.equal(vmOut.analytics.llm_calls, analytics.llm_calls);
  assert.equal(vmOut.analytics.mean_cost_per_task, analytics.mean_cost_per_task);

  return vmOut;
}

// ---------------------------------------------------------------------------
// 5. Main
// ---------------------------------------------------------------------------

async function main() {
  const conn = parseCaUrl();
  console.log(`Checking live backend at ${conn.origin} (GET only)...`);

  const [runs, help, agents, actions, graph, analytics, transcripts, profile, notifications, files] =
    await Promise.all([
      fetchGetJson(conn, "/api/runs"),
      fetchGetJson(conn, "/api/help"),
      fetchGetJson(conn, "/api/agents"),
      fetchGetJson(conn, "/api/actions"),
      fetchGetJson(conn, "/api/graph"),
      fetchGetJson(conn, "/api/analytics"),
      fetchGetJson(conn, "/api/transcripts"),
      fetchGetJson(conn, "/api/profile"),
      fetchGetJson(conn, "/api/notifications"),
      fetchGetJson(conn, "/api/files?q=a"),
    ]);

  assert.ok(Array.isArray(runs), "/api/runs must return an array");

  const detailsById = {};
  const costsById = {};
  const transcriptsByRunId = {};
  const liveDetails = [];
  const liveCosts = [];
  const liveRunTranscripts = [];

  for (const run of runs) {
    const idEnc = encodeURIComponent(run.id);
    const [detail, cost, runTranscript] = await Promise.all([
      fetchGetJson(conn, `/api/runs/${idEnc}`),
      fetchGetJson(conn, `/api/runs/${idEnc}/cost`),
      fetchGetJson(conn, `/api/runs/${idEnc}/transcript`),
    ]);
    detailsById[run.id] = detail;
    costsById[run.id] = cost;
    transcriptsByRunId[run.id] = runTranscript;
    liveDetails.push(detail);
    liveCosts.push(cost);
    if (Array.isArray(runTranscript)) {
      liveRunTranscripts.push(...runTranscript);
    }
  }

  // Load fixtures and compare shapes
  const fxRuns = readFixtureJson("backend-shape-runs.json");
  const fxRunDetail = readFixtureJson("backend-shape-run.json");
  const fxHelp = readFixtureJson("backend-shape-help.json");
  const fxAgents = readFixtureJson("backend-shape-agents.json");
  const fxActions = readFixtureJson("backend-shape-actions.json");
  const fxGraph = readFixtureJson("backend-shape-graph.json");
  const fxAnalytics = readFixtureJson("backend-shape-analytics.json");
  const fxCost = readFixtureJson("backend-shape-cost.json");
  const fxTranscripts = readFixtureJson("backend-shape-transcripts.json");
  const fxTranscript = readFixtureJson("backend-shape-transcript.json");
  const fxProfile = readFixtureJson("backend-shape-profile.json");
  const fxNotifications = readFixtureJson("backend-shape-notifications.json");
  const fxFiles = readFixtureJson("backend-shape-files.json");

  const diffs = [];
  compareEndpointShape("/api/runs", runs, fxRuns, diffs);
  if (liveDetails.length > 0) {
    compareObjectLists("/api/runs/<id>", liveDetails, [fxRunDetail], diffs);
    compareRunEventsByKind(liveDetails, fxRunDetail, diffs);
  } else {
    diffs.push("[info] /api/runs/<id>: no live runs to compare");
  }
  compareEndpointShape("/api/help", help, fxHelp, diffs);
  compareEndpointShape("/api/agents", agents, fxAgents, diffs, { dynamicKeyMap: true });
  compareEndpointShape("/api/actions", actions, fxActions, diffs);
  compareEndpointShape("/api/graph", graph, fxGraph, diffs);
  compareEndpointShape("/api/analytics", analytics, fxAnalytics, diffs);
  if (liveCosts.length > 0) {
    compareObjectLists("/api/runs/<id>/cost", liveCosts, [fxCost], diffs);
  }
  compareEndpointShape("/api/transcripts", transcripts, fxTranscripts, diffs);
  compareObjectLists("/api/runs/<id>/transcript[]", liveRunTranscripts, fxTranscript, diffs);
  compareEndpointShape("/api/profile", profile, fxProfile, diffs);
  compareEndpointShape("/api/notifications", notifications, fxNotifications, diffs);
  compareEndpointShape("/api/files?q=a", files, fxFiles, diffs);

  console.log(`\nShape comparison (${diffs.length} note(s)):`);
  for (const d of diffs) {
    console.log(`  - ${d}`);
  }

  // Feed live responses through Notch Adapter & Workspace Adapter
  const notchAdapter = loadNotchAdapterFromIndexHtml();
  const { WorkspaceAdapter } = loadWorkspaceAdapterFromAppJs();

  const nowSec = Math.floor(Date.now() / 1000);
  const notchVm = assertNotchViewModel(notchAdapter, runs, detailsById, help, agents, nowSec);
  const workspaceVm = assertWorkspaceViewModel(WorkspaceAdapter, {
    runs,
    detailsById,
    help,
    agents,
    actions,
    graph,
    analytics,
    costsById,
    transcriptsByRunId,
  });

  console.log(
    `\nLIVE CHECK PASS: ${runs.length} runs (${notchVm.runs.length} parent groups), ` +
      `${workspaceVm.stateMachine.edges.length} action edges, ` +
      `${notifications.length} notifications`
  );
}

main().catch((err) => {
  console.error("LIVE CHECK FAIL:", err?.stack || err?.message || err);
  process.exit(1);
});
