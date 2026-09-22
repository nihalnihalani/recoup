# QA baseline — Mission 2 (M04)

Owner: `opus-qa-engineer` (self-reported model: Opus 5.5 / `claude-opus-5-5`, D135).

Scope: the inherited P03, P04, P05, P06, P07, P10, P11 and P12 on the current revision; the test-harness inventory; the reusable test infrastructure and the gaps Mission 2 will hit; and a Phase 1 test-plan skeleton. P01, P02, P08 and P09 are in `docs/reviews/2026-09-23-security-baseline.md` (M03).

Inputs:
- Mission §15 and §17
- `convex/_generated/ai/guidelines.md`
- DECISIONS D134–D139 (especially D138)
- `docs/reviews/2026-09-21-production-readiness-baseline.md`
- `docs/reviews/phase4-verification.md` and `docs/reviews/read-budgets.md`
- The M01 contract (`docs/team/contracts/2026-09-23-M01-transaction-recovery-architecture.md`, rev 3) and the M02 fixtures (`docs/rules/fixtures/R02–R05.json` @ `6c429c8`)

Evidence labels: **(executed)** means a command ran in this task. **(code read)** means the claim comes from reading the source at the cited line, with no dedicated run.

**Revisions.**
- `f128bf4` is the commit for Part 1 of this task.
- Code and tests are unchanged from `f128bf4` through `6c429c8`, which was HEAD when this was written. Every commit after `f128bf4` touches only `docs/`.
- CI run `35771754039` passed at `1916c03`, a descendant of `f128bf4`. The `checks` job succeeded; the `e2e` job reported success but skipped Playwright (§B.3).

**Environment.**
- macOS, `TZ=Asia/Kolkata`.
- Local tools: Node v25.2.1 and npm 11.6.2. `.nvmrc` pins 22, and CI runs v22.23.2.
- Pinned packages: vitest 4.1.11, convex-test 0.0.59, TypeScript 6.0.3, `@playwright/test` 1.63.0.

---

## 0. Part 1: the calendar time-bomb (D138), fixed in `f128bf4`

**Cause.** `convex/tracking.test.ts`'s two D93/F3 read-budget tests passed `now = Date.UTC(2026, 8, 21, 12)` to `api.tracking.overview`. That query validates `now` with `watches.assertCoarseNow` (`convex/watches.ts:70-75`), which rejects any value more than 24 h from the server clock. The tests passed on 2026-09-21 and failed from 2026-09-22 on. CI caught it: run `35768323879` at `5cc326d` failed at "test (with minimum-count gate)".

**Fix (fixture only; no production code).** The describe block (`convex/tracking.test.ts:260-271`) now pins `Date` to `NOW`:
- `beforeEach`: `vi.useFakeTimers({ toFake: ["Date"] })`, then `vi.setSystemTime(NOW)`.
- `afterEach`: `vi.useRealTimers()`.

This is the pattern `readBudget.test.ts:158-162` and `dashboard.test.ts:103-119` already use. Only `Date` is faked because fully faked timers starve the nested `ctx.runQuery` measured inside `t.run`. The read-budget assertions are unchanged (executed):
- 40×51×30: 3,295 documents read, 250 items, `truncated: true`.
- 60×50×12: 3,310 documents read and 267 database queries, both under their limits.

### Sweep method and results

1. **Static.** I listed every hard-coded date literal in `convex/**/*.test.ts` and `src/**/*.test.ts` (`Date.UTC(`, `Date.parse(`, `new Date("…")`, 13-digit epoch literals): 31 files. For each one I checked whether its clock is pinned, injected, or only stored.
2. **Dynamic, pass/fail.** I wrote a vitest setup shim, which is **not committed** (it lives in the session scratchpad). It moves the process's real clock to a target date while time keeps advancing. It patches `Date.now` on the underlying `Date`, so vitest's `resetDate()` keeps the shift, and swaps `globalThis.Date` for a subclass so a zero-argument `new Date()` is shifted too. Before every test it asserts the shift is active.

   The whole suite ran under it (executed):

   | Clock | Before fix | After fix |
   |---|---|---|
   | 2026-10-24 (+1 month) | 2 failed (the two `tracking.test.ts` tests), 1,351 pass | 1,353 pass + 1 expected fail |
   | 2027-01-15 (+4 months) | 2 failed (the same two), 1,351 pass | 1,353 pass + 1 expected fail |
   | 2031-06-15 (+5 years) | 2 failed (the same two), 1,351 pass | 1,353 pass + 1 expected fail |
   | 2026-12-31T23:59:40Z (crosses UTC midnight and the new year mid-run; files finished from 23:59:40 to 00:00:23) | — | 1,353 pass + 1 expected fail |
   | `TZ=Pacific/Kiritimati` (UTC+14), real clock | — | 1,353 pass + 1 expected fail |
   | `TZ=Pacific/Pago_Pago` (UTC−11), real clock | — | 1,353 pass + 1 expected fail |

3. **Dynamic, "passes for the wrong reason".** A test can keep passing on a later date because a clock check now rejects the call before the check the test is meant to prove. To look for that, the shim wrapped `convexTest()`. It recorded every rejected `t.query`/`t.mutation`/`t.action` (478 of them), every non-2xx `t.fetch` (7), and every returned value, including `t.run` results (12,547 records). I compared a run on today's clock with runs at +1 month and +5 years, after normalizing run-to-run noise: random tokens, JWTs, rate-limiter `retryAfter`, and raw timestamps.
   - Every rejection reason is identical across all three runs.
   - Every returned value is identical, apart from the noise also seen between two same-day runs and two strings that legitimately embed today's date: the `usage.day` key (`policies.test.ts`, "accepts a store … up to 10 a day") and a verdict reason "…lowest price we have seen since <date>" (`purchases.test.ts`, W1b). No test asserts on either.

**Time-bomb list.**

| File:line | Why it would fail later | Fix |
|---|---|---|
| `convex/tracking.test.ts:267` (was `const NOW = Date.UTC(2026, 8, 21, 12)`), test "does not overflow the 32,000-document transaction limit and reports truncated" | fixed `now` → `assertCoarseNow` (±24 h against the real clock) | describe-level Date pin (`f128bf4`) |
| `convex/tracking.test.ts:354` (same constant), test "60 purchases x 50 items x 12 checks does not throw 'Too many index ranges read (4096)' (F3, D103)" | same | same |

Every other hard-coded date is safe, for one of the reasons below. The shifted runs and the trace comparison confirm each one.
- **Pinned with `vi.setSystemTime` at the same constant:**
  - whole-file pins: `readBudget`, `market`, `notify`, `budget`, `fairness`, `freshness`, `marketFlow`, `watches`, `offers`, `ops`, `dashboard`, `account`, `lifecycle`
  - pins inside individual tests: `policies:655/677`, `priceWatch:888/1030`, `drafts:1196/1216`, `insights:594-638`
- **Pure functions with the clock passed in:** `lib/money.test.ts:93`, `lib/verdict.test.ts:6`, `lib/shopsavvy.test.ts:14` (the captured live fixture is always parsed with `NOW`), `lib/priceStatsClient.test.ts:5`, `lib/accountState.test.ts:6`, `notify.test.ts:1230` (`queuedPatch(to, id, now)`).
- **Stored past values only, never compared with the clock in a way that can flip:**
  - `boundary.test.ts:33`, `claims.test.ts:12/264`, `purchases.test.ts:19/56`, `drafts.test.ts:39/50`, `intake.test.ts:74/421/461/469`, `inbound.test.ts:26`, `insights.test.ts:312/333`.
  - The only clock check these values reach is `assertTimestamp`, which rejects future values only (`lib/money.ts:22-26`). A past date only gets further in the past.
- **Explicit-date formatting:** `lib/log.test.ts:177`, `src/lib/time.test.ts:13-18`, `src/lib/accountExport.test.ts:43-48/103/124`. These use UTC, and the `TZ` runs pass.

**Gates after the fix (executed at `f128bf4`):**
- `npm test`: 66 files, 1,353 passed + 1 expected fail (`fairness.test.ts:220`, F-D74-1).
- `npm run test:ci`: "OK - 1354 tests passed across 66 file(s) (minimum 600)".
- `npm run typecheck`: clean.
- `npm run lint`: clean, 0 warnings (`--max-warnings=0` also exits 0).

