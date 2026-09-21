import { useEffect, useState } from "react";

/**
 * Matches `convex/watches.ts`'s `assertCoarseNow` (P06/D73): a reactive
 * query's `now` argument only ever moves in 5-minute steps, so the client
 * clock that feeds it should too -- passing it as a query argument then
 * re-subscribes the query on the server's own cadence, not on every render.
 */
export const COARSE_STEP_MS = 300_000;

/** How often `useCoarseNow` checks whether the rounded value has moved on; well inside `COARSE_STEP_MS`, so a step is never missed by more than this. */
const COARSE_POLL_MS = 30_000;

/** `ms` rounded down to the nearest 5-minute step, mirroring the server's own rounding. Pure; safe for any finite input. */
export function roundToCoarse(ms: number): number {
  return Math.floor(ms / COARSE_STEP_MS) * COARSE_STEP_MS;
}

/**
 * The client clock for every reactive query that takes a coarse `now`
 * (`watches.list`/`get`, `offers.listForWatch`, `tracking.overview`,
 * `budget.status` -- P06/D73): rounded down to a 5-minute step, and the
 * component only re-renders when that step actually advances (React bails
 * out of a `setState` to an equal value), so passing this as a query
 * argument cannot resubscribe it more than once every 5 minutes.
 *
 * DISPLAY-ONLY, and only ever this coarse. No button's eligibility is ever
 * computed from it: every countdown, cooldown, "checking…"/"searching…"
 * state derives from the RAW timestamps a query returns plus a much finer
 * client tick (`useNow` in `./ui`, typically ticked at 1s) -- this hook
 * feeds nothing but the `now` argument itself.
 */
export function useCoarseNow(): number {
  const [now, setNow] = useState(() => roundToCoarse(Date.now()));
  useEffect(() => {
    const id = setInterval(() => setNow(roundToCoarse(Date.now())), COARSE_POLL_MS);
    return () => clearInterval(id);
  }, []);
  return now;
}

// ---------------------------------------------------------------------------
// Derived display states -- pure functions over a query's raw timestamps
// plus a client `now`. NEVER used to gate a mutation: every button below
// still calls the mutation and shows its own error: these only decide what
// the UI says while the real state catches up.
// ---------------------------------------------------------------------------

/**
 * How long a requested-but-not-yet-recorded check stays "Checking…" before
 * the UI stops waiting and falls back to the watch's last completed state.
 * Mirrors `convex/offers.ts`'s own `SEARCH_PENDING_MS` convention: a
 * scheduled action that dies without ever writing back must not pin the UI
 * in a busy state forever.
 */
export const CHECK_PENDING_MS = 5 * 60_000;

/**
 * True while a watch's most recently REQUESTED check (`checkRequestedAt`)
 * has not yet been recorded by a newer `lastCheckedAt` (the way
 * `watches.recordWatchCheck` stamps both in the same patch), and that
 * request is still recent enough to plausibly be in flight. Replaces the
 * old server-computed `checking` boolean (T12 removed it in favour of the
 * two raw timestamps).
 */
export function isChecking(checkRequestedAt: number | null, lastCheckedAt: number | null, now: number): boolean {
  if (checkRequestedAt === null) return false;
  if (lastCheckedAt !== null && lastCheckedAt >= checkRequestedAt) return false;
  return now - checkRequestedAt < CHECK_PENDING_MS;
}

/** True while `offers.listForWatch`'s find marker is still pending: `searchingUntil` is in the future. */
export function isSearching(searchingUntil: number | undefined, now: number): boolean {
  return searchingUntil !== undefined && now < searchingUntil;
}

/**
 * "Find other stores" is enabled exactly when there is no cooldown yet, or
 * it has rolled off -- `offers.ts`'s own documented contract for
 * `nextFindAt`: `nextFindAt === undefined || nextFindAt <= now`.
 */
export function canFindOtherStores(nextFindAt: number | undefined, now: number): boolean {
  return nextFindAt === undefined || nextFindAt <= now;
}
