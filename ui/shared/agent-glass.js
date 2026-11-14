/**
 * Shared Agent Glass Wrapper (ui/shared/agent-glass.js)
 *
 * Implements the visual guideline:
 * - Uses the backend's /api/agents colors as given ({color, edge, ink}) without re-mixing body/edge.
 * - Darkens label ink by 25% toward black (ink * 0.75 per channel) so all 5 backend palettes
 *   (Lagoon, Rose, Mint, Lilac, Amber) pass >= 5.46:1 contrast on the rendered surface.
 * - Uses the quiet preset with transmission: 0 (avoids unblurred pool when CanvasRenderingContext2D.filter is unavailable in WKWebView).
 * - Computes a deterministic seed hash from the agent id/name.
 * - Provides a plain-chip fallback when mountGlass is unavailable.
 */
(function (global) {
  "use strict";

  /* Backend cursor palettes in order (backend/computeranything/cu/overlay.py) */
  const BACKEND_PALETTES = Object.freeze([
    { key: "lagoon", name: "Lagoon", color: "#B5D0EB", edge: "#D6E9FF", ink: "#2F647C" },
    { key: "rose",   name: "Rose",   color: "#EECED6", edge: "#FFF0F1", ink: "#963F59" },
    { key: "mint",   name: "Mint",   color: "#C0DED0", edge: "#E6FFF0", ink: "#396C5A" },
    { key: "lilac",  name: "Lilac",  color: "#E1CDE8", edge: "#FBE8F7", ink: "#71388B" },
    { key: "amber",  name: "Amber",  color: "#F0D9BE", edge: "#FFFCE0", ink: "#865733" },
  ]);

  /* Quiet preset with transmission: 0 for WKWebView */
  const QUIET_SETTINGS = Object.freeze({
    frost: 0.38,
    grain: 0.23,
    tumble: 0.012,
    thickness: 3,
    bulge: 0.38,
    elevation: 4,
    light: 315,
    transmission: 0,
  });

  function parseHex(hex) {
    const clean = String(hex || "").replace(/^#/, "").trim();
    const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
    const num = parseInt(full, 16);
    if (Number.isNaN(num)) return [47, 100, 124];
    return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
  }

  function toHex(rgb) {
    return (
      "#" +
      rgb
        .map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, "0"))
        .join("")
        .toUpperCase()
    );
  }

  /** Mix ink 25% toward black (channel * 0.75) so all 5 backend palettes pass >= 4.5:1 contrast. */
  function darkenInk(inkHex) {
    const [r, g, b] = parseHex(inkHex || "#2F647C");
    return toHex([r * 0.75, g * 0.75, b * 0.75]);
  }

  /** Stable 32-bit FNV-1a seed from agent id or name. */
  function hashAgentSeed(idOrName) {
    const str = String(idOrName || "agent");
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return (h % 99991) + 17;
  }

  /**
   * Resolve an /api/agents entry ({name, color, edge, ink} or palette key) as given,
   * without re-mixing body or edge, and compute the 25% darker label ink.
   */
  function resolveAgentPalette(agent) {
    if (!agent || typeof agent !== "object") {
      const def = BACKEND_PALETTES[0];
      return {
        body: def.color,
        edge: def.edge,
        ink: darkenInk(def.ink),
        rawInk: def.ink,
      };
    }

    const body = agent.color || agent.body || "";
    const byColor = BACKEND_PALETTES.find(
      (p) => p.color.toLowerCase() === String(body).toLowerCase() || p.key === String(agent.palette || "").toLowerCase()
    );

    const resolvedBody = body || byColor?.color || BACKEND_PALETTES[0].color;
    const resolvedEdge = agent.edge || byColor?.edge || "#D6E9FF";
    const resolvedRawInk = agent.ink || byColor?.ink || "#2F647C";
    const darkerInk = darkenInk(resolvedRawInk);

    return {
      body: resolvedBody,
      edge: resolvedEdge,
      ink: darkerInk,
      rawInk: resolvedRawInk,
    };
  }

  function applyPlainChipFallback(element, palette, shape) {
    element.classList.add("agent-glass-fallback");
    element.style.setProperty("--glass-ink", palette.ink);
    element.style.backgroundColor = palette.body;
    element.style.border = `1px solid ${palette.edge}`;
    element.style.color = palette.ink;
    element.style.borderRadius = shape === "capsule" ? "999px" : "18px";
  }

  function clearPlainChipFallback(element) {
    element.classList.remove("agent-glass-fallback");
    element.style.backgroundColor = "transparent";
    element.style.border = "";
  }

  /**
   * Mount sea-glass on an element for an /api/agents entry `{id, name, color, edge, ink}`.
   * Options: `{ shape: 'capsule' | 'rounded', seed?: number }`.
   */
  function mountAgentGlass(element, agent = {}, options = {}) {
    if (!element) return null;
    const shape = options.shape || element.dataset.glassShape || "capsule";
    const seedKey =
      options.seed ??
      agent.id ??
      agent.agent_id ??
      agent.name ??
      element.dataset.glassSeed ??
      "agent";
    const seed = typeof seedKey === "number" ? seedKey : hashAgentSeed(seedKey);
    const palette = resolveAgentPalette(agent);

    element.style.position = "relative";
    element.style.isolation = "isolate";
    element.style.overflow = "visible";
    element.style.setProperty("--glass-ink", palette.ink);

    const mountFn =
      (typeof global.mountGlass === "function" && global.mountGlass) ||
      (typeof global.SeaGlass?.mountGlass === "function" && global.SeaGlass.mountGlass) ||
      null;

    if (!mountFn) {
      applyPlainChipFallback(element, palette, shape);
      return {
        palette,
        isFallback: true,
        update(nextAgent) {
          const nextPal = resolveAgentPalette(nextAgent || agent);
          applyPlainChipFallback(element, nextPal, shape);
        },
        destroy() {
          clearPlainChipFallback(element);
        },
      };
    }

    try {
      clearPlainChipFallback(element);
      const handle = mountFn(element, {
        palette: {
          body: palette.body,
          edge: palette.edge,
          ink: palette.ink,
        },
        shape,
        settings: QUIET_SETTINGS,
        seed,
      });
      element.style.setProperty("--glass-ink", palette.ink);
      return {
        palette,
        isFallback: false,
        update(nextAgent) {
          const nextPal = resolveAgentPalette(nextAgent || agent);
          handle.update(QUIET_SETTINGS, {
            body: nextPal.body,
            edge: nextPal.edge,
            ink: nextPal.ink,
          });
          element.style.setProperty("--glass-ink", nextPal.ink);
        },
        destroy() {
          handle.destroy();
        },
      };
    } catch {
      applyPlainChipFallback(element, palette, shape);
      return {
        palette,
        isFallback: true,
        update() {},
        destroy() {
          clearPlainChipFallback(element);
        },
      };
    }
  }

  const api = Object.freeze({
    BACKEND_PALETTES,
    QUIET_SETTINGS,
    darkenInk,
    hashAgentSeed,
    resolveAgentPalette,
    mountAgentGlass,
  });

  global.AgentGlass = api;
  global.mountAgentGlass = mountAgentGlass;
})(typeof window !== "undefined" ? window : globalThis);
