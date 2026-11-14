/**
 * Shared child-process spawning and signal/exit cleanup helper for ui/tests/.
 * Ensures spawned children (and their process groups) plus registered resources
 * (HTTP servers, temp directories) are terminated/removed on normal exit,
 * uncaught errors, SIGINT, SIGTERM, and SIGHUP.
 */

import { spawn } from "node:child_process";

const activeChildren = new Set();
const cleanupCallbacks = new Set();
let handlersInstalled = false;
let isCleaningUp = false;

/**
 * Kill a child process and, on POSIX, its entire process group.
 */
export function killProcessTree(proc, signal = "SIGKILL") {
  if (!proc || !proc.pid) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-proc.pid, signal);
    } catch {
      // Fall through to direct kill if process group no longer exists or is not a leader.
    }
  }
  try {
    proc.kill(signal);
  } catch {
    // Ignore ESRCH / already-exited errors.
  }
}

/**
 * Synchronously kill all tracked child process groups and run registered cleanups.
 */
export function cleanupAll() {
  if (isCleaningUp) return;
  isCleaningUp = true;
  try {
    for (const proc of Array.from(activeChildren)) {
      killProcessTree(proc, "SIGKILL");
      activeChildren.delete(proc);
    }
    const callbacks = Array.from(cleanupCallbacks).reverse();
    cleanupCallbacks.clear();
    for (const fn of callbacks) {
      try {
        fn();
      } catch {
        // Best-effort cleanup.
      }
    }
  } finally {
    isCleaningUp = false;
  }
}

/**
 * Install process-level exit and signal handlers once.
 */
export function installCleanupHandlers() {
  if (handlersInstalled) return;
  handlersInstalled = true;

  process.on("exit", () => {
    cleanupAll();
  });

  const signalCodes = [
    ["SIGINT", 130],
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ];
  for (const [sig, exitCode] of signalCodes) {
    process.on(sig, () => {
      cleanupAll();
      process.exit(exitCode);
    });
  }

  process.on("uncaughtException", (err) => {
    console.error(err);
    cleanupAll();
    process.exit(1);
  });

  process.on("unhandledRejection", (err) => {
    console.error(err);
    cleanupAll();
    process.exit(1);
  });
}

/**
 * Register a synchronous cleanup callback (e.g. closing a server or removing a temp dir).
 * Returns an unregister function.
 */
export function registerCleanup(fn) {
  installCleanupHandlers();
  if (typeof fn !== "function") {
    throw new TypeError("registerCleanup expects a function");
  }
  cleanupCallbacks.add(fn);
  return () => cleanupCallbacks.delete(fn);
}

/**
 * Spawn a child process in its own process group (on POSIX) and track it for cleanup.
 */
export function spawnManaged(command, args = [], options = {}) {
  installCleanupHandlers();
  const spawnOpts = {
    ...options,
    detached: process.platform !== "win32",
  };
  const proc = spawn(command, args, spawnOpts);
  activeChildren.add(proc);

  const untrack = () => activeChildren.delete(proc);
  proc.once("exit", untrack);
  proc.once("error", untrack);
  return proc;
}
