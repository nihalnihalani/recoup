# Operator runbook

Owner: T22 (P12 operations and docs). Source contract: `docs/team/PLAN.md`
T22, `docs/team/DECISIONS.md` D62, D75-D79, D83, D94 (F12a), D98, D99 (F12a),
D102, D105, `docs/reviews/2026-09-21-phase0-reproduction.md` P12 rows ("no
operator kill-switch documentation", "no backup/restore/migration/rollback
runbook"). Environment variable reference: `docs/ops/ENVIRONMENT.md`.
Install/CI gates: `docs/ops/INSTALL.md`.

All commands below are `npx convex ...` unless noted, and target a
deployment by name with `--deployment <name>` (or `--prod` for the project's
production deployment, `cool-oyster-399` per current docs — see
`docs/ops/ENVIRONMENT.md`). **Every command in this file that writes or
deletes data is written against a non-production deployment.** Production
deploys/writes are not authorized in this mission (D83 item 6) — if you are
an operator reading this after that changes, replace `--deployment
adorable-lion-138` with `--prod` deliberately, never by habit, and get a
second person to confirm first for anything destructive.

## 1. Pause and resume costly or outbound work

`convex/ops.ts`'s `pauseKind`/`resumeKind` are the operator kill switch (D79):
they read/write the same deployment-wide `usage` row that `convex/limits.ts`'s
`GLOBAL_DAILY_BUDGETS` and `convex/lib/budget.ts`'s
`tryConsumeGlobalBudget`/`consumeGlobalBudget` already enforce on every paid
call, so pausing a kind takes effect immediately for every user, not just new
signups, and needs no code deploy.

**Pause** writes today's (UTC) usage count for `kind` up to its max, so the
next call anywhere in the app that draws from that switch is refused exactly
as if the real daily budget had been spent:

```sh
npx convex run ops:pauseKind '{"kind":"price_check"}' --deployment adorable-lion-138
```

**Resume** clears today's usage row for `kind` back to zero (not to whatever
real usage was before the pause — that number was never recorded):

```sh
npx convex run ops:resumeKind '{"kind":"price_check"}' --deployment adorable-lion-138
```

