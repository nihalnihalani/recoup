/**
 * T18.4 (D115 6b-5): purges the AgentMail component's per-inbox rows
 * (`inboundMessages`, `outboundMessages`, `events`) as part of account
 * deletion, and a daily sweep of the component's own finalized-outbound
 * retention window.
 *
 * Before this file, nothing ever purged or exported the component's mail
 * content: `convex/account.ts`'s `purge` action deletes the AgentMail inbox
 * over REST (`inboxTransport.deleteInbox`) but never touched the component's
 * local cache of inbound message bodies, outbound payloads, or raw webhook
 * events, so that data outlived the account indefinitely. `purgeInboxData`
 * below is the piece T18.1 (or the lead) wires into `account.purge` to close
 * that gap -- see the "Call site" note at the bottom of this file for the
 * exact line.
 *
 * The component's own `purgeInbox` internal mutation (patched into
 * `@agentmail/convex` -- see `patches/@agentmail+convex+0.1.0.patch` and
 * `node_modules/@agentmail/convex/src/component/lib.ts`) can issue at most
 * one `.paginate()` call per invocation (a hard Convex platform limit), so
 * it drains <= 200 rows from ONE of the three tables per call and returns a
 * cursor that also tracks which table is current. `purgeInboxData` is the
 * driving loop: it keeps calling `purgeInbox` with the returned cursor until
 * the cursor comes back `null` ("purgeInboxComplete" -- every table has been
 * confirmed empty for this inbox), bounded to `MAX_ITERATIONS` calls so one
 * action invocation cannot spin forever on an unforeseen non-converging
 * cursor (the same defensive bound `account.ts`'s `purge` action applies to
 * its own `purgeStep` loop).
 */
import { v } from "convex/values";
import { vOutboundId } from "@agentmail/convex";
import { internalAction, internalMutation } from "./_generated/server";
import { components } from "./_generated/api";

/**
 * One action invocation's ceiling on `purgeInbox` calls. Each call drains
 * <= 200 rows from one table (or just advances past an empty one), so 200
 * iterations comfortably covers three tables with up to ~13,000 rows each
 * before this returns `{ complete: false }` -- truthfully, not by throwing --
 * so the caller can reschedule and resume from the same cursor shape
 * `purgeStep`'s callers already expect from this codebase's other purge
 * loops.
 */
const MAX_ITERATIONS = 200;

/**
 * Drains every `inboundMessages`/`outboundMessages`/`events` row belonging
 * to `inboxId` from the AgentMail component, looping the component's
 * paginated `purgeInbox` mutation until its cursor comes back `null`.
 *
 * Returns `{ complete: false }` (never throws) if `MAX_ITERATIONS` calls
 * were not enough -- the caller (`account.purge`, once wired) should treat
 * that the same way it treats `purgeStep` not finishing: reschedule and call
 * again, resuming from wherever the component's own progress lands (the
 * component call is idempotent -- rows already deleted just don't come back
 * on the next page).
 */
export const purgeInboxData = internalAction({
  args: { inboxId: v.string() },
  returns: v.object({ complete: v.boolean(), deleted: v.number() }),
  handler: async (ctx, { inboxId }) => {
    let cursor: string | undefined = undefined;
    let deleted = 0;

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const result: { cursor: string | null; deleted: number } = await ctx.runMutation(
        components.agentmail.lib.purgeInbox,
        { inboxId, cursor },
      );
      deleted += result.deleted;
      if (result.cursor === null) {
        return { complete: true, deleted };
      }
      cursor = result.cursor;
    }

    return { complete: false, deleted };
  },
});

/**
 * Sweeps the component's own finalized-outbound retention window
 * (`outboundMessages` rows in a terminal/`sent` status older than
 * `olderThan`, default 7 days -- see `cleanupFinalizedOutbound`'s own
 * signature: `mutation({ args: { olderThan: v.optional(v.number()) }, ... })`
 * in `node_modules/@agentmail/convex/src/component/lib.ts`). This is
 * independent of account deletion -- it runs for every inbox, on a timer,
 * to keep the outbound log from growing unbounded for accounts that are
 * never deleted.
 *
 * `cleanupFinalizedOutbound` is already public on the component (not
 * gated behind this patch), so this is a thin `internal.*` wrapper purely
 * so `crons.ts` (owned by T18.1) references an app-internal function the
 * way every other cron entry in this codebase does, rather than a bare
 * component reference. Exact line for `crons.ts` (not added here per D115
 * 6b-5's lane split -- T18.4 works in a new file plus `patches/` only):
 *
 *   crons.interval("agentmail outbound cleanup", { hours: 24 }, internal.mailPurge.cleanupFinalizedOutbound, {});
 */
export const cleanupFinalizedOutbound = internalMutation({
  args: { olderThan: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.runMutation(components.agentmail.lib.cleanupFinalizedOutbound, {
      olderThan: args.olderThan,
    });
    return null;
  },
});

// ---------------------------------------------------------------------------
// T18.5 (D124 B1): single-outbound purge.
//
// Price-drop alerts go out from ONE shared inbox (`ALERTS_INBOX_ID`,
// `convex/notify.ts`'s `sendDrop`), never a user's own inbox -- so unlike
// every other outbound send in this app, its component `outboundMessages`
// row (and that row's delivery/bounce `events`) is NOT reachable by
// `purgeInboxData` above, which only ever drains ONE inbox at a time and
// must never touch the shared alerts inbox wholesale (that would destroy
// every OTHER user's alert history along with this one user's). The
// `mailLog` row itself (Recoup's own bookkeeping, `convex/schema.ts`) already
// records exactly which component row to remove via `outboundId`; this is
// the thin `internal.*` wrapper `convex/account.ts`'s `purgeStep` calls, for
// each `mailLog` row it is about to delete that carries one, mirroring
// `cleanupFinalizedOutbound`'s wrapper-only-touches-`components`-here
// convention so `account.ts` never imports `components` directly.
export const purgeOutbound = internalMutation({
  args: { outboundId: vOutboundId },
  returns: v.object({ remaining: v.boolean() }),
  handler: async (ctx, { outboundId }) => {
    // `vOutboundId`'s TS type is `Id<"outboundMessages">` (the component's own
    // table, `@agentmail/convex`'s client index), the same branded id
    // `notify.ts`'s `agentmail.cancel`/`status` calls already pass straight
    // through -- no cast needed.
    return await ctx.runMutation(components.agentmail.lib.purgeOutbound, { outboundId });
  },
});

// ---------------------------------------------------------------------------
// Call site (T18.1/lead wires this into convex/account.ts; not touched here
// -- see the task's explicit "Do NOT edit convex/account.ts" scope):
//
//   await ctx.runAction(internal.mailPurge.purgeInboxData, { inboxId });
//
// Placement: inside `purge` (internalAction), alongside the existing
// `if (inboxId) await inboxTransport.deleteInbox(inboxId);` block (around
// convex/account.ts:711) -- guarded the same way, `if (inboxId)`, and safe to
// call either just before or just after the REST delete since they purge two
// independent systems (this component's local Convex tables vs AgentMail's
// remote inbox) and `purgeInboxData` is idempotent, so a retry after a
// REST-delete failure re-invokes it for free (a second call returns
// `{ complete: true, deleted: 0 }` once the local rows are already gone).
// ---------------------------------------------------------------------------
