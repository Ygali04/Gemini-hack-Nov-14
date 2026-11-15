import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { extractStatement, loadNotchAdapterFromIndexHtml } from "./adapter-loader.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const UI_DIR = path.resolve(__dirname, "..");
const INDEX_HTML_PATH = path.join(UI_DIR, "index.html");
const FIXTURES_DIR = path.join(UI_DIR, "fixtures");

/**
 * Extract WorkspaceAdapter IIFE from ui/index.html and evaluate it in an isolated VM context.
 */
function loadAdapterFromIndexHtml() {
  return loadNotchAdapterFromIndexHtml(INDEX_HTML_PATH);
}

/**
 * Load a fixture JSON file and normalize asked_age_s -> asked the same way Transport.loadFixture does.
 */
function loadFixtureNormalized(fileName, nowSec) {
  const raw = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, fileName), "utf8"));
  const rawHelp = Array.isArray(raw.help) ? raw.help : [];
  const help = rawHelp.map((h) => {
    if (h && h.asked == null && h.asked_age_s != null) {
      return { ...h, asked: nowSec - Number(h.asked_age_s) };
    }
    return h;
  });
  return {
    runs: Array.isArray(raw.runs) ? raw.runs : [],
    details: raw.details && typeof raw.details === "object" ? raw.details : {},
    help,
    agents: raw.agents && typeof raw.agents === "object" ? raw.agents : {},
    transcripts: raw.transcripts && typeof raw.transcripts === "object" ? raw.transcripts : {},
  };
}

