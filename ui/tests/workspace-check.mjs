import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadWorkspaceAdapterFromAppJs as loadWorkspaceAdapter } from "./adapter-loader.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const UI_DIR = path.resolve(__dirname, "..");
const APP_JS_PATH = path.join(UI_DIR, "workspace", "app.js");
const FIXTURES_DIR = path.join(UI_DIR, "fixtures");

/**
 * Load a JSON file from ui/fixtures/.
 */
function readFixtureJson(fileName) {
  const fullPath = path.join(FIXTURES_DIR, fileName);
  assert.ok(fs.existsSync(fullPath), `Missing fixture file: ui/fixtures/${fileName}`);
  return JSON.parse(fs.readFileSync(fullPath, "utf8"));
}

/**
 * Extract the palette helpers, OnboardingState, and WorkspaceAdapter IIFE from
 * ui/workspace/app.js and evaluate them inside an isolated node:vm context.
 */
function loadWorkspaceAdapterFromAppJs(fixedNowSec) {
  const fixedNowMs = fixedNowSec * 1000;
  class FixedDate extends Date {
    static now() {
      return fixedNowMs;
    }
  }
  return loadWorkspaceAdapter({ appJsPath: APP_JS_PATH, DateClass: FixedDate });
}

/**
 * Verify all backend-shape-*.json files strictly match backend shapes.
 */
