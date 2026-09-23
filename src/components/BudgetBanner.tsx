import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { useCoarseNow } from "../lib/time";

/**
 * Plain-word label for each `DAILY_BUDGETS` kind, mirroring the `label`
 * fields in `convex/limits.ts` -- `budget.status` reports only the bare
 * `kind` key, not its label, so this is kept in sync by hand.
 */
const KIND_LABELS: Record<string, string> = {
  paste: "reading pasted emails",
  intake_retry: "re-reading emails",
  policy_refresh: "re-reading store policies",
  policy_fetch: "looking up store policies",
  draft_generate: "writing drafts",
  claim_email: "sending claim emails",
  item_check: "checking prices on your purchases",
  watch_check: "checking prices on watched items",
  market_lookup: "market history look-ups",
};

function capitalize(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * A deployment-wide daily switch some action's budget draws from (D73) can
 * run out before this user's own per-day limit does: `budget.status`'s
 * `paused` is true exactly then, per kind. This names which of the user's
 * own actions are affected right now.
 *
 * F2 (D266 audit): `pauseReason` tells the two causes apart. "cap" is the
 * ordinary daily counter, a UTC calendar day, so "tomorrow" is correct. An
 * "operator" pause (P12-W4) is durable -- it outlives UTC midnight and lifts
 * only when `ops.resumeKind` runs -- so promising "tomorrow" would be false.
 *
 * Rendered only inside `<Authenticated>` routes (Board, Watching): `budget.status`
 * requires a signed-in user and throws otherwise, so this must never render
 * where a signed-out visitor could see it.
 */
function labelsFor(kinds: { kind: string }[]): string[] {
  return kinds.map((k) => capitalize(KIND_LABELS[k.kind] ?? k.kind));
}

export function BudgetBanner() {
  const now = useCoarseNow();
  const status = useQuery(api.budget.status, { now });
  if (status === undefined) return null;
  const paused = status.kinds.filter((k) => k.paused);
  if (paused.length === 0) return null;

  // F2: an operator pause never says "tomorrow" or names a reset time nobody controls; a cap does.
  const capPaused = paused.filter((k) => k.pauseReason !== "operator");
  const operatorPaused = paused.filter((k) => k.pauseReason === "operator");

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex flex-wrap items-center gap-2 rounded-xl border border-yellow-500/30 bg-yellow-500/10 px-4 py-2.5 text-sm text-yellow-800"
    >
      <span className="size-2 shrink-0 rounded-full bg-yellow-500" aria-hidden="true" />
      <span>
        {capPaused.length > 0 && (
          <>
            {labelsFor(capPaused).join(", ")} {capPaused.length === 1 ? "is" : "are"} paused until tomorrow -- today's
            shared limit was reached.
          </>
        )}
        {capPaused.length > 0 && operatorPaused.length > 0 && " "}
        {operatorPaused.length > 0 && (
          <>
            {labelsFor(operatorPaused).join(", ")} {operatorPaused.length === 1 ? "is" : "are"} paused for now -- check
            back later.
          </>
        )}
      </span>
    </div>
  );
}
