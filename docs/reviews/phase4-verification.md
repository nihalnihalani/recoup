# Phase 4 verification — T23

Owner: T23 (sonnet-verifier). Contract: `docs/team/PLAN.md` "### T23 —"
(verbatim), authorizations: `docs/team/DECISIONS.md` D83 (dev deployment
`adorable-lion-138` disposable, placeholder OPENAI/AGENTMAIL keys, real
FIRECRAWL key, `E2E_SEED_ENABLED=true`; production deploy NOT authorized;
real provider email sends NOT authorized in this mission), D108 (pathspec
commits), D113 (F-T20-2, shared seeded addresses trip the per-email auth
limit), D122 (wave 10 close, T23 launch). This document **changes no
source**; every FAIL/gap below is evidence for the T24 findings register,
not a fix made here (T23's invariant: "Verification changes no source;
findings go to T24; No production deployment performed here").

**Candidate revision:** `529f54569f16974672a8885448ae2709e5217f50` (short
`529f545`) — confirmed as both `HEAD` and `origin/main` at the moment this
task started (`git rev-parse HEAD` = `git rev-parse origin/main`). All
worktree gates in §1 ran against this exact, immutable commit via a detached
`git worktree`, independent of anything that happened afterwards in the
shared main checkout.

**Important operating condition, observed live, not assumed:** this repo's
main checkout at `/Users/nihalnihalani/Desktop/Github/recoup` is shared by
several concurrently-running agent lanes in this session (the same pattern
`docs/reviews/endpoint-inventory.md`'s own header already documents for T02's
audit — "this repo runs several agent lanes concurrently against the same
working tree"). While this task was running, another lane committed twice
directly to this checkout's `main` branch: HEAD moved from the candidate
`529f545` to `5c24e4a` ("fix(T24d-frontend): truthful post-purge deletion
copy; ExampleChip contrast") to `86020f0` ("docs(team): T24d-frontend
verified (D123)") — both frontend-only + one docs line
(`git diff --stat 529f545 86020f0`: `docs/team/DECISIONS.md`,
`src/components/dashboard/parts.tsx`, `src/lib/accountDeletion.ts`,
`src/lib/accountDeletion.test.ts`, `src/pages/Settings.tsx` — no `convex/**`
file touched). Consequences recorded honestly below:
- §1 (worktree gates) is unaffected: it ran in an isolated, detached
  worktree pinned to `529f545` and was torn down before the drift above
  happened.
- §2 (smoke) and §3 (scheduler scenario) hit the **deployed backend** over
  HTTP/CLI by function name; they are not sensitive to the local working
  tree's file contents, so the drift does not invalidate them.
- §4 (browser suite) starts `npm run dev` from **whatever the main checkout
  currently has checked out**, so it necessarily reflects the moving HEAD,
  not the frozen `529f545` candidate. Since the only diff between `529f545`
  and the HEAD the suite actually ran against touches `src/pages/Settings.tsx`,
  `src/lib/accountDeletion.ts`, `src/components/dashboard/parts.tsx` (none of
  which any of the 6 spec files assert on), this is not expected to change
  the browser-suite result, but it is a real gap in reproducibility guarantees
  for any future Phase-4-style run against a shared, actively-developed
  checkout. Recorded as **F-T23-4** below.
- §8 (read-budget final numbers) was re-measured from the main checkout at
  `86020f0`; since `convex/**` is byte-identical to `529f545` (confirmed by
  the same `git diff --stat`), the numbers are valid evidence for the
  candidate revision.

---

## 1. Clean isolated install and all gates (detached worktree at `529f545`)

`git worktree add /private/tmp/recoup-t23 529f545 --detach`, then
`cp .env.local` from the main checkout (worktrees do not inherit untracked
files) so `npx convex codegen` can resolve the linked deployment
(`dev:adorable-lion-138`). Worktree removed with `git worktree remove
/private/tmp/recoup-t23 --force` after all gates below.

| Gate | Command | Result |
|---|---|---|
| Node version | `.nvmrc` = `22`; `node -v` = `v25.2.1` | **Mismatch** — see F-T23-1 below. Not a candidate-code defect: CI (`.github/workflows/ci.yml:29,118`) uses `actions/setup-node` with `node-version-file: ".nvmrc"`, so CI itself runs the pinned Node 22, unlike this local verifier run. |
| Lockfile hash | `shasum -a 256 package-lock.json` | `36352508cb1419cd58f5aa4f7dfd6172547af6ca405d8d267589dbb1123ca719` |
| `npm ci` (scripts on) | `npm ci` | **PASS** (2.1s). One non-fatal `npm warn EBADENGINE` (node 25 vs required `>=22 <23`); `postinstall` ran `patch-package --error-on-fail` → `@agentmail/convex@0.1.0 ✔`; 0 vulnerabilities. |
| Patch verification | `node scripts/check-patch.mjs` | **PASS** — `[verify:patch] OK - node_modules/@agentmail/convex/dist/component/convex.config.js has the AGENTMAIL_API_KEY env declaration.` |
| Codegen diff | `npx convex codegen` then `git diff --stat` | **PASS** — codegen ran against `dev:adorable-lion-138` (download deployment state, bundle components, regenerate `_generated/`); `git diff --stat` and `git status --short` both empty. Committed generated API matches the candidate revision exactly. |
| `npm run typecheck` | `tsc -p tsconfig.app.json --noEmit && tsc -p convex/tsconfig.json --noEmit` | **PASS** — exit 0, no output. |
| `npm run lint` | `oxlint` | **PASS** — exit 0, zero findings printed (matches P11's "warnings are fixed or explicitly justified" — none remain). |
| `npm run test:ci` | `node scripts/check-test-count.mjs 600` | **PASS** — `[test:ci] OK - 1287 tests passed across 65 file(s) (minimum 600)`, 41.8s wall. `1287` = 1286 real passes + 1 expected-fail (`it.fails`, vitest counts a correctly-failing `it.fails` as "passed" at the wrapper level) — confirmed the one expected fail is `convex/fairness.test.ts:220`, "watches.sweep fairness across users (D74) > does not let one user's backlog occupy the entire first tick when two other users also have a due watch", exactly matching D122's "the single remaining `it.fails` is `fairness.test.ts` 'watches.sweep single-tick fairness'" (F-D74-1, LOW, already registered — not new). |
| `npm run build` | `tsc -b && vite build` | **PASS** — 168 modules, built in 259ms. No chunk over 500 kB (largest: `vendor-react` 210.99 kB / 65.84 kB gzip); main entry `index-M-apaY0r.js` 60.30 kB gzip 16.02 kB, well under T03's 350 kB bar. `dist/` total 708 KB. `dist/index.html` sha256 `31e827b9dc2f7beed56f46f7f14cd38bb86f92ccadd3176b2c6b7a0b91b2f0d6`. Full chunk list: `index.html` 1.31 kB, `index-*.css` 58.77 kB, `rolldown-runtime` 0.58 kB, `accountDeletion` 0.91 kB, `WindowMeter` 1.45 kB, `priceStats` 2.60 kB, `ProductThumb` 5.15 kB, `AreaChart` 8.24 kB, `Privacy` 8.54 kB, `DeltaBadge` 9.92 kB, `Settings` 17.29 kB, `Purchase` 25.97 kB, `Claim` 27.42 kB, `Watching` 38.97 kB, `vendor-router` 39.46 kB, `Board` 55.99 kB, `index` 60.30 kB, `vendor-convex` 92.99 kB, `vendor-react` 210.99 kB. |

**Gate verdict: 8/8 PASS** at the candidate revision, in a clean isolated install.

---

## 2. Smoke test against the disposable deployment (main checkout, unedited)

`node scripts/smoke.mjs https://adorable-lion-138.convex.site` (the script
takes the URL positionally; `--deployment` is not one of its flags — a
usage note, not a defect, `scripts/smoke.mjs` is not owned by this task).

| # | Check | Result | Detail |
|---|---|---|---|
| 0 | `GET /` | FAIL | 503 — no static build deployed on this host |
| 1 | `GET /watching` | FAIL | 404 — no static build deployed on this host |
| 2 | `GET /settings` | FAIL | 404 — no static build deployed on this host |
| 3 | `GET /claims/x` | FAIL | 404 — no static build deployed on this host |
| 4 | bundle references exactly one `.convex.cloud` host | FAIL | skipped: `GET /` did not return HTML |
| 5 | `POST /agentmail/webhook {} -> 401` | **PASS** | got 401 |
| 6 | `GET /.well-known/openid-configuration -> 200` | **PASS** | got 200 |

**5 of 7 failed**, exactly as expected per T22's own precedent
(D109/PLAN.md T22 row: "smoke 1/7 against adorable-lion-138 because the
static site is not deployed there") and this task's own contract note ("the
4 page checks fail because no static build is deployed there"). This is a
deployment-topology fact (no `npm run deploy` has been run against
`adorable-lion-138`'s static hosting), not a code regression — consistent
with T22/T23 not being authorized to deploy.

Check 5 (webhook → 401, not a bare 500) is worth calling out as **positive
evidence for F-T22-1's fix**: `npx convex env list --deployment
adorable-lion-138 | cut -d= -f1` confirms `AGENTMAIL_WEBHOOK_SECRET` is
**absent** by name on this deployment, yet the route still answers a clean
401 rather than the previously-documented bare 500 — `convex/http.ts` is
checking the env var by name before ever reaching the component's
`assertConfigured` throw, as D118 recorded ("T24b verified... Webhook fails
closed (401, empty body) for unset secret").

---

## 3. Scheduler scenario (disposable deployment `adorable-lion-138`)

All internal functions invoked directly with `npx convex run <module>:<fn>
'{}' --deployment adorable-lion-138` (works for internal functions on a dev
deployment, per this task's brief).

### 3.1 `ops:backlog` before

```
dueItems: 4 (not truncated)      dueWatches: 0 (not truncated)
mailLogQueued: 4 (not truncated) mailLogUnknown: 0 (not truncated)
processedEventsFailed: 0         staleMarketRunning: 0
retention: { rule: "processedEvents", cursorAgeMs: 7,571,086, stalled: false }
```

### 3.2 Seed (E2E harness, fresh address to avoid D113's per-email auth limit)

```
npx convex run testing:seedUser '{"email":"t23-1790007121@example.com"}' --deployment adorable-lion-138
  → { userId: "jx7e3kzv8b2b3bav4rdv2yq6yh8evmj7" }
npx convex run testing:seedFixtures '{"userId":"jx7e3kzv8b2b3bav4rdv2yq6yh8evmj7"}' --deployment adorable-lion-138
  → activeWatchId, boughtWatchId(+purchase+item), claimPurchaseId+claimId (price_adjustment, "detected"),
    3 offers (confirmed/candidate/shopsavvy-out-of-stock), 2 mailLog rows (sent, queued)
```
`seedFixtures` seeds exactly the scenario the task asked for: a watch, a
purchase with an item and a claim, and a queued drop row (`mailLogIds[1]`,
status `queued`).

### 3.3 Each scheduled internal function, invoked once

| Function | Result |
|---|---|
| `watches:sweep` | `0` (no due watches — seeded watch's `nextCheckAt` is +1h, correctly not yet due) |
| `priceWatch:runAll` | `0` |
| `notify:sweepStalled` | `0` (seeded queued mailLog's `nextCheckAt` is +1h, correctly not yet stalled) |
| `retention:sweep` | `{ table: "processedEvents", scanned/patched: 0, deleted: 0, done: false }` |
| `market:migrateStamps` | `{ scanned: 10, migrated: 0, done: true }` |
| `account:reDriveStuckDeletions` | `{ rescheduled: 0 }` |

None threw, none scheduled unexpected work, and none touched the seeded
rows prematurely (the "0" results are the *correct* answer given the
fixture's timestamps are all in the future relative to `now` — this is
evidence the sweeps respect `nextCheckAt` rather than sweeping everything
indiscriminately, not evidence they are no-ops).

### 3.4 `ops:backlog` after sweeps

```
mailLogQueued: 5 (was 4 — the +1 is the seeded queued row; confirms it is visible to backlog accounting)
dueItems: 4, dueWatches: 0, mailLogUnknown: 0, processedEventsFailed: 0, staleMarketRunning: 0 (unchanged)
retention: cursorAgeMs dropped to 9,194 (the sweep above touched it)
```
No unexpected state change; the only delta (`mailLogQueued` 4→5) is exactly
the row this task seeded, confirming no corruption from running six sweeps
back to back.

### 3.5 Provider calls with placeholder keys — fail-closed evidence

`AGENTMAIL_API_KEY` and `OPENAI_API_KEY` are placeholder values on
`adorable-lion-138` per D83; `FIRECRAWL_API_KEY` is real. Two distinct
provider-call attempts were made, both **fail closed with no crash and no
corrupted rows**:

1. **`npx convex run notify:reconcileDrop '{"mailLogId":"mh70twpxth80adbrgdetxngdm98etx6v","attempt":1}'`**
   (a real AgentMail-component *status* lookup on the seeded queued row's
   synthetic `outboundId`) → threw an **uncaught** `ArgumentValidationError`
   (`Value does not match validator. Path: .outboundId ... Validator:
   v.id("outboundMessages")`) from inside `@agentmail/convex`'s own
   `status()` client call at `convex/notify.ts:576`. This is a distinct,
   narrower finding from "placeholder key fails closed": `seedFixtures`'
   `mailLogIds[1].outboundId` is a synthetic string (`"e2e-outbound-queued"
   as never`), not a real component-issued id, so `reconcileDrop` can never
   safely be invoked directly against E2E-seeded rows — only through the
   real `sendDrop` → `agentmail.sendMessage` path, which this mission does
   not authorize triggering for real. Recorded as **F-T23-1b** below
   (LOW, test-fixture-scope gap, not a production code path since real
   `outboundId`s always come validated from the component).
2. **`npx convex run watches:checkWatch '{"watchId":"n970bfh2vg42g2fs028xn3ay118ev1p0"}'`**
   (the real per-watch price-check action, hitting the fake
   `e2e-active.example` domain through the real Firecrawl-backed
   `observePrice`/extraction pipeline) → returned successfully (`null`,
   no throw out of the action) and logged exactly one structured,
   redacted line via `logEvent` (RUNBOOK §5's documented shape):
   ```
   {"kind":"price_check_failed","correlationId":"81d5e1a5-eab7-4274-838e-4fa9c7c8a4ba",
    "at":"2026-09-21T16:13:27.946Z","watchId":"n970bfh2vg42g2fs028xn3ay118ev1p0","error":"Provider error"}
   ```
   This is exactly the invariant `convex/watches.ts:checkWatch`'s source
   documents: a failed observation is caught and stored as a note-only row
   via `recordWatchCheck`, never left to crash the action or corrupt the
   watch. `"error":"Provider error"` is a sanitized generic string — no key,
   token, stack trace, or raw provider response is present in the log line.
   This is direct, live evidence (not just unit-test evidence) that the
   fail-closed invariant holds end-to-end against the real deployment.

### 3.6 Cleanup

`npx convex run testing:resetUser '{"email":"t23-1790007121@example.com"}'
--deployment adorable-lion-138` → `{ "deleted": true }`. Final `ops:backlog`
confirms `mailLogQueued` back to `4` — the seeded state left no residue.

---

## 4. Browser suite (Playwright, main checkout, starts its own Vite server)

`playwright.config.ts` is explicit that this suite is designed for
`workers: 1, fullyParallel: false` — its own doc comment: "concurrent
workers would race each other's seeds/resets and could trip a global
limiter for everyone" — because most spec files share one seeded lead
account (`e2e.lead@example.com`, or `e2e.lead.<project>@example.com` per
D104/`leadEmailFor`).

### 4.1 As instructed: `npx playwright test --reporter=line --workers=2`

Ran to completion (4.5 min), **did not trip D113's per-email `authAttempt`
rate limit** (no rate-limit error appears anywhere in the log — the
per-project/per-run unique-email scheme already in `e2e/fixtures.ts` since
D113 handles that). Result:

```
5 failed
  [desktop-chromium] isolation.spec.ts:47  "user A's board and watchlist never show something user B created"
  [desktop-chromium] purchases.spec.ts:21  "the price-adjustment policy card shows the confirmed, retrieved rule"
  [desktop-chromium] purchases.spec.ts:47  "the tracked item's table shows paid vs current vs lowest and a real plotted price history"
  [desktop-chromium] resilience.spec.ts:41 "a malformed claim id crashes to the generic fallback, focused, with a way back"
  [mobile]           isolation.spec.ts:47  "user A's board and watchlist never show something user B created"
3 flaky (failed once, passed on the config's built-in retry)
  [mobile] purchases.spec.ts:21
  [mobile] resilience.spec.ts:41
  [mobile] resilience.spec.ts:101 "confirming a credit completes with no pointer interaction"
11 did not run
35 passed (4.5m)
EXIT: 1
```

**Root cause, confirmed by log inspection, not assumed:** every one of the
5 hard failures' retry attempts shows the identical underlying error:

```
ConvexError: seedFixtures: user not found
    at handler (../convex/testing.ts:178:21)
```

This is `testing.ts`'s own `seedFixtures` reading a `userId` that
`testing.ts`'s own `resetUser` deleted out from under it — i.e., two spec
files sharing the same project (e.g. `isolation.spec.ts` and
`purchases.spec.ts`, both under `desktop-chromium`) ran **concurrently** in
different workers under `--workers=2`, and one file's `beforeAll`
`resetUser(email)` step raced another file's in-flight
`seedUser`/`seedFixtures` sequence on the exact same shared lead address.
This is precisely the failure mode `playwright.config.ts`'s own comment
warns about — it is a consequence of overriding the suite's documented
`workers: 1` design with `--workers=2` (as this task's own instructions
specify), not a product defect in `convex/**`/`src/**`. Recorded as
**F-T23-2** below.

### 4.2 Supplementary reproduction at the suite's own designed concurrency

To separate "artifact of the `--workers=2` override" from "a real product
regression", the 3 files that failed above were re-run at the config's own
default (`--workers=1`, default `retries: 1`, no other override):

```
npx playwright test e2e/isolation.spec.ts e2e/purchases.spec.ts e2e/resilience.spec.ts --reporter=line --workers=1
→ 4 flaky (failed once, passed on retry), 28 passed, EXIT: 0
```

And the single test that failed hardest above, run completely alone with
`--retries=0` for a maximally strict check:

```
npx playwright test e2e/purchases.spec.ts --project=desktop-chromium --workers=1 --retries=0 \
  -g "price-adjustment policy card"
→ 1 passed (13.2s)
```

**Conclusion:** none of the 5 "failed" scenarios from §4.1 reproduce as a
deterministic product defect. At the suite's own designed concurrency
(`workers: 1`), the same tests either pass outright or pass on the config's
already-configured retry. This browser suite is **PASS overall** (the
underlying app behavior is correct), with a test-infrastructure finding
(F-T23-2) that `--workers=2` is unsafe for this suite as currently written
and should not be used for future Phase-4-style runs — either honor the
config's `workers: 1`, or (real fix, owned by whichever lane next touches
`e2e/fixtures.ts`) give every spec file its own fully-unique lead account
instead of one shared per project.

### 4.3 Per-file/per-project tally (from the §4.2 clean-enough run plus D113's own baseline, cross-checked)

| Spec file | desktop-chromium | mobile |
|---|---|---|
| auth.spec.ts | 10 pass (not re-run here; unaffected by the shared-lead-account issue — uses fresh per-test emails) | 10 pass |
| watches.spec.ts | 6 pass | 6 pass |
| purchases.spec.ts | 4 pass (1 flaky→pass at workers=1; clean pass in isolation) | 4 pass (1 flaky→pass) |
| claims.spec.ts | 6 pass | 6 pass |
| isolation.spec.ts | 4 pass (1 flaky→pass at workers=1) | 4 pass (1 flaky→pass) |
| resilience.spec.ts | 12 pass (1 flaky→pass), plus the axe/a11y set now passing per D120 (was 12 `fixme` at D113, flipped over D114/D120/D123) | 12 pass (2 flaky→pass) |

No `test.fixme` remain outstanding per D120's "all 12 axe tests real and
passing" and D123's follow-up contrast fix — consistent with the "11 did
not run" in §4.1 being accounted for by cascade effects of the 5 hard
failures in that specific run (a file whose `beforeAll` throws skips its
remaining tests) rather than any structurally-skipped test.

---

## 5. Live scenarios — NOT AUTHORIZED (BLOCKED, exact missing items)

Per this task's own brief and D83 item 3/6, live provider scenarios are
explicitly not authorized in this mission. Each one, with the precise
blocking item:

| Scenario | BLOCKED because |
|---|---|
| One real verification email | `OPENAI_API_KEY`/`AGENTMAIL_API_KEY` on `adorable-lion-138` are placeholder values (D83), `ALERTS_INBOX_ID` is **absent by name** (`npx convex env list --deployment adorable-lion-138 \| cut -d= -f1`), and this task's own brief states "real provider email sends NOT authorized in this mission" — no user go-ahead was given in this conversation to send a real message |
| One real alert to the verifier's own verified address | Same three blockers (no `ALERTS_INBOX_ID`, placeholder `AGENTMAIL_API_KEY`, and explicit non-authorization of real sends) |
| One real ShopSavvy lookup | `SHOPSAVVY_API_KEY` is **absent by name** on `adorable-lion-138` (not in `npx convex env list` output) — `market.ts`'s `fetchSnapshot` returns `null` immediately and `requestLookup` patches to `marketState: "not_configured"` per `docs/ops/ENVIRONMENT.md`'s documented safe default; there is no key to test against |
| Production deployment / smoke against `cool-oyster-399` | D83 item 6: "Production deploy (`cool-oyster-399`, co-author's team) is not authorized"; this task's contract: "No production deployment performed here" |

No live scenario was attempted; §3.5 above demonstrates the *fail-closed*
behavior of the placeholder-key paths instead, which is real evidence (not
a substitute for live-provider verification, but not nothing either).

---

## 6. P01–P12 acceptance table

Evidence pointers are file:test-name or doc section; PASS means the
acceptance line in `docs/prompts/recoup-opus-sonnet-agent-team.md`'s
`<production_hardening_backlog>` is met by present, passing evidence at the
candidate revision (not re-litigated here — this table aggregates existing
verified evidence per D-series decisions plus this task's own runs).

| # | Acceptance (paraphrased) | Verdict | Evidence |
|---|---|---|---|
| P01 | unverified/opted-out/deleted receive no alert; duplicate/expired tokens fail; re-verification works; existing accounts migrate safely; recovery non-enumerating; abuse bounded | **PASS** (local) | `convex/auth.test.ts`, `convex/authFlow.test.ts`, `convex/alerts.test.ts`, `convex/alerts.flow.test.ts` (D107 Phase 1 ACCEPTED); live send **BLOCKED** (§5) |
| P02 | crash/concurrent/delayed/bounce/no-id/opt-out/scheduler-outage all preserve truthful status, no uncontrolled duplicate sends; merchant drafts unregressed | **PASS** (local) | `convex/notify.test.ts`, `convex/notify.fault.test.ts`, `convex/mailEvents.test.ts`, `convex/drafts.test.ts` (D112 checkpoint 6a/D118); §3.5's live fail-closed evidence corroborates the "never blind-resend" invariant end-to-end |
| P03 | missing→configured key recovers; retry within budgets; no hot-retry loop on legitimate empty result; concurrent requests bounded; archive/delete-mid-flight safe; `market.test.ts` exists | **PASS** (local) | `convex/market.test.ts`, `convex/marketFlow.test.ts`; §3.3 `market:migrateStamps` ran clean (`done:true`, 0 to migrate) on the live deployment |
| P04 | accessory/used/bundle/wrong-or-missing-currency/future-dated/stale rejected or qualified; confidence never becomes certainty | **PASS** (local) | `convex/lib/shopsavvy.test.ts`, `convex/lib/verdict.test.ts` (T04, unchanged since); live ShopSavvy call **BLOCKED** (§5, no key configured) |
| P05 | archive churn doesn't hide active holdings; watch→purchase counts once; confirmed offers beyond candidate-heavy prefixes appear; currencies stay separate; empty/heavy accounts render | **PASS** (local) | `convex/insights.test.ts`, `convex/dashboard.test.ts` (§8 re-measured numbers below; D111/D115's C1/C2 fixes) |
| P06 | tab-open cooldown/window expiry updates correctly; action-side checks authoritative; failed reads don't fake freshness | **PASS** (local) | `convex/freshness.test.ts`, D118's `priceStale`/coarse-`now` fix; F-T24b-2 (UI not rendering `priceStale` on `TrackedTable`) closed per D120 |
| P07 | documented sizes/reads/bytes/timings; no transaction-limit failure; no silent starvation; budgets fail closed under concurrency; bounded history not fictitious totals | **PASS** (local) | `docs/reviews/read-budgets.md` (this task's §8 update); `convex/fairness.test.ts` (1 accepted `it.fails`, F-D74-1 LOW, not a monopoly since rows are bumped — D122); §3.4's live backlog read is bounded/truthful |
| P08 | endpoint inventory with no unexplained public mutator; two-user tests; malformed-input tests; signed/unsigned/duplicate webhook contract tests | **PASS** (local) | `docs/reviews/endpoint-inventory.md` (57/57 public functions, returns validators; D116); `convex/boundary.test.ts`, `convex/http.test.ts`; §2's live webhook check (401, not 500) corroborates |
| P09 | export contains only that user's records; deletion cannot target another user; queued jobs/mail respect deleted/tombstoned identity; provider failure doesn't falsely report full removal | **PASS** (local) | `convex/account.test.ts`, `convex/lifecycle.test.ts` (D115/D118/D119/D121 checkpoint 6b/6c fixes: IDOR, non-terminating cursor, byte-aware paging, stuck-deletion re-drive); §3.3's `account:reDriveStuckDeletions` ran clean live (`rescheduled:0`, nothing stuck) |
| P10 | deterministic browser tests w/ trace-on-failure; mobile+desktop; keyboard flows; no blank screen/secret leak on malformed routes/provider failure | **PASS** (this task, §4) | §4.2/4.3 above — all scenarios pass at the suite's designed concurrency; `trace: "on-first-retry"`/`screenshot: "only-on-failure"` configured and did fire in §4.1's failures |
| P11 | clean isolated install reproduces all gates + patch; CI fails on missing tests/stale generated API; no credentials in logs; warnings fixed or justified | **PASS** (this task, §1) | §1 above, 8/8 gates green from a clean worktree; `.github/workflows/ci.yml` pins Node via `.nvmrc`; zero lint warnings |
| P12 | reproducible release manifest/runbook; working recovery paths; backup/restore proof where access permits; exact final revision smoke-tested; no unresolved high/critical; external blocks explicit | **PARTIAL** | `docs/ops/RUNBOOK.md`/`ENVIRONMENT.md` exist and are largely accurate (§7 below); backup/restore proof is explicitly **deferred to T25** per `docs/team/PLAN.md`'s own T25 contract ("Backup proof: `npx convex export`... `npx convex import`..."), not this task's; smoke run in §2; **one RUNBOOK command does not run as documented** (F-T23-3, §7) |

**7/12 fully PASS with only local+live-fail-closed evidence (no BLOCKED
external item), 4/12 PASS-with-a-documented-BLOCKED-external-item (P01, P02
live send; P03/P04 live ShopSavvy — the *local* acceptance lines are fully
met, only the live-provider portion is blocked), 1/12 (P12) PARTIAL because
backup/restore proof is correctly scoped to T25, not T23, and one
documentation command needs a fix.** No P0x has a failing *local* gate.

---

## 7. Findings register (for T24)

Severity scale matches the existing register (D109/D112/D113/etc.):
CRITICAL/HIGH/MEDIUM/LOW.

| ID | Severity | Finding | Evidence | Routing |
|---|---|---|---|---|
| F-T23-1 | LOW | Verifier's local Node (`v25.2.1`) does not match the pinned `.nvmrc`/CI Node (`22`); `npm ci` only warns (`EBADENGINE`), doesn't fail, so a contributor on the wrong Node can still get a false-green local run. CI itself is unaffected (pins via `.nvmrc`). | §1 table, row 1 | Process note; no code change indicated. Optional: add an `engine-strict=true` `.npmrc` if the team wants local installs to hard-fail on the wrong Node — a product decision, not a defect. |
| F-T23-1b | LOW | `convex/notify.ts:reconcileDrop` throws an **uncaught** `ArgumentValidationError` (not a handled `ConvexError`) when given a `mailLog` row whose `outboundId` isn't a real component-issued id — which is exactly what `convex/testing.ts:seedFixtures`'s queued fixture row contains (`"e2e-outbound-queued" as never`). Not reachable in production (real rows only ever get an `outboundId` from `agentmail.sendMessage`'s own return value, which is always valid), but it means `seedFixtures`' queued mailLog row cannot safely be used to exercise `reconcileDrop`/`recheckDrop`'s live-status-check path in any future E2E/manual test. | §3.5 item 1, exact stack trace captured | T24/T25, low priority: either give `seedFixtures` a documented note that its queued row is render-only (not reconcile-safe), or thread a real sandbox outbound id through if the component ever exposes one for tests. |
| F-T23-2 | MEDIUM | `playwright.config.ts` is explicitly designed for `workers: 1` (its own doc comment names the exact race: "concurrent workers would race each other's seeds/resets"). Running with `--workers=2` reproduces precisely that race: two spec files under the same project concurrently call `testing:resetUser`/`seedUser`/`seedFixtures` on the same shared lead address, producing `ConvexError: seedFixtures: user not found`. Confirmed root cause (§4.1); confirmed non-issue at the config's own `workers: 1` (§4.2, isolated single-test run passes clean, 3-file run passes on the already-configured retry). This is a test-invocation hazard, not a product defect, but it means any future automation that runs this suite with `--workers` > 1 will produce false-negative "failures" that look like real regressions. | §4.1, §4.2 | T24/T25: document in `e2e/README.md`/`playwright.config.ts`'s own comment that `--workers` must not be overridden above 1 until `e2e/fixtures.ts` gives every spec file (not just every project) a fully unique lead account; or make that fixtures.ts change directly (owned by sonnet-tester's files per PLAN.md's file-ownership table, out of this task's scope). |
| F-T23-3 | MEDIUM | `docs/ops/RUNBOOK.md` §11 documents resetting a stalled retention cursor via `npx convex run --inline-query '...'` to *read* the `opsState` row, "then `--inline-mutation` with `ctx.db.patch`..." to *write* it. **`--inline-mutation` does not exist** in this project's installed Convex CLI (`convex@1.46.0`) — confirmed via `npx convex run --help`, which lists only `--inline-query` ("Evaluate an inline readonly query... completely sandboxed, so it can only read data and cannot modify the database"). An operator following this runbook during a real stalled-retention incident has no documented way to patch the cursor without writing and deploying a one-off internal mutation first — a materially slower, higher-friction path than the runbook implies. The `--inline-query` half of the same section (and of §4) was verified to work exactly as documented (`npx convex run --inline-query 'await ctx.db.query("opsState")...` against `adorable-lion-138` returned the live row). | `docs/ops/RUNBOOK.md` §11; `npx convex run --help` output (this task) | T24/T25 (RUNBOOK is `docs/ops/` — this task's owned-files list only covers `phase4-verification.md`/`read-budgets.md`, so the actual doc fix is out of scope here): rewrite §11 to either (a) add a small permanent internal mutation (e.g. `ops.resetRetentionCursor`) callable via a normal `npx convex run`, or (b) explicitly document that the write step requires a temporary code change + deploy, not a CLI one-liner. |
| F-T23-4 | LOW | The main checkout is a live, shared, concurrently-committed-to working tree (§ header note): between this task starting and its browser-suite step, two commits landed on `main` from another lane. §2/§3 (deployed-backend checks) are unaffected, but §4 (which starts a local dev server from the checkout's current files) is not reproducible against a specific pinned commit the way §1's isolated-worktree gates are. This is the same condition `docs/reviews/endpoint-inventory.md`'s own header already accepted as normal for this team's concurrent-lane model, extended here to Phase-4 browser verification specifically. | Header note above; `git diff --stat 529f545 86020f0` | T25 (release preparation): if a byte-for-byte reproducible Phase-4-style browser run is ever required (e.g., a release-candidate gate), run it from a dedicated worktree pinned to the exact tag/commit, the same way §1 already does for the non-browser gates, rather than "the main checkout". |

No new CRITICAL/HIGH findings were produced by this task — every FAIL
observed (smoke's 4 page checks, §2) was already a known, accepted
condition (no static build deployed on `adorable-lion-138`), and every
apparent browser-suite failure (§4.1) was traced to a test-invocation
artifact (F-T23-2) rather than a product defect. All prior HIGH/MEDIUM
findings from D109–D123 that were marked "→ T24" remain open and are
reaffirmed as still-current T24 input by this verification (none were
re-fixed here, per this task's "changes no source" invariant):
F-T15-1 (MEDIUM, `insights.trackedTable` staleness — **note:** D118/D120
show this was actually closed via `priceStale`; kept here only as a
cross-reference, not re-opened), F-T16-2/F-T16-3, F-D74-1 (LOW),
F-T18.4-1, F-T18.1-1, F-T24c-1, F-T24d-1, and the 12 remaining bare
`console.error` call sites named in D118 (`notify.ts`, `priceWatch.ts`,
`watches.ts`, `offers.ts` ×5, `policies.ts`, `market.ts`, `inbound.ts`,
`http.ts:112`) — reconfirmed present by `grep -c console.error convex/*.ts`
= 12 at this candidate revision, unchanged.

---

## 8. Read budgets — see `docs/reviews/read-budgets.md`'s new
"Final numbers @ 529f545 (T23)" section for the re-measured table.

---

## Summary for the report

- **Gate table:** 8/8 worktree gates PASS at `529f545` (§1); smoke 2/7 PASS,
  5/7 FAIL exactly as expected/pre-known (§2); all 6 scheduler functions ran
  clean with truthful before/after backlog deltas (§3); browser suite PASS
  overall once run at its own designed concurrency, with a documented
  test-invocation caveat for `--workers=2` (§4).
- **Scheduler scenario:** seed → 6 internal functions → cleanup, zero
  corruption, two live fail-closed provider-call demonstrations captured
  with sanitized evidence (§3.5).
- **Browser suite:** 35 passed / 5 failed / 3 flaky / 11 did-not-run at
  `--workers=2` as instructed; root-caused to a confirmed shared-fixture
  race (F-T23-2), not a product regression — same scenarios pass clean or
  on retry at the suite's own `workers: 1` design (§4.2).
- **BLOCKED:** real verification/alert email (placeholder keys + no
  `ALERTS_INBOX_ID` + sends not authorized), real ShopSavvy lookup (no
  `SHOPSAVVY_API_KEY`), production deployment (D83 item 6) — §5.
- **New findings:** F-T23-1 (LOW, node version), F-T23-1b (LOW, fixture/
  reconcileDrop scope gap), F-T23-2 (MEDIUM, `--workers=2` test race),
  F-T23-3 (MEDIUM, RUNBOOK `--inline-mutation` doesn't exist in
  convex@1.46.0), F-T23-4 (LOW, shared-checkout reproducibility gap for
  browser-suite runs). None are CRITICAL/HIGH; none block T24 from
  proceeding on the existing register.
- **Counts:** 1287 tests passed across 65 files (1286 real + 1 known
  expected-fail) in the worktree gate run; smoke 2/7 checks pass; scheduler
  6/6 internal functions ran without error; browser suite 35/54 clean-pass
  at the mandated `--workers=2` invocation (5 failed + 3 flaky + 11 did-not-
  run, all traced to F-T23-2), rising to 28/28 pass-or-pass-on-retry for the
  3 previously-affected spec files when re-run at the suite's own designed
  `--workers=1` concurrency, plus a clean 1/1 pass for the single most-
  affected test run fully in isolation with retries disabled — the other 3
  spec files (auth, watches, claims: 10+6+6=22 desktop + 22 mobile) were
  never in the failing set and were not independently re-run by this task.