function assertBackendShapeFixtures() {
  const runs = readFixtureJson("backend-shape-runs.json");
  const runDetail = readFixtureJson("backend-shape-run.json");
  const help = readFixtureJson("backend-shape-help.json");
  const agents = readFixtureJson("backend-shape-agents.json");
  const actions = readFixtureJson("backend-shape-actions.json");
  const graph = readFixtureJson("backend-shape-graph.json");
  const analytics = readFixtureJson("backend-shape-analytics.json");
  const cost = readFixtureJson("backend-shape-cost.json");
  const transcripts = readFixtureJson("backend-shape-transcripts.json");
  const transcript = readFixtureJson("backend-shape-transcript.json");
  const notifications = readFixtureJson("backend-shape-notifications.json");
  const notificationsDismiss = readFixtureJson("backend-shape-notifications-dismiss.json");
  const files = readFixtureJson("backend-shape-files.json");
  const profile = readFixtureJson("backend-shape-profile.json");
  const taskPost = readFixtureJson("backend-shape-task.json");
  const helpPost = readFixtureJson("backend-shape-help-post.json");

  // 1. /api/runs: Run.view() with `events` popped
  assert.ok(Array.isArray(runs) && runs.length >= 2, "backend-shape-runs.json must be a non-empty array");
  const expectedRunListKeys = ["elapsed", "goal", "id", "n_events", "parent", "result", "role", "state"];
  for (const r of runs) {
    assert.deepEqual(
      Object.keys(r).sort(),
      expectedRunListKeys,
      `Run ${r.id} in backend-shape-runs.json must have exact Run.view() keys without events`
    );
  }

  // 2. /api/runs/<id>: Run.view(since=0)
  const expectedRunDetailKeys = ["elapsed", "events", "goal", "id", "n_events", "parent", "result", "role", "state"];
  assert.deepEqual(
    Object.keys(runDetail).sort(),
    expectedRunDetailKeys,
    "backend-shape-run.json must have exact Run.view() keys"
  );
  assert.ok(Array.isArray(runDetail.events) && runDetail.events.length > 0, "backend-shape-run.json must have events");
  assert.equal(runDetail.n_events, runDetail.events.length, "backend-shape-run.json n_events must equal events.length");
  for (const ev of runDetail.events) {
    assert.equal(typeof ev.t, "number", "Every event must have numeric t");
    assert.equal(typeof ev.kind, "string", "Every event must have string kind");
  }

  // 3. /api/help: runs.pending_help()
  assert.ok(Array.isArray(help) && help.length >= 1, "backend-shape-help.json must be a non-empty array");
  const expectedHelpKeys = ["agent", "answer", "asked", "detail", "id", "kind", "options", "question", "run", "thread"];
  for (const h of help) {
    assert.deepEqual(
      Object.keys(h).sort(),
      expectedHelpKeys,
      `Help item ${h.id} in backend-shape-help.json must have exact pending_help() keys`
    );
    assert.equal(h.answer, null, "Pending help item must have answer: null");
    assert.equal(typeof h.agent, "string", `Help item ${h.id} must have string agent`);
    assert.equal(typeof h.thread, "string", `Help item ${h.id} must have string thread`);
  }

  // 4. /api/agents: overlay.CURSORS
  assert.equal(typeof agents, "object", "backend-shape-agents.json must be an object");
  const agentEntries = Object.entries(agents);
  assert.ok(agentEntries.length >= 1, "backend-shape-agents.json must have at least 1 active cursor");
  for (const [aid, cursor] of agentEntries) {
    for (const reqKey of ["name", "color", "edge", "ink"]) {
      assert.equal(typeof cursor[reqKey], "string", `Agent ${aid} must have string ${reqKey}`);
    }
    for (const k of Object.keys(cursor)) {
      assert.ok(
        ["name", "color", "edge", "ink", "greeted"].includes(k),
        `Agent ${aid} has unexpected key ${k} not sent by overlay.CURSORS`
      );
    }
  }

  // 5. /api/actions: {"total": int, "actions": [...]}
  assert.deepEqual(Object.keys(actions).sort(), ["actions", "total"], "backend-shape-actions.json top-level keys");
  assert.ok(Array.isArray(actions.actions) && actions.actions.length >= 2, "backend-shape-actions.json must list actions");
  const allowedActionKeys = new Set(["ts", "run", "agent", "app", "from", "action", "to", "outcome", "ms", "source", "detail"]);
  const requiredActionKeys = ["ts", "run", "agent", "app", "from", "action", "to", "outcome", "ms", "source"];
  for (const row of actions.actions) {
    for (const rk of requiredActionKeys) {
      assert.ok(rk in row, `Action row missing required key ${rk}`);
    }
    for (const k of Object.keys(row)) {
      assert.ok(allowedActionKeys.has(k), `Action row has unexpected key ${k} not sent by cu/graph.py`);
    }
  }

  // 6. /api/graph: graph.load().stats()
  const expectedGraphKeys = [
    "actions_logged",
    "agents",
    "apps",
    "destructive_edges",
    "mean_edge_p",
    "screens",
    "skills",
    "transitions",
  ];
  assert.deepEqual(Object.keys(graph).sort(), expectedGraphKeys, "backend-shape-graph.json must match stats() keys");

  // 7. /api/analytics: store.summary()
  const expectedAnalyticsKeys = [
    "by_app",
    "by_purpose",
    "by_role",
    "cost_usd",
    "llm_calls",
    "mean_cost_per_task",
    "tasks",
  ];
  assert.deepEqual(
    Object.keys(analytics).sort(),
    expectedAnalyticsKeys,
    "backend-shape-analytics.json must match store.summary() keys"
  );

  // 8. /api/runs/<id>/cost: store.task_cost()
  const expectedCostKeys = [
    "actions",
    "agents",
    "by_agent",
    "completion_tokens",
    "cost_usd",
    "llm_calls",
    "model_seconds",
    "prompt_tokens",
    "run",
  ];
  assert.deepEqual(
    Object.keys(cost).sort(),
    expectedCostKeys,
    "backend-shape-cost.json must match store.task_cost() keys"
  );

  // 9 & 10. /api/transcripts (store.search_messages) and /api/runs/<id>/transcript (store.transcript + color)
  const expectedTranscriptsKeys = ["agent", "id", "kind", "meta", "role", "run", "text", "ts"];
  const expectedTranscriptKeys = ["agent", "color", "id", "kind", "meta", "role", "run", "text", "ts"];
  assert.ok(Array.isArray(transcripts) && transcripts.length >= 1, "backend-shape-transcripts.json must be non-empty");
  for (const m of transcripts) {
    assert.deepEqual(Object.keys(m).sort(), expectedTranscriptsKeys, "backend-shape-transcripts.json row keys");
  }
  assert.ok(Array.isArray(transcript) && transcript.length >= 3, "backend-shape-transcript.json must be non-empty");
  for (const m of transcript) {
    assert.deepEqual(Object.keys(m).sort(), expectedTranscriptKeys, "backend-shape-transcript.json row keys");
    if (m.role === "agent") {
      assert.equal(typeof m.color, "string", "backend-shape-transcript.json agent row must have color string");
    } else {
      assert.equal(m.color, null, "backend-shape-transcript.json non-agent row must have color: null");
    }
  }

  // 11. /api/notifications: server.notifications()
  const expectedNotificationKeys = ["body", "edge", "id", "ink", "kind", "ok", "text", "thread", "title", "ts"];
  assert.ok(Array.isArray(notifications) && notifications.length >= 1, "backend-shape-notifications.json must be non-empty");
  for (const n of notifications) {
    assert.deepEqual(
      Object.keys(n).sort(),
      expectedNotificationKeys,
      `Notification ${n.id} in backend-shape-notifications.json must match notifications() keys`
    );
  }

  // 12. POST /api/notifications/<id>/dismiss
  assert.deepEqual(Object.keys(notificationsDismiss).sort(), ["ok"], "backend-shape-notifications-dismiss.json keys");
  assert.equal(notificationsDismiss.ok, true, "backend-shape-notifications-dismiss.json ok must be true");

  // 13. GET /api/files?q=: server.find_files()
  const expectedFileKeys = ["dir", "name", "path", "where"];
  assert.ok(Array.isArray(files) && files.length >= 1, "backend-shape-files.json must be non-empty");
  for (const f of files) {
    assert.deepEqual(Object.keys(f).sort(), expectedFileKeys, `File ${f.name} in backend-shape-files.json keys`);
    assert.equal(typeof f.dir, "boolean", `File ${f.name} dir must be boolean`);
  }

  // 14. GET/POST /api/profile: profile.view()
  const expectedProfileKeys = ["call_me", "decide_model", "model", "voice_id"];
  assert.deepEqual(Object.keys(profile).sort(), expectedProfileKeys, "backend-shape-profile.json keys");
  for (const k of expectedProfileKeys) {
    assert.equal(typeof profile[k], "string", `backend-shape-profile.json ${k} must be string`);
  }

  // 15. POST /api/task
  assert.deepEqual(Object.keys(taskPost).sort(), ["run", "thread"], "backend-shape-task.json keys");
  assert.equal(typeof taskPost.run, "string");
  assert.equal(typeof taskPost.thread, "string");

  // 16. POST /api/help/<id>
  assert.deepEqual(Object.keys(helpPost).sort(), ["ok"], "backend-shape-help-post.json keys");
  assert.equal(typeof helpPost.ok, "boolean");

  return {
    runs,
    runDetail,
    help,
    agents,
    actions,
    graph,
    analytics,
    cost,
    transcripts,
    transcript,
  };
}

