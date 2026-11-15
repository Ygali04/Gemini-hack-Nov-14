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
      if (msg.type === "primaryAgentUpdated") {
        const nextAlias = typeof msg.alias === "string" ? msg.alias : "";
        const nextSwatchKey = typeof msg.swatch === "string" ? msg.swatch : msg.swatch?.key;
        const activeId = document.activeElement?.id || "";
        const editingAlias = activeId === "settings-agent-name" || activeId === "onboarding-agent-name";
        const aliasEchoOnly = editingAlias && nextAlias === String(OnboardingState.agentName || "").trim();
        if (!aliasEchoOnly) {
          OnboardingState.agentName = nextAlias;
        }
        if (nextSwatchKey) {
          const idx = AGENT_SWATCHES.findIndex((s) => s.key === nextSwatchKey);
          if (idx >= 0) OnboardingState.swatchIndex = idx;
        }
        try {
          if (typeof localStorage !== "undefined") {
            localStorage.setItem(
              PRIMARY_AGENT_STORAGE_KEY,
              JSON.stringify({ alias: OnboardingState.agentName, swatch: getPrimaryAgentSwatch().key })
            );
          }
        } catch {
          // Ignore storage errors
        }
        if (!aliasEchoOnly && typeof renderNow === "function") renderNow();
      }
      if (msg.type === "setView" && typeof msg.view === "string" && msg.view.trim()) {
        if (typeof handleShellSetView === "function") {
          handleShellSetView(msg.view);
        }
      }
      window.dispatchEvent(new CustomEvent("shell-event", { detail: msg }));
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
        return { ok: false, error: "Paste the address ComputerAnything printed" };
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
      if (!safe) throw new Error("Invalid sample name");
      let rawText = "";
      if (hasShellBridge()) {
        const res = await callShell("readFixture", { name: safe });
        if (!res || !res.ok) throw new Error(`Sample "${safe}" not found`);
        rawText = res.body || "";
      } else {
        const res = await fetch(`./fixtures/${safe}.json`, { cache: "no-store" });
        if (!res.ok) throw new Error(`Sample "${safe}" not found`);
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
        transcripts: Array.isArray(parsed.transcripts)
          ? parsed.transcripts
          : parsed.transcripts && typeof parsed.transcripts === "object"
            ? Object.values(parsed.transcripts).flat().filter(Boolean)
            : [],
        actions: actionList,
        graph: parsed.graph && typeof parsed.graph === "object" ? parsed.graph : null,
        analytics: parsed.analytics && typeof parsed.analytics === "object" ? parsed.analytics : null,
        costs: parsed.costs && typeof parsed.costs === "object" ? parsed.costs : {},
        profile: {
          call_me: String(parsed.profile?.call_me || ""),
          voice_id: String(parsed.profile?.voice_id || ""),
          model: String(parsed.profile?.model || ""),
          decide_model: String(parsed.profile?.decide_model || ""),
          agent_name: String(parsed.profile?.agent_name || ""),
        },
        supportsStop: parsed.supportsStop !== false,
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
          if (options.thread) payload.thread = options.thread;
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

    function collectFixtureSubtreeIds(rootRunId) {
      const ids = [];
      const seen = new Set();
      const queue = [rootRunId];
      while (queue.length) {
        const cur = queue.shift();
        if (!cur || seen.has(cur)) continue;
        seen.add(cur);
        ids.push(cur);
        for (const r of fixtureState.runs || []) {
          if (r && r.parent === cur && !seen.has(r.id)) {
            queue.push(r.id);
          }
        }
      }
      return ids;
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
        const runObj = (fixtureState.runs || []).find((r) => r.id === runId);
        const detailObj = fixtureState.details?.[runId];
        const entry =
          fixtureState.costs[runId] ||
          runObj?.result?.digest?.task_cost ||
          detailObj?.result?.digest?.task_cost || {
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
        const subtreeIds = new Set(collectFixtureSubtreeIds(runId));
        const rows = (fixtureState.transcripts || []).filter((t) => subtreeIds.has(t.run));
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
        const analyticsFailed = Boolean(
          fixtureState.workspaceState?.failedEndpoints?.some((e) => e && e.key === "analytics")
        );
        const taskRuns = (fixtureState.runs || []).filter((r) => !r.parent || r.role === "orchestrator");
        const taskCosts = taskRuns
          .map((r) => fixtureState.costs?.[r.id] || r.result?.digest?.task_cost || fixtureState.details?.[r.id]?.result?.digest?.task_cost)
          .filter(Boolean);
        if (!analyticsFailed && taskCosts.length > 0) {
          const totalCost = Number(taskCosts.reduce((s, c) => s + Number(c.cost_usd || 0), 0).toFixed(6));
          const totalCalls = taskCosts.reduce((s, c) => s + Number(c.llm_calls || 0), 0);
          return {
            tasks: taskRuns.length,
            cost_usd: totalCost,
            llm_calls: totalCalls,
            mean_cost_per_task: taskRuns.length ? Number((totalCost / taskRuns.length).toFixed(6)) : null,
            by_role: [],
            by_purpose: [],
            by_app: [],
          };
        }
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
        const p = fixtureState.profile || {};
        return {
          call_me: String(p.call_me || ""),
          voice_id: String(p.voice_id || ""),
          model: String(p.model || ""),
          decide_model: String(p.decide_model || ""),
          agent_name: String(p.agent_name || ""),
        };
      }
      if (method === "POST" && cleanPath === "/api/profile") {
        const updates = options.jsonBody || {};
        const allowedKeys = ["call_me", "voice_id", "model", "decide_model", "agent_name"];
        const badKeys = Object.keys(updates).filter((k) => !allowedKeys.includes(k));
        if (badKeys.length) {
          throw Object.assign(new Error(`unknown setting(s): ${badKeys.join(", ")}`), { status: 400, code: "HTTP" });
        }
        const nextProfile = { ...(fixtureState.profile || {}) };
        for (const k of allowedKeys) {
          if (k in updates) {
            const val = String(updates[k] ?? "").trim();
            if (val.length > 200 || /[\r\n]/.test(val)) {
              throw Object.assign(new Error(`${k}: one line, at most 200 characters`), { status: 400, code: "HTTP" });
            }
            nextProfile[k] = val;
          }
        }
        fixtureState.profile = {
          call_me: String(nextProfile.call_me || ""),
          voice_id: String(nextProfile.voice_id || ""),
          model: String(nextProfile.model || ""),
          decide_model: String(nextProfile.decide_model || ""),
          agent_name: String(nextProfile.agent_name || ""),
        };
        return JSON.parse(JSON.stringify(fixtureState.profile));
      }
      if (method === "POST" && cleanPath.startsWith("/api/runs/") && cleanPath.endsWith("/stop")) {
        if (!fixtureState.supportsStop) {
          throw Object.assign(new Error("not found"), { status: 404, code: "HTTP" });
        }
        const rid = decodeURIComponent(cleanPath.slice("/api/runs/".length, -"/stop".length));
        const target = fixtureState.runs.find((r) => r.id === rid);
        if (!target) {
          throw Object.assign(new Error("no such run"), { status: 404, code: "HTTP" });
        }
        const toStop = fixtureState.runs.filter(
          (r) => r.id === rid || (r.parent === rid && r.role !== "orchestrator")
        );
        for (const r of toStop) {
          if (r.state !== "done" && r.state !== "failed") {
            r.state = "failed";
            r.result = { ok: false, summary: "Stopped by you" };
            const d = fixtureState.details[r.id];
            if (d) {
              d.state = "failed";
              d.result = { ok: false, summary: "Stopped by you" };
              d.events = Array.isArray(d.events) ? d.events : [];
              d.events.push({
                t: Number(((d.elapsed || 0) + 0.1).toFixed(1)),
                kind: "result",
                ok: false,
                summary: "Stopped by you",
              });
              d.n_events = d.events.length;
            }
          }
        }
        return { ok: true };
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
          const siblings = fixtureState.runs.filter((r) => r.parent === parentId && r.role !== "orchestrator");
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
          meta: {
            attachments: options.attachedNames || [],
            ...(options.thread ? { thread: options.thread } : {}),
          },
        });
        return { run: newId, ...(options.thread ? { thread: options.thread } : {}) };
      }
      throw new Error(`Unsupported path in sample data: ${cleanPath}`);
    }

    async function pickFiles(kind) {
      if (!hasShellBridge()) return null;
      const res = await callShell("pickFiles", { kind });
      return Array.isArray(res?.files) ? res.files : [];
    }

    async function openSettingsPane(pane) {
      if (!hasShellBridge()) return { ok: false, error: "Shell unavailable" };
      try {
        return await callShell("openSettingsPane", { pane: String(pane || "").trim() });
      } catch (err) {
        return { ok: false, error: err?.message || "Could not open System Settings" };
      }
    }

    async function getPermissions() {
      if (!hasShellBridge()) return null;
      try {
        const res = await callShell("getPermissions", {});
        return res?.permissions && typeof res.permissions === "object" ? res.permissions : null;
      } catch {
        return null;
      }
    }

    async function listVoices() {
      if (!hasShellBridge()) return null;
      try {
        const res = await callShell("listVoices", {});
        return Array.isArray(res?.voices) ? res.voices : null;
      } catch {
        return null;
      }
    }

    function postPrimaryAgentUpdated(alias, swatch) {
      if (!hasShellBridge()) return;
      try {
        window.webkit.messageHandlers.shell.postMessage({
          type: "primaryAgentUpdated",
          alias: alias || null,
          swatch: swatch || null,
        });
      } catch {
        // Ignore shell bridge errors
      }
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
      openSettingsPane,
      getPermissions,
      listVoices,
      postPrimaryAgentUpdated,
      getSampleLabel,
      getFixtureWorkspaceState: () => fixtureState?.workspaceState || null,
    };
  })();

  /* ============================================================================
     2. ONBOARDING & APPROVAL RULES IN-PAGE STATE (Section 1B - B4)
     ============================================================================ */
  const OnboardingState = {
    step: 1,
    totalSteps: 8,
    userName: "",
    callMe: "",
    pronounce: "",
    profileLoaded: false,
    profileSaveStatus: "",
    profileSaveError: "",
    agentName: "Mercury",
    swatchIndex: 0,
    voiceId: "",
    voicePreviewStatus: "",
    a11y: (() => {
      const defaults = {
        text_size: "default",
        reduce_motion:
          typeof window !== "undefined" &&
          typeof window.matchMedia === "function" &&
          window.matchMedia("(prefers-reduced-motion: reduce)").matches,
        high_contrast:
          typeof window !== "undefined" &&
          typeof window.matchMedia === "function" &&
          window.matchMedia("(prefers-contrast: more)").matches,
      };
      try {
        const raw = typeof localStorage !== "undefined" ? localStorage.getItem("ca.a11y") : null;
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === "object") {
            if (["default", "large", "extra_large"].includes(parsed.text_size)) {
              defaults.text_size = parsed.text_size;
            }
            if (typeof parsed.reduce_motion === "boolean") {
              defaults.reduce_motion = parsed.reduce_motion;
            }
            if (typeof parsed.high_contrast === "boolean") {
              defaults.high_contrast = parsed.high_contrast;
            }
          }
        }
      } catch {
        // Ignore invalid ca.a11y storage
      }
      return defaults;
    })(),
    permissions: {
      accessibility: false,
      screen_recording: false,
      app_scripting: false,
    },
    stageDisplay: "secondary",
    memoryEnabled: true,
    confirmForgetOnboardingMemory: false,
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
  const ONBOARDING_SEEN_STORAGE_KEY = "ca.onboardingSeen";
  const A11Y_STORAGE_KEY = "ca.a11y";
  let autoOnboardingChecked = false;

  function applyA11ySettings(a11y) {
    if (typeof document === "undefined" || !document.documentElement) return;
    const root = document.documentElement;
    const textSize = ["default", "large", "extra_large"].includes(a11y?.text_size)
      ? a11y.text_size
      : "default";
    root.dataset.a11yTextSize = textSize;
    root.dataset.a11yHighContrast = a11y?.high_contrast ? "true" : "false";
    root.dataset.a11yReduceMotion = a11y?.reduce_motion ? "true" : "false";
  }

  function saveAndApplyA11ySettings() {
    applyA11ySettings(OnboardingState.a11y);
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(
          A11Y_STORAGE_KEY,
          JSON.stringify({
            text_size: OnboardingState.a11y.text_size,
            reduce_motion: Boolean(OnboardingState.a11y.reduce_motion),
            high_contrast: Boolean(OnboardingState.a11y.high_contrast),
          })
        );
      }
    } catch {
      // Ignore storage errors
    }
  }

  applyA11ySettings(OnboardingState.a11y);

  function hasSeenOnboarding() {
    try {
      return typeof localStorage !== "undefined" && localStorage.getItem(ONBOARDING_SEEN_STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  }

  function markOnboardingSeen() {
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(ONBOARDING_SEEN_STORAGE_KEY, "1");
      }
    } catch {
      // Ignore storage errors
    }
  }

  function hasSavedPrimaryAgent() {
    try {
      if (typeof localStorage === "undefined") return false;
      const raw = localStorage.getItem(PRIMARY_AGENT_STORAGE_KEY);
      if (!raw) return false;
      const parsed = JSON.parse(raw);
      return Boolean(parsed && typeof parsed === "object" && String(parsed.alias || parsed.name || "").trim());
    } catch {
      return false;
    }
  }

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
        const savedAlias = typeof parsed.alias === "string"
          ? parsed.alias
          : typeof parsed.name === "string"
            ? parsed.name
            : null;
        if (savedAlias !== null) {
          OnboardingState.agentName = savedAlias;
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

  let appliedInitialProfileAgentName = false;
  let lastSyncedProfileAgentName = null;

  function syncAgentNameToProfile(rawName) {
    const clean = String(rawName || "").trim();
    if (!Transport.isConnected()) return;
    if (lastSyncedProfileAgentName === clean) return;
    lastSyncedProfileAgentName = clean;
    Transport.request("POST", "/api/profile", { jsonBody: { agent_name: clean } })
      .then((saved) => {
        const savedName = String(saved?.agent_name ?? clean);
        if (typeof HistorySettingsState !== "undefined" && HistorySettingsState?.profile) {
          HistorySettingsState.profile.agent_name = savedName;
          HistorySettingsState.profileDraft.agent_name = savedName;
        }
      })
      .catch(() => {
        // Ignore profile sync errors quietly
      });
  }

  function savePrimaryAgentChoice(options = {}) {
    const sw = getPrimaryAgentSwatch();
    const alias = String(OnboardingState.agentName || "").trim();
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(
          PRIMARY_AGENT_STORAGE_KEY,
          JSON.stringify({
            alias,
            swatch: sw.key,
          })
        );
      }
    } catch {
      // Ignore storage errors
    }
    Transport.postPrimaryAgentUpdated(alias || null, sw.key);
    if (options.syncProfile) {
      syncAgentNameToProfile(alias);
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
       done -> Success (✓ only when result.ok is true and non-sample/non-mock)
       failed -> Failed */
    function hasMockVerifyEvidence(allRunsInGroup, detailsById) {
      for (const r of allRunsInGroup) {
        const evs = Array.isArray(detailsById[r.id]?.events) ? detailsById[r.id].events : [];
        if (
          evs.some(
            (e) =>
              e?.kind === "verify" &&
              e.achieved === true &&
              /^mock$/i.test(String(e.evidence || "").trim())
          )
        ) {
          return true;
        }
      }
      return false;
    }

    function isMockSummaryText(value) {
      return /^mock$/i.test(String(value || "").trim());
    }

    function isMockRunGroup(allRunsInGroup, detailsById, costData, isSampleContext) {
      if (isSampleContext) return true;
      if (hasMockVerifyEvidence(allRunsInGroup, detailsById)) return true;
      if (costData && costData.mock === true) return true;
      for (const r of allRunsInGroup) {
        const detail = detailsById[r.id];
        if (r?.result?.digest?.task_cost?.mock === true) return true;
        if (detail?.result?.digest?.task_cost?.mock === true) return true;
        if (
          isMockSummaryText(r?.result?.summary) ||
          isMockSummaryText(r?.result?.digest?.summary) ||
          isMockSummaryText(detail?.result?.summary) ||
          isMockSummaryText(detail?.result?.digest?.summary)
        ) {
          return true;
        }
      }
      return false;
    }

    function mapBackendState(rawState, result, hasPendingHelp, hasVerifyPass, isMockRun) {
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
        if (isMockRun) {
          return {
            filterKey: "success",
            word: "Finished · sample run, not verified",
            symbol: "",
            symbolWord: "Finished · sample run, not verified",
            shortSymbolWord: "Finished · sample run, not verified",
            colorClass: "state-neutral",
            isVerified: false,
          };
        }
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
      const reasonRaw = String(result?.error || result?.summary || result?.message || "").trim();
      const reasonLow = reasonRaw.toLowerCase();
      let incompleteLabel = "Couldn't finish";
      if (reasonLow.includes("cancel")) incompleteLabel = "Cancelled by you";
      else if (reasonLow.includes("stopped") || reasonLow.includes("stop")) incompleteLabel = "Stopped by you";
      else if (reasonLow.includes("denied") || reasonLow.includes("declined") || reasonLow.includes("said no")) {
        incompleteLabel = "You said no";
      } else if (reasonLow.includes("timed out") || reasonLow.includes("timeout")) {
        incompleteLabel = "Timed out waiting for you";
      } else if (reasonRaw) {
        const cleaned = reasonRaw.replace(/^×\s*failed\s*·?\s*/i, "").replace(/^failed\s*·?\s*/i, "").trim();
        if (cleaned) {
          const firstSentence = cleaned.split(/(?<=[.!?])\s+/)[0].trim();
          incompleteLabel = firstSentence.length > 72 ? firstSentence.slice(0, 69).trimEnd() + "…" : firstSentence;
        }
      }
      return {
        filterKey: "failed",
        word: incompleteLabel,
        symbol: "",
        symbolWord: incompleteLabel,
        shortSymbolWord: incompleteLabel,
        colorClass: "state-neutral",
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

    const OPEN_METHOD_TOKENS = new Set(["finder", "running", "spotlight", "reopen", "relaunch"]);
    const UI_KIND_TOKENS = new Set([
      "button", "menuitem", "textfield", "checkbox", "link", "tab", "radio", "sidebar", "menu", "item",
    ]);

    function formatAppDisplayName(rawTarget, appName) {
      const cleanTarget = String(rawTarget || "").replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
      const cleanApp = String(appName || "").trim();
      const usableApp = cleanApp && !/^(app|desktop)$/i.test(cleanApp) ? cleanApp : "";
      if (!cleanTarget) return usableApp || "app";
      if (usableApp) {
        const lowT = cleanTarget.toLowerCase();
        const lowA = usableApp.toLowerCase();
        if (lowA === lowT || lowA.startsWith(lowT) || lowT.startsWith(lowA)) {
          return usableApp;
        }
      }
      if (cleanTarget === cleanTarget.toLowerCase()) {
        return cleanTarget
          .split(/\s+/)
          .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : ""))
          .join(" ");
      }
      return cleanTarget;
    }

    function formatUsd(amount) {
      if (amount == null) return "—";
      const n = Number(amount);
      if (!Number.isFinite(n)) return "—";
      if (n === 0) return "$0.00";
      if (Math.abs(n) >= 0.01) return `$${n.toFixed(2)}`;
      return `$${n.toFixed(4)}`;
    }

    function humanizeSmAction(rawAction, appName) {
      const raw = String(rawAction || "").trim();
      if (!raw) return "Performed action";
      const hasColon = raw.includes(":");
      const parts = (hasColon ? raw.split(":") : raw.split(/\s+/)).map((p) => p.trim()).filter(Boolean);
      const verb = (parts[0] || "").toLowerCase();
      if (verb === "open_app" || verb === "open") {
        const appTokens = parts
          .slice(1)
          .filter((p) => !OPEN_METHOD_TOKENS.has(p.toLowerCase()) && !UI_KIND_TOKENS.has(p.toLowerCase()));
        return `Opened ${formatAppDisplayName(appTokens.join(" "), appName)}`;
      }
      const restParts = parts
        .slice(1)
        .filter((p) => !UI_KIND_TOKENS.has(p.toLowerCase()) && !OPEN_METHOD_TOKENS.has(p.toLowerCase()));
      const hadInvalidTarget = restParts.some((p) => /^invalid[-_\s]?target$/i.test(p));
      const validParts = restParts.filter((p) => !/^invalid[-_\s]?target$/i.test(p));
      const target = validParts.join(" ").replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
      if (verb === "click" || verb === "double_click") {
        const prefix = verb === "double_click" ? "Double-clicked" : "Clicked";
        if (hadInvalidTarget && !target) return `${prefix} (nothing matched)`;
        return `${prefix} ${target || "control"}`;
      }
      if (verb === "type" || verb === "input") {
        return `Typed ${target || (hadInvalidTarget ? "(nothing matched)" : "text")}`;
      }
      if (verb === "key" || verb === "press" || verb === "hotkey") {
        return `Pressed ${target || "key"}`;
      }
      if (verb === "scroll") {
        return `Scrolled ${target || "page"}`;
      }
      if (verb === "verify" || verb === "done_verified") {
        return `Checked ${target || appName || "screen"}`;
      }
      const clean = raw
        .replace(/invalid[-_\s]?target/gi, "(nothing matched)")
        .replace(/[:_]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      return clean.charAt(0).toUpperCase() + clean.slice(1);
    }

    function formatAgentStepEvent(ev, isMockRun) {
      if (!ev || typeof ev !== "object") return null;
      const tText = ev.t != null ? `${Number(ev.t).toFixed(1)}s` : "";
      switch (ev.kind) {
        case "decide": {
          let thought = ev.thought ? sentenceCase(ev.thought) : "";
          if (/^Split task into (\d+) parallel agents:/i.test(thought)) {
            thought = thought.replace(/^Split task into (\d+) parallel agents:/i, "Split the task between $1 agents:");
          }
          return {
            kind: "decide",
            label: "Decide",
            summary: thought
              ? thought
              : ev.action
                ? humanizeSmAction(ev.action)
                : "Planned next step",
            timeText: tText,
          };
        }
        case "act":
          return {
            kind: "act",
            label: "Work",
            summary: ev.action ? humanizeSmAction(ev.action) : "Completed a step",
            timeText: tText,
          };
        case "verify": {
          const isMockEv = Boolean(isMockRun || isMockSummaryText(ev.evidence));
          if (ev.achieved && isMockEv) {
            return {
              kind: "verify",
              label: "Verify",
              summary: "Sample run check (not verified)",
              timeText: tText,
            };
          }
          return {
            kind: "verify",
            label: "Verify",
            summary: ev.achieved
              ? `✓ Verified: ${ev.evidence || "Goal confirmed on screen"}`
              : `Not verified yet: ${ev.evidence || "Check did not pass"}`,
            timeText: tText,
          };
        }
        case "help": {
          const q = String(ev.question || "").trim();
          const qText = q ? q.charAt(0).toLowerCase() + q.slice(1) : "needs confirmation";
          return {
            kind: "help",
            label: "Help",
            summary: `Waiting for you: ${qText}`,
            timeText: tText,
          };
        }
        case "help_answer":
          return {
            kind: "help",
            label: "Answer",
            summary: `User answered: ${sentenceCase(ev.answer || "")}${ev.timed_out ? " (expired after 5m)" : ""}`,
            timeText: tText,
          };
        case "result": {
          const isMockEv = Boolean(isMockRun || isMockSummaryText(ev.summary));
          const prefix = ev.ok
            ? (isMockEv ? "Finished · sample run, not verified" : "✓ Verified")
            : "Did not finish";
          const cleanSum = isMockSummaryText(ev.summary) ? "" : sentenceCase(ev.summary || "");
          return {
            kind: "result",
            label: "Result",
            summary: cleanSum ? `${prefix} · ${cleanSum}` : prefix,
            timeText: tText,
          };
        }
        case "route": {
          const who = ev.agent || roleLabel(ev.role);
          const goalRaw = String(ev.goal || "").trim();
          const goalText = goalRaw
            ? goalRaw.charAt(0).toLowerCase() + goalRaw.slice(1)
            : ev.app
              ? `work in ${ev.app}`
              : "help";
          return {
            kind: "decide",
            label: "Route",
            summary: `Asked ${who} to ${goalText}`,
            timeText: tText,
          };
        }
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
          const costStr = formatUsd(ev.cost);
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

    function truncateAtWord(text, maxLen = 28) {
      const s = String(text || "").trim();
      if (s.length <= maxLen) return s;
      const slice = s.slice(0, maxLen);
      const lastSpace = slice.lastIndexOf(" ");
      if (lastSpace > Math.floor(maxLen * 0.45)) {
        return slice.slice(0, lastSpace).trimEnd() + "…";
      }
      return slice.trimEnd() + "…";
    }

    function isHashOrUnknownScreenToken(token) {
      const t = String(token || "").trim();
      if (!t || t === "?" || /^(unknown|none|null|screen|start)$/i.test(t)) return true;
      if (/^[0-9a-f]{6,}$/i.test(t)) return true;
      if (/^(?=.*\d)[a-z0-9]{8,}$/i.test(t)) return true;
      return false;
    }

    function extractReadableScreenSuffix(screenId) {
      const raw = String(screenId || "").trim();
      const suffix = raw.includes(":") ? raw.split(":").slice(1).join(":").trim() : raw;
      if (isHashOrUnknownScreenToken(suffix)) return "";
      let cleaned = suffix;
      const prefixMatch = /^([0-9a-f]{4})([a-z][a-z0-9_-]*)$/i.exec(cleaned);
      if (prefixMatch && /\d/.test(prefixMatch[1])) {
        cleaned = prefixMatch[2];
      }
      cleaned = cleaned
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/([a-zA-Z])(\d+)/g, "$1 $2")
        .replace(/[-_]+/g, " ")
        .trim();
      if (!cleaned || isHashOrUnknownScreenToken(cleaned)) return "";
      return sentenceCase(cleaned);
    }

    function formatActionTargetForScreen(action) {
      const parts = String(action || "")
        .split(":")
        .map((p) => p.trim())
        .filter(Boolean);
      if (!parts.length) return "action";
      const verb = parts[0].toLowerCase();
      const rest = parts
        .slice(1)
        .filter((p) => !UI_KIND_TOKENS.has(p.toLowerCase()) && !OPEN_METHOD_TOKENS.has(p.toLowerCase()));
      const cleaned = rest
        .map((p) => (/^invalid[-_\s]?target$/i.test(p) ? "(nothing matched)" : p))
        .join(" ");
      const target = cleaned || parts.slice(1).join(" ") || verb;
      return target.replace(/invalid[-_\s]?target/gi, "(nothing matched)").replace(/[-_]+/g, " ").trim();
    }

    function formatActionAsScreenTitle(action, detail, app, direction) {
      const raw = String(action || "").trim();
      const verb = raw.split(":")[0].toLowerCase();
      const target = formatActionTargetForScreen(raw);
      if (direction === "to") {
        if (verb === "open_app" || verb === "open") {
          return `${formatAppDisplayName(target, app)} opened`;
        }
        if (verb === "done") {
          if (typeof detail === "string" && detail.trim()) {
            return `Result: ${truncateAtWord(detail.trim(), 28)}`;
          }
          return `${app || "Task"} completed`;
        }
        if (verb === "type") return `After typing ${target}`;
        if (verb === "press") return `After pressing ${target}`;
        if (verb === "key") return `After ${target}`;
        return `After ${target}`;
      }
      if (verb === "open_app" || verb === "open") return `Before opening ${formatAppDisplayName(target, app)}`;
      if (verb === "done") return `${app || "App"} ready`;
      return `Before ${target}`;
    }

    function buildStateMachine(rawActions, agentPaletteByName, selectedAgentFilter, selectedAppFilter, resolveAgentName) {
      const rows = Array.isArray(rawActions) ? rawActions : [];
      const resolveName = typeof resolveAgentName === "function" ? resolveAgentName : (a) => String(a || "").trim();
      const normalizedRows = rows.map((r) => ({
        ...r,
        _appName: String(r.app || "App").trim() || "App",
        _agentName: resolveName(r.agent, r.run),
      }));
      const filteredRows = normalizedRows.filter((r) => {
        if (selectedAgentFilter) {
          const matchAgent =
            r._agentName === selectedAgentFilter ||
            r.agent === selectedAgentFilter ||
            r.run === selectedAgentFilter;
          if (!matchAgent) return false;
        }
        if (selectedAppFilter && selectedAppFilter !== "all") {
          if (r._appName !== selectedAppFilter) return false;
        }
        return true;
      });

      const screensMap = new Map();
      const edgesMap = new Map();
      const appsSet = new Set();
      const agentsSet = new Set();
      const incomingByScreen = new Map();
      const outgoingByScreen = new Map();
      const explicitTitleByScreen = new Map();

      for (const r of normalizedRows) {
        if (r._appName) appsSet.add(r._appName);
        if (r._agentName) agentsSet.add(r._agentName);
      }

      for (const row of filteredRows) {
        const app = row.app || "Desktop";
        const fromId = row.from || `${app}:start`;
        const actionVerb = String(row.action || "act").split(":")[0] || "next";
        const toId = row.to || `${app}:${actionVerb}`;
        if (row.from_title || row.window_title || row.screen_title) {
          explicitTitleByScreen.set(fromId, String(row.from_title || row.window_title || row.screen_title).trim());
        }
        if (row.to_title) {
          explicitTitleByScreen.set(toId, String(row.to_title).trim());
        }
        if (!outgoingByScreen.has(fromId)) outgoingByScreen.set(fromId, []);
        outgoingByScreen.get(fromId).push({ action: row.action, detail: row.detail, app });
        if (!incomingByScreen.has(toId)) incomingByScreen.set(toId, []);
        incomingByScreen.get(toId).push({ action: row.action, detail: row.detail, app });
      }

      function deriveScreenTitle(id, appName) {
        const explicit = explicitTitleByScreen.get(id);
        if (explicit && !isHashOrUnknownScreenToken(explicit)) {
          return sentenceCase(explicit);
        }
        const readable = extractReadableScreenSuffix(id);
        if (readable) return readable;
        const incoming = incomingByScreen.get(id);
        if (incoming && incoming.length) {
          const lastIn = incoming[incoming.length - 1];
          return formatActionAsScreenTitle(lastIn.action, lastIn.detail, appName, "to");
        }
        const outgoing = outgoingByScreen.get(id);
        if (outgoing && outgoing.length) {
          const firstOut = outgoing[0];
          return formatActionAsScreenTitle(firstOut.action, firstOut.detail, appName, "from");
        }
        return `${appName || "App"} screen`;
      }

      function ensureScreen(id, appName) {
        const key = id || `${appName || "App"}:screen`;
        if (!screensMap.has(key)) {
          screensMap.set(key, {
            id: key,
            app: appName || "App",
            title: deriveScreenTitle(key, appName || "App"),
            visits: 0,
            agents: new Set(),
          });
        }
        const node = screensMap.get(key);
        node.visits += 1;
        return node;
      }

      for (const row of filteredRows) {
        const app = row._appName || "Desktop";
        const fromId = row.from || `${app}:start`;
        const actionVerb = String(row.action || "act").split(":")[0] || "next";
        const toId = row.to || `${app}:${actionVerb}`;
        const fromNode = ensureScreen(fromId, app);
        const toNode = ensureScreen(toId, app);
        if (row._agentName) {
          fromNode.agents.add(row._agentName);
          toNode.agents.add(row._agentName);
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
        if (row._agentName && !edge.agents.includes(row._agentName)) {
          edge.agents.push(row._agentName);
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
          statusSymbolWord = "Couldn't finish";
          statusClass = "state-neutral";
          strokeColor = "#767d8e";
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
          actionClean: humanizeSmAction(e.action, e.app),
          sourceLabel: Array.from(e.sources).join(", ") || "model",
        };
      });

      const screens = Array.from(screensMap.values());
      const titleCountsByApp = new Map();
      for (const s of screens) {
        const key = `${s.app}::${s.title}`;
        titleCountsByApp.set(key, (titleCountsByApp.get(key) || 0) + 1);
      }
      const seenTitleIndex = new Map();
      for (const s of screens) {
        const key = `${s.app}::${s.title}`;
        if ((titleCountsByApp.get(key) || 0) > 1) {
          const n = (seenTitleIndex.get(key) || 0) + 1;
          seenTitleIndex.set(key, n);
          s.title = `${s.title} (${n})`;
        }
      }
      for (const e of edges) {
        const fromNode = screensMap.get(e.from);
        const toNode = screensMap.get(e.to);
        if (fromNode) e.fromTitle = fromNode.title;
        if (toNode) e.toTitle = toNode.title;
      }

      return {
        screens,
        edges,
        allApps: Array.from(appsSet).sort(),
        allAgents: Array.from(agentsSet).sort(),
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
      const isTaskRun = (r) => Boolean(r && (!r.parent || !byId.has(r.parent) || r.role === "orchestrator"));

      const parents = runsList.filter((r) => isTaskRun(r));
      const childrenByParent = new Map();
      const childOrchestratorsByParent = new Map();
      for (const r of runsList) {
        if (r.parent && byId.has(r.parent)) {
          if (isTaskRun(r)) {
            if (!childOrchestratorsByParent.has(r.parent)) childOrchestratorsByParent.set(r.parent, []);
            childOrchestratorsByParent.get(r.parent).push(r);
          } else {
            if (!childrenByParent.has(r.parent)) childrenByParent.set(r.parent, []);
            childrenByParent.get(r.parent).push(r);
          }
        }
      }

      const allTranscriptRowsByKey = new Map();
      const allTranscriptRowsList = [];
      if (transcriptsByRunId && typeof transcriptsByRunId === "object") {
        for (const rows of Object.values(transcriptsByRunId)) {
          if (!Array.isArray(rows)) continue;
          for (const tr of rows) {
            if (!tr || typeof tr !== "object") continue;
            const dedupKey = tr.id != null
              ? `id:${tr.id}`
              : `raw:${tr.ts ?? ""}|${tr.run ?? ""}|${tr.kind ?? ""}|${tr.text ?? ""}`;
            if (!allTranscriptRowsByKey.has(dedupKey)) {
              allTranscriptRowsByKey.set(dedupKey, tr);
              allTranscriptRowsList.push(tr);
            }
          }
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
        const groupRunIds = new Set(allGroupRuns.map((r) => r.id));

        const rawCostForTask = (taskRun) => {
          if (!taskRun) return null;
          const fetched = costsById?.[taskRun.id] || null;
          const digest = taskRun.result?.digest?.task_cost || detailsById[taskRun.id]?.result?.digest?.task_cost || null;
          if (fetched && (Number(fetched.llm_calls || 0) > 0 || Number(fetched.cost_usd || 0) > 0 || !digest)) {
            return fetched;
          }
          return digest || fetched || null;
        };

        const resolveGroupCost = () => {
          const baseCost = rawCostForTask(parent);
          if (!baseCost) return null;
          const directChildOrchestrators = childOrchestratorsByParent.get(parent.id) || [];
          if (!directChildOrchestrators.length || Number(baseCost.agents || 0) <= allGroupRuns.length) {
            return baseCost;
          }
          let subAgents = 0;
          let subCalls = 0;
          let subPromptTokens = 0;
          let subCompletionTokens = 0;
          let subCostUsd = 0;
          let subModelSec = 0;
          for (const dc of directChildOrchestrators) {
            const dcCost = rawCostForTask(dc);
            if (dcCost) {
              subAgents += Number(dcCost.agents || 0);
              subCalls += Number(dcCost.llm_calls || 0);
              subPromptTokens += Number(dcCost.prompt_tokens || 0);
              subCompletionTokens += Number(dcCost.completion_tokens || 0);
              subCostUsd += Number(dcCost.cost_usd || 0);
              subModelSec += Number(dcCost.model_seconds || 0);
            } else {
              const dcChildren = childrenByParent.get(dc.id) || [];
              subAgents += 1 + dcChildren.length;
            }
          }
          return {
            ...baseCost,
            agents: Math.max(allGroupRuns.length, Number(baseCost.agents || 0) - subAgents),
            llm_calls: Math.max(0, Number(baseCost.llm_calls || 0) - subCalls),
            prompt_tokens: Math.max(0, Number(baseCost.prompt_tokens || 0) - subPromptTokens),
            completion_tokens: Math.max(0, Number(baseCost.completion_tokens || 0) - subCompletionTokens),
            cost_usd: Number(Math.max(0, Number(baseCost.cost_usd || 0) - subCostUsd).toFixed(6)),
            model_seconds: Number(Math.max(0, Number(baseCost.model_seconds || 0) - subModelSec).toFixed(1)),
          };
        };

        const groupCost = resolveGroupCost();
        const isMockGroup = isMockRunGroup(
          allGroupRuns,
          detailsById,
          groupCost,
          Boolean(isSampleData)
        );

        const directParentRows = Array.isArray(transcriptsByRunId?.[parent.id]) ? transcriptsByRunId[parent.id] : [];
        const parentTranscriptRows = allTranscriptRowsList
          .filter((tr) => (tr.run ? groupRunIds.has(tr.run) : directParentRows.includes(tr)))
          .slice()
          .sort((a, b) => (Number(a.ts || 0) - Number(b.ts || 0)) || (Number(a.id || 0) - Number(b.id || 0)));
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
          const hasVerifyPass = !isMockGroup && events.some((e) => e.kind === "verify" && e.achieved);

          const status = mapBackendState(
            runItem.state,
            runItem.result || detail?.result,
            runHelp.length > 0,
            hasVerifyPass,
            isMockGroup
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

          const steps = events.map((ev) => formatAgentStepEvent(ev, isMockGroup)).filter(Boolean);
          const rawNodeSummary = (runItem.result || detail?.result)?.summary;
          const cleanNodeSummary =
            rawNodeSummary && !isMockSummaryText(rawNodeSummary)
              ? sentenceCase(rawNodeSummary)
              : "";
          if (!steps.length && rawNodeSummary) {
            steps.push({
              kind: "result",
              label: "Result",
              summary: cleanNodeSummary || "Finished · sample run, not verified",
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
            resultSummary:
              cleanNodeSummary ||
              steps[steps.length - 1]?.summary ||
              status.word,
          };
        });

        const primaryNode = nodes[0];
        const childNodes = nodes.slice(1);
        const groupHasWaiting = nodes.some((n) => n.status.filterKey === "waiting");
        const groupHasRunning = nodes.some((n) => n.status.filterKey === "running");
        const groupHasFailed = nodes.some((n) => n.status.filterKey === "failed");
        const groupHasVerified = !isMockGroup && nodes.some((n) => n.status.isVerified);

        let overallStatus = primaryNode.status;
        if (groupHasWaiting) {
          overallStatus = mapBackendState("awaiting_human", null, true, false, isMockGroup);
        } else if (groupHasRunning && primaryNode.status.filterKey !== "failed") {
          overallStatus = mapBackendState(
            primaryNode.status.word === "Queued" ? "queued" : "acting",
            null,
            false,
            false,
            isMockGroup
          );
        } else if (groupHasFailed && primaryNode.status.filterKey !== "running") {
          overallStatus = mapBackendState("failed", { ok: false }, false, false, isMockGroup);
        } else if (primaryNode.status.filterKey === "success") {
          overallStatus = mapBackendState("done", parent.result || { ok: true }, false, groupHasVerified, isMockGroup);
        }

        const uiSentFiles = sentAttachmentsByRunId.get(parent.id) || [];
        const backendAttachments = Array.isArray(parent.files)
          ? parent.files
          : Array.isArray(detailsById[parent.id]?.files)
            ? detailsById[parent.id].files
            : [];
        const attachments = Array.from(new Set([...uiSentFiles, ...backendAttachments]));

        const transcriptRows = parentTranscriptRows;
        const combinedEvents = [];
        if (transcriptRows.length) {
          for (const tr of transcriptRows) {
            const rawAgent = tr.agent || tr.role || "Agent";
            const isOrchestratorRow =
              rawAgent === "ComputerAnything" ||
              rawAgent === "Mercury" ||
              rawAgent === "Primary orchestrator" ||
              tr.role === "orchestrator";
            const rawText = String(tr.text || "").trim();
            const isRawActionKind =
              tr.kind === "act" ||
              /^(click|double_click|type|set_value|press|scroll|open_app|run_applescript)[\s:]/i.test(rawText);
            const cleanSummary = isRawActionKind
              ? humanizeSmAction(rawText)
              : isMockSummaryText(rawText)
                ? "Sample run (not verified)"
                : rawText;
            combinedEvents.push({
              kind: isRawActionKind ? "act" : (tr.kind || tr.role || "message"),
              agentName: isOrchestratorRow ? getPrimaryAgentDisplayName(rawAgent) : rawAgent,
              agentPalette: isOrchestratorRow ? getPrimaryAgentSwatch() : null,
              label: isRawActionKind ? "Work" : sentenceCase(tr.kind || tr.role || "Message"),
              summary: cleanSummary,
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

        const cleanParentSummary =
          parent.result?.summary && !isMockSummaryText(parent.result.summary)
            ? sentenceCase(parent.result.summary)
            : "";
        const cleanDigestSummary =
          parentDigest?.summary && !isMockSummaryText(parentDigest.summary)
            ? sentenceCase(parentDigest.summary)
            : "";
        const childResultFallback =
          childNodes.find((c) => c.resultSummary && c.resultSummary !== "Sample run check (not verified)")?.resultSummary ||
          "";

        return {
          id: parent.id,
          goal: parent.goal || "Untitled task",
          elapsedText: formatSeconds(parent.elapsed),
          attachments,
          overallStatus,
          isMock: isMockGroup,
          digest: parentDigest,
          digestSummaryText: digestParts.join(" · "),
          resultSummary:
            cleanParentSummary ||
            cleanDigestSummary ||
            childResultFallback ||
            overallStatus.word,
          primaryNode,
          childNodes,
          allNodes: nodes,
          combinedEvents,
          cost: groupCost,
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
        if (
          matchedRunIdsFromEndpoint &&
          (matchedRunIdsFromEndpoint.has(g.id) || g.allNodes.some((n) => matchedRunIdsFromEndpoint.has(n.runId)))
        ) {
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
      const runById = new Map(runsList.map((r) => [r.id, r]));
      const nodeNameByRunId = new Map();
      for (const g of taskGroups) {
        for (const n of g.allNodes) {
          if (n.runId && n.agentName) nodeNameByRunId.set(n.runId, n.agentName);
        }
      }
      const resolveSmAgentName = (rawAgent, runId) => {
        const raw = String(rawAgent || "").trim();
        const fromAgents =
          (raw && rawAgents?.[raw]?.name) ||
          (runId && rawAgents?.[runId]?.name) ||
          "";
        if (fromAgents) return String(fromAgents).trim();
        const fromNode =
          (runId && nodeNameByRunId.get(runId)) ||
          (raw && nodeNameByRunId.get(raw)) ||
          "";
        if (fromNode) return String(fromNode).trim();
        const rObj = (runId && runById.get(runId)) || (raw && runById.get(raw)) || null;
        if (rObj?.agent_name) return String(rObj.agent_name).trim();
        if (raw && !/^r\d{6,}-\d+(?:-[0-9a-f]+)?$/i.test(raw) && !/^[0-9a-f]{6,}$/i.test(raw)) {
          return raw;
        }
        if (rObj?.role === "orchestrator" || raw === "orchestrator") {
          return getPrimaryAgentDisplayName("Primary orchestrator");
        }
        if (rObj?.role) return formatRoleTitle(rObj.role);
        return raw || "Agent";
      };

      const stateMachine = buildStateMachine(
        rawActions,
        agentPaletteByName,
        state.smAgentFilter || "",
        selectedAppFilter || "all",
        resolveSmAgentName
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
          const isPrimaryRun = !r.parent || r.role === "orchestrator";
          const agentName = isPrimaryRun
            ? getPrimaryAgentDisplayName(rawAgents?.[r.id]?.name || r.agent_name || "Primary orchestrator")
            : (rawAgents?.[r.id]?.name || nodeNameByRunId.get(r.id) || r.role || "Agent");

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
                fromTitle: fromScreen?.title || extractReadableScreenSuffix(fromId) || "Active screen",
                toTitle: toScreen?.title || extractReadableScreenSuffix(toId) || "Next screen",
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
                fromTitle: fromScreen?.title || extractReadableScreenSuffix(a.from) || "Active screen",
                toTitle: toScreen?.title || extractReadableScreenSuffix(a.to) || "Next screen",
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
                  : { symbolWord: "○ Couldn't commit", colorClass: "state-neutral" },
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

      let resolvedAnalytics = rawAnalytics;
      if (!resolvedAnalytics && taskGroups.some((g) => g.cost && (Number(g.cost.llm_calls || 0) > 0 || Number(g.cost.cost_usd || 0) > 0))) {
        const totalCostUsd = Number(
          taskGroups.reduce((sum, g) => sum + Number(g.cost?.cost_usd || 0), 0).toFixed(6)
        );
        const totalLlmCalls = taskGroups.reduce((sum, g) => sum + Number(g.cost?.llm_calls || 0), 0);
        resolvedAnalytics = {
          tasks: taskGroups.length,
          cost_usd: totalCostUsd,
          llm_calls: totalLlmCalls,
          mean_cost_per_task: taskGroups.length ? Number((totalCostUsd / taskGroups.length).toFixed(6)) : null,
          by_role: [],
          by_purpose: [],
          by_app: [],
        };
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
        analytics: resolvedAnalytics,
        costsById,
      };
    }

    return {
      buildViewModel,
      formatSeconds,
      formatUsd,
      sentenceCase,
      humanizeSmAction,
    };
  })();

  /* ============================================================================
     4. WORKSPACE STATE & DOM REFERENCES
     ============================================================================ */
  const initialViewParam = params.get("view") || window.location.hash.replace(/^#/, "");
  const hasExplicitInitialView = Boolean(initialViewParam && initialViewParam.trim());
  let hasShellSetView = false;
  let currentView = normalizeViewName(initialViewParam || "graph");
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
  let stopRouteSupported = false;
  let stopRouteProbed = false;
  let stopAllBusy = false;
  let stopAllStatus = "";
  let stopAllStatusTone = "state-neutral";
  let stopAllStatusTimer = null;

  let copyFeedbackKey = "";
  let copyFeedbackTimer = null;
  const copyPayloadsByKey = new Map();

  function renderCopyButton(copyKey, label, textToCopy) {
    const clean = String(textToCopy || "").trim();
    if (!clean) return "";
    copyPayloadsByKey.set(copyKey, clean);
    const isCopied = copyFeedbackKey === copyKey;
    return `<button type="button" class="btn" data-action="copy-text" data-copy-key="${escapeHtml(copyKey)}">${
      isCopied ? "✓ Copied" : escapeHtml(label || "Copy")
    }</button>`;
  }

  async function copyTextToClipboard(text, feedbackKey) {
    const clean = String(text || "");
    if (!clean) return false;
    let copied = false;
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
        await navigator.clipboard.writeText(clean);
        copied = true;
      }
    } catch {
      // Fallback below
    }
    if (!copied) {
      try {
        const ta = document.createElement("textarea");
        ta.value = clean;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        copied = document.execCommand("copy");
        document.body.removeChild(ta);
      } catch {
        copied = false;
      }
    }
    if (copied && feedbackKey) {
      copyFeedbackKey = feedbackKey;
      if (copyFeedbackTimer) clearTimeout(copyFeedbackTimer);
      copyFeedbackTimer = setTimeout(() => {
        if (copyFeedbackKey === feedbackKey) {
          copyFeedbackKey = "";
          renderNow();
        }
      }, 2000);
      renderNow();
    }
    return copied;
  }

  function isReachableUrl(urlStr) {
    const s = String(urlStr || "").trim();
    if (!s) return false;
    return (
      s.startsWith("https://") ||
      s.startsWith("http://") ||
      s.startsWith("data:") ||
      s.startsWith("./") ||
      s.startsWith("/")
    ) && !s.startsWith("/Users/") && !s.startsWith("/var/") && !s.startsWith("/tmp/");
  }

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
    shellPermissions: null,
    shellVoices: null,
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
    profile: {
      call_me: "",
      voice_id: "",
      model: "",
      decide_model: "",
      agent_name: "",
    },
    profileDraft: {
      call_me: "",
      voice_id: "",
      model: "",
      decide_model: "",
      agent_name: "",
    },
    profileLoaded: false,
    profileDirty: false,
    profileSaving: false,
    profileSaveStatus: "",
    profileSaveError: "",
  };

  const VIEW_DEFINITIONS = [
    { id: "graph", label: "Agent graph", desc: "Who is working on what, parent to child", key: "1" },
    { id: "state-machine", label: "State machine", desc: "Screens and actions per app, success and failure", key: "2" },
    { id: "logs", label: "Transcript and history", desc: "Every chat, searchable, filter by state", key: "3" },
    { id: "analytics", label: "Analytics", desc: "Cost per task and app, reliability per app", key: "4" },
    { id: "artifacts", label: "Artifacts", desc: "Reports, patches, commits, files, and marketing results", key: "5" },
    { id: "memory", label: "Memory", desc: "What the agents remember about you, with Forget", key: "6" },
    { id: "agent-settings", label: "Agent settings", desc: "Primary agent name and color, primary model, and faster step model", key: "7" },
    { id: "app-settings", label: "App settings", desc: "What agents call you, voice, notch shortcut, permissions, and setup", key: "8" },
    { id: "onboarding", label: "First-run setup", desc: "Set your name, agent identity, voice, and permissions", key: "9" },
  ];

  let viewMenuOpen = false;

  function formatIncompleteOutcomeText(summaryText) {
    const raw = String(summaryText || "").trim();
    const low = raw.toLowerCase();
    if (low.includes("cancel")) return "Cancelled by you";
    if (low.includes("stopped") || low.includes("stop")) return "Stopped by you";
    if (low.includes("denied") || low.includes("declined") || low.includes("said no")) return "You said no";
    if (low.includes("timed out") || low.includes("timeout")) return "Timed out waiting for you";
    if (raw) {
      const cleaned = raw.replace(/^×\s*failed\s*·?\s*/i, "").replace(/^failed\s*·?\s*/i, "").trim();
      if (cleaned) {
        const firstSentence = cleaned.split(/(?<=[.!?])\s+/)[0].trim();
        return firstSentence.length > 72 ? firstSentence.slice(0, 69).trimEnd() + "…" : firstSentence;
      }
    }
    return "Couldn't finish";
  }

  function formatUiStatusDisplay(status, summaryText) {
    if (!status) return { text: "Running", colorClass: "state-working" };
    if (status.filterKey === "failed") {
      return {
        text: formatIncompleteOutcomeText(summaryText),
        colorClass: "state-neutral",
      };
    }
    return {
      text: status.symbolWord || status.word || "Running",
      colorClass: status.colorClass || "state-neutral",
    };
  }

  function normalizeViewName(raw) {
    const v = String(raw || "").toLowerCase().trim();
    if (v === "b1" || v === "graph" || v === "agent-graph") return "graph";
    if (v === "b1b" || v === "statemachine" || v === "state-machine" || v === "state") return "state-machine";
    if (v === "b2" || v === "logs" || v === "transcript" || v === "transcripts") return "logs";
    if (v === "b6" || v === "artifacts" || v === "artifact") return "artifacts";
    if (v === "b7" || v === "marketing" || v === "promo") return "artifacts";
    if (v === "b3" || v === "analytics" || v === "cost") return "analytics";
    if (v === "b4" || v === "onboarding" || v === "setup") return "onboarding";
    if (v === "settings" || v === "agent-settings") return "agent-settings";
    if (v === "app-settings") return "app-settings";
    if (v === "memory") return "memory";
    if (v === "b5" || v === "history" || v === "history-settings") return "history";
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
      } else {
        provEl.style.display = "none";
      }
    }

    const menuViewId =
      currentView === "history" ? "logs" : currentView === "marketing" ? "artifacts" : currentView;
    const activeDef = VIEW_DEFINITIONS.find((v) => v.id === menuViewId) || VIEW_DEFINITIONS[0];
    const menuLabelEl = document.getElementById("view-menu-label");
    if (menuLabelEl) {
      menuLabelEl.textContent = activeDef.label;
    }

    const menuBtn = document.getElementById("view-menu-btn");
    const menuDrop = document.getElementById("view-menu-dropdown");
    if (menuBtn) {
      menuBtn.setAttribute("aria-expanded", viewMenuOpen ? "true" : "false");
    }
    if (menuDrop) {
      menuDrop.classList.toggle("hidden", !viewMenuOpen);
      menuDrop.innerHTML = VIEW_DEFINITIONS.map((v) => {
        const isCurrent = v.id === menuViewId;
        const shortcutText = v.key >= "1" && v.key <= "9" ? `⌘${v.key}` : "";
        return `
          <button
            type="button"
            class="view-menu-item"
            role="menuitemradio"
            aria-checked="${isCurrent ? "true" : "false"}"
            data-action="select-view-menu"
            data-view="${escapeHtml(v.id)}"
          >
            <span class="view-menu-item-text">
              <span class="view-menu-item-title">${escapeHtml(v.label)}</span>
              <span class="view-menu-item-desc">${escapeHtml(v.desc)}</span>
            </span>
            ${shortcutText ? `<span class="view-menu-item-key">${shortcutText}</span>` : ""}
          </button>
        `;
      }).join("");
    }

    const activeRunCount = (rawRuns || []).filter(
      (r) => (!r.parent || r.role === "orchestrator") && (r.state === "queued" || r.state === "planning" || r.state === "acting" || r.state === "awaiting_human")
    ).length;
    const stopWrapEl = document.getElementById("stop-all-wrap");
    const stopBtnEl = document.getElementById("stop-all-btn");
    const stopStatusEl = document.getElementById("stop-all-status");
    const showStopBtn = stopRouteSupported && activeRunCount > 0 && vm.connectionStatus !== "disconnected";
    const showStopStatus = Boolean(stopAllStatus);
    if (stopWrapEl) {
      stopWrapEl.classList.toggle("hidden", !showStopBtn && !showStopStatus);
    }
    if (stopBtnEl) {
      stopBtnEl.classList.toggle("hidden", !showStopBtn);
      stopBtnEl.disabled = stopAllBusy;
      stopBtnEl.textContent = stopAllBusy ? "Stopping…" : "Stop all";
    }
    if (stopStatusEl) {
      stopStatusEl.classList.toggle("hidden", !showStopStatus);
      stopStatusEl.className = `state-text ${stopAllStatusTone}${showStopStatus ? "" : " hidden"}`;
      stopStatusEl.textContent = stopAllStatus;
    }

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
    const detail = errMsg || "Paste the address ComputerAnything printed when it started to connect this view.";
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
          <label for="connect-url-input" class="visually-hidden">ComputerAnything address</label>
          <input
            type="url"
            id="connect-url-input"
            class="inline-text-input"
            placeholder="http://127.0.0.1:8765/?t=..."
            aria-label="ComputerAnything address"
            value="${escapeHtml(prevVal)}"
          />
          <button type="button" id="connect-submit-btn" class="btn btn-primary" data-action="connect-backend">Connect</button>
        </div>
      </div>
    `;
  }

  function renderEmptyStateHtml({ title, subtitle, message, ctaLabel, ctaAction = "focus-prompt" }) {
    const headerHtml = title
      ? `
      <div class="section-header-row">
        <div>
          <h2 class="section-title">${escapeHtml(title)}</h2>
          <p class="section-subtitle">${escapeHtml(subtitle || "")}</p>
        </div>
      </div>`
      : "";
    const effectiveCtaLabel = ctaLabel || (hasShellBridge() ? "Open the notch" : "");
    const effectiveCtaAction = ctaLabel ? ctaAction : "open-notch";
    const ctaHtml = effectiveCtaLabel
      ? `<div class="filter-group">
          <button type="button" class="btn btn-primary" data-action="${escapeHtml(effectiveCtaAction)}">${escapeHtml(effectiveCtaLabel)}</button>
        </div>`
      : "";
    return `
      ${headerHtml}
      <div class="view-state-block">
        <span class="state-text state-neutral">&cir; ${escapeHtml(message)}</span>
        ${ctaHtml}
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
            <span class="section-subtitle">Disconnected from ComputerAnything for ${escapeHtml(ageSec)}s since last refresh.</span>
          </div>
          <button type="button" class="btn" data-action="retry-poll">Retry</button>
        </div>
      `);
    }
    if (failedEndpoints.length > 0) {
      const arrivedText = succeededEndpoints.length
        ? succeededEndpoints.map((e) => e.label || e).join(", ")
        : "Nothing";
      const failedText = failedEndpoints
        .map((e) => e.label || String(e))
        .join(", ");
      notices.push(`
        <div class="view-status-row" role="status">
          <div class="filter-group">
            <span class="state-text state-warning">&#9684; Partial data</span>
            <span class="section-subtitle">Loaded: ${escapeHtml(arrivedText)}. Missing: ${escapeHtml(failedText)}.</span>
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

    const DEMO_PREVIEW_FIXTURES = new Set([
      "workspace-demo",
      "workspace-empty",
      "workspace-partial",
      "workspace-stale",
      "workspace-loading",
      "workspace-disconnected",
    ]);

    if (vm.isSampleData && currentView !== "onboarding" && DEMO_PREVIEW_FIXTURES.has(activeFixtureName)) {
      banner.classList.remove("hidden");
      banner.innerHTML = `
        <span class="state-text state-warning">◔ Preview</span>
        <div class="filter-group">
          <button type="button" class="btn ${activeFixtureName === "workspace-demo" ? "btn-active" : ""}" data-action="load-fixture" data-fixture="workspace-demo">Multi-agent</button>
          <button type="button" class="btn ${activeFixtureName === "workspace-empty" ? "btn-active" : ""}" data-action="load-fixture" data-fixture="workspace-empty">Empty</button>
          <button type="button" class="btn ${activeFixtureName === "workspace-partial" ? "btn-active" : ""}" data-action="load-fixture" data-fixture="workspace-partial">Partial</button>
          <button type="button" class="btn ${activeFixtureName === "workspace-stale" ? "btn-active" : ""}" data-action="load-fixture" data-fixture="workspace-stale">Stale</button>
          <button type="button" class="btn ${activeFixtureName === "workspace-loading" ? "btn-active" : ""}" data-action="load-fixture" data-fixture="workspace-loading">Loading</button>
          <button type="button" class="btn ${activeFixtureName === "workspace-disconnected" ? "btn-active" : ""}" data-action="load-fixture" data-fixture="workspace-disconnected">Disconnected</button>
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
          title: "",
          message: "No runs yet. Open the notch at the top of your screen to ask an agent to run a task.",
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
                    <span>${
                      g.overallStatus.filterKey === "failed" || !g.overallStatus.symbol
                        ? `Run ${vm.taskGroups.length - i}`
                        : `${escapeHtml(g.overallStatus.symbol)} Run ${vm.taskGroups.length - i}`
                    }</span>
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
                ${(() => {
                  const st = formatUiStatusDisplay(node.status, node.stateFact);
                  return `<span class="state-text ${escapeHtml(st.colorClass)}">${escapeHtml(st.text)}</span>`;
                })()}
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
              ${(() => {
                const st = formatUiStatusDisplay(node.status, node.stateFact);
                return `<span>${escapeHtml(st.text)}</span>`;
              })()}
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
                <span class="agent-step-summary">${escapeHtml(st.summary)}</span>
                <span class="agent-step-time">${escapeHtml(st.timeText)}</span>
              </div>
            `
          )
          .join("")
      : `<div class="section-subtitle">No decide, act, verify, help, or result events recorded yet.</div>`;

    const copyResultHtml = group.resultSummary
      ? renderCopyButton(`result:${group.id}`, "Copy result", group.resultSummary)
      : "";

    const failedChildSummary =
      group.childNodes.find((c) => c.status?.filterKey === "failed")?.resultSummary || group.resultSummary;
    const groupStatusDisplay = formatUiStatusDisplay(
      group.overallStatus,
      group.overallStatus?.filterKey === "failed" ? failedChildSummary : group.resultSummary
    );
    const showGroupSummary =
      group.resultSummary && group.resultSummary !== groupStatusDisplay.text;

    container.innerHTML = `
      ${renderViewStatusNoticesHtml(vm)}
      <div class="section-header-row">
        <div>
          <h2 class="section-title">${escapeHtml(group.goal)}</h2>
          <p class="section-subtitle">
            <span class="state-text ${escapeHtml(groupStatusDisplay.colorClass)}">${escapeHtml(groupStatusDisplay.text)}</span>${
              showGroupSummary ? ` &middot; ${escapeHtml(group.resultSummary)}` : ""
            } &middot; Elapsed ${escapeHtml(group.elapsedText)}${
              group.digestSummaryText ? ` &middot; ${escapeHtml(group.digestSummaryText)}` : ""
            }
          </p>
        </div>
        <div class="filter-group">
          ${copyResultHtml}
          ${runSelectorHtml}
        </div>
      </div>

      <div class="b1-layout">
        <div class="agent-graph-stage" id="b1-graph-stage">
          <div class="agent-graph-canvas" id="b1-graph-canvas">
            <svg class="agent-graph-edges-svg" id="b1-edges-svg" aria-hidden="true"></svg>
            <div class="agent-graph-tier" id="b1-primary-tier">
              ${renderGraphNodeButton(group.primaryNode)}
            </div>
            ${childrenHtml}
          </div>
        </div>

        <div class="agent-steps-pane">
          <div class="agent-steps-header">
            <div>
              <div class="section-title">${escapeHtml(selectedNode.agentName)}</div>
              <div class="section-subtitle">
                ${(() => {
                  const st = formatUiStatusDisplay(selectedNode.status, selectedNode.stateFact);
                  return `<span class="state-text ${escapeHtml(st.colorClass)}">${escapeHtml(st.text)}</span>`;
                })()}
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
    const canvas = document.getElementById("b1-graph-canvas") || stage;
    const svg = document.getElementById("b1-edges-svg");
    if (!stage || !canvas || !svg) return;

    canvas.style.transform = "";
    const parentEl = canvas.querySelector('[data-parent-node="1"]');
    const childEls = Array.from(canvas.querySelectorAll('[data-parent-node="0"]'));
    if (!parentEl || !childEls.length) {
      svg.innerHTML = "";
    } else {
      const canvasRect = canvas.getBoundingClientRect();
      const pRect = parentEl.getBoundingClientRect();
      const px = pRect.left - canvasRect.left + pRect.width / 2;
      const py = pRect.bottom - canvasRect.top;

      const paths = childEls.map((childEl) => {
        const cRect = childEl.getBoundingClientRect();
        const cx = cRect.left - canvasRect.left + cRect.width / 2;
        const cy = cRect.top - canvasRect.top;
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

      svg.setAttribute("viewBox", `0 0 ${Math.max(10, canvasRect.width)} ${Math.max(10, canvasRect.height)}`);
      svg.innerHTML = paths.join("");
    }

    if (canvas !== stage) {
      const availW = Math.max(120, stage.clientWidth - 24);
      const availH = Math.max(120, stage.clientHeight - 24);
      const natW = canvas.scrollWidth || canvas.offsetWidth;
      const natH = canvas.scrollHeight || canvas.offsetHeight;
      if (natW > availW || natH > availH) {
        const scale = Math.max(0.55, Math.min(availW / natW, availH / natH));
        canvas.style.transform = `scale(${scale.toFixed(3)})`;
      }
    }
  }

  /* ---------------- B1b: STATE MACHINE GRAPH VIEW ---------------- */
  let selectedSmScreenId = null;
  const humanizeSmAction = WorkspaceAdapter.humanizeSmAction;
  const formatUsd = WorkspaceAdapter.formatUsd;

  function formatSmReliabilityWords(edge) {
    if (!edge) return "";
    if (edge.isDestructive) return "Needs approval";
    const tries = Number(edge.tries || 0);
    const ok = Number(edge.successes || 0);
    if (tries <= 0) return "Not tried yet";
    if (tries === 1) {
      return ok >= 1 ? "Worked" : "Did not finish";
    }
    return `Worked ${ok} of ${tries} times`;
  }

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
          title: "",
          message: "No screen transitions recorded yet. Open the notch at the top of your screen to run a computer-use task.",
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

    const agentOptionsHtml = [
      `<option value="" ${!smAgentFilter ? "selected" : ""}>All agents</option>`,
      ...sm.allAgents.map(
        (ag) => `<option value="${escapeHtml(ag)}" ${smAgentFilter === ag ? "selected" : ""}>${escapeHtml(ag)}</option>`
      ),
    ].join("");

    const appOptionsHtml = [
      `<option value="all" ${selectedAppFilter === "all" ? "selected" : ""}>All apps</option>`,
      ...sm.allApps.map(
        (app) => `<option value="${escapeHtml(app)}" ${selectedAppFilter === app ? "selected" : ""}>${escapeHtml(app)}</option>`
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
      function truncateWord(text, maxLen = 28) {
        const s = String(text || "").trim();
        if (s.length <= maxLen) return s;
        const slice = s.slice(0, maxLen);
        const lastSpace = slice.lastIndexOf(" ");
        if (lastSpace > Math.floor(maxLen * 0.45)) {
          return slice.slice(0, lastSpace).trimEnd() + "…";
        }
        return slice.trimEnd() + "…";
      }
      const wNode = 196;
      const hNode = 56;
      const colStep = 236;
      const rowStep = 148;
      const padX = 20;
      const pillW = 236;
      const pillH = 38;

      const screenIndex = new Map(sm.screens.map((s, i) => [s.id, i]));
      const adj = new Map(sm.screens.map((s) => [s.id, new Set()]));
      const outEdgesByNode = new Map(sm.screens.map((s) => [s.id, []]));
      const inDegree = new Map(sm.screens.map((s) => [s.id, 0]));

      for (const edge of sm.edges) {
        if (adj.has(edge.from) && adj.has(edge.to)) {
          adj.get(edge.from).add(edge.to);
          adj.get(edge.to).add(edge.from);
        }
        if (outEdgesByNode.has(edge.from)) {
          outEdgesByNode.get(edge.from).push(edge);
        }
        if (edge.from !== edge.to && inDegree.has(edge.to)) {
          inDegree.set(edge.to, inDegree.get(edge.to) + 1);
        }
      }

      /* Connected components in order of first appearance */
      const visitedComp = new Set();
      const components = [];
      for (const s of sm.screens) {
        if (visitedComp.has(s.id)) continue;
        const compIds = [];
        const queue = [s.id];
        visitedComp.add(s.id);
        while (queue.length) {
          const cur = queue.shift();
          compIds.push(cur);
          for (const nb of adj.get(cur) || []) {
            if (!visitedComp.has(nb)) {
              visitedComp.add(nb);
              queue.push(nb);
            }
          }
        }
        compIds.sort((a, b) => (screenIndex.get(a) ?? 0) - (screenIndex.get(b) ?? 0));
        components.push(compIds);
      }

      /* Side-by-side component grid so multi-app state machines fill wide viewports cleanly */
      const nodeLayout = new Map();
      const maxRowWidth = 1080;
      let currentX = padX;
      let currentY = 20;
      let rowMaxBottom = 20;
      let maxSvgWidth = 520;

      for (const compIds of components) {
        const compSet = new Set(compIds);
        const layerById = new Map();
        const roots = compIds.filter((id) => (inDegree.get(id) || 0) === 0);
        const bfsQueue = roots.length ? [...roots] : [compIds[0]];
        for (const r of bfsQueue) layerById.set(r, 0);

        while (bfsQueue.length) {
          const cur = bfsQueue.shift();
          const curLayer = layerById.get(cur) || 0;
          for (const edge of outEdgesByNode.get(cur) || []) {
            if (!compSet.has(edge.to)) continue;
            if (!layerById.has(edge.to)) {
              layerById.set(edge.to, curLayer + 1);
              bfsQueue.push(edge.to);
            }
          }
        }
        for (const id of compIds) {
          if (!layerById.has(id)) layerById.set(id, 0);
        }

        const layers = new Map();
        let maxLayer = 0;
        for (const id of compIds) {
          const layer = layerById.get(id) || 0;
          if (layer > maxLayer) maxLayer = layer;
          if (!layers.has(layer)) layers.set(layer, []);
          layers.get(layer).push(id);
        }

        let maxColsInComp = 1;
        for (const ids of layers.values()) {
          if (ids.length > maxColsInComp) maxColsInComp = ids.length;
        }

        const compEdges = sm.edges.filter((e) => compSet.has(e.from) && compSet.has(e.to));
        const hasSelfLoop = compEdges.some((e) => e.from === e.to);
        const backEdgeCount = compEdges.filter(
          (e) => e.from !== e.to && (layerById.get(e.to) || 0) <= (layerById.get(e.from) || 0)
        ).length;

        const compContentWidth = (maxColsInComp - 1) * colStep + wNode + (hasSelfLoop ? 240 : 120);
        if (currentX > padX && currentX + compContentWidth > maxRowWidth) {
          currentX = padX;
          currentY = rowMaxBottom + 24;
        }

        const compLeftX = currentX;
        const compTopY = currentY + 12;
        const compRightX = compLeftX + (maxColsInComp - 1) * colStep + wNode;
        const bottomPad = backEdgeCount > 0 ? 48 : 28;
        const compBottomY = compTopY + maxLayer * rowStep + hNode;

        for (let layer = 0; layer <= maxLayer; layer++) {
          const ids = layers.get(layer) || [];
          ids.forEach((id, colIdx) => {
            const x = compLeftX + colIdx * colStep;
            const y = compTopY + layer * rowStep;
            nodeLayout.set(id, {
              id,
              col: colIdx,
              row: layer,
              x,
              y,
              compTopY,
              compRightX,
              compBottomY,
            });
          });
        }

        const neededWidth = Math.max(520, compLeftX + compContentWidth + padX);
        if (neededWidth > maxSvgWidth) maxSvgWidth = neededWidth;
        if (compBottomY + bottomPad > rowMaxBottom) rowMaxBottom = compBottomY + bottomPad;
        currentX = compLeftX + compContentWidth + 24;
      }

      let svgWidth = maxSvgWidth;
      const svgHeight = Math.max(220, rowMaxBottom + 12);

      /* Group parallel edges between the same pair of nodes */
      const pairGroups = new Map();
      for (const edge of sm.edges) {
        const key = edge.from < edge.to ? `${edge.from}__${edge.to}` : `${edge.to}__${edge.from}`;
        if (!pairGroups.has(key)) pairGroups.set(key, []);
        pairGroups.get(key).push(edge);
      }

      const edgeIndexInPair = new Map();
      for (const list of pairGroups.values()) {
        list.forEach((edge, i) => {
          edgeIndexInPair.set(edge.id, { idx: i, count: list.length });
        });
      }

      function arrowPolygon(tipX, tipY, fromX, fromY, color) {
        const angle = Math.atan2(tipY - fromY, tipX - fromX);
        const len = 9;
        const wing = 5;
        const p1x = (tipX - len * Math.cos(angle) + wing * Math.sin(angle)).toFixed(1);
        const p1y = (tipY - len * Math.sin(angle) - wing * Math.cos(angle)).toFixed(1);
        const p2x = (tipX - len * Math.cos(angle) - wing * Math.sin(angle)).toFixed(1);
        const p2y = (tipY - len * Math.sin(angle) + wing * Math.cos(angle)).toFixed(1);
        return `<polygon points="${tipX.toFixed(1)},${tipY.toFixed(1)} ${p1x},${p1y} ${p2x},${p2y}" fill="${escapeHtml(color)}" />`;
      }

      function boxesOverlap(a, b, pad = 6) {
        return (
          a.x < b.x + b.w + pad &&
          a.x + a.w + pad > b.x &&
          a.y < b.y + b.h + pad &&
          a.y + a.h + pad > b.y
        );
      }

      /* Separate self-loops (attached to their screen node) from inter-screen edges */
      const selfLoopsByNode = new Map();
      const transitionEdges = [];
      for (const edge of sm.edges) {
        if (edge.from === edge.to) {
          if (!selfLoopsByNode.has(edge.from)) selfLoopsByNode.set(edge.from, []);
          selfLoopsByNode.get(edge.from).push(edge);
        } else {
          transitionEdges.push(edge);
        }
      }

      /* Reserve all node boxes (including attached self-loop footer height) before placing any label */
      const occupiedBoxes = [];
      for (const [nid, pos] of nodeLayout.entries()) {
        const hasAttached = (selfLoopsByNode.get(nid) || []).length > 0;
        occupiedBoxes.push({ x: pos.x, y: pos.y, w: wNode, h: hNode + (hasAttached ? 26 : 0) });
      }

      /* Precompute edge geometry */
      const edgeGeoms = [];
      let backEdgeSeq = 0;
      let skipEdgeSeq = 0;
      for (const edge of transitionEdges) {
        const fromPos = nodeLayout.get(edge.from);
        const toPos = nodeLayout.get(edge.to);
        if (!fromPos || !toPos) continue;

        const statusFill =
          edge.statusClass === "state-success"
            ? "#32d583"
            : edge.statusClass === "state-warning"
              ? "#f5a623"
              : "#a6adbb";
        const statusSymbol =
          edge.statusClass === "state-success"
            ? "✓"
            : edge.statusClass === "state-warning"
              ? "◔"
              : "○";
        const isSelectedEdge = selectedEdge && selectedEdge.id === edge.id;
        const isReplayHit =
          activeReplayStep &&
          ((activeReplayStep.fromId && edge.from === activeReplayStep.fromId && activeReplayStep.toId && edge.to === activeReplayStep.toId) ||
            (activeReplayStep.action && edge.action === activeReplayStep.action));

        const edgeStroke = isReplayHit
          ? "#f5a623"
          : isSelectedEdge
            ? "#f2f4f8"
            : edge.reliabilityColor || edge.trailColor || "#767d8e";
        const edgeWidth = isSelectedEdge || isReplayHit ? Math.max(3, edge.strokeWidth || 2.2) : edge.strokeWidth || 2.2;
        const dashAttr = edge.isDestructive ? 'stroke-dasharray="6 4"' : "";

        const plainAction = humanizeSmAction(edge.action, edge.app);
        const shortAction = truncateWord(plainAction, 26);
        const metaText = formatSmReliabilityWords(edge);

        let pathD = "";
        let labelX = 0;
        let labelY = 0;
        let arrowHtml = "";
        let bezierPts = null;

        if (toPos.row <= fromPos.row) {
          /* Backward / loop edge: route cleanly down the right side (or left if another node sits to the right of toPos) */
          backEdgeSeq += 1;
          const hasNodeRightOfFrom = Array.from(nodeLayout.values()).some(
            (p) => p.row === fromPos.row && p.x > fromPos.x
          );
          const hasNodeRightOfTo = Array.from(nodeLayout.values()).some(
            (p) => p.row === toPos.row && p.x > toPos.x
          );
          if (hasNodeRightOfFrom || hasNodeRightOfTo) {
            /* Route down the left side */
            const x1 = fromPos.x;
            const y1 = fromPos.y + hNode / 2;
            const x2 = toPos.x;
            const y2 = toPos.y + hNode / 2;
            const laneX = Math.max(8, Math.min(fromPos.x, toPos.x) - 34 - (backEdgeSeq - 1) * 28);
            const cx1 = laneX;
            const cy1 = y1;
            const cx2 = laneX;
            const cy2 = y2;
            pathD = `M ${x1} ${y1} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${x2} ${y2}`;
            bezierPts = [x1, y1, cx1, cy1, cx2, cy2, x2, y2];
            labelX = Math.max(pillW / 2 + 8, Math.round(0.125 * x1 + 0.375 * cx1 + 0.375 * cx2 + 0.125 * x2) - pillW / 2 - 8);
            labelY = Math.round(0.125 * y1 + 0.375 * cy1 + 0.375 * cy2 + 0.125 * y2);
            arrowHtml = arrowPolygon(x2, y2, cx2, cy2, edgeStroke);
          } else {
            const x1 = fromPos.x + wNode;
            const y1 = fromPos.y + hNode / 2;
            const x2 = toPos.x + wNode;
            const y2 = toPos.y + hNode / 2;
            const laneX = Math.max(fromPos.compRightX, toPos.compRightX) + 34 + (backEdgeSeq - 1) * 28;
            const cx1 = laneX;
            const cy1 = y1;
            const cx2 = laneX;
            const cy2 = y2;
            pathD = `M ${x1} ${y1} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${x2} ${y2}`;
            bezierPts = [x1, y1, cx1, cy1, cx2, cy2, x2, y2];
            labelX = Math.round(0.125 * x1 + 0.375 * cx1 + 0.375 * cx2 + 0.125 * x2) + pillW / 2 + 8;
            labelY = Math.round(0.125 * y1 + 0.375 * cy1 + 0.375 * cy2 + 0.125 * y2);
            arrowHtml = arrowPolygon(x2, y2, cx2, cy2, edgeStroke);
          }
        } else if (toPos.row - fromPos.row > 1) {
          /* Forward skip-layer edge: route around intermediate rows via right lane so it never crosses a node */
          skipEdgeSeq += 1;
          const x1 = fromPos.x + wNode;
          const y1 = fromPos.y + hNode / 2;
          const x2 = toPos.x + wNode;
          const y2 = toPos.y + hNode / 2;
          const laneX = Math.max(fromPos.compRightX, toPos.compRightX) + 34 + (backEdgeSeq + skipEdgeSeq - 1) * 28;
          pathD = `M ${x1} ${y1} C ${laneX} ${y1}, ${laneX} ${y2}, ${x2} ${y2}`;
          bezierPts = [x1, y1, laneX, y1, laneX, y2, x2, y2];
          labelX = Math.round(0.125 * x1 + 0.375 * laneX + 0.375 * laneX + 0.125 * x2) + pillW / 2 + 8;
          labelY = Math.round(0.125 * y1 + 0.375 * y1 + 0.375 * y2 + 0.125 * y2);
          arrowHtml = arrowPolygon(x2, y2, laneX, y2, edgeStroke);
        } else {
          /* Adjacent-layer forward edge: top-to-bottom cubic Bezier */
          const pairInfo = edgeIndexInPair.get(edge.id) || { idx: 0, count: 1 };
          const offset = (pairInfo.idx - (pairInfo.count - 1) / 2) * 44;
          const fromHasAttached = (selfLoopsByNode.get(edge.from) || []).length > 0;
          const x1 = fromPos.x + wNode / 2;
          const y1 = fromPos.y + hNode + (fromHasAttached ? 22 : 0);
          const x2 = toPos.x + wNode / 2;
          const y2 = toPos.y;
          const dy = Math.max(36, (y2 - y1) * 0.45);
          const cx1 = x1 + offset;
          const cy1 = y1 + dy;
          const cx2 = x2 + offset;
          const cy2 = y2 - dy;
          pathD = `M ${x1} ${y1} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${x2} ${y2}`;
          bezierPts = [x1, y1, cx1, cy1, cx2, cy2, x2, y2];
          labelX = Math.round(0.125 * x1 + 0.375 * cx1 + 0.375 * cx2 + 0.125 * x2);
          labelY = Math.round(0.125 * y1 + 0.375 * cy1 + 0.375 * cy2 + 0.125 * y2);
          arrowHtml = arrowPolygon(x2, y2, cx2, cy2, edgeStroke);
        }

        const sampledPts = [];
        if (bezierPts) {
          const [bx0, by0, bx1, by1, bx2, by2, bx3, by3] = bezierPts;
          for (let s = 1; s < 20; s++) {
            const t = s / 20;
            const u = 1 - t;
            const px = u * u * u * bx0 + 3 * u * u * t * bx1 + 3 * u * t * t * bx2 + t * t * t * bx3;
            const py = u * u * u * by0 + 3 * u * u * t * by1 + 3 * u * t * t * by2 + t * t * t * by3;
            sampledPts.push({ x: px, y: py });
          }
        }

        edgeGeoms.push({
          edge,
          statusFill,
          statusSymbol,
          isSelectedEdge,
          edgeStroke,
          edgeWidth,
          dashAttr,
          metaText,
          plainAction,
          shortAction,
          pathD,
          sampledPts,
          labelX,
          labelY,
          arrowHtml,
        });
      }

      let maxEdgeBottom = svgHeight;
      let maxEdgeRight = svgWidth;
      const edgesSvg = edgeGeoms
        .map((g, gIdx) => {
          const baseX = Math.max(8, g.labelX - pillW / 2);
          const baseY = Math.max(8, g.labelY - pillH / 2);

          function boxHitsOtherEdgePath(box) {
            for (let j = 0; j < edgeGeoms.length; j++) {
              if (j === gIdx) continue;
              for (const pt of edgeGeoms[j].sampledPts) {
                if (
                  pt.x >= box.x - 4 &&
                  pt.x <= box.x + box.w + 4 &&
                  pt.y >= box.y - 4 &&
                  pt.y <= box.y + box.h + 4
                ) {
                  return true;
                }
              }
            }
            return false;
          }

          /* Place label box so it never intersects any node, other label, or other edge path */
          let pillX = baseX;
          let pillY = baseY;
          const candidates = [{ x: baseX, y: baseY }];
          for (let step = 1; step <= 28; step++) {
            const dy = step * 16;
            const dx = step * 28;
            candidates.push({ x: baseX, y: baseY + dy });
            if (baseY - dy >= 8) candidates.push({ x: baseX, y: baseY - dy });
            candidates.push({ x: baseX + dx, y: baseY });
            if (baseX - dx >= 8) candidates.push({ x: baseX - dx, y: baseY });
            candidates.push({ x: baseX + dx, y: baseY + dy });
            if (baseY - dy >= 8) candidates.push({ x: baseX + dx, y: baseY - dy });
          }
          for (const cand of candidates) {
            const box = { x: cand.x, y: cand.y, w: pillW, h: pillH };
            if (!occupiedBoxes.some((occ) => boxesOverlap(box, occ, 6)) && !boxHitsOtherEdgePath(box)) {
              pillX = cand.x;
              pillY = cand.y;
              break;
            }
          }
          occupiedBoxes.push({ x: pillX, y: pillY, w: pillW, h: pillH });
          if (pillY + pillH + 12 > maxEdgeBottom) maxEdgeBottom = pillY + pillH + 12;
          if (pillX + pillW + 12 > maxEdgeRight) maxEdgeRight = pillX + pillW + 12;
          const textCenterX = pillX + pillW / 2;

          return `
            <g class="sm-edge-group ${g.isSelectedEdge ? "is-selected" : ""}" data-action="select-sm-edge" data-edge-id="${escapeHtml(g.edge.id)}" data-from-id="${escapeHtml(g.edge.from)}" data-to-id="${escapeHtml(g.edge.to)}" role="button" tabindex="0" aria-label="Inspect ${escapeHtml(g.plainAction)} from ${escapeHtml(g.edge.fromTitle)} to ${escapeHtml(g.edge.toTitle)} (${escapeHtml(g.metaText)})">
              <title>${escapeHtml(g.edge.fromTitle)} → ${escapeHtml(g.edge.toTitle)}: ${escapeHtml(g.plainAction)} (${escapeHtml(g.metaText)})</title>
              <path class="sm-edge-path" d="${g.pathD}" fill="none" stroke="${escapeHtml(g.edgeStroke)}" stroke-width="${g.edgeWidth}" ${g.dashAttr} />
              ${g.arrowHtml}
              <rect class="sm-edge-pill" x="${pillX}" y="${pillY}" width="${pillW}" height="${pillH}" rx="6" fill="#0c0d10" stroke="${g.isSelectedEdge ? "#f2f4f8" : "rgba(255,255,255,0.08)"}" stroke-width="1" />
              <text x="${textCenterX}" y="${pillY + 15}" text-anchor="middle" font-size="12" font-weight="600">
                <tspan fill="${g.statusFill}">${escapeHtml(g.statusSymbol)}</tspan>
                <tspan fill="#f2f4f8"> ${escapeHtml(g.shortAction)}</tspan>
              </text>
              <circle cx="${pillX + 12}" cy="${pillY + 28}" r="4" fill="${escapeHtml(g.edge.trailColor)}" />
              <text x="${textCenterX + 4}" y="${pillY + 32}" text-anchor="middle" fill="#a6adbb" font-size="12">
                ${escapeHtml(truncateWord(g.metaText, 28))}
              </text>
            </g>
          `;
        })
        .join("");

      svgWidth = maxEdgeRight;

      const nodesSvg = sm.screens
        .map((node) => {
          const pos = nodeLayout.get(node.id);
          if (!pos) return "";
          const isReplayNode =
            activeReplayStep &&
            (activeReplayStep.fromId === node.id || activeReplayStep.toId === node.id);
          const isSelectedNode =
            (selectedEdge && (selectedEdge.from === node.id || selectedEdge.to === node.id)) ||
            selectedSmScreenId === node.id;
          const nodeStroke = isReplayNode
            ? "#f5a623"
            : isSelectedNode
              ? "#f2f4f8"
              : "rgba(255,255,255,0.16)";
          const nodeStrokeWidth = isReplayNode || isSelectedNode ? "2" : "1";
          const shortApp = truncateWord(node.app, 22);
          const shortTitle = truncateWord(node.title, 22);
          const nodeSelfLoops = selfLoopsByNode.get(node.id) || [];
          const totalSelfTries = nodeSelfLoops.reduce((acc, e) => acc + Number(e.tries || 1), 0);
          const attachedHtml = nodeSelfLoops.length
            ? `
              <g class="sm-attached-actions" data-action="select-sm-screen-actions" data-screen-id="${escapeHtml(node.id)}" role="button" tabindex="0" aria-label="${totalSelfTries} actions on ${escapeHtml(node.title)}">
                <rect x="${pos.x + 8}" y="${pos.y + hNode + 2}" width="${wNode - 16}" height="20" rx="5" fill="#16181d" stroke="${selectedSmScreenId === node.id ? "#f2f4f8" : "rgba(255,255,255,0.12)"}" stroke-width="1" />
                <text x="${pos.x + wNode / 2}" y="${pos.y + hNode + 16}" text-anchor="middle" fill="#a6adbb" font-size="12">${totalSelfTries} ${totalSelfTries === 1 ? "action" : "actions"} on this screen &#9656;</text>
              </g>
            `
            : "";

          return `
            <g class="sm-node-group">
              <title>${escapeHtml(node.app)}: ${escapeHtml(node.title)}</title>
              <rect class="sm-node-rect" data-node-id="${escapeHtml(node.id)}" x="${pos.x}" y="${pos.y}" width="${wNode}" height="${hNode}" rx="8" fill="#16181d" stroke="${nodeStroke}" stroke-width="${nodeStrokeWidth}" />
              <text x="${pos.x + 12}" y="${pos.y + 21}" fill="#767d8e" font-size="12" font-weight="600">${escapeHtml(shortApp)}</text>
              <text x="${pos.x + 12}" y="${pos.y + 41}" fill="#f2f4f8" font-size="13" font-weight="600">${escapeHtml(shortTitle)}</text>
              ${attachedHtml}
            </g>
          `;
        })
        .join("");

      svgGraphHtml = `
        <div class="sm-graph-wrap">
          <svg class="sm-svg" viewBox="0 0 ${svgWidth} ${maxEdgeBottom}" role="img" aria-label="Agent state machine screen transitions">
            ${edgesSvg}
            ${nodesSvg}
          </svg>
        </div>
      `;
    }

    /* Clicked edge or attached screen actions detail */
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
                    : "state-neutral";
              const outSymbol =
                out === "ok" || out === "done_verified"
                  ? "✓ Worked"
                  : out === "help"
                    ? "◔ Waiting"
                    : out === "denied"
                      ? "Stopped by you"
                      : "Did not finish";
              const timeStr = r.ts
                ? new Date(r.ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
                : "—";
              return `
                <tr>
                  <td>${escapeHtml(timeStr)}</td>
                  <td>${escapeHtml(r.agent || "Agent")}</td>
                  <td><span class="state-text ${outClass}">${outSymbol}</span></td>
                  <td class="num-col">${escapeHtml(r.ms ?? 0)}ms</td>
                </tr>
              `;
            })
            .join("")
        : `<tr><td colspan="4" class="section-subtitle">No individual action rows recorded for this transition.</td></tr>`;

      edgeLogHtml = `
        <div class="sm-edge-detail">
          <div class="section-header-row">
            <div>
              <h3 class="section-title">${escapeHtml(humanizeSmAction(selectedEdge.action, selectedEdge.app))}</h3>
              <p class="section-subtitle">
                ${escapeHtml(selectedEdge.fromTitle)} &rarr; ${escapeHtml(selectedEdge.toTitle)} &middot; ${escapeHtml(formatSmReliabilityWords(selectedEdge))}
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
                  <th class="num-col">Duration</th>
                </tr>
              </thead>
              <tbody>${rowsHtml}</tbody>
            </table>
          </div>
        </div>
      `;
    } else if (selectedSmScreenId) {
      const screenNode = sm.screens.find((s) => s.id === selectedSmScreenId);
      const screenSelfLoops = sm.edges.filter((e) => e.from === selectedSmScreenId && e.to === selectedSmScreenId);
      if (screenNode && screenSelfLoops.length) {
        const listHtml = screenSelfLoops
          .map(
            (e) => `
              <div class="history-row-2line">
                <div class="history-row-goal">${escapeHtml(humanizeSmAction(e.action, e.app))}</div>
                <div class="history-row-meta">
                  <span>${escapeHtml(formatSmReliabilityWords(e))}</span>
                  <span>&middot;</span>
                  <span>${escapeHtml(e.agents.join(", ") || "Agent")}</span>
                </div>
              </div>
            `
          )
          .join("");
        edgeLogHtml = `
          <div class="sm-edge-detail">
            <div class="section-header-row">
              <div>
                <h3 class="section-title">Actions on ${escapeHtml(screenNode.title)}</h3>
                <p class="section-subtitle">${escapeHtml(screenNode.app)}</p>
              </div>
              <button type="button" class="btn" data-action="close-sm-screen-actions">Close</button>
            </div>
            <div class="history-list">${listHtml}</div>
          </div>
        `;
      }
    }

    const screenCount = stats.screens ?? sm.screens.length;
    const actionCount = sm.totalFilteredActions ?? sm.edges.length;
    const skillCount = stats.skills ?? 0;
    const summaryParts = [
      `${screenCount} ${screenCount === 1 ? "screen" : "screens"}`,
      `${actionCount} ${actionCount === 1 ? "action" : "actions"}`,
    ];
    if (stats.mean_edge_p != null) {
      summaryParts.push(`works ${Math.round(Number(stats.mean_edge_p) * 100)}% of the time`);
    }
    summaryParts.push(`${skillCount} saved ${skillCount === 1 ? "shortcut" : "shortcuts"}`);

    container.innerHTML = `
      ${renderViewStatusNoticesHtml(vm)}
      <div class="sm-compact-controls">
        <span class="sm-summary-line">${escapeHtml(summaryParts.join(" · "))}</span>
        <div class="filter-group">
          <label for="sm-app-select" class="visually-hidden">Filter by app</label>
          <select id="sm-app-select" class="sm-filter-select" data-action="set-sm-app-select">
            ${appOptionsHtml}
          </select>
          <label for="sm-agent-select" class="visually-hidden">Filter by agent</label>
          <select id="sm-agent-select" class="sm-filter-select" data-action="set-sm-agent-select">
            ${agentOptionsHtml}
          </select>
        </div>
      </div>

      ${svgGraphHtml}
      ${edgeLogHtml}
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
          title: "",
          message: "No transcripts yet. Open the notch at the top of your screen to run your first task.",
        })}
      `;
      return;
    }

    const statusChips = [
      { key: "all", label: "All" },
      { key: "running", label: "▶ Running" },
      { key: "waiting", label: "◔ Waiting" },
      { key: "success", label: "✓ Success" },
      { key: "failed", label: "Did not finish" },
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

            const renderCombinedTranscriptEntries = (eventsList) => {
              if (!eventsList.length) return `<div>No events recorded yet.</div>`;
              const blocks = [];
              let i = 0;
              while (i < eventsList.length) {
                const ev = eventsList[i];
                if (ev.kind === "act") {
                  const agent = ev.agentName || "Agent";
                  const group = [];
                  while (i < eventsList.length && eventsList[i].kind === "act" && (eventsList[i].agentName || "Agent") === agent) {
                    group.push(eventsList[i]);
                    i += 1;
                  }
                  const timeHint = group[group.length - 1]?.timeText || group[0]?.timeText || "";
                  const stepWord = group.length === 1 ? "step" : "steps";
                  const headerParts = ["Work", agent, `${group.length} ${stepWord}`];
                  if (timeHint) headerParts.push(timeHint);
                  blocks.push(`
                    <details class="transcript-work-fold">
                      <summary class="transcript-work-summary">${escapeHtml(headerParts.join(" · "))}</summary>
                      <div class="transcript-work-steps">
                        ${group.map((st) => `<div>${escapeHtml(st.summary)}</div>`).join("")}
                      </div>
                    </details>
                  `);
                } else {
                  blocks.push(
                    `<div>[${escapeHtml(ev.timeText || "0.0s")}] ${escapeHtml(ev.agentName)} · ${escapeHtml(ev.label)}: ${escapeHtml(ev.summary)}</div>`
                  );
                  i += 1;
                }
              }
              return blocks.join("");
            };

            const eventsHtml = isExpanded
              ? `
                <div class="transcript-events-panel">
                  ${
                    g.resultSummary
                      ? `<div class="filter-group" style="margin-bottom:8px;">${renderCopyButton(`log-result:${g.id}`, "Copy result", g.resultSummary)}</div>`
                      : ""
                  }
                  ${renderCombinedTranscriptEntries(g.combinedEvents)}
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
                    ${(() => {
                      const failedChild = g.childNodes.find((c) => c.status?.filterKey === "failed")?.resultSummary;
                      const st = formatUiStatusDisplay(
                        g.overallStatus,
                        g.overallStatus?.filterKey === "failed" ? (failedChild || g.resultSummary) : g.resultSummary
                      );
                      const showRes = g.resultSummary && g.resultSummary !== st.text;
                      return `<span class="state-text ${escapeHtml(st.colorClass)}">${escapeHtml(st.text)}</span>
                    <span class="transcript-goal">${escapeHtml(g.goal)}</span>
                    ${showRes ? `<span class="transcript-result">&middot; ${escapeHtml(g.resultSummary)}</span>` : ""}`;
                    })()}
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
        <p class="section-subtitle">
          Every run newest first: prompt, attachments, agents, status, result, and time
        </p>
        <div class="filter-group" role="group" aria-label="Transcript or history view">
          <button type="button" class="btn btn-active" aria-pressed="true" data-action="switch-view" data-target-view="logs">Transcript</button>
          <button type="button" class="btn" aria-pressed="false" data-action="switch-view" data-target-view="history">History</button>
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
    const marketingRuns = Array.isArray(vm.marketingRuns) ? vm.marketingRuns : [];

    if (selectedMarketingRunId) {
      const activeMkt = marketingRuns.find((r) => r.runId === selectedMarketingRunId);
      if (activeMkt) {
        container.innerHTML = renderMarketingArtifactDetailHtml(vm, activeMkt);
        return;
      }
      selectedMarketingRunId = null;
    }

    const existingMktTaskIds = new Set(
      artifacts
        .filter((a) => a.kind === "marketing" || a.detail?.brief)
        .map((a) => a.taskId)
        .filter(Boolean)
    );
    const extraMarketingRows = marketingRuns
      .filter((m) => !existingMktTaskIds.has(m.runId))
      .map((m) => ({
        id: `mkt:${m.runId}`,
        kind: "marketing",
        kindLabel: "Marketing",
        taskId: m.runId,
        taskGoal: m.goal,
        agentName: m.agentName,
        agentPalette: m.agentPalette,
        statusObj: m.status,
        timeText: m.elapsedText,
        detail: {
          tagline: m.tagline,
          brief: {
            launch_script: m.launchScript,
            shot_list: m.shotList,
            palette: m.palette,
          },
        },
        _marketingRunId: m.runId,
      }));
    const combinedArtifacts = [...artifacts, ...extraMarketingRows];

    if (!combinedArtifacts.length) {
      container.innerHTML = `
        ${renderViewStatusNoticesHtml(vm)}
        <div class="section-header-row">
          <p class="section-subtitle">Reports, patches, commits, files, and marketing results produced by agents</p>
        </div>
        ${renderEmptyStateHtml({
          title: "",
          message: "No artifacts produced yet.",
        })}
      `;
      return;
    }

    const rowsHtml = combinedArtifacts
      .map((item) => {
        const mktRun =
          item.kind === "marketing" || item._marketingRunId
            ? marketingRuns.find((r) => r.runId === (item._marketingRunId || item.taskId))
            : null;
        if (mktRun) {
          return `
            <div class="artifact-row">
              <button
                type="button"
                class="artifact-row-btn"
                data-action="open-marketing-artifact"
                data-run-id="${escapeHtml(mktRun.runId)}"
              >
                <span class="artifact-row-main">
                  <span class="state-text ${escapeHtml(item.statusObj.colorClass)}">${escapeHtml(item.statusObj.symbolWord)}</span>
                  <strong>${escapeHtml(item.kindLabel || "Marketing")}</strong>
                  <span class="inline-badge">
                    <span class="agent-color-dot" style="background:${escapeHtml(item.agentPalette?.body || "#767d8e")};"></span>
                    <span>${escapeHtml(item.agentName)}</span>
                  </span>
                  <span class="section-subtitle">${escapeHtml(item.taskGoal)}</span>
                </span>
                <span class="artifact-row-meta">
                  <span>${escapeHtml(item.timeText || "")}</span>
                  <span>Open</span>
                </span>
              </button>
            </div>
          `;
        }
        const isExpanded = expandedArtifactIds.has(item.id);
        let detailHtml = "";
        let artifactCopyText = "";
        let artifactCopyLabel = "Copy";
        let artifactOpenUrl = "";
        if (isExpanded) {
          if (item.kind === "bug_report") {
            const bugs = item.detail?.bugs || [];
            if (bugs.length) {
              artifactCopyLabel = "Copy report";
              artifactCopyText = bugs
                .map((b) => {
                  const head = `${WorkspaceAdapter.sentenceCase(b.severity || "med")} · ${b.title || "Bug"}${
                    b.file_hint ? ` (${b.file_hint})` : ""
                  }`;
                  return b.evidence ? `${head}\n${b.evidence}` : head;
                })
                .join("\n\n");
            }
            detailHtml = bugs.length
              ? bugs
                  .map(
                    (b) => `
                    <div>
                      <strong>${escapeHtml(WorkspaceAdapter.sentenceCase(b.severity || "med"))}</strong> · ${escapeHtml(b.title || "Bug")}
                      ${b.file_hint ? ` <span class="section-subtitle">(${escapeHtml(b.file_hint)})</span>` : ""}
                      ${b.evidence ? `<div class="section-subtitle">${escapeHtml(b.evidence)}</div>` : ""}
                    </div>
                  `
                  )
                  .join("")
              : `<div class="section-subtitle">No bugs found in this round.</div>`;
          } else if (item.kind === "patch") {
            const d = item.detail || {};
            artifactCopyLabel = "Copy patch";
            artifactCopyText = String(d.diff || d.explanation || "").trim();
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
            artifactCopyLabel = "Copy output";
            artifactCopyText = String(d.out || (Array.isArray(d.files) ? d.files.join("\n") : "")).trim();
            detailHtml = `
              <div>
                <span class="state-text ${d.ok ? "state-success" : "state-neutral"}">${d.ok ? "✓ Committed" : "○ Couldn't commit"}</span>
                ${d.files && d.files.length ? ` · ${escapeHtml(d.files.join(", "))}` : ""}
              </div>
              ${d.out ? `<pre class="artifact-diff-pre">${escapeHtml(d.out)}</pre>` : ""}
            `;
          } else {
            const d = item.detail || {};
            const brief = d.brief;
            if (isReachableUrl(d.src)) artifactOpenUrl = d.src;
            else if (isReachableUrl(d.url)) artifactOpenUrl = d.url;
            if (brief) {
              artifactCopyLabel = "Copy brief";
              const parts = [];
              if (d.tagline) parts.push(`Tagline: ${d.tagline}`);
              if (brief.launch_script) parts.push(`Launch script:\n${brief.launch_script}`);
              if (Array.isArray(brief.shot_list) && brief.shot_list.length) {
                parts.push(`Shot list:\n${brief.shot_list.map((s, idx) => `${idx + 1}. ${s}`).join("\n")}`);
              }
              artifactCopyText = parts.join("\n\n");
            } else if (d.tagline) {
              artifactCopyLabel = "Copy brief";
              artifactCopyText = d.tagline;
            }
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
                  : d.path && !artifactOpenUrl
                    ? `<div class="section-subtitle">Stored on this Mac and cannot be opened directly from this page.</div>`
                    : ""
              }
            `;
          }
        }

        const copyBtnHtml = artifactCopyText
          ? renderCopyButton(`artifact:${item.id}`, artifactCopyLabel, artifactCopyText)
          : "";
        const openLinkHtml = artifactOpenUrl
          ? `<a href="${escapeHtml(artifactOpenUrl)}" target="_blank" rel="noopener noreferrer" class="btn">Open</a>`
          : "";

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
                    <div class="filter-group">
                      ${copyBtnHtml}
                      ${openLinkHtml}
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
        <p class="section-subtitle">Reports, patches, commits, and marketing results produced by agents</p>
      </div>
      <div class="artifact-list">
        ${rowsHtml}
      </div>
    `;
  }

  /* ---------------- MARKETING ARTIFACT DETAIL ---------------- */
  function renderMarketingArtifactDetailHtml(vm, activeMkt) {

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
                shot.isRenderable && isReachableUrl(shot.src)
                  ? `
                    <div class="marketing-screenshot-item">
                      <img src="${escapeHtml(shot.src)}" alt="${escapeHtml(shot.fileName || "Marketing screenshot")}" class="marketing-screenshot-img" />
                      <div class="section-header-row">
                        <span class="section-subtitle">${escapeHtml(shot.fileName)}</span>
                        <a href="${escapeHtml(shot.src)}" target="_blank" rel="noopener noreferrer" class="btn">Open</a>
                      </div>
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

    const briefParts = [];
    if (activeMkt.tagline) briefParts.push(`Tagline: ${activeMkt.tagline}`);
    if (activeMkt.launchScript) briefParts.push(`Launch script:\n${activeMkt.launchScript}`);
    if (activeMkt.shotList.length) {
      briefParts.push(`Shot list:\n${activeMkt.shotList.map((s, idx) => `${idx + 1}. ${s}`).join("\n")}`);
    }
    if (activeMkt.palette.length) {
      briefParts.push(`Palette: ${activeMkt.palette.join(", ")}`);
    }
    const fullBriefText = briefParts.join("\n\n");
    const copyBriefBtn = fullBriefText
      ? renderCopyButton(`marketing-brief:${activeMkt.runId}`, "Copy brief", fullBriefText)
      : "";
    const copyScriptBtn = activeMkt.launchScript
      ? renderCopyButton(`marketing-script:${activeMkt.runId}`, "Copy script", activeMkt.launchScript)
      : "";

    return `
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
        <div class="filter-group">
          ${copyBriefBtn}
          <button type="button" class="btn" data-action="close-marketing-artifact">&larr; Back to artifacts</button>
        </div>
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
                <div class="section-header-row">
                  <h3 class="section-title">Launch script</h3>
                  ${copyScriptBtn}
                </div>
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
          title: "",
          message: "No tasks recorded yet. Open the notch at the top of your screen to run your first task.",
        })}
      `;
      return;
    }

    const reliabilityValue =
      gs.mean_edge_p != null ? `${Math.round(Number(gs.mean_edge_p) * 100)}% of the time` : "—";

    const summaryStripHtml = hasRecordedAnalytics
      ? `
        <div class="metrics-strip">
          <div class="metric-item">
            <span class="metric-label">Tasks</span>
            <span class="metric-value">${escapeHtml(an.tasks)}</span>
          </div>
          <div class="metric-item">
            <span class="metric-label">Model calls</span>
            <span class="metric-value">${escapeHtml(an.llm_calls)}</span>
          </div>
          <div class="metric-item">
            <span class="metric-label">Spent</span>
            <span class="metric-value">${formatUsd(an.cost_usd)}</span>
          </div>
          <div class="metric-item">
            <span class="metric-label">Per task</span>
            <span class="metric-value">${formatUsd(an.mean_cost_per_task)}</span>
          </div>
          <div class="metric-item">
            <span class="metric-label">Works</span>
            <span class="metric-value">${escapeHtml(reliabilityValue)}</span>
          </div>
        </div>
      `
      : `
        <div class="filter-bar" style="padding: 10px 0; border-bottom: 1px solid var(--line-divider);">
          <span class="state-text state-neutral">&cir; No recorded model calls yet</span>
          <span class="section-subtitle">
            ${
              vm.isSampleData
                ? "This sample has 0 recorded tasks."
                : "0 recorded model calls so far."
            }
          </span>
        </div>
      `;

    /* Cost per task over time */
    const tasksWithCost = vm.taskGroups
      .filter((g) => g.cost && g.cost.cost_usd != null && (g.cost.cost_usd > 0 || g.cost.llm_calls > 0))
      .slice()
      .reverse();
    let spendChartHtml = "";
    if (tasksWithCost.length) {
      const rawMaxCost = Math.max(...tasksWithCost.map((g) => Number(g.cost.cost_usd || 0)), 0);
      const allZeroCost = rawMaxCost <= 0;
      const maxCost = allZeroCost ? 0 : rawMaxCost;
      const chartH = 148;
      const topPad = 20;
      const bottomPad = 26;
      const plotH = chartH - topPad - bottomPad;
      const leftPad = 56;
      const rightPad = 16;
      const count = tasksWithCost.length;
      const barW = Math.min(64, Math.max(28, Math.floor(560 / Math.max(count, 1)) - 14));
      const gap = Math.max(12, Math.min(28, Math.floor(140 / Math.max(count, 1))));
      const chartW = Math.max(540, leftPad + rightPad + count * (barW + gap));
      const plotW = chartW - leftPad - rightPad;
      const midCost = maxCost / 2;
      const baselineY = topPad + plotH;
      const midY = topPad + plotH / 2;
      const barsSvg = tasksWithCost
        .map((g, i) => {
          const val = Number(g.cost.cost_usd || 0);
          const h = allZeroCost ? 2 : (val > 0 ? Math.max(6, Math.round((val / maxCost) * plotH)) : 2);
          const stepW = plotW / count;
          const x = Math.round(leftPad + i * stepW + (stepW - barW) / 2);
          const y = baselineY - h;
          const shortGoal = String(g.goal || `Task ${i + 1}`).trim();
          const axisLabel = shortGoal.length > 14 ? shortGoal.slice(0, 13).trimEnd() + "…" : shortGoal;
          const costLabel = formatUsd(val);
          return `
            <g>
              <rect x="${x}" y="${y}" width="${barW}" height="${h}" rx="4" fill="#a6adbb" opacity="0.82">
                <title>${escapeHtml(shortGoal)}: ${escapeHtml(costLabel)}</title>
              </rect>
              <text x="${x + barW / 2}" y="${Math.max(12, y - 5)}" text-anchor="middle" fill="#f2f4f8" font-size="11">${escapeHtml(costLabel)}</text>
              <text x="${x + barW / 2}" y="${chartH - 6}" text-anchor="middle" fill="#a6adbb" font-size="11">${escapeHtml(axisLabel)}<title>${escapeHtml(shortGoal)}</title></text>
            </g>
          `;
        })
        .join("");
      const axisGridSvg = allZeroCost
        ? `
            <line x1="${leftPad}" y1="${baselineY}" x2="${chartW - rightPad}" y2="${baselineY}" stroke="rgba(255,255,255,0.16)" />
            <text x="${leftPad - 8}" y="${baselineY + 4}" text-anchor="end" fill="#7d8495" font-size="11">$0</text>
          `
        : `
            <line x1="${leftPad}" y1="${topPad}" x2="${chartW - rightPad}" y2="${topPad}" stroke="rgba(255,255,255,0.08)" stroke-dasharray="3 3" />
            <line x1="${leftPad}" y1="${midY}" x2="${chartW - rightPad}" y2="${midY}" stroke="rgba(255,255,255,0.08)" stroke-dasharray="3 3" />
            <line x1="${leftPad}" y1="${baselineY}" x2="${chartW - rightPad}" y2="${baselineY}" stroke="rgba(255,255,255,0.16)" />
            <text x="${leftPad - 8}" y="${topPad + 4}" text-anchor="end" fill="#7d8495" font-size="11">${escapeHtml(formatUsd(maxCost))}</text>
            <text x="${leftPad - 8}" y="${midY + 4}" text-anchor="end" fill="#7d8495" font-size="11">${escapeHtml(formatUsd(midCost))}</text>
            <text x="${leftPad - 8}" y="${baselineY + 4}" text-anchor="end" fill="#7d8495" font-size="11">$0</text>
          `;
      spendChartHtml = `
        <div class="analytics-spark-wrap">
          <div class="section-header-row">
            <span class="filter-label">Cost per task</span>
            <span class="section-subtitle">${tasksWithCost.length} ${tasksWithCost.length === 1 ? "task" : "tasks"}</span>
          </div>
          <svg class="analytics-spark-svg" viewBox="0 0 ${chartW} ${chartH}" role="img" aria-label="Cost per task">
            ${axisGridSvg}
            ${barsSvg}
          </svg>
        </div>
      `;
    }

    /* Decide spend share cue */
    const purposes = Array.isArray(an?.by_purpose) ? an.by_purpose : [];
    const totalPurposeSpend = purposes.reduce((sum, p) => sum + Number(p.cost_usd || 0), 0);
    const decideRow = purposes.find((p) => String(p.purpose || "").toLowerCase() === "decide");
    const decidePct =
      totalPurposeSpend > 0 && decideRow
        ? Math.round((Number(decideRow.cost_usd || 0) / totalPurposeSpend) * 100)
        : null;
    const decideCueHtml =
      decidePct != null && decidePct >= 65
        ? `<p class="section-subtitle">Most of the cost (${decidePct}%) is the model deciding each step.</p>`
        : "";

    const taskRowsHtml = vm.taskGroups.length
      ? vm.taskGroups
          .map((g) => {
            const c = g.cost;
            if (!c || (c.llm_calls === 0 && c.prompt_tokens === 0 && c.cost_usd === 0)) {
              return `
                <tr>
                  <td>${escapeHtml(g.goal)}</td>
                  <td>${(() => {
                    const st = formatUiStatusDisplay(g.overallStatus, g.resultSummary);
                    return `<span class="state-text ${escapeHtml(st.colorClass)}">${escapeHtml(st.text)}</span>`;
                  })()}</td>
                  <td class="num-col">${escapeHtml(g.allNodes.length)}</td>
                  <td class="num-col" colspan="4"><span class="section-subtitle">No model calls recorded (sample run or still starting)</span></td>
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
                <td class="num-col">${formatUsd(c.cost_usd)}</td>
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
                  <td class="num-col">${p.cost_usd != null ? `${formatUsd(p.cost_usd)} (${share})` : "—"}</td>
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
      ${summaryStripHtml}
      ${spendChartHtml}
      ${decideCueHtml}

      <div class="analytics-disclosures-list">
        <details class="analytics-disclosure">
          <summary class="analytics-disclosure-summary">
            <span class="analytics-disclosure-summary-left">Per-task cost and time</span>
            <span class="section-subtitle">${vm.taskGroups.length} ${vm.taskGroups.length === 1 ? "task" : "tasks"}</span>
          </summary>
          <div class="analytics-disclosure-body">
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
          </div>
        </details>

        <details class="analytics-disclosure">
          <summary class="analytics-disclosure-summary">
            <span class="analytics-disclosure-summary-left">Where the cost goes</span>
            <span class="section-subtitle">${decidePct != null ? `${decidePct}% is the model deciding each step` : "Breakdown"}</span>
          </summary>
          <div class="analytics-disclosure-body">
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
          </div>
        </details>

        <details class="analytics-disclosure">
          <summary class="analytics-disclosure-summary">
            <span class="analytics-disclosure-summary-left">How reliably each app works</span>
            <span class="section-subtitle">${Array.isArray(an?.by_app) ? `${an.by_app.length} apps` : "0 apps"} &middot; ${escapeHtml(gs.screens ?? 0)} screens</span>
          </summary>
          <div class="analytics-disclosure-body">
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
                        <th class="num-col">Did not finish</th>
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
          </div>
        </details>
      </div>
    `;

    const disclosures = Array.from(container.querySelectorAll(".analytics-disclosure"));
    for (const d of disclosures) {
      d.addEventListener("toggle", () => {
        if (d.open) {
          for (const other of disclosures) {
            if (other !== d && other.open) other.open = false;
          }
        }
      });
    }
  }

  /* ---------------- B4: ONBOARDING VIEW ---------------- */
  const ONBOARDING_VOICES = [
    { id: "", name: "System voice", note: "Default macOS spoken voice" },
    { id: "none", name: "No voice", note: "Mute spoken replies" },
  ];

  function getAvailableVoiceChoices() {
    const base = [...ONBOARDING_VOICES];
    if (Array.isArray(HistorySettingsState.shellVoices)) {
      for (const v of HistorySettingsState.shellVoices) {
        if (!v || !v.id) continue;
        if (!base.some((b) => b.id === v.id)) {
          base.push({
            id: String(v.id),
            name: String(v.name || v.id),
            note: v.language ? `On-device (${v.language})` : "On-device voice",
          });
        }
      }
    }
    return base;
  }

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
              <span class="section-subtitle">Complete step 1 below or open the notch at the top of your screen to start.</span>
            </div>
          </div>
        `
        : "";

    const step = Math.max(1, Math.min(OnboardingState.totalSteps, OnboardingState.step || 1));
    OnboardingState.step = step;

    const chosenSwatch = AGENT_SWATCHES[OnboardingState.swatchIndex % AGENT_SWATCHES.length];
    const previewSeed = stableSeed("preview:" + OnboardingState.agentName + ":" + chosenSwatch.name);

    const stepQuestions = [
      "Hi — what should I call you, and what name and color would you like for me?",
      "Which voice should I use for spoken replies?",
      "How should text, motion, and contrast look?",
      "Before I operate apps, let's check the three macOS permissions I need.",
      "Which display should hold the agent stage while I work?",
      "Sensitive actions always ask first. Here is the approval gate:",
      "Should I remember preferences across tasks?",
      "Ready to run your first task? Pick a starter prompt below.",
    ];

    function getStepReplySummary(sNum) {
      if (sNum === 1) {
        const who = OnboardingState.callMe.trim() || "No name set";
        const alias = getPrimaryAgentDisplayName("ComputerAnything");
        return `Call me: ${who} · Agent: ${alias} (${chosenSwatch.name})`;
      }
      if (sNum === 2) {
        const v = getAvailableVoiceChoices().find((item) => item.id === OnboardingState.voiceId);
        return v ? `Voice: ${v.name}` : "Voice: System voice";
      }
      if (sNum === 3) {
        const a = OnboardingState.a11y;
        const parts = [`Text: ${WorkspaceAdapter.sentenceCase(a.text_size.replace("_", " "))}`];
        if (a.high_contrast) parts.push("High contrast");
        if (a.reduce_motion) parts.push("Reduced motion");
        return parts.join(" · ");
      }
      if (sNum === 4) {
        return "Permissions reviewed (macOS asks when needed)";
      }
      if (sNum === 5) {
        if (OnboardingState.stageDisplay === "primary") return "Primary display";
        if (OnboardingState.stageDisplay === "ask") return "Ask each time";
        return "Secondary display";
      }
      if (sNum === 6) return "Sensitive categories ask first";
      if (sNum === 7) return OnboardingState.memoryEnabled ? "Memory allowed" : "Not now";
      return "Ready for first task";
    }

    const primaryAgentName = getPrimaryAgentDisplayName("ComputerAnything");
    const historyTurnsHtml = Array.from({ length: step - 1 }, (_, idx) => {
      const sNum = idx + 1;
      return `
        <div class="onboarding-chat-turn is-past">
          <div class="onboarding-agent-msg">
            <span class="agent-color-dot" style="background:${escapeHtml(chosenSwatch.body)};"></span>
            <span class="onboarding-agent-name">${escapeHtml(primaryAgentName)}</span>
            <span class="section-subtitle">${escapeHtml(stepQuestions[sNum - 1])}</span>
          </div>
          <div class="onboarding-user-reply">
            <span class="onboarding-reply-chip">${escapeHtml(getStepReplySummary(sNum))}</span>
            <button type="button" class="btn" data-action="goto-onboarding-step" data-step="${sNum}">Change</button>
          </div>
        </div>
      `;
    }).join("");

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
                  ? `<span class="state-text state-neutral">${escapeHtml(OnboardingState.profileSaveError)}</span>`
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
      const voicesHtml = getAvailableVoiceChoices().map((v) => {
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
          </div>
          <div class="filter-group" style="margin-top: 8px;">
            <button type="button" class="btn ${a11y.reduce_motion ? "btn-active" : ""}" data-action="toggle-a11y" data-a11y-key="reduce_motion">
              ${a11y.reduce_motion ? "✓ Reduced motion: on" : "○ Reduced motion: off"}
            </button>
            <button type="button" class="btn ${a11y.high_contrast ? "btn-active" : ""}" data-action="toggle-a11y" data-a11y-key="high_contrast">
              ${a11y.high_contrast ? "✓ High contrast: on" : "○ High contrast: off"}
            </button>
          </div>
        </div>
      `;
    } else if (step === 4) {
      const permItems = [
        {
          key: "accessibility",
          pane: "accessibility",
          label: "Accessibility",
          why: "Needed so agents can click, type, and act inside apps.",
        },
        {
          key: "screen_recording",
          pane: "screenRecording",
          label: "Screen Recording",
          why: "Needed so agents can read the screen and verify steps.",
        },
        {
          key: "app_scripting",
          pane: "automation",
          label: "App scripting",
          why: "Needed for app scripting and faster deterministic shortcuts.",
        },
      ];
      const permsHtml = permItems
        .map(
          (p) => `
            <div class="starter-prompt-row">
              <div>
                <div class="starter-prompt-text">${escapeHtml(p.label)}</div>
                <div class="section-subtitle">${escapeHtml(p.why)}</div>
              </div>
              <div class="filter-group">
                <button type="button" class="btn" data-action="open-settings-pane" data-pane="${escapeHtml(p.pane)}">Open System Settings</button>
              </div>
            </div>
          `
        )
        .join("");

      stepBodyHtml = `
        <div class="onboarding-block">
          <h3 class="section-title">Permissions</h3>
          <p class="section-subtitle">
            macOS asks when an agent first needs each permission. You can also open System Settings now.
          </p>
          <div class="starter-prompts-list">${permsHtml}</div>
          ${HistorySettingsState.paneStatus ? `<p class="section-subtitle">${escapeHtml(HistorySettingsState.paneStatus)}</p>` : ""}
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
            Sample preview (read-only; approval rules are not saved in ComputerAnything yet). Sensitive categories always ask first.
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
      stepBodyHtml = `
        <div class="onboarding-block">
          <h3 class="section-title">Memory</h3>
          <p class="section-subtitle">
            Sample preview (in-session only; memory is not saved in ComputerAnything yet). Remember things about me to work faster next time.
          </p>
          <div class="filter-group">
            <button type="button" class="btn ${OnboardingState.memoryEnabled ? "btn-active" : ""}" data-action="set-onboarding-memory" data-enabled="1">
              ${OnboardingState.memoryEnabled ? "✓ " : ""}Allow
            </button>
            <button type="button" class="btn ${!OnboardingState.memoryEnabled ? "btn-active" : ""}" data-action="set-onboarding-memory" data-enabled="0">
              ${!OnboardingState.memoryEnabled ? "✓ " : ""}Not now
            </button>
            ${
              OnboardingState.confirmForgetOnboardingMemory
                ? `
                  <div class="filter-group" role="group" aria-label="Confirm forgetting all memories">
                    <span class="section-subtitle">Forget all saved memories?</span>
                    <button type="button" class="btn btn-destructive" data-action="confirm-forget-onboarding-memory">Delete all</button>
                    <button type="button" class="btn" data-action="cancel-forget-onboarding-memory">Keep</button>
                  </div>
                `
                : `
                  <button type="button" class="btn btn-danger" data-action="forget-onboarding-memory">
                    Forget everything
                  </button>
                `
            }
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

    const canAdvanceFromPerms = true;

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
            Step ${step} of ${OnboardingState.totalSteps}: ${escapeHtml(stepQuestions[step - 1])}
          </p>
        </div>
        <div class="filter-group">
          <span class="provenance-tag">${step} of ${OnboardingState.totalSteps}</span>
        </div>
      </div>

      <div class="onboarding-chat" aria-label="Onboarding conversation">
        ${historyTurnsHtml}
        <div class="onboarding-chat-turn is-current">
          <div class="onboarding-agent-msg">
            <span class="agent-color-dot" style="background:${escapeHtml(chosenSwatch.body)};"></span>
            <span class="onboarding-agent-name">${escapeHtml(primaryAgentName)}</span>
            <span class="onboarding-agent-question">${escapeHtml(stepQuestions[step - 1])}</span>
          </div>
          <div class="onboarding-reply-chips">
            ${stepBodyHtml}
          </div>
          <div class="section-header-row onboarding-footer">
            <div class="filter-group">
              <button type="button" class="btn" data-action="prev-onboarding-step" ${step <= 1 ? "disabled" : ""}>Back</button>
              ${step < OnboardingState.totalSteps ? `<button type="button" class="btn" data-action="skip-onboarding-step">Skip</button>` : ""}
            </div>
            <div class="filter-group">
              ${
                step < OnboardingState.totalSteps
                  ? `<button type="button" class="btn btn-primary" data-action="next-onboarding-step" ${!canAdvanceFromPerms ? "disabled" : ""}>Continue</button>`
                  : `<button type="button" class="btn" data-action="switch-view" data-target-view="graph">Open agent graph</button>`
              }
            </div>
          </div>
        </div>
      </div>

      <p class="section-subtitle">
        Note: Your name and voice are saved to your ComputerAnything profile. Your primary agent name and color are saved in this browser. The agents it starts keep their own names and cursor colors.
      </p>
    `;

    mountGlassElementsIn(container, "b4-onboarding");

    const nextAliasInput = document.getElementById("onboarding-agent-name");
    if (nextAliasInput) {
      nextAliasInput.addEventListener("input", (e) => {
        OnboardingState.agentName = e.target.value;
        savePrimaryAgentChoice({ syncProfile: true });
        renderOnboardingView(getViewModel());
      });
      attachImeSafeEnter(nextAliasInput, () => {
        OnboardingState.agentName = nextAliasInput.value.trim();
        savePrimaryAgentChoice({ syncProfile: true });
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
      const uiStatus = formatUiStatusDisplay(g.overallStatus, g.resultSummary || g.primaryNode?.stateFact);
      const isSpike = costUsd !== null && costUsd >= 0.05;
      const hasDenied = (g.combinedEvents || []).some(
        (ev) => ev?.kind === "help" && /denied|deny/i.test(String(ev?.text || ev?.detail || ""))
      );
      const exceptionParts = [];
      if (isFailed) exceptionParts.push(uiStatus.text);
      if (hasDenied) exceptionParts.push("Denied action");
      if (isSpike) exceptionParts.push("Cost spike");
      return {
        id: g.id,
        runIds: (g.allNodes || []).map((n) => n.runId).filter(Boolean),
        goal: g.goal || "Untitled task",
        apps,
        outcomeKey: g.overallStatus?.filterKey || "running",
        outcomeLabel: uiStatus.text,
        outcomeColorClass: uiStatus.colorClass,
        costUsd,
        elapsedText: g.elapsedText || "—",
        hasException: exceptionParts.length > 0,
        exceptionNote: exceptionParts.join(" · "),
        canOpenRun: true,
      };
    });
    return { usingSample: false, rows };
  }

  function renderHistoryView(vm) {
    const container = document.getElementById("b5-content");
    if (!container) return;

    if (vm.connectionStatus === "loading" && !hasLoadedOnce) {
      container.innerHTML = renderLoadingSkeletonViewHtml("history");
      return;
    }

    if (vm.connectionStatus === "disconnected") {
      container.innerHTML = renderNotConnectedViewHtml({
        title: "History",
        subtitle: "Past tasks, outcomes, apps used, and cost",
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
        if (transcriptMatchRunIds && (transcriptMatchRunIds.has(row.id) || (row.runIds || []).some((rid) => transcriptMatchRunIds.has(rid)))) return true;
        const hay = `${row.goal} ${row.apps.join(" ")} ${row.outcomeLabel}`.toLowerCase();
        if (!hay.includes(query)) return false;
      }
      return true;
    });

    const historyRowsHtml = !rows.length
      ? `
        <div class="view-state-block" style="padding: 8px 0;">
          <span class="state-text state-neutral">&cir; No task history yet. Completed runs appear here after your first task.</span>
        </div>
      `
      : filteredRows.length
      ? filteredRows
          .map((row) => {
            const costText = formatUsd(row.costUsd);
            const appsText = row.apps.length ? row.apps.join(", ") : "General";
            return `
              <div class="history-row-2line">
                <div class="history-row-goal">${escapeHtml(row.goal)}</div>
                <div class="history-row-meta">
                  <span class="state-text ${escapeHtml(row.outcomeColorClass)}">${escapeHtml(row.outcomeLabel)}</span>
                  <span>&middot;</span>
                  <span>${escapeHtml(appsText)}</span>
                  <span>&middot;</span>
                  <span>${escapeHtml(costText)}</span>
                  ${row.canOpenRun ? `<button type="button" class="btn" data-action="open-run-in-graph" data-run-id="${escapeHtml(row.id)}">Open run</button>` : ""}
                </div>
              </div>
            `;
          })
          .join("")
      : `<p class="section-subtitle">No tasks match the current search and filters.</p>`;

    container.innerHTML = `
      ${renderViewStatusNoticesHtml(vm)}
      <div class="section-header-row">
        <p class="section-subtitle">${
          usingSample
            ? "Sample data — no live runs recorded yet."
            : "Past tasks, outcomes, apps used, and cost."
        }</p>
        <div class="filter-group" role="group" aria-label="Transcript or history view">
          <button type="button" class="btn" aria-pressed="false" data-action="switch-view" data-target-view="logs">Transcript</button>
          <button type="button" class="btn btn-active" aria-pressed="true" data-action="switch-view" data-target-view="history">History</button>
        </div>
      </div>

      <div class="filter-bar">
        <div class="inline-input-row" style="flex: 1; min-width: 200px; max-width: 340px;">
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
          <button type="button" class="btn ${outcomeFilter === "failed" ? "btn-active" : ""}" aria-pressed="${outcomeFilter === "failed" ? "true" : "false"}" data-action="set-history-outcome" data-outcome="failed">Did not finish</button>
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

      <div class="history-list">
        ${historyRowsHtml}
      </div>
    `;

    const nextSearchInput = document.getElementById("history-search-input");
    if (nextSearchInput) {
      nextSearchInput.addEventListener("input", (e) => {
        HistorySettingsState.searchQuery = e.target.value;
        scheduleTranscriptSearch(e.target.value);
        renderHistoryView(getViewModel());
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
  }

  function renderAgentSettingsView(vm) {
    const container = document.getElementById("b8-content");
    if (!container) return;

    if (vm.connectionStatus === "loading" && !hasLoadedOnce) {
      container.innerHTML = renderLoadingSkeletonViewHtml("agent-settings");
      return;
    }

    if (vm.connectionStatus === "disconnected") {
      container.innerHTML = renderNotConnectedViewHtml({
        title: "Agent settings",
        subtitle: "Primary agent identity and model preferences",
        connectionError: vm.connectionError,
      });
      attachConnectInputHandlers(container);
      return;
    }

    const activeFieldId = document.activeElement?.id || "";
    const activeCursor =
      activeFieldId === "settings-agent-name" && document.activeElement?.selectionStart != null
        ? document.activeElement.selectionStart
        : null;

    const draft = HistorySettingsState.profileDraft;
    const savedRow = HistorySettingsState.savedRow || "";
    const currentSwatch = getPrimaryAgentSwatch();
    const errorHtml = HistorySettingsState.profileSaveError
      ? `<span class="state-text state-neutral">${escapeHtml(HistorySettingsState.profileSaveError)}</span>`
      : "";

    const modelOptions = [
      { value: "", label: "Automatic" },
      { value: "google/gemini-4-argon", label: "Gemini 4 Argon" },
      { value: "google/gemini-4-hydrogen", label: "Gemini 4 Hydrogen" },
      { value: "google/gemini-3.5-flash-lite", label: "Gemini 3.5 Flash Lite" },
    ];
    if (draft.model && !modelOptions.some((o) => o.value === draft.model)) {
      modelOptions.push({ value: draft.model, label: draft.model });
    }
    const decideModelOptions = [
      { value: "", label: "Same as primary model" },
      { value: "google/gemini-3.5-flash-lite", label: "Gemini 3.5 Flash Lite (fast)" },
      { value: "google/gemini-4-argon", label: "Gemini 4 Argon" },
    ];
    if (draft.decide_model && !decideModelOptions.some((o) => o.value === draft.decide_model)) {
      decideModelOptions.push({ value: draft.decide_model, label: draft.decide_model });
    }

    const rowFeedback = (key) =>
      savedRow === key ? `<span class="settings-row-feedback" role="status">✓ Saved</span>` : "";

    container.innerHTML = `
      ${renderViewStatusNoticesHtml(vm)}
      <div class="section-header-row">
        <div>
          <h3 class="section-title">Primary agent</h3>
          <p class="section-subtitle">Name and color apply immediately across the workspace and notch.</p>
        </div>
        <span aria-live="polite">${errorHtml}</span>
      </div>

      <div class="settings-form-grid">
        <div class="onboarding-field">
          <label for="settings-agent-name" class="filter-label">Primary agent name ${rowFeedback("agent_name")}</label>
          <input
            type="text"
            id="settings-agent-name"
            class="inline-text-input"
            maxlength="60"
            placeholder="Primary orchestrator"
            value="${escapeHtml(OnboardingState.agentName)}"
          />
        </div>
        <div class="onboarding-field">
          <span class="filter-label">Color ${rowFeedback("agent_color")}</span>
          <div class="filter-group" role="group" aria-label="Primary agent color">
            ${AGENT_SWATCHES.map((sw) => {
              const selected = currentSwatch.key === sw.key;
              return `<button type="button" class="btn ${selected ? "btn-active" : ""}" data-action="select-swatch" data-swatch="${escapeHtml(sw.key)}" aria-pressed="${selected ? "true" : "false"}"><span class="agent-color-dot" style="background:${escapeHtml(sw.body)};"></span><span>${escapeHtml(sw.name)}</span></button>`;
            }).join("")}
          </div>
        </div>
      </div>

      <div class="section-header-row" style="margin-top: 10px;">
        <div>
          <h3 class="section-title">Models</h3>
          <p class="section-subtitle">Choose which Gemini model plans tasks and which runs each step.</p>
        </div>
      </div>

      <form id="agent-models-form" class="settings-form-grid">
        <div class="onboarding-field">
          <label for="settings-model" class="filter-label">Primary model ${rowFeedback("model")}</label>
          <select id="settings-model" name="model" class="inline-text-input">
            ${modelOptions
              .map(
                (opt) =>
                  `<option value="${escapeHtml(opt.value)}" ${draft.model === opt.value ? "selected" : ""}>${escapeHtml(opt.label)}</option>`
              )
              .join("")}
          </select>
        </div>

        <div class="onboarding-field">
          <label for="settings-decide-model" class="filter-label">Faster step model ${rowFeedback("decide_model")}</label>
          <select id="settings-decide-model" name="decide_model" class="inline-text-input">
            ${decideModelOptions
              .map(
                (opt) =>
                  `<option value="${escapeHtml(opt.value)}" ${draft.decide_model === opt.value ? "selected" : ""}>${escapeHtml(opt.label)}</option>`
              )
              .join("")}
          </select>
        </div>
      </form>
    `;

    const agentNameInput = document.getElementById("settings-agent-name");
    if (agentNameInput) {
      agentNameInput.addEventListener("input", (e) => {
        OnboardingState.agentName = e.target.value;
        savePrimaryAgentChoice({ syncProfile: true });
        HistorySettingsState.savedRow = "agent_name";
        renderNow();
      });
      if (activeFieldId === "settings-agent-name") {
        agentNameInput.focus();
        if (activeCursor != null) {
          try {
            agentNameInput.setSelectionRange(activeCursor, activeCursor);
          } catch {
            // Ignore
          }
        }
      }
    }

    const modelsForm = document.getElementById("agent-models-form");
    if (modelsForm) {
      ["model", "decide_model"].forEach((key) => {
        const inputEl = modelsForm.querySelector(`[name="${key}"]`);
        if (!inputEl) return;
        inputEl.addEventListener("change", async (e) => {
          HistorySettingsState.profileDraft[key] = e.target.value;
          await saveWorkspaceProfileSettings([key], key);
        });
      });
    }
  }

  function renderAppSettingsView(vm) {
    const container = document.getElementById("b10-content");
    if (!container) return;

    if (vm.connectionStatus === "loading" && !hasLoadedOnce) {
      container.innerHTML = renderLoadingSkeletonViewHtml("app-settings");
      return;
    }

    if (vm.connectionStatus === "disconnected") {
      container.innerHTML = renderNotConnectedViewHtml({
        title: "App settings",
        subtitle: "Personal preferences, notch shortcut, and macOS permissions",
        connectionError: vm.connectionError,
      });
      attachConnectInputHandlers(container);
      return;
    }

    const activeFieldId = document.activeElement?.id || "";
    const activeCursor =
      activeFieldId === "settings-call-me" && document.activeElement?.selectionStart != null
        ? document.activeElement.selectionStart
        : null;

    const draft = HistorySettingsState.profileDraft;
    const savedRow = HistorySettingsState.savedRow || "";
    const errorHtml = HistorySettingsState.profileSaveError
      ? `<span class="state-text state-neutral">${escapeHtml(HistorySettingsState.profileSaveError)}</span>`
      : "";

    const voiceOptions = getAvailableVoiceChoices().map((v) => ({
      value: v.id,
      label: v.name,
    }));
    if (draft.voice_id && !voiceOptions.some((o) => o.value === draft.voice_id)) {
      voiceOptions.push({ value: draft.voice_id, label: "Custom voice" });
    }

    const rowFeedback = (key) =>
      savedRow === key ? `<span class="settings-row-feedback" role="status">✓ Saved</span>` : "";

    const permButtons = [
      { pane: "accessibility", label: "Accessibility" },
      { pane: "screenRecording", label: "Screen Recording" },
      { pane: "microphone", label: "Microphone" },
      { pane: "speechRecognition", label: "Speech Recognition" },
      { pane: "automation", label: "Automation" },
    ];

    container.innerHTML = `
      ${renderViewStatusNoticesHtml(vm)}
      <div class="section-header-row">
        <div>
          <h3 class="section-title">You &amp; voice</h3>
          <p class="section-subtitle">How agents address you and which voice reads replies.</p>
        </div>
        <div class="filter-group">
          <span aria-live="polite">${errorHtml}</span>
          <button type="button" class="btn" data-action="switch-view" data-target-view="onboarding">Run setup again</button>
        </div>
      </div>

      <form id="app-settings-form" class="settings-form-grid">
        <div class="onboarding-field">
          <label for="settings-call-me" class="filter-label">What should agents call you? ${rowFeedback("call_me")}</label>
          <div class="inline-input-row">
            <input
              type="text"
              id="settings-call-me"
              name="call_me"
              class="inline-text-input"
              maxlength="200"
              placeholder="Your name"
              value="${escapeHtml(draft.call_me)}"
            />
            <button type="submit" class="btn btn-primary" ${HistorySettingsState.profileSaving ? "disabled" : ""}>
              ${HistorySettingsState.profileSaving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>

        <div class="onboarding-field">
          <label for="settings-voice-id" class="filter-label">Voice for spoken replies ${rowFeedback("voice_id")}</label>
          <select id="settings-voice-id" name="voice_id" class="inline-text-input">
            ${voiceOptions
              .map(
                (opt) =>
                  `<option value="${escapeHtml(opt.value)}" ${draft.voice_id === opt.value ? "selected" : ""}>${escapeHtml(opt.label)}</option>`
              )
              .join("")}
          </select>
        </div>
      </form>

      <div class="section-header-row" style="margin-top: 10px;">
        <div>
          <h3 class="section-title">Notch shortcut</h3>
          <p class="section-subtitle">Press Option-Space anywhere on macOS to open or close the notch.</p>
        </div>
        <span class="attachment-token">⌥ Space</span>
      </div>

      <div class="section-header-row" style="margin-top: 10px;">
        <div>
          <h3 class="section-title">macOS permissions</h3>
          <p class="section-subtitle">Open System Settings to grant or review each permission the app uses.</p>
        </div>
      </div>
      <div class="starter-prompts-list">
        ${permButtons
          .map((p) => {
            const st = HistorySettingsState.shellPermissions?.[p.pane];
            let stateHtml = "";
            if (st === "granted") {
              stateHtml = `<span class="state-text state-success">✓ Granted</span>`;
            } else if (st === "denied") {
              stateHtml = `<span class="state-text state-neutral">✕ Not granted</span>`;
            } else if (st === "notAsked") {
              stateHtml = `<span class="state-text state-neutral">○ Not asked yet</span>`;
            }
            return `
              <div class="starter-prompt-row">
                <span class="starter-prompt-text">${escapeHtml(p.label)}</span>
                <div class="filter-group">
                  ${stateHtml}
                  <button type="button" class="btn" data-action="open-settings-pane" data-pane="${escapeHtml(p.pane)}">Open System Settings</button>
                </div>
              </div>
            `;
          })
          .join("")}
      </div>
      ${
        HistorySettingsState.paneStatus
          ? `<p class="section-subtitle" style="margin-top: 6px;">${escapeHtml(HistorySettingsState.paneStatus)}</p>`
          : ""
      }
    `;

    const appForm = document.getElementById("app-settings-form");
    if (appForm) {
      const callMeEl = appForm.querySelector('[name="call_me"]');
      if (callMeEl) {
        callMeEl.addEventListener("input", (e) => {
          HistorySettingsState.profileDraft.call_me = e.target.value;
          HistorySettingsState.profileDirty = true;
          HistorySettingsState.savedRow = "";
          HistorySettingsState.profileSaveError = "";
        });
      }
      const voiceEl = appForm.querySelector('[name="voice_id"]');
      if (voiceEl) {
        voiceEl.addEventListener("change", async (e) => {
          HistorySettingsState.profileDraft.voice_id = e.target.value;
          await saveWorkspaceProfileSettings(["voice_id"], "voice_id");
        });
      }
      if (activeFieldId === "settings-call-me" && callMeEl) {
        callMeEl.focus();
        if (activeCursor != null) {
          try {
            callMeEl.setSelectionRange(activeCursor, activeCursor);
          } catch {
            // Ignore
          }
        }
      }
      appForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        await saveWorkspaceProfileSettings(["call_me"], "call_me");
      });
    }
  }

  function renderMemoryView(vm) {
    const container = document.getElementById("b9-content");
    if (!container) return;

    if (vm.connectionStatus === "loading" && !hasLoadedOnce) {
      container.innerHTML = renderLoadingSkeletonViewHtml("memory");
      return;
    }

    if (vm.connectionStatus === "disconnected") {
      container.innerHTML = renderNotConnectedViewHtml({
        title: "Memory",
        subtitle: "Saved facts agents remember across runs",
        connectionError: vm.connectionError,
      });
      attachConnectInputHandlers(container);
      return;
    }

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
      : `<p class="section-subtitle">${
          HistorySettingsState.memoryLive ? "No saved memories yet." : "No sample memories."
        }</p>`;

    container.innerHTML = `
      ${renderViewStatusNoticesHtml(vm)}
      <div class="section-header-row">
        <p class="section-subtitle">${
          HistorySettingsState.memoryLive
            ? "Saved memories. Forgetting a memory deletes it."
            : "Sample memories. Nothing here is saved."
        }</p>
        ${HistorySettingsState.memoryLive ? "" : `<span class="provenance-tag">Sample</span>`}
      </div>
      ${
        HistorySettingsState.memoryError
          ? `<p class="state-text state-neutral">${escapeHtml(HistorySettingsState.memoryError)}</p>`
          : ""
      }
      <div class="history-list">
        ${memoriesHtml}
      </div>
    `;

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

    if (currentView === "graph") {
      renderAgentGraphView(vm);
    } else if (currentView === "state-machine") {
      renderStateMachineView(vm);
    } else if (currentView === "logs") {
      renderTranscriptLogView(vm);
    } else if (currentView === "artifacts" || currentView === "marketing") {
      renderArtifactsView(vm);
    } else if (currentView === "analytics") {
      renderAnalyticsView(vm);
    } else if (currentView === "agent-settings" || currentView === "settings") {
      renderAgentSettingsView(vm);
    } else if (currentView === "app-settings") {
      renderAppSettingsView(vm);
    } else if (currentView === "history") {
      renderHistoryView(vm);
    } else if (currentView === "memory") {
      renderMemoryView(vm);
    } else if (currentView === "onboarding") {
      renderOnboardingView(vm);
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

  async function refreshShellAppSettingsData() {
    const [perms, voices] = await Promise.all([
      Transport.getPermissions(),
      Transport.listVoices(),
    ]);
    let changed = false;
    if (perms) {
      HistorySettingsState.shellPermissions = perms;
      changed = true;
    }
    if (voices) {
      HistorySettingsState.shellVoices = voices;
      changed = true;
    }
    if (changed && (currentView === "app-settings" || currentView === "onboarding")) {
      renderNow();
    }
  }

  function handleShellSetView(viewName) {
    hasShellSetView = true;
    viewMenuOpen = false;
    setView(viewName);
  }

  function setView(viewName) {
    const normalized = normalizeViewName(viewName);
    currentView = normalized;
    viewMenuOpen = false;
    try {
      const nextUrl = new URL(window.location.href);
      nextUrl.searchParams.set("view", normalized);
      window.history.replaceState(null, "", nextUrl.toString());
    } catch {
      window.location.hash = normalized;
    }
    renderNow();
    if (normalized === "app-settings" || normalized === "onboarding") {
      refreshShellAppSettingsData();
    }
  }

  async function handleConnectSubmit() {
    const input = document.getElementById("connect-url-input");
    if (!input) return;
    const res = await Transport.setConnection(input.value);
    if (!res.ok) {
      connectionStatus = "disconnected";
      connectionError = res.error || "Paste the address ComputerAnything printed when it started";
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
      sendErrorText = err.message || "Could not load sample";
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
    const fileItems = attachedItems.filter((a) => a.kind !== "link");
    const attachedNames = attachedItems.map((a) => a.name).filter(Boolean);
    const activeThreadId = selectedTaskRunId || "";

    try {
      let created;
      if (activeFixtureName) {
        created = await Transport.request("POST", "/api/task", {
          prompt: fullPrompt,
          attachedNames,
          ...(activeThreadId ? { thread: activeThreadId } : {}),
        });
      } else if (hasShellBridge()) {
        const filePaths = fileItems.map((f) => f.path).filter(Boolean);
        created = await Transport.request(
          "POST",
          "/api/task",
          filePaths.length
            ? { prompt: fullPrompt, filePaths, ...(activeThreadId ? { thread: activeThreadId } : {}) }
            : { jsonBody: { prompt: fullPrompt, ...(activeThreadId ? { thread: activeThreadId } : {}) } }
        );
      } else if (fileItems.length) {
        const fd = new FormData();
        fd.append("prompt", fullPrompt);
        if (activeThreadId) fd.append("thread", activeThreadId);
        for (const item of fileItems) {
          if (item.file) fd.append("files", item.file, item.name);
        }
        created = await Transport.request("POST", "/api/task", { formData: fd });
      } else {
        created = await Transport.request("POST", "/api/task", {
          jsonBody: { prompt: fullPrompt, ...(activeThreadId ? { thread: activeThreadId } : {}) },
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
        connectionError = "Token rejected · Paste the ComputerAnything address again";
      } else {
        sendErrorText = err.message || "Could not send task";
      }
      renderNow();
    }
  }

  /* ============================================================================
     8. POLLING (/api/runs, /api/help, /api/agents, /api/actions, /api/graph, /api/analytics, /api/runs/<id>/cost)
     ============================================================================ */
  async function probeStopRoute() {
    if (stopRouteProbed || !Transport.isConnected()) return;
    stopRouteProbed = true;
    try {
      await Transport.request("POST", "/api/runs/__probe__/stop");
      stopRouteSupported = true;
    } catch (err) {
      const msg = String(err?.message || "").toLowerCase();
      stopRouteSupported = msg.includes("no such run");
    }
  }

  async function stopAllRunningAgents() {
    if (stopAllBusy || !stopRouteSupported) return;
    const activeParents = (rawRuns || []).filter(
      (r) => (!r.parent || r.role === "orchestrator") && (r.state === "queued" || r.state === "planning" || r.state === "acting" || r.state === "awaiting_human")
    );
    if (!activeParents.length) return;
    stopAllBusy = true;
    stopAllStatus = "";
    renderHeaderAndProvenance(getViewModel());

    let stoppedCount = 0;
    let failedCount = 0;
    await Promise.all(
      activeParents.map(async (r) => {
        try {
          await Transport.request("POST", `/api/runs/${encodeURIComponent(r.id)}/stop`);
          stoppedCount += 1;
        } catch {
          failedCount += 1;
        }
      })
    );

    stopAllBusy = false;
    if (failedCount === 0) {
      stopAllStatusTone = "state-success";
      stopAllStatus =
        stoppedCount === 1
          ? "✓ Stopped 1 running task"
          : `✓ Stopped ${stoppedCount} running tasks`;
    } else if (stoppedCount > 0) {
      stopAllStatusTone = "state-warning";
      stopAllStatus = `◔ Stopped ${stoppedCount} of ${activeParents.length} tasks`;
    } else {
      stopAllStatusTone = "state-neutral";
      stopAllStatus = "✕ Could not stop running tasks";
    }
    if (stopAllStatusTimer) clearTimeout(stopAllStatusTimer);
    stopAllStatusTimer = setTimeout(() => {
      stopAllStatus = "";
      renderHeaderAndProvenance(getViewModel());
    }, 6000);
    await pollAll();
  }

  async function saveWorkspaceProfileSettings(onlyKeys = null, savedRowKey = "") {
    HistorySettingsState.profileSaveStatus = "";
    HistorySettingsState.profileSaveError = "";
    HistorySettingsState.savedRow = "";
    if (!Transport.isConnected()) {
      HistorySettingsState.profileSaveError = "Not connected to ComputerAnything";
      renderNow();
      return;
    }
    const fullPayload = {
      call_me: String(HistorySettingsState.profileDraft.call_me || "").trim(),
      voice_id: String(HistorySettingsState.profileDraft.voice_id || "").trim(),
      model: String(HistorySettingsState.profileDraft.model || "").trim(),
      decide_model: String(HistorySettingsState.profileDraft.decide_model || "").trim(),
    };
    const payload = Array.isArray(onlyKeys) && onlyKeys.length
      ? Object.fromEntries(onlyKeys.filter((k) => k in fullPayload).map((k) => [k, fullPayload[k]]))
      : fullPayload;
    for (const [k, v] of Object.entries(payload)) {
      if (v.length > 200 || /[\r\n]/.test(v)) {
        HistorySettingsState.profileSaveError = `${k}: one line, at most 200 characters`;
        renderNow();
        return;
      }
    }
    HistorySettingsState.profileSaving = true;
    renderNow();
    try {
      const saved = await Transport.request("POST", "/api/profile", { jsonBody: payload });
      const next = {
        call_me: String(saved?.call_me ?? fullPayload.call_me),
        voice_id: String(saved?.voice_id ?? fullPayload.voice_id),
        model: String(saved?.model ?? fullPayload.model),
        decide_model: String(saved?.decide_model ?? fullPayload.decide_model),
        agent_name: String(saved?.agent_name ?? HistorySettingsState.profile.agent_name ?? ""),
      };
      HistorySettingsState.profile = next;
      HistorySettingsState.profileDraft = { ...next };
      HistorySettingsState.profileDirty = false;
      HistorySettingsState.profileLoaded = true;
      HistorySettingsState.profileSaveStatus = "✓ Saved";
      HistorySettingsState.savedRow = savedRowKey || (onlyKeys && onlyKeys[0]) || "all";
      OnboardingState.callMe = next.call_me;
      OnboardingState.voiceId = next.voice_id;
    } catch (err) {
      HistorySettingsState.profileSaveError = err.message || "Could not save settings";
    } finally {
      HistorySettingsState.profileSaving = false;
    }
    renderNow();
  }

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
      connectionError = wsState.error || "Paste the address ComputerAnything printed when it started";
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

    const actionsPath = "/api/actions";

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
        connectionError = nextFailed[0]?.error || "Could not reach ComputerAnything";
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

      const parentRuns = nextRuns.filter((r) => !r.parent || r.role === "orchestrator");
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
      const p = resultsByKey.profile;
      const nextProfile = {
        call_me: String(p.call_me || ""),
        voice_id: String(p.voice_id || ""),
        model: String(p.model || ""),
        decide_model: String(p.decide_model || ""),
        agent_name: String(p.agent_name || ""),
      };
      HistorySettingsState.profile = nextProfile;
      HistorySettingsState.profileLoaded = true;
      const activeId = document.activeElement?.id || "";
      if (!HistorySettingsState.profileDirty && !activeId.startsWith("settings-")) {
        HistorySettingsState.profileDraft = { ...nextProfile };
      }
      if (activeId !== "onboarding-call-me") {
        OnboardingState.callMe = nextProfile.call_me;
      }
      if (nextProfile.voice_id && !OnboardingState.voiceDirty) {
        OnboardingState.voiceId = nextProfile.voice_id;
      }
      const remoteAgentName = nextProfile.agent_name.trim();
      if (!appliedInitialProfileAgentName && activeId !== "settings-agent-name" && activeId !== "onboarding-agent-name") {
        appliedInitialProfileAgentName = true;
        lastSyncedProfileAgentName = remoteAgentName;
        if (remoteAgentName) {
          OnboardingState.agentName = remoteAgentName;
          savePrimaryAgentChoice();
        }
      }
      OnboardingState.profileLoaded = true;
      if (!autoOnboardingChecked && !hasExplicitInitialView && !hasShellSetView && !activeFixtureName) {
        autoOnboardingChecked = true;
        const hasSavedProfileName = Boolean(String(p.call_me || "").trim());
        if (!hasSeenOnboarding() && !hasSavedProfileName && !hasSavedPrimaryAgent()) {
          markOnboardingSeen();
          OnboardingState.step = 1;
          setView("onboarding");
        } else {
          markOnboardingSeen();
        }
      }
    }

    if (!stopRouteProbed) {
      await probeStopRoute();
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
          source: m.run ? `Run ${m.run}` : (m.source || "ComputerAnything memory"),
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
      promptInput.style.height = "32px";
      promptInput.style.height = `${Math.min(80, Math.max(32, promptInput.scrollHeight))}px`;
    }

    /* Attachment limits matching backend/computeranything/core/attach.py (3-image limit,
       text inline up to 6000 chars, binary/PDF name-only unless text extracted) and
       backend/computeranything/server.py (MAX_FILE = 50 MB). */
    const ATTACHMENT_LIMITS = Object.freeze({
      maxFileBytes: 50 * 1024 * 1024,
      maxImages: 3,
    });

    function inferBrowserFileKind(file) {
      const mime = String(file?.type || "").toLowerCase();
      const name = String(file?.name || "").toLowerCase();
      if (mime.startsWith("image/") || /\.(png|jpe?g|gif|webp|heic|heif|tiff?|bmp)$/i.test(name)) {
        return "image";
      }
      if (mime === "application/pdf" || name.endsWith(".pdf")) {
        return "pdf";
      }
      if (
        mime.startsWith("text/") ||
        mime === "application/json" ||
        /\.(txt|md|markdown|csv|tsv|json|yaml|yml|xml|log|py|js|ts|swift|html|css)$/i.test(name)
      ) {
        return "text";
      }
      return "other";
    }

    function formatAttachmentLabel(att, imageIdx) {
      if (att.kind === "link") return "Link";
      if (att.fileKind === "image") {
        return imageIdx < ATTACHMENT_LIMITS.maxImages
          ? "Agents see it"
          : "Not sent · 3-image limit";
      }
      if (att.fileKind === "text") return "Agents read it";
      if (att.fileKind === "pdf") {
        if (att.textExtracted === true) {
          const pages = Number(att.pageCount) || 0;
          return pages > 0
            ? `Agents read the text · ${pages} ${pages === 1 ? "page" : "pages"}`
            : "Agents read the text";
        }
        return "Name only · agents can't open it yet";
      }
      return "Name only · agents can't open it yet";
    }

    function renderAttachments() {
      if (!attachmentsList) return;
      if (!attachments.length) {
        attachmentsList.innerHTML = "";
        return;
      }
      let imageIdx = 0;
      attachmentsList.innerHTML = attachments
        .map((att, idx) => {
          const currentImgIdx = att.fileKind === "image" ? imageIdx++ : -1;
          const label = formatAttachmentLabel(att, currentImgIdx);
          const thumbHtml = att.thumbnail
            ? `<img class="attachment-thumb" src="${escapeHtml(att.thumbnail)}" alt="" />`
            : "";
          return `
            <span class="attachment-token">
              ${thumbHtml}
              <span class="attachment-name" title="${escapeHtml(att.name)}">${escapeHtml(att.name)}</span>
              <span class="attachment-note">${escapeHtml(label)}</span>
              <button type="button" class="attachment-remove" data-remove-idx="${idx}" aria-label="Remove ${escapeHtml(att.name)}">&times;</button>
            </span>
          `;
        })
        .join("");
    }

    function addAttachments(items) {
      const rejections = [];
      for (const item of items) {
        if (!item || !item.name) continue;
        if (item.fileKind === "folder" || item.kind === "folder") {
          rejections.push("Folders can't be attached · Drop the files inside");
          continue;
        }
        if (typeof item.size === "number" && item.size > ATTACHMENT_LIMITS.maxFileBytes) {
          rejections.push(`${item.name}: Over 50 MB · Not attached`);
          continue;
        }
        if (!attachments.some((a) => a.id === item.id)) {
          attachments.push(item);
        }
      }
      if (rejections.length) {
        sendErrorText = rejections[0];
        renderSendErrorBanner();
      }
      renderAttachments();
    }

    function normalizeShellFiles(files) {
      return (files || []).map((f) => ({
        id: `${f.path || ""}-${f.name || ""}`,
        name: f.name || "file",
        kind: f.kind === "folder" ? "folder" : "file",
        fileKind: f.kind || "other",
        path: f.path || "",
        size: typeof f.size === "number" ? f.size : 0,
        thumbnail: f.thumbnail || "",
        pageCount: typeof f.pageCount === "number" ? f.pageCount : 0,
        textExtracted: Boolean(f.textExtracted),
      }));
    }

    function normalizeBrowserFiles(files) {
      return (files || []).map((f, i) => {
        const fileKind = inferBrowserFileKind(f);
        const name = f.name || `photo-${Date.now()}-${i + 1}.png`;
        const thumbnail =
          fileKind === "image" && typeof URL !== "undefined" && typeof URL.createObjectURL === "function"
            ? URL.createObjectURL(f)
            : "";
        return {
          id: `file-${name}-${f.size}-${i}`,
          name,
          kind: "file",
          fileKind,
          size: typeof f.size === "number" ? f.size : 0,
          thumbnail,
          textExtracted: false,
          file: f,
          objectUrl: thumbnail,
        };
      });
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
            addAttachments(normalizeShellFiles(picked));
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
        addAttachments(normalizeBrowserFiles(files));
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
          const [removed] = attachments.splice(idx, 1);
          if (removed?.objectUrl && typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
            try {
              URL.revokeObjectURL(removed.objectUrl);
            } catch {
              // Ignore object URL cleanup errors
            }
          }
          renderAttachments();
        }
      });
    }

    if (promptForm) {
      promptForm.addEventListener("dragover", (e) => {
        e.preventDefault();
        promptForm.classList.add("drag-over");
      });

      promptForm.addEventListener("dragleave", (e) => {
        if (!promptForm.contains(e.relatedTarget)) {
          promptForm.classList.remove("drag-over");
        }
      });

      promptForm.addEventListener("drop", (e) => {
        e.preventDefault();
        promptForm.classList.remove("drag-over");
        if (!hasShellBridge()) {
          const dtItems = Array.from(e.dataTransfer?.items || []);
          const hasFolder = dtItems.some(
            (it) => typeof it.webkitGetAsEntry === "function" && it.webkitGetAsEntry()?.isDirectory
          );
          if (hasFolder) {
            sendErrorText = "Folders can't be attached · Drop the files inside";
            renderSendErrorBanner();
            return;
          }
          const files = Array.from(e.dataTransfer?.files || []);
          if (files.length) {
            addAttachments(normalizeBrowserFiles(files));
            return;
          }
        }
        const uri = e.dataTransfer?.getData("text/uri-list") || e.dataTransfer?.getData("text/plain");
        if (uri && /^https?:\/\//i.test(uri.trim())) {
          const clean = uri.trim();
          addAttachments([{ id: `link-${clean}`, name: clean, kind: "link", url: clean }]);
        }
      });
    }

    if (promptInput) {
      promptInput.addEventListener("paste", (e) => {
        if (hasShellBridge()) return;
        const files = Array.from(e.clipboardData?.files || []);
        if (files.length) {
          e.preventDefault();
          addAttachments(normalizeBrowserFiles(files));
        }
      });
    }

    window.addEventListener("shell-event", (e) => {
      const msg = e.detail || {};
      if (msg.type === "filesDropped" && Array.isArray(msg.files)) {
        addAttachments(normalizeShellFiles(msg.files));
      }
    });

    const viewMenuBtn = document.getElementById("view-menu-btn");
    if (viewMenuBtn) {
      viewMenuBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        viewMenuOpen = !viewMenuOpen;
        renderHeaderAndProvenance(getViewModel());
      });
    }

    /* Delegated clicks across view menu & all 10 views */
    document.addEventListener("click", async (e) => {
      if (viewMenuOpen && !e.target.closest(".view-menu-wrap")) {
        viewMenuOpen = false;
        renderHeaderAndProvenance(getViewModel());
      }

      const actionEl = e.target.closest("[data-action]");
      if (!actionEl) return;
      const action = actionEl.dataset.action;

      switch (action) {
        case "select-view-menu":
          viewMenuOpen = false;
          setView(actionEl.dataset.view || "graph");
          document.getElementById("view-menu-btn")?.focus();
          break;

        case "switch-view": {
          const targetView = actionEl.dataset.targetView || "graph";
          if (targetView === "onboarding") {
            OnboardingState.step = 1;
          }
          setView(targetView);
          break;
        }

        case "open-notch": {
          if (hasShellBridge()) {
            callShell("openNotch").catch(() => {});
          }
          break;
        }

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
          selectedSmScreenId = null;
          selectedSmEdgeId =
            selectedSmEdgeId === actionEl.dataset.edgeId ? null : actionEl.dataset.edgeId || null;
          renderNow();
          break;

        case "close-sm-edge":
          selectedSmEdgeId = null;
          renderNow();
          break;

        case "select-sm-screen-actions":
          selectedSmEdgeId = null;
          selectedSmScreenId =
            selectedSmScreenId === actionEl.dataset.screenId ? null : actionEl.dataset.screenId || null;
          renderNow();
          break;

        case "close-sm-screen-actions":
          selectedSmScreenId = null;
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
            OnboardingState.profileSaveError = "Not connected to ComputerAnything";
            renderNow();
            break;
          }
          try {
            await Transport.request("POST", "/api/profile", {
              jsonBody: {
                call_me: OnboardingState.callMe,
                agent_name: String(OnboardingState.agentName || "").trim(),
              },
            });
            lastSyncedProfileAgentName = String(OnboardingState.agentName || "").trim();
            OnboardingState.profileSaveStatus = "✓ Saved";
            OnboardingState.profileLoaded = true;
          } catch (err) {
            OnboardingState.profileSaveError = err.message || "Could not save name";
          }
          renderNow();
          break;
        }

        case "select-swatch": {
          const swatchKey = actionEl.dataset.swatch;
          const idx = AGENT_SWATCHES.findIndex((s) => s.key === swatchKey);
          if (idx >= 0) {
            OnboardingState.swatchIndex = idx;
            savePrimaryAgentChoice();
            HistorySettingsState.savedRow = "agent_color";
            renderNow();
          }
          break;
        }

        case "open-marketing-artifact": {
          selectedMarketingRunId = actionEl.dataset.runId || null;
          renderNow();
          break;
        }

        case "close-marketing-artifact": {
          selectedMarketingRunId = null;
          renderNow();
          break;
        }

        case "open-settings-pane": {
          const pane = actionEl.dataset.pane;
          if (pane) {
            const res = await Transport.openSettingsPane(pane);
            HistorySettingsState.paneStatus = res?.ok
              ? `Opened ${pane} in System Settings.`
              : res?.error || "Open System Settings from the Mac app.";
            renderNow();
            refreshShellAppSettingsData();
          }
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
          if (OnboardingState.step < OnboardingState.totalSteps) {
            OnboardingState.step += 1;
            renderNow();
          }
          break;

        case "select-onboarding-voice":
          OnboardingState.voiceId = actionEl.dataset.voiceId ?? "";
          renderNow();
          break;

        case "preview-onboarding-voice": {
          const vid = actionEl.dataset.voiceId ?? "";
          const available = getAvailableVoiceChoices();
          const voiceObj = available.find((v) => v.id === vid) || available[0];
          if (vid === "none") {
            OnboardingState.voicePreviewStatus = "Spoken replies are muted (No voice).";
            renderNow();
            break;
          }
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
            saveAndApplyA11ySettings();
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

        case "set-onboarding-memory":
          OnboardingState.memoryEnabled = actionEl.dataset.enabled === "1";
          OnboardingState.memoryStatusNote = OnboardingState.memoryEnabled
            ? "Memory enabled for this session."
            : "Memory paused for this session.";
          renderNow();
          break;

        case "forget-onboarding-memory":
          OnboardingState.confirmForgetOnboardingMemory = true;
          renderNow();
          break;

        case "cancel-forget-onboarding-memory":
          OnboardingState.confirmForgetOnboardingMemory = false;
          renderNow();
          break;

        case "confirm-forget-onboarding-memory": {
          OnboardingState.confirmForgetOnboardingMemory = false;
          OnboardingState.userName = "";
          OnboardingState.callMe = "";
          OnboardingState.pronounce = "";
          try {
            const memResp = await Transport.request("GET", "/api/memory");
            const items = Array.isArray(memResp)
              ? memResp
              : Array.isArray(memResp?.facts)
              ? memResp.facts
              : Array.isArray(memResp?.memories)
              ? memResp.memories
              : [];
            let deleted = 0;
            let failed = 0;
            const deletedIds = new Set();
            for (const item of items) {
              const mid = String(item?.id ?? item?.fact_id ?? "").trim();
              if (!mid) {
                failed += 1;
                continue;
              }
              try {
                await Transport.request("DELETE", `/api/memory/${encodeURIComponent(mid)}`);
                deleted += 1;
                deletedIds.add(mid);
              } catch {
                failed += 1;
              }
            }
            if (deletedIds.size > 0) {
              HistorySettingsState.liveMemories = HistorySettingsState.liveMemories.filter(
                (m) => !deletedIds.has(String(m.id))
              );
              HistorySettingsState.memories = HistorySettingsState.memories.filter(
                (m) => !deletedIds.has(String(m.id))
              );
            }
            if (items.length === 0) {
              OnboardingState.memoryStatusNote = "No saved memories to forget.";
            } else if (failed === 0) {
              OnboardingState.memoryStatusNote = `Forgot ${deleted} ${deleted === 1 ? "memory" : "memories"}.`;
            } else {
              OnboardingState.memoryStatusNote = `Forgot ${deleted} ${deleted === 1 ? "memory" : "memories"}; ${failed} remain.`;
            }
          } catch (err) {
            OnboardingState.memoryStatusNote = err?.message || "Could not load memories to forget.";
          }
          renderNow();
          break;
        }

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

        case "copy-text": {
          const key = actionEl.dataset.copyKey;
          if (key && copyPayloadsByKey.has(key)) {
            await copyTextToClipboard(copyPayloadsByKey.get(key), key);
          }
          break;
        }

        default:
          break;
      }
    });

    const stopAllBtn = document.getElementById("stop-all-btn");
    if (stopAllBtn) {
      stopAllBtn.addEventListener("click", () => {
        stopAllRunningAgents();
      });
    }

    document.addEventListener("change", async (e) => {
      const target = e.target;
      if (target && target.matches('[data-action="select-replay-run"]')) {
        replayRunId = target.value || null;
        replayStepIndex = 0;
        renderNow();
      } else if (target && target.matches('[data-action="set-a11y-select"]')) {
        const key = target.dataset.a11yKey;
        if (key === "text_size" && ["default", "large", "extra_large"].includes(target.value)) {
          OnboardingState.a11y.text_size = target.value;
          saveAndApplyA11ySettings();
        }
        renderNow();
      } else if (target && target.matches('[data-action="set-history-cost"]')) {
        HistorySettingsState.costFilter = target.value || "all";
        renderNow();
      } else if (target && target.matches('[data-action="set-sm-app-select"]')) {
        selectedAppFilter = target.value || "all";
        selectedSmEdgeId = null;
        selectedSmScreenId = null;
        renderNow();
      } else if (target && target.matches('[data-action="set-sm-agent-select"]')) {
        smAgentFilter = target.value || "";
        selectedSmEdgeId = null;
        selectedSmScreenId = null;
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

    function syncViewFromLocationSearch() {
      try {
        const currentParams = new URLSearchParams(window.location.search);
        const qView = currentParams.get("view");
        if (qView && qView.trim()) {
          const normalized = normalizeViewName(qView);
          if (normalized !== currentView) {
            setView(normalized);
          }
        }
      } catch {
        // Ignore URL parsing errors
      }
    }

    window.addEventListener("popstate", syncViewFromLocationSearch);
    window.addEventListener("pageshow", syncViewFromLocationSearch);

    window.addEventListener("storage", (event) => {
      if (!event.key || event.key === PRIMARY_AGENT_STORAGE_KEY) {
        loadPrimaryAgentChoice();
        renderNow();
      }
    });

    window.addEventListener("focus", () => {
      loadPrimaryAgentChoice();
      renderNow();
      if (currentView === "app-settings" || currentView === "onboarding") {
        refreshShellAppSettingsData();
      }
    });

    /* Keyboard accessibility:
       - Cmd+1..Cmd+8 (and Cmd+9/Cmd+0) switch views
       - Cmd+W and Escape close the window (after closing innermost open menu/detail)
       - Enter / Space on SVG .sm-edge-group controls */
    document.addEventListener("keydown", (e) => {
      const target = e.target;

      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
        const k = String(e.key || "").toLowerCase();
        if (k === "w") {
          e.preventDefault();
          if (hasShellBridge()) {
            try {
              window.webkit.messageHandlers.shell.postMessage({ type: "closeWindow" });
            } catch {
              // Ignore shell errors
            }
          }
          return;
        }
        const matchedView = VIEW_DEFINITIONS.find((v) => v.key === k);
        if (matchedView) {
          e.preventDefault();
          viewMenuOpen = false;
          setView(matchedView.id);
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

      if (viewMenuOpen) {
        e.preventDefault();
        viewMenuOpen = false;
        renderHeaderAndProvenance(getViewModel());
        document.getElementById("view-menu-btn")?.focus();
        return;
      }

      if (currentView === "memory" && HistorySettingsState.confirmForgetId) {
        e.preventDefault();
        const mid = HistorySettingsState.confirmForgetId;
        HistorySettingsState.confirmForgetId = null;
        renderNow();
        requestAnimationFrame(() => {
          document.querySelector(`[data-action="forget-memory"][data-memory-id="${mid}"]`)?.focus();
        });
        return;
      }

      if (currentView === "memory" && HistorySettingsState.editingMemoryId) {
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
        return;
      }

      if (hasShellBridge()) {
        e.preventDefault();
        try {
          window.webkit.messageHandlers.shell.postMessage({ type: "closeWindow" });
        } catch {
          // Ignore shell errors
        }
      }
    });
  }

  async function boot() {
    setupEventListeners();
    renderNow();
    if (currentView === "app-settings" || currentView === "onboarding") {
      refreshShellAppSettingsData();
    }
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
