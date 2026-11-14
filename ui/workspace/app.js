(function () {
  "use strict";

  const params = new URLSearchParams(window.location.search);
  let activeFixtureName = params.get("fixture") || "";
  const queryToken = params.get("t") || "";
  const hasShellBridge = () => Boolean(window.webkit?.messageHandlers?.shell);

  /* ============================================================================
     0. SEA-GLASS MATERIAL & PALETTE HELPERS (Section 3 — via ui/shared/agent-glass.js)
     ============================================================================ */
  const SharedGlass = window.AgentGlass || {
    BACKEND_PALETTES: [
      { key: "lagoon", name: "Lagoon", color: "#B5D0EB", edge: "#D6E9FF", ink: "#2F647C" },
      { key: "rose",   name: "Rose",   color: "#EECED6", edge: "#FFF0F1", ink: "#963F59" },
      { key: "mint",   name: "Mint",   color: "#C0DED0", edge: "#E6FFF0", ink: "#396C5A" },
      { key: "lilac",  name: "Lilac",  color: "#E1CDE8", edge: "#FBE8F7", ink: "#71388B" },
      { key: "amber",  name: "Amber",  color: "#F0D9BE", edge: "#FFFCE0", ink: "#865733" },
    ],
    darkenInk(hex) {
      return hex || "#234B5D";
    },
    hashAgentSeed(str) {
      const s = String(str || "agent");
      let h = 2166136261 >>> 0;
      for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619) >>> 0;
      }
      return (h % 99991) + 17;
    },
    resolveAgentPalette(agent) {
      const p = this.BACKEND_PALETTES[0];
      return {
        body: agent?.color || agent?.body || p.color,
        edge: agent?.edge || p.edge,
        ink: this.darkenInk(agent?.ink || p.ink),
        rawInk: agent?.ink || p.ink,
      };
    },
    mountAgentGlass() {
      return null;
    },
  };

  /* 5 backend cursor palettes in order (backend/computeranything/cu/overlay.py).
     Uses backend {color, edge, ink} as given without re-mixing body/edge,
     with label ink darkened 25% toward black (ink * 0.75 per channel). */
  const AGENT_SWATCHES = Object.freeze(
    SharedGlass.BACKEND_PALETTES.map((p) => {
      const resolved = SharedGlass.resolveAgentPalette(p);
      return Object.freeze({
        key: p.key,
        name: p.name,
        color: p.color,
        body: resolved.body,
        edge: resolved.edge,
        ink: resolved.ink,
        rawInk: p.ink,
      });
    })
  );

  function stableSeed(str) {
    return SharedGlass.hashAgentSeed(str);
  }

  const mountedGlassByContainer = new Map();

  function clearMountedGlass(containerKey) {
    const list = mountedGlassByContainer.get(containerKey);
    if (list && list.length) {
      for (const inst of list) {
        try {
          inst.destroy();
        } catch {
          // Ignore cleanup errors
        }
      }
    }
    mountedGlassByContainer.set(containerKey, []);
  }

  function mountGlassElementsIn(containerEl, containerKey) {
    clearMountedGlass(containerKey);
    if (!containerEl) return;
    const mountAgentFn = window.mountAgentGlass || SharedGlass.mountAgentGlass;
    if (typeof mountAgentFn !== "function") return;

    const nodes = Array.from(containerEl.querySelectorAll('[data-glass-mount="1"]'));
    if (!nodes.length) return;

    const mounted = [];
    for (const el of nodes) {
      if (!el.isConnected) continue;
      const color = el.dataset.glassBody || AGENT_SWATCHES[0].body;
      const edge = el.dataset.glassEdge || AGENT_SWATCHES[0].edge;
      const rawInk = el.dataset.glassRawInk || AGENT_SWATCHES[0].rawInk;
      const shape = el.dataset.glassShape || "rounded";
      const seed = Number(el.dataset.glassSeed) || 42;
      try {
        const handle = mountAgentFn(
          el,
          { color, edge, ink: rawInk },
          { shape, seed }
        );
        if (handle) mounted.push(handle);
      } catch {
        // Plain-chip fallback is handled inside mountAgentGlass
      }
    }
    mountedGlassByContainer.set(containerKey, mounted);
  }

  /* ============================================================================
     1. TRANSPORT LAYER (Shell Bridge | Same-Origin Fetch | Fixture Mode)
     ============================================================================ */
  const Transport = (function () {
    let bridgeSeq = 1;
    const pendingBridgeCalls = new Map();

    let sessionToken = queryToken;
    let sessionBaseUrl = queryToken ? window.location.origin : "";
    let fixtureState = null;

    window.__notchBridgeReceive = function (msg) {
      if (!msg) return;
      if (msg.id && pendingBridgeCalls.has(msg.id)) {
        const resolver = pendingBridgeCalls.get(msg.id);
        pendingBridgeCalls.delete(msg.id);
        resolver(msg);
        return;
      }
      if (msg.type === "connectionUpdated" && msg.ok && !activeFixtureName) {
        sessionBaseUrl = msg.baseUrl || "shell";
        sessionToken = "shell-session";
        pollAll();
      }
    };

    function callShell(type, payload) {
      return new Promise((resolve, reject) => {
        if (!hasShellBridge()) {
          reject(new Error("Shell unavailable"));
          return;
        }
        const id = "ws-" + bridgeSeq++;
        pendingBridgeCalls.set(id, resolve);
        try {
          window.webkit.messageHandlers.shell.postMessage({
            type,
            id,
            ...(payload || {}),
          });
        } catch (err) {
          pendingBridgeCalls.delete(id);
          reject(err);
        }
      });
    }

    function parseBackendAddress(raw) {
      const trimmed = String(raw || "").trim();
      if (!trimmed) {
        return { ok: false, error: "Paste the address the backend printed" };
      }
      let parsed;
      try {
        parsed = new URL(trimmed);
      } catch {
        return { ok: false, error: "Address must be a valid URL with ?t=" };
      }
      const token = parsed.searchParams.get("t") || "";
      if (!token) {
        return { ok: false, error: "Address is missing ?t= token" };
      }
      return {
        ok: true,
        baseUrl: parsed.origin,
        token,
      };
    }

    async function init() {
      if (activeFixtureName) {
        await loadFixture(activeFixtureName);
        return { connected: true, isSampleData: true };
      }
      if (hasShellBridge()) {
        const cfg = await callShell("getConfig");
        if (cfg && cfg.connected) {
          sessionBaseUrl = cfg.baseUrl || "shell";
          sessionToken = "shell-session";
          return { connected: true, isSampleData: false };
        }
        return { connected: false, isSampleData: false };
      }
      if (sessionToken && window.location.protocol.startsWith("http")) {
        return { connected: true, isSampleData: false };
      }
      return { connected: false, isSampleData: false };
    }

    async function setConnection(rawUrl) {
      activeFixtureName = "";
      fixtureState = null;
      if (hasShellBridge()) {
        const res = await callShell("setConnection", { url: rawUrl });
        if (!res || !res.ok) {
          return { ok: false, error: res?.error || "Invalid address" };
        }
        sessionBaseUrl = res.baseUrl || "shell";
        sessionToken = "shell-session";
        return { ok: true };
      }

      const parsed = parseBackendAddress(rawUrl);
      if (!parsed.ok) return parsed;

      if (window.location.protocol.startsWith("http") && parsed.baseUrl !== window.location.origin) {
        return {
          ok: false,
          error: "Browser origin differs; open " + parsed.baseUrl + "/ui/workspace.html?t=… or use the desktop shell",
        };
      }

      sessionBaseUrl = parsed.baseUrl;
      sessionToken = parsed.token;
      return { ok: true };
    }

    function clearConnection() {
      sessionToken = "";
      sessionBaseUrl = "";
    }

    function isConnected() {
      if (activeFixtureName) return Boolean(fixtureState);
      return Boolean(sessionToken);
    }

    async function loadFixture(name) {
      const safe = String(name || "").replace(/[^A-Za-z0-9_-]/g, "");
      if (!safe) throw new Error("Invalid fixture name");
      let rawText = "";
      if (hasShellBridge()) {
        const res = await callShell("readFixture", { name: safe });
        if (!res || !res.ok) throw new Error(`Sample fixture "${safe}" not found`);
        rawText = res.body || "";
      } else {
        const res = await fetch(`./fixtures/${safe}.json`, { cache: "no-store" });
        if (!res.ok) throw new Error(`Sample fixture "${safe}" not found`);
        rawText = await res.text();
      }
      const parsed = JSON.parse(rawText);
      const actionList = Array.isArray(parsed.actions?.actions)
        ? parsed.actions.actions
        : Array.isArray(parsed.actions)
          ? parsed.actions
          : [];
      fixtureState = {
        sampleLabel: "Sample data",
        workspaceState: parsed.workspaceState && typeof parsed.workspaceState === "object" ? parsed.workspaceState : null,
        agents: parsed.agents && typeof parsed.agents === "object" ? parsed.agents : {},
        runs: Array.isArray(parsed.runs) ? parsed.runs : [],
        details: parsed.details && typeof parsed.details === "object" ? parsed.details : {},
        help: Array.isArray(parsed.help) ? parsed.help : [],
        transcripts: Array.isArray(parsed.transcripts) ? parsed.transcripts : [],
        actions: actionList,
        graph: parsed.graph && typeof parsed.graph === "object" ? parsed.graph : null,
        analytics: parsed.analytics && typeof parsed.analytics === "object" ? parsed.analytics : null,
        costs: parsed.costs && typeof parsed.costs === "object" ? parsed.costs : {},
        profile: parsed.profile && typeof parsed.profile === "object" ? parsed.profile : { call_me: "" },
        memory: Array.isArray(parsed.memory) ? parsed.memory : null,
      };
      activeFixtureName = safe;
    }

    async function request(method, path, options = {}) {
      if (activeFixtureName) {
        return handleFixtureRequest(method, path, options);
      }

      if (hasShellBridge()) {
        const payload = { method, path };
        if (options.filePaths && options.filePaths.length) {
          payload.filePaths = options.filePaths;
          payload.prompt = options.prompt || "";
        } else if (options.jsonBody !== undefined) {
          payload.body = JSON.stringify(options.jsonBody);
        }
        const res = await callShell("http", payload);
        if (!res || res.status === 0) {
          throw Object.assign(new Error(res?.error || "Not connected"), { code: "NETWORK" });
        }
        let data = null;
        try {
          data = res.body ? JSON.parse(res.body) : {};
        } catch {
          data = {};
        }
        if (!res.ok) {
          throw Object.assign(new Error(data.error || `HTTP ${res.status}`), {
            status: res.status,
            code: res.status === 403 ? "AUTH" : "HTTP",
          });
        }
        return data;
      }

      if (!sessionToken) {
        throw Object.assign(new Error("Not connected"), { code: "AUTH" });
      }

      const fetchOpts = {
        method,
        headers: { "X-CA-Token": sessionToken },
      };
      if (options.formData) {
        fetchOpts.body = options.formData;
      } else if (options.jsonBody !== undefined) {
        fetchOpts.headers["Content-Type"] = "application/json";
        fetchOpts.body = JSON.stringify(options.jsonBody);
      }

      const res = await fetch(path, fetchOpts);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw Object.assign(new Error(data.error || `HTTP ${res.status}`), {
          status: res.status,
          code: res.status === 403 ? "AUTH" : "HTTP",
        });
      }
      return data;
    }

    function handleFixtureRequest(method, path, options) {
      if (!fixtureState) throw new Error("Sample data unavailable");
      const [cleanPath, queryStr] = String(path || "").split("?");
      const q = new URLSearchParams(queryStr || "");

      if (method === "GET" && cleanPath === "/api/runs") {
        return JSON.parse(JSON.stringify(fixtureState.runs));
      }
      if (method === "GET" && cleanPath.startsWith("/api/runs/") && cleanPath.endsWith("/cost")) {
        const runId = decodeURIComponent(cleanPath.slice("/api/runs/".length, -"/cost".length));
        const entry = fixtureState.costs[runId] || {
          run: runId,
          agents: 1,
          llm_calls: 0,
          prompt_tokens: 0,
          completion_tokens: 0,
          cost_usd: 0,
          model_seconds: 0,
          actions: {},
          by_agent: [],
        };
        return JSON.parse(JSON.stringify(entry));
      }
      if (method === "GET" && cleanPath.startsWith("/api/runs/") && cleanPath.endsWith("/transcript")) {
        const runId = decodeURIComponent(cleanPath.slice("/api/runs/".length, -"/transcript".length));
        const rows = (fixtureState.transcripts || []).filter((t) => t.run === runId);
        return JSON.parse(JSON.stringify(rows));
      }
      if (method === "GET" && cleanPath === "/api/transcripts") {
        const query = (q.get("q") || "").trim().toLowerCase();
        const allRows = fixtureState.transcripts || [];
        const matched = query
          ? allRows.filter((row) =>
              [row.text, row.agent, row.role, row.kind, JSON.stringify(row.meta || {})]
                .some((s) => String(s || "").toLowerCase().includes(query))
            )
          : allRows;
        return JSON.parse(JSON.stringify(matched));
      }
      if (method === "GET" && cleanPath.startsWith("/api/runs/")) {
        const idPart = decodeURIComponent(cleanPath.slice("/api/runs/".length));
        const detail = fixtureState.details[idPart] || fixtureState.runs.find((r) => r.id === idPart);
        if (!detail) throw new Error("Run not found");
        return JSON.parse(JSON.stringify(detail));
      }
      if (method === "GET" && cleanPath === "/api/help") {
        return JSON.parse(JSON.stringify(fixtureState.help.filter((h) => h.answer == null)));
      }
      if (method === "GET" && cleanPath === "/api/agents") {
        return JSON.parse(JSON.stringify(fixtureState.agents || {}));
      }
      if (method === "GET" && cleanPath === "/api/actions") {
        const agentFilter = q.get("agent") || "";
        const all = fixtureState.actions || [];
        const filtered = agentFilter
          ? all.filter((a) => a.agent === agentFilter || a.run === agentFilter)
          : all;
        return JSON.parse(JSON.stringify({ total: all.length, actions: filtered }));
      }
      if (method === "GET" && cleanPath === "/api/graph") {
        if (fixtureState.graph) return JSON.parse(JSON.stringify(fixtureState.graph));
        return {
          screens: 0,
          transitions: 0,
          skills: 0,
          apps: [],
          mean_edge_p: null,
          destructive_edges: 0,
          actions_logged: 0,
          agents: [],
        };
      }
      if (method === "GET" && cleanPath === "/api/analytics") {
        if (fixtureState.analytics) return JSON.parse(JSON.stringify(fixtureState.analytics));
        return {
          tasks: 0,
          cost_usd: 0,
          llm_calls: 0,
          mean_cost_per_task: null,
          by_role: [],
          by_purpose: [],
          by_app: [],
        };
      }
      if (method === "GET" && cleanPath === "/api/profile") {
        return JSON.parse(JSON.stringify(fixtureState.profile || { call_me: "" }));
      }
      if (method === "POST" && cleanPath === "/api/profile") {
        fixtureState.profile = {
          ...(fixtureState.profile || {}),
          ...(options.jsonBody || {}),
        };
        return { ok: true, profile: fixtureState.profile };
      }
      if (method === "GET" && cleanPath === "/api/memory") {
        if (!Array.isArray(fixtureState.memory)) {
          throw new Error("HTTP 404");
        }
        return JSON.parse(JSON.stringify(fixtureState.memory));
      }
      if (method === "DELETE" && cleanPath === "/api/memory") {
        if (!Array.isArray(fixtureState.memory)) {
          throw new Error("HTTP 404");
        }
        fixtureState.memory = [];
        return { ok: true };
      }
      if (method === "DELETE" && cleanPath.startsWith("/api/memory/")) {
        if (!Array.isArray(fixtureState.memory)) {
          throw new Error("HTTP 404");
        }
        const mid = decodeURIComponent(cleanPath.slice("/api/memory/".length));
        fixtureState.memory = fixtureState.memory.filter((m) => String(m.id) !== mid);
        return { ok: true };
      }
      if (method === "POST" && cleanPath.startsWith("/api/help/")) {
        const hid = decodeURIComponent(cleanPath.slice("/api/help/".length));
        const choice = options.jsonBody?.choice;
        const item = fixtureState.help.find((h) => h.id === hid);
        if (!item || !item.options.includes(choice)) {
          throw new Error("Choice not in options");
        }
        item.answer = choice;
        const targetRun = fixtureState.runs.find((r) => r.id === item.run);
        const targetDetail = fixtureState.details[item.run];
        const isPositive = choice === item.options[0];
        if (targetRun) {
          targetRun.state = isPositive ? "done" : "failed";
          targetRun.result = {
            ok: isPositive,
            summary: isPositive ? "Completed after confirmation" : `Stopped: ${choice} by user`,
          };
        }
        if (targetDetail) {
          targetDetail.state = targetRun ? targetRun.state : "done";
          targetDetail.events = targetDetail.events || [];
          targetDetail.events.push({
            t: Number(((targetDetail.elapsed || 9) + 0.8).toFixed(1)),
            kind: "help_answer",
            id: hid,
            answer: choice,
            timed_out: false,
          });
          if (isPositive) {
            targetDetail.events.push({
              t: Number(((targetDetail.elapsed || 9) + 1.4).toFixed(1)),
              kind: "verify",
              achieved: true,
              evidence: "Confirmed action after user approval",
            });
          }
          targetDetail.events.push({
            t: Number(((targetDetail.elapsed || 9) + 1.6).toFixed(1)),
            kind: "result",
            ok: isPositive,
            summary: isPositive ? "Completed after confirmation" : `Stopped: ${choice} by user`,
          });
          targetDetail.result = targetRun?.result || null;
        }
        const parentId = targetRun?.parent;
        if (parentId) {
          const siblings = fixtureState.runs.filter((r) => r.parent === parentId);
          const parent = fixtureState.runs.find((r) => r.id === parentId);
          const anyWaiting = siblings.some((s) => s.state === "awaiting_human");
          const anyFailed = siblings.some((s) => s.state === "failed");
          const allDone = siblings.every((s) => s.state === "done");
          if (parent && !anyWaiting) {
            if (anyFailed) {
              parent.state = "failed";
              parent.result = { ok: false, summary: `Stopped: ${choice} by user` };
            } else if (allDone) {
              parent.state = "done";
              parent.result = { ok: true, summary: "All agents it started verified completion" };
            }
          }
        }
        return { ok: true };
      }
      if (method === "POST" && cleanPath === "/api/task") {
        const promptText = options.prompt || options.jsonBody?.prompt || "New task";
        const newId = "r-sample-" + Date.now();
        const childId = newId + "-cu-1";
        const parentRun = {
          id: newId,
          goal: promptText,
          role: "orchestrator",
          parent: null,
          state: "acting",
          elapsed: 0.4,
          n_events: 2,
          result: null,
        };
        const childRun = {
          id: childId,
          goal: promptText,
          role: "cu",
          parent: newId,
          state: "acting",
          elapsed: 0.3,
          n_events: 2,
          result: null,
        };
        const chosenPal = AGENT_SWATCHES[OnboardingState.swatchIndex % AGENT_SWATCHES.length];
        fixtureState.agents[childId] = {
          name: "Iris",
          color: chosenPal.color,
          edge: chosenPal.edge,
          ink: chosenPal.rawInk,
          greeted: true,
        };
        fixtureState.runs.unshift(parentRun, childRun);
        fixtureState.details[newId] = {
          ...parentRun,
          events: [
            { t: 0.1, kind: "state", state: "planning" },
            { t: 0.4, kind: "decide", thought: `Dispatching agent for "${promptText}"`, action: "route:cu" },
          ],
        };
        fixtureState.details[childId] = {
          ...childRun,
          events: [
            { t: 0.1, kind: "state", state: "acting" },
            { t: 0.3, kind: "decide", thought: `Inspecting active window for "${promptText}"`, action: "snapshot" },
          ],
        };
        fixtureState.transcripts.unshift({
          id: Date.now(),
          ts: Date.now() / 1000,
          run: newId,
          role: "user",
          agent: "ComputerAnything",
          kind: "prompt",
          text: promptText,
          meta: { attachments: options.attachedNames || [] },
        });
        return { run: newId };
      }
      throw new Error(`Unsupported path in sample data: ${cleanPath}`);
    }

    async function pickFiles(kind) {
      if (!hasShellBridge()) return null;
      const res = await callShell("pickFiles", { kind });
      return Array.isArray(res?.files) ? res.files : [];
    }

    function getSampleLabel() {
      return fixtureState?.sampleLabel || (activeFixtureName ? "Sample data" : "");
    }

    return {
      init,
      setConnection,
      clearConnection,
      isConnected,
      loadFixture,
      request,
      pickFiles,
      getSampleLabel,
      getFixtureWorkspaceState: () => fixtureState?.workspaceState || null,
    };
  })();

  /* ============================================================================
     2. ONBOARDING & APPROVAL RULES IN-PAGE STATE (Section 1B - B4)
     ============================================================================ */
  const OnboardingState = {
    step: 1,
    totalSteps: 9,
    userName: "",
    callMe: "",
    pronounce: "",
    profileLoaded: false,
    profileSaveStatus: "",
    profileSaveError: "",
    agentName: "Mercury",
    swatchIndex: 0,
    voiceId: "2X7h8q4r8pMNZ7zRmpiF",
    voicePreviewStatus: "",
    a11y: {
      text_size: "default",
      reduce_motion:
        typeof window !== "undefined" &&
        typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      high_contrast:
        typeof window !== "undefined" &&
        typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-contrast: more)").matches,
      cursor_palette: "default",
      cursor_scale: 1.0,
    },
    permissions: {
      accessibility: false,
      screen_recording: false,
      app_scripting: false,
    },
    stageDisplay: "secondary",
    blockedApps: ["Banking", "Passwords", "Health"],
    customBlockedApp: "",
    memoryEnabled: true,
    memoryStatusNote: "",
    starterPrompts: [
      "Open Calculator and verify that 8 units at $31 equals 248",
      "Confirm Display Settings resolution is set to Default on Built-in Display",
      "Open Safari and check the local workspace summary",
    ],
    rules: [
      {
        id: "rule-money",
        kind: "money",
        when: "Spend money, place an order, or submit payment",
        should: "ask",
        locked: true,
        warning: "This spends money",
      },
      {
        id: "rule-signin",
        kind: "sign_in",
        when: "Change sign-in, passwords, tokens, or security settings",
        should: "ask",
        locked: true,
        warning: "This changes sign-in or security settings",
      },
      {
        id: "rule-delete",
        kind: "delete",
        when: "Delete files or run destructive actions",
        should: "ask",
        locked: true,
        warning: "This can't be undone",
      },
      {
        id: "rule-send",
        kind: "send",
        when: "Send messages, emails, or posts on your behalf",
        should: "ask",
        locked: false,
        warning: "",
      },
      {
        id: "rule-script",
        kind: "script",
        when: "Run app scripts or automation shortcuts",
        should: "ask",
        locked: false,
        warning: "",
      },
    ],
  };

  const PRIMARY_AGENT_STORAGE_KEY = "ca.primaryAgent";

  function getPrimaryAgentSwatch() {
    const idx = Math.max(0, Number(OnboardingState.swatchIndex) || 0) % AGENT_SWATCHES.length;
    return AGENT_SWATCHES[idx] || AGENT_SWATCHES[0];
  }

  function getPrimaryAgentDisplayName(fallback) {
    const trimmed = String(OnboardingState.agentName || "").trim();
    return trimmed || fallback || "ComputerAnything";
  }

  function loadPrimaryAgentChoice() {
    try {
      if (typeof localStorage === "undefined") return;
      const raw = localStorage.getItem(PRIMARY_AGENT_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        if (typeof parsed.alias === "string") {
          OnboardingState.agentName = parsed.alias;
        }
        if (typeof parsed.swatch === "string") {
          const foundIdx = AGENT_SWATCHES.findIndex((s) => s.key === parsed.swatch);
          if (foundIdx >= 0) {
            OnboardingState.swatchIndex = foundIdx;
          }
        }
      }
    } catch {
      // Ignore storage errors
    }
  }

  function savePrimaryAgentChoice() {
    try {
      if (typeof localStorage === "undefined") return;
      const sw = getPrimaryAgentSwatch();
      localStorage.setItem(
        PRIMARY_AGENT_STORAGE_KEY,
        JSON.stringify({
          alias: String(OnboardingState.agentName || "").trim(),
          swatch: sw.key,
        })
      );
    } catch {
      // Ignore storage errors
    }
  }

  loadPrimaryAgentChoice();

  function warningForApprovalKind(kind) {
    if (kind === "destructive") return { text: "This can't be undone", danger: true };
    if (kind === "sign_in") return { text: "This changes sign-in or security settings", danger: false };
    if (kind === "money") return { text: "This spends money", danger: false };
    return { text: "Requires your confirmation", danger: false };
  }

  function formatOptionButtonLabel(optionValue) {
    const clean = String(optionValue || "").trim().toLowerCase();
    if (clean === "approve") return "Approve";
    if (clean === "deny") return "Deny";
    if (clean === "done") return "Done";
    if (clean === "cancel") return "Cancel";
    return clean ? clean.charAt(0).toUpperCase() + clean.slice(1) : "Confirm";
  }

  /* ============================================================================
     3. SINGLE WORKSPACE ADAPTER (Maps /api/* -> ViewModel for B1, B1b, B2, B3, B4)
     ============================================================================ */
  const WorkspaceAdapter = (function () {
    function formatSeconds(sec) {
      const n = Math.max(0, Number(sec) || 0);
      if (n < 1) return "<1s";
      if (n < 10) return `${n.toFixed(1)}s`;
      const whole = Math.round(n);
      if (whole < 60) return `${whole}s`;
      const mins = Math.floor(whole / 60);
      const rem = whole % 60;
      return `${mins}m ${String(rem).padStart(2, "0")}s`;
    }

    function sentenceCase(text) {
      const s = String(text || "").trim();
      if (!s) return "";
      return s.charAt(0).toUpperCase() + s.slice(1);
    }

    function roleLabel(role) {
      if (role === "orchestrator") return "Primary agent";
      if (role === "cu") return "Computer use";
      if (role === "qa") return "QA agent";
      if (role === "dev") return "Dev agent";
      if (role === "marketing") return "Marketing agent";
      return "Agent";
    }

    /* Section 1B - B1 status word mapping:
       queued -> Queued
       planning / acting -> Running
       awaiting_human -> Waiting
       done -> Success (✓ only when result.ok is true)
       failed -> Failed */
    function mapBackendState(rawState, result, hasPendingHelp, hasVerifyPass) {
      if (hasPendingHelp || rawState === "awaiting_human") {
        return {
          filterKey: "waiting",
          word: "Waiting",
          symbol: "◔",
          symbolWord: "◔ Waiting",
          shortSymbolWord: "◔ Waiting",
          colorClass: "state-warning",
          isVerified: false,
        };
      }
      if (rawState === "queued") {
        return {
          filterKey: "running",
          word: "Queued",
          symbol: "○",
          symbolWord: "○ Queued",
          shortSymbolWord: "○ Queued",
          colorClass: "state-neutral",
          isVerified: false,
        };
      }
      if (rawState === "planning" || rawState === "acting") {
        return {
          filterKey: "running",
          word: "Running",
          symbol: "▶",
          symbolWord: "▶ Running",
          shortSymbolWord: "▶ Running",
          colorClass: "state-working",
          isVerified: false,
        };
      }
      if (rawState === "done" && result && result.ok === true) {
        const verified = Boolean(hasVerifyPass);
        return {
          filterKey: "success",
          word: "Success",
          symbol: "✓",
          symbolWord: verified ? "✓ Success · Verified" : "✓ Success",
          shortSymbolWord: "✓ Success",
          colorClass: "state-success",
          isVerified: verified,
        };
      }
      return {
        filterKey: "failed",
        word: "Failed",
        symbol: "×",
        symbolWord: "× Failed",
        shortSymbolWord: "× Failed",
        colorClass: "state-danger",
        isVerified: false,
      };
    }

    /**
     * Join /api/agents colors per Section 1B (B1) & Section 3:
     * - /api/agents is keyed by the child run id (overlay.claim(run.id, name)) with {name, color, edge, ink}.
     * - The orchestrator (parent) run has no cursor; draw it without glass, in the UI's muted text color.
     * - Entries vanish when a computer-use run ends and other roles never have one: keep a neutral fallback.
     */
    function lookupNodeGlassRecord(runItem, rawAgentsMap, isPrimary, recoveredInfo) {
      if (isPrimary) {
        const sw = getPrimaryAgentSwatch();
        return {
          name: getPrimaryAgentDisplayName(runItem?.agent_name || recoveredInfo?.name || "Primary orchestrator"),
          body: sw.body,
          edge: sw.edge,
          ink: sw.ink,
          rawInk: sw.rawInk,
          swatchKey: sw.key,
        };
      }
      const direct = rawAgentsMap && typeof rawAgentsMap === "object" ? rawAgentsMap[runItem.id] || null : null;
      if (direct && (direct.color || direct.body)) {
        const resolved = SharedGlass.resolveAgentPalette(direct);
        return {
          name: direct.name || recoveredInfo?.name || "",
          body: resolved.body,
          edge: resolved.edge,
          ink: resolved.ink,
          rawInk: resolved.rawInk,
        };
      }
      if (recoveredInfo && (recoveredInfo.color || recoveredInfo.body)) {
        const resolved = SharedGlass.resolveAgentPalette(recoveredInfo);
        return {
          name: recoveredInfo.name || "",
          body: resolved.body,
          edge: resolved.edge,
          ink: resolved.ink,
          rawInk: resolved.rawInk,
        };
      }
      return null;
    }

    function formatAgentStepEvent(ev) {
      if (!ev || typeof ev !== "object") return null;
      const tText = ev.t != null ? `${Number(ev.t).toFixed(1)}s` : "";
      switch (ev.kind) {
        case "decide":
          return {
            kind: "decide",
            label: "Decide",
            summary: ev.thought
              ? sentenceCase(ev.thought)
              : ev.action
                ? `Selected action ${ev.action}`
                : "Planned next step",
            timeText: tText,
          };
        case "act":
          return {
            kind: "act",
            label: "Act",
            summary: `${ev.action ? String(ev.action).replace(/:/g, " · ") : "Executed screen action"}${
              ev.source ? ` (${ev.source})` : ""
            }`,
            timeText: tText,
          };
        case "verify":
          return {
            kind: "verify",
            label: "Verify",
            summary: ev.achieved
              ? `✓ Verified: ${ev.evidence || "Goal confirmed on screen"}`
              : `Not verified yet: ${ev.evidence || "Check did not pass"}`,
            timeText: tText,
          };
        case "help":
          return {
            kind: "help",
            label: "Help",
            summary: `Asked approval (${ev.help_kind || "confirm"}): ${ev.question || "Needs confirmation"}`,
            timeText: tText,
          };
        case "help_answer":
          return {
            kind: "help",
            label: "Answer",
            summary: `User answered: ${sentenceCase(ev.answer || "")}${ev.timed_out ? " (expired after 5m)" : ""}`,
            timeText: tText,
          };
        case "result":
          return {
            kind: "result",
            label: "Result",
            summary: `${ev.ok ? "✓ Verified" : "× Failed"} · ${sentenceCase(ev.summary || "")}`,
            timeText: tText,
          };
        case "route":
          return {
            kind: "decide",
            label: "Route",
            summary: `Dispatched ${ev.agent || roleLabel(ev.role)}${ev.app ? ` on ${ev.app}` : ""}: ${ev.goal || ""}`,
            timeText: tText,
          };
        case "bug_report": {
          const bugs = Array.isArray(ev.bugs) ? ev.bugs : [];
          return {
            kind: "bug_report",
            label: "Bug report",
            summary: bugs.length
              ? `Round ${ev.round || 1}: ${bugs.length} issue${bugs.length === 1 ? "" : "s"} (${bugs[0].title || "bug"})`
              : `Round ${ev.round || 1}: no bugs found`,
            timeText: tText,
          };
        }
        case "patch":
          return {
            kind: "patch",
            label: "Patch",
            summary: ev.applied
              ? `Round ${ev.round || 1}: applied${ev.explanation ? ` · ${ev.explanation}` : ""}`
              : `Round ${ev.round || 1}: not applied${ev.error ? ` (${ev.error})` : ""}`,
            timeText: tText,
          };
        case "commit":
          return {
            kind: "commit",
            label: "Commit",
            summary: ev.ok !== false
              ? `Committed ${(Array.isArray(ev.files) ? ev.files.length : 0)} file${(Array.isArray(ev.files) && ev.files.length === 1) ? "" : "s"}`
              : `Commit failed${ev.out ? `: ${ev.out}` : ""}`,
            timeText: tText,
          };
        case "tour":
          return {
            kind: "act",
            label: "Tour",
            summary: `Step ${ev.step || 1}: ${ev.summary || (ev.ok ? "Captured screen" : "Tour step")}`,
            timeText: tText,
          };
        case "artifact": {
          const name = ev.path ? String(ev.path).split("/").pop() : "artifact";
          return {
            kind: "artifact",
            label: sentenceCase(ev.type || "Artifact"),
            summary: ev.tagline ? `${name} · ${ev.tagline}` : name,
            timeText: tText,
          };
        }
        case "llm": {
          const costStr = ev.cost == null ? "—" : `$${Number(ev.cost).toFixed(4)}`;
          return {
            kind: "decide",
            label: "Model",
            summary: `${ev.purpose ? `${sentenceCase(ev.purpose)} · ` : ""}${ev.model || "Model"} · Cost ${costStr}`,
            timeText: tText,
          };
        }
        case "tests":
          return {
            kind: "act",
            label: "Tests",
            summary:
              ev.exit === 0
                ? `Tests passed (round ${ev.round || 1})${ev.tail ? ` · ${ev.tail}` : ""}`
                : `Tests failed (round ${ev.round || 1})${ev.tail ? ` · ${ev.tail}` : ""}`,
            timeText: tText,
          };
        case "patch":
          return {
            kind: "act",
            label: "Patch",
            summary:
              ev.applied === false
                ? `Patch not applied (${ev.error || "declined"})`
                : `Applied patch: ${ev.explanation || "Updated source"}`,
            timeText: tText,
          };
        case "app_ready":
          return {
            kind: "act",
            label: "App",
            summary: `Focused ${ev.app || "application"} (${ev.seconds || 0}s)`,
            timeText: tText,
          };
        case "error":
          return {
            kind: "result",
            label: "Error",
            summary: sentenceCase(ev.error || ev.msg || "Runtime error"),
            timeText: tText,
          };
        default:
          return null;
      }
    }

    function buildStateMachine(rawActions, agentPaletteByName, selectedAgentFilter, selectedAppFilter) {
      const rows = Array.isArray(rawActions) ? rawActions : [];
      const filteredRows = rows.filter((r) => {
        if (selectedAgentFilter) {
          const matchAgent =
            r.agent === selectedAgentFilter ||
            r.run === selectedAgentFilter;
          if (!matchAgent) return false;
        }
        if (selectedAppFilter && selectedAppFilter !== "all") {
          if ((r.app || "App") !== selectedAppFilter) return false;
        }
        return true;
      });

      const screensMap = new Map();
      const edgesMap = new Map();
      const appsSet = new Set();
      const agentsSet = new Set();

      for (const r of rows) {
        if (r.app) appsSet.add(r.app);
        if (r.agent) agentsSet.add(r.agent);
      }

      function ensureScreen(id, appName) {
        const key = id || `${appName || "App"}:screen`;
        if (!screensMap.has(key)) {
          const fallbackTitle = String(key).includes(":") ? String(key).split(":").slice(1).join(":") : String(key);
          screensMap.set(key, {
            id: key,
            app: appName || "App",
            title: sentenceCase(fallbackTitle.replace(/[-_]/g, " ")) || String(key),
            visits: 0,
            agents: new Set(),
          });
        }
        const node = screensMap.get(key);
        node.visits += 1;
        return node;
      }

      for (const row of filteredRows) {
        const app = row.app || "Desktop";
        const fromId = row.from || `${app}:start`;
        const actionVerb = String(row.action || "act").split(":")[0] || "next";
        const toId = row.to || `${app}:${actionVerb}`;
        const fromNode = ensureScreen(fromId, app);
        const toNode = ensureScreen(toId, app);
        if (row.agent) {
          fromNode.agents.add(row.agent);
          toNode.agents.add(row.agent);
        }

        const edgeKey = `${fromId}__${row.action || "act"}__${toId}`;
        if (!edgesMap.has(edgeKey)) {
          edgesMap.set(edgeKey, {
            id: edgeKey,
            app,
            from: fromId,
            fromTitle: fromNode.title,
            to: toId,
            toTitle: toNode.title,
            action: row.action || "action",
            tries: 0,
            successes: 0,
            failures: 0,
            denied: 0,
            waiting: 0,
            latencies: [],
            sources: new Set(),
            agents: [],
            runs: [],
            lastOutcome: row.outcome || "ok",
          });
        }
        const edge = edgesMap.get(edgeKey);
        const out = row.outcome;
        if (out === "ok" || out === true || out === "done_verified") {
          edge.tries += 1;
          edge.successes += 1;
          edge.lastOutcome = "ok";
        } else if (out === "failed" || out === false || out === "done_rejected") {
          edge.tries += 1;
          edge.failures += 1;
          edge.lastOutcome = "failed";
        } else if (out === "denied") {
          edge.denied += 1;
          edge.lastOutcome = "denied";
        } else if (out === "help") {
          edge.waiting += 1;
          edge.lastOutcome = "help";
        }
        if (row.ms) edge.latencies.push(Number(row.ms));
        if (row.source) edge.sources.add(row.source);
        if (row.agent && !edge.agents.includes(row.agent)) {
          edge.agents.push(row.agent);
        }
        if (row.run && !edge.runs.includes(row.run)) {
          edge.runs.push(row.run);
        }
      }

      const edges = Array.from(edgesMap.values()).map((e) => {
        let statusSymbolWord = "✓ Success";
        let statusClass = "state-success";
        let strokeColor = "#32d583";
        if (e.failures > 0 && e.successes === 0) {
          statusSymbolWord = "× Failed";
          statusClass = "state-danger";
          strokeColor = "#ff5c6c";
        } else if (e.denied > 0 && e.successes === 0) {
          statusSymbolWord = "⊘ Denied";
          statusClass = "state-danger";
          strokeColor = "#ff5c6c";
        } else if (e.waiting > 0 && e.successes === 0) {
          statusSymbolWord = "◔ Waiting";
          statusClass = "state-warning";
          strokeColor = "#f5a623";
        }

        const primaryAgent = e.agents[0] || "";
        const primaryRun = e.runs[0] || "";
        const agentPalette =
          agentPaletteByName.get(primaryRun) ||
          agentPaletteByName.get(primaryAgent) ||
          null;
        const trailColor = agentPalette?.body || "#767d8e";
        const meanMs = e.latencies.length
          ? Math.round(e.latencies.reduce((a, b) => a + b, 0) / e.latencies.length)
          : 0;
        const reliabilityPNum = e.tries > 0 ? (1 + e.successes) / (2 + e.tries) : null;
        const reliabilityP = reliabilityPNum != null ? reliabilityPNum.toFixed(2) : null;
        const isDestructive = /\b(send|pay|buy|purchase|order|checkout|delete|remove|erase|post|publish|transfer|confirm|submit|unsubscribe|sign out|log out|reset|empty trash|wire|withdraw)\b/i.test(
          e.action || ""
        );
        const reliabilityColor = isDestructive
          ? "#ff5c6c"
          : reliabilityPNum == null
            ? "#767d8e"
            : reliabilityPNum >= 0.7
              ? "#32d583"
              : reliabilityPNum >= 0.45
                ? "#f5a623"
                : "#ff5c6c";
        const strokeWidth = Number(Math.min(7, Math.max(1.8, 1.4 + Math.sqrt(e.tries || 1) * 1.3)).toFixed(1));

        return {
          ...e,
          statusSymbolWord,
          statusClass,
          trailColor,
          reliabilityColor,
          strokeWidth,
          isDestructive,
          meanMs,
          reliabilityP,
          actionClean: String(e.action || "").replace(/:/g, " · "),
          sourceLabel: Array.from(e.sources).join(", ") || "model",
        };
      });

      return {
        screens: Array.from(screensMap.values()),
        edges,
        allApps: Array.from(appsSet).sort(),
        allAgents: Array.from(agentsSet),
        totalFilteredActions: filteredRows.length,
      };
    }

    function buildViewModel(state) {
      const {
        rawRuns,
        detailsById,
        pendingHelp,
        rawAgents,
        rawActions,
        rawGraph,
        rawAnalytics,
        costsById,
        transcriptsByRunId,
        searchedTranscriptRows,
        sentAttachmentsByRunId,
        connectionStatus,
        connectionError,
        isSampleData,
        selectedTaskRunId,
        selectedAgentId,
        selectedAppFilter,
        logSearchQuery,
        logStatusFilter,
      } = state;

      const runsList = Array.isArray(rawRuns) ? rawRuns : [];
      const helpList = Array.isArray(pendingHelp) ? pendingHelp : [];
      const byId = new Map(runsList.map((r) => [r.id, r]));

      const parents = runsList.filter((r) => !r.parent || !byId.has(r.parent));
      const childrenByParent = new Map();
      for (const r of runsList) {
        if (r.parent && byId.has(r.parent)) {
          if (!childrenByParent.has(r.parent)) childrenByParent.set(r.parent, []);
          childrenByParent.get(r.parent).push(r);
        }
      }

      /* Map child run IDs and agent names to backend /api/agents glass palettes */
      const agentPaletteByName = new Map();
      if (rawAgents && typeof rawAgents === "object") {
        for (const [aid, info] of Object.entries(rawAgents)) {
          if (info && (info.color || info.body)) {
            const resolved = SharedGlass.resolveAgentPalette(info);
            agentPaletteByName.set(aid, resolved);
            if (info.name) agentPaletteByName.set(info.name, resolved);
          }
        }
      }

      const nowSec = Date.now() / 1000;
      const mappedApprovals = helpList.map((h) => {
        const elapsedSinceAsked = h.asked ? nowSec - Number(h.asked) : 0;
        const isExpired = Boolean(h.timed_out || (h.asked && elapsedSinceAsked > 300 && h.asked < 2000000000));
        const warn = warningForApprovalKind(h.kind);
        const options = Array.isArray(h.options) && h.options.length ? h.options : ["approve", "deny"];
        return {
          id: h.id,
          runId: h.run,
          kind: h.kind || "confirm",
          question: h.question || "Approval required",
          detail: h.detail ? String(h.detail) : "",
          options,
          warningText: warn.text,
          isDangerWarning: warn.danger,
          isExpired,
        };
      });

      const taskGroups = parents.map((parent) => {
        /* Up to 4 child computer-use / specialist agents per prompt (Section 1B - B1) */
        const rawChildren = [...(childrenByParent.get(parent.id) || [])].slice(0, 4);
        const allGroupRuns = [parent, ...rawChildren];

        const parentTranscriptRows = transcriptsByRunId[parent.id] || [];
        const parentEvents = Array.isArray(detailsById[parent.id]?.events) ? detailsById[parent.id].events : [];
        const recoveredByRunId = new Map();
        const recoveredByAgentName = new Map();

        const recordRecovered = (keyRunId, agentName, colorVal) => {
          if (!agentName && !colorVal) return;
          if (keyRunId) {
            const prev = recoveredByRunId.get(keyRunId) || {};
            recoveredByRunId.set(keyRunId, {
              name: prev.name || agentName || "",
              color: prev.color || colorVal || null,
            });
          }
          if (agentName) {
            const prev = recoveredByAgentName.get(agentName) || {};
            recoveredByAgentName.set(agentName, {
              name: agentName,
              color: prev.color || colorVal || null,
            });
          }
        };

        for (const ev of parentEvents) {
          if (ev && (ev.agent || ev.color)) {
            recordRecovered(ev.child || ev.run || null, ev.agent || "", ev.color || null);
          }
        }
        for (const tr of parentTranscriptRows) {
          if (tr && (tr.agent || tr.color)) {
            recordRecovered(tr.run || null, tr.agent || "", tr.color || null);
          }
        }

        const nodes = allGroupRuns.map((runItem, idx) => {
          const isPrimary = idx === 0;
          const detail = detailsById[runItem.id] || runItem;
          const events = Array.isArray(detail?.events) ? detail.events : [];
          for (const ev of events) {
            if (ev && (ev.agent || ev.color)) {
              recordRecovered(runItem.id, ev.agent || "", ev.color || null);
            }
          }
          const runHelp = mappedApprovals.filter((h) => h.runId === runItem.id && !h.isExpired);
          const hasVerifyPass = events.some((e) => e.kind === "verify" && e.achieved);

          const status = mapBackendState(
            runItem.state,
            runItem.result || detail?.result,
            runHelp.length > 0,
            hasVerifyPass
          );

          let recoveredInfo = recoveredByRunId.get(runItem.id) || null;
          if (!recoveredInfo?.color && recoveredInfo?.name && recoveredByAgentName.has(recoveredInfo.name)) {
            recoveredInfo = recoveredByAgentName.get(recoveredInfo.name);
          }
          if (!recoveredInfo && !isPrimary && rawChildren.length === 1) {
            const firstNamed = Array.from(recoveredByAgentName.values())[0] || null;
            if (firstNamed) recoveredInfo = firstNamed;
          }

          const glassRecord = lookupNodeGlassRecord(runItem, rawAgents, isPrimary, recoveredInfo);
          const displayName = isPrimary
            ? getPrimaryAgentDisplayName(runItem.agent_name || recoveredInfo?.name || "Primary orchestrator")
            : glassRecord?.name || recoveredInfo?.name || roleLabel(runItem.role);

          if (glassRecord) {
            agentPaletteByName.set(runItem.id, glassRecord);
            agentPaletteByName.set(displayName, glassRecord);
          }

          const steps = events.map(formatAgentStepEvent).filter(Boolean);
          if (!steps.length && (runItem.result?.summary || detail?.result?.summary)) {
            steps.push({
              kind: "result",
              label: "Result",
              summary: sentenceCase((runItem.result || detail.result).summary),
              timeText: formatSeconds(runItem.elapsed),
            });
          }

          return {
            runId: runItem.id,
            parentRunId: runItem.parent || null,
            isPrimary,
            hasGlass: Boolean(glassRecord),
            agentId: runItem.id,
            agentName: displayName,
            role: runItem.role || "cu",
            roleText: roleLabel(runItem.role),
            goal: runItem.goal || parent.goal || "Task",
            elapsedText: formatSeconds(runItem.elapsed),
            status,
            palette: glassRecord,
            seed: stableSeed(runItem.id + ":" + displayName),
            steps,
            rawEvents: events,
            resultSummary: (runItem.result || detail?.result)?.summary
              ? sentenceCase((runItem.result || detail.result).summary)
              : steps[steps.length - 1]?.summary || status.word,
          };
        });

        const primaryNode = nodes[0];
        const childNodes = nodes.slice(1);
        const groupHasWaiting = nodes.some((n) => n.status.filterKey === "waiting");
        const groupHasRunning = nodes.some((n) => n.status.filterKey === "running");
        const groupHasFailed = nodes.some((n) => n.status.filterKey === "failed");
        const groupHasVerified = nodes.some((n) => n.status.isVerified);

        let overallStatus = primaryNode.status;
        if (groupHasWaiting) {
          overallStatus = mapBackendState("awaiting_human", null, true, false);
        } else if (groupHasRunning && primaryNode.status.filterKey !== "failed") {
          overallStatus = mapBackendState(
            primaryNode.status.word === "Queued" ? "queued" : "acting",
            null,
            false,
            false
          );
        } else if (groupHasFailed && primaryNode.status.filterKey !== "running") {
          overallStatus = mapBackendState("failed", { ok: false }, false, false);
        } else if (primaryNode.status.filterKey === "success") {
          overallStatus = mapBackendState("done", parent.result || { ok: true }, false, groupHasVerified);
        }

        const uiSentFiles = sentAttachmentsByRunId.get(parent.id) || [];
        const backendAttachments = Array.isArray(parent.files)
          ? parent.files
          : Array.isArray(detailsById[parent.id]?.files)
            ? detailsById[parent.id].files
            : [];
        const attachments = Array.from(new Set([...uiSentFiles, ...backendAttachments]));

        const transcriptRows = transcriptsByRunId[parent.id] || [];
        const combinedEvents = [];
        if (transcriptRows.length) {
          for (const tr of transcriptRows) {
            const rawAgent = tr.agent || tr.role || "Agent";
            const isOrchestratorRow = rawAgent === "ComputerAnything" || tr.role === "orchestrator";
            combinedEvents.push({
              agentName: isOrchestratorRow ? getPrimaryAgentDisplayName(rawAgent) : rawAgent,
              agentPalette: isOrchestratorRow ? getPrimaryAgentSwatch() : null,
              label: sentenceCase(tr.kind || tr.role || "Message"),
              summary: tr.text || "",
              timeText: tr.ts ? new Date(tr.ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "",
            });
          }
        } else {
          for (const n of nodes) {
            for (const st of n.steps) {
              combinedEvents.push({
                agentName: n.agentName,
                ...st,
              });
            }
          }
        }

        const parentDigest = parent.result?.digest || detailsById[parent.id]?.result?.digest || null;
        const digestParts = [];
        if (parentDigest && typeof parentDigest === "object") {
          if (parentDigest.steps != null) digestParts.push(`${parentDigest.steps} steps`);
          if (parentDigest.memory_steps != null && parentDigest.memory_steps > 0) {
            digestParts.push(`${parentDigest.memory_steps} from memory`);
          }
          if (parentDigest.seconds != null) digestParts.push(`${parentDigest.seconds}s`);
        }

        return {
          id: parent.id,
          goal: parent.goal || "Untitled task",
          elapsedText: formatSeconds(parent.elapsed),
          attachments,
          overallStatus,
          digest: parentDigest,
          digestSummaryText: digestParts.join(" · "),
          resultSummary: parent.result?.summary
            ? sentenceCase(parent.result.summary)
            : parentDigest?.summary
              ? sentenceCase(parentDigest.summary)
              : childNodes.find((c) => c.resultSummary)?.resultSummary || overallStatus.word,
          primaryNode,
          childNodes,
          allNodes: nodes,
          combinedEvents,
          cost: costsById[parent.id] || null,
        };
      });

      const activeGroup =
        taskGroups.find((g) => g.id === selectedTaskRunId) || taskGroups[0] || null;

      let activeAgentNode = null;
      if (activeGroup) {
        activeAgentNode =
          activeGroup.allNodes.find(
            (n) => n.runId === selectedAgentId || n.agentName === selectedAgentId || n.agentId === selectedAgentId
          ) || activeGroup.primaryNode;
      }

      /* Filter B2 Transcript Log using /api/transcripts?q= search results (with client fallback if 404) & status chips */
      const qLower = String(logSearchQuery || "").trim().toLowerCase();
      const matchedRunIdsFromEndpoint =
        qLower && Array.isArray(searchedTranscriptRows)
          ? new Set(searchedTranscriptRows.map((row) => row.run).filter(Boolean))
          : null;

      const filteredTranscriptRuns = taskGroups.filter((g) => {
        if (logStatusFilter && logStatusFilter !== "all") {
          if (g.overallStatus.filterKey !== logStatusFilter) return false;
        }
        if (!qLower) return true;
        if (matchedRunIdsFromEndpoint && matchedRunIdsFromEndpoint.has(g.id)) {
          return true;
        }
        const haystacks = [
          g.goal,
          g.resultSummary,
          ...g.attachments,
          ...g.allNodes.map((n) => n.agentName),
          ...g.combinedEvents.map((e) => `${e.label} ${e.summary}`),
        ];
        return haystacks.some((h) => String(h || "").toLowerCase().includes(qLower));
      });

      /* Build B1b State Machine Graph */
      const stateMachine = buildStateMachine(
        rawActions,
        agentPaletteByName,
        state.smAgentFilter || "",
        selectedAppFilter || "all"
      );

      /* Build Agent Replay runs (Issue #1 #5: step through act events and see which screen node each hit) */
      const actionsByRun = new Map();
      for (const row of Array.isArray(rawActions) ? rawActions : []) {
        if (!row.run) continue;
        if (!actionsByRun.has(row.run)) actionsByRun.set(row.run, []);
        actionsByRun.get(row.run).push(row);
      }

      const replayRuns = runsList
        .map((r) => {
          const detail = detailsById[r.id];
          const evs = Array.isArray(detail?.events) ? detail.events : [];
          const actEvents = evs.filter((ev) => ev.kind === "act");
          const runActions = actionsByRun.get(r.id) || [];
          const agentName =
            rawAgents?.[r.id]?.name ||
            r.role ||
            "Agent";

          let steps = [];
          if (actEvents.length) {
            steps = actEvents.map((ev, idx) => {
              const matchedAction =
                runActions.find((a) => ev.action && a.action === ev.action) ||
                runActions[idx] ||
                null;
              const fromId = matchedAction?.from || "";
              const toId = matchedAction?.to || "";
              const fromScreen = stateMachine.screens.find((s) => s.id === fromId);
              const toScreen = stateMachine.screens.find((s) => s.id === toId);
              return {
                index: idx,
                t: ev.t,
                action: ev.action || matchedAction?.action || "act",
                ok: ev.ok !== false,
                outcome: matchedAction?.outcome || (ev.ok === false ? "failed" : "ok"),
                app: matchedAction?.app || (fromId ? fromId.split(":")[0] : "Desktop"),
                fromId,
                toId,
                fromTitle: fromScreen?.title || (fromId ? fromId.split(":").slice(1).join(":") : "Active screen"),
                toTitle: toScreen?.title || (toId ? toId.split(":").slice(1).join(":") : "Next screen"),
                ms: matchedAction?.ms || 0,
              };
            });
          } else if (runActions.length) {
            steps = runActions.map((a, idx) => {
              const fromScreen = stateMachine.screens.find((s) => s.id === a.from);
              const toScreen = stateMachine.screens.find((s) => s.id === a.to);
              return {
                index: idx,
                t: null,
                action: a.action || "act",
                ok: a.outcome === "ok" || a.outcome === "done_verified",
                outcome: a.outcome || "ok",
                app: a.app || "Desktop",
                fromId: a.from || "",
                toId: a.to || "",
                fromTitle: fromScreen?.title || (a.from ? a.from.split(":").slice(1).join(":") : "Active screen"),
                toTitle: toScreen?.title || (a.to ? a.to.split(":").slice(1).join(":") : "Next screen"),
                ms: a.ms || 0,
              };
            });
          }

          return {
            id: r.id,
            goal: r.goal || "Untitled run",
            agentName,
            role: r.role || "agent",
            steps,
          };
        })
        .filter((rr) => rr.steps.length > 0);

      function basenameOf(p) {
        const clean = String(p || "").trim();
        if (!clean) return "";
        const parts = clean.split(/[\\/]/);
        return parts[parts.length - 1] || clean;
      }

      function isWebRenderableSrc(src) {
        const s = String(src || "").trim();
        if (!s) return false;
        if (/^(data:image\/|https?:\/\/)/i.test(s)) return true;
        if (/^\.?\/(?:ui\/|fixtures\/|assets\/)/i.test(s)) return true;
        return false;
      }

      const artifacts = [];
      const seenBriefKeys = new Set();

      for (const g of taskGroups) {
        for (const n of g.allNodes) {
          const evs = Array.isArray(n.rawEvents) ? n.rawEvents : [];
          evs.forEach((ev, idx) => {
            if (!ev || typeof ev !== "object") return;
            const tText = ev.t != null ? `+${Number(ev.t).toFixed(1)}s` : n.elapsedText;
            const sortTs = ev.ts || ev.t || 0;
            if (ev.kind === "bug_report") {
              const bugs = Array.isArray(ev.bugs) ? ev.bugs : [];
              artifacts.push({
                id: `${n.runId}-bug-${idx}`,
                kind: "bug_report",
                kindLabel: bugs.length
                  ? `Bug report · Round ${ev.round || 1} (${bugs.length})`
                  : `Bug report · Round ${ev.round || 1}`,
                statusObj: bugs.length
                  ? { symbolWord: "◔ Bugs found", colorClass: "state-warning" }
                  : { symbolWord: "✓ Clean", colorClass: "state-success" },
                agentName: n.agentName,
                agentPalette: n.palette,
                taskId: g.id,
                taskGoal: g.goal,
                timeText: tText,
                sortTs,
                summary: bugs.length ? bugs.map((b) => b.title || "Bug").join("; ") : "No bugs found",
                detail: { bugs, round: ev.round || 1 },
              });
            } else if (ev.kind === "patch") {
              const applied = Boolean(ev.applied);
              const filesList = Array.isArray(ev.files) ? ev.files : [];
              artifacts.push({
                id: `${n.runId}-patch-${idx}`,
                kind: "patch",
                kindLabel: `Patch · Round ${ev.round || 1}`,
                statusObj: applied
                  ? { symbolWord: "✓ Applied", colorClass: "state-success" }
                  : { symbolWord: "✕ Not applied", colorClass: "state-danger" },
                agentName: n.agentName,
                agentPalette: n.palette,
                taskId: g.id,
                taskGoal: g.goal,
                timeText: tText,
                sortTs,
                summary: applied
                  ? (ev.explanation || (filesList.length ? filesList.join(", ") : "Patch applied"))
                  : (ev.error ? `Not applied: ${ev.error}` : "Patch was not applied"),
                detail: {
                  applied,
                  round: ev.round || 1,
                  attempt: ev.attempt || 1,
                  files: filesList,
                  explanation: ev.explanation || "",
                  diff: ev.diff || "",
                  error: ev.error || "",
                },
              });
            } else if (ev.kind === "commit") {
              const ok = ev.ok !== false;
              const filesList = Array.isArray(ev.files) ? ev.files : [];
              artifacts.push({
                id: `${n.runId}-commit-${idx}`,
                kind: "commit",
                kindLabel: "Commit",
                statusObj: ok
                  ? { symbolWord: "✓ Committed", colorClass: "state-success" }
                  : { symbolWord: "✕ Failed", colorClass: "state-danger" },
                agentName: n.agentName,
                agentPalette: n.palette,
                taskId: g.id,
                taskGoal: g.goal,
                timeText: tText,
                sortTs,
                summary: filesList.length ? filesList.join(", ") : (ev.out || "Git commit"),
                detail: { ok, files: filesList, out: ev.out || "" },
              });
            } else if (ev.kind === "artifact") {
              const artType = String(ev.type || "artifact").toLowerCase();
              const fileName = basenameOf(ev.path || ev.url || "");
              if (artType === "brief") {
                seenBriefKeys.add(`${n.runId}:${ev.path || ""}`);
              }
              const kindLabel =
                artType === "brief"
                  ? "Marketing brief"
                  : artType === "screenshot"
                    ? "Screenshot"
                    : sentenceCase(artType);
              artifacts.push({
                id: `${n.runId}-art-${idx}`,
                kind: "artifact",
                artifactType: artType,
                kindLabel,
                statusObj: { symbolWord: "✓ Saved", colorClass: "state-success" },
                agentName: n.agentName,
                agentPalette: n.palette,
                taskId: g.id,
                taskGoal: g.goal,
                timeText: tText,
                sortTs,
                summary: ev.tagline ? `${fileName ? `${fileName} · ` : ""}${ev.tagline}` : (fileName || "Saved artifact"),
                detail: {
                  type: artType,
                  fileName,
                  path: ev.path || "",
                  url: ev.url || "",
                  tagline: ev.tagline || "",
                  brief: ev.brief && typeof ev.brief === "object" ? ev.brief : null,
                },
              });
            }
          });

          const nodeDetail = detailsById[n.runId] || runsList.find((r) => r.id === n.runId) || null;
          const resBrief = nodeDetail?.result?.brief;
          if (resBrief) {
            const pathStr = typeof resBrief === "string" ? resBrief : (resBrief.path || "");
            const dedupKey = `${n.runId}:${pathStr}`;
            if (!seenBriefKeys.has(dedupKey)) {
              seenBriefKeys.add(dedupKey);
              const fileName = basenameOf(pathStr);
              artifacts.push({
                id: `${n.runId}-res-brief`,
                kind: "artifact",
                artifactType: "brief",
                kindLabel: "Marketing brief",
                statusObj: n.status,
                agentName: n.agentName,
                agentPalette: n.palette,
                taskId: g.id,
                taskGoal: g.goal,
                timeText: n.elapsedText,
                sortTs: 0,
                summary: (typeof resBrief === "object" && resBrief.tagline)
                  ? resBrief.tagline
                  : (fileName || n.resultSummary || "Launch brief"),
                detail: {
                  type: "brief",
                  fileName,
                  path: pathStr,
                  tagline: typeof resBrief === "object" ? (resBrief.tagline || "") : "",
                  brief: typeof resBrief === "object" ? resBrief : null,
                },
              });
            }
          }
        }
      }

      const marketingRuns = [];
      for (const g of taskGroups) {
        const mktNode = g.allNodes.find((n) => n.role === "marketing");
        if (!mktNode && g.primaryNode.role !== "marketing") continue;
        const targetNode = mktNode || g.primaryNode;
        const evs = Array.isArray(targetNode.rawEvents) ? targetNode.rawEvents : [];
        const nodeDetail = detailsById[targetNode.runId] || runsList.find((r) => r.id === targetNode.runId) || null;
        const parentDetail = detailsById[g.id] || runsList.find((r) => r.id === g.id) || null;

        const briefEv = evs.find((e) => e.kind === "artifact" && String(e.type || "").toLowerCase() === "brief") || null;
        const rawBrief = nodeDetail?.result?.brief || parentDetail?.result?.brief || null;
        const briefObj =
          rawBrief && typeof rawBrief === "object"
            ? rawBrief
            : briefEv?.brief && typeof briefEv.brief === "object"
              ? briefEv.brief
              : briefEv && (briefEv.launch_script || briefEv.shot_list || briefEv.palette)
                ? briefEv
                : null;
        const briefPath =
          typeof rawBrief === "string"
            ? rawBrief
            : typeof briefEv?.path === "string"
              ? briefEv.path
              : "";
        const briefFileName = basenameOf(briefPath);
        const tagline = briefObj?.tagline || briefEv?.tagline || "";
        const launchScript = briefObj?.launch_script || "";
        const shotList = Array.isArray(briefObj?.shot_list) ? briefObj.shot_list : [];
        const palette = Array.isArray(briefObj?.palette) ? briefObj.palette : [];

        const shotEntries = [];
        const seenShot = new Set();
        const addShot = (item) => {
          const src = typeof item === "string" ? item : (item?.url || item?.path || "");
          const label = typeof item === "object" && item?.label ? item.label : basenameOf(src);
          const key = src || label;
          if (!key || seenShot.has(key)) return;
          seenShot.add(key);
          shotEntries.push({
            src,
            fileName: basenameOf(src) || label,
            isRenderable: isWebRenderableSrc(src),
          });
        };
        if (Array.isArray(briefObj?.screenshots)) {
          briefObj.screenshots.forEach(addShot);
        }
        evs
          .filter((e) => e.kind === "artifact" && String(e.type || "").toLowerCase() === "screenshot")
          .forEach((e) => addShot(e));

        const tourSteps = evs
          .filter((e) => e.kind === "tour")
          .map((e) => ({
            step: e.step || 1,
            ok: e.ok !== false,
            summary: e.summary || "",
          }));

        const storedOnMacOnly = !launchScript && !shotList.length && !palette.length && Boolean(briefPath);

        marketingRuns.push({
          runId: g.id,
          agentRunId: targetNode.runId,
          goal: g.goal,
          agentName: targetNode.agentName,
          agentPalette: targetNode.palette,
          status: g.overallStatus,
          elapsedText: g.elapsedText,
          summary: targetNode.resultSummary || g.resultSummary,
          briefFileName,
          briefPath,
          tagline,
          launchScript,
          shotList,
          palette,
          screenshots: shotEntries,
          tourSteps,
          storedOnMacOnly,
        });
      }

      return {
        connectionStatus,
        connectionError,
        isSampleData,
        sampleLabel: Transport.getSampleLabel(),
        approvals: mappedApprovals,
        taskGroups,
        activeGroup,
        activeAgentNode,
        filteredTranscriptRuns,
        searchedTranscriptRows: Array.isArray(searchedTranscriptRows) ? searchedTranscriptRows : null,
        artifacts,
        marketingRuns,
        stateMachine,
        rawActions: Array.isArray(rawActions) ? rawActions : [],
        replayRuns,
        graphStats: rawGraph || {
          screens: stateMachine.screens.length,
          transitions: stateMachine.edges.length,
          skills: 0,
          apps: stateMachine.allApps,
          mean_edge_p: null,
          destructive_edges: 0,
          actions_logged: Array.isArray(rawActions) ? rawActions.length : 0,
          agents: stateMachine.allAgents,
        },
        analytics: rawAnalytics,
        costsById,
      };
    }

    return {
      buildViewModel,
      formatSeconds,
    };
  })();

  /* ============================================================================
     4. WORKSPACE STATE & DOM REFERENCES
     ============================================================================ */
  let currentView = normalizeViewName(params.get("view") || window.location.hash.replace(/^#/, "") || "graph");
  let connectionStatus = "loading";
  let connectionError = "";
  let isSampleData = Boolean(activeFixtureName);
  let hasLoadedOnce = false;
  let lastSuccessfulRefreshAt = 0;
  let failedEndpoints = [];
  let succeededEndpoints = [];

  let rawRuns = [];
  let detailsById = {};
  let pendingHelp = [];
  let rawAgents = {};
  let rawActions = [];
  let rawGraph = null;
  let rawAnalytics = null;
  let costsById = {};
  let transcriptsByRunId = {};
  let searchedTranscriptRows = null;
  const sentAttachmentsByRunId = new Map();
  try {
    const savedAtt = window.sessionStorage?.getItem("ca_ws_sent_attachments_v1");
    if (savedAtt) {
      const parsedAtt = JSON.parse(savedAtt);
      if (parsedAtt && typeof parsedAtt === "object") {
        for (const [rid, names] of Object.entries(parsedAtt)) {
          if (Array.isArray(names)) sentAttachmentsByRunId.set(rid, names);
        }
      }
    }
  } catch {
    // Ignore sessionStorage errors
  }

  function persistSentAttachments() {
    try {
      const obj = {};
      for (const [rid, names] of sentAttachmentsByRunId.entries()) {
        obj[rid] = names;
      }
      window.sessionStorage?.setItem("ca_ws_sent_attachments_v1", JSON.stringify(obj));
    } catch {
      // Ignore sessionStorage errors
    }
  }

  let selectedTaskRunId = null;
  let selectedAgentNodeId = null;
  let smAgentFilter = "";
  let selectedAppFilter = "all";
  let selectedSmEdgeId = null;
  let replayRunId = null;
  let replayStepIndex = 0;
  let logSearchQuery = "";
  let logStatusFilter = "all";
  let searchDebounceTimer = null;
  const expandedTranscriptRunIds = new Set();
  const expandedArtifactIds = new Set();
  let selectedMarketingRunId = null;

  let attachments = [];
  let sendErrorText = "";

  const HistorySettingsState = {
    searchQuery: "",
    outcomeFilter: "all",
    costFilter: "all",
    confirmForgetId: null,
    editingMemoryId: null,
    editingMemoryDraft: "",
    memoryLive: false,
    liveMemories: [],
    memoryError: "",
    memories: [
      {
        id: "mem-1",
        key: "Preferred name",
        value: "Ryosuke",
        source: "Onboarding",
        updated: "Today",
      },
      {
        id: "mem-2",
        key: "Default browser",
        value: "Safari",
        source: "Observed in tasks",
        updated: "Today",
      },
      {
        id: "mem-3",
        key: "Invoice folder",
        value: "Save downloaded invoices to Downloads",
        source: "Observed in tasks",
        updated: "Yesterday",
      },
    ],
    appPermissions: [
      { app: "Calculator", standard: "allow" },
      { app: "Safari", standard: "ask" },
      { app: "Finder", standard: "ask" },
      { app: "Terminal", standard: "ask" },
    ],
    dailyCapUsd: 5.0,
    dailyCapDraft: "5.00",
    dailyCapSavedNote: "",
    sampleTodaySpendUsd: 0.08,
  };

  function normalizeViewName(raw) {
    const v = String(raw || "").toLowerCase().trim();
    if (v === "b1" || v === "graph" || v === "agent-graph") return "graph";
    if (v === "b1b" || v === "statemachine" || v === "state-machine" || v === "state") return "state-machine";
    if (v === "b2" || v === "logs" || v === "transcript" || v === "transcripts") return "logs";
    if (v === "b6" || v === "artifacts" || v === "artifact") return "artifacts";
    if (v === "b7" || v === "marketing" || v === "promo") return "marketing";
    if (v === "b3" || v === "analytics" || v === "cost") return "analytics";
    if (v === "b4" || v === "onboarding" || v === "setup") return "onboarding";
    if (v === "b5" || v === "history" || v === "settings" || v === "history-settings") return "history-settings";
    return "graph";
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /* ============================================================================
     5. IME-SAFE ENTER HANDLER (Modern Web Guidance: ime-safe-enter-submit)
     ============================================================================ */
  function attachImeSafeEnter(inputEl, onEnterSubmit) {
    if (!inputEl) return;
    let justEndedComposition = false;
    inputEl.addEventListener("compositionend", () => {
      justEndedComposition = true;
      setTimeout(() => {
        justEndedComposition = false;
      }, 30);
    });
    inputEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        if (event.isComposing || event.keyCode === 229 || justEndedComposition) {
          return;
        }
        event.preventDefault();
        onEnterSubmit(event);
      }
    });
  }

  /* ============================================================================
     6. RENDERING VIEWS (B1, B1b, B2, B3, B4)
     ============================================================================ */
  function getViewModel() {
    return WorkspaceAdapter.buildViewModel({
      rawRuns,
      detailsById,
      pendingHelp,
      rawAgents,
      rawActions,
      rawGraph,
      rawAnalytics,
      costsById,
      transcriptsByRunId,
      searchedTranscriptRows,
      sentAttachmentsByRunId,
      connectionStatus,
      connectionError,
      isSampleData,
      selectedTaskRunId,
      selectedAgentId: selectedAgentNodeId,
      smAgentFilter,
      selectedAppFilter,
      logSearchQuery,
      logStatusFilter,
    });
  }

  function renderHeaderAndProvenance(vm) {
    const provEl = document.getElementById("provenance-badge");
    if (provEl) {
      if (vm.isSampleData) {
        provEl.style.display = "inline-flex";
        provEl.textContent = vm.sampleLabel || "Sample data";
      } else if (vm.connectionStatus === "connected") {
        provEl.style.display = "inline-flex";
        provEl.textContent = "Live backend";
      } else {
        provEl.style.display = "none";
      }
    }

    const countGraph = document.getElementById("nav-count-graph");
    if (countGraph) {
      countGraph.textContent = vm.activeGroup ? String(vm.activeGroup.allNodes.length) : "0";
    }
    const countSm = document.getElementById("nav-count-sm");
    if (countSm) {
      countSm.textContent = String(vm.stateMachine.screens.length);
    }
    const countLogs = document.getElementById("nav-count-logs");
    if (countLogs) {
      countLogs.textContent = String(vm.taskGroups.length);
    }
    const countArtifacts = document.getElementById("nav-count-artifacts");
    if (countArtifacts) {
      countArtifacts.textContent = String((vm.artifacts || []).length);
    }
    const countMarketing = document.getElementById("nav-count-marketing");
    if (countMarketing) {
      countMarketing.textContent = String((vm.marketingRuns || []).length);
    }

    document.querySelectorAll("[data-view-tab]").forEach((btn) => {
      const isSelected = btn.dataset.viewTab === currentView;
      btn.setAttribute("aria-selected", isSelected ? "true" : "false");
    });

    document.querySelectorAll("[data-view-panel]").forEach((panel) => {
      const isActive = panel.dataset.viewPanel === currentView;
      panel.classList.toggle("active", isActive);
      panel.hidden = !isActive;
    });
  }

  function attachConnectInputHandlers(containerEl) {
    if (!containerEl) return;
    const connectInput = containerEl.querySelector("#connect-url-input");
    if (connectInput) {
      attachImeSafeEnter(connectInput, () => handleConnectSubmit());
    }
  }

  function renderNotConnectedViewHtml({ title, subtitle, connectionError: errMsg }) {
    const prevVal = document.getElementById("connect-url-input")?.value || "";
    const detail = errMsg || "Paste the address the backend printed to connect this view.";
    return `
      <div class="section-header-row">
        <div>
          <h2 class="section-title">${escapeHtml(title)}</h2>
          <p class="section-subtitle">${escapeHtml(subtitle)}</p>
        </div>
      </div>
      <div class="view-state-block">
        <div class="filter-group">
          <span class="state-text state-warning">&oslash; Not connected</span>
          <span class="section-subtitle">${escapeHtml(detail)}</span>
        </div>
        <div class="inline-input-row connect-row">
          <label for="connect-url-input" class="visually-hidden">Backend address</label>
          <input
            type="url"
            id="connect-url-input"
            class="inline-text-input"
            placeholder="http://127.0.0.1:8765/?t=..."
            aria-label="Backend address"
            value="${escapeHtml(prevVal)}"
          />
          <button type="button" id="connect-submit-btn" class="btn btn-primary" data-action="connect-backend">Connect</button>
        </div>
      </div>
    `;
  }

  function renderEmptyStateHtml({ title, subtitle, message, ctaLabel, ctaAction = "focus-prompt" }) {
    return `
      <div class="section-header-row">
        <div>
          <h2 class="section-title">${escapeHtml(title)}</h2>
          <p class="section-subtitle">${escapeHtml(subtitle)}</p>
        </div>
      </div>
      <div class="view-state-block">
        <span class="state-text state-neutral">&cir; ${escapeHtml(message)}</span>
        <div class="filter-group">
          <button type="button" class="btn btn-primary" data-action="${escapeHtml(ctaAction)}">${escapeHtml(ctaLabel)}</button>
        </div>
      </div>
    `;
  }

  function renderViewStatusNoticesHtml(vm) {
    const notices = [];
    if (vm.connectionStatus === "stale") {
      const ageSec = lastSuccessfulRefreshAt > 0
        ? Math.max(31, Math.round((Date.now() - lastSuccessfulRefreshAt) / 1000))
        : 45;
      notices.push(`
        <div class="view-status-row" role="status">
          <div class="filter-group">
            <span class="state-text state-warning">&#9684; May be out of date</span>
            <span class="section-subtitle">Disconnected from backend for ${escapeHtml(ageSec)}s since last refresh.</span>
          </div>
          <button type="button" class="btn" data-action="retry-poll">Retry</button>
        </div>
      `);
    }
    if (failedEndpoints.length > 0) {
      const arrivedText = succeededEndpoints.length
        ? succeededEndpoints.map((e) => e.label || e).join(", ")
        : "No endpoints";
      const failedText = failedEndpoints
        .map((e) => e.label || String(e))
        .join(", ");
      notices.push(`
        <div class="view-status-row" role="status">
          <div class="filter-group">
            <span class="state-text state-warning">&#9684; Partial data</span>
            <span class="section-subtitle">Arrived: ${escapeHtml(arrivedText)}. Failed: ${escapeHtml(failedText)}.</span>
          </div>
          <button type="button" class="btn" data-action="retry-poll">Retry</button>
        </div>
      `);
    }
    return notices.join("");
  }

  function renderLoadingSkeletonViewHtml(viewKey) {
    if (viewKey === "graph") {
      return `
        <div class="section-header-row">
          <div>
            <h2 class="section-title">Agent graph</h2>
            <p class="section-subtitle">One lead agent and the agents it starts</p>
          </div>
          <span class="state-text state-working">&hellip; Loading agent graph</span>
        </div>
        <div class="skeleton-stack" aria-busy="true">
          <div class="skeleton-row">
            <div class="skeleton-box" style="width: 220px; height: 64px;"></div>
          </div>
          <div class="skeleton-row">
            <div class="skeleton-box" style="width: 190px; height: 60px;"></div>
            <div class="skeleton-box" style="width: 190px; height: 60px;"></div>
            <div class="skeleton-box" style="width: 190px; height: 60px;"></div>
          </div>
          <div class="skeleton-line" style="width: 72%;"></div>
          <div class="skeleton-line" style="width: 58%;"></div>
          <div class="skeleton-line" style="width: 64%;"></div>
        </div>
      `;
    }
    if (viewKey === "state-machine") {
      return `
        <div class="section-header-row">
          <div>
            <h2 class="section-title">State machine graph</h2>
            <p class="section-subtitle">Screens, transitions, and action reliability across runs</p>
          </div>
          <span class="state-text state-working">&hellip; Loading state machine</span>
        </div>
        <div class="skeleton-stack" aria-busy="true">
          <div class="skeleton-row">
            <div class="skeleton-line" style="width: 96px; height: 28px;"></div>
            <div class="skeleton-line" style="width: 96px; height: 28px;"></div>
            <div class="skeleton-line" style="width: 96px; height: 28px;"></div>
          </div>
          <div class="skeleton-row">
            <div class="skeleton-box" style="width: 200px; height: 52px;"></div>
            <div class="skeleton-line" style="width: 140px; height: 12px;"></div>
            <div class="skeleton-box" style="width: 200px; height: 52px;"></div>
          </div>
          <div class="skeleton-row">
            <div class="skeleton-box" style="width: 200px; height: 52px;"></div>
            <div class="skeleton-line" style="width: 140px; height: 12px;"></div>
            <div class="skeleton-box" style="width: 200px; height: 52px;"></div>
          </div>
        </div>
      `;
    }
    if (viewKey === "logs") {
      return `
        <div class="section-header-row">
          <div>
            <h2 class="section-title">Transcript log</h2>
            <p class="section-subtitle">Searchable history of prompts, attachments, agents, and replies</p>
          </div>
          <span class="state-text state-working">&hellip; Loading transcript log</span>
        </div>
        <div class="skeleton-stack" aria-busy="true">
          <div class="skeleton-row">
            <div class="skeleton-line" style="width: 260px; height: 28px;"></div>
            <div class="skeleton-line" style="width: 84px; height: 28px;"></div>
            <div class="skeleton-line" style="width: 84px; height: 28px;"></div>
          </div>
          <div class="skeleton-line" style="width: 92%; height: 24px;"></div>
          <div class="skeleton-line" style="width: 88%; height: 24px;"></div>
          <div class="skeleton-line" style="width: 84%; height: 24px;"></div>
          <div class="skeleton-line" style="width: 78%; height: 24px;"></div>
        </div>
      `;
    }
    if (viewKey === "artifacts") {
      return `
        <div class="section-header-row">
          <div>
            <h2 class="section-title">Artifacts</h2>
            <p class="section-subtitle">Reports, patches, commits, and launch briefs produced by agents</p>
          </div>
          <span class="state-text state-working">&hellip; Loading artifacts</span>
        </div>
        <div class="skeleton-stack" aria-busy="true">
          <div class="skeleton-line" style="width: 92%;"></div>
          <div class="skeleton-line" style="width: 86%;"></div>
          <div class="skeleton-line" style="width: 78%;"></div>
        </div>
      `;
    }
    if (viewKey === "marketing") {
      return `
        <div class="section-header-row">
          <div>
            <h2 class="section-title">Marketing</h2>
            <p class="section-subtitle">Launch briefs, voice-over scripts, shot lists, palettes, and screenshots</p>
          </div>
          <span class="state-text state-working">&hellip; Loading marketing</span>
        </div>
        <div class="skeleton-stack" aria-busy="true">
          <div class="skeleton-box" style="width: 100%; height: 64px;"></div>
          <div class="skeleton-line" style="width: 90%;"></div>
          <div class="skeleton-line" style="width: 82%;"></div>
        </div>
      `;
    }
    if (viewKey === "analytics") {
      return `
        <div class="section-header-row">
          <div>
            <h2 class="section-title">Analytics</h2>
            <p class="section-subtitle">Spend, model calls, and app reliability from the local store</p>
          </div>
          <span class="state-text state-working">&hellip; Loading analytics</span>
        </div>
        <div class="skeleton-stack" aria-busy="true">
          <div class="skeleton-grid-4">
            <div class="skeleton-box" style="height: 68px;"></div>
            <div class="skeleton-box" style="height: 68px;"></div>
            <div class="skeleton-box" style="height: 68px;"></div>
            <div class="skeleton-box" style="height: 68px;"></div>
          </div>
          <div class="skeleton-box" style="width: 100%; height: 72px;"></div>
          <div class="skeleton-line" style="width: 94%;"></div>
          <div class="skeleton-line" style="width: 88%;"></div>
          <div class="skeleton-line" style="width: 82%;"></div>
        </div>
      `;
    }
    if (viewKey === "onboarding") {
      return `
        <div class="section-header-row">
          <div>
            <h2 class="section-title">Onboarding</h2>
            <p class="section-subtitle">Configure your profile, permissions, approval rules, and first task</p>
          </div>
          <span class="state-text state-working">&hellip; Loading onboarding</span>
        </div>
        <div class="skeleton-stack" aria-busy="true">
          <div class="skeleton-row">
            <div class="skeleton-line" style="width: 84px; height: 28px;"></div>
            <div class="skeleton-line" style="width: 84px; height: 28px;"></div>
            <div class="skeleton-line" style="width: 84px; height: 28px;"></div>
            <div class="skeleton-line" style="width: 84px; height: 28px;"></div>
          </div>
          <div class="skeleton-row">
            <div class="skeleton-box" style="width: 220px; height: 36px;"></div>
            <div class="skeleton-box" style="width: 220px; height: 36px;"></div>
          </div>
          <div class="skeleton-row">
            <div class="skeleton-box" style="width: 96px; height: 32px;"></div>
            <div class="skeleton-box" style="width: 96px; height: 32px;"></div>
            <div class="skeleton-box" style="width: 96px; height: 32px;"></div>
          </div>
        </div>
      `;
    }
    return `
      <div class="section-header-row">
        <div>
          <h2 class="section-title">History and settings</h2>
          <p class="section-subtitle">Search past tasks, review memories, set app permissions, and manage daily spend</p>
        </div>
        <span class="state-text state-working">&hellip; Loading history and settings</span>
      </div>
      <div class="skeleton-stack" aria-busy="true">
        <div class="skeleton-row">
          <div class="skeleton-line" style="width: 240px; height: 28px;"></div>
          <div class="skeleton-line" style="width: 110px; height: 28px;"></div>
        </div>
        <div class="skeleton-line" style="width: 95%; height: 24px;"></div>
        <div class="skeleton-line" style="width: 90%; height: 24px;"></div>
        <div class="skeleton-line" style="width: 85%; height: 24px;"></div>
        <div class="skeleton-box" style="width: 100%; height: 84px;"></div>
      </div>
    `;
  }

  function renderConnectionBanner(vm) {
    const banner = document.getElementById("connection-banner");
    if (!banner) return;

    if (vm.connectionStatus === "disconnected" || (vm.connectionStatus === "loading" && !hasLoadedOnce) || vm.connectionStatus === "stale") {
      banner.classList.add("hidden");
      banner.innerHTML = "";
      return;
    }

    if (vm.isSampleData && currentView !== "onboarding") {
      banner.classList.remove("hidden");
      banner.innerHTML = `
        <div class="filter-group">
          <span class="state-text state-warning">◔ Preview mode</span>
          <span class="section-subtitle">Showing preview runs and metrics, never live runs.</span>
        </div>
        <div class="filter-group">
          <button type="button" class="btn ${activeFixtureName === "workspace-demo" ? "btn-active" : ""}" data-action="load-fixture" data-fixture="workspace-demo">Multi-agent preview</button>
          <button type="button" class="btn ${activeFixtureName === "workspace-empty" ? "btn-active" : ""}" data-action="load-fixture" data-fixture="workspace-empty">Empty preview</button>
          <button type="button" class="btn ${activeFixtureName === "workspace-partial" ? "btn-active" : ""}" data-action="load-fixture" data-fixture="workspace-partial">Partial preview</button>
          <button type="button" class="btn ${activeFixtureName === "workspace-stale" ? "btn-active" : ""}" data-action="load-fixture" data-fixture="workspace-stale">Stale preview</button>
          <button type="button" class="btn ${activeFixtureName === "workspace-loading" ? "btn-active" : ""}" data-action="load-fixture" data-fixture="workspace-loading">Loading preview</button>
          <button type="button" class="btn ${activeFixtureName === "workspace-disconnected" ? "btn-active" : ""}" data-action="load-fixture" data-fixture="workspace-disconnected">Not connected preview</button>
        </div>
      `;
      return;
    }

    banner.classList.add("hidden");
    banner.innerHTML = "";
  }

  /* A4 & B4 #4: Render ONLY the request's own `options` verbatim (Approve/Deny or Done/Cancel).
     Do NOT show "Always allow" until backend /api/rules (§5-4) exists. */
  function renderApprovalsStrip(vm) {
    const strip = document.getElementById("approvals-strip");
    if (!strip) return;

    const showApprovalsHere = currentView === "graph" || currentView === "logs";
    if (!vm.approvals.length || !showApprovalsHere) {
      strip.classList.add("hidden");
      strip.innerHTML = "";
      return;
    }

    strip.classList.remove("hidden");
    strip.innerHTML = vm.approvals
      .map((item) => {
        if (item.isExpired) {
          return `
            <div class="approval-item">
              <div class="approval-main-row">
                <div class="approval-question-group">
                  <span class="state-text state-danger">&times; Expired</span>
                  <span class="approval-question">${escapeHtml(item.question)}</span>
                  <span class="approval-warning ${item.isDangerWarning ? "is-danger" : ""}">${escapeHtml(item.warningText)}</span>
                </div>
                <span class="approval-meta">Denied automatically after 5 minutes</span>
              </div>
              ${item.detail ? `<div class="approval-meta">${escapeHtml(item.detail)}</div>` : ""}
            </div>
          `;
        }

        const optionButtonsHtml = item.options
          .map((opt) => {
            const label = formatOptionButtonLabel(opt);
            return `
              <button
                type="button"
                class="btn"
                data-action="answer-help"
                data-help-id="${escapeHtml(item.id)}"
                data-help-kind="${escapeHtml(item.kind)}"
                data-choice="${escapeHtml(opt)}"
              >${escapeHtml(label)}</button>
            `;
          })
          .join("");

        return `
          <div class="approval-item">
            <div class="approval-main-row">
              <div class="approval-question-group">
                <span class="state-text state-warning">◔ Waiting</span>
                <span class="approval-question">${escapeHtml(item.question)}</span>
                <span class="approval-warning ${item.isDangerWarning ? "is-danger" : ""}">${escapeHtml(item.warningText)}</span>
              </div>
              <div class="approval-actions">
                ${optionButtonsHtml}
              </div>
            </div>
            ${item.detail ? `<div class="approval-meta">${escapeHtml(item.detail)} &middot; Denies after 5m if unanswered</div>` : ""}
          </div>
        `;
      })
      .join("");
  }

  /* ---------------- B1: AGENT GRAPH VIEW ---------------- */
  function renderAgentGraphView(vm) {
    const container = document.getElementById("b1-content");
    if (!container) return;

    if (vm.connectionStatus === "loading" && !hasLoadedOnce) {
      clearMountedGlass("b1-graph");
      container.innerHTML = renderLoadingSkeletonViewHtml("graph");
      return;
    }

    if (vm.connectionStatus === "disconnected") {
      clearMountedGlass("b1-graph");
      container.innerHTML = renderNotConnectedViewHtml({
        title: "Agent graph",
        subtitle: "One lead agent and the agents it starts",
        connectionError: vm.connectionError,
      });
      attachConnectInputHandlers(container);
      return;
    }

    if (!vm.activeGroup) {
      clearMountedGlass("b1-graph");
      container.innerHTML = `
        ${renderViewStatusNoticesHtml(vm)}
        ${renderEmptyStateHtml({
          title: "Agent graph",
          subtitle: "One lead agent and the agents it starts",
          message: "No runs yet. Send a prompt above to watch your primary agent and the agents it starts work.",
          ctaLabel: "Ask agents to run a task",
          ctaAction: "focus-prompt",
        })}
      `;
      return;
    }

    const group = vm.activeGroup;
    const selectedNode = vm.activeAgentNode || group.primaryNode;

    const runSelectorHtml =
      vm.taskGroups.length > 1
        ? `
          <div class="filter-group">
            <span class="filter-label">Prompt run:</span>
            ${vm.taskGroups
              .map(
                (g, i) => `
                  <button
                    type="button"
                    class="btn ${g.id === group.id ? "btn-active" : ""}"
                    data-action="select-task-run"
                    data-run-id="${escapeHtml(g.id)}"
                  >
                    <span>${escapeHtml(g.overallStatus.symbol)} Run ${vm.taskGroups.length - i}</span>
                  </button>
                `
              )
              .join("")}
          </div>
        `
        : "";

    /* Section 1B - B1:
       The orchestrator (parent) run has no cursor; draw it without glass, in the UI's muted text color.
       If /api/agents is empty or has no entry for a node, draw the same way. */
    function renderGraphNodeButton(node) {
      const isSelected = node.runId === selectedNode.runId;
      if (!node.hasGlass || !node.palette) {
        return `
          <button
            type="button"
            class="agent-glass-node is-plain-node ${isSelected ? "is-selected" : ""}"
            data-action="select-agent-node"
            data-node-run-id="${escapeHtml(node.runId)}"
            data-agent-name="${escapeHtml(node.agentName)}"
            data-parent-node="${node.isPrimary ? "1" : "0"}"
            aria-pressed="${isSelected ? "true" : "false"}"
          >
            <span class="glass-content">
              <span class="glass-node-top">
                <span class="glass-agent-name">${escapeHtml(node.agentName)}</span>
                <span class="glass-role-tag">${escapeHtml(node.roleText)}</span>
              </span>
              <span class="glass-node-status">
                <span class="state-text ${escapeHtml(node.status.colorClass)}">${escapeHtml(node.status.symbolWord)}</span>
                <span>&middot; ${escapeHtml(node.elapsedText)}</span>
              </span>
            </span>
          </button>
        `;
      }

      return `
        <button
          type="button"
          class="agent-glass-node ${isSelected ? "is-selected" : ""}"
          data-glass-mount="1"
          data-glass-body="${escapeHtml(node.palette.body)}"
          data-glass-edge="${escapeHtml(node.palette.edge)}"
          data-glass-ink="${escapeHtml(node.palette.ink)}"
          data-glass-raw-ink="${escapeHtml(node.palette.rawInk)}"
          data-glass-shape="rounded"
          data-glass-seed="${escapeHtml(node.seed)}"
          data-action="select-agent-node"
          data-node-run-id="${escapeHtml(node.runId)}"
          data-agent-name="${escapeHtml(node.agentName)}"
          data-parent-node="${node.isPrimary ? "1" : "0"}"
          aria-pressed="${isSelected ? "true" : "false"}"
        >
          <span class="glass-content">
            <span class="glass-node-top">
              <span class="glass-agent-name">${escapeHtml(node.agentName)}</span>
              <span class="glass-role-tag">${escapeHtml(node.roleText)}</span>
            </span>
            <span class="glass-node-status">
              <span>${escapeHtml(node.status.symbolWord)}</span>
              <span>&middot; ${escapeHtml(node.elapsedText)}</span>
            </span>
          </span>
        </button>
      `;
    }

    const childrenHtml = group.childNodes.length
      ? `<div class="agent-graph-tier" id="b1-children-tier">${group.childNodes.map(renderGraphNodeButton).join("")}</div>`
      : `<div class="section-subtitle">No agents started for this prompt.</div>`;

    const stepsHtml = selectedNode.steps.length
      ? selectedNode.steps
          .map(
            (st) => `
              <div class="agent-step-row">
                <span class="agent-step-kind">${escapeHtml(st.label)}</span>
                <span class="agent-step-summary">${escapeHtml(st.summary)}</span>
                <span class="agent-step-time">${escapeHtml(st.timeText)}</span>
              </div>
            `
          )
          .join("")
      : `<div class="section-subtitle">No decide, act, verify, help, or result events recorded yet.</div>`;

    container.innerHTML = `
      ${renderViewStatusNoticesHtml(vm)}
      <div class="section-header-row">
        <div>
          <h2 class="section-title">${escapeHtml(group.goal)}</h2>
          <p class="section-subtitle">
            <span class="state-text ${escapeHtml(group.overallStatus.colorClass)}">${escapeHtml(group.overallStatus.symbolWord)}</span>
            &middot; ${escapeHtml(group.resultSummary)} &middot; Elapsed ${escapeHtml(group.elapsedText)}${
              group.digestSummaryText ? ` &middot; ${escapeHtml(group.digestSummaryText)}` : ""
            }
          </p>
        </div>
        ${runSelectorHtml}
      </div>

      <div class="b1-layout">
        <div class="agent-graph-stage" id="b1-graph-stage">
          <svg class="agent-graph-edges-svg" id="b1-edges-svg" aria-hidden="true"></svg>
          <div class="agent-graph-tier" id="b1-primary-tier">
            ${renderGraphNodeButton(group.primaryNode)}
          </div>
          ${childrenHtml}
        </div>

        <div class="agent-steps-pane">
          <div class="agent-steps-header">
            <div>
              <div class="section-title">${escapeHtml(selectedNode.agentName)}</div>
              <div class="section-subtitle">
                <span class="state-text ${escapeHtml(selectedNode.status.colorClass)}">${escapeHtml(selectedNode.status.symbolWord)}</span>
                &middot; ${escapeHtml(selectedNode.roleText)} &middot; ${selectedNode.steps.length} step${selectedNode.steps.length === 1 ? "" : "s"}
              </div>
            </div>
            <button
              type="button"
              class="btn"
              data-action="filter-sm-by-agent"
              data-agent-name="${escapeHtml(selectedNode.isPrimary ? "" : selectedNode.agentName)}"
            >
              ${selectedNode.isPrimary ? "View all trails" : "Filter trail"}
            </button>
          </div>
          <div class="agent-steps-list">
            ${stepsHtml}
          </div>
        </div>
      </div>
    `;

    mountGlassElementsIn(container, "b1-graph");
    requestAnimationFrame(drawB1ParentChildEdges);
  }

  function drawB1ParentChildEdges() {
    const stage = document.getElementById("b1-graph-stage");
    const svg = document.getElementById("b1-edges-svg");
    if (!stage || !svg) return;

    const parentEl = stage.querySelector('[data-parent-node="1"]');
    const childEls = Array.from(stage.querySelectorAll('[data-parent-node="0"]'));
    if (!parentEl || !childEls.length) {
      svg.innerHTML = "";
      return;
    }

    const stageRect = stage.getBoundingClientRect();
    const pRect = parentEl.getBoundingClientRect();
    const px = pRect.left - stageRect.left + pRect.width / 2;
    const py = pRect.bottom - stageRect.top;

    const paths = childEls.map((childEl) => {
      const cRect = childEl.getBoundingClientRect();
      const cx = cRect.left - stageRect.left + cRect.width / 2;
      const cy = cRect.top - stageRect.top;
      const midY = (py + cy) / 2;
      const stroke = childEl.dataset.glassBody || "#767d8e";
      const isSelected = childEl.classList.contains("is-selected");
      return `
        <path
          d="M ${px} ${py} C ${px} ${midY}, ${cx} ${midY}, ${cx} ${cy}"
          fill="none"
          stroke="${escapeHtml(stroke)}"
          stroke-width="${isSelected ? "2.5" : "1.6"}"
          stroke-opacity="${isSelected ? "0.95" : "0.55"}"
        />
        <circle cx="${cx}" cy="${cy - 2}" r="3.5" fill="${escapeHtml(stroke)}" />
      `;
    });

    svg.setAttribute("viewBox", `0 0 ${Math.max(10, stageRect.width)} ${Math.max(10, stageRect.height)}`);
    svg.innerHTML = paths.join("");
  }

  /* ---------------- B1b: STATE MACHINE GRAPH VIEW ---------------- */
  function renderStateMachineView(vm) {
    const container = document.getElementById("b1b-content");
    if (!container) return;

    if (vm.connectionStatus === "loading" && !hasLoadedOnce) {
      container.innerHTML = renderLoadingSkeletonViewHtml("state-machine");
      return;
    }

    if (vm.connectionStatus === "disconnected") {
      container.innerHTML = renderNotConnectedViewHtml({
        title: "State machine graph",
        subtitle: "Screens as nodes and actions as directed edges across runs",
        connectionError: vm.connectionError,
      });
      attachConnectInputHandlers(container);
      return;
    }

    const sm = vm.stateMachine;
    const stats = vm.graphStats;

    if (!sm.edges.length && !smAgentFilter && selectedAppFilter === "all" && !vm.taskGroups.length) {
      container.innerHTML = `
        ${renderViewStatusNoticesHtml(vm)}
        ${renderEmptyStateHtml({
          title: "State machine graph",
          subtitle: "Screens as nodes and actions as directed edges across runs",
          message: "No screen transitions recorded yet. Run a computer-use task to map screens and actions.",
          ctaLabel: "Ask agents to run a task",
          ctaAction: "focus-prompt",
        })}
      `;
      return;
    }

    /* Determine active replay run & step */
    const replayRuns = Array.isArray(vm.replayRuns) ? vm.replayRuns : [];
    const activeReplayRun =
      replayRuns.find((r) => r.id === replayRunId) || replayRuns[0] || null;
    if (activeReplayRun && replayRunId !== activeReplayRun.id) {
      replayRunId = activeReplayRun.id;
      replayStepIndex = 0;
    }
    const replaySteps = activeReplayRun?.steps || [];
    const clampedStepIdx = replaySteps.length
      ? Math.max(0, Math.min(replayStepIndex, replaySteps.length - 1))
      : 0;
    replayStepIndex = clampedStepIdx;
    const activeReplayStep = replaySteps[clampedStepIdx] || null;

    const selectedEdge =
      sm.edges.find((e) => e.id === selectedSmEdgeId) || null;

    const agentPillsHtml = [
      `<button type="button" class="agent-trail-pill ${!smAgentFilter ? "active" : ""}" data-action="set-sm-agent" data-agent="">All agents</button>`,
      ...sm.allAgents.map((ag) => {
        const active = smAgentFilter === ag;
        const matchNode = vm.activeGroup?.allNodes.find((n) => n.agentName === ag);
        const dotColor = matchNode?.palette?.body || "#767d8e";
        return `
          <button type="button" class="agent-trail-pill ${active ? "active" : ""}" data-action="set-sm-agent" data-agent="${escapeHtml(ag)}">
            <span class="agent-color-dot" style="background:${escapeHtml(dotColor)};"></span>
            <span>${escapeHtml(ag)}</span>
          </button>
        `;
      }),
    ].join("");

    const appFilterHtml = [
      `<button type="button" class="btn ${selectedAppFilter === "all" ? "btn-active" : ""}" data-action="set-sm-app" data-app="all">All apps</button>`,
      ...sm.allApps.map(
        (app) => `
          <button type="button" class="btn ${selectedAppFilter === app ? "btn-active" : ""}" data-action="set-sm-app" data-app="${escapeHtml(app)}">${escapeHtml(app)}</button>
        `
      ),
    ].join("");

    let svgGraphHtml = "";
    if (!sm.edges.length) {
      svgGraphHtml = `
        <div class="filter-bar" style="padding: 16px 0;">
          <span class="state-text state-neutral">&cir; No screen transitions recorded for this filter</span>
          ${
            smAgentFilter || selectedAppFilter !== "all"
              ? `<button type="button" class="btn" data-action="clear-sm-filters">Show all transitions</button>`
              : `<button type="button" class="btn" data-action="load-fixture" data-fixture="workspace-demo">Load sample data</button>`
          }
        </div>
      `;
    } else {
      const rowHeight = 100;
      const svgWidth = 880;
      const svgHeight = Math.max(140, sm.edges.length * rowHeight + 32);

      const edgeRowsSvg = sm.edges
        .map((edge, idx) => {
          const y = 20 + idx * rowHeight;
          const xFrom = 24;
          const wNode = 224;
          const hNode = 54;
          const xTo = 620;
          const xLineStart = xFrom + wNode;
          const xLineEnd = xTo;
          const xMid = Math.round((xLineStart + xLineEnd) / 2);

          const statusFill =
            edge.statusClass === "state-success"
              ? "#32d583"
              : edge.statusClass === "state-warning"
                ? "#f5a623"
                : "#ff5c6c";

          const isSelectedEdge = selectedEdge && selectedEdge.id === edge.id;
          const isReplayHit =
            activeReplayStep &&
            ((activeReplayStep.fromId && edge.from === activeReplayStep.fromId && activeReplayStep.toId && edge.to === activeReplayStep.toId) ||
              (activeReplayStep.action && edge.action === activeReplayStep.action));

          const nodeStroke = isReplayHit
            ? "#f5a623"
            : isSelectedEdge
              ? "#f2f4f8"
              : "rgba(255,255,255,0.12)";
          const nodeStrokeWidth = isReplayHit || isSelectedEdge ? "2" : "1";

          const edgeStroke = edge.reliabilityColor || edge.trailColor || "#767d8e";
          const edgeWidth = edge.strokeWidth || 2.2;
          const dashAttr = edge.isDestructive ? 'stroke-dasharray="6 4"' : "";

          const reliabilityBadge = edge.isDestructive
            ? "⊘ Destructive · gated"
            : edge.reliabilityP != null
              ? `P=${edge.reliabilityP} · ${edge.tries} ${edge.tries === 1 ? "try" : "tries"}`
              : "gated";
          const metaText = `${reliabilityBadge}${
            edge.meanMs ? ` · ${edge.meanMs}ms` : ""
          } · ${edge.sourceLabel}`;

          return `
            <g class="sm-edge-group ${isSelectedEdge ? "is-selected" : ""}" transform="translate(0, ${y})" data-action="select-sm-edge" data-edge-id="${escapeHtml(edge.id)}" role="button" tabindex="0" aria-label="Inspect ${escapeHtml(edge.actionClean)} from ${escapeHtml(edge.fromTitle)} to ${escapeHtml(edge.toTitle)}">
              <rect x="${xFrom}" y="5" width="${wNode}" height="${hNode}" rx="8" fill="#16181d" stroke="${nodeStroke}" stroke-width="${nodeStrokeWidth}" />
              <text x="${xFrom + 12}" y="25" fill="#767d8e" font-size="12" font-weight="600">${escapeHtml(edge.app)}</text>
              <text x="${xFrom + 12}" y="45" fill="#f2f4f8" font-size="13" font-weight="600">${escapeHtml(edge.fromTitle.slice(0, 26))}</text>

              <line x1="${xLineStart}" y1="32" x2="${xLineEnd - 8}" y2="32" stroke="${escapeHtml(edgeStroke)}" stroke-width="${edgeWidth}" ${dashAttr} />
              <polygon points="${xLineEnd},32 ${xLineEnd - 9},26 ${xLineEnd - 9},38" fill="${escapeHtml(edgeStroke)}" />

              <rect x="${xMid - 150}" y="2" width="300" height="24" rx="6" fill="#0c0d10" />
              <text x="${xMid}" y="18" text-anchor="middle" font-size="12" font-weight="600">
                <tspan fill="${statusFill}">${escapeHtml(edge.statusSymbolWord)}</tspan>
                <tspan fill="#f2f4f8"> · ${escapeHtml(edge.actionClean.slice(0, 24))}</tspan>
              </text>
              <circle cx="${xMid - 138}" cy="46" r="4" fill="${escapeHtml(edge.trailColor)}" />
              <text x="${xMid}" y="50" text-anchor="middle" fill="#a6adbb" font-size="12">
                ${escapeHtml(edge.agents.join(", "))} · ${escapeHtml(metaText)}
              </text>

              <rect x="${xTo}" y="5" width="${wNode}" height="${hNode}" rx="8" fill="#16181d" stroke="${nodeStroke}" stroke-width="${nodeStrokeWidth}" />
              <text x="${xTo + 12}" y="25" fill="#767d8e" font-size="12" font-weight="600">${escapeHtml(edge.app)}</text>
              <text x="${xTo + 12}" y="45" fill="#f2f4f8" font-size="13" font-weight="600">${escapeHtml(edge.toTitle.slice(0, 26))}</text>
            </g>
          `;
        })
        .join("");

      svgGraphHtml = `
        <div class="sm-graph-wrap">
          <svg class="sm-svg" viewBox="0 0 ${svgWidth} ${svgHeight}" role="img" aria-label="Agent state machine screen transitions">
            ${edgeRowsSvg}
          </svg>
        </div>
      `;
    }

    /* Clicked edge action log rows */
    let edgeLogHtml = "";
    if (selectedEdge) {
      const matchingRows = (vm.rawActions || []).filter(
        (r) =>
          (r.from || `${r.app || "Desktop"}:start`) === selectedEdge.from &&
          (r.action || "action") === selectedEdge.action &&
          (r.to || `${r.app || "Desktop"}:${String(r.action || "act").split(":")[0] || "next"}`) === selectedEdge.to
      );
      const rowsHtml = matchingRows.length
        ? matchingRows
            .map((r) => {
              const out = String(r.outcome || "ok");
              const outClass =
                out === "ok" || out === "done_verified"
                  ? "state-success"
                  : out === "help"
                    ? "state-warning"
                    : "state-danger";
              const outSymbol =
                out === "ok" || out === "done_verified"
                  ? "✓ Success"
                  : out === "help"
                    ? "◔ Waiting"
                    : out === "denied"
                      ? "⊘ Denied"
                      : "× Failed";
              const timeStr = r.ts
                ? new Date(r.ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
                : "—";
              return `
                <tr>
                  <td>${escapeHtml(timeStr)}</td>
                  <td>${escapeHtml(r.agent || "Agent")}</td>
                  <td><span class="state-text ${outClass}">${outSymbol}</span></td>
                  <td class="num-col">${escapeHtml(r.ms ?? 0)}ms</td>
                  <td>${escapeHtml(r.source || "model")}</td>
                </tr>
              `;
            })
            .join("")
        : `<tr><td colspan="5" class="section-subtitle">No individual action rows recorded for this edge.</td></tr>`;

      edgeLogHtml = `
        <div class="sm-edge-detail">
          <div class="section-header-row">
            <div>
              <h3 class="section-title">Edge log: ${escapeHtml(selectedEdge.actionClean)}</h3>
              <p class="section-subtitle">
                ${escapeHtml(selectedEdge.fromTitle)} &rarr; ${escapeHtml(selectedEdge.toTitle)}
                ${selectedEdge.isDestructive ? " · Destructive action (never suggested as a path)" : ""}
              </p>
            </div>
            <button type="button" class="btn" data-action="close-sm-edge">Close</button>
          </div>
          <div class="data-table-wrap">
            <table class="data-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Agent</th>
                  <th>Outcome</th>
                  <th class="num-col">Latency</th>
                  <th>Source</th>
                </tr>
              </thead>
              <tbody>${rowsHtml}</tbody>
            </table>
          </div>
        </div>
      `;
    }

    /* Agent replay section (Issue #1 #5) */
    let replayHtml = "";
    if (replayRuns.length) {
      const runOptionsHtml = replayRuns
        .map(
          (rr) =>
            `<option value="${escapeHtml(rr.id)}" ${rr.id === activeReplayRun?.id ? "selected" : ""}>${escapeHtml(
              `${rr.agentName}: ${rr.goal.slice(0, 64)}`
            )}</option>`
        )
        .join("");

      const stepDetailHtml = activeReplayStep
        ? `
          <div class="replay-step-bar">
            <span class="state-text ${activeReplayStep.ok ? "state-success" : "state-danger"}">
              ${activeReplayStep.ok ? "✓ Success" : "× Failed"}
            </span>
            <span class="replay-action-name">${escapeHtml(String(activeReplayStep.action || "").replace(/:/g, " · "))}</span>
            <span class="section-subtitle">
              Screen hit: ${escapeHtml(activeReplayStep.app)} · ${escapeHtml(activeReplayStep.fromTitle)} &rarr; ${escapeHtml(activeReplayStep.toTitle)}
              ${activeReplayStep.ms ? ` (${escapeHtml(activeReplayStep.ms)}ms)` : ""}
            </span>
          </div>
        `
        : `<p class="section-subtitle">No act steps recorded for this run.</p>`;

      replayHtml = `
        <div class="sm-replay-section">
          <div class="section-header-row">
            <div>
              <h3 class="section-title">Agent replay</h3>
              <p class="section-subtitle">Pick a run and step through its act events to see which screen node each one hit</p>
            </div>
            <div class="filter-group">
              <button type="button" class="btn" data-action="replay-prev" ${clampedStepIdx <= 0 ? "disabled" : ""}>Previous</button>
              <span class="section-subtitle">Step ${replaySteps.length ? clampedStepIdx + 1 : 0} of ${replaySteps.length}</span>
              <button type="button" class="btn" data-action="replay-next" ${clampedStepIdx >= replaySteps.length - 1 ? "disabled" : ""}>Next</button>
            </div>
          </div>
          <div class="filter-bar">
            <label for="replay-run-select" class="filter-label">Run:</label>
            <select id="replay-run-select" class="inline-text-input replay-select" data-action="select-replay-run">
              ${runOptionsHtml}
            </select>
          </div>
          ${stepDetailHtml}
        </div>
      `;
    }

    const reliabilityText =
      stats.mean_edge_p != null ? `${Math.round(Number(stats.mean_edge_p) * 100)}% (P=${stats.mean_edge_p})` : "No scored edges yet";

    container.innerHTML = `
      ${renderViewStatusNoticesHtml(vm)}
      <div class="section-header-row">
        <div>
          <h2 class="section-title">State machine graph</h2>
          <p class="section-subtitle">
            Screens as nodes and actions as directed edges. Width shows tries; color shows reliability; dashed lines mark destructive edges. Click an edge for its action log.
          </p>
        </div>
        <div class="filter-group">
          ${appFilterHtml}
        </div>
      </div>

      <div class="metrics-strip">
        <div class="metric-item">
          <span class="metric-label">Screens mapped</span>
          <span class="metric-value">${escapeHtml(stats.screens ?? sm.screens.length)}</span>
          <span class="metric-note">App + window title + elements</span>
        </div>
        <div class="metric-item">
          <span class="metric-label">Action transitions</span>
          <span class="metric-value">${escapeHtml(stats.transitions ?? sm.edges.length)}</span>
          <span class="metric-note">${escapeHtml(sm.totalFilteredActions)} logged action rows</span>
        </div>
        <div class="metric-item">
          <span class="metric-label">Saved replay skills</span>
          <span class="metric-value">${escapeHtml(stats.skills ?? 0)}</span>
          <span class="metric-note">Macro paths replayed without model</span>
        </div>
        <div class="metric-item">
          <span class="metric-label">Mean edge reliability</span>
          <span class="metric-value">${escapeHtml(reliabilityText)}</span>
          <span class="metric-note">Posterior mean across tries</span>
        </div>
      </div>

      <div class="sm-legend-row">
        <div class="filter-group">
          <span class="filter-label">Agent trail filter:</span>
          ${agentPillsHtml}
        </div>
      </div>

      ${svgGraphHtml}
      ${edgeLogHtml}
      ${replayHtml}
    `;
  }

  /* ---------------- B2: TRANSCRIPT LOG VIEW ---------------- */
  function renderTranscriptLogView(vm) {
    const container = document.getElementById("b2-content");
    if (!container) return;

    if (vm.connectionStatus === "loading" && !hasLoadedOnce) {
      container.innerHTML = renderLoadingSkeletonViewHtml("logs");
      return;
    }

    if (vm.connectionStatus === "disconnected") {
      container.innerHTML = renderNotConnectedViewHtml({
        title: "Transcript log",
        subtitle: "Every run newest first: prompt, attachments, agents, status, result, and time",
        connectionError: vm.connectionError,
      });
      attachConnectInputHandlers(container);
      return;
    }

    if (!vm.taskGroups.length && !logSearchQuery.trim() && logStatusFilter === "all") {
      container.innerHTML = `
        ${renderViewStatusNoticesHtml(vm)}
        ${renderEmptyStateHtml({
          title: "Transcript log",
          subtitle: "Every run newest first: prompt, attachments, agents, status, result, and time",
          message: "No transcripts yet. Prompts, attachments, and agent replies appear here after your first run.",
          ctaLabel: "Ask agents to run a task",
          ctaAction: "focus-prompt",
        })}
      `;
      return;
    }

    const statusChips = [
      { key: "all", label: "All" },
      { key: "running", label: "▶ Running" },
      { key: "waiting", label: "◔ Waiting" },
      { key: "success", label: "✓ Success" },
      { key: "failed", label: "× Failed" },
    ];

    const chipsHtml = statusChips
      .map(
        (c) => `
          <button
            type="button"
            class="btn ${logStatusFilter === c.key ? "btn-active" : ""}"
            data-action="set-log-status"
            data-status="${escapeHtml(c.key)}"
          >${escapeHtml(c.label)}</button>
        `
      )
      .join("");

    const rowsHtml = vm.filteredTranscriptRuns.length
      ? vm.filteredTranscriptRuns
          .map((g) => {
            const isExpanded = expandedTranscriptRunIds.has(g.id);
            const agentsBadges = g.allNodes
              .map(
                (n) => `
                  <span class="inline-badge">
                    <span class="agent-color-dot" style="background:${escapeHtml(n.palette?.body || "#767d8e")};"></span>
                    <span>${escapeHtml(n.agentName)}</span>
                  </span>
                `
              )
              .join("");

            const attachBadges = g.attachments.length
              ? g.attachments
                  .map((att) => `<span class="attachment-token">${escapeHtml(att)}</span>`)
                  .join("")
              : `<span class="section-subtitle">No attachments</span>`;

            const eventsHtml = isExpanded
              ? `
                <div class="transcript-events-panel">
                  ${
                    g.combinedEvents.length
                      ? g.combinedEvents
                          .map(
                            (ev) =>
                              `<div>[${escapeHtml(ev.timeText || "0.0s")}] ${escapeHtml(ev.agentName)} · ${escapeHtml(ev.label)}: ${escapeHtml(ev.summary)}</div>`
                          )
                          .join("")
                      : `<div>No events recorded yet.</div>`
                  }
                </div>
              `
              : "";

            return `
              <div class="transcript-item">
                <button
                  type="button"
                  class="transcript-row-btn"
                  data-action="toggle-transcript-run"
                  data-run-id="${escapeHtml(g.id)}"
                  aria-expanded="${isExpanded ? "true" : "false"}"
                >
                  <span class="transcript-main">
                    <span class="state-text ${escapeHtml(g.overallStatus.colorClass)}">${escapeHtml(g.overallStatus.symbolWord)}</span>
                    <span class="transcript-goal">${escapeHtml(g.goal)}</span>
                    <span class="transcript-result">&middot; ${escapeHtml(g.resultSummary)}</span>
                  </span>
                  <span class="transcript-meta">
                    <span>${escapeHtml(g.elapsedText)}</span>
                    <span>${isExpanded ? "Hide transcript" : `${g.combinedEvents.length} entries`}</span>
                  </span>
                </button>
                <div class="transcript-subrow">
                  <div class="transcript-badges">
                    ${agentsBadges}
                  </div>
                  <div class="transcript-badges">
                    ${attachBadges}
                    <button type="button" class="btn" data-action="open-run-in-graph" data-run-id="${escapeHtml(g.id)}">View graph</button>
                  </div>
                </div>
                ${eventsHtml}
              </div>
            `;
          })
          .join("")
      : `
        <div class="filter-bar" style="padding: 16px 0;">
          <span class="state-text state-neutral">&cir; No runs match the current search or status filter</span>
          ${
            logSearchQuery || logStatusFilter !== "all"
              ? `<button type="button" class="btn" data-action="clear-log-filters">Reset filters</button>`
              : `<button type="button" class="btn" data-action="load-fixture" data-fixture="workspace-demo">Load sample data</button>`
          }
        </div>
      `;

    const existingInput = document.getElementById("log-search-input");
    const hadFocus = document.activeElement === existingInput;
    const cursorStart = existingInput?.selectionStart ?? null;

    container.innerHTML = `
      ${renderViewStatusNoticesHtml(vm)}
      <div class="section-header-row">
        <div>
          <h2 class="section-title">Transcript log</h2>
          <p class="section-subtitle">
            Every run newest first: prompt, attachments, agents, status, result, and time
            ${
              vm.isSampleData
                ? " &middot; Preview runs (not live backend history)"
                : " &middot; History resets when backend restarts"
            }
          </p>
        </div>
      </div>

      <div class="log-controls-row">
        <div class="search-input-wrap">
          <label for="log-search-input" class="visually-hidden">Search transcripts, prompts, results, and events</label>
          <input
            type="search"
            id="log-search-input"
            class="search-input"
            placeholder="Search prompts, results, agents, or events…"
            value="${escapeHtml(logSearchQuery)}"
          />
        </div>
        <div class="filter-group" role="group" aria-label="Filter runs by status">
          ${chipsHtml}
        </div>
      </div>

      <div class="transcript-list">
        ${rowsHtml}
      </div>
    `;

    const nextInput = document.getElementById("log-search-input");
    if (nextInput) {
      nextInput.addEventListener("input", (e) => {
        logSearchQuery = e.target.value;
        scheduleTranscriptSearch(logSearchQuery);
        renderTranscriptLogView(getViewModel());
      });
      attachImeSafeEnter(nextInput, () => {
        logSearchQuery = nextInput.value;
        runTranscriptSearchNow(logSearchQuery);
      });
      if (hadFocus) {
        nextInput.focus();
        if (cursorStart != null) {
          try {
            nextInput.setSelectionRange(cursorStart, cursorStart);
          } catch {
            // Ignore selection range errors
          }
        }
      }
    }
  }

  /* ---------------- ARTIFACTS LIST VIEW ---------------- */
  function renderArtifactsView(vm) {
    const container = document.getElementById("b6-content");
    if (!container) return;

    if (vm.connectionStatus === "loading" && !hasLoadedOnce) {
      container.innerHTML = renderLoadingSkeletonViewHtml("artifacts");
      return;
    }

    if (vm.connectionStatus === "disconnected") {
      container.innerHTML = renderNotConnectedViewHtml({
        title: "Artifacts",
        subtitle: "Reports, patches, commits, and launch briefs produced by agents",
        connectionError: vm.connectionError,
      });
      attachConnectInputHandlers(container);
      return;
    }

    const artifacts = Array.isArray(vm.artifacts) ? vm.artifacts : [];

    if (!artifacts.length) {
      container.innerHTML = `
        ${renderViewStatusNoticesHtml(vm)}
        <div class="section-header-row">
          <div>
            <h2 class="section-title">Artifacts</h2>
            <p class="section-subtitle">Reports, patches, commits, and launch briefs produced by agents</p>
          </div>
        </div>
        ${renderEmptyViewHtml({
          title: "Artifacts",
          subtitle: "Reports, patches, commits, and launch briefs produced by agents",
          message: "No artifacts produced yet. Bug reports, patches, commits, and launch briefs appear here as agents work.",
          showSampleButton: !vm.isSampleData,
        })}
      `;
      return;
    }

    const rowsHtml = artifacts
      .map((item) => {
        const isExpanded = expandedArtifactIds.has(item.id);
        let detailHtml = "";
        if (isExpanded) {
          if (item.kind === "bug_report") {
            const bugs = item.detail?.bugs || [];
            detailHtml = bugs.length
              ? bugs
                  .map(
                    (b) => `
                    <div>
                      <strong>${escapeHtml(sentenceCase(b.severity || "med"))}</strong> · ${escapeHtml(b.title || "Bug")}
                      ${b.file_hint ? ` <span class="section-subtitle">(${escapeHtml(b.file_hint)})</span>` : ""}
                      ${b.evidence ? `<div class="section-subtitle">${escapeHtml(b.evidence)}</div>` : ""}
                    </div>
                  `
                  )
                  .join("")
              : `<div class="section-subtitle">No bugs found in this round.</div>`;
          } else if (item.kind === "patch") {
            const d = item.detail || {};
            detailHtml = `
              <div>
                <span class="state-text ${d.applied ? "state-success" : "state-danger"}">${d.applied ? "✓ Applied" : "✕ Not applied"}</span>
                ${d.explanation ? ` · ${escapeHtml(d.explanation)}` : ""}
              </div>
              ${d.files && d.files.length ? `<div class="section-subtitle">Files: ${escapeHtml(d.files.join(", "))}</div>` : ""}
              ${d.error ? `<div class="state-text state-danger">Error: ${escapeHtml(d.error)}</div>` : ""}
              ${d.diff ? `<pre class="artifact-diff-pre">${escapeHtml(d.diff)}</pre>` : ""}
            `;
          } else if (item.kind === "commit") {
            const d = item.detail || {};
            detailHtml = `
              <div>
                <span class="state-text ${d.ok ? "state-success" : "state-danger"}">${d.ok ? "✓ Committed" : "✕ Commit failed"}</span>
                ${d.files && d.files.length ? ` · ${escapeHtml(d.files.join(", "))}` : ""}
              </div>
              ${d.out ? `<pre class="artifact-diff-pre">${escapeHtml(d.out)}</pre>` : ""}
            `;
          } else {
            const d = item.detail || {};
            const brief = d.brief;
            detailHtml = `
              ${d.fileName ? `<div>File: <strong>${escapeHtml(d.fileName)}</strong></div>` : ""}
              ${d.tagline ? `<div>Tagline: ${escapeHtml(d.tagline)}</div>` : ""}
              ${
                brief
                  ? `
                    ${brief.launch_script ? `<div class="marketing-script-box">${escapeHtml(brief.launch_script)}</div>` : ""}
                    ${
                      Array.isArray(brief.shot_list) && brief.shot_list.length
                        ? `<div class="section-subtitle">Shot list: ${escapeHtml(brief.shot_list.join(" · "))}</div>`
                        : ""
                    }
                  `
                  : d.path
                    ? `<div class="section-subtitle">Stored on this Mac and cannot be opened directly from this page.</div>`
                    : ""
              }
            `;
          }
        }

        return `
          <div class="artifact-row">
            <button
              type="button"
              class="artifact-row-btn"
              data-action="toggle-artifact-row"
              data-artifact-id="${escapeHtml(item.id)}"
              aria-expanded="${isExpanded ? "true" : "false"}"
            >
              <span class="artifact-row-main">
                <span class="state-text ${escapeHtml(item.statusObj.colorClass)}">${escapeHtml(item.statusObj.symbolWord)}</span>
                <strong>${escapeHtml(item.kindLabel)}</strong>
                <span class="inline-badge">
                  <span class="agent-color-dot" style="background:${escapeHtml(item.agentPalette?.body || "#767d8e")};"></span>
                  <span>${escapeHtml(item.agentName)}</span>
                </span>
                <span class="section-subtitle">${escapeHtml(item.taskGoal)}</span>
              </span>
              <span class="artifact-row-meta">
                <span>${escapeHtml(item.timeText || "")}</span>
                <span>${isExpanded ? "Hide" : "Details"}</span>
              </span>
            </button>
            ${
              isExpanded
                ? `
                  <div class="artifact-detail-panel">
                    ${detailHtml}
                    <div>
                      <button type="button" class="btn" data-action="open-run-in-graph" data-run-id="${escapeHtml(item.taskId)}">View task in graph</button>
                    </div>
                  </div>
                `
                : ""
            }
          </div>
        `;
      })
      .join("");

    container.innerHTML = `
      ${renderViewStatusNoticesHtml(vm)}
      <div class="section-header-row">
        <div>
          <h2 class="section-title">Artifacts</h2>
          <p class="section-subtitle">Bug reports, patches, commits, and marketing briefs from run events</p>
        </div>
      </div>
      <div class="artifact-list">
        ${rowsHtml}
      </div>
    `;
  }

  /* ---------------- MARKETING VIEW ---------------- */
  function renderMarketingView(vm) {
    const container = document.getElementById("b7-content");
    if (!container) return;

    if (vm.connectionStatus === "loading" && !hasLoadedOnce) {
      container.innerHTML = renderLoadingSkeletonViewHtml("marketing");
      return;
    }

    if (vm.connectionStatus === "disconnected") {
      container.innerHTML = renderNotConnectedViewHtml({
        title: "Marketing",
        subtitle: "Launch briefs, voice-over scripts, shot lists, palettes, and screenshots",
        connectionError: vm.connectionError,
      });
      attachConnectInputHandlers(container);
      return;
    }

    const runs = Array.isArray(vm.marketingRuns) ? vm.marketingRuns : [];
    if (!runs.length) {
      container.innerHTML = `
        ${renderViewStatusNoticesHtml(vm)}
        <div class="section-header-row">
          <div>
            <h2 class="section-title">Marketing</h2>
            <p class="section-subtitle">Launch briefs, voice-over scripts, shot lists, palettes, and screenshots</p>
          </div>
        </div>
        ${renderEmptyViewHtml({
          title: "Marketing",
          subtitle: "Launch briefs, voice-over scripts, shot lists, palettes, and screenshots",
          message: "No marketing runs yet. Ask your agents to create a launch brief or promo for an app or site.",
          showSampleButton: !vm.isSampleData,
        })}
      `;
      return;
    }

    const activeMkt = runs.find((r) => r.runId === selectedMarketingRunId) || runs[0];
    selectedMarketingRunId = activeMkt.runId;

    const selectorHtml =
      runs.length > 1
        ? `
          <div class="filter-group">
            <label for="marketing-run-select" class="filter-label">Marketing run</label>
            <select id="marketing-run-select" class="inline-select" data-action="select-marketing-run">
              ${runs
                .map(
                  (r) =>
                    `<option value="${escapeHtml(r.runId)}" ${r.runId === activeMkt.runId ? "selected" : ""}>${escapeHtml(r.goal)}</option>`
                )
                .join("")}
            </select>
          </div>
        `
        : "";

    const paletteHtml = activeMkt.palette.length
      ? `
        <div class="onboarding-block">
          <h3 class="section-title">Palette</h3>
          <div class="marketing-palette-row">
            ${activeMkt.palette
              .map(
                (hex) => `
                  <span class="marketing-swatch-chip">
                    <span class="marketing-swatch-dot" style="background:${escapeHtml(hex)};"></span>
                    <span>${escapeHtml(hex)}</span>
                  </span>
                `
              )
              .join("")}
          </div>
        </div>
      `
      : "";

    const shotsListHtml = activeMkt.shotList.length
      ? `
        <div class="onboarding-block">
          <h3 class="section-title">Shot list</h3>
          <ol class="marketing-shot-list">
            ${activeMkt.shotList.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}
          </ol>
        </div>
      `
      : "";

    const screenshotsHtml = activeMkt.screenshots.length
      ? `
        <div class="onboarding-block">
          <h3 class="section-title">Screenshots</h3>
          <div class="marketing-screenshots-grid">
            ${activeMkt.screenshots
              .map((shot) =>
                shot.isRenderable
                  ? `
                    <div class="marketing-screenshot-item">
                      <img src="${escapeHtml(shot.src)}" alt="${escapeHtml(shot.fileName || "Marketing screenshot")}" class="marketing-screenshot-img" />
                      <span class="section-subtitle">${escapeHtml(shot.fileName)}</span>
                    </div>
                  `
                  : `
                    <div class="marketing-screenshot-item">
                      <strong>${escapeHtml(shot.fileName)}</strong>
                      <span class="section-subtitle">Saved on this Mac and cannot be previewed from this page.</span>
                    </div>
                  `
              )
              .join("")}
          </div>
        </div>
      `
      : "";

    const tourHtml = activeMkt.tourSteps.length
      ? `
        <div class="onboarding-block">
          <h3 class="section-title">Product tour steps</h3>
          <div class="history-list">
            ${activeMkt.tourSteps
              .map(
                (st) => `
                  <div class="history-list-row">
                    <div class="history-list-main">
                      <span class="state-text ${st.ok ? "state-success" : "state-warning"}">${st.ok ? "✓" : "◔"} Step ${escapeHtml(st.step)}</span>
                      <span class="section-subtitle">${escapeHtml(st.summary || "Captured")}</span>
                    </div>
                  </div>
                `
              )
              .join("")}
          </div>
        </div>
      `
      : "";

    const macOnlyNoticeHtml = activeMkt.storedOnMacOnly
      ? `
        <div class="onboarding-block">
          <h3 class="section-title">Launch brief file</h3>
          ${activeMkt.briefFileName ? `<p>File: <strong>${escapeHtml(activeMkt.briefFileName)}</strong></p>` : ""}
          <p class="section-subtitle">
            The brief itself is stored on this Mac and is not readable through this page.
          </p>
        </div>
      `
      : "";

    container.innerHTML = `
      ${renderViewStatusNoticesHtml(vm)}
      <div class="section-header-row">
        <div>
          <h2 class="section-title">${escapeHtml(activeMkt.goal)}</h2>
          <p class="section-subtitle">
            <span class="state-text ${escapeHtml(activeMkt.status.colorClass)}">${escapeHtml(activeMkt.status.symbolWord)}</span>
            &middot; ${escapeHtml(activeMkt.agentName)} &middot; ${escapeHtml(activeMkt.elapsedText)}
            ${activeMkt.summary ? ` &middot; ${escapeHtml(activeMkt.summary)}` : ""}
          </p>
        </div>
        ${selectorHtml}
      </div>

      <div class="marketing-run-section">
        ${
          activeMkt.tagline
            ? `
              <div class="onboarding-block">
                <div class="filter-label">Tagline</div>
                <div class="marketing-tagline">${escapeHtml(activeMkt.tagline)}</div>
              </div>
            `
            : ""
        }
        ${
          activeMkt.launchScript
            ? `
              <div class="onboarding-block">
                <h3 class="section-title">Launch script</h3>
                <p class="marketing-script-box">${escapeHtml(activeMkt.launchScript)}</p>
              </div>
            `
            : ""
        }
        ${shotsListHtml}
        ${paletteHtml}
        ${screenshotsHtml}
        ${tourHtml}
        ${macOnlyNoticeHtml}
      </div>
    `;

    const selectEl = document.getElementById("marketing-run-select");
    if (selectEl) {
      selectEl.addEventListener("change", (e) => {
        selectedMarketingRunId = e.target.value;
        renderMarketingView(getViewModel());
      });
    }
  }

  /* ---------------- B3: ANALYTICS VIEW ---------------- */
  function renderAnalyticsView(vm) {
    const container = document.getElementById("b3-content");
    if (!container) return;

    if (vm.connectionStatus === "loading" && !hasLoadedOnce) {
      container.innerHTML = renderLoadingSkeletonViewHtml("analytics");
      return;
    }

    if (vm.connectionStatus === "disconnected") {
      container.innerHTML = renderNotConnectedViewHtml({
        title: "Analytics",
        subtitle: "Spend, model calls, and app reliability from the local store",
        connectionError: vm.connectionError,
      });
      attachConnectInputHandlers(container);
      return;
    }

    const an = vm.analytics;
    const gs = vm.graphStats;

    const hasRecordedAnalytics = Boolean(an && (an.tasks > 0 || an.llm_calls > 0));
    if (!hasRecordedAnalytics && !vm.taskGroups.length && !failedEndpoints.length) {
      container.innerHTML = `
        ${renderViewStatusNoticesHtml(vm)}
        ${renderEmptyStateHtml({
          title: "Analytics",
          subtitle: "Spend, model calls, and app reliability from the local store",
          message: "No tasks recorded yet. Spend, model calls, and app reliability appear here after your first run.",
          ctaLabel: "Ask agents to run a task",
          ctaAction: "focus-prompt",
        })}
      `;
      return;
    }

    const provenanceDescription = vm.isSampleData
      ? "Preview metrics shown from sample runs, never live runs."
      : vm.connectionStatus === "connected"
        ? "Live metrics from the local backend store."
        : "Not connected. Connect to the backend or load preview data to inspect analytics.";

    const summaryStripHtml = hasRecordedAnalytics
      ? `
        <div class="metrics-strip">
          <div class="metric-item">
            <span class="metric-label">Recorded tasks</span>
            <span class="metric-value">${escapeHtml(an.tasks)}</span>
            <span class="metric-note">${vm.isSampleData ? "Preview tasks" : "From local store"}</span>
          </div>
          <div class="metric-item">
            <span class="metric-label">Total model calls</span>
            <span class="metric-value">${escapeHtml(an.llm_calls)}</span>
            <span class="metric-note">${vm.isSampleData ? "Preview model calls" : "From local store"}</span>
          </div>
          <div class="metric-item">
            <span class="metric-label">Total token spend</span>
            <span class="metric-value">${an.cost_usd != null ? `$${Number(an.cost_usd).toFixed(4)}` : "—"}</span>
            <span class="metric-note">${
              an.mean_cost_per_task != null
                ? `Mean $${Number(an.mean_cost_per_task).toFixed(4)} / task`
                : "No per-task mean yet"
            }</span>
          </div>
          <div class="metric-item">
            <span class="metric-label">Memory graph coverage</span>
            <span class="metric-value">${escapeHtml(gs.screens ?? 0)} screens · ${escapeHtml(gs.skills ?? 0)} skills</span>
            <span class="metric-note">${
              gs.mean_edge_p != null ? `Mean reliability P=${gs.mean_edge_p}` : "No scored edges yet"
            }</span>
          </div>
        </div>
      `
      : `
        <div class="filter-bar" style="padding: 12px 0; border-bottom: 1px solid var(--line-divider);">
          <span class="state-text state-neutral">&cir; No recorded model calls in store yet</span>
          <span class="section-subtitle">
            ${
              vm.isSampleData
                ? "This fixture is the empty first-run sample (0 recorded tasks)."
                : "The local store has 0 recorded model calls (for example when running in mock mode). Zeroes are not shown as completed metrics."
            }
          </span>
        </div>
      `;

    /* Cost per task over time (Issue #1 #2) */
    const tasksWithCost = vm.taskGroups
      .filter((g) => g.cost && g.cost.cost_usd != null && (g.cost.cost_usd > 0 || g.cost.llm_calls > 0))
      .slice()
      .reverse();
    let spendChartHtml = "";
    if (tasksWithCost.length) {
      const maxCost = Math.max(...tasksWithCost.map((g) => Number(g.cost.cost_usd || 0)), 0.0001);
      const barW = 28;
      const gap = 10;
      const chartW = Math.max(240, tasksWithCost.length * (barW + gap) + 16);
      const chartH = 56;
      const barsSvg = tasksWithCost
        .map((g, i) => {
          const val = Number(g.cost.cost_usd || 0);
          const h = Math.max(4, Math.round((val / maxCost) * 38));
          const x = 8 + i * (barW + gap);
          const y = 44 - h;
          return `
            <g>
              <rect x="${x}" y="${y}" width="${barW}" height="${h}" rx="3" fill="#a6adbb" opacity="0.75">
                <title>${escapeHtml(g.goal)}: $${val.toFixed(4)}</title>
              </rect>
              <text x="${x + barW / 2}" y="55" text-anchor="middle" fill="#767d8e" font-size="10">$${val.toFixed(3)}</text>
            </g>
          `;
        })
        .join("");
      spendChartHtml = `
        <div class="analytics-spark-wrap">
          <div class="section-header-row">
            <span class="filter-label">Cost per task over time</span>
            <span class="section-subtitle">${tasksWithCost.length} ${tasksWithCost.length === 1 ? "task" : "tasks"}</span>
          </div>
          <svg class="analytics-spark-svg" viewBox="0 0 ${chartW} ${chartH}" role="img" aria-label="Cost per task over time">
            ${barsSvg}
          </svg>
        </div>
      `;
    }

    /* Decide spend share cue (Issue #1 #2) */
    const purposes = Array.isArray(an?.by_purpose) ? an.by_purpose : [];
    const totalPurposeSpend = purposes.reduce((sum, p) => sum + Number(p.cost_usd || 0), 0);
    const decideRow = purposes.find((p) => String(p.purpose || "").toLowerCase() === "decide");
    const decidePct =
      totalPurposeSpend > 0 && decideRow
        ? Math.round((Number(decideRow.cost_usd || 0) / totalPurposeSpend) * 100)
        : null;
    const decideCueHtml =
      decidePct != null && decidePct >= 65
        ? `<p class="section-subtitle">Decide accounts for ${decidePct}% of model spend — consider switching on the fast decide tier.</p>`
        : "";

    const taskRowsHtml = vm.taskGroups.length
      ? vm.taskGroups
          .map((g) => {
            const c = g.cost;
            if (!c || (c.llm_calls === 0 && c.prompt_tokens === 0 && c.cost_usd === 0)) {
              return `
                <tr>
                  <td>${escapeHtml(g.goal)}</td>
                  <td><span class="state-text ${escapeHtml(g.overallStatus.colorClass)}">${escapeHtml(g.overallStatus.shortSymbolWord || g.overallStatus.symbolWord)}</span></td>
                  <td class="num-col">${escapeHtml(g.allNodes.length)}</td>
                  <td class="num-col" colspan="4"><span class="section-subtitle">No model calls logged (mock mode or pending)</span></td>
                  <td class="num-col">${escapeHtml(g.elapsedText)}</td>
                </tr>
              `;
            }
            const totalTokens = (Number(c.prompt_tokens) || 0) + (Number(c.completion_tokens) || 0);
            return `
              <tr>
                <td>${escapeHtml(g.goal)}</td>
                <td><span class="state-text ${escapeHtml(g.overallStatus.colorClass)}">${escapeHtml(g.overallStatus.shortSymbolWord || g.overallStatus.symbolWord)}</span></td>
                <td class="num-col">${escapeHtml(c.agents ?? g.allNodes.length)}</td>
                <td class="num-col">${escapeHtml(c.llm_calls)}</td>
                <td class="num-col">${totalTokens.toLocaleString()} (${Number(c.prompt_tokens || 0).toLocaleString()} in / ${Number(c.completion_tokens || 0).toLocaleString()} out)</td>
                <td class="num-col">${c.cost_usd != null ? `$${Number(c.cost_usd).toFixed(4)}` : "—"}</td>
                <td class="num-col">${escapeHtml(c.model_seconds ?? 0)}s</td>
                <td class="num-col">${escapeHtml(g.elapsedText)}</td>
              </tr>
            `;
          })
          .join("")
      : `<tr><td colspan="8" class="section-subtitle">No task runs recorded yet.</td></tr>`;

    const roleRowsHtml =
      Array.isArray(an?.by_role) && an.by_role.length
        ? an.by_role
            .map((r) => {
              const runsCount = Number(r.runs) || 0;
              const okCount = Number(r.ok) || 0;
              const rate = runsCount > 0 ? `${Math.round((okCount / runsCount) * 100)}% (${okCount}/${runsCount})` : "—";
              return `
                <tr>
                  <td>${escapeHtml(r.role)}</td>
                  <td class="num-col">${escapeHtml(runsCount)}</td>
                  <td class="num-col">${escapeHtml(rate)}</td>
                  <td class="num-col">${r.mean_seconds != null ? `${Number(r.mean_seconds).toFixed(1)}s` : "—"}</td>
                </tr>
              `;
            })
            .join("")
        : `<tr><td colspan="4" class="section-subtitle">No role completion stats recorded yet.</td></tr>`;

    const purposeRowsHtml =
      purposes.length
        ? purposes
            .map((p) => {
              const share =
                totalPurposeSpend > 0
                  ? `${Math.round((Number(p.cost_usd || 0) / totalPurposeSpend) * 100)}%`
                  : "—";
              return `
                <tr>
                  <td>${escapeHtml(p.purpose || "general")}</td>
                  <td class="num-col">${escapeHtml(p.calls ?? 0)}</td>
                  <td class="num-col">${p.cost_usd != null ? `$${Number(p.cost_usd).toFixed(4)} (${share})` : "—"}</td>
                  <td class="num-col">${p.mean_ms != null ? `${Math.round(Number(p.mean_ms))}ms` : "—"}</td>
                </tr>
              `;
            })
            .join("")
        : `<tr><td colspan="4" class="section-subtitle">No purpose spend breakdown recorded yet.</td></tr>`;

    const appRowsHtml =
      Array.isArray(an?.by_app) && an.by_app.length
        ? an.by_app
            .map((a) => {
              const totalActs = Number(a.actions) || 0;
              const okActs = Number(a.ok) || 0;
              const rateNum = totalActs > 0 ? Math.round((okActs / totalActs) * 100) : null;
              const rateHtml =
                rateNum == null
                  ? '<span class="state-text state-neutral">&cir; —</span>'
                  : rateNum < 70
                    ? `<span class="state-text state-warning">◔ ${rateNum}% · Needs help</span>`
                    : `<span class="state-text state-success">✓ ${rateNum}%</span>`;
              return `
                <tr>
                  <td>${escapeHtml(a.app || "Desktop")}</td>
                  <td class="num-col">${escapeHtml(totalActs)}</td>
                  <td class="num-col">${escapeHtml(okActs)}</td>
                  <td class="num-col">${escapeHtml(a.failed ?? 0)}</td>
                  <td class="num-col">${escapeHtml(a.denied ?? 0)}</td>
                  <td class="num-col">${rateHtml}</td>
                </tr>
              `;
            })
            .join("")
        : `<tr><td colspan="6" class="section-subtitle">No application action rows recorded yet.</td></tr>`;

    container.innerHTML = `
      ${renderViewStatusNoticesHtml(vm)}
      <div class="section-header-row">
        <div>
          <h2 class="section-title">Analytics</h2>
          <p class="section-subtitle">${escapeHtml(provenanceDescription)}</p>
        </div>
      </div>

      ${summaryStripHtml}
      ${spendChartHtml}
      ${decideCueHtml}

      <details class="analytics-disclosure">
        <summary class="analytics-disclosure-summary">
          <span>Per-task cost and time</span>
          <span class="section-subtitle">${vm.taskGroups.length} ${vm.taskGroups.length === 1 ? "task" : "tasks"} &middot; ${vm.isSampleData ? "Preview" : "Live store"}</span>
        </summary>
        <div class="data-table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>Task prompt</th>
                <th>Status</th>
                <th class="num-col">Agents</th>
                <th class="num-col">Calls</th>
                <th class="num-col">Tokens (in / out)</th>
                <th class="num-col">Cost</th>
                <th class="num-col">Model time</th>
                <th class="num-col">Wall time</th>
              </tr>
            </thead>
            <tbody>
              ${taskRowsHtml}
            </tbody>
          </table>
        </div>
      </details>

      <details class="analytics-disclosure">
        <summary class="analytics-disclosure-summary">
          <span>Spend by model purpose &amp; agent role</span>
          <span class="section-subtitle">${decidePct != null ? `Decide ${decidePct}% of spend` : "Breakdown"}</span>
        </summary>
        <div class="b1-layout">
          <div>
            <div class="section-header-row">
              <h3 class="section-title">By model purpose</h3>
            </div>
            <div class="data-table-wrap">
              <table class="data-table">
                <thead>
                  <tr>
                    <th>Purpose</th>
                    <th class="num-col">Calls</th>
                    <th class="num-col">Spend</th>
                    <th class="num-col">Mean latency</th>
                  </tr>
                </thead>
                <tbody>
                  ${purposeRowsHtml}
                </tbody>
              </table>
            </div>
          </div>

          <div>
            <div class="section-header-row">
              <h3 class="section-title">By agent role</h3>
            </div>
            <div class="data-table-wrap">
              <table class="data-table">
                <thead>
                  <tr>
                    <th>Role</th>
                    <th class="num-col">Runs</th>
                    <th class="num-col">Success</th>
                    <th class="num-col">Mean time</th>
                  </tr>
                </thead>
                <tbody>
                  ${roleRowsHtml}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </details>

      <details class="analytics-disclosure">
        <summary class="analytics-disclosure-summary">
          <span>Reliability per app &amp; memory stats</span>
          <span class="section-subtitle">${Array.isArray(an?.by_app) ? `${an.by_app.length} apps` : "0 apps"} &middot; ${escapeHtml(gs.screens ?? 0)} screens</span>
        </summary>
        <div class="b1-layout">
          <div>
            <div class="section-header-row">
              <h3 class="section-title">Reliability per app</h3>
            </div>
            <div class="data-table-wrap">
              <table class="data-table">
                <thead>
                  <tr>
                    <th>Application</th>
                    <th class="num-col">Steps</th>
                    <th class="num-col">✓ Ok</th>
                    <th class="num-col">× Failed</th>
                    <th class="num-col">⊘ Denied</th>
                    <th class="num-col">Success rate</th>
                  </tr>
                </thead>
                <tbody>
                  ${appRowsHtml}
                </tbody>
              </table>
            </div>
          </div>

          <div>
            <div class="section-header-row">
              <h3 class="section-title">Memory and tool stats</h3>
            </div>
            <div class="data-table-wrap">
              <table class="data-table">
                <thead>
                  <tr>
                    <th>Metric</th>
                    <th class="num-col">Value</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Screens indexed</td>
                    <td class="num-col">${escapeHtml(gs.screens ?? 0)}</td>
                  </tr>
                  <tr>
                    <td>Action transitions</td>
                    <td class="num-col">${escapeHtml(gs.transitions ?? 0)}</td>
                  </tr>
                  <tr>
                    <td>Saved macro skills</td>
                    <td class="num-col">${escapeHtml(gs.skills ?? 0)}</td>
                  </tr>
                  <tr>
                    <td>Destructive edges gated</td>
                    <td class="num-col">${escapeHtml(gs.destructive_edges ?? 0)}</td>
                  </tr>
                  <tr>
                    <td>Total actions logged</td>
                    <td class="num-col">${escapeHtml(gs.actions_logged ?? 0)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </details>
    `;
  }

  /* ---------------- B4: ONBOARDING VIEW ---------------- */
  const ONBOARDING_VOICES = [
    { id: "2X7h8q4r8pMNZ7zRmpiF", name: "Sunny", note: "Warm and steady (default)" },
    { id: "voice_river", name: "River", note: "Calm and neutral" },
    { id: "voice_sage", name: "Sage", note: "Crisp and brisk" },
  ];

  function renderOnboardingView(vm) {
    const container = document.getElementById("b4-content");
    if (!container) return;

    if (vm.connectionStatus === "loading" && !hasLoadedOnce) {
      clearMountedGlass("b4-onboarding");
      container.innerHTML = renderLoadingSkeletonViewHtml("onboarding");
      return;
    }

    if (vm.connectionStatus === "disconnected") {
      clearMountedGlass("b4-onboarding");
      container.innerHTML = renderNotConnectedViewHtml({
        title: "Meet your agent",
        subtitle: "Set your name, voice, permissions, approval rules, and send your first task",
        connectionError: vm.connectionError,
      });
      attachConnectInputHandlers(container);
      return;
    }

    const emptyNoticeHtml =
      vm.connectionStatus === "connected" && !vm.taskGroups.length && !failedEndpoints.length
        ? `
          <div class="view-status-row" role="status">
            <div class="filter-group">
              <span class="state-text state-neutral">&cir; No runs yet</span>
              <span class="section-subtitle">Complete step 1 below or send your first prompt to start.</span>
            </div>
            <button type="button" class="btn" data-action="focus-prompt">Ask agents to run a task</button>
          </div>
        `
        : "";

    const step = Math.max(1, Math.min(OnboardingState.totalSteps, OnboardingState.step || 1));
    OnboardingState.step = step;

    const chosenSwatch = AGENT_SWATCHES[OnboardingState.swatchIndex % AGENT_SWATCHES.length];
    const previewSeed = stableSeed("preview:" + OnboardingState.agentName + ":" + chosenSwatch.name);

    const stepTitles = [
      "Name",
      "Voice",
      "Look and accessibility",
      "Permissions",
      "Where agents work",
      "What needs approval",
      "Off-limits apps",
      "Memory",
      "First task",
    ];

    const stepNavHtml = stepTitles
      .map((label, idx) => {
        const sNum = idx + 1;
        const active = sNum === step;
        return `
          <button
            type="button"
            class="btn ${active ? "btn-active" : ""}"
            data-action="goto-onboarding-step"
            data-step="${sNum}"
            aria-current="${active ? "step" : "false"}"
          >${sNum}. ${escapeHtml(label)}</button>
        `;
      })
      .join("");

    let stepBodyHtml = "";

    if (step === 1) {
      const swatchesHtml = AGENT_SWATCHES.map((sw, idx) => {
        const checked = idx === OnboardingState.swatchIndex;
        return `
          <button
            type="button"
            role="radio"
            aria-checked="${checked ? "true" : "false"}"
            class="swatch-glass-chip"
            data-glass-mount="1"
            data-glass-body="${escapeHtml(sw.body)}"
            data-glass-edge="${escapeHtml(sw.edge)}"
            data-glass-ink="${escapeHtml(sw.ink)}"
            data-glass-raw-ink="${escapeHtml(sw.rawInk)}"
            data-glass-shape="capsule"
            data-glass-seed="${escapeHtml(stableSeed("swatch:" + sw.name))}"
            data-action="select-onboarding-swatch"
            data-swatch-idx="${idx}"
          >
            <span class="glass-content">
              <span>${escapeHtml(sw.name)}</span>
              <span>${checked ? "✓" : ""}</span>
            </span>
          </button>
        `;
      }).join("");

      stepBodyHtml = `
        <div class="onboarding-block">
          <h3 class="section-title">What should I call you?</h3>
          <p class="section-subtitle">Optional. Leave blank if you prefer not to set a name now.</p>
          <div class="onboarding-row">
            <div class="onboarding-field">
              <label for="onboarding-call-me" class="filter-label">Call me (saved to your profile)</label>
              <div class="inline-input-row">
                <input type="text" id="onboarding-call-me" class="inline-text-input" value="${escapeHtml(OnboardingState.callMe)}" placeholder="Preferred name" maxlength="40" />
                <button type="button" class="btn btn-primary" data-action="save-onboarding-profile">Save name</button>
              </div>
              ${
                OnboardingState.profileSaveError
                  ? `<span class="state-text state-danger">${escapeHtml(OnboardingState.profileSaveError)}</span>`
                  : OnboardingState.profileSaveStatus
                    ? `<span class="state-text state-success">${escapeHtml(OnboardingState.profileSaveStatus)}</span>`
                    : ""
              }
            </div>
            <div class="onboarding-field">
              <label for="onboarding-pronounce" class="filter-label">Pronunciation (in-session only)</label>
              <input type="text" id="onboarding-pronounce" class="inline-text-input" value="${escapeHtml(OnboardingState.pronounce)}" placeholder="e.g. ree-oh" maxlength="40" />
            </div>
          </div>

          <div class="onboarding-row" style="margin-top:12px;">
            <div class="onboarding-field">
              <label for="onboarding-agent-name" class="filter-label">Primary agent alias</label>
              <input type="text" id="onboarding-agent-name" class="inline-text-input" value="${escapeHtml(OnboardingState.agentName)}" placeholder="Mercury" maxlength="32" />
            </div>
            <div class="preview-stage">
              <span class="filter-label">Live agent chip:</span>
              <div
                class="agent-preview-chip"
                data-glass-mount="1"
                data-glass-body="${escapeHtml(chosenSwatch.body)}"
                data-glass-edge="${escapeHtml(chosenSwatch.edge)}"
                data-glass-ink="${escapeHtml(chosenSwatch.ink)}"
                data-glass-raw-ink="${escapeHtml(chosenSwatch.rawInk)}"
                data-glass-shape="capsule"
                data-glass-seed="${escapeHtml(previewSeed)}"
              >
                <span class="glass-content">
                  <span>${escapeHtml(getPrimaryAgentDisplayName("ComputerAnything"))}</span>
                  <span>✓ Ready</span>
                </span>
              </div>
            </div>
          </div>

          <div>
            <div class="filter-label">Agent sea-glass color swatch:</div>
            <div class="swatches-stage" role="radiogroup" aria-label="Agent color swatches">${swatchesHtml}</div>
            <p class="section-subtitle" style="margin-top:8px;">The agents it starts keep their own names and cursor colors.</p>
          </div>
        </div>
      `;
    } else if (step === 2) {
      const voicesHtml = ONBOARDING_VOICES.map((v) => {
        const active = OnboardingState.voiceId === v.id;
        return `
          <div class="starter-prompt-row">
            <div>
              <span class="starter-prompt-text">${escapeHtml(v.name)}</span>
              <span class="section-subtitle"> &middot; ${escapeHtml(v.note)}</span>
            </div>
            <div class="filter-group">
              <button type="button" class="btn" data-action="preview-onboarding-voice" data-voice-id="${escapeHtml(v.id)}">Play 3s sample</button>
              <button type="button" class="btn ${active ? "btn-active" : ""}" data-action="select-onboarding-voice" data-voice-id="${escapeHtml(v.id)}">${active ? "✓ Selected" : "Allow"}</button>
            </div>
          </div>
        `;
      }).join("");
      stepBodyHtml = `
        <div class="onboarding-block">
          <h3 class="section-title">Choose a voice</h3>
          <p class="section-subtitle">Pick a voice for spoken replies, or listen to a 3-second sample first.</p>
          <div class="starter-prompts-list">${voicesHtml}</div>
          ${OnboardingState.voicePreviewStatus ? `<p class="section-subtitle">${escapeHtml(OnboardingState.voicePreviewStatus)}</p>` : ""}
        </div>
      `;
    } else if (step === 3) {
      const a11y = OnboardingState.a11y;
      stepBodyHtml = `
        <div class="onboarding-block">
          <h3 class="section-title">Look and accessibility</h3>
          <p class="section-subtitle">Follows your macOS reduced motion, high contrast, and VoiceOver settings by default.</p>
          <div class="onboarding-row">
            <div class="onboarding-field">
              <label for="onboarding-text-size" class="filter-label">Text size</label>
              <select id="onboarding-text-size" class="inline-text-input" data-action="set-a11y-select" data-a11y-key="text_size">
                <option value="default" ${a11y.text_size === "default" ? "selected" : ""}>Default</option>
                <option value="large" ${a11y.text_size === "large" ? "selected" : ""}>Large</option>
                <option value="extra_large" ${a11y.text_size === "extra_large" ? "selected" : ""}>Extra large</option>
              </select>
            </div>
            <div class="onboarding-field">
              <label for="onboarding-cursor-palette" class="filter-label">Cursor palette</label>
              <select id="onboarding-cursor-palette" class="inline-text-input" data-action="set-a11y-select" data-a11y-key="cursor_palette">
                <option value="default" ${a11y.cursor_palette === "default" ? "selected" : ""}>Default sea-glass</option>
                <option value="okabe_ito" ${a11y.cursor_palette === "okabe_ito" ? "selected" : ""}>Okabe-Ito (color-blind-safe)</option>
              </select>
            </div>
            <div class="onboarding-field">
              <label for="onboarding-cursor-scale" class="filter-label">Cursor scale</label>
              <select id="onboarding-cursor-scale" class="inline-text-input" data-action="set-a11y-select" data-a11y-key="cursor_scale">
                <option value="1" ${Number(a11y.cursor_scale) === 1 ? "selected" : ""}>1.0x</option>
                <option value="1.25" ${Number(a11y.cursor_scale) === 1.25 ? "selected" : ""}>1.25x</option>
                <option value="1.5" ${Number(a11y.cursor_scale) === 1.5 ? "selected" : ""}>1.5x</option>
              </select>
            </div>
          </div>
          <div class="filter-group" style="margin-top: 8px;">
            <button type="button" class="btn ${a11y.reduce_motion ? "btn-active" : ""}" data-action="toggle-a11y" data-a11y-key="reduce_motion">
              ${a11y.reduce_motion ? "✓ Reduced motion: cursors jump instead of flying" : "○ Reduced motion: off"}
            </button>
            <button type="button" class="btn ${a11y.high_contrast ? "btn-active" : ""}" data-action="toggle-a11y" data-a11y-key="high_contrast">
              ${a11y.high_contrast ? "✓ High contrast: on" : "○ High contrast: off"}
            </button>
          </div>
        </div>
      `;
    } else if (step === 4) {
      const perms = OnboardingState.permissions;
      const permItems = [
        {
          key: "accessibility",
          label: "Accessibility",
          why: "Needed so agents can click, type, and act inside apps.",
        },
        {
          key: "screen_recording",
          label: "Screen Recording",
          why: "Needed so agents can read the screen and verify steps.",
        },
        {
          key: "app_scripting",
          label: "App scripting",
          why: "Needed for app scripting and faster deterministic shortcuts.",
        },
      ];
      const permsHtml = permItems
        .map((p) => {
          const granted = Boolean(perms[p.key]);
          return `
            <div class="starter-prompt-row">
              <div>
                <div class="starter-prompt-text">${escapeHtml(p.label)}</div>
                <div class="section-subtitle">${escapeHtml(p.why)}</div>
              </div>
              <div class="filter-group">
                <span class="state-text ${granted ? "state-success" : "state-warning"}">
                  ${granted ? "✓ Granted" : "◔ Needed"}
                </span>
                ${
                  vm.isSampleData
                    ? `<button type="button" class="btn" data-action="toggle-sample-perm" data-perm-key="${p.key}">${granted ? "Not now" : "Allow"}</button>`
                    : ""
                }
              </div>
            </div>
          `;
        })
        .join("");

      const allGranted = perms.accessibility && perms.screen_recording && perms.app_scripting;
      stepBodyHtml = `
        <div class="onboarding-block">
          <h3 class="section-title">Permissions</h3>
          <p class="section-subtitle">
            All three permissions are required before continuing. Live permission check endpoint is not on the backend yet${vm.isSampleData ? " — use Allow below to test in sample mode" : ""}.
          </p>
          <div class="starter-prompts-list">${permsHtml}</div>
          <div class="filter-group">
            <span class="state-text ${allGranted ? "state-success" : "state-warning"}">
              ${allGranted ? "✓ Ready to continue" : "◔ Waiting for all three permissions"}
            </span>
          </div>
        </div>
      `;
    } else if (step === 5) {
      const choices = [
        { val: "secondary", label: "Secondary display (recommended)" },
        { val: "primary", label: "Primary display" },
        { val: "ask", label: "Ask each time" },
      ];
      const choicesHtml = choices
        .map((c) => {
          const active = OnboardingState.stageDisplay === c.val;
          return `
            <button type="button" class="btn ${active ? "btn-active" : ""}" data-action="set-stage-display" data-display="${c.val}">
              ${active ? "✓ " : ""}${escapeHtml(c.label)}
            </button>
          `;
        })
        .join("");
      stepBodyHtml = `
        <div class="onboarding-block">
          <h3 class="section-title">Where agents work</h3>
          <p class="section-subtitle">
            Agents work behind your windows and never take your keyboard. Choose which display holds the agent stage.
          </p>
          <div class="filter-group">${choicesHtml}</div>
        </div>
      `;
    } else if (step === 6) {
      const rulesRowsHtml = OnboardingState.rules
        .map((rule) => {
          if (rule.locked) {
            return `
              <tr>
                <td>
                  <div>${escapeHtml(rule.when)}</div>
                  <div class="approval-warning ${rule.kind === "delete" ? "is-danger" : ""}">${escapeHtml(rule.warning)}</div>
                </td>
                <td>
                  <span class="state-text state-warning">◔ Ask first</span>
                  <div class="rule-locked-note">Always asks. Can't be changed.</div>
                </td>
              </tr>
            `;
          }
          return `
            <tr>
              <td>${escapeHtml(rule.when)}</td>
              <td>
                <span class="state-text state-neutral">◔ ${rule.should === "block" ? "Not now" : "Ask first"} (read-only)</span>
              </td>
            </tr>
          `;
        })
        .join("");

      stepBodyHtml = `
        <div class="onboarding-block">
          <h3 class="section-title">What needs approval</h3>
          <p class="section-subtitle">
            Sample preview (read-only; approval rules are not saved on the backend yet). Sensitive categories always ask first.
          </p>
          <div class="data-table-wrap">
            <table class="rules-table">
              <thead>
                <tr>
                  <th>When it wants to…</th>
                  <th>It should</th>
                </tr>
              </thead>
              <tbody>${rulesRowsHtml}</tbody>
            </table>
          </div>
        </div>
      `;
    } else if (step === 7) {
      const blockedHtml = OnboardingState.blockedApps
        .map(
          (app) => `
            <span class="attachment-token">
              <span class="attachment-name">${escapeHtml(app)}</span>
              ${
                ["Banking", "Passwords", "Health"].includes(app)
                  ? `<span class="section-subtitle" style="margin-left:4px;">Locked</span>`
                  : `<button type="button" class="attachment-remove" data-action="remove-blocked-app" data-app="${escapeHtml(app)}" aria-label="Remove ${escapeHtml(app)}">&times;</button>`
              }
            </span>
          `
        )
        .join("");
      stepBodyHtml = `
        <div class="onboarding-block">
          <h3 class="section-title">Off-limits apps</h3>
          <p class="section-subtitle">
            Banking, passwords, and health apps are blocked by default so agents never open or read them.
          </p>
          <div class="attachments-list">${blockedHtml}</div>
          <div class="filter-bar" style="margin-top:8px;">
            <label for="onboarding-block-app-input" class="filter-label">Add app to block:</label>
            <input type="text" id="onboarding-block-app-input" class="inline-text-input" value="${escapeHtml(OnboardingState.customBlockedApp)}" placeholder="e.g. Messages" maxlength="40" />
            <button type="button" class="btn" data-action="add-blocked-app">Block app</button>
          </div>
        </div>
      `;
    } else if (step === 8) {
      stepBodyHtml = `
        <div class="onboarding-block">
          <h3 class="section-title">Memory</h3>
          <p class="section-subtitle">
            Sample preview (in-session only; memory is not saved on the backend yet). Remember things about me to work faster next time.
          </p>
          <div class="filter-group">
            <button type="button" class="btn ${OnboardingState.memoryEnabled ? "btn-active" : ""}" data-action="set-onboarding-memory" data-enabled="1">
              ${OnboardingState.memoryEnabled ? "✓ " : ""}Allow
            </button>
            <button type="button" class="btn ${!OnboardingState.memoryEnabled ? "btn-active" : ""}" data-action="set-onboarding-memory" data-enabled="0">
              ${!OnboardingState.memoryEnabled ? "✓ " : ""}Not now
            </button>
            <button type="button" class="btn btn-danger" data-action="forget-onboarding-memory">
              Forget everything
            </button>
          </div>
          ${OnboardingState.memoryStatusNote ? `<p class="section-subtitle">${escapeHtml(OnboardingState.memoryStatusNote)}</p>` : ""}
        </div>
      `;
    } else {
      const starterHtml = OnboardingState.starterPrompts
        .map(
          (promptText, i) => `
            <div class="starter-prompt-row">
              <span class="starter-prompt-text">${i + 1}. ${escapeHtml(promptText)}</span>
              <div class="filter-group">
                <button
                  type="button"
                  class="btn"
                  data-action="fill-starter-prompt"
                  data-prompt="${escapeHtml(promptText)}"
                >Load in input</button>
                <button
                  type="button"
                  class="btn btn-primary"
                  data-action="send-starter-prompt"
                  data-prompt="${escapeHtml(promptText)}"
                >Run first task</button>
              </div>
            </div>
          `
        )
        .join("");

      stepBodyHtml = `
        <div class="onboarding-block" style="border-bottom:none;">
          <h3 class="section-title">First task</h3>
          <p class="section-subtitle">
            Run a safe, visible demo to watch your agent cursor, lane, and steps in action.
          </p>
          <div class="starter-prompts-list">${starterHtml}</div>
        </div>
      `;
    }

    const canAdvanceFromPerms =
      step !== 4 ||
      (OnboardingState.permissions.accessibility &&
        OnboardingState.permissions.screen_recording &&
        OnboardingState.permissions.app_scripting);

    const existingAliasInput = document.getElementById("onboarding-agent-name");
    const aliasHadFocus = document.activeElement === existingAliasInput;
    const aliasCursor = existingAliasInput?.selectionStart ?? null;

    container.innerHTML = `
      ${renderViewStatusNoticesHtml(vm)}
      ${emptyNoticeHtml}
      <div class="section-header-row">
        <div>
          <h2 class="section-title">Meet your agent</h2>
          <p class="section-subtitle">
            Step ${step} of ${OnboardingState.totalSteps}: ${escapeHtml(stepTitles[step - 1])}
          </p>
        </div>
        <div class="filter-group">
          <span class="provenance-tag">${step} of ${OnboardingState.totalSteps}</span>
        </div>
      </div>

      <div class="filter-bar onboarding-step-pills" role="navigation" aria-label="Onboarding steps">
        ${stepNavHtml}
      </div>

      ${stepBodyHtml}

      <div class="section-header-row onboarding-footer">
        <div class="filter-group">
          <button type="button" class="btn" data-action="prev-onboarding-step" ${step <= 1 ? "disabled" : ""}>Back</button>
          ${step !== 4 && step < OnboardingState.totalSteps ? `<button type="button" class="btn" data-action="skip-onboarding-step">Skip</button>` : ""}
        </div>
        <div class="filter-group">
          ${
            step < OnboardingState.totalSteps
              ? `<button type="button" class="btn btn-primary" data-action="next-onboarding-step" ${!canAdvanceFromPerms ? "disabled" : ""}>Continue</button>`
              : `<button type="button" class="btn" data-action="switch-view" data-target-view="graph">Open agent graph</button>`
          }
        </div>
      </div>

      <p class="section-subtitle">
        Note: Your name is saved to your backend profile. Your primary agent name and color are saved in this browser. The agents it starts keep their own names and cursor colors.
      </p>
    `;

    mountGlassElementsIn(container, "b4-onboarding");

    const nextAliasInput = document.getElementById("onboarding-agent-name");
    if (nextAliasInput) {
      nextAliasInput.addEventListener("input", (e) => {
        OnboardingState.agentName = e.target.value;
        savePrimaryAgentChoice();
        renderOnboardingView(getViewModel());
      });
      attachImeSafeEnter(nextAliasInput, () => {
        OnboardingState.agentName = nextAliasInput.value.trim();
        savePrimaryAgentChoice();
        renderNow();
      });
      if (aliasHadFocus) {
        nextAliasInput.focus();
        if (aliasCursor != null) {
          try {
            nextAliasInput.setSelectionRange(aliasCursor, aliasCursor);
          } catch {
            // Ignore
          }
        }
      }
    }

    const userNameInput = document.getElementById("onboarding-user-name");
    if (userNameInput) {
      userNameInput.addEventListener("input", (e) => {
        OnboardingState.userName = e.target.value;
      });
    }
    const callMeInput = document.getElementById("onboarding-call-me");
    if (callMeInput) {
      callMeInput.addEventListener("input", (e) => {
        OnboardingState.callMe = e.target.value;
      });
    }
    const pronounceInput = document.getElementById("onboarding-pronounce");
    if (pronounceInput) {
      pronounceInput.addEventListener("input", (e) => {
        OnboardingState.pronounce = e.target.value;
      });
    }
    const blockAppInput = document.getElementById("onboarding-block-app-input");
    if (blockAppInput) {
      blockAppInput.addEventListener("input", (e) => {
        OnboardingState.customBlockedApp = e.target.value;
      });
    }
  }

  function buildHistoryRows(vm) {
    if (!vm.taskGroups.length) {
      return {
        usingSample: false,
        rows: [],
      };
    }
    const actionsByRun = new Map();
    for (const act of Array.isArray(rawActions) ? rawActions : []) {
      const rid = act?.run;
      const app = act?.app;
      if (!rid || !app) continue;
      if (!actionsByRun.has(rid)) actionsByRun.set(rid, new Set());
      actionsByRun.get(rid).add(app);
    }
    const rows = vm.taskGroups.map((g) => {
      const appSet = new Set();
      for (const n of g.allNodes || []) {
        const set = actionsByRun.get(n.runId);
        if (set) {
          for (const a of set) appSet.add(a);
        }
      }
      const apps = Array.from(appSet).sort();
      const costUsd = typeof g.cost?.cost_usd === "number" ? g.cost.cost_usd : null;
      const isFailed = g.overallStatus?.filterKey === "failed";
      const isSpike = costUsd !== null && costUsd >= 0.05;
      const hasDenied = (g.combinedEvents || []).some(
        (ev) => ev?.kind === "help" && /denied|deny/i.test(String(ev?.text || ev?.detail || ""))
      );
      const exceptionParts = [];
      if (isFailed) exceptionParts.push("Failed run");
      if (hasDenied) exceptionParts.push("Denied action");
      if (isSpike) exceptionParts.push("Cost spike");
      return {
        id: g.id,
        goal: g.goal || "Untitled task",
        apps,
        outcomeKey: g.overallStatus?.filterKey || "running",
        outcomeLabel: g.overallStatus?.symbolWord || "Running",
        costUsd,
        elapsedText: g.elapsedText || "—",
        hasException: exceptionParts.length > 0,
        exceptionNote: exceptionParts.join(" · "),
        canOpenRun: true,
      };
    });
    return { usingSample: false, rows };
  }

  function renderHistorySettingsView(vm) {
    const container = document.getElementById("b5-content");
    if (!container) return;

    if (vm.connectionStatus === "loading" && !hasLoadedOnce) {
      container.innerHTML = renderLoadingSkeletonViewHtml("history-settings");
      return;
    }

    if (vm.connectionStatus === "disconnected") {
      container.innerHTML = renderNotConnectedViewHtml({
        title: "History and settings",
        subtitle: "Search past tasks, review what the agent knows, and set app permissions and spend limits",
        connectionError: vm.connectionError,
      });
      attachConnectInputHandlers(container);
      return;
    }

    const searchInput = document.getElementById("history-search-input");
    const searchHadFocus = searchInput && document.activeElement === searchInput;
    const searchCursor = searchHadFocus ? searchInput.selectionStart : null;

    const { usingSample, rows } = buildHistoryRows(vm);
    const query = HistorySettingsState.searchQuery.trim().toLowerCase();
    const outcomeFilter = HistorySettingsState.outcomeFilter;
    const costFilter = HistorySettingsState.costFilter;

    const transcriptMatchRunIds =
      query && Array.isArray(searchedTranscriptRows)
        ? new Set(searchedTranscriptRows.map((r) => r.run).filter(Boolean))
        : null;

    const filteredRows = rows.filter((row) => {
      if (outcomeFilter !== "all" && row.outcomeKey !== outcomeFilter) return false;
      if (costFilter === "under-1c" && !(row.costUsd !== null && row.costUsd < 0.01)) return false;
      if (costFilter === "1c-5c" && !(row.costUsd !== null && row.costUsd >= 0.01 && row.costUsd <= 0.05)) return false;
      if (costFilter === "over-5c" && !(row.costUsd !== null && row.costUsd > 0.05)) return false;
      if (costFilter === "spike" && !row.hasException) return false;
      if (query) {
        if (transcriptMatchRunIds && transcriptMatchRunIds.has(row.id)) return true;
        const hay = `${row.goal} ${row.apps.join(" ")} ${row.exceptionNote}`.toLowerCase();
        if (!hay.includes(query)) return false;
      }
      return true;
    });

    const historyRowsHtml = !rows.length
      ? `
        <tr>
          <td colspan="6">
            <div class="view-state-block" style="padding: 8px 0;">
              <span class="state-text state-neutral">&cir; No task history yet. Completed runs appear here after your first task.</span>
              <div class="filter-group">
                <button type="button" class="btn btn-primary" data-action="focus-prompt">Ask agents to run a task</button>
              </div>
            </div>
          </td>
        </tr>
      `
      : filteredRows.length
      ? filteredRows
          .map((row) => {
            const costText = row.costUsd !== null ? `$${row.costUsd.toFixed(4)}` : "—";
            const appsText = row.apps.length ? row.apps.join(", ") : "General";
            const outcomeHtml = row.hasException
              ? `<span class="state-text state-danger">${escapeHtml(row.outcomeLabel)}</span>${
                  row.exceptionNote
                    ? `<div class="section-subtitle">${escapeHtml(row.exceptionNote)}</div>`
                    : ""
                }`
              : `<span class="state-text state-neutral">${escapeHtml(row.outcomeLabel)}</span>`;
            const openBtnHtml = row.canOpenRun
              ? `<button type="button" class="btn" data-action="open-run-in-graph" data-run-id="${escapeHtml(row.id)}">Open run</button>`
              : `<span class="section-subtitle">Sample</span>`;
            return `
              <tr>
                <td>
                  <div class="history-goal-text">${escapeHtml(row.goal)}</div>
                </td>
                <td>${escapeHtml(appsText)}</td>
                <td>${outcomeHtml}</td>
                <td class="num-cell">${escapeHtml(costText)}</td>
                <td class="num-cell">${escapeHtml(row.elapsedText)}</td>
                <td>${openBtnHtml}</td>
              </tr>
            `;
          })
          .join("")
      : `
        <tr>
          <td colspan="6" class="section-subtitle">No tasks match the current search and filters.</td>
        </tr>
      `;

    const activeMemories = HistorySettingsState.memoryLive
      ? HistorySettingsState.liveMemories
      : HistorySettingsState.memories;

    const memoriesHtml = activeMemories.length
      ? activeMemories
          .map((mem) => {
            const isEditing = !HistorySettingsState.memoryLive && HistorySettingsState.editingMemoryId === mem.id;
            const isConfirming = HistorySettingsState.confirmForgetId === mem.id;
            const valueHtml = isEditing
              ? `
                <div class="inline-input-row">
                  <label for="memory-edit-input-${escapeHtml(mem.id)}" class="visually-hidden">Edit ${escapeHtml(mem.key)}</label>
                  <input
                    type="text"
                    id="memory-edit-input-${escapeHtml(mem.id)}"
                    class="inline-text-input"
                    data-memory-edit-input="${escapeHtml(mem.id)}"
                    value="${escapeHtml(HistorySettingsState.editingMemoryDraft)}"
                  />
                  <button type="button" class="btn btn-primary" data-action="save-memory" data-memory-id="${escapeHtml(mem.id)}">Save</button>
                  <button type="button" class="btn" data-action="cancel-edit-memory" data-memory-id="${escapeHtml(mem.id)}">Cancel</button>
                </div>
              `
              : `<span>${escapeHtml(mem.value)}</span>`;

            const actionHtml = isEditing
              ? ""
              : isConfirming
              ? `
                <div class="filter-group" role="group" aria-label="Confirm forgetting ${escapeHtml(mem.key)}">
                  <span class="section-subtitle">Forget this memory?</span>
                  <button type="button" class="btn btn-destructive" data-action="confirm-forget-memory" data-memory-id="${escapeHtml(mem.id)}">Delete</button>
                  <button type="button" class="btn" data-action="cancel-forget-memory" data-memory-id="${escapeHtml(mem.id)}">Keep</button>
                </div>
              `
              : `
                <div class="filter-group">
                  ${HistorySettingsState.memoryLive ? "" : `<button type="button" class="btn" data-action="edit-memory" data-memory-id="${escapeHtml(mem.id)}">Edit</button>`}
                  <button type="button" class="btn" data-action="forget-memory" data-memory-id="${escapeHtml(mem.id)}">Forget</button>
                </div>
              `;

            return `
              <div class="history-list-row" data-memory-row="${escapeHtml(mem.id)}">
                <div class="history-list-main">
                  <div class="history-list-title">${escapeHtml(mem.key)}</div>
                  <div class="history-list-value">${valueHtml}</div>
                  <div class="section-subtitle">${escapeHtml(mem.source)} &middot; ${escapeHtml(mem.updated)}</div>
                </div>
                <div class="history-list-actions">
                  ${actionHtml}
                </div>
              </div>
            `;
          })
          .join("")
      : `<p class="section-subtitle">No saved memories in this session.</p>`;

    const permsHtml = HistorySettingsState.appPermissions
      .map((perm) => {
        return `
          <tr>
            <td><strong>${escapeHtml(perm.app)}</strong></td>
            <td>
              <div class="filter-group" role="group" aria-label="Standard actions for ${escapeHtml(perm.app)}">
                <button
                  type="button"
                  class="btn ${perm.standard === "ask" ? "btn-active" : ""}"
                  aria-pressed="${perm.standard === "ask" ? "true" : "false"}"
                  data-action="set-app-perm"
                  data-app="${escapeHtml(perm.app)}"
                  data-mode="ask"
                >Ask first</button>
                <button
                  type="button"
                  class="btn ${perm.standard === "allow" ? "btn-active" : ""}"
                  aria-pressed="${perm.standard === "allow" ? "true" : "false"}"
                  data-action="set-app-perm"
                  data-app="${escapeHtml(perm.app)}"
                  data-mode="allow"
                >Allow automatically</button>
              </div>
            </td>
            <td class="section-subtitle">Money, sign-in, and destructive actions are locked to ask first.</td>
          </tr>
        `;
      })
      .join("");

    const hasLiveSpend = typeof vm.analytics?.cost_usd === "number";
    const todaySpend = hasLiveSpend
      ? vm.analytics.cost_usd
      : vm.isSampleData
        ? HistorySettingsState.sampleTodaySpendUsd
        : null;

    container.innerHTML = `
      ${renderViewStatusNoticesHtml(vm)}
      <div class="section-header-row">
        <div>
          <h2 class="section-title">History and settings</h2>
          <p class="section-subtitle">Search past tasks, review what the agent knows, and set app permissions and spend limits</p>
        </div>
      </div>

      <section class="onboarding-block" aria-labelledby="history-tasks-heading">
        <div class="section-header-row">
          <div>
            <h3 id="history-tasks-heading" class="section-title">Task history</h3>
            <p class="section-subtitle">${
              usingSample
                ? "Sample data — no live runs recorded yet. Searchable by goal and app."
                : "Searchable by goal and app. Exceptions mark failed runs, denied actions, or cost spikes."
            }</p>
          </div>
        </div>

        <div class="filter-bar">
          <div class="inline-input-row" style="flex: 1; min-width: 220px; max-width: 360px;">
            <label for="history-search-input" class="visually-hidden">Search task history by goal or app</label>
            <input
              type="search"
              id="history-search-input"
              class="inline-text-input"
              placeholder="Search by goal or app…"
              value="${escapeHtml(HistorySettingsState.searchQuery)}"
            />
          </div>

          <div class="filter-group" role="group" aria-label="Filter by outcome">
            <button type="button" class="btn ${outcomeFilter === "all" ? "btn-active" : ""}" aria-pressed="${outcomeFilter === "all" ? "true" : "false"}" data-action="set-history-outcome" data-outcome="all">All</button>
            <button type="button" class="btn ${outcomeFilter === "success" ? "btn-active" : ""}" aria-pressed="${outcomeFilter === "success" ? "true" : "false"}" data-action="set-history-outcome" data-outcome="success">Success</button>
            <button type="button" class="btn ${outcomeFilter === "failed" ? "btn-active" : ""}" aria-pressed="${outcomeFilter === "failed" ? "true" : "false"}" data-action="set-history-outcome" data-outcome="failed">Failed</button>
            <button type="button" class="btn ${outcomeFilter === "waiting" ? "btn-active" : ""}" aria-pressed="${outcomeFilter === "waiting" ? "true" : "false"}" data-action="set-history-outcome" data-outcome="waiting">Waiting</button>
          </div>

          <div class="filter-group">
            <label for="history-cost-filter" class="section-subtitle">Cost</label>
            <select id="history-cost-filter" class="inline-select" data-action="set-history-cost">
              <option value="all" ${costFilter === "all" ? "selected" : ""}>All costs</option>
              <option value="under-1c" ${costFilter === "under-1c" ? "selected" : ""}>Under $0.01</option>
              <option value="1c-5c" ${costFilter === "1c-5c" ? "selected" : ""}>$0.01 to $0.05</option>
              <option value="over-5c" ${costFilter === "over-5c" ? "selected" : ""}>Over $0.05</option>
              <option value="spike" ${costFilter === "spike" ? "selected" : ""}>Exceptions only</option>
            </select>
          </div>
        </div>

        <div class="data-table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>Goal</th>
                <th>Apps</th>
                <th>Outcome</th>
                <th>Cost</th>
                <th>Time</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              ${historyRowsHtml}
            </tbody>
          </table>
        </div>
      </section>

      <section class="onboarding-block" aria-labelledby="history-memory-heading">
        <div class="section-header-row">
          <div>
            <h3 id="history-memory-heading" class="section-title">Memory viewer</h3>
            <p class="section-subtitle">${
              HistorySettingsState.memoryLive
                ? "Saved memories from the backend. Forgetting a memory deletes it."
                : "Sample data — no backend memory endpoint yet. Changes apply to this session only."
            }</p>
          </div>
          ${HistorySettingsState.memoryLive ? "" : `<span class="provenance-tag">Sample</span>`}
        </div>
        ${
          HistorySettingsState.memoryError
            ? `<p class="state-text state-danger">${escapeHtml(HistorySettingsState.memoryError)}</p>`
            : ""
        }
        <div class="history-list">
          ${memoriesHtml}
        </div>
      </section>

      <section class="onboarding-block" aria-labelledby="history-perms-heading">
        <div class="section-header-row">
          <div>
            <h3 id="history-perms-heading" class="section-title">Per-app permissions</h3>
            <p class="section-subtitle">Sample data — no backend permissions endpoint yet. Saved in this session only.</p>
          </div>
        </div>
        <div class="data-table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>App</th>
                <th>Standard actions</th>
                <th>Protected actions</th>
              </tr>
            </thead>
            <tbody>
              ${permsHtml}
            </tbody>
          </table>
        </div>
      </section>

      <section class="onboarding-block" aria-labelledby="history-cap-heading">
        <div class="section-header-row">
          <div>
            <h3 id="history-cap-heading" class="section-title">Daily spend cap</h3>
            <p class="section-subtitle">Sample setting. No backend cap yet. Agents are not paused.</p>
          </div>
        </div>

        <div class="filter-bar">
          <div class="filter-group">
            <span class="section-subtitle">${vm.isSampleData && !hasLiveSpend ? "Sample today's spend:" : "Today's spend:"}</span>
            <strong>${todaySpend != null ? `$${todaySpend.toFixed(4)}` : "—"}</strong>
            <span class="state-text state-neutral">&cir; Sample setting &middot; Agents are not paused</span>
          </div>

          <div class="inline-input-row">
            <label for="daily-cap-input" class="section-subtitle">Daily cap ($)</label>
            <input
              type="number"
              id="daily-cap-input"
              class="inline-text-input"
              style="width: 110px;"
              min="0.50"
              step="0.50"
              value="${escapeHtml(HistorySettingsState.dailyCapDraft)}"
            />
            <button type="button" class="btn" data-action="save-daily-cap">Save cap</button>
          </div>
        </div>
        ${
          HistorySettingsState.dailyCapSavedNote
            ? `<p class="section-subtitle">${escapeHtml(HistorySettingsState.dailyCapSavedNote)}</p>`
            : ""
        }
      </section>
    `;

    const nextSearchInput = document.getElementById("history-search-input");
    if (nextSearchInput) {
      nextSearchInput.addEventListener("input", (e) => {
        HistorySettingsState.searchQuery = e.target.value;
        scheduleTranscriptSearch(e.target.value);
        renderHistorySettingsView(getViewModel());
      });
      if (searchHadFocus) {
        nextSearchInput.focus();
        if (searchCursor != null) {
          try {
            nextSearchInput.setSelectionRange(searchCursor, searchCursor);
          } catch {
            // Ignore
          }
        }
      }
    }

    const capInput = document.getElementById("daily-cap-input");
    if (capInput) {
      capInput.addEventListener("input", (e) => {
        HistorySettingsState.dailyCapDraft = e.target.value;
      });
      attachImeSafeEnter(capInput, () => {
        const val = parseFloat(HistorySettingsState.dailyCapDraft);
        if (!Number.isNaN(val) && val > 0) {
          HistorySettingsState.dailyCapUsd = val;
          HistorySettingsState.dailyCapDraft = val.toFixed(2);
          HistorySettingsState.dailyCapSavedNote = `Daily cap set to $${val.toFixed(2)} for this session.`;
          renderNow();
        }
      });
    }

    if (HistorySettingsState.editingMemoryId) {
      const editInput = container.querySelector(
        `[data-memory-edit-input="${HistorySettingsState.editingMemoryId}"]`
      );
      if (editInput) {
        editInput.addEventListener("input", (e) => {
          HistorySettingsState.editingMemoryDraft = e.target.value;
        });
        attachImeSafeEnter(editInput, () => {
          const item = HistorySettingsState.memories.find(
            (m) => m.id === HistorySettingsState.editingMemoryId
          );
          const clean = HistorySettingsState.editingMemoryDraft.trim();
          if (item && clean) {
            item.value = clean;
            item.updated = "Just now";
          }
          HistorySettingsState.editingMemoryId = null;
          HistorySettingsState.editingMemoryDraft = "";
          renderNow();
        });
      }
    }
  }

  function renderNow() {
    const vm = getViewModel();
    if (!selectedTaskRunId && vm.taskGroups[0]) {
      selectedTaskRunId = vm.taskGroups[0].id;
    }
    renderHeaderAndProvenance(vm);
    renderConnectionBanner(vm);
    renderApprovalsStrip(vm);

    const errBanner = document.getElementById("send-error-banner");
    if (errBanner) {
      if (sendErrorText) {
        errBanner.classList.remove("hidden");
        errBanner.innerHTML = `<span class="state-text state-danger">&times; Failed &middot; ${escapeHtml(sendErrorText)}</span>`;
      } else {
        errBanner.classList.add("hidden");
        errBanner.innerHTML = "";
      }
    }

    if (currentView === "graph") {
      renderAgentGraphView(vm);
    } else if (currentView === "state-machine") {
      renderStateMachineView(vm);
    } else if (currentView === "logs") {
      renderTranscriptLogView(vm);
    } else if (currentView === "artifacts") {
      renderArtifactsView(vm);
    } else if (currentView === "marketing") {
      renderMarketingView(vm);
    } else if (currentView === "analytics") {
      renderAnalyticsView(vm);
    } else if (currentView === "onboarding") {
      renderOnboardingView(vm);
    } else if (currentView === "history-settings") {
      renderHistorySettingsView(vm);
    }
  }

  /* ============================================================================
     7. TRANSCRIPT ENDPOINTS & INTERACTIONS
     ============================================================================ */
  function extractTranscriptRows(resp) {
    if (Array.isArray(resp)) return resp;
    if (Array.isArray(resp?.rows)) return resp.rows;
    if (Array.isArray(resp?.transcript)) return resp.transcript;
    if (Array.isArray(resp?.messages)) return resp.messages;
    return null;
  }

  async function fetchRunTranscript(runId) {
    if (!runId || !Transport.isConnected()) return;
    try {
      const resp = await Transport.request("GET", `/api/runs/${encodeURIComponent(runId)}/transcript`);
      const rows = extractTranscriptRows(resp);
      if (rows) {
        transcriptsByRunId[runId] = rows;
        renderNow();
      }
    } catch {
      // Fallback to in-memory run events if endpoint returns 404
    }
  }

  async function runTranscriptSearchNow(query) {
    const clean = String(query || "").trim();
    if (!clean || !Transport.isConnected()) {
      searchedTranscriptRows = null;
      renderNow();
      return;
    }
    try {
      const resp = await Transport.request("GET", `/api/transcripts?q=${encodeURIComponent(clean)}`);
      searchedTranscriptRows = extractTranscriptRows(resp);
    } catch {
      searchedTranscriptRows = null;
    }
    renderNow();
  }

  function scheduleTranscriptSearch(query) {
    if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
    const clean = String(query || "").trim();
    if (!clean) {
      searchedTranscriptRows = null;
      return;
    }
    searchDebounceTimer = setTimeout(() => {
      runTranscriptSearchNow(clean);
    }, 180);
  }

  function setView(viewName) {
    const normalized = normalizeViewName(viewName);
    currentView = normalized;
    try {
      const nextUrl = new URL(window.location.href);
      nextUrl.searchParams.set("view", normalized);
      window.history.replaceState(null, "", nextUrl.toString());
    } catch {
      window.location.hash = normalized;
    }
    renderNow();
  }

  async function handleConnectSubmit() {
    const input = document.getElementById("connect-url-input");
    if (!input) return;
    const res = await Transport.setConnection(input.value);
    if (!res.ok) {
      connectionStatus = "disconnected";
      connectionError = res.error || "Paste the address the backend printed";
      renderNow();
      return;
    }
    isSampleData = false;
    connectionError = "";
    connectionStatus = "loading";
    renderNow();
    await pollAll();
  }

  async function switchFixture(fixtureName) {
    try {
      await Transport.loadFixture(fixtureName);
      isSampleData = true;
      connectionStatus = "connected";
      connectionError = "";
      selectedTaskRunId = null;
      selectedAgentNodeId = null;
      transcriptsByRunId = {};
      searchedTranscriptRows = null;
      try {
        const nextUrl = new URL(window.location.href);
        nextUrl.searchParams.set("fixture", fixtureName);
        window.history.replaceState(null, "", nextUrl.toString());
      } catch {
        // Ignore history update error on file://
      }
      await pollAll();
    } catch (err) {
      sendErrorText = err.message || "Could not load sample fixture";
      renderNow();
    }
  }

  async function submitTask(rawPrompt, attachedItems = []) {
    sendErrorText = "";
    const cleanPrompt = String(rawPrompt || "").trim();
    if (!cleanPrompt) return;

    if (!Transport.isConnected()) {
      await switchFixture("workspace-demo");
    }

    const links = attachedItems.filter((a) => a.kind === "link").map((a) => a.url);
    const fullPrompt = links.length ? `${cleanPrompt}\n${links.join("\n")}` : cleanPrompt;
    const fileItems = attachedItems.filter((a) => a.kind === "file");
    const attachedNames = attachedItems.map((a) => a.name).filter(Boolean);

    try {
      let created;
      if (activeFixtureName) {
        created = await Transport.request("POST", "/api/task", {
          prompt: fullPrompt,
          attachedNames,
        });
      } else if (hasShellBridge()) {
        const filePaths = fileItems.map((f) => f.path).filter(Boolean);
        created = await Transport.request(
          "POST",
          "/api/task",
          filePaths.length ? { prompt: fullPrompt, filePaths } : { jsonBody: { prompt: fullPrompt } }
        );
      } else if (fileItems.length) {
        const fd = new FormData();
        fd.append("prompt", fullPrompt);
        for (const item of fileItems) {
          if (item.file) fd.append("files", item.file, item.name);
        }
        created = await Transport.request("POST", "/api/task", { formData: fd });
      } else {
        created = await Transport.request("POST", "/api/task", {
          jsonBody: { prompt: fullPrompt },
        });
      }

      if (created?.run) {
        if (attachedNames.length) {
          sentAttachmentsByRunId.set(created.run, attachedNames);
          persistSentAttachments();
        }
        selectedTaskRunId = created.run;
        selectedAgentNodeId = created.run;
      }
      if (currentView === "onboarding") {
        setView("graph");
      }
      await pollAll();
    } catch (err) {
      if (err.code === "AUTH") {
        Transport.clearConnection();
        connectionStatus = "disconnected";
        connectionError = "Token rejected · Paste the backend address again";
      } else {
        sendErrorText = err.message || "Could not send task";
      }
      renderNow();
    }
  }

  /* ============================================================================
     8. POLLING (/api/runs, /api/help, /api/agents, /api/actions, /api/graph, /api/analytics, /api/runs/<id>/cost)
     ============================================================================ */
  async function pollAll() {
    if (!Transport.isConnected()) {
      connectionStatus = "disconnected";
      failedEndpoints = [];
      succeededEndpoints = [];
      renderNow();
      return;
    }

    const wsState = activeFixtureName ? Transport.getFixtureWorkspaceState() : null;
    if (wsState?.status === "disconnected") {
      hasLoadedOnce = false;
      connectionStatus = "disconnected";
      connectionError = wsState.error || "Paste the address the backend printed";
      failedEndpoints = [];
      succeededEndpoints = [];
      renderNow();
      return;
    }
    if (wsState?.status === "loading") {
      hasLoadedOnce = false;
      connectionStatus = "loading";
      connectionError = "";
      failedEndpoints = [];
      succeededEndpoints = [];
      renderNow();
      return;
    }

    const actionsPath = smAgentFilter
      ? `/api/actions?agent=${encodeURIComponent(smAgentFilter)}`
      : "/api/actions";

    const specs = [
      { key: "runs", label: "Runs", path: "/api/runs" },
      { key: "help", label: "Approvals", path: "/api/help" },
      { key: "agents", label: "Agent identities", path: "/api/agents" },
      { key: "actions", label: "Action trail", path: actionsPath },
      { key: "graph", label: "Memory graph", path: "/api/graph" },
      { key: "analytics", label: "Analytics", path: "/api/analytics" },
      { key: "profile", label: "Profile", path: "/api/profile" },
    ];

    const settled = await Promise.allSettled(
      specs.map((spec) => Transport.request("GET", spec.path))
    );

    const authFailure = settled.find(
      (res) => res.status === "rejected" && res.reason?.code === "AUTH"
    );
    if (authFailure) {
      Transport.clearConnection();
      connectionStatus = "disconnected";
      connectionError = "Token rejected · Paste the address again";
      failedEndpoints = [];
      succeededEndpoints = [];
      renderNow();
      return;
    }

    const nextSucceeded = [];
    const nextFailed = [];
    const resultsByKey = {};

    settled.forEach((res, idx) => {
      const spec = specs[idx];
      if (res.status === "fulfilled") {
        nextSucceeded.push({ key: spec.key, label: spec.label, path: spec.path });
        resultsByKey[spec.key] = res.value;
      } else {
        nextFailed.push({
          key: spec.key,
          label: spec.label,
          path: spec.path,
          error: res.reason?.message || "Request failed",
        });
      }
    });

    if (nextSucceeded.length === 0) {
      failedEndpoints = nextFailed;
      succeededEndpoints = [];
      if (hasLoadedOnce && lastSuccessfulRefreshAt > 0 && Date.now() - lastSuccessfulRefreshAt > 30000) {
        connectionStatus = "stale";
      } else if (!hasLoadedOnce) {
        connectionStatus = "disconnected";
        connectionError = nextFailed[0]?.error || "Could not reach backend";
      }
      renderNow();
      return;
    }

    const nextRuns = resultsByKey.runs !== undefined
      ? (Array.isArray(resultsByKey.runs) ? resultsByKey.runs : [])
      : rawRuns;
    const nextHelp = resultsByKey.help !== undefined
      ? (Array.isArray(resultsByKey.help) ? resultsByKey.help : [])
      : pendingHelp;

    if (resultsByKey.runs !== undefined) {
      await Promise.all(
        nextRuns.map(async (r) => {
          const existing = detailsById[r.id];
          const since = existing && Array.isArray(existing.events) ? existing.events.length : 0;
          if (existing && existing.n_events === r.n_events && (r.state === "done" || r.state === "failed")) {
            return;
          }
          try {
            const view = await Transport.request(
              "GET",
              `/api/runs/${encodeURIComponent(r.id)}?since=${since}`
            );
            if (existing && since > 0 && Array.isArray(view.events) && !activeFixtureName) {
              view.events = [...existing.events, ...view.events];
            }
            detailsById[r.id] = view;
          } catch {
            // Keep previous detail
          }
        })
      );

      const parentRuns = nextRuns.filter((r) => !r.parent);
      await Promise.all(
        parentRuns.slice(0, 8).map(async (p) => {
          try {
            const costData = await Transport.request("GET", `/api/runs/${encodeURIComponent(p.id)}/cost`);
            if (costData) costsById[p.id] = costData;
          } catch {
            // Ignore cost fetch errors
          }
          if (expandedTranscriptRunIds.has(p.id) || !transcriptsByRunId[p.id]) {
            await fetchRunTranscript(p.id);
          }
        })
      );
    }

    rawRuns = nextRuns;
    pendingHelp = nextHelp;
    if (resultsByKey.agents !== undefined) {
      rawAgents = resultsByKey.agents && typeof resultsByKey.agents === "object" ? resultsByKey.agents : {};
    }
    if (resultsByKey.actions !== undefined) {
      rawActions = Array.isArray(resultsByKey.actions?.actions) ? resultsByKey.actions.actions : [];
    }
    if (resultsByKey.graph !== undefined) {
      rawGraph = resultsByKey.graph;
    }
    if (resultsByKey.analytics !== undefined) {
      rawAnalytics = resultsByKey.analytics;
    }
    if (resultsByKey.profile && typeof resultsByKey.profile === "object") {
      const activeId = document.activeElement?.id || "";
      if (activeId !== "onboarding-call-me") {
        OnboardingState.callMe = String(resultsByKey.profile.call_me || "");
      }
      OnboardingState.profileLoaded = true;
    }

    try {
      const memResp = await Transport.request("GET", "/api/memory");
      const memRows = Array.isArray(memResp)
        ? memResp
        : Array.isArray(memResp?.memories)
          ? memResp.memories
          : null;
      if (memRows) {
        HistorySettingsState.memoryLive = true;
        HistorySettingsState.memoryError = "";
        HistorySettingsState.liveMemories = memRows.map((m, idx) => ({
          id: String(m.id ?? `mem-${idx}`),
          key: m.key || (m.run ? `Memory · ${m.run}` : "Saved memory"),
          value: String(m.text ?? m.value ?? ""),
          source: m.run ? `Run ${m.run}` : (m.source || "Backend memory"),
          updated: m.ts
            ? new Date(m.ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
            : (m.updated || "Saved"),
        }));
      }
    } catch {
      HistorySettingsState.memoryLive = false;
    }

    if (wsState?.status === "partial") {
      failedEndpoints = Array.isArray(wsState.failedEndpoints) ? wsState.failedEndpoints : nextFailed;
      succeededEndpoints = Array.isArray(wsState.succeededEndpoints) ? wsState.succeededEndpoints : nextSucceeded;
      connectionStatus = "connected";
      lastSuccessfulRefreshAt = Date.now();
    } else if (wsState?.status === "stale") {
      failedEndpoints = [];
      succeededEndpoints = nextSucceeded;
      connectionStatus = "stale";
      lastSuccessfulRefreshAt = Date.now() - (Number(wsState.staleAgeSeconds) || 45) * 1000;
    } else {
      failedEndpoints = nextFailed;
      succeededEndpoints = nextSucceeded;
      connectionStatus = "connected";
      lastSuccessfulRefreshAt = Date.now();
    }

    hasLoadedOnce = true;
    connectionError = "";
    renderNow();
  }

  /* ============================================================================
     9. EVENT LISTENERS & BOOTSTRAP
     ============================================================================ */
  function setupEventListeners() {
    const promptForm = document.getElementById("prompt-form");
    const promptInput = document.getElementById("prompt-input");
    const promptFieldWrap = document.getElementById("prompt-field-wrap");
    const attachBtn = document.getElementById("attach-btn");
    const attachMenu = document.getElementById("attach-menu");
    const fileInput = document.getElementById("file-input");
    const linkInputRow = document.getElementById("link-input-row");
    const linkInput = document.getElementById("link-input");
    const linkAddBtn = document.getElementById("link-add-btn");
    const linkCancelBtn = document.getElementById("link-cancel-btn");
    const attachmentsList = document.getElementById("attachments-list");

    function syncPromptFieldState() {
      if (!promptInput || !promptFieldWrap) return;
      promptFieldWrap.classList.toggle("has-text", promptInput.value.length > 0);
      promptInput.style.height = "20px";
      promptInput.style.height = `${Math.min(80, Math.max(20, promptInput.scrollHeight))}px`;
    }

    function renderAttachments() {
      if (!attachmentsList) return;
      if (!attachments.length) {
        attachmentsList.innerHTML = "";
        return;
      }
      attachmentsList.innerHTML = attachments
        .map(
          (att, idx) => `
            <span class="attachment-token">
              <span class="attachment-name" title="${escapeHtml(att.name)}">${escapeHtml(att.name)}</span>
              <button type="button" class="attachment-remove" data-remove-idx="${idx}" aria-label="Remove ${escapeHtml(att.name)}">&times;</button>
            </span>
          `
        )
        .join("");
    }

    function addAttachments(items) {
      for (const item of items) {
        if (!item || !item.name) continue;
        if (!attachments.some((a) => a.id === item.id)) {
          attachments.push(item);
        }
      }
      renderAttachments();
    }

    if (promptInput) {
      promptInput.addEventListener("input", syncPromptFieldState);
      attachImeSafeEnter(promptInput, () => {
        promptForm?.requestSubmit();
      });
    }

    if (promptForm) {
      promptForm.addEventListener("submit", (e) => {
        e.preventDefault();
        const text = promptInput?.value.trim() || "";
        if (!text) return;
        const currentAttachments = [...attachments];
        promptInput.value = "";
        attachments = [];
        renderAttachments();
        syncPromptFieldState();
        submitTask(text, currentAttachments);
      });
    }

    if (attachBtn && attachMenu) {
      attachBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const willOpen = !attachMenu.classList.contains("open");
        attachMenu.classList.toggle("open", willOpen);
        attachBtn.setAttribute("aria-expanded", willOpen ? "true" : "false");
      });

      document.addEventListener("click", (e) => {
        if (!attachMenu.contains(e.target) && e.target !== attachBtn) {
          attachMenu.classList.remove("open");
          attachBtn.setAttribute("aria-expanded", "false");
        }
      });

      attachMenu.addEventListener("click", async (e) => {
        const item = e.target.closest("[data-attach-kind]");
        if (!item) return;
        const kind = item.dataset.attachKind;
        attachMenu.classList.remove("open");
        attachBtn.setAttribute("aria-expanded", "false");

        if (kind === "link") {
          linkInputRow?.classList.remove("hidden");
          requestAnimationFrame(() => linkInput?.focus());
          return;
        }

        if (hasShellBridge()) {
          const picked = await Transport.pickFiles(kind);
          if (picked && picked.length) {
            addAttachments(
              picked.map((f) => ({
                id: `${f.path}-${f.name}`,
                name: f.name,
                kind: "file",
                path: f.path,
              }))
            );
          }
          return;
        }

        if (fileInput) {
          if (kind === "photo") fileInput.setAttribute("accept", "image/*");
          else if (kind === "video") fileInput.setAttribute("accept", "video/*");
          else fileInput.removeAttribute("accept");
          fileInput.click();
        }
      });
    }

    if (fileInput) {
      fileInput.addEventListener("change", () => {
        const files = Array.from(fileInput.files || []);
        addAttachments(
          files.map((f) => ({
            id: `file-${f.name}-${f.size}`,
            name: f.name,
            kind: "file",
            file: f,
          }))
        );
        fileInput.value = "";
      });
    }

    if (linkAddBtn && linkInput && linkInputRow) {
      linkAddBtn.addEventListener("click", () => {
        const val = linkInput.value.trim();
        if (val) {
          addAttachments([{ id: `link-${val}`, name: val, kind: "link", url: val }]);
        }
        linkInput.value = "";
        linkInputRow.classList.add("hidden");
      });
      attachImeSafeEnter(linkInput, () => linkAddBtn.click());
    }

    if (linkCancelBtn && linkInput && linkInputRow) {
      linkCancelBtn.addEventListener("click", () => {
        linkInput.value = "";
        linkInputRow.classList.add("hidden");
      });
    }

    if (attachmentsList) {
      attachmentsList.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-remove-idx]");
        if (!btn) return;
        const idx = Number(btn.dataset.removeIdx);
        if (!Number.isNaN(idx)) {
          attachments.splice(idx, 1);
          renderAttachments();
        }
      });
    }

    /* Delegated clicks across navigation & all 5 views */
    document.addEventListener("click", async (e) => {
      const tabBtn = e.target.closest("[data-view-tab]");
      if (tabBtn) {
        setView(tabBtn.dataset.viewTab);
        return;
      }

      const actionEl = e.target.closest("[data-action]");
      if (!actionEl) return;
      const action = actionEl.dataset.action;

      switch (action) {
        case "switch-view":
          setView(actionEl.dataset.targetView || "graph");
          break;

        case "connect-backend":
          await handleConnectSubmit();
          break;

        case "retry-poll":
          await pollAll();
          break;

        case "focus-prompt": {
          const promptEl = document.getElementById("prompt-input");
          if (promptEl) {
            promptEl.focus();
            promptEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
          }
          break;
        }

        case "load-fixture":
          if (actionEl.dataset.fixture) {
            await switchFixture(actionEl.dataset.fixture);
          }
          break;

        case "select-task-run":
          selectedTaskRunId = actionEl.dataset.runId || null;
          selectedAgentNodeId = selectedTaskRunId;
          renderNow();
          break;

        case "select-agent-node": {
          selectedAgentNodeId = actionEl.dataset.nodeRunId || null;
          const agName = actionEl.dataset.agentName || "";
          const isParent = actionEl.dataset.parentNode === "1";
          /* Selecting an agent in B1 filters B1b state machine graph to that agent */
          smAgentFilter = isParent ? "" : agName;
          renderNow();
          break;
        }

        case "filter-sm-by-agent":
          smAgentFilter = actionEl.dataset.agentName || "";
          setView("state-machine");
          await pollAll();
          break;

        case "set-sm-agent":
          smAgentFilter = actionEl.dataset.agent || "";
          await pollAll();
          break;

        case "set-sm-app":
          selectedAppFilter = actionEl.dataset.app || "all";
          renderNow();
          break;

        case "clear-sm-filters":
          smAgentFilter = "";
          selectedAppFilter = "all";
          selectedSmEdgeId = null;
          await pollAll();
          break;

        case "select-sm-edge":
          selectedSmEdgeId =
            selectedSmEdgeId === actionEl.dataset.edgeId ? null : actionEl.dataset.edgeId || null;
          renderNow();
          break;

        case "close-sm-edge":
          selectedSmEdgeId = null;
          renderNow();
          break;

        case "replay-prev":
          if (replayStepIndex > 0) {
            replayStepIndex -= 1;
            renderNow();
          }
          break;

        case "replay-next":
          replayStepIndex += 1;
          renderNow();
          break;

        case "set-log-status":
          logStatusFilter = actionEl.dataset.status || "all";
          renderNow();
          break;

        case "clear-log-filters":
          logSearchQuery = "";
          searchedTranscriptRows = null;
          logStatusFilter = "all";
          renderNow();
          break;

        case "toggle-transcript-run": {
          const rid = actionEl.dataset.runId;
          if (rid) {
            if (expandedTranscriptRunIds.has(rid)) {
              expandedTranscriptRunIds.delete(rid);
              renderNow();
            } else {
              expandedTranscriptRunIds.add(rid);
              renderNow();
              await fetchRunTranscript(rid);
            }
          }
          break;
        }

        case "open-run-in-graph":
          selectedTaskRunId = actionEl.dataset.runId || null;
          selectedAgentNodeId = selectedTaskRunId;
          setView("graph");
          break;

        case "answer-help": {
          const hid = actionEl.dataset.helpId;
          const choice = actionEl.dataset.choice;
          if (hid && choice) {
            actionEl.disabled = true;
            try {
              await Transport.request("POST", `/api/help/${encodeURIComponent(hid)}`, {
                jsonBody: { choice },
              });
              await pollAll();
            } catch (err) {
              sendErrorText = err.message || "Could not submit approval response";
              renderNow();
            }
          }
          break;
        }

        case "save-onboarding-profile": {
          OnboardingState.profileSaveStatus = "";
          OnboardingState.profileSaveError = "";
          if (!Transport.isConnected()) {
            OnboardingState.profileSaveError = "Not connected to backend";
            renderNow();
            break;
          }
          try {
            await Transport.request("POST", "/api/profile", {
              jsonBody: { call_me: OnboardingState.callMe },
            });
            OnboardingState.profileSaveStatus = "✓ Saved";
            OnboardingState.profileLoaded = true;
          } catch (err) {
            OnboardingState.profileSaveError = err.message || "Could not save name";
          }
          renderNow();
          break;
        }

        case "select-onboarding-swatch": {
          const idx = Number(actionEl.dataset.swatchIdx);
          if (!Number.isNaN(idx) && idx >= 0 && idx < AGENT_SWATCHES.length) {
            OnboardingState.swatchIndex = idx;
            savePrimaryAgentChoice();
            renderNow();
          }
          break;
        }

        case "goto-onboarding-step": {
          const targetStep = Number(actionEl.dataset.step);
          if (!Number.isNaN(targetStep) && targetStep >= 1 && targetStep <= OnboardingState.totalSteps) {
            if (
              OnboardingState.step === 4 &&
              targetStep > 4 &&
              !(
                OnboardingState.permissions.accessibility &&
                OnboardingState.permissions.screen_recording &&
                OnboardingState.permissions.app_scripting
              )
            ) {
              break;
            }
            OnboardingState.step = targetStep;
            renderNow();
          }
          break;
        }

        case "prev-onboarding-step":
          if (OnboardingState.step > 1) {
            OnboardingState.step -= 1;
            renderNow();
          }
          break;

        case "next-onboarding-step":
        case "skip-onboarding-step":
          if (action === "skip-onboarding-step" && OnboardingState.step === 4) {
            break;
          }
          if (OnboardingState.step < OnboardingState.totalSteps) {
            OnboardingState.step += 1;
            renderNow();
          }
          break;

        case "select-onboarding-voice":
          OnboardingState.voiceId = actionEl.dataset.voiceId || "2X7h8q4r8pMNZ7zRmpiF";
          renderNow();
          break;

        case "preview-onboarding-voice": {
          const vid = actionEl.dataset.voiceId || "2X7h8q4r8pMNZ7zRmpiF";
          const voiceObj = ONBOARDING_VOICES.find((v) => v.id === vid) || ONBOARDING_VOICES[0];
          OnboardingState.voicePreviewStatus = `Playing 3-second sample for ${voiceObj.name}…`;
          renderNow();
          if (typeof window !== "undefined" && window.speechSynthesis && typeof window.SpeechSynthesisUtterance === "function") {
            try {
              window.speechSynthesis.cancel();
              const utt = new window.SpeechSynthesisUtterance(`Hello, I am ${voiceObj.name}, ready to help.`);
              window.speechSynthesis.speak(utt);
            } catch {
              // Ignore speech synthesis errors in headless/restricted environments
            }
          }
          setTimeout(() => {
            OnboardingState.voicePreviewStatus = `Finished 3-second sample for ${voiceObj.name}.`;
            if (currentView === "onboarding") renderNow();
          }, 3000);
          break;
        }

        case "toggle-a11y": {
          const key = actionEl.dataset.a11yKey;
          if (key === "reduce_motion" || key === "high_contrast") {
            OnboardingState.a11y[key] = !OnboardingState.a11y[key];
            renderNow();
          }
          break;
        }

        case "toggle-sample-perm": {
          const pKey = actionEl.dataset.permKey;
          if (pKey && Object.prototype.hasOwnProperty.call(OnboardingState.permissions, pKey)) {
            OnboardingState.permissions[pKey] = !OnboardingState.permissions[pKey];
            renderNow();
          }
          break;
        }

        case "set-stage-display": {
          const disp = actionEl.dataset.display;
          if (disp === "secondary" || disp === "primary" || disp === "ask") {
            OnboardingState.stageDisplay = disp;
            renderNow();
          }
          break;
        }

        case "add-blocked-app": {
          const name = (OnboardingState.customBlockedApp || "").trim();
          if (name && !OnboardingState.blockedApps.includes(name)) {
            OnboardingState.blockedApps.push(name);
            OnboardingState.customBlockedApp = "";
            renderNow();
          }
          break;
        }

        case "remove-blocked-app": {
          const appName = actionEl.dataset.app;
          if (appName && !["Banking", "Passwords", "Health"].includes(appName)) {
            OnboardingState.blockedApps = OnboardingState.blockedApps.filter((a) => a !== appName);
            renderNow();
          }
          break;
        }

        case "set-onboarding-memory":
          OnboardingState.memoryEnabled = actionEl.dataset.enabled === "1";
          OnboardingState.memoryStatusNote = OnboardingState.memoryEnabled
            ? "Memory enabled for this session."
            : "Memory paused for this session.";
          renderNow();
          break;

        case "forget-onboarding-memory":
          OnboardingState.userName = "";
          OnboardingState.callMe = "";
          OnboardingState.pronounce = "";
          OnboardingState.memoryStatusNote = "Cleared session memory preferences.";
          renderNow();
          break;

        case "fill-starter-prompt": {
          const text = actionEl.dataset.prompt || "";
          if (promptInput && text) {
            promptInput.value = text;
            syncPromptFieldState();
            promptInput.focus();
          }
          break;
        }

        case "send-starter-prompt": {
          const text = actionEl.dataset.prompt || "";
          if (text) {
            submitTask(text, []);
          }
          break;
        }

        case "set-history-outcome":
          HistorySettingsState.outcomeFilter = actionEl.dataset.outcome || "all";
          renderNow();
          break;

        case "edit-memory": {
          const mid = actionEl.dataset.memoryId;
          const mem = HistorySettingsState.memories.find((m) => m.id === mid);
          if (mem) {
            HistorySettingsState.confirmForgetId = null;
            HistorySettingsState.editingMemoryId = mid;
            HistorySettingsState.editingMemoryDraft = mem.value;
            renderNow();
            requestAnimationFrame(() => {
              document.querySelector(`[data-memory-edit-input="${mid}"]`)?.focus();
            });
          }
          break;
        }

        case "save-memory": {
          const mid = actionEl.dataset.memoryId;
          const mem = HistorySettingsState.memories.find((m) => m.id === mid);
          const clean = HistorySettingsState.editingMemoryDraft.trim();
          if (mem && clean) {
            mem.value = clean;
            mem.updated = "Just now";
          }
          HistorySettingsState.editingMemoryId = null;
          HistorySettingsState.editingMemoryDraft = "";
          renderNow();
          break;
        }

        case "cancel-edit-memory": {
          const mid = actionEl.dataset.memoryId;
          HistorySettingsState.editingMemoryId = null;
          HistorySettingsState.editingMemoryDraft = "";
          renderNow();
          if (mid) {
            requestAnimationFrame(() => {
              document.querySelector(`[data-action="edit-memory"][data-memory-id="${mid}"]`)?.focus();
            });
          }
          break;
        }

        case "forget-memory": {
          const mid = actionEl.dataset.memoryId;
          if (mid) {
            HistorySettingsState.editingMemoryId = null;
            HistorySettingsState.confirmForgetId = mid;
            renderNow();
            requestAnimationFrame(() => {
              document.querySelector(`[data-action="cancel-forget-memory"][data-memory-id="${mid}"]`)?.focus();
            });
          }
          break;
        }

        case "toggle-artifact-row": {
          const aid = actionEl.dataset.artifactId;
          if (aid) {
            if (expandedArtifactIds.has(aid)) {
              expandedArtifactIds.delete(aid);
            } else {
              expandedArtifactIds.add(aid);
            }
            renderNow();
          }
          break;
        }

        case "confirm-forget-memory": {
          const mid = actionEl.dataset.memoryId;
          if (mid) {
            if (HistorySettingsState.memoryLive) {
              try {
                await Transport.request("DELETE", `/api/memory/${encodeURIComponent(mid)}`);
                HistorySettingsState.liveMemories = HistorySettingsState.liveMemories.filter((m) => m.id !== mid);
                HistorySettingsState.memoryError = "";
              } catch (err) {
                HistorySettingsState.memoryError = err.message || "Could not delete memory";
              }
            } else {
              HistorySettingsState.memories = HistorySettingsState.memories.filter((m) => m.id !== mid);
            }
            HistorySettingsState.confirmForgetId = null;
            renderNow();
          }
          break;
        }

        case "cancel-forget-memory": {
          const mid = actionEl.dataset.memoryId;
          HistorySettingsState.confirmForgetId = null;
          renderNow();
          if (mid) {
            requestAnimationFrame(() => {
              document.querySelector(`[data-action="forget-memory"][data-memory-id="${mid}"]`)?.focus();
            });
          }
          break;
        }

        case "set-app-perm": {
          const appName = actionEl.dataset.app;
          const mode = actionEl.dataset.mode;
          const perm = HistorySettingsState.appPermissions.find((p) => p.app === appName);
          if (perm && (mode === "ask" || mode === "allow")) {
            perm.standard = mode;
            renderNow();
          }
          break;
        }

        case "save-daily-cap": {
          const val = parseFloat(HistorySettingsState.dailyCapDraft);
          if (!Number.isNaN(val) && val > 0) {
            HistorySettingsState.dailyCapUsd = val;
            HistorySettingsState.dailyCapDraft = val.toFixed(2);
            HistorySettingsState.dailyCapSavedNote = `Daily cap set to $${val.toFixed(2)} for this session.`;
            renderNow();
          }
          break;
        }

        default:
          break;
      }
    });

    document.addEventListener("change", (e) => {
      const target = e.target;
      if (target && target.matches('[data-action="select-replay-run"]')) {
        replayRunId = target.value || null;
        replayStepIndex = 0;
        renderNow();
      } else if (target && target.matches('[data-action="set-a11y-select"]')) {
        const key = target.dataset.a11yKey;
        if (key === "cursor_scale") {
          OnboardingState.a11y.cursor_scale = Number(target.value) || 1.0;
        } else if (key === "text_size" || key === "cursor_palette") {
          OnboardingState.a11y[key] = target.value;
        }
        renderNow();
      } else if (target && target.matches('[data-action="set-history-cost"]')) {
        HistorySettingsState.costFilter = target.value || "all";
        renderNow();
      }
    });

    window.addEventListener("resize", () => {
      if (currentView === "graph") {
        requestAnimationFrame(drawB1ParentChildEdges);
      }
    });

    window.addEventListener("hashchange", () => {
      const hashView = window.location.hash.replace(/^#/, "");
      if (hashView) {
        setView(hashView);
      }
    });

    /* Keyboard accessibility:
       - ArrowLeft / ArrowRight / Home / End on view tabs
       - Enter / Space on SVG .sm-edge-group controls
       - Escape closes the innermost open menu, inline form, confirmation, or detail */
    document.addEventListener("keydown", (e) => {
      const target = e.target;

      if (target && target.matches && target.matches('[role="tab"][data-view-tab]')) {
        const tabs = Array.from(document.querySelectorAll('[role="tab"][data-view-tab]'));
        const idx = tabs.indexOf(target);
        if (idx !== -1 && (e.key === "ArrowRight" || e.key === "ArrowLeft" || e.key === "Home" || e.key === "End")) {
          e.preventDefault();
          let nextIdx = idx;
          if (e.key === "ArrowRight") nextIdx = (idx + 1) % tabs.length;
          else if (e.key === "ArrowLeft") nextIdx = (idx - 1 + tabs.length) % tabs.length;
          else if (e.key === "Home") nextIdx = 0;
          else if (e.key === "End") nextIdx = tabs.length - 1;
          const nextTab = tabs[nextIdx];
          if (nextTab) {
            setView(nextTab.dataset.viewTab);
            nextTab.focus();
          }
          return;
        }
      }

      if (target && target.matches && target.matches('.sm-edge-group[data-action="select-sm-edge"]')) {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          const edgeId = target.dataset.edgeId || null;
          selectedSmEdgeId = selectedSmEdgeId === edgeId ? null : edgeId;
          renderNow();
          return;
        }
      }

      if (e.key !== "Escape") return;

      if (attachMenu && attachMenu.classList.contains("open")) {
        e.preventDefault();
        attachMenu.classList.remove("open");
        attachBtn?.setAttribute("aria-expanded", "false");
        attachBtn?.focus();
        return;
      }

      if (linkInputRow && !linkInputRow.classList.contains("hidden")) {
        e.preventDefault();
        if (linkInput) linkInput.value = "";
        linkInputRow.classList.add("hidden");
        attachBtn?.focus();
        return;
      }

      if (currentView === "history-settings" && HistorySettingsState.confirmForgetId) {
        e.preventDefault();
        const mid = HistorySettingsState.confirmForgetId;
        HistorySettingsState.confirmForgetId = null;
        renderNow();
        requestAnimationFrame(() => {
          document.querySelector(`[data-action="forget-memory"][data-memory-id="${mid}"]`)?.focus();
        });
        return;
      }

      if (currentView === "history-settings" && HistorySettingsState.editingMemoryId) {
        e.preventDefault();
        const mid = HistorySettingsState.editingMemoryId;
        HistorySettingsState.editingMemoryId = null;
        HistorySettingsState.editingMemoryDraft = "";
        renderNow();
        requestAnimationFrame(() => {
          document.querySelector(`[data-action="edit-memory"][data-memory-id="${mid}"]`)?.focus();
        });
        return;
      }

      if (currentView === "state-machine" && selectedSmEdgeId) {
        e.preventDefault();
        const prevEdge = selectedSmEdgeId;
        selectedSmEdgeId = null;
        renderNow();
        requestAnimationFrame(() => {
          document.querySelector(`.sm-edge-group[data-edge-id="${prevEdge}"]`)?.focus();
        });
        return;
      }

      if (currentView === "logs" && expandedTranscriptRunIds.size > 0) {
        e.preventDefault();
        const ids = Array.from(expandedTranscriptRunIds);
        const lastId = ids[ids.length - 1];
        expandedTranscriptRunIds.delete(lastId);
        renderNow();
        requestAnimationFrame(() => {
          document.querySelector(`[data-action="toggle-transcript-run"][data-run-id="${lastId}"]`)?.focus();
        });
      }
    });
  }

  async function boot() {
    setupEventListeners();
    renderNow();
    try {
      const state = await Transport.init();
      isSampleData = state.isSampleData;
      if (state.connected) {
        await pollAll();
      } else {
        connectionStatus = "disconnected";
        renderNow();
      }
    } catch (err) {
      connectionStatus = "disconnected";
      connectionError = err.message || "Could not initialize workspace";
      renderNow();
    }
    setInterval(pollAll, 1500);
  }

  boot();
})();