---

## A. P03–P07, P10–P12 on the current revision

Classes are the mission §15 vocabulary. When an item is in two states, the **primary** class is the one that decides whether it can be closed.

### A.1 Summary

| # | Primary class | Also | What holds | What fails or is missing |
|---|---|---|---|---|
| P03 | **still_present** (narrowed) | already_fixed (original finding) | State machine, transactional claim, retries, resumable migration, orchestration suite (`market.test.ts` 34, `marketFlow.test.ts` 4) | A provider "no such product" response (`success:false` / `data:[]`) is recorded as `not_configured` and paid for again on every accepted check (QA-1). No UI calls `api.market.refresh`, so `terminal_failure`/`empty_result` are permanent for users. |
| P04 | **still_present** (narrowed) | already_fixed (envelope, caps, timestamps, currency mismatch, qualifiers) | Boundary validation and verdict qualification | Store candidates skip the condition filter; a store with no currency is stored as priced; no shipping handling; no maximum age for market points; the newest market points go unread (QA-5, QA-6, QA-8) |
| P05 | **still_present** (narrowed) | already_fixed (server read models) | Archive churn, candidate vs confirmed, bought counted once, `truncated` flags, `byCurrency` | Dashboard charts add cents across currencies (QA-2); a silent 30-watch cap in `trackedTable`/`priceHistory` (QA-7) |
| P06 | **still_present** (narrowed) | already_fixed (coarse `now`, distinct fields, `priceStale` for watches) | Reactive queries take a validated coarse `now`; authoritative mutations and actions use server time | `drafts.approveAndSend` never re-checks `claim.windowEndsAt` (QA-3); owned items have no staleness flag (QA-4); the hooks are untested |
| P07 | **changed_scope_with_evidence** | already_fixed (measured budgets, fail-closed budgets, retention for most classes) | read-budgets.md numbers; `fairness.test.ts`; `retention.ts` 7-step sweep | Mission 2 adds documents/evidence blobs (nothing exists yet). Still unretained: AgentMail inbound/events, `marketPrices`, `usage`, `processedEvents` rows. The single-tick fairness gap is an accepted `it.fails`. |
| P10 | **changed_scope_with_evidence** | externally_blocked (CI) | The inherited 27-scenario Playwright suite (×2 projects), last verified at `529f545` | Not re-run at HEAD (34 `convex/` + 4 `src/` files changed since). Never runs in CI, and its wiring would fail even with the secrets set (QA-9). No Mission 2 flow exists yet. No spec covers offline/reconnect or missing config. |
| P11 | **externally_blocked** | already_fixed (local gates, clean install, CI `checks`) | CI on Node 22 runs `npm ci`, `verify:patch`, typecheck, lint, `test:ci` (count gate), build | `codegen:check` and the Playwright job skip silently while reporting green (secrets not provisioned, plus QA-9). Lint allows 1 warning (QA-10), the count floor is loose (QA-11), docs pushes cancel code runs (QA-12). |
| P12 | **changed_scope_with_evidence** | externally_blocked (production deploy, D83/D136) | RELEASE/RUNBOOK/ENVIRONMENT docs; rc-2026-09-21.2 manifest; backup/restore and smoke on `adorable-lion-138`; `ops.backlog` diagnostics | The manifest describes `357dc37`, not HEAD (`18f3b46` changed `priceWatch.ts`, `watches.ts`, `intake.ts`, `lib/text.ts`). The Mission 2 operational scope (rule-pack versions, rule-evaluation and source-refresh diagnostics, evidence deletion jobs, migration plan) does not exist yet. |

### A.2 P03 — recoverable market history

| §15 sub-requirement | Code | Proving test(s) | Status |
|---|---|---|---|
| States: not configured / queued / running / success / legitimate empty / retryable / terminal | `schema.ts:58-61` (`marketState`); `market.ts:271-339` `requestLookup`, `:361-371` `markRunning`, `:476-493` `recordSnapshot`, `:507-620` `lookup` | `market.test.ts:120` "goes to not_configured with no budget spend…", `:281` "classifies a real but empty response as empty_result, with no hot auto retry", `:152` (429 retry), `:186` (5xx backoff), `:625` (stale-claim reclaim) | **Partly holds.** `market.ts:558-563` records any `null` snapshot as `not_configured`. `lib/shopsavvy.ts:189-196` `parseSnapshot` returns `null` for `success:false` or an empty `data`, even when the key is set (QA-1). |
| A failed or missing-key lookup never permanently blocks | `market.ts:286-291` (no key: no stamp); `:293-302` (15-minute stale reclaim); `:334` (terminal → manual resets attempts); `:485-491` | `market.test.ts:120`, `:518`, `:206`, `:625`; `marketFlow.test.ts:162` "no key: an accepted check still auto-fires…" | **Server side holds. No path from the UI:** `grep -rn "api.market" src` returns 0, so no screen can call `api.market.refresh`, and `terminal_failure`/`empty_result` are final for users. |
| Transactional claim before paid work | `market.ts:320-337` (charge, patch to `queued`, and schedule in one mutation); `:367`, `:395` | `market.test.ts:354` "lets exactly one of two concurrent requestLookup calls claim and charge"; `marketFlow.test.ts:180` (one fetch) | Holds. convex-test runs mutations one at a time, so this proves the state gate, not an OCC retry. |
| Bounded retries, refresh and spend | `limits.ts:231` (`MARKET_MAX_ATTEMPTS`=4), 234, 237, 250; `market.ts:248-261`, `:533-555` | `market.test.ts:152`, `:186`, `:375`, `:408`, `:473`, `:498`, `:813`, `:845`; `marketFlow.test.ts:233`, `:256` | Holds, except the QA-1 case, where each accepted check re-charges until the per-user daily cap is used up. |
| Migrate old stamps only with persisted evidence | `market.ts:648-684` `migrateStamps` (opsState cursor) | `market.test.ts:933` "classifies both legacy shapes and is idempotent", `:968` | **Partly holds.** Two legacy shapes are classified (PLAN T10 listed four). A legitimately empty legacy lookup becomes `not_configured` and is paid for again. |
| Orchestration tests | `market.ts:155-162` `classifyFetchError`; `:392-396` (archive, bought and tombstone skip) | `market.test.ts:557` (archived mid-flight), `:589` and `lifecycle.test.ts:219` (tombstoned), `:607` (bought), `:281`, `:311` / `:327` (size caps) | Holds for 429, 5xx, oversize, archive and tombstone. |

**Not covered by any test:**
- timeout/network → retryable;
- 400/401/403 → terminal;
- a small invalid-JSON body;
- how `lookup` classifies a `success:false` / `data:[]` response (QA-1);
- `migrateStamps` resuming after the first 100-row page;
- a migrated `success` not being charged again;
- any UI refresh path (none exists).

### A.3 P04 — historical-price quality