function runChecks() {
  const WorkspaceAdapter = loadAdapterFromIndexHtml();
  const nowSec = 1763140500;

  // =========================================================================
  // 1. Fixture checks: qa-loop-verified.json, awaiting-approval.json, failed.json
  // =========================================================================
  {
    const fx = loadFixtureNormalized("qa-loop-verified.json", nowSec);
    const vmOut = WorkspaceAdapter.mapRuns(fx.runs, fx.details, fx.help, {
      connectionStatus: "connected",
      isSampleData: false,
      agentsById: fx.agents,
      nowSec,
    });

    assert.equal(vmOut.runs.length, 1, "qa-loop-verified: expected 1 parent run group");
    const run = vmOut.runs[0];
    assert.equal(run.state, "verified", "qa-loop-verified: state must be verified");
    assert.equal(run.stateSymbolWord, "✓ Verified", "qa-loop-verified: non-mock verified label must be '✓ Verified'");
    assert.ok(run.stateSymbolWord.includes("✓"), "qa-loop-verified: must include check mark when result.ok is true");
    assert.equal(run.stateColorClass, "state-success", "qa-loop-verified: color class must be state-success");
    assert.equal(
      run.evidenceText,
      "Cart total displays $20 and empty email blocks submit",
      "qa-loop-verified: evidenceText must come from achieved verify event"
    );
    assert.equal(
      run.speakText,
      "Cart total and empty-email checks now pass after 1 patch.",
      "qa-loop-verified: speakText must be extracted"
    );
    assert.equal(run.steps.length, 2, "qa-loop-verified: expected 2 child agent steps");
    for (const step of run.steps) {
      assert.ok(step.stateSymbolWord.includes("✓"), `qa-loop-verified: child step ${step.id} with result.ok=true must have ✓`);
    }

    // Also check sample/mock mode label
    const vmSample = WorkspaceAdapter.mapRuns(fx.runs, fx.details, fx.help, {
      connectionStatus: "connected",
      isSampleData: true,
      agentsById: fx.agents,
      nowSec,
    });
    assert.equal(vmSample.runs[0].stateSymbolWord, "Finished · sample run, not verified", "qa-loop-verified: sample mode must label mock verification");
  }

  {
    const fx = loadFixtureNormalized("awaiting-approval.json", nowSec);
    const vmOut = WorkspaceAdapter.mapRuns(fx.runs, fx.details, fx.help, {
      connectionStatus: "connected",
      isSampleData: false,
      agentsById: fx.agents,
      nowSec,
    });

    assert.equal(vmOut.runs.length, 1, "awaiting-approval: expected 1 parent run group");
    const run = vmOut.runs[0];
    assert.equal(run.state, "waiting", "awaiting-approval: state must be waiting");
    assert.equal(run.stateSymbolWord, "◔ Needs approval", "awaiting-approval: symbol+word must be '◔ Needs approval'");
    assert.ok(!run.stateSymbolWord.includes("✓"), "awaiting-approval: must NOT show check mark");
    assert.equal(run.stateColorClass, "state-warning", "awaiting-approval: color class must be state-warning");
    assert.equal(run.pendingHelp.length, 2, "awaiting-approval: expected 2 help items (1 expired, 1 active)");

    const h10 = run.pendingHelp.find((h) => h.id === "h10");
    const h12 = run.pendingHelp.find((h) => h.id === "h12");
    assert.ok(h10 && h12, "awaiting-approval: both h10 and h12 must be present");
    assert.equal(h10.isExpired, true, "awaiting-approval: h10 (310s >= 300s) must be marked expired");
    assert.equal(h10.statusText, "Expired", "awaiting-approval: expired item must have statusText 'Expired'");
    assert.equal(h10.kindWarning, "This can't be undone", "awaiting-approval: destructive warning must match");
    assert.deepEqual(h10.options, ["approve", "deny"], "awaiting-approval: h10 options must pass through unchanged");

    assert.equal(h12.isExpired, false, "awaiting-approval: h12 (12s < 300s) must be active");
    assert.equal(h12.kindWarning, "This spends money", "awaiting-approval: money warning must match");
    assert.deepEqual(h12.options, ["approve", "deny"], "awaiting-approval: h12 options must pass through unchanged");
  }

  {
    const fx = loadFixtureNormalized("failed.json", nowSec);
    const vmOut = WorkspaceAdapter.mapRuns(fx.runs, fx.details, fx.help, {
      connectionStatus: "connected",
      isSampleData: false,
      agentsById: fx.agents,
      nowSec,
    });

    assert.equal(vmOut.runs.length, 1, "failed: expected 1 parent run group");
    const run = vmOut.runs[0];
    assert.equal(run.state, "failed", "failed: state must be failed");
    assert.ok(run.stateSymbolWord.length > 0, "failed: stateSymbolWord must be non-empty plain words");
    assert.ok(!run.stateSymbolWord.includes("Failed"), "failed: must NOT contain 'Failed'");
    assert.ok(!run.stateSymbolWord.includes("×"), "failed: must NOT contain '×'");
    assert.ok(!run.stateSymbolWord.includes("✓"), "failed: must NOT show check mark");
    assert.equal(run.stateColorClass, "state-neutral", "failed: color class must be state-neutral");
    assert.ok(
      run.stateFact.endsWith("· Nothing was changed."),
      "failed: unapplied patch must append '· Nothing was changed.'"
    );
    for (const step of run.steps) {
      assert.ok(!step.stateSymbolWord.includes("✓"), `failed: child step ${step.id} must NOT have ✓`);
      assert.ok(!step.stateSymbolWord.includes("Failed"), `failed: child step ${step.id} must NOT contain 'Failed'`);
      assert.ok(!step.stateSymbolWord.includes("×"), `failed: child step ${step.id} must NOT contain '×'`);
      assert.equal(step.stateColorClass, "state-neutral", `failed: child step ${step.id} must use state-neutral`);
    }
  }

  // =========================================================================
  // 2. Real backend API shapes (core/runs.py, api/server.py, agents/orchestrator.py, cu/overlay.py)
  // =========================================================================
  // Shape from GET /api/runs (Run.view() with `events` popped) and GET /api/runs/<id>?since=0
  const realParentId = "r1763149000-1-a1b2";
  const realChildId = "r1763149000-2-c3d4";

  const realParentView = {
    id: realParentId,
    goal: "open Calculator and compute 8 * 31",
    role: "orchestrator",
    parent: null,
    state: "done",
    elapsed: 1.4,
    events: [
      { t: 0.0, state: "planning", kind: "state" },
      { t: 0.01, purpose: "route", ms: 1, cost: null, tokens: 0, ok: true, kind: "llm" },
      {
        t: 0.02,
        role: "cu",
        app: null,
        repo: null,
        url: null,
        goal: "open Calculator and compute 8 * 31",
        subtasks: [],
        fallback: "bad router reply: {'action': 'done', 'reason': 'mock'}",
        kind: "route",
      },
      { t: 0.02, state: "acting", kind: "state" },
      { t: 1.4, state: "done", kind: "state" },
    ],
    n_events: 5,
    result: {
      ok: true,
      summary: "mock",
      digest: {
        run: realParentId,
        goal: "open Calculator and compute 8 * 31",
        role: "orchestrator",
        ok: true,
        summary: "mock",
        seconds: 1.4,
        steps: 1,
        help_requests: 0,
        memory_steps: 0,
        llm: { calls: 1, prompt_tokens: 0, completion_tokens: 0, cost: 0.0, ms: 1 },
        task_cost: {
          run: realParentId,
          agents: 2,
          llm_calls: 2,
          prompt_tokens: 0,
          completion_tokens: 0,
          cost_usd: 0.0,
          model_seconds: 0.0,
          actions: { ok: 1, done_verified: 1 },
          by_agent: [
            { agent: "orchestrator", calls: 1, cost: 0.0, ms: 1 },
            { agent: "CU 1", calls: 1, cost: 0.0, ms: 1 },
          ],
        },
        children: [realChildId],
      },
    },
  };

  const realChildView = {
    id: realChildId,
    goal: "open Calculator and compute 8 * 31",
    role: "cu",
    parent: realParentId,
    state: "done",
    elapsed: 1.3,
    events: [
      { t: 0.0, state: "acting", kind: "state" },
      { t: 0.01, state: "planning", kind: "state" },
      {
        t: 0.2,
        app: "Calculator",
        method: "running",
        seconds: 0.2,
        ready_after: 0.1,
        window: 101,
        lane: { x: 20, y: 42, w: 1400, h: 838, slot: 0 },
        kind: "app_ready",
      },
      { t: 0.2, action: "open_app:running:calculator", outcome: "ok", node: null, to: null, kind: "graph" },
      { t: 0.21, state: "acting", kind: "state" },
      { t: 0.25, purpose: "decide", ms: 1, cost: null, tokens: 0, ok: true, kind: "llm" },
      { t: 0.25, ms: 1, thought: null, action: "done", kind: "decide" },
      { t: 0.26, achieved: true, evidence: "mock", kind: "verify" },
      { t: 0.26, action: "done", outcome: "done_verified", node: "Calculator:abc1234567", to: null, kind: "graph" },
      { t: 1.3, ok: true, summary: "mock", steps: 0, kind: "result" },
      { t: 1.3, state: "done", kind: "state" },
    ],
    n_events: 11,
    result: { ok: true, summary: "mock", steps: 0 },
  };

  // GET /api/runs strips `events` from each Run.view()
  const { events: _pe, ...realParentListEntry } = realParentView;
  const { events: _ce, ...realChildListEntry } = realChildView;

  // Live /api/agents shape from cu/overlay.py: CURSORS[agent_id] = {"name", "color", "edge", "ink"}
  const realAgentsPopulated = {
    [realChildId]: { name: "CU 1", color: "#B5D0EB", edge: "#D6E9FF", ink: "#2F647C" },
  };

  {
    const vmReal = WorkspaceAdapter.mapRuns(
      [realParentListEntry, realChildListEntry],
      { [realParentId]: realParentView, [realChildId]: realChildView },
      [],
      {
        connectionStatus: "connected",
        isSampleData: false,
        agentsById: realAgentsPopulated,
        nowSec,
      }
    );

    assert.equal(vmReal.runs.length, 1);
    const r = vmReal.runs[0];
    assert.equal(r.state, "unverified");
    assert.equal(r.stateSymbolWord, "Finished · sample run, not verified");
    assert.equal(r.evidenceText, "");
    assert.equal(r.steps.length, 1);
    assert.equal(r.steps[0].agentIdentity.name, "CU 1");
    assert.equal(r.steps[0].agentIdentity.color, "#B5D0EB");
    assert.equal(r.steps[0].stateSymbolWord, "Finished · sample run, not verified");

    // Also verify when /api/agents is empty `{}` (after overlay.release(run.id) runs in cu_agent.py finally block)
    const vmEmptyAgents = WorkspaceAdapter.mapRuns(
      [realParentListEntry, realChildListEntry],
      { [realParentId]: realParentView, [realChildId]: realChildView },
      [],
      {
        connectionStatus: "connected",
        isSampleData: false,
        agentsById: {},
        nowSec,
      }
    );
    assert.equal(vmEmptyAgents.runs[0].steps[0].agentIdentity.name, "Computer use agent");
  }

  // =========================================================================
  // 3. Exhaustive state mapping & "✓ only when result.ok === true" truth table
  // =========================================================================
  const stateCases = [
    {
      name: "queued -> working (no ✓)",
      parentState: "queued",
      result: null,
      expectState: "working",
      expectSymbolWord: "▶ Running",
      expectCheck: false,
    },
    {
      name: "planning -> working (no ✓)",
      parentState: "planning",
      result: null,
      expectState: "working",
      expectSymbolWord: "▶ Running",
      expectCheck: false,
    },
    {
      name: "acting -> working (no ✓)",
      parentState: "acting",
      result: null,
      expectState: "working",
      expectSymbolWord: "▶ Running",
      expectCheck: false,
    },
    {
      name: "acting even with result.ok=true -> working (no ✓)",
      parentState: "acting",
      result: { ok: true, summary: "premature ok" },
      expectState: "working",
      expectSymbolWord: "▶ Running",
      expectCheck: false,
    },
    {
      name: "awaiting_human -> waiting (no ✓)",
      parentState: "awaiting_human",
      result: null,
      expectState: "waiting",
      expectSymbolWord: "◔ Needs approval",
      expectCheck: false,
    },
    {
      name: "done + result: null -> unverified (no ✓)",
      parentState: "done",
      result: null,
      expectState: "unverified",
      expectSymbolWord: "◔ Finished, not verified",
      expectCheck: false,
    },
    {
      name: "done + result: {} (ok undefined) -> unverified (no ✓)",
      parentState: "done",
      result: { summary: "finished without ok boolean" },
      expectState: "unverified",
      expectSymbolWord: "◔ Finished, not verified",
      expectCheck: false,
    },
    {
      name: "done + result: { ok: false } -> failed (no ✓)",
      parentState: "done",
      result: { ok: false, summary: "verifier rejected" },
      expectState: "failed",
      expectSymbolWord: "Verifier rejected",
      expectCheck: false,
    },
    {
      name: "done + result: { ok: 1 } (non-boolean truthy) -> unverified (no ✓)",
      parentState: "done",
      result: { ok: 1, summary: "truthy int is not strict true" },
      expectState: "unverified",
      expectSymbolWord: "◔ Finished, not verified",
      expectCheck: false,
    },
    {
      name: "failed + result: { ok: false } -> failed (no ✓)",
      parentState: "failed",
      result: { ok: false, summary: "failed run" },
      expectState: "failed",
      expectSymbolWord: "Stopped before finishing",
      expectCheck: false,
    },
    {
      name: "done + result: { ok: true } -> verified (WITH ✓)",
      parentState: "done",
      result: { ok: true, summary: "verified run" },
      expectState: "verified",
      expectSymbolWord: "✓ Verified",
      expectCheck: true,
    },
  ];

  for (const tc of stateCases) {
    const pRun = {
      id: "r-test-parent",
      goal: tc.name,
      role: "orchestrator",
      parent: null,
      state: tc.parentState,
      elapsed: 2.0,
      n_events: 1,
      result: tc.result,
    };
    const cRun = {
      id: "r-test-child",
      goal: tc.name,
      role: "cu",
      parent: "r-test-parent",
      state: tc.parentState,
      elapsed: 1.5,
      n_events: 1,
      result: tc.result,
    };
    const out = WorkspaceAdapter.mapRuns(
      [pRun, cRun],
      {
        "r-test-parent": { ...pRun, events: [] },
        "r-test-child": { ...cRun, events: [] },
      },
      [],
      { connectionStatus: "connected", isSampleData: false, agentsById: {}, nowSec }
    );
    const mapped = out.runs[0];
    assert.equal(mapped.state, tc.expectState, `${tc.name}: wrong state`);
    assert.equal(mapped.stateSymbolWord, tc.expectSymbolWord, `${tc.name}: wrong stateSymbolWord`);
    assert.equal(
      mapped.stateSymbolWord.includes("✓"),
      tc.expectCheck,
      `${tc.name}: parent check mark presence mismatch`
    );
    assert.equal(
      mapped.steps[0].stateSymbolWord.includes("✓"),
      tc.expectCheck,
      `${tc.name}: step check mark presence mismatch`
    );
  }

  // =========================================================================
  // 4. Approval options passthrough & warning mapping (core/runs.py:75-113, cu/cu_agent.py:107-137, 330)
  // =========================================================================
  const approvalCases = [
    {
      id: "h-money",
      kind: "money",
      options: ["approve", "deny"],
      expectWarning: "This spends money",
    },
    {
      id: "h-signin",
      kind: "sign_in",
      options: ["approve", "deny"],
      expectWarning: "This changes sign-in or security settings",
    },
    {
      id: "h-destructive",
      kind: "destructive",
      options: ["approve", "deny"],
      expectWarning: "This can't be undone",
    },
    {
      id: "h-captcha",
      kind: "captcha",
      options: ["done", "cancel"],
      expectWarning: "",
    },
    {
      id: "h-clarify",
      kind: "clarify",
      options: ["done", "cancel"],
      expectWarning: "",
    },
    {
      id: "h-custom",
      kind: "clarify",
      options: ["option_a", "option_b", "option_c"],
      expectWarning: "",
    },
  ];

  const helpParent = {
    id: "r-help-parent",
    goal: "Check all help options",
    role: "orchestrator",
    parent: null,
    state: "acting",
    elapsed: 5.0,
    n_events: 1,
    result: null,
  };
  const helpChild = {
    id: "r-help-child",
    goal: "Check all help options",
    role: "cu",
    parent: "r-help-parent",
    state: "awaiting_human",
    elapsed: 4.5,
    n_events: 1,
    result: null,
  };

  // Real pending_help() payload from core/runs.py:122-131
  const rawPendingHelp = approvalCases.map((c, idx) => ({
    id: c.id,
    run: "r-help-child",
    kind: c.kind,
    question: `Question for ${c.id}?`,
    options: [...c.options],
    detail: idx % 2 === 0 ? null : `Detail for ${c.id}`,
    answer: null,
    asked: nowSec - 15,
    agent: "CU 1",
    thread: "r-help-parent",
  }));

  const helpVm = WorkspaceAdapter.mapRuns(
    [helpParent, helpChild],
    {
      "r-help-parent": { ...helpParent, events: [] },
      "r-help-child": { ...helpChild, events: [] },
    },
    rawPendingHelp,
    { connectionStatus: "connected", isSampleData: false, agentsById: {}, nowSec }
  );

  assert.equal(helpVm.runs[0].state, "waiting");
  assert.equal(helpVm.runs[0].pendingHelp.length, approvalCases.length);
  for (const expected of approvalCases) {
    const actual = helpVm.runs[0].pendingHelp.find((h) => h.id === expected.id);
    assert.ok(actual, `Missing mapped help item ${expected.id}`);
    assert.deepEqual(
      actual.options,
      expected.options,
      `Approval options for ${expected.id} must be passed through unchanged`
    );
    assert.equal(actual.kindWarning, expected.expectWarning, `Warning mismatch for ${expected.id}`);
    assert.equal(actual.isExpired, false, `${expected.id} should not be expired at 15s`);
  }

  // =========================================================================
  // 5. Backend-shape fixtures (ui/fixtures/backend-shape-*.json from origin/main)
  // =========================================================================
  {
    const readBackendFixture = (name) =>
      JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, name), "utf8"));

    const bsRuns = readBackendFixture("backend-shape-runs.json");
    const bsRunDetail = readBackendFixture("backend-shape-run.json");
    const bsHelp = readBackendFixture("backend-shape-help.json");
    const bsAgents = readBackendFixture("backend-shape-agents.json");
    const bsActions = readBackendFixture("backend-shape-actions.json");
    const bsGraph = readBackendFixture("backend-shape-graph.json");
    const bsAnalytics = readBackendFixture("backend-shape-analytics.json");
    const bsCost = readBackendFixture("backend-shape-cost.json");
    const bsTranscripts = readBackendFixture("backend-shape-transcripts.json");
    const bsTranscript = readBackendFixture("backend-shape-transcript.json");
    const bsNotifications = readBackendFixture("backend-shape-notifications.json");
    const bsNotificationsDismiss = readBackendFixture("backend-shape-notifications-dismiss.json");
    const bsFiles = readBackendFixture("backend-shape-files.json");
    const bsProfile = readBackendFixture("backend-shape-profile.json");
    const bsTaskPost = readBackendFixture("backend-shape-task.json");
    const bsHelpPost = readBackendFixture("backend-shape-help-post.json");

    assert.ok(Array.isArray(bsRuns) && bsRuns.length === 4, "backend-shape-runs.json must have 4 run views");
    assert.equal(bsRunDetail.id, "r1763149000-2-c3d4", "backend-shape-run.json must be child run view");
    assert.ok(Array.isArray(bsHelp) && bsHelp.length === 1, "backend-shape-help.json must have 1 pending help item");
    assert.equal(bsHelp[0].agent, "Leo", "backend-shape-help.json must include agent");
    assert.equal(bsHelp[0].thread, "r1763149010-3-e5f6", "backend-shape-help.json must include thread");
    assert.equal(typeof bsAgents, "object", "backend-shape-agents.json must be an object");
    assert.ok(Array.isArray(bsActions.actions), "backend-shape-actions.json must have actions array");
    assert.equal(bsGraph.screens, 5, "backend-shape-graph.json must have screens count");
    assert.equal(bsAnalytics.tasks, 2, "backend-shape-analytics.json must have tasks count");
    assert.equal(bsCost.run, "r1763149000-1-a1b2", "backend-shape-cost.json must match parent run");
    assert.ok(Array.isArray(bsTranscripts) && bsTranscripts.length >= 1, "backend-shape-transcripts.json must be array");
    assert.ok(Array.isArray(bsTranscript) && bsTranscript.length >= 1, "backend-shape-transcript.json must be array");
    assert.ok(bsTranscript.some((m) => m.role === "agent" && typeof m.color === "string"), "backend-shape-transcript.json agent rows must include color");
    assert.ok(Array.isArray(bsNotifications) && bsNotifications.length >= 1, "backend-shape-notifications.json must be array");
    assert.equal(bsNotificationsDismiss.ok, true, "backend-shape-notifications-dismiss.json must have ok: true");
    assert.ok(Array.isArray(bsFiles) && bsFiles.length >= 1, "backend-shape-files.json must be array");
    assert.equal(typeof bsProfile.model, "string", "backend-shape-profile.json must include model");
    assert.equal(typeof bsTaskPost.run, "string", "backend-shape-task.json must include run");
    assert.equal(typeof bsTaskPost.thread, "string", "backend-shape-task.json must include thread");
    assert.equal(bsHelpPost.ok, true, "backend-shape-help-post.json must have ok: true");

    const bsNowSec = 1763149020;
    const vmBackend = WorkspaceAdapter.mapRuns(
      bsRuns,
      { [bsRunDetail.id]: bsRunDetail },
      bsHelp,
      {
        connectionStatus: "connected",
        isSampleData: false,
        agentsById: bsAgents,
        costsById: { [bsCost.run]: bsCost },
        nowSec: bsNowSec,
      }
    );

    assert.equal(vmBackend.runs.length, 2, "backend-shape: expected 2 parent run groups");

    const waitingRun = vmBackend.runs.find((r) => r.id === "r1763149010-3-e5f6");
    assert.ok(waitingRun, "backend-shape: expected waiting parent run r1763149010-3-e5f6");
    assert.equal(waitingRun.state, "waiting", "backend-shape: active run with pending help must be waiting");
    assert.equal(waitingRun.stateSymbolWord, "◔ Needs approval");
    assert.equal(waitingRun.pendingHelp.length, 1);
    assert.equal(waitingRun.pendingHelp[0].id, "h1");
    assert.equal(waitingRun.pendingHelp[0].kindWarning, "This spends money");
    assert.equal(waitingRun.pendingHelp[0].isExpired, false);
    assert.equal(waitingRun.steps.length, 1);
    assert.equal(waitingRun.steps[0].agentIdentity.name, "Leo");
    assert.equal(waitingRun.steps[0].agentIdentity.color, "#EECED6");

    const verifiedRun = vmBackend.runs.find((r) => r.id === "r1763149000-1-a1b2");
    assert.ok(verifiedRun, "backend-shape: expected verified parent run r1763149000-1-a1b2");
    assert.equal(verifiedRun.state, "verified", "backend-shape: completed run with verify pass must be verified");
    assert.equal(verifiedRun.stateSymbolWord, "✓ Verified");
    assert.equal(verifiedRun.evidenceText, "Calculator display reads 248");
    assert.equal(verifiedRun.steps.length, 1);
    assert.equal(verifiedRun.steps[0].agentIdentity.name, "Iris");
    assert.equal(verifiedRun.steps[0].agentIdentity.color, "#B5D0EB");
    assert.equal(verifiedRun.steps[0].app, "Calculator");
    assert.ok(verifiedRun.digest, "backend-shape: verified run must include digest");
    assert.equal(verifiedRun.digest.totalSteps, 2);
    assert.equal(verifiedRun.digest.memorySteps, 1);
    assert.equal(verifiedRun.digest.costUsd, 0.0049);
    assert.equal(verifiedRun.digest.costText, "$0.0049");
  }

  // =========================================================================
  // 6. Parallel chat isolation & transcript action-line filtering
  // =========================================================================
  {
    const fx = loadFixtureNormalized("two-chats-parallel.json", nowSec);
    const vmParallel = WorkspaceAdapter.mapRuns(fx.runs, fx.details, fx.help, {
      connectionStatus: "connected",
      isSampleData: false,
      agentsById: fx.agents,
      transcriptsById: fx.transcripts,
      nowSec,
    });

    assert.equal(vmParallel.runs.length, 2, "two-chats-parallel: expected 2 parent chats");
    const mercury = vmParallel.runs.find((r) => r.id === "r-chat-mercury");
    const cal = vmParallel.runs.find((r) => r.id === "r-chat-cal");
    assert.ok(mercury && cal, "two-chats-parallel: expected both Mercury and Cal chats");
    assert.equal(mercury.steps[0].agentIdentity.name, "Mercury", "two-chats-parallel: Mercury step 0 name");
    assert.equal(cal.steps[0].agentIdentity.name, "Cal", "two-chats-parallel: Cal step 0 name");

    for (const row of mercury.transcriptRows) {
      const hay = `${row.who || ""} ${row.text || ""}`;
      assert.ok(!hay.includes("Cal") && !hay.includes("408"), `two-chats-parallel: Mercury transcript leaked Cal: ${hay}`);
    }
    for (const row of cal.transcriptRows) {
      const hay = `${row.who || ""} ${row.text || ""}`;
      assert.ok(!hay.includes("Mercury") && !hay.includes("Q3-Ledger"), `two-chats-parallel: Cal transcript leaked Mercury: ${hay}`);
    }

    const pollutedTranscripts = {
      ...fx.transcripts,
      "r-chat-mercury": [
        ...(fx.transcripts["r-chat-mercury"] || []),
        {
          id: 999,
          ts: 1763149252.5,
          run: "r-chat-cal-cu",
          role: "agent",
          agent: "Cal",
          kind: "result",
          text: "Cal leaked 408",
        },
      ],
    };
    const vmPolluted = WorkspaceAdapter.mapRuns(fx.runs, fx.details, fx.help, {
      connectionStatus: "connected",
      isSampleData: false,
      agentsById: fx.agents,
      transcriptsById: pollutedTranscripts,
      nowSec,
    });
    const mercuryPolluted = vmPolluted.runs.find((r) => r.id === "r-chat-mercury");
    assert.ok(
      !mercuryPolluted.transcriptRows.some((row) => row.id === "999" || `${row.who} ${row.text}`.includes("Cal")),
      "two-chats-parallel: foreign-run transcript row must be rejected"
    );
  }

  {
    const fx = loadFixtureNormalized("transcript-action-lines.json", nowSec);
    const vmActions = WorkspaceAdapter.mapRuns(fx.runs, fx.details, fx.help, {
      connectionStatus: "connected",
      isSampleData: false,
      agentsById: fx.agents,
      transcriptsById: fx.transcripts,
      nowSec,
    });

    assert.equal(vmActions.runs.length, 1, "transcript-action-lines: expected 1 parent run");
    const run = vmActions.runs[0];
    const bubbleIds = run.transcriptRows.map((r) => r.id);
    assert.deepEqual(bubbleIds, ["1", "2", "9"], "transcript-action-lines: action lines must not become chat bubbles");
    const actionIds = new Set(["3", "4", "5", "6", "7", "8"]);
    for (const row of run.transcriptRows) {
      assert.ok(!actionIds.has(row.id), `transcript-action-lines: action row ${row.id} leaked into chat bubbles`);
    }

    const step0 = run.steps[0];
    assert.equal(step0.workStepCount, 6, "transcript-action-lines: expected 6 counted action steps");
    const expectedActionSteps = [
      "Enter 8 * 31 into Calculator",
      "Pressed return",
      "Clicked 3",
      "Clicked 2",
      "Typed in display",
      "Clicked 3",
    ];
    for (const expectedLine of expectedActionSteps) {
      assert.ok(
        step0.workSteps.includes(expectedLine),
        `transcript-action-lines: missing action line "${expectedLine}" in steps[0].workSteps`
      );
    }
  }

  // =========================================================================
  // 8. A8: Pipeline error notice & stopped children + raw Details toggle
  // =========================================================================
  {
    const fx = loadFixtureNormalized("a8-broken-error.json", nowSec);
    const vmBroken = WorkspaceAdapter.mapRuns(fx.runs, fx.details, fx.help, {
      connectionStatus: "connected",
      isSampleData: false,
      agentsById: fx.agents,
      transcriptsById: fx.transcripts,
      nowSec,
    });
    assert.equal(vmBroken.runs.length, 1, "a8-broken-error: expected 1 parent run");
    const brokenRun = vmBroken.runs[0];
    const errRow = brokenRun.transcriptRows.find((r) => r.id === "3");
    assert.ok(errRow, "a8-broken-error: missing transcript error row");
    assert.equal(
      errRow.text,
      "This task stopped because something went wrong on our side. Nothing else was done. Send it again to retry.",
      "a8-broken-error: raw error message must be replaced with plain generic copy"
    );
    assert.equal(
      errRow.rawErrorText,
      "Something broke: no JSON object in model reply (line 1 col 1)",
      "a8-broken-error: raw error text must be preserved for Details toggle"
    );
    assert.ok(
      !`${brokenRun.stateSymbolWord} ${brokenRun.stateFact} ${brokenRun.pillFact} ${brokenRun.failureLineText}`.includes("no JSON object"),
      "a8-broken-error: raw error text must not leak into run summary fields"
    );
    for (const childStep of brokenRun.steps) {
      assert.equal(childStep.isStoppedByTaskError, true, `a8-broken-error: child ${childStep.id} must be flagged isStoppedByTaskError`);
      assert.ok(!childStep.stateSymbolWord.includes("✓"), `a8-broken-error: child ${childStep.id} must not render checkmark`);
      assert.equal(childStep.latestSummary, "", `a8-broken-error: child ${childStep.id} must not duplicate error summary`);
    }

    // Credit / 402 variant
    const vmCredit = WorkspaceAdapter.mapRuns(
      [
        {
          id: "r-credit-1",
          parent: null,
          role: "orchestrator",
          goal: "Check inbox",
          state: "failed",
          result: { ok: false, summary: "orchestrator error: HTTP 402 Payment Required" },
        },
      ],
      {},
      [],
      {
        connectionStatus: "connected",
        isSampleData: false,
        transcriptsById: {
          "r-credit-1": [
            { id: 1, ts: 1, role: "user", kind: "prompt", text: "Check inbox" },
            { id: 2, ts: 2, role: "agent", kind: "error", text: "Something broke: 402 Payment Required — out of credit" },
          ],
        },
        nowSec,
      }
    );
    const creditRow = vmCredit.runs[0].transcriptRows.find((r) => r.id === "2");
    assert.equal(
      creditRow.text,
      "The model account is out of credit. Add credit, then send this again.",
      "a8-broken-error: 402/credit error must use credit guidance"
    );

    const convsBroken = WorkspaceAdapter.buildAgentConversations(vmBroken, {
      primaryThread: "r-a8-broken-1",
    });
    const brokenConv = convsBroken.byId.get("__primary__");
    assert.equal(
      brokenConv.lastLinePreview,
      "This task stopped because something went wrong on our side. Nothing else was done. Send it again to retry.",
      "a8-broken-error: row preview must match A8 error sentence"
    );

    const convsCredit = WorkspaceAdapter.buildAgentConversations(vmCredit, {
      primaryThread: "r-credit-1",
    });
    const creditConv = convsCredit.byId.get("__primary__");
    assert.equal(
      creditConv.lastLinePreview,
      "The model account is out of credit. Add credit, then send this again.",
      "a8-broken-error: row preview must match A8 credit sentence"
    );

    // Chat DOM rendering: raw text absent until Details is opened
    const indexSrc = fs.readFileSync(INDEX_HTML_PATH, "utf8");
    const renderFnSrc = extractStatement(indexSrc, /\bfunction renderAgentTaskHtml\s*\(/, "renderAgentTaskHtml");
    const openErrorDetailIds = new Set();
    const escapeHtml = (s) =>
      String(s ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    const renderCtx = {
      escapeHtml,
      WorkspaceAdapter,
      openWorkKeys: new Set(),
      openResultDetailIds: new Set(),
      openErrorDetailIds,
      openOutputPreviewIds: new Set(),
      copiedItemIds: new Set(),
      stopNoticesByRunId: new Map(),
      pendingStopIds: new Set(),
      stopRouteSupported: false,
      ttsSpeaking: false,
      getPrimaryAgentRowIdentity: () => ({ name: "ComputerAnything", palette: {} }),
      renderAgentChipHtml: (id) => `<span class="chip">${escapeHtml(id?.name || "Agent")}</span>`,
      renderWorkDividerHtml: () => "",
      getVisibleMemoriesForRun: () => [],
      pendingUndoMemoryIds: new Set(),
    };
    vm.runInNewContext(`${renderFnSrc}\nthis.renderAgentTaskHtml = renderAgentTaskHtml;`, renderCtx);
    const htmlClosed = renderCtx.renderAgentTaskHtml(brokenRun, { identity: { name: "ComputerAnything", palette: {} } }, vmBroken);
    assert.ok(
      htmlClosed.includes("This task stopped because something went wrong on our side. Nothing else was done. Send it again to retry."),
      "a8-broken-error: visible chat must show plain error line"
    );
    assert.ok(htmlClosed.includes("Details"), "a8-broken-error: visible chat must offer Details toggle");
    assert.ok(!htmlClosed.includes("no JSON object"), "a8-broken-error: raw error text must NOT appear in visible chat before Details is opened");
    assert.ok(!htmlClosed.includes("Something broke:"), "a8-broken-error: raw 'Something broke:' must NOT appear before Details is opened");
    assert.ok(!htmlClosed.includes("✓"), "a8-broken-error: stopped children must NOT show ✓");
    const quietStopCount = (htmlClosed.match(/chat-quiet-stop/g) || []).length;
    assert.equal(quietStopCount, 2, "a8-broken-error: each stopped child must show one quiet stop line under its name");
    const sideCount = (htmlClosed.match(/something went wrong on our side/g) || []).length;
    assert.equal(sideCount, 1, "a8-broken-error: parent error line must appear only once for the task");

    const errKeyMatch = htmlClosed.match(/data-error-key="([^"]+)"/);
    assert.ok(errKeyMatch, "a8-broken-error: Details button must expose data-error-key");
    openErrorDetailIds.add(errKeyMatch[1]);
    const htmlOpen = renderCtx.renderAgentTaskHtml(brokenRun, { identity: { name: "ComputerAnything", palette: {} } }, vmBroken);
    assert.ok(
      htmlOpen.includes("Something broke: no JSON object in model reply (line 1 col 1)"),
      "a8-broken-error: raw error text must appear once Details is opened"
    );
  }

  // =========================================================================
  // 9. A10: Follow-up task in an agent conversation (root -> followup orchestrator -> agent)
  // =========================================================================
  {
    const fx = loadFixtureNormalized("a10-followup.json", nowSec);
    const vmFollow = WorkspaceAdapter.mapRuns(fx.runs, fx.details, fx.help, {
      connectionStatus: "connected",
      isSampleData: false,
      agentsById: fx.agents,
      transcriptsById: fx.transcripts,
      nowSec,
    });
    const convs = WorkspaceAdapter.buildAgentConversations(vmFollow, {
      primaryThread: "r1794717957-5-9b96",
    });
    const primaryConv = convs.byId.get("__primary__");
    assert.ok(primaryConv, "a10-followup: expected primary conversation");
    assert.equal(primaryConv.tasks.length, 2, "a10-followup: conversation must have 2 tasks (first + follow-up)");

    const firstTask = primaryConv.tasks[0];
    const followTask = primaryConv.tasks[1];
    assert.equal(firstTask.id, "r1794717957-5-9b96", "a10-followup: first task must be root run");
    assert.equal(followTask.id, "r1794718608-7-a38f", "a10-followup: second task must be follow-up orchestrator run");

    assert.equal(firstTask.steps.length, 1, "a10-followup: first task must have 1 child agent step");
    assert.equal(firstTask.steps[0].agentIdentity.name, "Mia", "a10-followup: first task agent must be Mia");
    assert.equal(followTask.steps.length, 1, "a10-followup: follow-up task must have 1 child agent step");
    assert.equal(followTask.steps[0].agentIdentity.name, "Ava", "a10-followup: follow-up task agent must be Ava");
    assert.equal(followTask.steps[0].agentIdentity.color, "#B5D0EB", "a10-followup: follow-up agent Ava color must come from transcript");

    assert.ok(
      firstTask.transcriptRows.some((r) => r.text.includes("Mia")) &&
        !firstTask.transcriptRows.some((r) => r.text.includes("Ava") || r.text.includes("4 + 4")),
      "a10-followup: first task transcript must stay scoped to first task"
    );
    assert.ok(
      followTask.transcriptRows.some((r) => r.text.includes("Ava")) &&
        followTask.transcriptRows.some((r) => r.text.includes("4 + 4")) &&
        !followTask.transcriptRows.some((r) => r.text.includes("Mia") || r.text.includes("6 + 9")),
      "a10-followup: follow-up task transcript must stay scoped to follow-up task"
    );

    assert.equal(primaryConv.latestTask.id, followTask.id, "a10-followup: newest task must be follow-up");
    assert.equal(primaryConv.latestTask.goal, "compute 4 + 4 in Calculator", "a10-followup: newest task drives header prompt");
    assert.equal(primaryConv.listClockText, followTask.listClockText, "a10-followup: row clock must come from newest task");
    assert.notEqual(followTask.listClockText, firstTask.listClockText, "a10-followup: follow-up clock differs from first task");
    assert.equal(
      primaryConv.lastLinePreview,
      "Finished · sample run, not verified",
      `a10-followup: sample-run row preview must match compact result line, got "${primaryConv.lastLinePreview}"`
    );
    assert.ok(
      !/\bmock\b/i.test(primaryConv.lastLinePreview),
      `a10-followup: word "mock" must never appear in row preview, got "${primaryConv.lastLinePreview}"`
    );

    // Render both tasks + Work rows + compact result lines + live follow-up state
    const indexSrc = fs.readFileSync(INDEX_HTML_PATH, "utf8");
    const renderWorkFnSrc = extractStatement(indexSrc, /\bfunction renderWorkDividerHtml\s*\(/, "renderWorkDividerHtml");
    const renderTaskFnSrc = extractStatement(indexSrc, /\bfunction renderAgentTaskHtml\s*\(/, "renderAgentTaskHtml");
    const escapeHtml = (s) =>
      String(s ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    const renderCtx = {
      escapeHtml,
      WorkspaceAdapter,
      openWorkKeys: new Set(),
      openResultDetailIds: new Set(),
      openErrorDetailIds: new Set(),
      openOutputPreviewIds: new Set(),
      copiedItemIds: new Set(),
      stopNoticesByRunId: new Map(),
      pendingStopIds: new Set(),
      stopRouteSupported: true,
      ttsSpeaking: false,
      WorkspaceAdapter,
      getPrimaryAgentRowIdentity: () => ({ name: "ComputerAnything", color: "#B5D0EB", rawEdge: "#D6E9FF", palette: { body: "#B5D0EB", edge: "#D6E9FF", ink: "#2F647C" } }),
      renderAgentChipHtml: (id) => `<span class="chip">${escapeHtml(id?.name || "Agent")}</span>`,
      getVisibleMemoriesForRun: () => [],
      pendingUndoMemoryIds: new Set(),
    };
    vm.runInNewContext(
      `${renderWorkFnSrc}\n${renderTaskFnSrc}\nthis.renderWorkDividerHtml = renderWorkDividerHtml;\nthis.renderAgentTaskHtml = renderAgentTaskHtml;`,
      renderCtx
    );

    // With step act events and non-mock verified results, both tasks render their own agent, Work row, and result line
    const workRuns = JSON.parse(JSON.stringify(fx.runs)).map((r) => {
      const nextSummary = r.goal.includes("4 + 4") ? "Calculated 8" : "Calculated 15";
      return {
        ...r,
        result: {
          ...r.result,
          summary: nextSummary,
          steps: 1,
          ...(r.result?.digest ? { digest: { ...r.result.digest, summary: nextSummary, steps: 1 } } : {}),
        },
      };
    });
    const workDetails = {
      "r1794717957-6-6e62": {
        id: "r1794717957-6-6e62",
        events: [
          { t: 0.4, kind: "act", step: 0, action: "click:button:6", agent: "Mia" },
          { t: 1.0, kind: "verify", achieved: true, evidence: "Calculator displays 15" },
        ],
      },
      "r1794718608-8-de2b": {
        id: "r1794718608-8-de2b",
        events: [
          { t: 0.4, kind: "act", step: 0, action: "click:button:4", agent: "Ava" },
          { t: 1.0, kind: "verify", achieved: true, evidence: "Calculator displays 8" },
        ],
      },
    };
    const vmWork = WorkspaceAdapter.mapRuns(workRuns, workDetails, [], {
      connectionStatus: "connected",
      isSampleData: false,
      transcriptsById: fx.transcripts,
      costsById: {
        "r1794717957-5-9b96": { run: "r1794717957-5-9b96", cost_usd: 0.0021 },
        "r1794718608-7-a38f": { run: "r1794718608-7-a38f", cost_usd: 0.0014 },
      },
      nowSec,
    });
    const convWork = WorkspaceAdapter.buildAgentConversations(vmWork, {
      primaryThread: "r1794717957-5-9b96",
    }).byId.get("__primary__");
    assert.equal(convWork.tasks.length, 2, "a10-followup (work): expected 2 tasks");
    const htmlTask1 = renderCtx.renderAgentTaskHtml(convWork.tasks[0], convWork, vmWork, false);
    const htmlTask2 = renderCtx.renderAgentTaskHtml(convWork.tasks[1], convWork, vmWork, true);

    assert.ok(htmlTask1.includes("One agent will do this."), "a10-followup: task 1 must render plan line");
    assert.ok(htmlTask1.includes("Asked Mia to help"), "a10-followup: task 1 must render Mia handoff");
    assert.ok(htmlTask1.includes("work-divider-wrap") && htmlTask1.includes("Work · Mia · 1 step"), "a10-followup: task 1 must render Mia Work row");
    assert.equal((htmlTask1.match(/chat-result-line/g) || []).length, 1, "a10-followup: task 1 must render 1 compact result line");
    assert.ok(htmlTask1.includes("$0.0021") && htmlTask1.includes("copy-result"), "a10-followup: task 1 result line must include cost and copy control");

    assert.ok(htmlTask2.includes("One agent will do this."), "a10-followup: task 2 must render plan line");
    assert.ok(htmlTask2.includes("Asked Ava to help"), "a10-followup: task 2 must render Ava handoff");
    assert.ok(htmlTask2.includes("work-divider-wrap") && htmlTask2.includes("Work · Ava · 1 step"), "a10-followup: task 2 must render Ava Work row");
    assert.equal((htmlTask2.match(/chat-result-line/g) || []).length, 1, "a10-followup: task 2 must render 1 compact result line");
    assert.ok(htmlTask2.includes("$0.0014") && htmlTask2.includes("copy-result"), "a10-followup: task 2 result line must include cost and copy control");
    assert.equal(convWork.lastLinePreview, "Calculator displays 8", "a10-followup (work): newest task result must drive row preview");
    assert.equal(
      WorkspaceAdapter.buildTaskCompactLine(convWork.tasks[1]),
      convWork.lastLinePreview,
      "a10-followup (work): row preview and compact result line must come from the same builder"
    );

    // While follow-up is running: collapsed notch liveAgents, per-agent Stop, and live status track follow-up
    const liveRuns = JSON.parse(JSON.stringify(workRuns)).map((r) =>
      r.id === "r1794718608-7-a38f" || r.id === "r1794718608-8-de2b"
        ? { ...r, state: "acting", result: null }
        : r
    );
    const vmLive = WorkspaceAdapter.mapRuns(liveRuns, workDetails, [], {
      connectionStatus: "connected",
      isSampleData: false,
      transcriptsById: fx.transcripts,
      nowSec,
    });
    const convLive = WorkspaceAdapter.buildAgentConversations(vmLive, {
      primaryThread: "r1794717957-5-9b96",
    }).byId.get("__primary__");
    assert.equal(vmLive.liveAgents.length, 1, "a10-followup (live): collapsed notch must track the running follow-up agent");
    assert.equal(vmLive.liveAgents[0].name, "Ava", "a10-followup (live): collapsed notch dot must be Ava");
    assert.deepEqual([...convLive.liveRunIds], ["r1794718608-7-a38f"], "a10-followup (live): Stop targets follow-up orchestrator");
    const htmlLive2 = renderCtx.renderAgentTaskHtml(convLive.tasks[1], convLive, vmLive, false);
    assert.ok(
      htmlLive2.includes('data-action="stop-agent" data-run-id="r1794718608-8-de2b"'),
      "a10-followup (live): per-agent Stop must address Ava's follow-up child run"
    );

    // Restart case where server's /api/runs omits grandchildren (r1794718608-8-de2b)
    const restartRuns = fx.runs.filter((r) => r.id !== "r1794718608-8-de2b");
    const vmRestart = WorkspaceAdapter.mapRuns(restartRuns, {}, [], {
      connectionStatus: "connected",
      isSampleData: false,
      transcriptsById: fx.transcripts,
      nowSec,
    });
    const convRestart = WorkspaceAdapter.buildAgentConversations(vmRestart, {
      primaryThread: "r1794717957-5-9b96",
    }).byId.get("__primary__");
    assert.equal(convRestart.tasks.length, 2, "a10-followup (restart): follow-up task must survive even if grandchild omitted");
    assert.ok(
      convRestart.tasks[1].transcriptRows.some((r) => r.text.includes("Ava")),
      "a10-followup (restart): follow-up must retain its transcript rows"
    );
  }

  // =========================================================================
  // 10. A11: Unified row preview / compact result line + new-agent form input
  // =========================================================================
  {
    const indexSrc = fs.readFileSync(INDEX_HTML_PATH, "utf8");
    const renderWorkFnSrc = extractStatement(indexSrc, /\bfunction renderWorkDividerHtml\s*\(/, "renderWorkDividerHtml");
    const renderTaskFnSrc = extractStatement(indexSrc, /\bfunction renderAgentTaskHtml\s*\(/, "renderAgentTaskHtml");
    const escapeHtml = (s) =>
      String(s ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    const renderCtx = {
      escapeHtml,
      WorkspaceAdapter,
      openWorkKeys: new Set(),
      openResultDetailIds: new Set(),
      openErrorDetailIds: new Set(),
      openOutputPreviewIds: new Set(),
      copiedItemIds: new Set(),
      stopNoticesByRunId: new Map(),
      pendingStopIds: new Set(),
      stopRouteSupported: true,
      ttsSpeaking: false,
      WorkspaceAdapter,
      getPrimaryAgentRowIdentity: () => ({ name: "ComputerAnything", color: "#B5D0EB", rawEdge: "#D6E9FF", palette: { body: "#B5D0EB", edge: "#D6E9FF", ink: "#2F647C" } }),
      renderAgentChipHtml: (id) => `<span class="chip">${escapeHtml(id?.name || "Agent")}</span>`,
      getVisibleMemoriesForRun: () => [],
      pendingUndoMemoryIds: new Set(),
    };
    vm.runInNewContext(
      `${renderWorkFnSrc}\n${renderTaskFnSrc}\nthis.renderWorkDividerHtml = renderWorkDividerHtml;\nthis.renderAgentTaskHtml = renderAgentTaskHtml;`,
      renderCtx
    );

    // Sample run row (mock-finished.json) -> "Finished · sample run, not verified" and never "mock"
    const fxMock = loadFixtureNormalized("mock-finished.json", nowSec);
    const vmMock = WorkspaceAdapter.mapRuns(fxMock.runs, fxMock.details, fxMock.help, {
      connectionStatus: "connected",
      isSampleData: false,
      agentsById: fxMock.agents,
      nowSec,
    });
    const convsMock = WorkspaceAdapter.buildAgentConversations(vmMock, {
      createdAgents: [{ id: "nova", name: "Nova", swatch: "rose", thread: "r-mock-calc-1", threads: ["r-mock-calc-1"] }],
    });
    const novaConv = convsMock.byId.get("nova");
    assert.ok(novaConv, "a11: expected Nova conversation for sample run");
    assert.equal(novaConv.lastLinePreview, "Finished · sample run, not verified", "a11: sample run row must match compact result line");
    assert.ok(!/\bmock\b/i.test(novaConv.lastLinePreview), "a11: word 'mock' must never appear in sample-run row");
    const htmlMock = renderCtx.renderAgentTaskHtml(novaConv.tasks[0], novaConv, vmMock, true);
    assert.ok(htmlMock.includes("Finished · sample run, not verified"), "a11: sample run conversation must render same compact phrase");

    // Stopped by person (cancelled-chat.json) -> "You said no."
    const fxCancelled = loadFixtureNormalized("cancelled-chat.json", nowSec);
    const vmCancelled = WorkspaceAdapter.mapRuns(fxCancelled.runs, fxCancelled.details, fxCancelled.help, {
      connectionStatus: "connected",
      isSampleData: false,
      agentsById: fxCancelled.agents,
      transcriptsById: fxCancelled.transcripts,
      nowSec,
    });
    const convCancelled = WorkspaceAdapter.buildAgentConversations(vmCancelled, {
      primaryThread: "r1763149100-1",
    }).byId.get("__primary__");
    assert.equal(convCancelled.lastLinePreview, "You said no.", "a11: stopped-by-person row must match failure line");
    const htmlCancelled = renderCtx.renderAgentTaskHtml(convCancelled.tasks[0], convCancelled, vmCancelled, false);
    assert.ok(htmlCancelled.includes("You said no."), "a11: stopped-by-person conversation must render same phrase");

    // Still working -> "● Working"
    const fxWorking = loadFixtureNormalized("working-live.json", nowSec);
    const vmWorking = WorkspaceAdapter.mapRuns(fxWorking.runs, fxWorking.details, fxWorking.help, {
      connectionStatus: "connected",
      isSampleData: false,
      agentsById: fxWorking.agents,
      nowSec,
    });
    const convWorking = WorkspaceAdapter.buildAgentConversations(vmWorking, {
      primaryThread: "r1763140600-1",
    }).byId.get("__primary__");
    assert.equal(convWorking.lastLinePreview, "● Working", "a11: still-working row must show '● Working'");

    // Waiting for person -> pending help question
    const fxWait = loadFixtureNormalized("awaiting-approval.json", nowSec);
    const vmWait = WorkspaceAdapter.mapRuns(fxWait.runs, fxWait.details, fxWait.help, {
      connectionStatus: "connected",
      isSampleData: false,
      agentsById: fxWait.agents,
      nowSec,
    });
    const convWait = WorkspaceAdapter.buildAgentConversations(vmWait, {
      primaryThread: fxWait.runs.find((r) => !r.parent).id,
    }).byId.get("__primary__");
    assert.ok(
      convWait.lastLinePreview && convWait.lastLinePreview !== "No tasks yet" && !/\bmock\b/i.test(convWait.lastLinePreview),
      `a11: waiting row must show waiting prompt, got "${convWait.lastLinePreview}"`
    );
    assert.equal(
      convWait.lastLinePreview,
      WorkspaceAdapter.buildTaskCompactLine(convWait.latestTask, { waitingTask: convWait.tasks[0] }),
      "a11: waiting row must use shared compact builder"
    );

    // Requirement 2: New-agent form name field framing, focus, Enter/Esc, 5 colors
    const nameCssBlock = indexSrc.match(/\.agent-name-input\s*\{[^}]+\}/)?.[0] || "";
    const nameFocusBlock = indexSrc.match(/\.agent-name-input:focus[\s\S]*?\{[^}]+\}/)?.[0] || "";
    assert.ok(nameCssBlock.includes("border:"), "a11: .agent-name-input must define a visible border");
    assert.ok(nameCssBlock.includes("border-radius:"), "a11: .agent-name-input must define border-radius");
    assert.ok(nameCssBlock.includes("padding:"), "a11: .agent-name-input must define padding");
    assert.ok(nameCssBlock.includes("background: #121418"), "a11: .agent-name-input must match chat input bar background");
    assert.ok(nameFocusBlock.includes("box-shadow:") && nameFocusBlock.includes("var(--focus-ring)"), "a11: .agent-name-input must show visible focus ring");

    const swatchSelectedCss = indexSrc.match(/\.agent-swatch-btn\[aria-checked="true"\]\s*\{[^}]+\}/)?.[0] || "";
    assert.ok(swatchSelectedCss.includes("box-shadow:"), "a11: selected color swatch must keep a visible selected ring");

    const renderFormFnSrc = extractStatement(indexSrc, /\bfunction renderAgentFormHtml\s*\(/, "renderAgentFormHtml");
    const formCtx = {
      escapeHtml,
      WorkspaceAdapter,
      PRIMARY_AGENT_SWATCHES: WorkspaceAdapter.DEFAULT_AGENT_SWATCHES,
      agentFormState: { mode: "create", agentId: "", name: "", swatch: "lagoon", returnView: "list", error: "" },
    };
    vm.runInNewContext(`${renderFormFnSrc}\nthis.renderAgentFormHtml = renderAgentFormHtml;`, formCtx);
    const formHtml = formCtx.renderAgentFormHtml();
    assert.ok(formHtml.includes('id="agent-name-input"'), "a11: form must render #agent-name-input");
    assert.ok(formHtml.includes('class="agent-name-input"'), "a11: #agent-name-input must use framed .agent-name-input class");
    assert.ok(formHtml.includes('placeholder="Agent name"'), "a11: #agent-name-input must keep 'Agent name' placeholder");
    assert.equal((formHtml.match(/class="agent-swatch-btn"/g) || []).length, 5, "a11: form must keep 5 color swatches");
    assert.ok(!formHtml.includes("<label"), "a11: no new visible label text on screen");
    assert.ok(indexSrc.includes('if (e.target && e.target.id === "agent-name-input" && agentFormState)'), "a11: Enter handler on #agent-name-input must submit form");
  }
}

try {
  runChecks();
  console.log("CHECK PASS");
} catch (err) {
  console.error("CHECK FAIL:", err?.message || err);
  process.exit(1);
}