function runChecks() {
  const fixedNowSec = 1763149020;
  const { WorkspaceAdapter } = loadWorkspaceAdapterFromAppJs(fixedNowSec);
  const fx = assertBackendShapeFixtures();

  const detailsById = {
    [fx.runDetail.id]: fx.runDetail,
  };
  const costsById = {
    [fx.cost.run]: fx.cost,
  };

  const transcriptsByRunId = {
    "r1763149000-1-a1b2": fx.transcript,
  };
  const sentAttachmentsByRunId = new Map();

  const vmOut = WorkspaceAdapter.buildViewModel({
    rawRuns: fx.runs,
    detailsById,
    pendingHelp: fx.help,
    rawAgents: fx.agents,
    rawActions: fx.actions.actions,
    rawGraph: fx.graph,
    rawAnalytics: fx.analytics,
    costsById,
    transcriptsByRunId,
    searchedTranscriptRows: null,
    sentAttachmentsByRunId,
    connectionStatus: "connected",
    connectionError: "",
    isSampleData: false,
    selectedTaskRunId: "r1763149000-1-a1b2",
    selectedAgentId: "r1763149000-2-c3d4",
    smAgentFilter: "",
    selectedAppFilter: "all",
    logSearchQuery: "",
    logStatusFilter: "all",
  });

  // ===========================================================================
  // 1. Agent Graph view model (B1: taskGroups, activeGroup, nodes, steps, approvals)
  // ===========================================================================
  assert.equal(vmOut.taskGroups.length, 2, "Expected 2 parent task groups from backend-shape-runs.json");

  const waitingGroup = vmOut.taskGroups.find((g) => g.id === "r1763149010-3-e5f6");
  assert.ok(waitingGroup, "Expected waiting task group r1763149010-3-e5f6");
  assert.equal(waitingGroup.overallStatus.filterKey, "waiting", "Group with pending help must be in waiting state");
  assert.equal(waitingGroup.overallStatus.symbolWord, "◔ Waiting", "Waiting group must have symbol+word '◔ Waiting'");
  assert.equal(waitingGroup.allNodes.length, 2, "Waiting group must have primary + 1 child node");

  assert.equal(vmOut.approvals.length, 1, "Expected 1 mapped approval item from backend-shape-help.json");
  assert.equal(vmOut.approvals[0].id, "h1");
  assert.equal(vmOut.approvals[0].runId, "r1763149010-4-b7d8");
  assert.equal(vmOut.approvals[0].kind, "money");
  assert.equal(vmOut.approvals[0].warningText, "This spends money");
  assert.equal(vmOut.approvals[0].isExpired, false);
  assert.deepEqual([...vmOut.approvals[0].options], ["approve", "deny"]);

  const verifiedGroup = vmOut.activeGroup;
  assert.ok(verifiedGroup && verifiedGroup.id === "r1763149000-1-a1b2", "Selected activeGroup must be r1763149000-1-a1b2");
  assert.equal(verifiedGroup.overallStatus.filterKey, "success", "Completed group must have filterKey 'success'");
  assert.equal(verifiedGroup.overallStatus.isVerified, true, "Completed group with verify pass must be verified");
  assert.equal(verifiedGroup.overallStatus.symbolWord, "✓ Success · Verified");
  assert.equal(verifiedGroup.primaryNode.isPrimary, true, "Primary node must be marked isPrimary");
  assert.equal(verifiedGroup.childNodes.length, 1, "Verified group must have 1 child node");

  const childNode = vmOut.activeAgentNode;
  assert.ok(childNode && childNode.runId === "r1763149000-2-c3d4", "Selected activeAgentNode must be child run");
  assert.equal(childNode.agentName, "Iris", "Child node name must be joined from /api/agents[run.id].name");
  assert.equal(childNode.status.isVerified, true, "Child node must be marked verified");
  assert.ok(childNode.palette?.body && childNode.palette?.edge && childNode.palette?.ink, "Child node must have glass palette");
  assert.ok(childNode.steps.length >= 6, "Child node must map app_ready, decide, act, verify, and result steps");
  const stepKinds = new Set(childNode.steps.map((s) => s.kind));
  assert.ok(stepKinds.has("decide"), "Child node steps must include decide");
  assert.ok(stepKinds.has("act"), "Child node steps must include act");
  assert.ok(stepKinds.has("verify"), "Child node steps must include verify");
  assert.ok(stepKinds.has("result"), "Child node steps must include result");

  // ===========================================================================
  // 2. State Machine Graph & Action Trail (B1b: screens, edges, trail, graphStats)
  // ===========================================================================
  const sm = vmOut.stateMachine;
  assert.ok(sm && Array.isArray(sm.screens) && sm.screens.length >= 4, "State machine must build screen nodes");
  assert.ok(Array.isArray(sm.edges) && sm.edges.length === 5, "State machine must build 5 directed action edges");
  assert.deepEqual([...sm.allApps], ["Calculator", "Safari"], "State machine must list all apps sorted");
  assert.deepEqual([...sm.allAgents], ["Iris", "Leo"], "State machine must list all agents from actions");
  assert.equal(sm.totalFilteredActions, 5, "State machine totalFilteredActions must equal 5");

  const calcTypeEdge = sm.edges.find((e) => e.action === "type:textfield:display");
  assert.ok(calcTypeEdge, "Action trail must contain type:textfield:display edge");
  assert.equal(calcTypeEdge.from, "Calculator:a1b2c3d4e5");
  assert.equal(calcTypeEdge.to, "Calculator:f6a7b8c9d0");
  assert.equal(calcTypeEdge.tries, 1);
  assert.equal(calcTypeEdge.successes, 1);
  assert.equal(calcTypeEdge.statusSymbolWord, "✓ Success");
  assert.equal(calcTypeEdge.meanMs, 135);
  assert.equal(calcTypeEdge.reliabilityP, "0.67");
  assert.equal(calcTypeEdge.sourceLabel, "llm");
  assert.deepEqual([...calcTypeEdge.agents], ["Iris"]);
  assert.ok(calcTypeEdge.trailColor.startsWith("#"), "Edge must have hex trailColor");

  assert.equal(vmOut.graphStats.screens, 5, "graphStats.screens must match backend-shape-graph.json");
  assert.equal(vmOut.graphStats.transitions, 5, "graphStats.transitions must match backend-shape-graph.json");
  assert.equal(vmOut.graphStats.skills, 1, "graphStats.skills must match backend-shape-graph.json");
  assert.equal(vmOut.graphStats.mean_edge_p, 0.633, "graphStats.mean_edge_p must match backend-shape-graph.json");

  // Check agent trail filtering
  const vmIrisTrail = WorkspaceAdapter.buildViewModel({
    rawRuns: fx.runs,
    detailsById,
    pendingHelp: fx.help,
    rawAgents: fx.agents,
    rawActions: fx.actions.actions,
    rawGraph: fx.graph,
    rawAnalytics: fx.analytics,
    costsById,
    transcriptsByRunId,
    searchedTranscriptRows: null,
    sentAttachmentsByRunId,
    connectionStatus: "connected",
    connectionError: "",
    isSampleData: false,
    selectedTaskRunId: "r1763149000-1-a1b2",
    selectedAgentId: "r1763149000-2-c3d4",
    smAgentFilter: "Iris",
    selectedAppFilter: "all",
    logSearchQuery: "",
    logStatusFilter: "all",
  });
  assert.equal(vmIrisTrail.stateMachine.totalFilteredActions, 4, "Filtering by Iris must keep 4 actions");
  assert.ok(
    vmIrisTrail.stateMachine.edges.every((e) => e.agents.includes("Iris")),
    "Filtered edges must all belong to Iris"
  );

  // ===========================================================================
  // 3. Transcript Log rows (B2: filteredTranscriptRuns + search/status filters)
  // ===========================================================================
  assert.equal(vmOut.filteredTranscriptRuns.length, 2, "Transcript log must have 2 task rows");
  for (const row of vmOut.filteredTranscriptRuns) {
    assert.ok(row.id && row.goal && row.elapsedText, "Transcript row must have id, goal, elapsedText");
    assert.ok(row.overallStatus?.symbolWord, "Transcript row must have status symbol+word");
    assert.ok(typeof row.resultSummary === "string" && row.resultSummary.length > 0, "Transcript row must have resultSummary");
    assert.ok(Array.isArray(row.allNodes) && row.allNodes.length >= 2, "Transcript row must include agent nodes");
    assert.ok(Array.isArray(row.combinedEvents), "Transcript row must include combinedEvents");
  }
  assert.equal(
    verifiedGroup.combinedEvents.length,
    fx.transcript.length,
    "Task with /api/runs/<id>/transcript rows must populate combinedEvents from transcript"
  );

  const vmFilteredLog = WorkspaceAdapter.buildViewModel({
    rawRuns: fx.runs,
    detailsById,
    pendingHelp: fx.help,
    rawAgents: fx.agents,
    rawActions: fx.actions.actions,
    rawGraph: fx.graph,
    rawAnalytics: fx.analytics,
    costsById,
    transcriptsByRunId,
    searchedTranscriptRows: fx.transcripts,
    sentAttachmentsByRunId,
    connectionStatus: "connected",
    connectionError: "",
    isSampleData: false,
    selectedTaskRunId: "r1763149000-1-a1b2",
    selectedAgentId: "r1763149000-2-c3d4",
    smAgentFilter: "",
    selectedAppFilter: "all",
    logSearchQuery: "248",
    logStatusFilter: "success",
  });
  assert.equal(vmFilteredLog.filteredTranscriptRuns.length, 1, "Search '248' + status 'success' must match 1 run");
  assert.equal(vmFilteredLog.filteredTranscriptRuns[0].id, "r1763149000-1-a1b2");

  // ===========================================================================
  // 4. Analytics totals & per-task cost (B3: analytics, costsById, activeGroup.cost)
  // ===========================================================================
  assert.ok(vmOut.analytics, "View model must include analytics");
  assert.equal(vmOut.analytics.tasks, 2);
  assert.equal(vmOut.analytics.cost_usd, 0.0074);
  assert.equal(vmOut.analytics.llm_calls, 6);
  assert.equal(vmOut.analytics.mean_cost_per_task, 0.0037);
  assert.equal(vmOut.analytics.by_role.length, 2);
  assert.equal(vmOut.analytics.by_purpose.length, 3);
  assert.equal(vmOut.analytics.by_app.length, 2);

  assert.ok(verifiedGroup.cost, "Verified task group must have per-task cost attached from costsById");
  assert.equal(verifiedGroup.cost.agents, 2);
  assert.equal(verifiedGroup.cost.llm_calls, 4);
  assert.equal(verifiedGroup.cost.prompt_tokens, 1820);
  assert.equal(verifiedGroup.cost.completion_tokens, 345);
  assert.equal(verifiedGroup.cost.cost_usd, 0.0049);
  assert.equal(verifiedGroup.cost.model_seconds, 1.4);
  assert.equal(verifiedGroup.cost.by_agent.length, 2);
}

try {
  runChecks();
  console.log("CHECK PASS");
} catch (err) {
  console.error("CHECK FAIL:", err?.message || err);
  process.exit(1);
}