| §15 sub-requirement | Code | Proving test(s) | Status |
|---|---|---|---|
| Product/variant matching | `lib/offerMatch.ts:96-132, 161-166`; `offers.ts:595, 654, 664-668, 896-906` | `offers.test.ts:150`, `:792`, `:817`, `:883`, `:935`; `lib/offerMatch.test.ts:164`, `:170` | Holds, with a residual. The find path `offers.ts:664` still compares the stored `title` (the retailer name for ShopSavvy rows) with the search title, a leftover of the F4 bug (QA-8). The error goes the safe way: an offer is flagged "needs reconfirm", never authorized. |
| Condition (used, refurbished, open-box) | History: `lib/shopsavvy.ts:102-107, 277, 334` | `lib/shopsavvy.test.ts:376` "excludes a used/refurbished/open-box/bundle offer from history entirely" | **Store candidates: missing.** The `market.ts:590-606` loop never calls `isExcludedCondition`. No test (QA-5). |
| Bundle quantity | Condition regex plus the high-side outlier cut (`lib/shopsavvy.ts:103, 257`) | `lib/shopsavvy.test.ts:376`, `:424` | Heuristic only; no pack size or per-unit price. |
| Currency | `lib/shopsavvy.ts:173-174, 289`; `market.ts:450-468` (a mismatch is stored unpriced); no conversion anywhere | `lib/shopsavvy.test.ts:292`, `:350`, `:363`; `market.test.ts:981`, `:995`, `:1035` | **A store with no stated currency is stored as priced** with `currency` undefined (`market.ts:456` only catches a mismatch). If the user confirms it, `StoreCompare.tsx:208` assumes the watch's currency and ranks it (`:217`). No test (QA-5). |
| Shipping and pricing inclusion | — | — | **Not implemented.** No shipping or tax field anywhere in `convex/`. |
| Timestamps (future, pre-2010; observed vs retrieved) | `lib/shopsavvy.ts:92-100`; `lib/verdict.ts:138-140`; `market.ts:412, 480-481` | `lib/shopsavvy.test.ts:211`, `:230`, `:249`, `:268`; `lib/verdict.test.ts:213`, `:231`; `market.test.ts:657` "stamps source, observedAt (provider) and retrievedAt (now)…" | Holds. `shopsavvy.test.ts:230` asserts only the in-tolerance half of its title. |
| Staleness | Own price: `lib/verdict.ts:185-192`, `watches.ts:227, 249`; offers `offers.ts:724-737, 817-851` | `lib/verdict.test.ts:245-279`; `freshness.test.ts:159`, `:236`; `offers.test.ts:631`, `:1065` | **Market points and ShopSavvy listings have no maximum age.** `watches.ts:191-195` `marketFor` takes the first 120 rows of `by_watch` = `["watchId","observedAt"]` in ascending order. Once more than 120 rows accumulate, the newest are never read (QA-6). |
| Envelope validation, size, minor units, URLs, malformed payloads | `lib/shopsavvy.ts:50, 166, 192, 200, 203-209`; `market.ts:132-150` | `lib/shopsavvy.test.ts:154-203`, `:315`; `market.test.ts:311`, `:327` | Holds. No test for a small invalid-JSON body. `recordSnapshot` accepts `cents: v.number()` with no integer check at that boundary (`market.ts:199, 209`). |
| Safe conversion | `lib/shopsavvy.ts:71-75` `toCents`; integer comparisons in `lib/verdict.ts` | `lib/shopsavvy.test.ts:100`, `:109`, `:117` | Holds. |
| Outlier filtering is not matching | `lib/verdict.ts:141, 296-302` (a market-derived verdict is "qualified"); ShopSavvy rows are always `candidate` (`market.ts:464`) | `lib/verdict.test.ts:190`, `:201`, `:350`; `offers.test.ts:701` "…never drives best unconfirmed…" | Holds. Nothing checks that ShopSavvy's product is the watched product. |
| Optional and source-labelled | `market.ts:411, 465`; `offers.ts:484, 679`; UI chips `StoreCompare.tsx:86`, `MarketHistory.tsx:80` | `market.test.ts:657`; `offers.test.ts:692`, `:701` | Holds, with a residual. After a Recoup recheck, the offer row keeps `source: "shopsavvy"` (`offers.ts:907-911`; the check row is labelled `recoup`) (QA-8). |
| Missing ShopSavvy never breaks watching; no claim or alert from provider data | `market.ts:286-291`; lookup is scheduled, never inline (`watches.ts:816-818`); `claimDrop` only from Recoup's own read (`watches.ts:804`) | `marketFlow.test.ts:162`; `market.test.ts:120` | Holds by construction. **No end-to-end test** asserts that a successful market lookup creates zero `claims`/`mailLog` rows. |

**Not covered by any test:**
- condition exclusion for store candidates;
- a store candidate with no currency;
- shipping (not implemented);
- stale market points or listings (not implemented);
- a small invalid-JSON body;
- market data creating no claim or alert, end to end;
- a product-identity check on ShopSavvy results (not implemented).

### A.4 P05 — dashboard completeness

| §15 sub-requirement | Code | Proving test(s) | Status |
|---|---|---|---|
| Archived rows cannot hide active rows | `insights.ts:124` `userWatches`, `:138` `userPurchases` (indexed per status); `tracking.ts:156-161` | `insights.test.ts:110` "archive churn beyond the cap hides nothing active (watches and purchases)"; `tracking.test.ts:47` "F6 (D103)…" | Holds. |
| Candidate offers cannot hide confirmed ones | `offers.ts:194-206` `confirmedOffers` (`WATCH_ROWS`=100) | `insights.test.ts:183` "a confirmed offer behind 25 unconfirmed candidates still appears" | Holds. |
| A converted watch plus its purchase is counted once | `insights.ts:220`, `:475` (a watch with `purchaseId` is skipped) | `insights.test.ts:151`; `dashboard.test.ts:327` | Holds. |
| A sample is not shown as complete | `insights.ts:48` `WINDOW_NOTE`, `truncated` at `:134/:144/:379`; `tracking.ts:161, 212`; UI `dashboard/parts.tsx:39` `RecentNote`, `PurchasesTable.tsx:63` | `insights.test.ts:139`, `:257`, `:294`; `dashboard.test.ts:222`, `:260`; `tracking.test.ts:208`, `:218`, `:274` | **Server side holds.** `insights.ts:539, 626-641` `liveWatches` stops at `MAX_TRACKED`=30 (the per-user limit is 50) with no `truncated` flag. It feeds `priceHistory` and `trackedTable` (QA-7). **No UI rendering test** (there are no component tests). |
| Currencies are never summed | `tracking.ts:176-184, 253, 321-323` `byCurrency`; `insights.ts:433`; `src/lib/currencyTotals.ts:65` | `tracking.test.ts:76` "F5b (D103): totals never sum money across currencies…"; `insights.test.ts:198`, `:502`, `:564`; `src/lib/currencyTotals.test.ts:33`, `:76` | **Server side holds; the UI breaks it.** `src/components/dashboard/model.ts:85-94` `watchedTotalSeries` (drawn at `StatCards.tsx:88`) and `:100-111` `claimableGapSeries` (drawn at `StatCards.tsx:143`) add cents across currencies under one guessed label. `purchases.board` also adds `confirmed`/`owed`/`asked` across currencies (`purchases.ts:516-524`; not rendered today). No test (QA-2). |

**Not covered by any test:** UI rendering of `truncated`/`windowNote`; mixed-currency charts; the 30-watch cap in `trackedTable`/`priceHistory`.

### A.5 P06 — time and freshness

| §15 sub-requirement | Code | Proving test(s) | Status |
|---|---|---|---|
| No `Date.now()` in reactive summaries | `watches.ts:70-75` `assertCoarseNow` used by `watches.list:343`, `watches.get:366`, `tracking.overview:162`, `insights.trackedTable:819`, `purchases.get:318`, `budget.status:68` | `watches.test.ts:1061` (source grep: no `Date.now()` in list/get or `summarise`), `:1085`, `:1110`; `purchases.test.ts:450`; `budget.test.ts:260`; `offers.test.ts:668`, `:681` | Holds. The clock is read only to reject a bad argument. `offers.listForWatch` reads the clock through `assertTimestamp`'s default (`lib/money.ts:22`, `offers.ts:441`) and does not round `now`. The source grep covers only `watches.ts` and `purchases.get`, not `tracking`/`insights`/`budget`. |
| Last attempt vs last success vs age vs cooldown vs window | `schema.ts:133, 147` (`lastCheckedAt`/`lastObservedAt`); `watches.ts:113-126, 769-782`; `lib/freshness.ts:26` | `watches.test.ts:1119`; `freshness.test.ts:271`, `:325` | Holds for watches. **Owned items have no `priceStale`** (QA-4). |
| An open tab never freezes eligibility | `src/lib/time.ts:33` `useCoarseNow`; `src/lib/ui.ts:113` `useNow`; `Watching.tsx:261` | `src/lib/time.test.ts` (pure helpers only) | **Hooks untested.** No browser test leaves a tab open past a cooldown. `src/components/Countdown.tsx` is imported nowhere (code read). |
| Authoritative actions reject expired work whatever the client clock says | `watches.ts:468-472`; `priceWatch.ts:365, 392, 684-693`; `offers.ts:298-309` | `watches.test.ts:297`; `priceWatch.test.ts:182`, `:416`, `:982`, `:1036`; `offers.test.ts:388` | **Mostly holds.** No mutation or action accepts a client `now`. **`drafts.approveAndSend` (`drafts.ts:409`) never reads `claim.windowEndsAt`,** so a price-adjustment request can be sent after the window closed (QA-3). M01 R01 item 5 plans this check (M12/M13). |
| Failed reads never make old data look fresh | `watches.ts:775-782`, `:227`, `:249`, `:270`; `insights.ts:827-835` | `freshness.test.ts:159`, `:187`, `:236`; `watches.test.ts:1119`, `:1151`; `insights.test.ts:582`, `:609`, `:630` | Holds for watches. **Owned items:** `tracking.overview`'s `dropCents` feeds "money on the table" (`dashboard/model.ts:53`) with no age check (QA-4). |

