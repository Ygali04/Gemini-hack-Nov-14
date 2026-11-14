#!/usr/bin/env node
/**
 * Development-only static + reverse-proxy server for checking the real UI
 * against a live local backend in a normal browser without exposing the
 * backend token to the browser.
 *
 * Usage:
 *   CA_URL="http://127.0.0.1:8765/?t=..." node ui/tests/dev-proxy.mjs [--port 4519] [--allow-post] [--allow-task]
 *
 * Then open:
 *   http://127.0.0.1:4519/index.html?t=dev
 *   http://127.0.0.1:4519/workspace.html?t=dev
 *
 * Safety:
 *   - Binds 127.0.0.1 only.
 *   - Forwards /api/* to 127.0.0.1 only.
 *   - Forwards GET by default; refuses POST with 405 unless --allow-post,
 *     and refuses POST /api/task with 405 unless --allow-task.
 *   - Strips Origin/Referer and injects X-CA-Token server-side; never logs
 *     or returns the real token.
 *   - Node built-ins only.
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installCleanupHandlers, registerCleanup } from "./process-cleanup.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const UI_DIR = path.resolve(__dirname, "..");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

function parseArgs(argv) {
  let port = 4519;
  let allowPost = false;
  let allowTask = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--port" && argv[i + 1]) {
      port = Number(argv[++i]);
    } else if (arg.startsWith("--port=")) {
      port = Number(arg.slice("--port=".length));
    } else if (arg === "--allow-post") {
      allowPost = true;
    } else if (arg === "--allow-task") {
      allowTask = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: CA_URL=http://127.0.0.1:8765/?t=... node ui/tests/dev-proxy.mjs [--port 4519] [--allow-post] [--allow-task]"
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid --port value: ${port}`);
  }

  return { port, allowPost, allowTask };
}

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
  if (parsed.protocol !== "http:") {
    throw new Error(`Unsupported CA_URL protocol: ${parsed.protocol} (expected http:)`);
  }
  if (parsed.hostname !== "127.0.0.1") {
    throw new Error(`Refusing to forward to host "${parsed.hostname}"; only 127.0.0.1 is allowed`);
  }
  const token = parsed.searchParams.get("t") || "";
  if (!token) {
    throw new Error("CA_URL is missing the ?t= token parameter");
  }
  return {
    hostname: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 80,
    origin: parsed.origin,
    token,
  };
}

function sendJson(res, statusCode, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  res.end(body);
}

function serveStatic(req, res, pathname) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    sendJson(res, 405, { error: `Method ${req.method} not allowed for static files` }, { Allow: "GET, HEAD" });
    return;
  }

  if (pathname === "/") {
    res.writeHead(302, { Location: "/index.html?t=dev", "Cache-Control": "no-store" });
    res.end();
    return;
  }

  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    sendJson(res, 400, { error: "Malformed URL path" });
    return;
  }

  if (decoded.includes("\0")) {
    sendJson(res, 400, { error: "Invalid URL path" });
    return;
  }

  const relPath = decoded.replace(/^\/+/, "");
  const fullPath = path.resolve(UI_DIR, relPath);
  if (fullPath !== UI_DIR && !fullPath.startsWith(UI_DIR + path.sep)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }

  fs.stat(fullPath, (statErr, stat) => {
    if (statErr || !stat.isFile()) {
      sendJson(res, 404, { error: "Not found" });
      return;
    }

    const ext = path.extname(fullPath).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": stat.size,
      "Cache-Control": "no-store",
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    const stream = fs.createReadStream(fullPath);
    stream.on("error", () => {
      if (!res.headersSent) {
        sendJson(res, 500, { error: "Failed to read file" });
      } else {
        res.destroy();
      }
    });
    stream.pipe(res);
  });
}

function forwardApi(req, res, reqUrl, backend, options) {
  const { pathname } = reqUrl;
  const method = (req.method || "GET").toUpperCase();

  if (method === "POST") {
    if (!options.allowPost) {
      sendJson(res, 405, { error: "POST requests are disabled (start with --allow-post)" }, { Allow: "GET" });
      return;
    }
    if (pathname === "/api/task" && !options.allowTask) {
      sendJson(res, 405, { error: "POST /api/task is disabled (start with --allow-task)" }, { Allow: "GET" });
      return;
    }
  } else if (method !== "GET") {
    const allow = options.allowPost ? "GET, POST" : "GET";
    sendJson(res, 405, { error: `Method ${method} not allowed` }, { Allow: allow });
    return;
  }

  const forwardHeaders = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const lower = key.toLowerCase();
    if (
      lower === "origin" ||
      lower === "referer" ||
      lower === "host" ||
      lower === "x-ca-token" ||
      lower === "connection"
    ) {
      continue;
    }
    if (value !== undefined) {
      forwardHeaders[key] = value;
    }
  }
  forwardHeaders["X-CA-Token"] = backend.token;

  const proxyReq = http.request(
    {
      hostname: backend.hostname,
      port: backend.port,
      method,
      path: `${reqUrl.pathname}${reqUrl.search}`,
      headers: forwardHeaders,
    },
    (proxyRes) => {
      const respHeaders = { ...proxyRes.headers };
      delete respHeaders["transfer-encoding"];
      res.writeHead(proxyRes.statusCode || 502, respHeaders);
      proxyRes.pipe(res);
    }
  );

  proxyReq.on("error", (err) => {
    if (!res.headersSent) {
      sendJson(res, 502, { error: `Upstream backend error: ${err.code || err.message}` });
    } else {
      res.destroy();
    }
  });

  if (method === "GET") {
    proxyReq.end();
  } else {
    req.pipe(proxyReq);
  }
}

function main() {
  installCleanupHandlers();
  const options = parseArgs(process.argv.slice(2));
  const backend = parseCaUrl();

  const server = http.createServer((req, res) => {
    let reqUrl;
    try {
      reqUrl = new URL(req.url || "/", `http://127.0.0.1:${options.port}`);
    } catch {
      sendJson(res, 400, { error: "Invalid request URL" });
      return;
    }

    if (reqUrl.pathname === "/api" || reqUrl.pathname.startsWith("/api/")) {
      forwardApi(req, res, reqUrl, backend, options);
      return;
    }

    serveStatic(req, res, reqUrl.pathname);
  });

  registerCleanup(() => {
    try { server.closeAllConnections?.(); } catch {}
    try { server.close(); } catch {}
  });

  server.listen(options.port, "127.0.0.1", () => {
    console.log(`dev-proxy listening on http://127.0.0.1:${options.port}`);
    console.log(`forwarding /api/* -> ${backend.origin} (X-CA-Token injected server-side)`);
    console.log(
      `methods: GET${options.allowPost ? ", POST" : ""}${options.allowPost && options.allowTask ? " (including /api/task)" : ""}`
    );
    console.log(`notch:     http://127.0.0.1:${options.port}/index.html?t=dev`);
    console.log(`workspace: http://127.0.0.1:${options.port}/workspace.html?t=dev`);
  });
}

try {
  main();
} catch (err) {
  console.error(`dev-proxy error: ${err.message}`);
  process.exit(1);
}
