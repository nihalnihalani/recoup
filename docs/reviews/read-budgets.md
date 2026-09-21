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

| Fixture | Result | documentsRead | bytesRead | ms |
|---|---|---:|---:|---:|
| 500 items × 65 claims/item (dissent's exact repro) | **throws** `Scanned too many documents in a single function execution (limit: 32000)` | 32,001 | 9,418,374 (8.98 MiB) | ~8,230–8,500 |
| 500 items × 61 claims/item | passes | **32,000** (exactly at the ceiling) | 9,414,070 | ~8,170 |

**Failure threshold, bisected**: per item scanned, `eligibleItems` reads 1 (`ctx.db.get(purchase)`) + 1 (`latestPricePolicy`, one row per user+domain+kind in this fixture) + `claimsPerItem` (the unbounded collect), plus the initial 500-document `items` scan itself: `total = items*(claimsPerItem + 3)`. At `items=500` that is exactly `500*64 = 32,000` at `claimsPerItem=61` (empirically confirmed above: no throw) and `500*65 = 32,500` at `claimsPerItem=62` (algebraic crossover; the dissent's own `claimsPerItem=65` — empirically confirmed above — is comfortably past it). **The tracker throws deterministically at `limit + 1` documents read** on whichever single read tips it over, so `documentsRead` reads exactly 32,001 regardless of which item/claim triggered it — confirmed identically for both the `eligibleItems` (500×65) and `tracking.overview` (40×50×30) overflows above.

The cron consequence: `priceWatch.runAll` (priceWatch.ts:474-489) calls `eligibleItems` unconditionally every tick (2h cadence, `crons.ts`), so once any user's account reaches this shape, **every tick for every user** throws and schedules nothing, with no recovery path short of manually deleting claim rows.

## Fairness (`convex/fairness.test.ts`)

- **`priceWatch.runAll`/`eligibleItems` — permanent starvation, `it.fails` (D74, D80 HIGH).** 3 users; B has 480 newer eligible items, A and C have 1 older eligible item each. `eligibleItems` (priceWatch.ts:178) reads `ctx.db.query("items").order("desc")` — plain `_creationTime` descending, globally across every user, no per-user slice, item-level `nextCheckAt` never read. Observed distribution across 3 ticks of `runAll` with no advancing state that would help (matching the dissent's "tick 1, tick 2, +30 days" repro): **every tick schedules exactly B's newest 50 of 480 items; A and C are scheduled 0 times, in any tick.** `PRICE_CHECK_PER_USER_PER_TICK=10` (`convex/limits.ts:170`) is already defined for D74's fix but unused anywhere.
- **`watches.sweep` — per-tick starvation is real but bounded, `it.fails` for the single-tick case + a passing test for the recovery bound (D74 medium).** Same 3-user/480-watch shape, but keyed on `nextCheckAt` (ascending, earliest-due-first) rather than creation time. Tick 1: B's 480 watches, all more overdue than A/C's, fill the entire `WATCH_SWEEP_PAGE=50` page — **A and C get 0 in tick 1.** Unlike `eligibleItems`, a scheduled row's `nextCheckAt` is bumped forward (watches.ts:753-756), so the backlog actually drains: a second passing test confirms both A and C are scheduled within `ceil(480/50)+1 = 10` ticks. `WATCH_SWEEP_PER_USER=10` (`convex/limits.ts:173`) is likewise defined for D74's fix but unused.
- **Global budget exhaustion fails closed (passing).** With the `usage` global `price_check` row pre-seeded to `GLOBAL_DAILY_BUDGETS.price_check.max` (3,000): `watches.sweep` schedules 0 (`takeGlobalBudget` returns 0 granted, due watches stay due, no `_scheduled_functions` rows created) and the `usage` row is confirmed unchanged (not overspent). `watches.create` (which charges the same global switch via `consumeGlobalBudget`, which throws) is confirmed to refuse the whole mutation — no watch row is written — with the `usage` row again unchanged. The refusal is visible in both cases by re-reading the `usage` row directly.

## Recommended indexes/pagination for T12/T16 (only where these measurements justify it)

1. **`claims.by_item_kind_status` index, replacing `hasOpenPriceClaim`'s full `.collect()`** (priceWatch.ts:122-129) — this is the direct fix for the eligibleItems overflow above (D74 already names this index). Justified by the bisected 61/62-claims-per-item threshold: an indexed existence check turns an O(claims-per-item) read into O(1), which at the dissent's 65-claims fixture alone removes ~32,000 of the ~32,500 attempted reads.
2. **A bound on `tracking.ts:105-108`'s `items` `.collect()`** (and the same pattern in `insights.ts:134-137`/`338-341`, already flagged `partially_present` in the phase0 review) — justified by the empirically confirmed 62,040-read overflow at 40×50×30. A `.take(N)` (mirroring `MAX_ITEMS_PER_PURCHASE`-style caps elsewhere) or a dedicated `items`-count aggregate would keep this bounded the same way `offers.listForWatch`/`intake.needsAttention` already are.
3. **Parallelize the serial per-product fan-out in `insights.activity`/`insights.sources`** (P07 "serialized fan-out", already flagged `partially_present`) with `Promise.all`, the same way `watches.list` and `insights.ts`'s own `liveWatches` already do. Justified directly by the measured wall time: ~75s per query at the original fixture size for what is, per-read, a well-bounded query (26,548 documents is under the limit) — the cost is round-trip latency multiplied serially, not data volume. `insights.priceHistory`'s `for (const w of watches) confirmedOffers(...)` loop (insights.ts:538) has the identical anti-pattern; its read cost is small at these fixture sizes (290 documents) so it is not urgent, but the same fix applies for consistency.
4. **No action indicated** for `offers.listForWatch`, `intake.needsAttention`, `watches.sweep`, or `claims.get`'s ledger-events read (203 documents at 200 seeded events — genuinely unbounded per `claims.ts:360-363`, but claim ledgers do not grow to thousands of events in practice the way item/claim/check counts do) — all measured comfortably inside budget with caps that hold regardless of backing data volume.