**Not covered by any test:**
- the `useCoarseNow`/`useNow` hooks;
- open-tab expiry in a browser;
- `approveAndSend` after `windowEndsAt`;
- owned-item staleness;
- a source-level no-clock check for `tracking.overview`, `insights.trackedTable` and `budget.status`.

### A.6 P07 — read budgets, fairness, retention

| §15 sub-requirement | Code | Proving test(s) | Status |
|---|---|---|---|
| Measured and documented | `docs/reviews/read-budgets.md` | `readBudget.test.ts` (13 tests); `dashboard.test.ts:222`, `:260`; `tracking.test.ts:274`, `:360`; `purchases.test.ts:696-822` (`purchases.board` measured with its own `harness()`) | Holds. Not measured: `insights.trackedTable`, `purchases.get`, `retention.sweep`. The 2026-09-21 numbers need a re-run after Mission 2 adds tables. |
| Fairness | `priceWatch.ts:261-267, 617`; `watches.ts:871-877` | `fairness.test.ts:113` (priceWatch starvation, now a plain `it`), `:259` (sweep drains within `ceil(480/50)+1` ticks); `priceWatch.test.ts:468`, `:891`; `watches.test.ts:690` | Holds, with the accepted exception **`fairness.test.ts:220` `it.fails`** (F-D74-1, LOW): one tick's global page can belong to one user. The comments at `fairness.test.ts:212-216` and `read-budgets.md:61-62` saying `WATCH_SWEEP_PER_USER` is unused are stale; it is used at `watches.ts:872`. |
| Budgets fail closed | `lib/budget.ts:99-166`; `budget.ts:34`; `watches.ts:438, 882`; `priceWatch.ts:648` | `fairness.test.ts:313`, `:337`; `budget.test.ts:120-214`; `watches.test.ts:1000`; `dashboard.test.ts:359` | Holds. |
| Bounded, resumable retention per data class; financial history kept | `retention.ts:350` `sweep` (7 steps, page 200, opsState cursor); `crons.ts:45, 76`; `mailPurge.ts:99` | `retention.test.ts:54`, `:96` (bounded and resumable), `:409` (claims and ledger untouched); `ops.test.ts:304` (stall); `mailPurge.test.ts:169` | See the class list below. |

Retention status by data class (code read):

| Data class | Status | Where / note |
|---|---|---|
| Scrape content | By design, nothing to retain | Held in memory only (`priceWatch.ts:556-569`). No test that it stays unstored. |
| `processedEvents.payload` | Retained with limits | `retention.ts:88`; `retention.test.ts:109`. Keyed on `_creationTime`; `needs_review` payloads are kept indefinitely. |
| AgentMail `outboundMessages` | Retained with limits | `mailPurge.ts:99` |
| AgentMail `inboundMessages`/`events` | **No retention** | Deleted only with the account (`account.ts:1045`) |
| `watchChecks`/`priceChecks`/`offerChecks` | Retained with limits | `retention.ts:113-195`; `retention.test.ts:182-287` |
| `marketPrices` | **No retention** | — |
| `mailLog`, opsState stash, never-verified users | Retained with limits | `retention.ts:205`, `:231`; `retention.test.ts:315`, `:341`, `:365`, `:387` |
| `processedEvents` rows | **Payload only**; rows are kept | — |
| `usage` | **No retention** | — |
| Documents/evidence blobs (Mission 2) | **Do not exist yet** | M01's M14 owns retention and the orphan-blob sweep |
| Finished scheduled jobs | Left to the Convex platform | — |

**Not covered by any test:** retention for the classes marked "No retention" above (not implemented); scrape content staying unstored; read budgets for `trackedTable`/`purchases.get`; single-tick fairness (accepted).

### A.7 P10 — browser acceptance and resilience

The suite has 6 spec files and 27 tests × 2 projects = 54 (`npx playwright test --list`, executed). The last recorded run was T23 at `529f545` (`phase4-verification.md` §4): 35 pass / 5 fail / 3 flaky at `--workers=2`. The failures were the shared-seed race F-T23-2; at `--workers=1` all passed, some on retry. **Not re-run in this task:** it needs `adorable-lion-138` redeployed at HEAD, and deploying is a lead action (D137).

| §15 sub-requirement | Spec(s) | Status |
|---|---|---|
| Auth, logout, route refresh | `auth.spec.ts` (sign-up via real UI, identical wrong-password copy, reset neutrality, sign-out, direct route survives hard reload) | Holds (at `529f545`) |
| Watch lifecycle, conversion | `watches.spec.ts` (create shows truthful check-failed state; pause/resume; "I bought it" → purchase with window) | Holds (at `529f545`) |
| Source review | `purchases.spec.ts` "the price-adjustment policy card shows the confirmed, retrieved rule" | R01 policy only |
| Draft edit and approval | `claims.spec.ts` "writing the message: a truthful provider failure, or (if it succeeds) a real recipient-confirm gate" | **Partly covered.** With the placeholder OpenAI key the failure path runs; edit → approve → send is not exercised. |
| Recovery confirmation | `claims.spec.ts` ledger; `resilience.spec.ts` keyboard confirm-credit | Holds (at `529f545`) |
| Unknown/foreign records, provider failure | `resilience.spec.ts` error boundary ×2, foreign id ×2; `watches.spec.ts`; `claims.spec.ts` | Holds (at `529f545`) |
| Two-user isolation | `isolation.spec.ts` ×2 | Holds (at `529f545`) |
| Keyboard, a11y | `resilience.spec.ts` keyboard ×2, axe ×6 pages | Holds (at `529f545`) |
| Traces/screenshots | `playwright.config.ts:33-35` | Configured |
| Mocked E2E separate from live smoke | The suite runs against a real disposable backend with placeholder keys; `scripts/smoke.mjs` is separate | **Separate, but not mocked.** Provider failures are real failures, so success paths that need a provider cannot run. |
| New transaction intake, fact confirmation, opportunity evaluation, approval invalidation | — | **Not implemented** (Mission 2 features) |
| Offline/reconnect, missing frontend config, expired session | — | **No spec.** T03 verified offline and missing config manually via chrome-devtools (VERIFICATION.md). |

### A.8 P11 — reproducible install and CI

| §15 sub-requirement | Evidence | Status |
|---|---|---|
| Pinned runtime | `.nvmrc`=22; `package.json` engines `>=22 <23`; `ci.yml:29, 118` `node-version-file`; CI log shows v22.23.2 | Holds in CI. Locally, v25 only warns (`EBADENGINE`, F-T23-1). |
| Reproducible install, AgentMail patch | `npm ci` + `postinstall` `patch-package --error-on-fail`; `ci.yml:46-47` `verify:patch`; clean worktree at `529f545` (T23) | Holds |
| Typecheck, lint, tests, build | `ci.yml:49-69`; run `35771754039` at `1916c03` green (executed via `gh`) | Holds. Lint is `--max-warnings=1` but the real count is 0, so one new warning passes (QA-10). |
| No pass-with-no-tests | `scripts/check-test-count.mjs` (fails on vitest failure, under 600 total, or any file with 0 tests) | Holds. The 600 floor is 44% of 1,354 (QA-11). |
| Suites actually run | CI run `35652236148`: `codegen:check` printed "SKIPPED - no reachable Convex deployment is configured" and exited 0; `e2e` job "run Playwright suite: skipped", job concluded **success** | **Externally blocked** (4 secrets not provisioned, `RELEASE.md` §4). **QA-9:** even with the secrets, `e2e/fixtures.ts` never reads `E2E_CONVEX_URL`/`E2E_DEPLOY_KEY` (§B.3). |
| No weakening of types, no blanket suppression | 0 `@ts-ignore`/`@ts-expect-error`; 19 targeted lint disables (10 `no-console`, 7 `no-empty-pattern`, 1 `no-control-regex` with a reason, 1 `no-explicit-any`); `convex/tsconfig.json` strict. `tsconfig.app.json` omits `strict`, but TS 6.0.3 turns the strict family on unless it is set to false. `tsc --strict` on the app adds 0 errors (executed). | Holds |

