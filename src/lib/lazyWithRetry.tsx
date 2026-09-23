import { lazy, type ComponentType, type LazyExoticComponent } from "react";

/**
 * P10-MW-1: route chunks that can be loaded again after a failure.
 *
 * `React.lazy` caches a rejected import on the lazy object for good, so a chunk that failed once (a moment offline, or
 * a release that removed the old assets) stayed broken until a full reload: the error boundary's "Try again" and
 * navigating away and back both re-rendered the same rejected object. Here each route keeps its lazy component in a
 * slot; `resetFailedChunks()` swaps every FAILED slot for a fresh `lazy(load)`, so the next render makes a new
 * `import()`. It is called by the error boundary's retry and when a route mounts; never during the failing render
 * itself, so a chunk that keeps failing cannot loop.
 */

type Slot = { reset: () => void };
const slots = new Set<Slot>();

/** Swaps every failed route chunk for a fresh one; the next render re-requests it. */
export function resetFailedChunks(): void {
  for (const slot of slots) slot.reset();
}

export function lazyWithRetry<P extends object>(load: () => Promise<{ default: ComponentType<P> }>): ComponentType<P> {
  let failed = false;
  const make = (): LazyExoticComponent<ComponentType<P>> =>
    lazy(() =>
      load().catch((error: unknown) => {
        failed = true;
        // After a release the old chunk is gone for good: one guarded full reload fetches the new build.
        if (isChunkLoadError(error) && reloadOnceForChunkError()) return new Promise<never>(() => {});
        throw error;
      }),
    );
  let current = make();
  slots.add({
    reset: () => {
      if (!failed) return;
      failed = false;
      current = make();
    },
  });
  function RetryableRoute(props: P) {
    const Current = current;
    return <Current {...props} />;
  }
  return RetryableRoute;
}

/** A failed dynamic import or module preload: the browser and Vite word it differently. */
export function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS|ChunkLoadError/i.test(
    message,
  );
}

const RELOAD_KEY = "recoup-chunk-reload-at";
/** One automatic reload per this window: a second failure soon after shows the error with its buttons instead. */
const RELOAD_GUARD_MS = 60_000;

/**
 * After a release the old chunks are gone, so only a full reload (fresh `index.html`) can load the page. Reloads at
 * most once per `RELOAD_GUARD_MS` (sessionStorage), and never while offline: a reload then would only swap the app for
 * the browser's offline page, while "Try again" keeps working once the connection is back. Returns whether it reloaded.
 */
export function reloadOnceForChunkError(
  env: { storage?: Pick<Storage, "getItem" | "setItem">; online?: boolean; reload?: () => void; now?: number } = {},
): boolean {
  const online = env.online ?? (typeof navigator === "undefined" ? true : navigator.onLine);
  if (!online) return false;
  const now = env.now ?? Date.now();
  let storage: Pick<Storage, "getItem" | "setItem"> | undefined;
  try {
    storage = env.storage ?? window.sessionStorage;
  } catch {
    storage = undefined;
  }
  // Without a place to remember the last reload there is no guard, so never reload automatically (it could loop).
  if (!storage) return false;
  try {
    // No stored value means no previous reload — do not treat that as "last reload was at time 0", which
    // would wrongly block every reload until `now` itself passed RELOAD_GUARD_MS.
    const raw = storage.getItem(RELOAD_KEY);
    const last = raw === null ? null : Number(raw);
    if (last !== null && Number.isFinite(last) && now - last < RELOAD_GUARD_MS) return false;
    storage.setItem(RELOAD_KEY, String(now));
  } catch {
    // Storage blocked: without a guard, never reload automatically (it could loop).
    return false;
  }
  (env.reload ?? (() => window.location.reload()))();
  return true;
}
