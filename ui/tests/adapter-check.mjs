import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const UI_DIR = path.resolve(__dirname, "..");
const INDEX_HTML_PATH = path.join(UI_DIR, "index.html");
const FIXTURES_DIR = path.join(UI_DIR, "fixtures");

/**
 * Extract WorkspaceAdapter IIFE from ui/index.html and evaluate it in an isolated VM context.
 */
function loadAdapterFromIndexHtml() {
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
  assert.equal(typeof adapter?.mapRuns, "function", "WorkspaceAdapter.mapRuns must be a function");
  return adapter;
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
    assert.equal(vmSample.runs[0].stateSymbolWord, "✓ Verified (mock)", "qa-loop-verified: sample mode must label mock verification");
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
    assert.equal(run.stateSymbolWord, "× Failed", "failed: symbol+word must be '× Failed'");
    assert.ok(!run.stateSymbolWord.includes("✓"), "failed: must NOT show check mark");
    assert.equal(run.stateColorClass, "state-danger", "failed: color class must be state-danger");
    assert.ok(
      run.stateFact.endsWith("· Nothing was changed."),
      "failed: unapplied patch must append '· Nothing was changed.'"
    );
    for (const step of run.steps) {
      assert.ok(!step.stateSymbolWord.includes("✓"), `failed: child step ${step.id} must NOT have ✓`);
      assert.equal(step.stateSymbolWord, "× Failed", `failed: child step ${step.id} must be '× Failed'`);
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
    assert.equal(r.state, "verified");
    assert.equal(r.stateSymbolWord, "✓ Verified");
    assert.equal(r.evidenceText, "mock");
    assert.equal(r.steps.length, 1);
    assert.equal(r.steps[0].agentIdentity.name, "CU 1");
    assert.equal(r.steps[0].agentIdentity.color, "#B5D0EB");
    assert.equal(r.steps[0].stateSymbolWord, "✓ Verified");

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
      expectSymbolWord: "× Failed",
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
      expectSymbolWord: "× Failed",
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

  // Real pending_help() payload from core/runs.py:111-112
  const rawPendingHelp = approvalCases.map((c, idx) => ({
    id: c.id,
    run: "r-help-child",
    kind: c.kind,
    question: `Question for ${c.id}?`,
    options: [...c.options],
    detail: idx % 2 === 0 ? null : `Detail for ${c.id}`,
    answer: null,
    asked: nowSec - 15,
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
}

try {
  runChecks();
  console.log("CHECK PASS");
} catch (err) {
  console.error("CHECK FAIL:", err?.message || err);
  process.exit(1);
}