### A.9 P12 — release, operations, recovery

| §15 sub-requirement | Evidence | Status |
|---|---|---|
| Actual target, revisions, config presence, webhook setup | `docs/reviews/release-candidate.md` (rc-2026-09-21.2 = `357dc37`); `docs/ops/ENVIRONMENT.md`; README reconciled (`README.md:16, 62-64`) | **Stale for HEAD.** `18f3b46` changed `convex/{priceWatch,watches,intake}.ts` and `lib/text.ts` after the candidate. |
| Optional vs required providers | `ENVIRONMENT.md` §"required"/"one feature"/"optional" | Holds |
| Rule-pack versions in the manifest | — | **Not implemented** (Mission 2) |
| Redacted diagnostics | `lib/log.ts` + `lib/log.test.ts` (18); `ops.backlog` (`ops.test.ts:162-357`, including retention stall and stuck deletions) | Inherited scope holds. **Rule-evaluation, source-refresh and evidence-deletion diagnostics do not exist yet.** 12 bare `console.error` call sites were recorded at T23; not re-counted here. |
| Operator controls | `ops.pauseKind`/`resumeKind` (`ops.test.ts:40-100`), `ops.resetRetentionCursor` (`ops.test.ts:360-395`); `RUNBOOK.md` §1, §11 | Holds |
| Backup/export, isolated restore | `RUNBOOK.md` §9; `release-candidate.md` §7 (export → import on `adorable-lion-138`) | Holds for the RC schema. Needs a re-run once Mission 2 changes the schema. |
| Deployment order, smoke checks, rollback limits | `RELEASE.md` §1, §3; `scripts/smoke.mjs` | Documented. **Production deploy and smoke are externally blocked** (D83 item 6, D136). |
| Migration plan | `RUNBOOK.md` §3 (inherited migrations); M01 §8 (Mission 2 plan, proposed) | Mission 2 plan is in the M01 contract; no runnable tests yet. |

No vitest test covers `scripts/smoke.mjs` or `scripts/check-*.mjs`, or checks runbook commands against the CLI (F-T23-3 was found by hand).

---

## B. Test-harness inventory

### B.1 Vitest

- **Config** (`vitest.config.mts:5-7`): `environment: "edge-runtime"`; `server.deps.inline: ["convex-test"]`; `include: ["convex/**/*.test.ts", "src/**/*.test.ts"]`.
  - No `setupFiles`, no `testTimeout` (21 tests pass their own timeout of up to 150 s), default pool (`forks`), per-file isolation.
  - **No coverage provider** (no `@vitest/coverage-*`) and **no DOM environment or React testing library** (no `happy-dom`, `jsdom` or `@testing-library/*`).

- **Counts (executed):**

  | Directory | Files | Tests |
  |---|---:|---:|
  | `convex/` | 38 | 957 |
  | `convex/lib/` | 23 | 346 |
  | `src/lib/` | 5 | 51 |
  | **Total** | **66** | **1,354** |

  - The total is 1,353 real passes plus 1 `it.fails`.
  - Wall time is about 47 s. `readBudget.test.ts` alone takes about 45 s and is the long pole.
  - Largest files: `boundary` 85, `watches` 80, `intake` 64, `priceWatch` 57, `notify` 55, `drafts` 51, `account` 50.
- **Typecheck coverage:** `convex/tsconfig.json` includes `./**/*`, so every `convex/**/*.test.ts` is typechecked. The two `src/lib` test files are typechecked by `tsconfig.app.json`.
- **Silently not run:**
  1. **Any `src/**/*.test.tsx`.** The include glob is `*.test.ts`, so a component test (which M01's M15 requires) would never be collected, and `test:ci` cannot see a file that was never collected (QA-13).
  2. `.reference/**` holds 110 test files of other projects. It is gitignored (`.gitignore:25`) and outside `include`, so this is intentional.
  3. `e2e/*.spec.ts` are Playwright-only.
  4. No `.skip`/`.only`/`.todo`/`skipIf` anywhere. The one `it.fails` is `fairness.test.ts:220`.
- **Modules with no direct test file** (tested only indirectly): `crons.ts` (no test asserts the schedule table; each target function is tested), `mail.ts`, `limits.ts`, `lib/{balance,budget,freshness,latestPolicy}.ts`, `src/lib/{delivery,money,offerNotes,priceStats,stores,ui}.ts`. All 56 `src/**/*.tsx` components and pages have no unit tests.

### B.2 The test-count gate

`scripts/check-test-count.mjs` runs `npm run test:ci` → `node scripts/check-test-count.mjs 600`.
- It runs vitest again with `--reporter=json` into a temp file.
- It fails on any vitest failure, a total under 600, or any collected file with 0 tests.
- **Threshold 600 vs actual 1,354**: up to 754 tests could disappear without tripping it (QA-11).
- It cannot see:
  - files the include glob misses (B.1 item 1);
  - an `it.each([])` over an empty fixture list inside a file that has other tests.

### B.3 CI (`.github/workflows/ci.yml`)

**Triggers and concurrency.**
- Runs on `pull_request` and on `push` to `main`.
- `concurrency: ci-<workflow>-<ref>` with `cancel-in-progress: true` (`:14-16`).
- There is no `paths` filter, so a docs-only push cancels an in-flight code run (QA-12). Observed: the M04 run `35771209180` was cancelled. Its code was verified only by the later run `35771754039` at `1916c03`.

**`checks` job:** checkout → setup-node (`.nvmrc`) → `npm ci` → `verify:patch` → `typecheck` → `lint --max-warnings=1` → `test:ci` → `build` → dist size summary → `codegen:check` (skips and exits 0 without `CODEGEN_CHECK_CONVEX_URL`/`_ADMIN_KEY`).

**`e2e` job** (needs `checks`):
- Checks that `e2e/` exists (the comment "T20 pending" at `:112` is stale).
- `npm ci`, then installs Playwright chromium.
- Checks for `E2E_CONVEX_URL`/`E2E_DEPLOY_KEY`, then skips the run and reports **success**.
- **QA-9 — even with those secrets, the job cannot work as wired:**
  - `e2e/fixtures.ts:55-78` resolves the deployment from `CONVEX_DEPLOYMENT` or `.env.local`, never from `E2E_CONVEX_URL`. `E2E_CONVEX_URL` appears only in an error message.
  - `convex run` needs `CONVEX_DEPLOY_KEY`, and nothing maps `E2E_DEPLOY_KEY` to it.
  - `assertSafeDeployment` (`:83-97`) refuses anything but `adorable-lion-138` unless `E2E_ALLOW_UNKNOWN_DEPLOYMENT=true`. `RELEASE.md` §4 says CI must use a dedicated deployment.
  - Without `E2E_BASE_URL`, `webServer` runs `npm run dev` with no `VITE_CONVEX_URL`, which renders the config-missing screen.

**Not in CI at all:**
- `npm run typecheck:e2e` (passes locally, executed);
- `npm run smoke` (needs a deployed site);
- `npx convex dev --once` / deploy dry-run;
- `npm audit`;
- a clock-shift run (§C.2).

**CI history.**
- `18f3b46`: green (2026-09-21T20:37Z).
- `5cc326d`: red at the test step (D138).
- `1916c03`: green in `checks`; `e2e` "green" with Playwright skipped.

### B.4 Playwright (`playwright.config.ts`)

**Configuration.**
- `testDir: ./e2e`; `workers: 1` and `fullyParallel: false`, on purpose (`:12-18`); `retries: 1`; `timeout` 60 s; `expect` 10 s.
- `trace: on-first-retry`, `screenshot: only-on-failure`, `video: retain-on-failure`.
- Projects: `desktop-chromium` (1280×800) and `mobile` (Pixel 5).
- `webServer: npm run dev` unless `E2E_BASE_URL` is set.
- Dependencies: `@axe-core/playwright` 4.13.0.

**Fixtures** (`e2e/fixtures.ts`):
- `signInFresh` drives the real sign-up UI and reads the code through `testing:lastCodeFor`.
- `signInSeeded` / `seedLead(leadEmailFor(project))` use one lead account per project.
- `newE2EEmail`, `resetUser`, and `runConvex` (shells out to `node_modules/.bin/convex run`).

**Needs a live deployment:**
- a Convex deployment with `E2E_SEED_ENABLED=true` (`convex/testing.ts` refuses otherwise, and always refuses the production host);
- CLI admin access for `convex run testing:*`;
- `.env.local` holding `CONVEX_DEPLOYMENT` and `VITE_CONVEX_URL`.

**Known hazard:** F-T23-2. Shared per-project lead accounts race at `--workers` above 1. It is documented in `e2e/README.md` but not fixed; the fix is a lead account per spec file.

### B.5 Other scripts

| Script | What it checks | Run by |
|---|---|---|
| `scripts/check-patch.mjs` | Only the AgentMail env declaration. `purgeInbox`/`by_inbox` are a manual check in `RELEASE.md` §2 (F-T18.4-1). | CI and local |
| `scripts/check-codegen.mjs` | Codegen drift; needs a deployment | Skips in CI |
| `scripts/smoke.mjs` | 7 HTTP checks against a site URL | Manual only |

---

## C. Reusable test infrastructure, and the gaps Mission 2 will hit

### C.1 What to build on

- **`convex/test.setup.ts:40` `setup()`** builds a convex-test instance with every mounted component registered:
  - `agentmail`, with the `sendPool`/`callbackPool` workpools;
  - `firecrawl`;
  - `rateLimiter`, with `batchWorker`.

  It uses exhaustive `import.meta.glob`s over each component's `src/` (D51 explains why the packages' own test globs match nothing). It also stubs the three provider env vars. **Caveat:** its positional `convexTest(schema, modules)` form silently ignores `transactionLimits`.
