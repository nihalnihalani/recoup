import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

/**
 * Price watch (T09). Every tick costs one Firecrawl scrape plus one OpenAI
 * extraction per eligible item. Two hours keeps that small while giving the
 * price charts twelve real readings a day; an adjustment window is short, so a
 * drop found half a day sooner matters. `runAll` is idempotent — a tick with
 * nothing in an open window does nothing at all.
 */
crons.interval("price watch", { hours: 2 }, internal.priceWatch.runAll, {});

/**
 * Watches (W1). The tick is not the cadence: each watch carries its own
 * `nextCheckAt` (WATCH_CHECK_INTERVAL_MS after its last check), so an hourly tick only
 * spreads the load and picks up new or resumed watches sooner. A tick with
 * nothing due costs one indexed read.
 */
crons.interval("watch sweep", { hours: 1 }, internal.watches.sweep, {});

/**
 * Inbound mail safety net: unstick rows whose action died and re-run failed ones that still
 * have attempts left. A tick with nothing to do costs two bounded indexed reads.
 */
crons.interval("retry failed inbound", { hours: 1 }, internal.intake.retryFailed, {});

/**
 * Durable mail delivery safety net (T06, D68). Picks up `mailLog` rows stuck
 * `claimed` (a crash between claim and the enqueue transaction), `queued`
 * (a reconcile that never got its scheduled follow-up), or `unknown`
 * (reconciliation exhausted its backoff) past their `nextCheckAt`, and
 * re-drives them via `sendDrop`/`reconcileDrop`. A tick with nothing due
 * costs one bounded indexed read per status.
 */
crons.interval("mail sweep", { hours: 1 }, internal.notify.sweepStalled, {});

/**
 * Data retention (D75, T16). `retention.sweep` self-reschedules through a
 * bounded page at a time until every rule has caught up for the day, then
 * stops; this daily firing starts the next cycle. See convex/retention.ts's
 * module docstring for the cursor/self-reschedule design.
 */
crons.interval("retention sweep", { hours: 24 }, internal.retention.sweep, {});

/**
 * Confirmed other-store offers (W3), once a day at 13:00 UTC, which is early morning on the US west
 * coast where the demo account lives. Convex crons are UTC and do not follow daylight saving, so this
 * drifts by an hour in winter; a re-check is not time-critical, it just has to be recent.
 */
crons.cron("offer prices", "0 13 * * *", internal.offers.sweepRechecks, {});

/**
 * Account-deletion re-drive (6b-4c, D115). `account.requestDeletion`'s purge
 * chain is meant to be self-sustaining (`purge` reschedules itself on every
 * unfinished step and every inbox-delete retry), but a process crash between
 * recording that decision and actually arming the next scheduled call can
 * still orphan a `deleting` row with nothing left in the scheduler --
 * `beforeSessionCreation` (`convex/auth.ts`) stops such a zombie account
 * from being signed into, but does nothing to finish deleting it. Daily is
 * generous next to `STUCK_DELETION_AGE_MS` (24h): a tick with nothing stuck
 * costs one bounded, indexed read and reschedules nothing.
 */
crons.interval("account re-drive", { hours: 24 }, internal.account.reDriveStuckDeletions, {});

/**
 * T18.4 (D115 6b-5): daily sweep of the AgentMail component's own
 * finalized-outbound retention window (`outboundMessages` rows in a
 * terminal/`sent` status older than the component's default cutoff),
 * independent of account deletion -- it runs for every inbox so the
 * outbound log does not grow unbounded for accounts that are never
 * deleted. See `convex/mailPurge.ts`'s own docstring for the exact line
 * (reproduced here as instructed by that module).
 */
crons.interval("agentmail outbound cleanup", { hours: 24 }, internal.mailPurge.cleanupFinalizedOutbound, {});

/**
 * Transaction-recovery retention (M14; DA-A-7, D146, DA-A-32). Clears
 * email/paste evidence text and unattached uploads 30 days after receipt
 * unless a claim or the user keeps them, then prunes old evaluations that
 * nothing references. `retention.sweepRecovery` self-reschedules one
 * bounded page at a time until the cycle is done, like `retention.sweep`,
 * but with its own cursor (opsState `retentionRecovery`). See
 * convex/retention.ts.
 */
crons.interval("recovery retention sweep", { hours: 24 }, internal.retention.sweepRecovery, {});

/**
 * Orphan blob sweep (M14; SEC-UP-7, DA-A-28(d)). Deletes `_storage` blobs
 * older than 24 h that no field registered in `lib/blobRefs.ts` references,
 * e.g. an upload whose finalize never ran. Self-reschedules page by page
 * (opsState `orphanSweep`, whose age M1B's `ops.backlog` reports).
 */
crons.interval("orphan blob sweep", { hours: 24 }, internal.retention.sweepOrphanBlobs, {});

/**
 * Deadline sweep (M29; C50, D158, SEC-CH-6; rev 5.2). Hourly: re-evaluates `not_yet_due` opportunities whose
 * `reevaluateAt` has passed (M20's `opportunities.sweepReevaluateDue`, one bounded page), then scans running USER
 * deadlines and schedules one state-re-reading `deadlines.remind` per opportunity whose in-app attention must be set
 * or cleared. In-app only; nothing is ever sent (D03). A tick with nothing due costs two bounded index reads plus the
 * re-evaluation page. See convex/deadlines.ts.
 */
crons.interval("deadline sweep", { hours: 1 }, internal.deadlines.sweep, {});

/**
 * Evidence extraction safety net (M23 provides it, M29 schedules it; D246): re-queues extraction runs whose
 * `EXTRACTION_LEASE_MS` (15 min) lease expired, gives up after `MAX_EXTRACTION_ATTEMPTS`, and re-schedules queued rows
 * (a budget pause or a lost schedule). Every 15 minutes, the lease length. With live extraction OFF nothing is ever
 * queued, so a tick costs two bounded index reads.
 */
crons.interval("evidence extraction retry", { minutes: 15 }, internal.evidence.retryStalledExtractions, {});

export default crons;
