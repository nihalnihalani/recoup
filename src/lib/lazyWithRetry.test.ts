// @vitest-environment node
// Plain Node, not the suite's default edge-runtime: edge-runtime's `window.sessionStorage` is a working object, which
// would defeat the "storage is unavailable" case below (env.storage explicitly overrides it in every other test
// here, so no test in this file needs a real `window`).
import { describe, expect, it } from "vitest";
import { isChunkLoadError, reloadOnceForChunkError } from "./lazyWithRetry";

/**
 * P10-MW-1 (unit level): `isChunkLoadError`'s message matching, and `reloadOnceForChunkError`'s guard (storage,
 * online, and the reload-once window), exercised through its injected `env` so no real `window` is needed. Neither
 * helper exists on origin/main at all — this whole module is new — so this file fails to import on base.
 */
describe("isChunkLoadError", () => {
  it.each([
    ["TypeError: Failed to fetch dynamically imported module", true],
    ["Error: error loading dynamically imported module: https://x/y.js", true],
    ["TypeError: Importing a module script failed", true],
    ["Unable to preload CSS for /assets/x.css", true],
    ["ChunkLoadError: Loading chunk 4 failed", true],
    ["TypeError: Cannot read properties of undefined", false],
    ["ConvexError: not found", false],
  ])("%s -> %s", (message, expected) => {
    expect(isChunkLoadError(new Error(message))).toBe(expected);
  });

  it("stringifies a non-Error throw instead of crashing", () => {
    expect(isChunkLoadError("Failed to fetch dynamically imported module")).toBe(true);
    expect(isChunkLoadError({ weird: true })).toBe(false);
  });
});

function fakeStorage(initial: Record<string, string> = {}): Pick<Storage, "getItem" | "setItem"> {
  const store = { ...initial };
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
  };
}

describe("reloadOnceForChunkError", () => {
  it("reloads once and records the time when online with working storage", () => {
    const storage = fakeStorage();
    let reloaded = 0;
    const did = reloadOnceForChunkError({ storage, online: true, now: 1_000, reload: () => (reloaded += 1) });
    expect(did).toBe(true);
    expect(reloaded).toBe(1);
    expect(storage.getItem("recoup-chunk-reload-at")).toBe("1000");
  });

  it("does not reload a second time inside the guard window", () => {
    const storage = fakeStorage({ "recoup-chunk-reload-at": "1000" });
    let reloaded = 0;
    const did = reloadOnceForChunkError({ storage, online: true, now: 1_000 + 30_000, reload: () => (reloaded += 1) });
    expect(did).toBe(false);
    expect(reloaded).toBe(0);
  });

  it("reloads again once the guard window has fully elapsed", () => {
    const storage = fakeStorage({ "recoup-chunk-reload-at": "1000" });
    let reloaded = 0;
    const did = reloadOnceForChunkError({ storage, online: true, now: 1_000 + 60_001, reload: () => (reloaded += 1) });
    expect(did).toBe(true);
    expect(reloaded).toBe(1);
  });

  it("never reloads while offline, guard or not", () => {
    const storage = fakeStorage();
    let reloaded = 0;
    const did = reloadOnceForChunkError({ storage, online: false, now: 1_000, reload: () => (reloaded += 1) });
    expect(did).toBe(false);
    expect(reloaded).toBe(0);
  });

  it("never reloads when storage is unavailable (no guard would survive)", () => {
    let reloaded = 0;
    const did = reloadOnceForChunkError({ storage: undefined, online: true, now: 1_000, reload: () => (reloaded += 1) });
    expect(did).toBe(false);
    expect(reloaded).toBe(0);
  });
});