- **`test.setup.ts:55` `signedIn(t, name)`** inserts a bare `users` row and returns `withIdentity({ subject: "<userId>|session" })`. That is enough for `getAuthUserId`. It does not create a session, email or verification. For those, use the real `api.auth.signIn` flow as `auth.test.ts`/`authFlow.test.ts` do.
- **Limit-enforcing harness:** `convexTest({ schema, modules, transactionLimits: true })` plus component registration, copied into 8 files (`account`, `marketFlow`, `dashboard`, `freshness`, `insights`, `purchases` ×2, `readBudget`, `tracking`). Pair it with `measure()` (`readBudget.test.ts:104`, `dashboard.test.ts:82`), which wraps `ctx.meta.getTransactionMetrics()` inside `t.run` and prints `[read-budget]` JSON lines.
- **Clock patterns:**
  1. Full fake timers plus `vi.setSystemTime(T0)` in `beforeEach` (most files). This is required with `t.finishAllScheduledFunctions(vi.runAllTimers)`.
  2. Date-only fakes (`{ toFake: ["Date"] }`) for transaction-limit measurements, because full fakes starve nested `runQuery`.
  3. Relative-only: `vi.useFakeTimers()` plus `advanceTimersByTime` (`retention.test.ts`, `intake.test.ts`).
  4. Pure functions with the clock passed in (`lib/verdict`, `lib/shopsavvy`, `lib/money`). **This is the model for the deadline engine.**

  **Correction for whoever writes clock-dependent tests.** `retention.test.ts:14-25` says convex-test stamps `_creationTime` from the real clock. In convex-test 0.0.59 it comes from the faked `Date.now()`, clamped to be monotonic (`node_modules/convex-test/dist/index.js:104-106`). So a `setSystemTime` made before the first insert, or moving forward, is honoured; only moving backward after an insert is clamped (QA-15).
- **Scheduler:**
  - `t.finishAllScheduledFunctions(vi.runAllTimers)` / `finishInProgressScheduledFunctions` (7 files);
  - `ctx.db.system.query("_scheduled_functions")` to count pending jobs (`priceWatch.test.ts:1033-1034`).
- **Provider stubs:** `vi.stubGlobal("fetch", …)` plus `vi.unstubAllGlobals()` (9 files); `vi.spyOn` on module singletons (`account.inboxTransport`) plus `vi.restoreAllMocks()`.
- **Two-user isolation:** `boundary.test.ts:47` `secretsFor(tag)` and `:64` `seedWorld(t, userId, tag)` plant tag-marked strings in every field, and each rejection is checked for leaks. 19 files already sign in two or more users.
- **Browser seeding:** `convex/testing.ts` (`seedUser`, `markVerified`, `seedFixtures`, `lastCodeFor`, `resetUser`; internal, gated by `E2E_SEED_ENABLED`) plus the `e2e/fixtures.ts` helpers.
- **Deploy-safe test helpers:** Convex skips any file with more than one dot in its name (`node_modules/convex/dist/cjs/bundler/index.js:370-372`). That is why `test.setup.ts` can use `import.meta.glob` and why M01's `*.fixtures.ts` names are safe.

### C.2 Gaps Mission 2 needs to close (in dependency order)

| # | Gap | Proposed shape | Owner (per M01 §11) |
|---|---|---|---|
| G1 | **Two-user helpers for new tables** | Generalize `seedWorld` into a `test.world.ts` helper (multi-dot) that seeds `transactions`, `evidence`, `facts`, `incidents`, `opportunities`, `evaluations`, `packets`, `submissions` for a tag. Add a **reflective** isolation test: enumerate public functions from `convex/_generated/api` plus the endpoint inventory, and assert every one taking an `Id<"newTable">` has a foreign-id case. It pairs with M01's SEC-DEL-1 reflective export/purge test. | M16 (`isolationM1.test.ts`) |
| G2 | **Clock injection for the deadline engine, and a recurrence guard for D138** | Keep `lib/deadlines/engine.ts` and `lib/rules/*` pure with `now` injected; M01 already requires a grep test for `Date.now`/`new Date()`. For Convex-level tests, a `pinClock(at, "date" \| "all")` helper in `test.setup.ts`. Never pass a fixture's fixed time to a public query without pinning, because `assertCoarseNow` makes that exactly D138. **Recurrence guard (lead decision, not committed here):** commit this task's shim as `scripts/clockshift.setup.ts` with `npm run test:clockshift` (suite at +400 days), run in CI. Also note that M01's holiday table ends in 2030 (`beyond_calendar` after that); add a fixture for that boundary and a dated TODO to extend the table. | QA + lead |
| G3 | **Loading fixtures from `docs/rules/fixtures/*.json`** | A test-only multi-dot loader `convex/test.fixtures.ts` using `import.meta.glob("../docs/rules/fixtures/*.json", { eager: true, import: "default" })`. It should:<ul><li>validate every file with a zod schema (zod is already a dependency);</li><li>expand fact references;</li><li>yield `{ruleId, caseId, variantId, now: Date.parse(clock), facts, expected}`;</li><li>**assert a minimum case count per rule**, so an empty list cannot pass silently;</li><li>never compute expectations.</li></ul>A companion `convex/test.fixtures.test.ts` validates the files themselves. **State of the M02 files:** 48 cases + 22 variants over R02–R05; every §17 category is present, though R04 has no case tagged `negative`.<ul><li>At `c6bb660`, 10 cases gave `facts` as prose, 5 carried expectations only on variants, R05-05 had no top-level `clock`, and outcome `likely_eligible_missing_evidence` did not match M01's `likely_eligible`.</li><li>I sent these to `opus-rules-researcher`. At `6c429c8` (executed check): 0 prose facts, now structured `facts_from` + `facts_override`; every case has `expected` and `clock` either on the case or on every variant (variant wins), written down in each file's `conventions.loader`.</li></ul>**The loader must:**<ul><li>expand `facts_from`/`facts_override`;</li><li>let variant-level `clock`/`source`/`expected` override the case;</li><li>map `likely_eligible_missing_evidence` → `likely_eligible` (`docs/rules/README.md:75-84`);</li><li>check file hashes against `docs/rules/manifest.json`.</li></ul>R01 fixtures are planned as TypeScript (`convex/lib/rules/fixtures/r01_v1.fixtures.ts`, M01). | M16 + M02 |
| G4 | **Component-test environment** | M15 requires component tests for the opportunity card. Today they would silently not run (QA-13). Add `src/**/*.test.tsx` to `include`, a per-file `// @vitest-environment happy-dom`, and dev dependencies `happy-dom` + `@testing-library/react`. This touches `package.json`, the lockfile and `vitest.config.mts`, which need a single owner. | lead / M16 |
| G5 | **One transaction-limit harness** | Add `limitedSetup()` to `test.setup.ts` and migrate the 8 copies, so new tables register once. Required for M12's "`recovery.summary` bounded at 200 opportunities + 200 claims". | QA |
| G6 | **Concurrency realism** | convex-test serializes mutations, so "two concurrent calls" tests prove idempotency gates, not OCC behaviour (already noted for `sendDrop` in VERIFICATION T09 and for `requestLookup` above). §17 concurrency cases (duplicate submission, credit confirmation vs reminder, duplicate webhooks) need a live-deployment check against `adorable-lion-138` for at least C49/C50. | M25 |
| G7 | **E2E for Mission 2 flows** | New `convex/testing.ts` seeders for transactions, evidence (synthetic PDF/JPG, a synthetic test card number for PAN-masking checks), and opportunities. A lead account per spec file (fixes F-T23-2). QA-9's CI wiring. A dedicated E2E deployment. | M16 / M25 + lead |
| G8 | **Gate tightening** | `test:ci` floor to about 1,300 (ratchet); `lint --max-warnings=0` in CI and `INSTALL.md:70-93`; `typecheck:e2e` in CI; a `paths` rule so docs pushes don't cancel code runs. | lead (shared CI owner) |
| G9 | **Coverage visibility** | Optional: `@vitest/coverage-v8` for a report (not a gate) on `lib/rules/**`, `lib/deadlines/**`, `lib/money.ts`, `lib/ledger.ts`. | lead decision |

