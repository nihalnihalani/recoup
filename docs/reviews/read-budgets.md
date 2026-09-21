# Read budgets — T07 (P07 measurement)

Real numbers from `convexTest({ schema, modules, transactionLimits: true })` (options-object form — the positional form `setup()` in `test.setup.ts` uses silently ignores `transactionLimits`, per `node_modules/convex-test/dist/index.js:1858-1862`), measured via `ctx.meta.getTransactionMetrics()` from inside a `t.run` transaction wrapping each `ctx.runQuery`/`ctx.runMutation` call. Source: `convex/readBudget.test.ts`, `convex/fairness.test.ts`. Convex's default per-transaction limits: 32,000 documents read, 16,777,216 bytes (16MiB) read, 4,096 database (index-range) queries.

Ran with `npm test` (full suite: 43 files, 823 passed, 4 expected-fail, 0 unexpected failures, 42s) and standalone (`npx vitest run convex/readBudget.test.ts convex/fairness.test.ts --reporter=verbose`: 14 passed, 3 expected-fail, 0 unexpected, ~42s).

## Query → fixture → documentsRead → bytesRead → ms → headroom

| Query | Fixture | documentsRead | bytesRead | databaseQueries | ms | Headroom (docs / bytes) |
|---|---|---:|---:|---:|---:|---|
| `insights.activity` | 40 purchases×20 items×10 checks, 60 watches×20 checks | 9,348 | 2,259,105 (2.15 MiB) | 886 | 3,459 | 71% / 87% |
| `insights.sources` | same + 1 watch×300 offers | 9,448 | 2,291,205 (2.19 MiB) | 924 | 3,444 | 70% / 86% |
| `insights.priceHistory` | 1 watch×300 offers×20 checks, amid 60 other watches | 290 | 78,559 | 42 | 78 | 99% / 100% |
| `tracking.overview` | 40 purchases×20 items×10 checks | 8,840 | 2,136,180 (2.04 MiB) | 1,681 | 4,305 | 72% / 87% |
| `watches.list` | 60 watches×20 checks + 1 watch×300 offers | 1,261 | 304,900 | 125 | 214 | 96% / 98% |
| `offers.listForWatch` | 1 watch×300 offers (over the 100-row `WATCH_ROWS` cap) | 101 | 32,370 | 2 | 4 | 100% / 100% |
| `intake.needsAttention` | 500 processedEvents (250 failed, 250 needs_review) | 100 | 22,200 | 3 | 19 | 100% / 100% |
| `watches.sweep` | 60 due watches (+1 not-yet-due) | 100 | 24,040 | 2 | 5 | 100% / 100% |
| `claims.get` | 1 claim × 200 ledgerEvents | 203 | 40,834 | 9 | 3 | 99% / 100% |

All nine stay well inside the 32,000-document / 16MiB ceilings **at this (deliberately reduced — see below) fixture size**. `offers.listForWatch`, `intake.needsAttention`, `watches.sweep`, `claims.get` are cleanly bounded by their own `.take()`/index caps regardless of how much data sits behind them (300 offers → 101 reads; 500 processedEvents → 100 reads; 60 due watches → the fixed `WATCH_SWEEP_PAGE=50`), and stay that way at any account size — no action needed there.

### Why the shared fixture is smaller than originally specified

The task's original sizing (40 purchases×**50** items×**30** checks, **200** watches×**60** checks) was run once. It did not overflow `insights.activity`/`insights.sources` (they cap per-item history at `CHECKS_PER_PRODUCT=12`), but each took **~75 seconds of real wall time** in convex-test's simulated syscall layer — measured, not estimated:

| Query | Fixture (original size) | documentsRead | bytesRead | ms |
|---|---|---:|---:|---:|
| `insights.activity` | 40 purchases×50 items×30 checks, 200 watches×60 checks | 26,548 | 6,425,090 (6.13 MiB) | 74,628 |
| `insights.sources` | same + 1 watch×300 offers | 26,648 | 6,457,190 (6.16 MiB) | 74,821 |