Valid `kind` values (`convex/limits.ts`'s `GLOBAL_DAILY_BUDGETS`) and what
each one stops:

| `kind` | Stops |
|---|---|
| `price_check` | Every automatic price read: `watches.sweep`'s hourly tick and `priceWatch.runAll`'s tick, plus manual "check now" on owned items and watches (their own per-user daily cap still applies underneath; this is the deployment-wide ceiling) |
| `policy_fetch` | New price-adjustment/returns policy research (`convex/policies.ts`) triggered by purchase creation/confirmation or a manual refresh |
| `drop_email` | **Outbound mail**: price-drop alert emails (`convex/notify.ts`) to account holders |
| `market_lookup` | Third-party ShopSavvy price-history lookups (`convex/market.ts`) |
| `claim_email` | **Outbound mail**: the claim request emails a user approves and sends (`convex/drafts.ts`) |
| `inbound_extract` | Model extraction of pasted/forwarded order emails (`convex/intake.ts`) — pausing this does not stop inbound webhook events from being *received* (they still get a `processedEvents` row), only from being *read* by the model; a refused one becomes `needs_review` and is retried hourly once you resume |

`pauseKind`/`resumeKind` throw a `ConvexError` for any other string,
including a real *per-user* budget kind like `draft_generate` (those have no
global switch to pause — see `convex/limits.ts`'s `DAILY_BUDGETS` vs
`GLOBAL_DAILY_BUDGETS`).

**To stop everything at once** (a full incident, not just one kind): call
`pauseKind` for all six kinds above, in one shell loop:

```sh
for k in price_check policy_fetch drop_email market_lookup claim_email inbound_extract; do
  npx convex run ops:pauseKind "{\"kind\":\"$k\"}" --deployment adorable-lion-138
done
```

**Last resort, not a substitute for the above:** removing a provider key
(`npx convex env remove AGENTMAIL_API_KEY`, etc.) also stops the
corresponding paid calls, because every call site fails closed on a missing
key (D79). Prefer `pauseKind` — it is scoped, instant, and does not also
break unrelated reads (e.g. removing `AGENTMAIL_API_KEY` would also break
inbox creation and auth mail, not just claim-email sending).

## 2. Rotate a key

1. Get the new value from the provider (OpenAI, Firecrawl, AgentMail, or
   ShopSavvy's own dashboard).
2. `npx convex env set NAME 'new-value' --force --deployment <name>`
   (`--force` is required because the CLI refuses to silently overwrite a
   value that is already set to something different).
3. No redeploy is needed — every call site reads `process.env.NAME` fresh on
   each invocation (D12(c)); the new value takes effect on the next call.
4. **`AGENTMAIL_WEBHOOK_SECRET` specifically:** rotate the secret in the
   AgentMail webhook configuration first, then set the same new value here.
   Doing it in the other order (or only on one side) makes every inbound
   webhook 401 ("invalid signature") until both sides agree — fails closed,
   but inbound mail is down for that window.
5. **`JWT_PRIVATE_KEY`/`JWKS` specifically:** these are the Convex Auth
   signing keys; rotating them invalidates every existing session (every
   signed-in user is signed out). Do not rotate these casually; there is no
   code in this repo to regenerate them other than re-running
   `npx @convex-dev/auth`'s own setup, which is outside this file's scope.

## 3. Post-deploy migrations

Two resumable, idempotent migrations exist. Run both after any deploy that
could have left rows to backfill (a fresh deployment, or after a schema
change touching `authAccounts`/`users.email` normalization or `watches`
market-state fields). Both are safe to run against a deployment with nothing
to migrate — they scan a page, find zero eligible rows, and return
`done: true, scanned: <page size>, ...: 0`.

**`lib/authMigrate:normalizeLegacyAccounts`** — lowercases/trims legacy
`authAccounts.providerAccountId`/`users.email` rows that predate D67's
normalize-on-write (see the module's own doc comment in
`convex/lib/authMigrate.ts` for why this matters: an un-migrated legacy row
is permanently unreachable at sign-in, not just cosmetically wrong):

```sh
npx convex run lib/authMigrate:normalizeLegacyAccounts '{}' --deployment adorable-lion-138
```

It reschedules itself until the whole table is scanned (`done: false` means
"more to do, already queued", not "call it again yourself"). If it reports
`collisions > 0`, two accounts normalize to the same address; resolve by hand
(rename or remove the blocking row — the collision is left untouched, never
auto-merged), then re-run with `restart: true` to force a full rescan instead
of resuming from the cursor past the row you just fixed:

```sh
npx convex run lib/authMigrate:normalizeLegacyAccounts '{"restart":true}' --deployment adorable-lion-138
```

**`market:migrateStamps`** — classifies pre-D71 watches that have an old
`marketFetchedAt` timestamp but no `marketState` (see `convex/market.ts`'s
own doc comment on `migrateStamps`):

```sh
npx convex run market:migrateStamps '{}' --deployment adorable-lion-138
```

Never charges a budget or schedules a fetch; purely a state classification
pass. Also self-reschedules until `done: true`.

## 4. Read the backlog

```sh
npx convex run ops:backlog '{}' --deployment adorable-lion-138
```

Returns bounded counts (each capped at `scanLimit`, default 2000; pass
`{"scanLimit": N}` to raise or lower it) with a `truncated` flag meaning "the
real number is at least this, possibly more":

| Field | A large or growing number means |
|---|---|
| `dueWatches` | The hourly `watches.sweep` cron is falling behind (or paused via `price_check` — check that first) |
| `dueItems` | The 2-hour `priceWatch.runAll` cron is falling behind (same check) |
| `processedEventsFailed` | Inbound webhook/paste processing is failing faster than the hourly `intake.retryFailed` safety net clears it — read a few rows' `lastError`/`errorSummary` by hand (`npx convex run --inline-query 'await ctx.db.query("processedEvents").withIndex("by_status", q => q.eq("status", "failed")).take(5)'`) before assuming it will self-heal |
| `mailLogQueued` | Mail handed to AgentMail with no confirmed message id yet; the hourly `notify.sweepStalled` cron re-checks these — a persistently large number suggests AgentMail's own status API is failing, not just slow |
| `mailLogUnknown` | Reconciliation gave up after its backoff schedule with still no message id; these do not self-heal further, and are effectively "delivery unknown" state shown to the user (D13) |
| `staleMarketRunning` | A ShopSavvy lookup has been claimed `running` for over 15 minutes — almost certainly a crashed/killed action, not one still in flight (a real call times out at 30s). It self-heals the next time anyone calls `market.refresh`/`requestLookup` on that exact watch (the stale-reclaim logic in `market.ts`), but a watch nobody revisits can sit here indefinitely; a nonzero, non-shrinking count across repeated `backlog` calls is worth a look |

`now` in the response is the wall-clock time the read happened, for
comparing against timestamps you pull separately.

**Reading `market_lookup` budget status alongside `staleMarketRunning`
(D107 C5, T12.2):** the per-user `market_lookup` cap (5/day,
`convex/limits.ts`'s `DAILY_BUDGETS.market_lookup`) counts only *new-watch*
lookups and *manual* refreshes. An automatic retry of an existing lookup
(`attempt > 1` in the backoff chain) charges the deployment-wide global
counter only, never the per-user one — so a single watch stuck retrying
cannot by itself exhaust or explain a user hitting their per-user cap; a
user reporting "market history refuses to load and I haven't refreshed much"
is more likely hitting the *global* switch (check `budget.status` for that
user, and whether `pauseKind`/an organic deployment-wide exhaustion is in
play) than their own 5/day. A manual retry after a watch reaches
`terminal_failure` also resets its attempt counter, so "stuck failed
forever" for one watch is not expected either — if you see it, that is
worth a closer look, not an assumed dead end.

## 10. `E2E_SEED_ENABLED` on production breaks real auth, not just fixtures

Worth repeating from `docs/ops/ENVIRONMENT.md` because the failure mode is
easy to underestimate: setting `E2E_SEED_ENABLED=true` on the production
deployment does not just make `convex/testing.ts`'s seed/reset functions
refuse — it makes **every real sign-up and password reset fail loudly**,
because the same production-host guard is also called, unconditionally and
uncaught, from the shared auth-mail send path (`convex/lib/authMail.ts`'s
`authMailTransport.send` → `recordE2ECode`) whenever the flag is on (D107).
Confirm this variable is absent on production (`npx convex env list
--prod`) as part of any environment audit, not only at initial setup — and
remember the host check it relies on (`cool-oyster-399`, hardcoded in two
places) needs updating by hand if production ever moves to a different
deployment name (`docs/ops/ENVIRONMENT.md`'s E2E-only section has the exact
locations).

**`seedFixtures`' queued mailLog row is render-only (T18.5/F-T23-1b).**
`convex/testing.ts`'s `seedFixtures` writes one `mailLog` row `status:
"queued"` with `outboundId: "e2e-outbound-queued" as never` — a fake
placeholder string, never a real AgentMail component id, purely so an E2E
run's UI has something in the "sending" state to render. Do not point
`notify.reconcileDrop`/`sweepStalled` (or any hand-run `ops` inspection) at
this row expecting a real component lookup to succeed: `agentmail.status`
against a fake id fails, the same way it would for any malformed id. If a
seeded E2E account's mail log looks "stuck" on this one row, that is
expected and not a bug to chase.

## 5. Interpret a `logEvent` kind

`convex/lib/log.ts`'s `logEvent(kind, fields)` writes one JSON line per
event via `console.error`, so every line is visible in `npx convex logs
--deployment <name>` (add `--jsonl` for raw JSON, then pipe through `grep`/
`jq` to filter by `kind`, e.g. `npx convex logs --jsonl --deployment
adorable-lion-138 | grep '"kind":"market_failed"'`). Every line carries a
fresh `correlationId` (not linked across lines automatically — if you are
chasing one incident across a retry chain, match on other fields in the line
instead, like a `watchId` or `claimId`) and a redacted `fields` payload (no
raw secret ever reaches the log — see the module doc comment in
`convex/lib/log.ts` for exactly what gets stripped).

| `kind` | Roughly means | Where |
|---|---|---|
| `extraction_failed` | A model call for order/price/policy extraction ran but produced nothing usable | `intake.ts`, `priceWatch.ts` |
| `notification_failed` | A price-drop alert send failed outright | `notify.ts` |
| `notification_stalled` | A price-drop alert is stuck `claimed`/`queued`/`unknown` past its reconcile window | `notify.ts` |
| `price_check_failed` | A scrape/read of a product page failed | `priceWatch.ts`, `watches.ts` |
| `budget_exhausted` | A deployment-wide global budget refused a call (a symptom, not a bug — check whether it was paused deliberately via §1 first) | anywhere `charge`/`tryCharge`/`consumeGlobalBudget` is on the call path |
| `webhook_rejected` | An inbound webhook failed signature verification or malformed-body validation | `http.ts` |
| `scheduler_backlog` | A cron/sweep noticed it is behind (see §4's `backlog` fields for the same signal on demand) | crons/sweeps |
| `market_failed` | A ShopSavvy lookup failed (`retryable_failure`/`terminal_failure`) | `market.ts` |
| `migration_progress` | A resumable migration page ran (§3) | `lib/authMigrate.ts`, `market.ts` |

As of this writing, `logEvent` is a primitive with tests
(`convex/lib/log.test.ts`) but the existing bare `console.error` call sites
in `notify.ts`, `priceWatch.ts`, `watches.ts`, `offers.ts`, `policies.ts`,
`market.ts`, and `inbound.ts` have not yet been switched over to it — that
mechanical replacement is a separate, later pass (`docs/team/PLAN.md`
D106/T22 note: "the `console.error` → `logEvent` sweep is a lead-scheduled
mechanical pass after T16/T18 land"). Until that lands, those call sites'
existing plain-text `console.error` lines are still what `npx convex logs`
shows for those paths — the kind table above describes the taxonomy the
sweep will tag them with, not a claim that every line is JSON today.

## 6. Disable the inbound webhook

Two ways, different blast radius:

- **Provider side (correct way):** disable or delete the webhook in the
  AgentMail dashboard. Inbound mail is simply not forwarded; nothing in this
  app is touched.
- **This deployment's side:** `npx convex env remove AGENTMAIL_WEBHOOK_SECRET
  --deployment <name>` (or set it to a value that no longer matches the
  provider's). Every inbound POST to `/agentmail/webhook` then fails with a
  clean **401 and an empty body** (F-T22-1, T24b): `convex/http.ts` checks
  `process.env.AGENTMAIL_WEBHOOK_SECRET` by name before ever calling into the
  AgentMail component, so an unset secret can no longer reach the component's
  own `assertConfigured("webhook")` throw (which, uncaught, used to surface
  as a bare 500 — that was the previously-documented behaviour here; fixed by
  F-T22-1 and covered by `convex/http.test.ts`). No event is ever applied
  either way — this path always fails closed. Prefer the provider-side
  disable when you have a choice; use the env-var removal only when you
  cannot reach the provider dashboard.

## 7. `AUTH_LOG_LEVEL` / `AUTH_LOG_SECRETS` — never set these

`@convex-dev/auth` (not a variable this app defines) supports
`AUTH_LOG_LEVEL=DEBUG` and `AUTH_LOG_SECRETS=true` for its own verbose
debug logging. **Never set either one on any deployment reachable by real
users** (D99/F12a). At that log level the library can print verification
codes, session tokens, and password-reset material into the function log,
which is exactly the class of secret `convex/lib/log.ts`'s redaction exists
to keep out. If you need to debug an auth issue, read the specific
`authAccounts`/`authSessions`/`usage` rows involved with an ad hoc
`--inline-query` instead of turning on library-wide debug logging.

## 8. What a code rollback does NOT undo

Rolling back to an older commit and redeploying only changes which function
code runs. Three things it never reverts:

1. **Schema.** This repo's convention is additive-only schema changes (no
   existing table loses a field; new fields are always optional — see
   `convex/schema.ts`'s own comments and `docs/team/DECISIONS.md`'s D01-era
   invariants), specifically so an older deploy of function code keeps
   working against the current schema. But the schema itself is not rolled
   back by redeploying old code — if the commit you are rolling back to
   predates a schema change, you are running old code against the *current*
   (newer) schema, not the schema that shipped with that commit. Check
   `convex/schema.ts`'s git history for what actually changed before
   assuming a rollback fixes a schema-shaped problem.
2. **Data.** Every row already written stays written. A rollback does not
   un-run a migration (§3), un-prune a retention sweep, or restore a row a
   user deleted. If bad code wrote bad data, fixing the code stops it from
   writing *more* bad data; the existing bad rows still need a deliberate
   fix (by hand, or a follow-up migration) or a restore from a backup (§9).
3. **Sent mail.** A claim email or price-drop alert that already left
   AgentMail is not unsent by any action in this app. `mailLog`/`drafts`
   rows record what happened; they do not control what already happened.

## 9. Backup (export) and restore (import)

**Export** a deployment's data to a local ZIP (`--include-file-storage` also
captures the AgentMail-unrelated `_storage` table, if this deployment ever
uses Convex file storage directly — currently this app does not, but the
flag is harmless either way):

```sh
npx convex export --path backup-$(date +%Y%m%d-%H%M%S).zip --deployment adorable-lion-138
```

**Restore** into a **non-production** deployment only — never the deployment
named as production in `docs/ops/ENVIRONMENT.md`/`README.md`
(`cool-oyster-399`), and never without the user's explicit say-so even then
(D83 item 6: a production deploy/write is not authorized in this mission).
A fresh preview deployment or the shared dev deployment are the intended
targets:

```sh
# Merge into whatever already exists in the target deployment:
npx convex import backup.zip --deployment adorable-lion-138

# Or fully mirror the snapshot, deleting anything in the target that is not
# in the backup (confirms interactively unless you pass -y):
npx convex import --replace-all backup.zip --deployment adorable-lion-138
```

Both commands were verified against this project's actual Convex CLI
(`npx convex export --help` / `npx convex import --help`) while writing this
runbook, not copied from memory — the flags above are exactly what the CLI
in this repo's `package.json` (`convex@^1.46.0`) offers. Neither command was
run for real as part of writing this file; do that only when you actually
need a backup/restore, and only against a deployment you are sure is not
production.

## 11. Retention: never-verified accounts, and a stalled cursor

- **Never-verified accounts are purged after 7 days and cannot be recovered.** `convex/retention.ts`'s daily sweep deletes any `users` row with no `emailVerificationTime` once it is more than `RETENTION_UNVERIFIED_DAYS` (7) days old and owns no purchases/watches/claims/profiles rows (D107 hygiene addendum — sign-in itself is gated on verification, so an unverified account can never legitimately own any of those). There is no undo; the person must sign up again.
- **Read a stalled retention cursor:** `npx convex run ops:backlog '{}' --deployment adorable-lion-138` — its `retention` field names which table the resumable sweep (`convex/retention.ts`'s `sweep`) is currently on (`rule`), how long the cursor has sat there untouched (`cursorAgeMs`), and whether that exceeds the 48h stall threshold (`stalled: true`, almost always one row on that table the sweep keeps failing to process — a poison page). Inspect the raw cursor first if you want to see exactly what it holds: `npx convex run --inline-query 'await ctx.db.query("opsState").withIndex("by_key", q => q.eq("key", "retention")).unique()' --deployment adorable-lion-138`.
- **Reset it** with `ops:resetRetentionCursor` (T18.5/F-T23-3) — **not** `npx convex run --inline-mutation`, which does not exist in this repo's pinned CLI (`convex@1.46.0` ships `--inline-query` only; there is no ad hoc inline-mutation escape hatch, unlike the read above):
  ```sh
  # Restart the whole cycle from the top (RETENTION_STEPS[0], "processedEvents"):
  npx convex run ops:resetRetentionCursor '{}' --deployment adorable-lion-138

  # Skip only the stuck step for this cycle (N = the index into
  # convex/ops.ts's RETENTION_STEPS, e.g. 4 for "mailLog"):
  npx convex run ops:resetRetentionCursor '{"step":4}' --deployment adorable-lion-138
  ```
  Both forms return the cursor as it was *before* the reset, so you can confirm what you just overwrote. Then resume progress with `npx convex run retention:sweep '{}' --deployment adorable-lion-138`.

## 12. Account deletion

`convex/account.ts`'s `requestDeletion`/`purge`/`purgeStep` (T18, D77;
checkpoint 6c conditions closed T18.5/D124) tombstone an account, delete its
owned rows, drain the AgentMail component's own copies of its mail, and
attempt to delete the remote AgentMail inbox — all bounded and resumable.
Most of this is unattended; the cases below are the ones that need a human.

**Read stuck deletions:** `npx convex run ops:backlog '{}' --deployment
adorable-lion-138` — its `deletions` field (`{ stuck, deletingTotal }`,
T18.5) reports `accountState` rows stuck `status: "deleting"` for over 24h
(`STUCK_DELETION_AGE_MS`) with no live scheduled `purge` job, alongside
every `deleting` row currently in flight. A nonzero `deletingTotal` alone is
not a problem — ordinary in-flight purges show up there too, and the daily
`reDriveStuckDeletions` cron re-schedules anything genuinely stuck within
24h on its own. A **persistently nonzero `stuck`** across repeated
`backlog` calls (hours apart) means that cron itself is not running — check
`npx convex logs` for `reDriveStuckDeletions` errors before assuming any one
row is unrecoverable. To force an immediate re-drive instead of waiting for
the next cron tick: `npx convex run account:reDriveStuckDeletions '{}'
--deployment adorable-lion-138`.

**What `inboxDeleted: false` means, and the manual fallback.**
`account.deletionStatus`/the per-row `accountState.inboxDeleted` field is
read LITERALLY, never inferred from `status` (`purge`'s own docstring has
the full state table): `status: "deleted"` means Recoup's own side (app
data, the AgentMail component's per-inbox rows, and every auth row) is
fully gone; `inboxDeleted: false` on a `"deleted"` row means the REMOTE
AgentMail inbox itself was never confirmed deleted after all 5 retry
attempts (backoff: 1m, 10m, 1h, 6h, 24h — `INBOX_DELETE_BACKOFF_MS`). This
is not a stuck row (there is no more retry chain to re-drive: the account is
already fully `"deleted"` on Recoup's side) — it needs a one-time manual
DELETE against the provider:

```sh
curl -X DELETE "https://api.agentmail.to/v0/inboxes/<inboxId>" \
  -H "Authorization: Bearer $AGENTMAIL_API_KEY"
```

Find `<inboxId>` and confirm the failure via `npx convex run
--inline-query 'await ctx.db.query("accountState").withIndex("by_status", q
=> q.eq("status", "deleted")).take(20)' --deployment adorable-lion-138`
(bounded, not `.collect()` — see this section's own point about never
issuing an unbounded read; a `stuck`/`deletingTotal` count over 20 is
`ops.backlog`'s job, not this ad hoc query's), filtering for `inboxDeleted:
false`, and read `lastError` on the same row
for why it kept failing (sanitized — never the raw provider body, see
`lib/errors.ts`). A 404 from the DELETE call above means it is already gone
(nothing further to do); referencing `$AGENTMAIL_API_KEY` by name only, per
§2 — never paste the literal key into a command you might share or log.
There is no in-app "retry inbox delete" action once `status` is already
`"deleted"`; this manual call is the only remaining path.

**Ownerless `processedEvents` rows for a still-live inbox.** Two
independent things can each leave a `processedEvents` row with no `userId`:
(1) a rate-limited/unrouted inbound message the app could not attribute to
any user at ingest time (D115 6b-7, unrelated to deletion), and (2) mail
that arrives for an inbox whose remote DELETE permanently failed (the
`inboxDeleted: false` case above) — `profiles`/`accountState` are both
already gone by then, so a later inbound webhook for that same (still-live)
inbox is written the same ownerless way, keeping up to 60,000 characters of
message text. Neither case is purge's job to clean up further: the account
side is truthfully `"deleted"` already, and the row is not attributable to
any live account. Both are bounded the same way: `retention.ts`'s daily
sweep clears `processedEvents.payload` (the raw subject/from/text, not the
row itself) for any row in a terminal status older than
`RETENTION_PAYLOAD_DAYS` (30 days) — §11 above covers reading/resetting
that sweep's own cursor if it looks stalled. Deleting the remote inbox by
hand (previous item) stops any FURTHER mail from arriving at all; it does
not retroactively clear rows already written.