---

## D. Phase 1 test-plan skeleton (mission §17, aligned to M01 §10–§11)

Every task report states:
- the environment;
- the revision and working-tree state;
- the command;
- counts collected and executed;
- the result;
- the artifact path;
- limitations.

A relevant change after verification invalidates the result until it is re-run.

### D.0 Harness first (before M10–M15 tests land)

| File | Proves |
|---|---|
| `convex/test.setup.ts` (+ `limitedSetup`, `pinClock`, `twoUsers`) | G2/G5 helpers exist and are used; no new hand-rolled harness copies |
| `convex/test.fixtures.ts` + `convex/test.fixtures.test.ts` | Every `docs/rules/fixtures/*.json` parses and validates. Ids are unique. Every case or variant has `clock` and `expected`. Outcomes use M01's enum. The §17 categories are present per rule. There is a minimum count per file. |
| `vitest.config.mts` (`*.test.tsx` + happy-dom) | A deliberately trivial component test is collected; `test:ci` counts it |
| `scripts/clockshift.setup.ts` + `npm run test:clockshift` (if the lead approves) | The whole suite passes with the clock at +400 days |

### D.1 Wave 1 — safety foundation + R01 retrofit

| File | Owner | Proves (layer) |
|---|---|---|
| `convex/lib/money.test.ts` (extend) | M10 | `assertMoney`/`parseDecimalToMinor` properties: no floats; rejects `1e3`, `-1`, `12.345` USD; `assertUserAmount` refuses 10^12 (pure) |
| `convex/lib/ledger.test.ts` (extend) + `convex/ledgerFixtures.test.ts` | M10 lib-level, **M16 independent via public mutations** | §17 core financial fixtures:<ul><li>4,000 → 2,500 → 0;</li><li>a later debit of 1,000 reopens only its own claim;</li><li>provisional credit shown separately;</li><li>alternatives do not inflate (3,000 + 2,500 on one lossKey gives 3,000);</li><li>USD and EUR stay separate;</li><li>2 × 12,000 vs 9,500 gives 5,000;</li><li>wrong variant or currency, or an unsupported policy, opens no claim;</li><li>a voucher adds to the non-cash count, not Recovered.</li></ul> |
| `convex/lib/access.test.ts` (extend) | M10 | Each `owned*` helper: a missing id and a foreign id raise byte-identical `ConvexError`s; `assertSameTransaction` |
| `convex/lib/pan.test.ts` | M10 | `maskPans`: Luhn-valid test card numbers with spaces or hyphens are masked; a 16-digit non-Luhn number is untouched; idempotent (M03 SEC-SD-2 amendment D142: issuer prefix and length check) |
| `convex/facts.test.ts`, `convex/transactions.test.ts` | M11 | Resolution matrix (confirmed vs observed conflict, `user_unknown`, missing ≠ false); `putFact` refusals (foreign reference, off-catalogue key, wrong kind, oversize amount, unmasked card number); supersede; `ensurePurchaseTransaction` idempotent |
| `convex/lib/rules/outcome.test.ts` | M12 | `deriveOutcome`: exhaustive 3^6 × flags precedence table, hand-written |
| `convex/lib/deadlines/engine.test.ts` | M12 | Injected `now` only. Calendar vs business days; inclusive and exclusive ends; DST 2026-03-08 and 2026-11-01; notice sent vs received; unknown and disputed anchors; time zone unknown → earliest cutoff with an assumption; `beyond_calendar` after 2030; ±1 unit around every boundary. Plus a grep test: no `Date.now`/`new Date()` in `lib/rules/**` or `lib/deadlines/**`. |
| `convex/lib/rules/r01_price_adjustment_v1.test.ts` | M12 | R01 §10 items 2–7 from hand-written fixtures across all §17 categories |
| `convex/r01Parity.test.ts` | **M16** | For every `recordCheck` fixture, claims opened are identical to `5cc326d`; the unmodified existing suite stays green |
| `convex/opportunities.test.ts` | M12 | Evaluating twice gives one `evaluations` row and the same `resultHash`; concurrent `openCase` gives one claim (serialized proof, G6); a material change bumps the version and invalidates the draft; `approveAndSend` is refused at `windowEndsAt + 1` and allowed at `−1` (closes QA-3) |
| `convex/recovery.test.ts` | M12 | `summary`: rows per currency, overlap groups, provisional and non-cash kept separate; bounded under `limitedSetup` at 200 opportunities + 200 claims |
| `convex/evidence.test.ts` + `convex/http.test.ts` (extend) | M13 | SEC-UP-1/2/3/5/6, SEC-SD-2 and S-M03-1 named tests (size 413, type-sniff 415, owner-scoped dedupe, foreign download 404 identical to missing, no `/api/storage` URL in any result, PAN masked everywhere); prompt-injection text creates no confirmed fact and no claim |
| `convex/account.test.ts` (extend) | M14 | SEC-DEL-1 reflective export and purge; evidence blobs purged blob-first and resumably; the orphan sweep never removes a referenced blob; retention moves unlinked evidence to `content_deleted` after 30 days |
| `convex/isolationM1.test.ts` | **M16** | Every new public function × foreign id → the same not-found, with no leaked tag strings (G1, reflective) |
| `src/components/opportunity/*.test.tsx` | M15 (after G4) | Card states for each outcome: unknown deadline; cap shown as a limit; no estimate means no amount; provisional and non-cash badges |
| `e2e/r01-opportunity.spec.ts` | **M16** | Watch → buy → price drop → opportunity card → claim → draft → approve (an `.example` recipient is refused) → confirm credit → dashboard Recovered equals confirmed; desktop and mobile; axe |

### D.2 Wave 2 — R05 → R02 → R04 → R03