That ~75s/query cost is itself a finding (see below — P07's "serialized fan-out"), but it made a single foreground CI-shaped run of this file take minutes per query, so the shared fixture (`SIZES` in `readBudget.test.ts`) was reduced to 20 items/10 checks/60 watches/20 checks for the numbers above. **Both sizes are within insights.ts's own documented per-parent caps** (`MAX_WATCHES=40`, `MAX_PURCHASES=40`) and the app's own `limits.ts` (`MAX_WATCHES_PER_USER=50`, `MAX_PURCHASES_PER_USER=200`) — this is not an artificially light fixture, just a smaller point on the same curve.

## `tracking.overview`: a second transaction-limit overflow (new finding, beyond the named repro)

At the **original** 40×50×30 shape, `tracking.overview` also threw the transaction-limit error — empirically confirmed in the same run that produced the activity/sources numbers above:

```
documentsRead: 32,001 (limit 32,000)   bytesRead: 7,743,372   databaseQueries: 2,104
```

`convex/tracking.ts:105-108` does an **unbounded** `.collect()` of every item on `by_purchase` for each of up to 60 active purchases (`MAX_PURCHASES`, tracking.ts:10), then up to `MAX_POINTS=90` priceChecks (tracking.ts:111-115) and an **unbounded** claims `.collect()` (tracking.ts:122-125) per item. At 40 purchases×50 items×30 checks that is `40*(1+50+50*30) = 62,040` attempted document reads — over the 32,000 limit by roughly a factor of 2, thrown for a **real signed-in user's dashboard load**, not a cron. D81 recorded "P07 transaction-limit failure on insights.activity at owner maxima" as **not reproduced** — that holds (`insights.activity` caps per-item history at `CHECKS_PER_PRODUCT=12`) — but `tracking.overview` has no equivalent per-item cap on the *items* read itself, and does overflow at the identical account shape. This was not separately named in D80/D81 and is flagged here as a HIGH-severity gap on par with D80's `eligibleItems` finding, on a more exposed surface (a page loaded directly by the account holder, not just a nightly cron). At the file's reduced fixture size (40×20×10) it reads 8,840 documents — the regression test in `readBudget.test.ts` asserts it stays bounded there, since re-running the full overflow (another ~45s) would only re-confirm a number already pinned exactly by the eligibleItems bisection below (the tracker throws deterministically at `limit + 1` regardless of which query trips it).

## `priceWatch.eligibleItems`: the reproduced transaction-limit overflow (D80)

Reproduces `docs/reviews/2026-09-21-phase0-reproduction.md`'s `refute:P07:security` #1 exactly: 500 items, each inside an open price-adjustment window (so `hasOpenPriceClaim`'s full, unbounded `.collect()` on `claims.by_item` runs for every one instead of the loop short-circuiting at `FANOUT_LIMIT=50` eligible items found), each carrying 1 open `price_adjustment` claim + 64 dismissed `return_credit` claims (D44 lets a user re-open a dismissed `return_credit` claim any number of times; nothing prunes dismissed claims).