| File | Owner | Proves |
|---|---|---|
| `convex/lib/rules/r05_late_order_v1.test.ts` | M21 | `docs/rules/fixtures/R05.json` through the G3 loader: ship vs delivery keys swapped changes the outcome (R05-02); deemed consent vs no consent (R05-03/-04); unknown order date gives `needs_facts` |
| `convex/lib/rules/r02_air_refund_v1.test.ts` | M22 | `R02.json`: accepted alternative gives `not_eligible` (R02-03); acceptance unknown gives exactly the missing fact `air.alternative.accepted` (R02-04); a one-hour delay creates no cash opportunity (R02-05); separate refund-timing specs per payment class |
| `convex/lib/rules/r04_baggage_v1.test.ts` | M22 | `R04.json`: expenses capped at the documented total (R04-04); bag-fee path complementary (R04-05); one expense line never in two cases; a liability cap shown as a limit, never used as the estimate |
| `convex/lib/rules/r03_billing_error_v1.test.ts` | M21 | `R03.json`: unknown first-statement date gives `unknown_anchor` and never the transaction date (R03-03); debit gives `unsupported`, not `not_eligible` (R03-04); `mustBe: received`; letter-template snapshot has no text beyond template + facts |
| `convex/packets.test.ts`, `convex/submissions.test.ts` | M20 | Approval binds recipient, subject, body, attachment set and versions, amount, facts and draft version; any material change invalidates it; prepared ≠ submitted; manual submission needs user evidence; delivery states are truthful (unknown/stalled visible, no blind resend) |
| `convex/failureInjection.test.ts` | M25 | §17 failure points: before durable job creation; after creation but before the provider call; after provider acceptance but before persistence; during reconciliation, account deletion, rule-version change and approval invalidation. Duplicate webhooks. Manual vs cron check. Credit confirmation vs reminder. |
| `convex/intake.test.ts` (extend) | M23 | A statement with several transaction types gives separate candidates; an encrypted or malformed PDF is unsupported; budgets are charged before the model call |
| `convex/iphoneCase.test.ts` | M25 | §12 case: every path is evaluated or listed as not checked with a reason; no digital-content path; no card number, CVV or serial asked; Potential = R01 estimate or 0 |
| `convex/slicesM2.test.ts` | **M25** | Each Phase 1 slice through public functions end to end (intake → facts → evaluation → packet → approval → submission → promise → confirmed credit) |
| `e2e/{r05,r02,r04,r03}.spec.ts` | **M25** | §17 browser proof per path: start from the UI, intake, confirm facts, inspect reasoning, add evidence, edit packet, **approval invalidation**, submission or manual path, record a promise, confirm posted funds, dashboard/detail consistency; keyboard only; axe; direct-route refresh and foreign ids |

Not in Phase 1 (these §17 domain fixtures belong to later scenarios; tests should assert they are **not evaluated**):
- generic card-network label (R06–R08);
- recall candidate without serial or VIN (R11);
- closed settlement (R23);
- subscription with unresolved jurisdiction (R16);
- warranty outside coverage (R10).

---

## E. Findings from this baseline

| ID | Severity | Finding | Evidence | Suggested owner |
|---|---|---|---|---|
| QA-1 | MEDIUM | With the key set, a provider "no product" response (`success:false` or `data:[]`) makes `parseSnapshot` return `null` (`lib/shopsavvy.ts:189-196`). `lookup` records that as `not_configured` (`market.ts:558-563`; its comment assumes an unset key), and the gate lets `not_configured` through (`market.ts:303-312`). Every accepted price check (2-hour cadence) re-charges a paid lookup until the per-user daily cap runs out, and the UI says "not configured on this deployment". This breaks §15 P03's "legitimate empty is not a hot retry loop". | code read; no test covers `lookup`'s classification of this case | integrations (`market.ts`) |
| QA-2 | MEDIUM | Dashboard charts add money across currencies: `watchedTotalSeries` and `claimableGapSeries` (`src/components/dashboard/model.ts:85-94`, `:100-111`, drawn at `StatCards.tsx:88`, `:143`). `purchases.board` totals also add across currencies (`purchases.ts:516-524`; not rendered). Violates mission §6 "never sum different currencies". | code read | frontend (M15 owns `StatCards.tsx`), backend |
| QA-3 | MEDIUM | `drafts.approveAndSend` never re-checks `claim.windowEndsAt`, so a price-adjustment request can go out after its window closed. | `grep windowEndsAt convex/drafts.ts` → 0 | M12/M13 (already in M01 R01 item 5) |
| QA-4 | LOW–MEDIUM | Owned items have no staleness flag. An old drop keeps counting in "money on the table" (`tracking.overview` `dropCents` → `dashboard/model.ts:53`). | code read | backend |
| QA-5 | LOW | ShopSavvy store candidates skip the used/refurbished filter (`market.ts:590-606`). A store with no currency is stored as priced; once confirmed, `StoreCompare.tsx:208` shows it in the watch's currency and `:217` ranks it. | code read | integrations |
| QA-6 | LOW | `marketFor` reads the oldest 120 `marketPrices` (`watches.ts:191-195`, index `by_watch` = `[watchId, observedAt]` ascending). After repeated lookups the newest points are never read. `marketPrices` has no retention. | code read + schema | integrations |
| QA-7 | LOW | `insights.liveWatches` stops at 30 watches (`insights.ts:539, 626-641`; per-user limit 50) with no `truncated` flag, for `priceHistory`/`trackedTable`. | code read | backend |
| QA-8 | LOW | The F4 leftover in the offer find path (`offers.ts:664`) compares the retailer title, which wrongly marks a confirmed ShopSavvy offer "needs reconfirm" (safe direction). The offer `source` stays `shopsavvy` after a Recoup recheck (`offers.ts:907-911`). | code read | integrations |
| QA-9 | MEDIUM | The CI `e2e` job cannot run as wired, even once secrets exist. `e2e/fixtures.ts` never reads `E2E_CONVEX_URL`/`E2E_DEPLOY_KEY`, refuses non-`adorable-lion-138` deployments without `E2E_ALLOW_UNKNOWN_DEPLOYMENT`, and has no `VITE_CONVEX_URL` for `npm run dev`. Meanwhile the job reports success while skipping. The comment at `ci.yml:112` is stale. | executed (`gh run view`) + code read | lead (shared CI) + QA |
| QA-10 | LOW | CI lint runs with `--max-warnings=1`, but the real count is 0 (`--max-warnings=0` exits 0), so one new warning passes. `INSTALL.md:70-93` still describes the fixed `passage.ts` warning. | executed | lead |
| QA-11 | LOW | The `test:ci` floor is 600 against 1,354 tests. | executed | lead/QA |
| QA-12 | LOW | CI `cancel-in-progress` with no `paths` filter: docs pushes cancel code runs (M04's own run was cancelled). | executed (`gh run list`) | lead |
| QA-13 | MEDIUM (for M15) | There is no DOM test environment, and `src/**/*.test.tsx` is not in `include`, so the component tests required by M01 M15 would silently never run. | config read | lead/M16 (G4) |
| QA-14 | LOW | The transaction-limit harness is copied in 8 files; `setup()` silently ignores limits. | grep | QA (G5) |
| QA-15 | LOW (docs) | The header at `retention.test.ts:14-25` wrongly says `_creationTime` ignores the fake clock (convex-test 0.0.59 uses a monotonic `Date.now()`). This matters for clock-injection guidance. | `convex-test/dist/index.js:104-106` | QA |
| QA-16 | INFO | Stale comments: `market.ts:536-542` (says max attempts is 3; it is 4), `market.ts:558-561`, `fairness.test.ts:212-216` and `read-budgets.md:61-62` (`WATCH_SWEEP_PER_USER` "unused"; it is used at `watches.ts:872`), `lib/freshness.ts:8-15`. | code read | owners of those files |
| QA-17 | INFO | The browser suite has not run since `529f545`; HEAD differs in 34 `convex/` and 4 `src/` files. Re-run at wave-1 close after the lead redeploys `adorable-lion-138`. | `git diff --stat 529f545 HEAD` | lead + QA |

## F. Limitations

- **P03–P07 mapping.** Two read-only sub-agents mapped P03–P07 sub-requirements to code and tests. I spot-checked every claim labelled still broken above against the source. The remaining line references come from their code reading and were not executed individually. The full suite was executed.
- **Playwright** was listed and typechecked but not run. Running it needs a redeploy (D137).
- **The clock-shift shim is not committed** (per the task). The recurrence guard is a recommendation (G2). The shim fakes the JavaScript clock in vitest workers only. It does not move the OS clock, so anything reading time outside JavaScript `Date` (none found) would not be covered.
- **No live provider, production or deployment action** was taken.