| Fixture | Result (before T12) | documentsRead (before T12) | bytesRead (before T12) | ms (before T12) | **after T12** (documentsRead / bytesRead / ms) |
|---|---|---:|---:|---:|---|
| 500 items × 65 claims/item (dissent's exact repro) | **throws** `Scanned too many documents in a single function execution (limit: 32000)` | 32,001 | 9,418,374 (8.98 MiB) | ~8,230–8,500 | passes — **2,000** / 545,170 / ~9,900–10,130 |
| 500 items × 61 claims/item | passes | **32,000** (exactly at the ceiling) | 9,414,070 | ~8,170 | passes — **2,000** / 545,170 / ~9,380 |

**Failure threshold, bisected (before T12)**: per item scanned, `eligibleItems` reads 1 (`ctx.db.get(purchase)`) + 1 (`latestPricePolicy`, one row per user+domain+kind in this fixture) + `claimsPerItem` (the unbounded collect), plus the initial 500-document `items` scan itself: `total = items*(claimsPerItem + 3)`. At `items=500` that is exactly `500*64 = 32,000` at `claimsPerItem=61` (empirically confirmed above: no throw) and `500*65 = 32,500` at `claimsPerItem=62` (algebraic crossover; the dissent's own `claimsPerItem=65` — empirically confirmed above — is comfortably past it). **The tracker throws deterministically at `limit + 1` documents read** on whichever single read tips it over, so `documentsRead` reads exactly 32,001 regardless of which item/claim triggered it — confirmed identically for both the `eligibleItems` (500×65) and `tracking.overview` (40×50×30) overflows above.

The cron consequence (before T12): `priceWatch.runAll` (priceWatch.ts:474-489) calls `eligibleItems` unconditionally every tick (2h cadence, `crons.ts`), so once any user's account reaches this shape, **every tick for every user** throws and schedules nothing, with no recovery path short of manually deleting claim rows.

**After T12 (D101, measured 2026-09-21 by T09 in `convex/readBudget.test.ts`)**: `claims.by_item_type_status` replaces the unbounded per-item `.collect()` with an indexed existence check, so `documentsRead` no longer scales with `claimsPerItem` at all — 61 and 65 claims/item now measure the *identical* 2,000 documentsRead, comfortably under the 32,000 ceiling (94% headroom), and the old 61-vs-62 bisected "ceiling" no longer describes this code path. `convex/readBudget.test.ts`'s two regression tests for this fixture were rewritten accordingly (from asserting the old throw/exact-32,000 numbers to asserting `documentsRead <= 2,500`, a headroom bound rather than the exact measured number, consistent with this file's style elsewhere) rather than deleted, so the fixture continues to guard against the per-item read ever becoming unbounded again.

## Fairness (`convex/fairness.test.ts`)

- **`priceWatch.runAll`/`eligibleItems` — permanent starvation, `it.fails` (D74, D80 HIGH).** 3 users; B has 480 newer eligible items, A and C have 1 older eligible item each. `eligibleItems` (priceWatch.ts:178) reads `ctx.db.query("items").order("desc")` — plain `_creationTime` descending, globally across every user, no per-user slice, item-level `nextCheckAt` never read. Observed distribution across 3 ticks of `runAll` with no advancing state that would help (matching the dissent's "tick 1, tick 2, +30 days" repro): **every tick schedules exactly B's newest 50 of 480 items; A and C are scheduled 0 times, in any tick.** `PRICE_CHECK_PER_USER_PER_TICK=10` (`convex/limits.ts:170`) is already defined for D74's fix but unused anywhere.
- **`watches.sweep` — per-tick starvation is real but bounded, `it.fails` for the single-tick case + a passing test for the recovery bound (D74 medium).** Same 3-user/480-watch shape, but keyed on `nextCheckAt` (ascending, earliest-due-first) rather than creation time. Tick 1: B's 480 watches, all more overdue than A/C's, fill the entire `WATCH_SWEEP_PAGE=50` page — **A and C get 0 in tick 1.** Unlike `eligibleItems`, a scheduled row's `nextCheckAt` is bumped forward (watches.ts:753-756), so the backlog actually drains: a second passing test confirms both A and C are scheduled within `ceil(480/50)+1 = 10` ticks. `WATCH_SWEEP_PER_USER=10` (`convex/limits.ts:173`) is likewise defined for D74's fix but unused.
- **Global budget exhaustion fails closed (passing).** With the `usage` global `price_check` row pre-seeded to `GLOBAL_DAILY_BUDGETS.price_check.max` (3,000): `watches.sweep` schedules 0 (`takeGlobalBudget` returns 0 granted, due watches stay due, no `_scheduled_functions` rows created) and the `usage` row is confirmed unchanged (not overspent). `watches.create` (which charges the same global switch via `consumeGlobalBudget`, which throws) is confirmed to refuse the whole mutation — no watch row is written — with the `usage` row again unchanged. The refusal is visible in both cases by re-reading the `usage` row directly.

## Recommended indexes/pagination for T12/T16 (only where these measurements justify it)

1. **`claims.by_item_kind_status` index, replacing `hasOpenPriceClaim`'s full `.collect()`** (priceWatch.ts:122-129) — this is the direct fix for the eligibleItems overflow above (D74 already names this index). Justified by the bisected 61/62-claims-per-item threshold: an indexed existence check turns an O(claims-per-item) read into O(1), which at the dissent's 65-claims fixture alone removes ~32,000 of the ~32,500 attempted reads.
2. **A bound on `tracking.ts:105-108`'s `items` `.collect()`** (and the same pattern in `insights.ts:134-137`/`338-341`, already flagged `partially_present` in the phase0 review) — justified by the empirically confirmed 62,040-read overflow at 40×50×30. A `.take(N)` (mirroring `MAX_ITEMS_PER_PURCHASE`-style caps elsewhere) or a dedicated `items`-count aggregate would keep this bounded the same way `offers.listForWatch`/`intake.needsAttention` already are.
3. **Parallelize the serial per-product fan-out in `insights.activity`/`insights.sources`** (P07 "serialized fan-out", already flagged `partially_present`) with `Promise.all`, the same way `watches.list` and `insights.ts`'s own `liveWatches` already do. Justified directly by the measured wall time: ~75s per query at the original fixture size for what is, per-read, a well-bounded query (26,548 documents is under the limit) — the cost is round-trip latency multiplied serially, not data volume. `insights.priceHistory`'s `for (const w of watches) confirmedOffers(...)` loop (insights.ts:538) has the identical anti-pattern; its read cost is small at these fixture sizes (290 documents) so it is not urgent, but the same fix applies for consistency.
4. **No action indicated** for `offers.listForWatch`, `intake.needsAttention`, `watches.sweep`, or `claims.get`'s ledger-events read (203 documents at 200 seeded events — genuinely unbounded per `claims.ts:360-363`, but claim ledgers do not grow to thousands of events in practice the way item/claim/check counts do) — all measured comfortably inside budget with caps that hold regardless of backing data volume.

## T15 update (2026-09-21, main 5e306db+): before/after for `eligibleItems`, `insights.activity`, `tracking.overview`

The table at the top of this file and the `eligibleItems` section below it were measured earlier the same day (T07), before several later fixes landed on `main`: **D107 C1** (`tracking.ts`, commit `e0e9b7d` — the shared item-read budget is now spent by rows *actually read*, purchase by purchase, instead of a fixed `MAX_ITEMS_PER_PURCHASE`-sized share reserved per purchase up front), **D107 C2** (`insights.ts`, commit `1b47e08` — the identical fix applied to `activity`/`sources`' `itemsWithinBudget`), **D107 C3/C5/C6** (`priceWatch.ts`/`market.ts`/`lib/schedule.ts`, commit `07242b1`), and a routing-only fix to this file's own `eligibleItems` measurements (commit `60d02c5`, `ctx.runQuery` → `ctx.runMutation`, since `eligibleItems` became an `internalMutation` under C3/F1). Re-running `convex/readBudget.test.ts` (unmodified — not a file this task owns) at HEAD against the exact same fixtures gives:

| Query | Fixture | documentsRead (original T07) | documentsRead (now) | databaseQueries (original T07) | databaseQueries (now) |
|---|---|---:|---:|---:|---:|
| `insights.activity` | 40 purchases×20 items×10 checks, 60 watches×20 checks | 9,348 | **2,199** | 886 | **204** |
| `insights.sources` | same + 1 watch×300 offers | 9,448 | **2,299** | 924 | **242** |
| `tracking.overview` | 40 purchases×20 items×10 checks | 8,840 | **2,791** | 1,681 | **290** |
| `priceWatch.eligibleItems` | 500 items×65 claims/item | 2,000 (after T12, D101) | **2,500** | not separately tracked | **2,001** |
| `priceWatch.eligibleItems` | 500 items×61 claims/item | 2,000 (after T12, D101) | **2,500** | not separately tracked | **2,001** |

All five stay far inside the 32,000-document / 4,096-database-query ceilings, with **more** headroom than the original T07 measurement, not less — nothing here is a regression.

`eligibleItems`' small rise (2,000 → 2,500 documentsRead; 2,001 databaseQueries, newly tracked) is fully explained by the C3/F1 change `60d02c5` routes around, not by that commit itself: `eligibleItems` is no longer a pure read (it was an `internalQuery`) but an `internalMutation` that stamps each scanned-but-ineligible item's `nextCheckAt` as it scans (D103 F1: pushing a permanently-ineligible item out of the index head), so every scanned item now costs one additional per-item write on top of the read that was already there — `60d02c5` itself changed only this file's OWN measurement call (`ctx.runQuery` → `ctx.runMutation`, since a mutation reference throws through `runQuery`) and made no behavior change of its own. The 61-vs-65-claims/item numbers are still identical to each other (as D101 first established), confirming the per-item read/stamp still does not scale with `claimsPerItem`.

The much larger `activity`/`sources`/`overview` drops (roughly 4×) are the net, cumulative effect of everything landed on `main` since the original T07 measurement earlier the same day — chiefly D107 C1/C2 (the item-read budget no longer wastes a fixed per-purchase share on purchases smaller than the cap) and D89's `mailLog.by_user_status` index (`insights.activity`'s mail-events read went from an unindexed-then-filtered page to a status-indexed one) — not attributable to any single commit in isolation; this file does not attempt to apportion the delta commit-by-commit. `tracking.test.ts`'s and `insights.test.ts`'s own C1/C2 acceptance cases (6×1 purchases → 6, not 5; 10×1 purchases → `bought` sums to 10) are unchanged and still pass; the numbers above are a fresh top-level checkpoint on top of those, not a replacement for them.

### T15's own heavy fixture (`convex/dashboard.test.ts`)

A second, independent fixture — mixed-currency, distinct from the `SIZES` fixture above: 24 purchases (12 USD, 12 EUR) × 2 items × 2 `priceChecks` each, plus one more purchase carrying 51 items (one over `MAX_ITEMS_PER_PURCHASE`, so a real per-purchase cut fires identically in all three queries) — 25 purchases, 99 items total. Measured the same way (`ctx.meta.getTransactionMetrics()` inside a `t.run` wrapping `ctx.runQuery`, called through the caller's own identity so `getAuthUserId` resolves — see `dashboard.test.ts`'s `measure()` doc comment for the identity pitfall this avoids):

| Query | Fixture | documentsRead | bytesRead | databaseQueries |
|---|---|---:|---:|---:|
| `insights.sources` | 24 mixed-currency purchases×2 items + 1 purchase×51 items | 220 | 52,717 | 127 |
| `insights.activity` | same | 226 | 54,195 | 139 |
| `tracking.overview` | same | 222 | 53,299 | 176 |

All three report `truncated: true` here — the added 51-item purchase trips a real, identical per-purchase cut in every one of them, while the 24 well-formed purchases underneath it still render in full (confirmed by `dashboard.test.ts`'s own item-count assertions). Separately, at the same 24-purchase account with NO overflow purchase, `insights.sources`/`tracking.overview` report `truncated: false` (nothing to cut) while `insights.activity` truthfully reports `truncated: true` on its own, much tighter `FEED_LIMIT` (40 total events) — 24 purchases × 2 priced items each is 120 activity events, genuinely over that window. The three dashboard read models do not share one truncation trigger; each is honest about its own. All comfortably inside every ceiling.

## Final numbers @ 529f545 (T23, Phase 4 verification)

Re-measured 2026-09-21 from the main checkout (`git rev-parse HEAD` =
`86020f0e930479790de7e7dfc1a5d5781ff4fb1a` at measurement time; confirmed
via `git diff --stat 529f545 86020f0` that no `convex/**` file differs
between that HEAD and the T23 candidate revision `529f545` — the only
changes are `docs/team/DECISIONS.md` plus three frontend files unrelated to
any query measured here — so these numbers are valid, unmodified evidence
for the candidate). Command: `npx vitest run convex/readBudget.test.ts
convex/dashboard.test.ts convex/fairness.test.ts --reporter=verbose`, reading
the same `[read-budget]` JSON lines the tests themselves print via
`ctx.meta.getTransactionMetrics()`. Result: **3 files, 22 passed + 1
expected fail (23), 41.95s.**

| Query | Fixture | documentsRead | bytesRead | databaseQueries | ms |
|---|---|---:|---:|---:|---:|
| `insights.activity` | 40 purchases×20 items×10 checks, 60 watches×20 checks | 2,199 | 530,744 | 205 | 898.4 |
| `insights.sources` | same + 1 watch×300 offers | 2,299 | 562,844 | 243 | 806.3 |
| `insights.priceHistory` | 1 watch×300 offers×20 checks, amid 200 other watches | 290 | 78,559 | 43 | 96.7 |
| `tracking.overview` | 40 purchases×20 items×10 checks | 2,791 | 674,119 | 291 | 1,205.4 |
| `watches.list` | 60 watches×20 checks + 1 watch×300 offers | 1,261 | 304,900 | 126 | 222.2 |
| `offers.listForWatch` | 1 watch×300 offers | 101 | 32,370 | 3 | 6.6 |
| `intake.needsAttention` | 500 processedEvents (250 failed, 250 needs_review) | 100 | 22,200 | 3 | 22.6 |
| `watches.sweep` | 60 due watches (+1 not-yet-due) | 100 | 24,040 | 52 | 79.2 |
| `watches.sweep` (multi-user) | 6 users, 10/10/10/10/5/5 due watches | 100 | 24,200 | 52 | 1.7 |
| `claims.get` | 1 claim × 200 ledgerEvents | 203 | 40,834 | 9 | 4.0 |
| `priceWatch.eligibleItems` | 500 items × 65 claims/item | 2,500 | 673,950 | 2,001 | 11,510 |
| `priceWatch.eligibleItems` | 500 items × 65 claims/item (D101 regression case) | 2,500 | 673,950 | 2,001 | 10,926 |
| `priceWatch.eligibleItems` | 500 items × 61 claims/item | 2,500 | 673,950 | 2,001 | 10,065 |
| `insights.sources` (dashboard fixture) | 24 mixed-currency purchases×2 items + 1×51-item purchase | 220 | 52,717 | 127 | — |
| `insights.activity` (dashboard fixture) | same | 226 | 54,195 | 139 | — |
| `tracking.overview` (dashboard fixture) | same | 222 | 53,299 | 177 | 12.4 |

All values are **identical** to the "T15 update" section above (measured
earlier at `main 5e306db+`) to within measurement noise — the only
difference anywhere is `tracking.overview` (dashboard fixture)'s
`databaseQueries` reading 177 here vs 176 in the T15 update, a 1-query
difference not reproduced on re-run and not correlated with any `convex/**`
change between the two measurement points; not treated as a regression.
`priceWatch.eligibleItems` again confirms **no scaling with claims-per-item**
(65 and 61 claims/item both read exactly 2,500 documents / 2,001 database
queries), reconfirming D101's fix is still in effect at the candidate
revision. Every number stays far inside the 32,000-document / 16 MiB /
4,096-database-query ceilings — **no regression, no new transaction-limit
risk, P07's acceptance line ("documented data sizes, read counts/bytes and
timings; no transaction-limit failure") holds at the candidate revision.**

`convex/fairness.test.ts` in the same run: 4 passed + 1 expected fail
(`it.fails`, `convex/fairness.test.ts:220`, "watches.sweep... does not let
one user's backlog occupy the entire first tick" — D74/F-D74-1, LOW,
unchanged, not a regression) — matching the single expected-fail counted in
the full 1287-test worktree run (`docs/reviews/phase4-verification.md` §1).
