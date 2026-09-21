# Team plan — production hardening (lead-owned)

Source: Phase 0 workflow (12 Sonnet reproducers → 24 Opus refuters → Opus planner), full output in `docs/team/phase0/`. Statuses: pending · ready · in_progress · review · changes_requested · verified · blocked.

| ID | Ph | Owner | Blocks on | HR | Purpose | Files | Status |
|---|---|---|---|---|---|---|---|
| T01 | 1 | sonnet-backend | – | yes | Phase 1/2 schema, shared validators, limits, rate-limiter mount, dependency additions, and the shared gate helpers every later task reads. Lands first so no other task edits schema.ts/convex.config.ts | convex/schema.ts, convex/limits.ts, convex/convex.config.ts, package.json, package-lock.json, convex/test.setup.ts… | verified (6 commits; 735 tests; lead re-ran gates) |
| T02 | 1 | sonnet-tester | – | yes | P08 contract tests against existing surfaces (they need no new code): HTTP webhook signed/unsigned/duplicate/malformed via convex-test t.fetch, foreign-ID on every public action and second-id mutation | convex/http.test.ts, convex/boundary.test.ts, docs/reviews/endpoint-inventory.md | verified (36505d1; 95 tests, 2 findings) |
| T03 | 1 | sonnet-frontend | – | no | P10 frontend resilience that needs no backend change: route-level error boundaries (no blank screen on unknown/foreign/malformed ids), missing-configuration guard, offline/reconnect indicator, route c | src/App.tsx, src/main.tsx, src/components/ErrorBoundary.tsx, src/components/States.tsx, src/components/ConnectionBanner.tsx, src/components/claim/Composer.tsx… | verified (d5558a6..a615a20) |
| T04 | 1 | sonnet-integrations | – | no | P04 pure-boundary hardening in lib/shopsavvy.ts and lib/verdict.ts: condition/availability/currency/timestamp/size/length validation and the verdict market-path future-date filter and minimum-point gu | convex/lib/shopsavvy.ts, convex/lib/shopsavvy.test.ts, convex/lib/verdict.ts, convex/lib/verdict.test.ts | verified (e9e3de9, 3feb0bd; 610 tests) |
| T05 | 1 | sonnet-backend | T01 | yes | P01 identity: email verification and password reset through the installed Convex Auth Password provider's verify/reset hooks, email normalisation/validation, per-email rate limiting, non-enumerating s | convex/auth.ts, convex/lib/authMail.ts, convex/lib/authMail.test.ts, convex/lib/email.ts, convex/lib/email.test.ts | verified after T05.1 + T05.2 (N1/N4/N5/N8 + D102 hook) |
| T06 | 1 | sonnet-integrations | T01 | yes | P02 durable alert delivery: sendDrop becomes one transaction (read + gate + enqueue + queued + schedule), send-time verification/preference gate, explicit unknown/suppressed states, owner recheck, hou | convex/notify.ts, convex/notify.test.ts, convex/mail.ts, convex/mailEvents.ts, convex/mailEvents.test.ts, convex/http.ts… | verified after T06.1 + T06.2 (61f2add, 596db68: N2/N3/N6/N7) + F11a (10caaad) |
| T07 | 1 | sonnet-tester | T01 | no | P07 measurement: representative high-volume fixtures under convex-test transactionLimits for insights, watches.list, priceWatch.eligibleItems, intake attention and claims.get; fairness tests for the c | convex/readBudget.test.ts, convex/fairness.test.ts, docs/reviews/read-budgets.md | verified (2e33f91; 14 pass + 3 expected-fail; read-budgets.md) |
| T08 | 1 | sonnet-frontend | T05, T06 | yes | P01/P02 UI: sign-up -> verification-code step, sign-in for unverified accounts, forgot-password/reset flow, Settings alert preference with verification status, honest copy separating per-message merch | src/pages/SignIn.tsx, src/pages/Settings.tsx, src/pages/Watching.tsx, src/components/shell/UserCard.tsx | verified (97900d5..e8242cb; live rehearsal) |
| T09 | 1 | sonnet-tester | T05, T06 | yes | Tester acceptance suite for P01/P02 in separate files: full auth flow tests, alert gate matrix, unsubscribe route, crash-boundary and concurrent-duplicate simulations for the new sendDrop transaction, | convex/auth.test.ts, convex/notify.fault.test.ts, convex/alerts.flow.test.ts | verified (762b497; 37 tests; 877 total) |
| T10 | 2 | sonnet-integrations | T01 | no | P03 recoverable market history: explicit state machine, transactional claim before paid lookup, capped retry/backoff, refresh policy, migration of old stamps, archive/bought guards, fixed user-facing  | convex/market.ts, convex/market.test.ts | verified (6bcfdb6; 17 tests; 840 total) |
| T11 | 2 | sonnet-backend | T01 | no | P05 dashboard accounting: status-indexed reads instead of take-then-filter, canonical bought/check counting across watch->purchase conversion, confirmed offers via the shared helper, per-currency best | convex/insights.ts, convex/insights.test.ts | verified (b2b48d7 + T14a UI adaptation) |
| T12 | 2 | sonnet-backend | T04, T10, T11 | no | P06 freshness and P07 fairness in the backend: remove wall-clock reads from reactive queries (raw timestamps + bounded coarse `now` argument), separate last successful observation from last attempt, s | convex/watches.ts, convex/watches.test.ts, convex/priceWatch.ts, convex/priceWatch.test.ts, convex/tracking.ts, convex/tracking.test.ts… | verified + T12.1 (F1/F2 blockers, F3 4096-range, F6, F5a/b, F10, D93, D87, purchases.get now) |
| T13 | 2 | sonnet-integrations | T10 | no | Offers freshness (raw timestamps instead of nulled leases), P04 leftovers in market/offers ingestion (own-store exclusion by registrable host, availability in stores, per-watch offer cap in recordSnap | convex/offers.ts, convex/offers.test.ts, convex/lib/offerMatch.ts, convex/lib/offerMatch.test.ts, convex/market.ts, convex/market.test.ts | verified + T13.1 (af9facd..d167816; F4/F5a/F7/F8/F9/F11/F12 fixed; 78 tests in owned files) |
| T14 | 2 | sonnet-frontend | T11, T12, T13 | no | P05/P06 UI: dashboard truncation labels and per-currency bests, WatchCard price-as-of and stale qualification, client-computed checking/cooldown/search-lease state, MarketHistory state copy, budget-pa | src/pages/Watching.tsx, src/pages/Board.tsx, src/components/watching/WatchCard.tsx, src/components/watching/StoreCompare.tsx, src/components/watching/MarketHistory.tsx, src/components/dashboard/SourcesCard.tsx… | verified (0a6e611..fe7e422; typecheck clean; live auth rehearsal blocked → T20a) |
| T15 | 2 | sonnet-tester | T12, T13, T14 | no | Cross-module regression tests for Phase 2 slices in tester-owned files: freshness across watches/offers/insights/tracking, market recovery end-to-end from watch check to dashboard, dashboard accountin | convex/freshness.test.ts, convex/dashboard.test.ts, convex/marketFlow.test.ts, docs/reviews/read-budgets.md | verified (3a4ea5d; lead re-ran 13 pass + 1 expected fail; F-T15-1 to register) |
| T16 | 2 | sonnet-backend | T12 | yes | P07 retention (bounded, resumable, audit-preserving) plus P08 backend fixes: returns validators and string bounds on claims/purchases, needsAttention projection, inbound extraction budget, inbox-provi | convex/retention.ts, convex/retention.test.ts, convex/claims.ts, convex/claims.test.ts, convex/purchases.ts, convex/purchases.test.ts… | done (a14ebb8 et al.; lead: full suite 1104+1, typecheck/lint clean; awaiting Opus checkpoint 6) |
| T17 | 3 | sonnet-verifier | T01, T03 | no | P11 reproducible installation and CI: pinned Node, GitHub Actions workflow with npm ci, patch verification, typecheck, lint (0 warnings), tests without --passWithNoTests and a minimum-count check, bui | .github/workflows/ci.yml, .nvmrc, package.json, package-lock.json, scripts/check-patch.mjs, scripts/check-test-count.mjs… | verified (fresh-clone proof; codegen:check needs a CI deployment secret) |
| T18 | 3 | sonnet-backend | T16 | yes | P09 backend: authenticated paged data export, explicit account-deletion flow with confirmation, session revocation, tombstone, resumable bounded purge including the AgentMail inbox, bounded provider-f | convex/account.ts, convex/account.test.ts, convex/lib/accountState.ts | WITHHELD at 6b (D115) → T18.1 in_progress (account/auth/crons), T18.2 pending (integration gates), T18.3 pending (read gates), T18.4 pending (mail-component purge) |
| T19 | 3 | sonnet-frontend | T18 | yes | P09 UI: Settings export (paged fetch to a JSON download), account deletion with typed confirmation and post-deletion sign-out, and a truthful Privacy & services page (providers, retention, contact, li | src/pages/Settings.tsx, src/pages/Privacy.tsx, src/App.tsx, src/pages/SignIn.tsx, src/components/shell/UserCard.tsx | in_progress (wave 10; + F-T24-1 ActivityTimeline/Watching contrast, F-T16-3) |
| T20 | 3 | sonnet-tester | T08, T14, T17, T19 | yes | P10 browser acceptance suite (Playwright) against a disposable Convex dev deployment with controlled fixtures and mocked providers, separated from provider smoke tests; accessibility checks; desktop a | e2e/auth.spec.ts, e2e/watches.spec.ts, e2e/purchases.spec.ts, e2e/claims.spec.ts, e2e/resilience.spec.ts, e2e/isolation.spec.ts… | verified (b619e20; 6 specs × 2 projects: 42 pass + 12 fixme on real contrast findings; lifecycle specs pending T18/T19; F-T20-1/2 to register) |
| T21 | 3 | sonnet-tester | T18 | yes | P09 and P08 cross-user tests in tester files: export/deletion isolation, deletion vs scheduled work, webhook after deletion, plus the final endpoint inventory refresh with returns validators and spend | convex/lifecycle.test.ts, docs/reviews/endpoint-inventory.md | verified (657d1f2; lead re-ran 12 pass + 1 expected fail = 6b-3/F-T21-1; inventory 57/57 returns, 2 bound gaps → T18.2) |
| T22 | 3 | sonnet-verifier | T12, T13, T16 | no | P12 operations and docs: structured redacted failure logging with correlation ids, operator pause switch, smoke script, README/hackathon reconciliation, environment documentation, runbook and release/ | convex/lib/log.ts, convex/lib/log.test.ts, convex/ops.ts, convex/ops.test.ts, scripts/smoke.mjs, README.md… | verified (6e3d66e; 34 tests; smoke 1/7 against adorable-lion-138 because the static site is not deployed there; findings F-T22-1/2 to the T24 register) |
| T23 | 4 | sonnet-verifier | T09, T15, T20, T21, T22 | yes | Phase 4 verification: clean isolated install and all gates, browser suite run against the disposable deployment, scheduler scenario (manual cron invocations), authorized controlled live scenarios, mea | docs/reviews/phase4-verification.md, docs/reviews/read-budgets.md | pending |
| T24 | 4 | sonnet-backend | T23 | yes | Resolve critical/high findings and failed required gates from Phase 4 verification and the fresh Opus audit (conditional; scoped by the findings register). | convex/**/*.ts (only files named in the findings register), src/**/*.tsx (only files named in the findings register) | pending |
| T25 | 5 | sonnet-verifier | T24 | yes | Phase 5 release preparation: reproducible release manifest for the exact release candidate, environment checklist, backup/restore proof on the disposable deployment, deploy order, rollback/restore ins | docs/ops/RELEASE.md, docs/reviews/release-candidate.md, docs/team/HANDOFF.md | pending |

## Waves
- W1: T01, T02, T03, T04
- W2: T05, T06, T07
- W3: T08, T09, T10, T11
- W4: T12, T13, T17
- W5: T14, T15, T16
- W6: T18, T20, T22
- W7: T19, T21
- W8: T23
- W9: T24
- W10: T25

## File ownership
- `convex/schema.ts` → sonnet-backend (T01 only; any later schema need is an addendum by sonnet-backend, pre-declared: offerChecks.source?: priceSource)
- `convex/convex.config.ts` → sonnet-backend (T01)
- `package.json + package-lock.json` → sonnet-backend in wave 1 (T01); sonnet-verifier from wave 4 (T17) onward
- `convex/http.ts` → sonnet-integrations (T06)
- `convex/crons.ts` → sonnet-integrations through wave 2 (T06); sonnet-backend from wave 4 (T12, T16)
- `src/App.tsx, src/main.tsx` → sonnet-frontend
- `shared validators (convex/schema.ts exports), convex/limits.ts, convex/lib/access.ts, convex/lib/accountState.ts, convex/lib/rateLimits.ts, convex/lib/budget.ts, convex/lib/email.ts, convex/lib/authMail.ts, convex/lib/errors.ts, convex/lib/passage.ts` → sonnet-backend
- `convex/auth.ts, convex/alerts.ts, convex/account.ts, convex/retention.ts, convex/watches.ts, convex/priceWatch.ts, convex/insights.ts, convex/tracking.ts, convex/budget.ts, convex/claims.ts, convex/purchases.ts, convex/intake.ts, convex/replies.ts, convex/profiles.ts, convex/test.setup.ts (+ their X.test.ts)` → sonnet-backend
- `convex/notify.ts, convex/mail.ts, convex/mailEvents.ts, convex/drafts.ts, convex/offers.ts, convex/market.ts, convex/lib/shopsavvy.ts, convex/lib/verdict.ts, convex/lib/offerMatch.ts (+ their X.test.ts)` → sonnet-integrations
- `console.error lines in notify.ts, priceWatch.ts, watches.ts, offers.ts, policies.ts, market.ts, inbound.ts during wave 6` → sonnet-verifier (T22, mechanical replacement only)
- `convex/lib/log.ts, convex/ops.ts, scripts/, .github/, .nvmrc, vitest.config.mts, playwright.config.ts, README.md, hackathon.md, docs/ops/, docs/reviews/phase4-verification.md, docs/reviews/release-candidate.md, docs/team/HANDOFF.md` → sonnet-verifier
- `convex/http.test.ts, convex/boundary.test.ts, convex/readBudget.test.ts, convex/fairness.test.ts, convex/auth.test.ts, convex/notify.fault.test.ts, convex/alerts.flow.test.ts, convex/freshness.test.ts, convex/dashboard.test.ts, convex/marketFlow.test.ts, convex/lifecycle.test.ts, convex/testing.ts, e2e/**, docs/reviews/endpoint-inventory.md, docs/reviews/read-budgets.md` → sonnet-tester
- `src/** (all other frontend files)` → sonnet-frontend
- `docs/team/DECISIONS.md` → lead only

## Task contracts (verbatim from planner; implementers receive these in their prompts)
### T01 — Phase 1/2 schema, shared validators, limits, rate-limiter mount, dependency additions, and the shared gate helpers every
**Owner:** sonnet-backend · **Phase:** 1 · **Blocks on:** – · **High-risk:** True
**Files:** convex/schema.ts, convex/limits.ts, convex/convex.config.ts, package.json, package-lock.json, convex/test.setup.ts, convex/lib/rateLimits.ts, convex/lib/accountState.ts, convex/lib/budget.ts, convex/alerts.ts, convex/alerts.test.ts, convex/lib/passage.ts, convex/_generated/api.d.ts, convex/_generated/api.js

**Contract:**

SCHEMA (convex/schema.ts): (1) mailStatus adds literals "unknown" (reconciliation exhausted, no message id) and "suppressed" (gate refused). Export `mailReason = v.union(literals: unverified, opted_out, deleted, address_suppressed, daily_cap, global_cap, no_email, not_configured, watch_inactive, send_failed)`. mailLog adds `reason: v.optional(mailReason)`, `attempt: v.optional(v.number())`, `nextCheckAt: v.optional(v.number())`, `lastCheckedAt: v.optional(v.number())`, `providerStatus: v.optional(v.string())`, indexes `by_outbound ["outboundId"]` and `by_status_nextCheck ["status","nextCheckAt"]`. (2) New table `alertSettings { userId: v.id("users"), alertsEnabled: v.boolean(), unsubscribeToken: v.string(), suppressedAt?: number, suppressedReason?: v.union("bounced","complained","user_unsubscribed"), updatedAt: number }` indexes by_user, by_token. (3) New table `accountState { userId: v.id("users"), status: v.union("deleting","deleted"), requestedAt: number, completedAt?: number, attempts: number, lastError?: string, inboxDeleted?: boolean, progress?: v.object({ table: v.string(), cursor: v.optional(v.string()) }) }` indexes by_user, by_status (absence of a row = active). (4) New table `opsState { key: v.string(), cursor?: v.string(), updatedAt: number }` index by_key (retention cursors). (5) Export `marketState = v.union(not_configured, queued, running, success, empty_result, retryable_failure, terminal_failure)`; watches adds `marketState?: marketState`, `marketAttempts?: number`, `marketClaimedAt?: number`, `marketNextRetryAt?: number`, `marketObservedAt?: number` (newest provider point time; marketFetchedAt stays = retrieval time), `lastObservedAt?: number` (time of last ACCEPTED own price). (6) items adds `nextCheckAt?: number` and index `by_nextCheck ["nextCheckAt"]`; purchases adds index `by_user_status ["userId","status"]`; claims adds index `by_item_kind_status ["itemId","kind","status"]`. LIMITS (convex/limits.ts): `AUTH_ATTEMPTS_PER_EMAIL=10 per 10 min`, `AUTH_MAIL_PER_EMAIL=3 per hour`, `AUTH_MAIL_GLOBAL=200 per hour`, `VERIFICATION_CODE_TTL_S=900`, `MAIL_RECONCILE_STALL_MS=1_800_000`, `MAIL_SWEEP_PAGE=50`, `DROP_RECLAIM_MIN_MS=86_400_000`, `MARKET_MAX_ATTEMPTS=3`, `MARKET_RETRY_BACKOFF_MS=[600_000, 3_600_000, 21_600_000]`, `MARKET_REFRESH_MIN_AGE_MS=7 days`, `STALE_PRICE_MS=3 days`, `PRICE_CHECK_PER_USER_PER_TICK=10`, `WATCH_SWEEP_PER_USER=10`, `RETENTION_PAYLOAD_DAYS=30`, `RETENTION_OBSERVATION_DAYS=180`, `RETENTION_KEEP_NEWEST=30`, `RETENTION_MAILLOG_DAYS=90`, `RETENTION_PAGE=200`; GLOBAL_DAILY_BUDGETS adds `claim_email: 100`, `inbound_extract: 500`. convex/lib/budget.ts: `charge()`/`tryCharge()` MUST enforce the global row for any kind present in GLOBAL_DAILY_BUDGETS (verify; today's drafts.approveAndSend charge("claim_email") therefore becomes globally capped with no drafts.ts edit). RATE LIMITER: add dependency `@convex-dev/rate-limiter` (exact pin) and direct dependency `@oslojs/crypto` (already hoisted transitively); `app.use(rateLimiter)` in convex.config.ts; `convex/lib/rateLimits.ts` exports `rateLimiter = new RateLimiter(components.rateLimiter, { authAttempt: { kind: "token bucket", rate: 10, period: 10*MINUTE, capacity: 10 }, authMailPerEmail: { kind: "fixed window", rate: 3, period: HOUR }, authMailGlobal: { kind: "fixed window", rate: 200, period: HOUR }, inboxProvision: { kind: "fixed window", rate: 1, period: 5*MINUTE }, dropRecheck: { kind: "fixed window", rate: 1, period: MINUTE } })`; test.setup.ts registers the component per D51 (glob its src/component exhaustively). HELPERS: `convex/lib/accountState.ts` exports `isTombstoned(ctx: QueryCtx, userId): Promise<boolean>` and `alertGate(ctx: QueryCtx, userId): Promise<{ ok: true; to: string } | { ok: false; reason: MailReason; message: string }>` evaluating in order: accountState deleting/deleted -> deleted; users.email missing -> no_email; users.emailVerificationTime undefined -> unverified; alertSettings.alertsEnabled === false -> opted_out; alertSettings.suppressedAt set -> address_suppressed. Fixed user-facing message per reason. ALERTS MODULE (convex/alerts.ts): `settings` query (requireUserId) returns `{ alertsEnabled: boolean, emailVerified: boolean, email: string|null, suppressedReason: string|null }`; `setAlerts({ enabled: v.boolean() })` mutation (creates row, generates 32-byte hex token via crypto.getRandomValues, clears suppressedReason only when it was user_unsubscribed); `tokenFor(ctx: MutationCtx, userId): Promise<string>` helper (creates row if absent); `unsubscribeByToken({ token: v.string() })` internalMutation -> sets alertsEnabled=false, suppressedReason=user_unsubscribed, returns v.boolean() (route caller never leaks the boolean). Also fix the oxlint no-useless-escape warning in convex/lib/passage.ts:25. Run `npx convex codegen` and commit convex/_generated (D50; also fixes the stale lib/errors drift).

**Acceptance:**
- npm run typecheck and npm test pass after schema/index changes (575 baseline tests unchanged)
- convex/alerts.test.ts: settings default enabled; setAlerts false/true round-trip; unsubscribeByToken with unknown token returns false and writes nothing; valid token disables and records user_unsubscribed; another user's token cannot be read via settings
- alertGate unit tests: each reason branch (deleted, no_email, unverified, opted_out, address_suppressed) and ok path returning the trimmed email
- budget test: charge("claim_email") 101st global call in a day throws even for different users; inbound_extract kind exists
- rate limiter component registers in convex-test and rateLimiter.limit("authAttempt") refuses the 11th call within 10 minutes for one key
- codegen diff is empty after `npx convex codegen` (lib/errors present in api.d.ts)

**Invariants:** No existing table loses a field; all new fields optional so existing rows validate; Global budgets fail closed under concurrent work (read+write of the usage row in one mutation); No secret is read or stored by alerts.ts; unsubscribe tokens are opaque and never reused as auth

**Risks:** Largest blast radius task; every later task compiles against these names. Rate-limiter component registration in convex-test may need the D51 exhaustive glob treatment.

### T02 — P08 contract tests against existing surfaces (they need no new code): HTTP webhook signed/unsigned/duplicate/malformed v
**Owner:** sonnet-tester · **Phase:** 1 · **Blocks on:** – · **High-risk:** True
**Files:** convex/http.test.ts, convex/boundary.test.ts, docs/reviews/endpoint-inventory.md

**Contract:**

convex/http.test.ts uses `t.fetch("/agentmail/webhook", { method: "POST", headers, body })` with AGENTMAIL_WEBHOOK_SECRET from test.setup.ts and the svix library (already a transitive dependency of @agentmail/convex) to sign bodies: (a) unsigned -> 401 and zero processedEvents/component rows; (b) bad signature -> 401; (c) signed message.received -> 200 and exactly one processedEvents row; (d) the same signed body twice -> still one processedEvents row and one component event row; (e) malformed JSON with a valid signature -> non-2xx and no row; (f) body of 2 MB -> documented outcome (no crash of app tables). convex/boundary.test.ts: for each public action (drafts.generate, intake.paste, policies.refresh, profiles.ensureInbox) and each mutation taking a second id (purchases.confirm itemIds, offers.confirm/reject, claims.* on foreign claimId, market.refresh foreign watchId) assert `rejects.toThrow()` for user B against user A's ids AND that usage/drafts/claims tables are unchanged afterwards; malformed inputs: 10_000-char evidence/reason/idempotencyKey on claims.confirmCredit/recordLaterDebit/adjustExpected (records current behaviour; T16 tightens and updates the expectation), `v.id` validation failure on unknown id strings. docs/reviews/endpoint-inventory.md: table of all 50+ public exports (file:line, kind, identity check, ownership helper, relation checks, args/returns validators present, spend, output projection), with auth.signIn/signOut/isAuthenticated listed as framework-protected exceptions.

**Acceptance:**
- Every listed webhook case is a passing test (documented skip with reason if t.fetch cannot reach the route)
- Every public action has a foreign-id rejection test that also asserts no spend/no write
- Inventory lists every exported public query/mutation/action in convex/*.ts with no unexplained public mutator

**Invariants:** Tests never call real providers; svix signing uses the test secret only; Test files do not modify shared harness files

**Risks:** t.fetch + httpRouter with the auth routes and static-hosting catch-all may need the component registered in the harness; if the static-hosting component blocks, register it per D51.

### T03 — P10 frontend resilience that needs no backend change: route-level error boundaries (no blank screen on unknown/foreign/m
**Owner:** sonnet-frontend · **Phase:** 1 · **Blocks on:** – · **High-risk:** False
**Files:** src/App.tsx, src/main.tsx, src/components/ErrorBoundary.tsx, src/components/States.tsx, src/components/ConnectionBanner.tsx, src/components/claim/Composer.tsx, src/components/Money.tsx, src/lib/money.ts, src/pages/Purchase.tsx, src/pages/Claim.tsx, vite.config.ts

**Contract:**

src/main.tsx: if `import.meta.env.VITE_CONVEX_URL` is missing or not https, render a static `<ConfigMissing/>` message (role=alert, no secrets) instead of constructing ConvexReactClient. src/components/ErrorBoundary.tsx: class component with getDerivedStateFromError; props `{ fallback: (err, reset) => ReactNode }`; renders `<ErrorBox>` with a generic message, a `Go to board` link and `Try again` button; it maps ConvexError data containing "not found" (purchase/claim/watch) to the copy "This item does not exist or belongs to another account."; never renders raw err.message for non-ConvexError errors. src/App.tsx: wrap each `<Route element>` in `<ErrorBoundary>` (keyed by location.pathname so reset happens on navigation) and convert page imports to `React.lazy` with a `<Loading/>` Suspense fallback; keep the `/`, `/purchases/:id`, `/claims/:id`, `/watching`, `/settings`, `*` routes; add placeholder routes `/privacy` (T19 fills) only when T19 lands. src/components/ConnectionBanner.tsx: uses `useConvexConnectionState()` from convex/react (fallback `client.connectionState()` polling every 2s if the hook is absent in convex 1.46) plus `navigator.onLine`; shows a non-blocking banner "Reconnecting…" when `!isWebSocketConnected` for > 3s; mounted once in Shell via App.tsx. src/components/claim/Composer.tsx `deliveryOf()`: order becomes status ∈ TERMINAL_FAILURES or errorMessage -> failed label BEFORE the agentmailMessageId -> Sent branch; providerStatus "complained" renders "Delivered, marked as spam". Money.tsx: move non-component exports into src/lib/money.ts. vite.config.ts: `build.rollupOptions.output.manualChunks` for react/react-dom/react-router and convex vendor chunks; do NOT raise chunkSizeWarningLimit.

**Acceptance:**
- npm run build main chunk < 350 kB and no >500 kB chunk warning; lint 0 warnings for Money.tsx
- Manual/Playwright-later: /purchases/abc, /claims/<other-user-id> render the ErrorBox with board link, not a blank page (documented in the task report with screenshot)
- Composer: a sendStatus of {status:'bounced', agentmailMessageId:'x', errorMessage:null} renders a failure label (unit-testable pure function exported as deliveryOf)
- With VITE_CONVEX_URL unset, `vite build` output renders the ConfigMissing message (verified by loading dist/index.html in the browser tool)

**Invariants:** Error UI never prints stack traces, provider bodies or env values; Auth-gated routing behaviour unchanged (AuthLoading/Unauthenticated flow preserved)

**Risks:** React.lazy + Convex Auth loading states can flash; keep Suspense fallback identical to existing Loading. useConvexConnectionState availability in convex 1.46 must be checked.

### T04 — P04 pure-boundary hardening in lib/shopsavvy.ts and lib/verdict.ts: condition/availability/currency/timestamp/size/lengt
**Owner:** sonnet-integrations · **Phase:** 1 · **Blocks on:** – · **High-risk:** False
**Files:** convex/lib/shopsavvy.ts, convex/lib/shopsavvy.test.ts, convex/lib/verdict.ts, convex/lib/verdict.test.ts

**Contract:**

lib/shopsavvy.ts: (1) `parseSnapshot` caps loops at `MARKET_PARSE_MAX_OFFERS=200` and `MARKET_PARSE_MAX_POINTS_PER_OFFER=400` (constants exported from shopsavvy.ts, not limits.ts, to keep this task file-local) and drops the rest; `str()` caps at 200 chars; retailer > 200 chars truncated. (2) `epoch()` rejects timestamps > now + 24h or < 2010-01-01 (returns null -> point dropped); accepts a `now` parameter threaded from callers (default Date.now() only in actions). (3) A point or offer with no currency at all is DROPPED (never defaulted to the watch currency); `flattenHistory`/`marketStats` keep `?? currency` removed. (4) `condition` parsed; points/offers with condition matching /used|refurb|open.?box|renewed/i are excluded from history and from candidate stores; `availability` false/out-of-stock excluded from candidate stores (history keeps them but flagged `inStock: false` in the returned point type). (5) `withoutOutliers` unchanged, but export `MIN_OUTLIER_POINTS=4` for verdict use. (6) Remove the dead `marketStats` export's raw productUrl path (delete `marketStats` entirely if only tests use it; update tests). lib/verdict.ts: `fromMarket` filters `p.observedAt <= now` and requires `market.length >= 4` (i.e. outlier filtering was effective) else returns not_enough_history; new input field `priceObservedAt?: number` (T12 passes watch.lastObservedAt): when `now - priceObservedAt > STALE_PRICE_MS` (constant duplicated locally as 3 days; T12 imports the limits value) return `{ label: "unknown", reason: "The last price we could read was N days ago; we will judge it again after the next successful check." }` before any comparison. Keep every existing label threshold and test.

**Acceptance:**
- shopsavvy.test.ts: no-currency offer dropped from history and stores; used/refurbished excluded; out-of-stock offer excluded from stores; future-dated and pre-2010 points dropped; 50,000-offer body parses at most 200 offers; 200,000-char retailer truncated
- verdict.test.ts: market point dated in the future ignored (mirror of the own-history test); market with 3 points returns not_enough_history; stale priceObservedAt returns unknown with the age reason; all existing verdict tests still pass
- No change to verdict labels for the existing fixtures

**Invariants:** Invariant 13: missing or ambiguous prices are not discounts; ShopSavvy data never creates claims or alerts (no call-site changes here)

**Risks:** Dropping no-currency points can empty the market series for some products; acceptable and labelled by MarketHistory (T14).

### T05 — P01 identity: email verification and password reset through the installed Convex Auth Password provider's verify/reset h
**Owner:** sonnet-backend · **Phase:** 1 · **Blocks on:** T01 · **High-risk:** True
**Files:** convex/auth.ts, convex/lib/authMail.ts, convex/lib/authMail.test.ts, convex/lib/email.ts, convex/lib/email.test.ts

**Contract:**

convex/lib/email.ts: `normalizeEmail(raw: unknown): string` -> trim, lowercase, length <= 254, must match `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`, else throw `ConvexError("Enter a valid email address")`. No plus/dot folding (record as decision). convex/lib/authMail.ts: `export function authMail(kind: "verify" | "reset")` returns `Email({ id: kind === "verify" ? "recoup-verify" : "recoup-reset", maxAge: VERIFICATION_CODE_TTL_S, generateVerificationToken: async () => generateRandomString(random, "0123456789", 8) from @oslojs/crypto/random, sendVerificationRequest: async ({ identifier, token, expires }, ctx) => { await rateLimiter.limit(ctx, "authMailPerEmail", { key: identifier, throws: true }); await rateLimiter.limit(ctx, "authMailGlobal", { throws: true }); POST `${AGENTMAIL_BASE_URL ?? default}/inboxes/${ALERTS_INBOX_ID}/messages/send` with bearer AGENTMAIL_API_KEY and body { to: [identifier], subject: fixed, text: fixed template containing the 8-digit code and expiry minutes, no links }; on missing ALERTS_INBOX_ID/AGENTMAIL_API_KEY or !response.ok throw ConvexError("Could not send the email right now") without echoing the body } })`. Mail send function is injectable (`sendAuthMail` dependency parameter defaulting to the fetch implementation) so tests mock it. convex/auth.ts: `const password = Password<DataModel>({ profile: (params) => ({ email: normalizeEmail(params.email) }), validatePasswordRequirements: (p) => 8 <= p.length <= 128 else ConvexError, verify: authMail("verify"), reset: authMail("reset") })`; `guarded(provider)` wraps `provider.authorize(params, ctx)`: (1) `rateLimiter.limit(ctx, "authAttempt", { key: normalizeEmail(params.email), throws: true })` before any provider work; (2) flow === "signUp": catch any error whose message includes "already exists" and rethrow `ConvexError("Could not create an account with those details. If you already have one, sign in or reset your password.")`; (3) flow === "reset": catch InvalidAccountId and return the same `{ kind: "started", started: true }` result the provider returns for a known address, sending nothing; (4) all other errors pass through. `convexAuth({ providers: [guarded(password)] })`. Existing accounts: NOT grandfathered; Password.ts:229 already forces `email-verification` on next sign-in when `verify` is set (this is the migration). No email-change mutation is added; add a test asserting no convex module patches users.email.

**Acceptance:**
- email.test.ts: normalisation cases, rejects no-@, >254 chars, whitespace-only
- authMail.test.ts: sendVerificationRequest calls the injected sender with the 8-digit token and fixed subject; 4th send for one address within an hour throws; missing ALERTS_INBOX_ID throws a ConvexError with no body echo
- auth wrapper tests (convex-test, mocked sender): signUp -> returns started (no session) and one mail; signUp for an existing address with a wrong password -> the generic ConvexError and no mail; reset for unknown address -> started, no mail, same shape as known address; 11th attempt for one email in 10 minutes -> rate-limit error; email-verification with a wrong/expired code fails; correct code sets users.emailVerificationTime
- Tester's convex/auth.test.ts (T09) passes without changes to these contracts

**Invariants:** No custom token cryptography; codes and expiry are the provider's authVerificationCodes rows; Auth mail body is fixed copy with no user-controlled text and no link; users.email is written only by the provider at sign-up

**Risks:** Convex Auth flows under convex-test may need JWT_PRIVATE_KEY/SITE_URL env; signUp with verify returns before session minting so most cases avoid JWT. Wrapping authorize must preserve the provider's `extraProviders` field so verify/reset providers register.

### T06 — P02 durable alert delivery: sendDrop becomes one transaction (read + gate + enqueue + queued + schedule), send-time veri
**Owner:** sonnet-integrations · **Phase:** 1 · **Blocks on:** T01 · **High-risk:** True
**Files:** convex/notify.ts, convex/notify.test.ts, convex/mail.ts, convex/mailEvents.ts, convex/mailEvents.test.ts, convex/http.ts, convex/crons.ts, convex/drafts.ts, convex/drafts.test.ts

**Contract:**

notify.ts: (1) `claimDrop(ctx, ...)` unchanged dedupe, but if the existing dedupe row is status failed(reason send_failed)/suppressed(reason in daily_cap, global_cap, no_email, not_configured, watch_inactive, unverified) and `_creationTime < now - DROP_RECLAIM_MIN_MS`, it is re-claimed in place (patch back to claimed, clear error/reason) instead of ignored; rows with reason opted_out/deleted/address_suppressed are never re-claimed. It calls `alertGate` and inserts `suppressed` rows with reason before scheduling anything. (2) `sendDrop` becomes `internalMutation({ args: { mailLogId: v.id("mailLog") } })`: row must be claimed else return null; re-run `alertGate` (send-time recheck) and the watch/inbox checks; on refusal patch `{ status: "suppressed", reason, error: message }`; else `const { outboundId } = await agentmail.sendMessage(ctx, {...fixed subject/body + footer line `Unsubscribe: ${process.env.CONVEX_SITE_URL}/alerts/unsubscribe?token=${await tokenFor(ctx, userId)}`})` then patch `{ status: "queued", outboundId, attempt: 0, nextCheckAt: now + BACKOFF_MS[0] }` and `ctx.scheduler.runAfter(BACKOFF_MS[0], internal.notify.reconcileDrop, { mailLogId, attempt: 1 })` in the same transaction; if sendMessage throws, patch `{ status: "failed", reason: "send_failed", error: sanitizeError(err) }`. Delete markQueued/finishDrop and the action. (3) `applyDropOutcome`: bounced/rejected/failed -> failed (error sanitized, providerStatus raw); complained -> sent + providerStatus complained + `suppressAddress(userId, "complained")`; sent/delivered with id -> sent + providerStatus; pending -> schedule next attempt with `nextCheckAt`; attempts exhausted -> status unknown, nextCheckAt = now + MAIL_RECONCILE_STALL_MS. Every transition records lastCheckedAt. (4) `recheckDrop` public mutation `{ mailLogId }`: requireUserId, row.userId must match, status ∈ {queued, unknown}, `rateLimiter.limit("dropRecheck", key: mailLogId)`, schedules reconcileDrop(attempt = row.attempt ?? 1) now. (5) `sweepStalled` internalMutation: `by_status_nextCheck` for status queued and unknown with nextCheckAt <= now, take MAIL_SWEEP_PAGE, schedule reconcileDrop for each and bump nextCheckAt by MAIL_RECONCILE_STALL_MS; returns count. crons.ts adds `crons.interval("mail sweep", { hours: 1 }, internal.notify.sweepStalled, {})`. (6) `drops` query returns status, reason, error, providerStatus, and `canRecheck: boolean`. mail.ts: `new AgentMail(components.agentmail, { onMessageReceived, onEvent: internal.mailEvents.onEvent })`. mailEvents.ts `onEvent` internalMutation (args exactly per node_modules/@agentmail/convex/dist/client/index.d.ts onEvent reference): for events carrying an outboundId: mailLog.by_outbound -> if the new status is bounced/rejected/failed after sent -> patch status failed (providerStatus, error "The email bounced") and suppressAddress("bounced"); complained -> providerStatus complained + suppressAddress("complained"); drafts.by_outbound -> call drafts' exported `applySendOutcome` (drafts.ts) so a post-sent bounce sets draft.sendError, returns the claim to "drafted" only from "sent", cancels pending followUps via followUps.cancelPending, and records a claimNote; events without outboundId are ignored; handler never throws (log via console.error with eventId). `suppressAddress(ctx, userId, reason)` lives in mailEvents.ts and patches alertSettings (creating the row). drafts.ts: only `applySendOutcome`/`reconcileSend` region changes to accept the late-bounce path; approveAndSend, newest-draft, recipient confirmation, cancellation guards untouched. http.ts: add `GET /alerts/unsubscribe` httpAction: reads `token` query param (<= 128 chars), runs `internal.alerts.unsubscribeByToken`, always responds 200 text/plain "You will no longer receive price alert emails from Recoup."; route registered before static routes.

**Acceptance:**
- notify.test.ts: sendMessage mock throwing -> row failed/send_failed, no outboundId, nothing scheduled; success -> queued + outboundId + one scheduled reconcileDrop in the same transaction (assert via _scheduled_functions); unverified user -> suppressed/unverified and no send; alertsEnabled=false -> suppressed/opted_out; tombstoned user -> suppressed/deleted; caps -> suppressed/daily_cap|global_cap (replacing the failed+error expectation); exhausted backoff -> unknown with nextCheckAt; sweepStalled reschedules unknown rows once per stall window; recheckDrop by owner schedules, by other user throws, on sent row throws; re-claim after 24h for send_failed but never for opted_out
- mailEvents.test.ts: late bounce on a sent mailLog -> failed + alertSettings.suppressedReason bounced; complaint -> suppressed complained; late bounce on a sent draft -> draft.sendError set, claim drafted, pending followUp cancelled; duplicate event id -> idempotent; event without outboundId -> no-op
- drafts.test.ts: all existing approveAndSend/reconcileSend/markPacketSent/recheckSend tests unchanged and passing
- http.test.ts (T02 extends or T09 adds): GET /alerts/unsubscribe with valid token disables alerts; with garbage token returns 200 and writes nothing

**Invariants:** Invariant 8: UI status is queued until the component reports a message id; unknown never renders as sent; Never blind-resend: a row leaves claimed only inside the transaction that enqueued it; Merchant approval/newest-draft/cancel protections (D49, D52, D56, D57, D58) are regression targets

**Risks:** onEvent argument shape must be read from the installed component types; convex-test dispatch into the component is known to fail (drafts.test.ts:402-411), so sendMessage is mocked at the module boundary as today.

### T07 — P07 measurement: representative high-volume fixtures under convex-test transactionLimits for insights, watches.list, pri
**Owner:** sonnet-tester · **Phase:** 1 · **Blocks on:** T01 · **High-risk:** False
**Files:** convex/readBudget.test.ts, convex/fairness.test.ts, docs/reviews/read-budgets.md

**Contract:**

convex/readBudget.test.ts uses `convexTest({ schema, modules, transactionLimits: true })` (options-object form) and a fixture builder `heavyAccount(t, { purchases: 40, itemsPerPurchase: 50, checksPerItem: 12, claims: 40, draftsPerClaim: 200, watches: 40, offersPerWatch: 40 })` built in chunked t.run calls. Records for each query (insights.activity, insights.sources, insights.priceHistory, insights.trackedTable, watches.list, tracking.overview, intake.needsAttention, claims.get, purchases.board) the documentsRead/bytesRead reported by convex-test (read from the transaction metrics if exposed, else assert no throw plus wall-clock). Asserts today's known failure explicitly: 500 items x (1 open price claim + 64 dismissed return claims) makes internal.priceWatch.eligibleItems throw the 32,000-document limit (this test is inverted by T12 once fixed). convex/fairness.test.ts: two users, user B fills 50 newest eligible items; assert user A's older eligible item is absent from eligibleItems across three ticks today (inverted by T12), and the watches.sweep two-user rotation case. docs/reviews/read-budgets.md: table of query, fixture, documentsRead, bytes, ms, and the 32k/16MiB headroom.

**Acceptance:**
- readBudget.test.ts passes on current main with the recorded numbers and a single `it.fails`-style assertion for eligibleItems overflow
- fairness.test.ts encodes the starvation case as `it.fails` (or todo with exact expectation) so T12 flips it green
- read-budgets.md filled with measured numbers, not estimates

**Invariants:** Tests only seed via t.run and public/internal functions; no schema edits; Fixture sizes are the code's own caps (limits.ts), not arbitrary

**Risks:** convex-test transaction metrics may not be publicly exposed; fall back to documenting throws and timings.

### T08 — P01/P02 UI: sign-up -> verification-code step, sign-in for unverified accounts, forgot-password/reset flow, Settings ale
**Owner:** sonnet-frontend · **Phase:** 1 · **Blocks on:** T05, T06 · **High-risk:** True
**Files:** src/pages/SignIn.tsx, src/pages/Settings.tsx, src/pages/Watching.tsx, src/components/shell/UserCard.tsx

**Contract:**

SignIn.tsx `Flow = "signIn" | "signUp" | "verify" | "reset" | "resetVerify"`. After `signIn("password", { flow: "signUp" | "signIn", email, password })` resolves without `signingIn` (i.e. started), switch to `verify` with an 8-digit code input and submit `{ flow: "email-verification", email, code }`; `reset` submits `{ flow: "reset", email }` and always shows "If that address has an account, a code is on its way"; `resetVerify` submits `{ flow: "reset-verification", email, code, newPassword }`. Error rendering: ConvexError data shown verbatim (they are our fixed strings), any other error -> "Could not sign in. Try again in a minute." Copy line 19 becomes: "Recoup never emails a store without you approving that message. Price alerts to your own verified address are automatic once you turn them on." Settings.tsx: `useQuery(api.alerts.settings)` card: email, Verified/Not verified pill, toggle bound to `api.alerts.setAlerts`, suppressed reason message with `Turn alerts back on` when reason is user_unsubscribed, and help text that verification is required for alerts. Watching.tsx Drops: status map claimed/queued -> "Sending", sent -> "Emailed", unknown -> "Delivery unconfirmed" with a `Check again` button calling api.notify.recheckDrop (disabled when !canRecheck), suppressed -> "Not emailed: <error>", failed -> "Failed: <error>"; providerStatus complained -> "Marked as spam". UserCard: unchanged except sign-out stays.

**Acceptance:**
- Manual walkthrough recorded in the task report against a dev deployment with mocked sender (or the tester's e2e in T20): sign-up shows the code step; wrong code shows the provider error; reset for unknown email shows the neutral message
- Settings toggle round-trips and the Not verified pill appears for the unverified test account
- Watching renders each of the six mailLog statuses from a seeded fixture (storybook-free: assert via a pure `dropChip(status, reason, providerStatus)` helper unit-tested in src? Keep the helper pure and exported)
- Typecheck/lint clean

**Invariants:** No secret or raw provider text rendered; UI never claims an email was sent for queued/unknown rows

**Risks:** Convex Auth client `signIn` return value for started flows must be checked (`{ signingIn: false }`); reset-verification param names per Password.ts.

### T09 — Tester acceptance suite for P01/P02 in separate files: full auth flow tests, alert gate matrix, unsubscribe route, crash
**Owner:** sonnet-tester · **Phase:** 1 · **Blocks on:** T05, T06 · **High-risk:** True
**Files:** convex/auth.test.ts, convex/notify.fault.test.ts, convex/alerts.flow.test.ts

**Contract:**

convex/auth.test.ts (mocked sendAuthMail): signUp -> started + one mail + authVerificationCodes row; duplicate code use fails; expired code (advance 16 min) fails; correct code sets emailVerificationTime; second signUp with existing address and wrong password -> generic error and no mail; reset for unknown -> started, no mail; reset for known -> mail; reset-verification with wrong code fails and password unchanged; rate limit after 10 attempts. convex/notify.fault.test.ts: (a) recordWatchCheck twice for the same price -> one mailLog row; (b) sendDrop invoked twice for the same row -> second returns null and sendMessage called once; (c) setAlerts(false) between claim and sendDrop -> suppressed/opted_out; (d) delete-tombstone between claim and send -> suppressed/deleted; (e) reconcileDrop with provider status pending across all BACKOFF attempts -> unknown, then sweepStalled reschedules and a later sent outcome flips to sent; (f) bounce with message id -> failed; (g) no message id after component sent -> stays queued/unknown never sent; (h) scheduler outage simulation: seed a queued row whose scheduled reconcile never ran (no _scheduled_functions), run sweepStalled -> reconcile scheduled. convex/alerts.flow.test.ts: unsubscribe via t.fetch then claimDrop -> suppressed/opted_out; setAlerts(true) clears user_unsubscribed but not bounced.

**Acceptance:**
- All listed cases are passing tests (no it.todo) except any documented as impossible under convex-test with the reason and the alternative evidence
- Concurrent-attempt cases are expressed as interleavings the harness can order (documented per invariant 6)

**Invariants:** Never calls real AgentMail/OpenAI; Does not edit module-owned test files

**Risks:** Convex Auth under convex-test may require env stubs (JWT_PRIVATE_KEY); coordinate with T05's approach.

### T10 — P03 recoverable market history: explicit state machine, transactional claim before paid lookup, capped retry/backoff, re
**Owner:** sonnet-integrations · **Phase:** 2 · **Blocks on:** T01 · **High-risk:** False
**Files:** convex/market.ts, convex/market.test.ts

**Contract:**

market.ts exports: `requestLookup` internalMutation `{ watchId, trigger: v.union("auto","manual") }` returns `{ scheduled: boolean, state: marketState, reason?: string }` — loads watch; refuse (false) if status archived/bought or owner tombstoned; if `!process.env.SHOPSAVVY_API_KEY` -> patch marketState not_configured (do NOT set marketFetchedAt), return false; if state ∈ {queued, running} -> false/in_flight; if state success and (trigger auto or marketFetchedAt > now - MARKET_REFRESH_MIN_AGE_MS) -> false; if empty_result and trigger auto -> false; if terminal_failure and trigger auto -> false; if retryable_failure and now < marketNextRetryAt -> false; manual: `tryCharge(ctx, userId, "market_lookup")` else false/budget; auto: `tryConsumeGlobalBudget("market_lookup")` else false/budget; then patch `{ marketState: "queued", marketClaimedAt: now }` and schedule `internal.market.lookup` (runAfter 0) in the same transaction. `refresh` public mutation `{ watchId }` -> ownedWatch then requestLookup(manual). `markRunning` internalMutation (queued -> running, else returns false and lookup exits). `lookup` internalAction: markRunning; fetchSnapshot with 30s timeout; classify: ok+points -> success; ok+no product/empty -> empty_result; 401/403/400 -> terminal_failure; 429/5xx/timeout/network -> retryable_failure (attempts+1, nextRetryAt = now + MARKET_RETRY_BACKOFF_MS[attempts-1]; attempts >= MARKET_MAX_ATTEMPTS -> terminal_failure); always call `recordSnapshot` with the outcome. `recordSnapshot` internalMutation `{ watchId, outcome: marketState, points, stores, note?: string }`: re-reads watch; if missing, archived, bought, or marketState !== running -> no writes, return { skipped: true }; writes points/stores (dedupe by marketKey and storeDomain, enforce MAX_OFFERS_PER_WATCH, own store excluded by registrableHost); patches `{ marketState: outcome, marketFetchedAt: now, marketObservedAt: max(points.observedAt), marketNote: NOTE[outcome], marketAttempts, marketNextRetryAt }` where NOTE is a fixed map (not_configured: "Market history is not configured on this deployment", empty_result: "ShopSavvy has no price history for this product", retryable_failure: "Could not read market history; we will try again", terminal_failure: "Market history is unavailable for this product"); raw provider errors only in console via lib/log (T22) never in marketNote. `migrateStamps` internalMutation `{ cursor?: string }` pages 100 watches with marketFetchedAt set and marketState undefined: marketPrices rows exist -> success; note == old empty string -> empty_result; note == old not-configured string -> not_configured and clear marketFetchedAt; note startsWith "Could not read" -> retryable_failure attempts 1 nextRetryAt now; returns next cursor; idempotent. Remove `watchForMarket`'s marketFetchedAt gate (state gate replaces it). Keep the module invariant: never opens a claim, never sends an alert.

**Acceptance:**
- convex/market.test.ts: missing key -> not_configured with no budget spend and no marketFetchedAt; then key set + refresh -> success; 429 then success within backoff; 3 retryable failures -> terminal_failure; empty body -> empty_result and auto trigger does not re-request; two requestLookup calls before lookup runs -> exactly one scheduled job and one fetch; refresh by non-owner throws; refresh on bought/archived refused; archive between markRunning and recordSnapshot -> no writes; migrateStamps classifies all four legacy shapes and is idempotent; success refresh before 7 days refused, after 7 days allowed and charged
- watches.test.ts existing market assertion still passes after T12 rewires the caller

**Invariants:** Two simultaneous requests consume at most one paid lookup (claim in the same transaction as the schedule); marketFetchedAt = retrieval time; marketObservedAt = provider observation time; source label stays shopsavvy

**Risks:** watches.ts still calls internal.market.lookup directly until T12 swaps it to requestLookup; keep `lookup` tolerant of marketState undefined (treat as queued) for that window.

### T11 — P05 dashboard accounting: status-indexed reads instead of take-then-filter, canonical bought/check counting across watch
**Owner:** sonnet-backend · **Phase:** 2 · **Blocks on:** T01 · **High-risk:** False
**Files:** convex/insights.ts, convex/insights.test.ts

**Contract:**

insights.ts: `userWatches` -> existing `liveWatches` (by_user_status active/paused/bought, take MAX_WATCHES per status); `userPurchases` -> `by_user_status [userId, "active"]` take MAX_PURCHASES. Canonical counting rule (exported constant comment): a watch with `purchaseId` set contributes nothing to sources/activity (its checks and drops are represented by the purchase item that carries them) — implemented as `if (watch.purchaseId) continue` in sources and activity. Offers per watch via `confirmedOffers(ctx, watchId)` (already imported) — remove the unordered take(20). Currency: `tally()` and the offers loop compare cents only when currencies match; `sourceRow` replaces `bestCents/bestSubject/currency` with `bests: v.array(v.object({ currency: v.string(), cents: v.number(), subject: v.string() }))` (one entry per currency, min per currency). `sources` returns `{ rows, truncated: boolean }` where truncated is true when any status page hit MAX_WATCHES or purchases hit MAX_PURCHASES or a product hit CHECKS_PER_PRODUCT; `activity` returns `{ events, truncated }` (events unchanged shape, price_drop emitted once per check id); add `windowNote: "recent activity (last 12 checks per item)"` string constant exported for the UI. priceHistory/trackedTable unchanged except they pass through the new `truncated` flag. Remove the `.collect()` of items in activity/sources in favour of `.take(MAX_ITEMS_PER_PURCHASE)`.

**Acceptance:**
- insights.test.ts: 1 active watch + 45 newer archived -> present in sources and activity; same for purchases; markBought -> bought 1, checks/drops not doubled, activity has one price_drop per check; confirmed offer behind 25 rejected rows appears; EUR and USD on one domain yield two bests entries and no cross-currency min; 45 active watches -> watching 40 and truncated true; empty account renders empty rows with truncated false
- Board.tsx/SourcesCard.tsx typecheck after the shape change (T14 updates rendering; until then the frontend compiles because unused fields are removed only in T14 — coordinate: keep `bestCents` optional-undefined for one wave if SourcesCard references it; grep confirms it does not)

**Invariants:** No money summed across currencies; Sampled windows are flagged, never presented as totals

**Risks:** Shape change of sourceRow; confirm no src/ reference to bestCents (report says none).

### T12 — P06 freshness and P07 fairness in the backend: remove wall-clock reads from reactive queries (raw timestamps + bounded c
**Owner:** sonnet-backend · **Phase:** 2 · **Blocks on:** T04, T10, T11 · **High-risk:** False
**Files:** convex/watches.ts, convex/watches.test.ts, convex/priceWatch.ts, convex/priceWatch.test.ts, convex/tracking.ts, convex/tracking.test.ts, convex/budget.ts, convex/budget.test.ts, convex/lib/budget.ts, convex/crons.ts

**Contract:**

watches.ts: `list`/`get` add `args.now: v.optional(v.number())` validated with assertTimestamp; clients pass `Math.floor(Date.now()/300_000)*300_000` (T14); server uses `const now = args.now ?? latestObservedAt(checks) ?? undefined`; `now` is used only for verdict/display, never for eligibility. `watchSummary` adds `lastObservedAt: v.optional(v.number())` (from watch.lastObservedAt), `priceStale: v.boolean()` (lastObservedAt missing or older than STALE_PRICE_MS), `checkRequestedAt: v.optional(v.number())` raw (replaces `checking`; client computes), `targetHit` requires !priceStale; verdict receives `priceObservedAt: lastObservedAt`. `recordWatchCheck` sets `lastObservedAt = now` only when observedCents accepted; the market trigger calls `internal.market.requestLookup({ watchId, trigger: "auto" })` via ctx.runMutation-free direct scheduling (it is a mutation calling a mutation helper: export `requestLookupInTx(ctx, watchId, trigger)` from market.ts is integrations' file — instead schedule `ctx.scheduler.runAfter(0, internal.market.requestLookup, ...)`). `sweep`: page WATCH_SWEEP_PAGE from by_status_nextCheck, group by userId, take at most WATCH_SWEEP_PER_USER per user, bump nextCheckAt for scheduled rows, and skip tombstoned users; `watchForCheck` returns null for tombstoned owners. priceWatch.ts: `eligibleItems` reads `items.by_nextCheck` ascending (undefined first) take SCAN_LIMIT, skips tombstoned owners, uses `claims.by_item_kind_status` for the open-claim check (no collect), returns items grouped by user with at most PRICE_CHECK_PER_USER_PER_TICK each; `runAll` patches `items.nextCheckAt = now + WATCH_CHECK_INTERVAL_MS` for every scheduled item (rotation) and `now + WATCH_SWEEP_BUMP_MS` for skipped-due-to-budget items; fix stale 6h comments to 2h. tracking.ts `overview` adds `args.now` the same way. budget.ts: new public query `status` returns `{ day, kinds: [{ kind, userUsed, userMax, globalUsed, globalMax, paused: boolean }] }` for the signed-in user (paused = globalUsed >= globalMax). crons.ts: no new cron here (retention cron lands in T16).

**Acceptance:**
- watches.test.ts: list/get with an explicit `now` 60 days after the last accepted check and a recent failed check -> priceStale true, verdict.label unknown with age reason, targetHit false, lastObservedAt = day 8, lastCheckedAt = day 68; `now` older than lastObservedAt ignored for authorization (checkNow still enforces its own clock); checking derived client-side so summary exposes checkRequestedAt
- fairness.test.ts (T07) starvation cases flip green: user A's older item is checked on tick 1 when user B has 50 newer items; sweep rotation across two users
- readBudget.test.ts overflow case flips green: 500 items with 65 claims each -> eligibleItems under the 32k limit
- priceWatch.test.ts: nextCheckAt bumped for scheduled and budget-skipped items; tombstoned user's items never scheduled
- budget.test.ts: status reports paused when the global row is at max

**Invariants:** Mutation-side eligibility (checkNow, sweep, runAll, claimDrop) uses its own Date.now(); the query `now` argument never affects quota, money or authorization; Invariant 14: at most one open price-adjustment claim per item; dedupe unchanged

**Risks:** items.by_nextCheck with undefined values: confirm Convex index ordering puts missing fields first; otherwise backfill lazily in runAll.

### T13 — Offers freshness (raw timestamps instead of nulled leases), P04 leftovers in market/offers ingestion (own-store exclusio
**Owner:** sonnet-integrations · **Phase:** 2 · **Blocks on:** T10 · **High-risk:** False
**Files:** convex/offers.ts, convex/offers.test.ts, convex/lib/offerMatch.ts, convex/lib/offerMatch.test.ts, convex/market.ts, convex/market.test.ts

**Contract:**

offers.ts `listForWatch`: remove Date.now(); return `searchingUntil: v.optional(v.number())` (marker _creationTime + SEARCH_PENDING_MS) and `nextFindAt: v.optional(v.number())` raw (never nulled); `find` keeps its own clock. `appendOfferCheck` gains `source: priceSource` param; `offers.confirm` on a shopsavvy candidate records the check with source shopsavvy and `observedAt` = the provider observation time; insights/dashboard consumers (T14) label source. market.ts `recordSnapshot`: `ownDomain = registrableHost(hostOf(watch.productUrl))` compared with `cleanStoreUrl().storeDomain`; stores with availability false excluded; enforce MAX_OFFERS_PER_WATCH using the by_watch count (take MAX+1); dedupe set built from all rows by_watch (take WATCH_ROWS) not 24. Delete `marketStats` if unused. offerMatch.ts: export `registrableHost` already; add `sameStore(a, b)` helper used by both paths.

**Acceptance:**
- offers.test.ts: listForWatch returns raw nextFindAt after cooldown expiry (no null), searchingUntil set while marker is fresh; confirm on shopsavvy candidate writes offerChecks.source shopsavvy
- market.test.ts: subdomain-hosted own store not inserted as another store; out-of-stock store excluded; 30 existing rows + new store -> not inserted beyond cap; rejected store not re-added as a second candidate row
- Existing offers tests unchanged

**Invariants:** User decisions (rejected/confirmed) survive any re-ingestion; ShopSavvy prices are never presented as Recoup reads (source label persisted)

**Risks:** offerChecks.source field: confirm the schema already has priceSource on offerChecks; if not, it is an optional addition T01 must include (pre-declared here: `offerChecks.source?: priceSource`).

### T14 — P05/P06 UI: dashboard truncation labels and per-currency bests, WatchCard price-as-of and stale qualification, client-co
**Owner:** sonnet-frontend · **Phase:** 2 · **Blocks on:** T11, T12, T13 · **High-risk:** False
**Files:** src/pages/Watching.tsx, src/pages/Board.tsx, src/components/watching/WatchCard.tsx, src/components/watching/StoreCompare.tsx, src/components/watching/MarketHistory.tsx, src/components/dashboard/SourcesCard.tsx, src/components/dashboard/StatCards.tsx, src/components/dashboard/PriceHistoryCard.tsx, src/components/dashboard/TrackedTable.tsx, src/components/dashboard/ActivityTimeline.tsx, src/lib/ui.ts, src/components/BudgetBanner.tsx

**Contract:**

src/lib/ui.ts adds `useCoarseNow(stepMs = 300_000)` returning `Math.floor(now/step)*step` from useNow; Watching/Board pass `{ now }` to api.watches.list/get and api.tracking.overview. WatchCard: `checking = checkRequestedAt > (lastCheckedAt ?? 0) && now - checkRequestedAt < WATCH_CHECK_COOLDOWN_MS` computed with useNow; shows "Price as of <ago(lastObservedAt)>" beside the price and "Last check <ago(lastCheckedAt)> (failed: note)" separately; when priceStale renders the price muted with "Price may be out of date" and hides the target-hit panel. StoreCompare: `canFind = !searching && (nextFindAt === undefined || nextFindAt <= now)` from raw fields; own-store row shows both timestamps. MarketHistory: copy per marketState (not_configured/queued/running/empty_result/retryable_failure/terminal_failure) and a `Refresh` button calling api.market.refresh when state ∈ {retryable_failure, terminal_failure, empty_result, success older than 7d}; shows "via ShopSavvy" and observed-vs-fetched dates. SourcesCard: render `bests` per currency with Money; when `truncated` show "Recent activity; older items not counted"; StatCards: alert count from deduped events; PriceHistoryCard/TrackedTable: source badge for shopsavvy points. BudgetBanner: useQuery(api.budget.status); when any kind paused show "Automatic <kind> are paused for today; they resume at midnight UTC"; mounted in Watching and Board.

**Acceptance:**
- Typecheck/lint clean; `npm run build` chunk sizes not regressed
- Pure helpers (`checkingFrom`, `canFindFrom`, `priceAsOfLabel`, `marketCopy`) exported and unit-tested with vitest in src/lib/*.test.ts (add `src/**/*.test.ts` to vitest include ONLY via T17's config change; until then colocate tests under convex/lib as pure TS if needed)
- Screenshot walkthrough in the task report: stale watch, paused budget, not_configured market

**Invariants:** Client clock is presentation only; No fabricated totals: truncated rows are labelled

**Risks:** Coordinate vitest include change with T17; until then keep UI helper tests as pure functions under convex/lib/uiHelpers.test.ts or skip.

### T15 — Cross-module regression tests for Phase 2 slices in tester-owned files: freshness across watches/offers/insights/trackin
**Owner:** sonnet-tester · **Phase:** 2 · **Blocks on:** T12, T13, T14 · **High-risk:** False
**Files:** convex/freshness.test.ts, convex/dashboard.test.ts, convex/marketFlow.test.ts, docs/reviews/read-budgets.md

**Contract:**

freshness.test.ts: seed 3 accepted checks, then 60 failed checks via recordWatchCheck; assert watches.get(now=+5d) priceStale true, verdict unknown, insights.trackedTable lowest not from stale price (or flagged), tracking.overview lastCheckedAt vs latest priced point separated, notify.claimDrop still only fires on accepted observations. marketFlow.test.ts: no key -> watch check -> not_configured -> set key -> next accepted check auto-requests once -> lookup success -> MarketHistory data via watches.get shows marketObservedAt <= marketFetchedAt. dashboard.test.ts: heavy account from T07 fixture -> sources/activity truncated flags true, bought counted once after markBought, budget.status paused after global exhaustion. Update read-budgets.md with post-fix numbers.

**Acceptance:**
- All cases pass; read-budgets.md shows before/after for eligibleItems and insights.activity
- No test exceeds 32k documents under transactionLimits

**Invariants:** Tester files only

**Risks:** Fixture sizes; keep under harness limits.

### T12.2 — Phase 2 acceptance blockers (D107 C1, C3, C5, C6)
**Owner:** sonnet-backend-2 · **Phase:** 2 (fix) · **Blocks on:** D107 · **High-risk:** True · **Status:** verified (07242b1; lead re-ran 6 files 143/143; 60×50×12 = 266 ranges / 3,310 docs; purchases.ts call sites landed directly)
**Files:** convex/tracking.ts, convex/priceWatch.ts, convex/policies.ts, convex/market.ts, convex/lib/schedule.ts (+tests); purchases.ts call sites only after T16 commits (else handoff note under docs/team/handoffs/).

**Contract:** see D107 rows C1, C3, C5, C6 (verbatim routing). Acceptance: 6×1 → 6 purchases, `truncated:false`; 60×50×12 `< 4096` ranges and `< 32,000` docs; resurrection paths scheduled within 2 ticks behind 500 rotating items; needs_review no-link items get a transient stamp; retries charge global only; manual refresh from terminal resets attempts.

### T14.2 — Frontend adoption of D103/D107 shapes (C4)
**Owner:** sonnet-frontend · **Phase:** 2 (fix) · **Blocks on:** T12.2 landing · **High-risk:** False · **Status:** verified (3f0171d; lead re-ran src/lib 27/27; residual: `onTable` sum still picks one display currency — register F-T14-1 LOW)
**Files:** src/components/dashboard/StatCards.tsx, src/pages/Purchase.tsx (+ any src/lib helper), tests under src/lib.

**Contract:** `StatCards` renders `totals.byCurrency` (one line per currency, `primaryCurrency` first) instead of formatting the scoped `recoveredCents` with a guessed currency; `Purchase.tsx` passes `useCoarseNow()` as `now` to `purchases.get` so verdict staleness is real. Typecheck/lint clean; a `src/lib` unit test for the byCurrency formatter.

### T16.1 — Checkpoint 6a MEDIUMs (D112 6a-1, 6a-2)
**Owner:** sonnet-backend-2 · **Phase:** 3 (fix) · **Status:** verified (d18f209, a2eb2ec; lead re-ran 6 files 130/130; SHA-256 via crypto.subtle; dual legacy-key lookup landed)
**Files:** convex/lib/idempotency.ts (+test, new), convex/claims.ts, convex/replies.ts, convex/intake.ts (+tests), convex/inbound.ts (+test), convex/limits.ts, convex/lib/rateLimits.ts. Contract: D112 rows 6a-1 and 6a-2 verbatim.

### T12.3 — Checkpoint 6a C3 test strength and LOW wiring gaps (D112 6a-3..6)
**Owner:** sonnet-backend-3 · **Phase:** 3 (fix) · **Status:** verified (10f9abf..c7e308c; lead re-ran 4 files 106/106; neutered-helper proof: all 4 resurrection tests fail with no-op helpers)
**Files:** convex/priceWatch.test.ts, convex/purchases.ts (+test), convex/policies.ts (+test), convex/lib/schedule.ts (+test). Contract: D112 rows 6a-3..6a-6 verbatim.

### T24b — Backend register items + structured-log sweep
**Owner:** sonnet-backend-2 · **Phase:** 4 (fix) · **Status:** in_progress
**Files:** convex/http.ts (+http.test.ts), convex/limits.ts, convex/ops.ts (+ops.test.ts), convex/insights.ts (+freshness.test.ts flip only), package.json (script only), docs/ops/RUNBOOK.md (two lines), and the `console.error` → `logEvent` sweep in notify.ts, priceWatch.ts, watches.ts, offers.ts, policies.ts, market.ts, inbound.ts. Contract: F-T22-1/2/3, F-T15-1, D112 RUNBOOK/ops lines, D109 sweep.

### T18.1 — Checkpoint 6b: export IDOR/termination, byte-aware pages, sign-in gate, purge re-drive, test strength (D115 6b-1/2/4/6/8)
**Owner:** sonnet-backend · **Status:** in_progress · **Files:** convex/account.ts, account.test.ts, auth.ts (+auth tests), crons.ts, limits.ts, lib/accountState.ts.

### T18.2 — Checkpoint 6b: tombstone gates on write lanes (D115 6b-3 writers, 6b-7)
**Owner:** sonnet-integrations · **Status:** pending (after T24b releases its files) · **Files:** convex/inbound.ts, replies.ts, intake.ts, profiles.ts, drafts.ts, policies.ts (+tests).

### T18.3 — Checkpoint 6b: tombstone-aware reads (D115 6b-3 readers) + console.error sweep (T24c)
**Owner:** sonnet-backend-3 · **Status:** pending (after T18.2) · **Files:** insights.ts, watches.ts, tracking.ts, notify.ts, offers.ts, profiles.ts reads; sweep in notify/priceWatch/watches/offers/policies/market/inbound.

### T18.4 — Checkpoint 6b: AgentMail component data purge (D115 6b-5)
**Owner:** sonnet-backend-3 · **Status:** in_progress · **Files:** patches/@agentmail+convex+0.1.0.patch, convex/mailPurge.ts (+test); call site wired by T18.1/lead.

### T16 — P07 retention (bounded, resumable, audit-preserving) plus P08 backend fixes: returns validators and string bounds on cla
**Owner:** sonnet-backend · **Phase:** 2 · **Blocks on:** T12 · **High-risk:** True
**Files:** convex/retention.ts, convex/retention.test.ts, convex/claims.ts, convex/claims.test.ts, convex/purchases.ts, convex/purchases.test.ts, convex/intake.ts, convex/intake.test.ts, convex/replies.ts, convex/replies.test.ts, convex/profiles.ts, convex/profiles.test.ts, convex/crons.ts, convex/lib/errors.ts

**Contract:**

retention.ts `sweep` internalMutation `{ }`: reads opsState key "retention" cursor `{ table, cursor }`; processes RETENTION_PAGE docs per run for one table then advances: processedEvents (status succeeded/failed/ignored older than RETENTION_PAYLOAD_DAYS -> patch payload undefined; row kept), mailLog (sent/failed/suppressed older than RETENTION_MAILLOG_DAYS -> delete), watchChecks/priceChecks/offerChecks (older than RETENTION_OBSERVATION_DAYS and not among the newest RETENTION_KEEP_NEWEST per parent -> delete), marketPrices (older than 400 days -> delete). NEVER touches ledgerEvents, claims, claimNotes, drafts, replies, purchases, items, policies, followUps, usage. Stores the next cursor in opsState; wraps to the first table when done; returns `{ table, deleted, patched, done }`. crons.ts adds `crons.interval("retention", { hours: 6 }, internal.retention.sweep, {})`. claims.ts: `returns:` validators on all 7 public functions (claims.get returns projection excluding draft bodies beyond 20_000 chars? no — keep bodies, but validate shape); bounds: `evidence` <= 500, `idempotencyKey` 1..128, `reason` <= 500 via shared `assertText(name, value, max)` in lib/errors.ts or lib/text.ts; `purchases.ts` returns validators on setReturned/get/board. intake.ts `needsAttention`: attentionRow drops `lastError`, adds `errorSummary: sanitizeError(lastError)`; `processEvent` and replies.classify call `tryConsumeGlobalBudget("inbound_extract")` before extract(); on refusal set status needs_review with summary "Paused: daily extraction budget reached; will retry" and let retryFailed pick it up next hour. profiles.ensureInbox: `rateLimiter.limit(ctx, "inboxProvision", { key: userId, throws: true })` before the remote create; `save` remains idempotent.

**Acceptance:**
- retention.test.ts: payload cleared only for terminal rows older than 30d; newest 30 checks per parent survive; ledger/claims untouched; cursor resumes across runs; a run never exceeds RETENTION_PAGE writes
- claims.test.ts: oversized evidence/reason/key rejected with ConvexError; returns validators pass for every existing test
- intake.test.ts: needsAttention rows have errorSummary and no lastError; 501st inbound extraction in a day -> needs_review without OpenAI call; replies.classify same
- profiles.test.ts: second ensureInbox within 5 minutes throws rate limit without a second remote call
- T02 boundary.test.ts expectations updated to the new bounds

**Invariants:** Ledger history append-only and never purged; Invariant 10: budget refusal is needs_review (retryable), never failed/dropped

**Risks:** Deleting priceChecks older than 180 days while keeping newest 30 must not remove observations referenced by open claims (priceCheckId): skip any check referenced by a claim (query claims.by_item and exclude referenced ids).

### T17 — P11 reproducible installation and CI: pinned Node, GitHub Actions workflow with npm ci, patch verification, typecheck, l
**Owner:** sonnet-verifier · **Phase:** 3 · **Blocks on:** T01, T03 · **High-risk:** False
**Files:** .github/workflows/ci.yml, .nvmrc, package.json, package-lock.json, scripts/check-patch.mjs, scripts/check-test-count.mjs, vitest.config.mts, playwright.config.ts, docs/ops/INSTALL.md

**Contract:**

.nvmrc = `22`; package.json `engines.node: ">=22 <23"`, `test: "vitest run"`, `test:ci: "vitest run --reporter=json --outputFile=.vitest/results.json && node scripts/check-test-count.mjs 600"`, `postinstall: "patch-package --error-on-fail"`, `@agentmail/convex` pinned exactly `0.1.0`, `@auth/core` resolved to 0.41.3 in the lockfile (npm update within ^0.41.1; record triage: not reachable via Password-only config), devDependencies `@playwright/test` and `@axe-core/playwright` (exact pins). scripts/check-patch.mjs: exits 1 unless node_modules/@agentmail/convex/dist/component/convex.config.js contains `AGENTMAIL_API_KEY`. scripts/check-test-count.mjs: exits 1 if numTotalTests < argv. vitest.config.mts include adds `src/**/*.test.ts` (environment jsdom not required: keep pure-function tests). ci.yml jobs: `checks` (ubuntu, actions/setup-node with node-version-file .nvmrc, cache npm; `npm ci`; `node scripts/check-patch.mjs`; `npx convex codegen` then `git diff --exit-code convex/_generated` (if codegen needs a deployment, use `npx convex codegen --init`-free mode documented in INSTALL.md and fall back to `git diff --exit-code` after `npx convex codegen --dry-run`); `npm run typecheck`; `npm run lint -- --deny-warnings`; `npm run test:ci`; `npm run build`; upload dist size summary) and `browser` job (needs checks; `npx playwright install --with-deps chromium`; runs `npx playwright test` only when secrets `E2E_CONVEX_URL`/`E2E_DEPLOY_KEY` exist, else prints a skipped notice; uploads playwright-report and traces as artifacts). No secrets echoed; `env` values never printed. playwright.config.ts scaffold (projects desktop-chromium and mobile-chromium, trace on-first-retry, screenshot only-on-failure, baseURL from E2E_BASE_URL) that T20 fills. docs/ops/INSTALL.md: supported install mode = full `npm ci` with scripts; `--omit=dev` and `--ignore-scripts` unsupported and why.

**Acceptance:**
- A clean `git worktree` + `npm ci` runs every gate green locally; `npm test` without tests in include fails (verified by temporarily pointing include at an empty glob)
- check-patch.mjs fails on an unpatched node_modules copy
- npm audit --omit=dev reports 0 critical after the bump; triage note in INSTALL.md
- lint exits non-zero on a warning (passage.ts and Money.tsx fixed by T01/T03)
- ci.yml validated with `act` or a dry run documented; no `--passWithNoTests` anywhere

**Invariants:** No credentials in logs/artifacts; CI never prints env; Patch stays version-bound: exact pin

**Risks:** `npx convex codegen` may require a linked deployment; document the fallback precisely rather than skipping the check.

### T18 — P09 backend: authenticated paged data export, explicit account-deletion flow with confirmation, session revocation, tomb
**Owner:** sonnet-backend · **Phase:** 3 · **Blocks on:** T16 · **High-risk:** True
**Files:** convex/account.ts, convex/account.test.ts, convex/lib/accountState.ts

**Contract:**

account.ts: `exportPage` query `{ table: v.union(literals for purchases, items, claims, ledgerEvents, claimNotes, drafts, replies, followUps, policies, priceChecks, watches, watchChecks, offers, offerChecks, marketPrices, mailLog, processedEvents, alertSettings, profiles), cursor: v.optional(v.string()) }` returns `{ rows: v.array(v.any()), cursor: v.union(v.string(), v.null()) }` using `.withIndex(by_user...).paginate({ numItems: 200 })`, projecting out `payload` raw bodies over 60 KB? (keep payload; it is the user's own mail) and never returning other users' rows (every table is read through a userId index; tables without by_user — ledgerEvents, claimNotes, drafts, replies, followUps, watchChecks, offerChecks, marketPrices — are exported by iterating the user's parent ids in pages). `requestDeletion({ confirmation: v.string() })` mutation: requireUserId; confirmation must equal "delete my account"; upsert accountState `{ status: "deleting", requestedAt: now, attempts: 0 }`; revoke sessions via the library helper (`invalidateSessions(ctx, { userId })` from @convex-dev/auth/server — implementer confirms the export name); schedule `internal.account.purge` runAfter 0; returns null. `purge` internalAction: loops `ctx.runMutation(internal.account.purgeStep, { userId })` until `{ done: true }`; then deletes the AgentMail inbox (component method if exposed, else REST DELETE /inboxes/{id} mirroring createInboxRemote, never echoing bodies); on provider failure: attempts++ with sanitized lastError, reschedule with backoff [1m, 10m, 1h, 6h, 24h], after 5 attempts leave status deleting with inboxDeleted false (truthful) and stop; on success `purgeAuth` then patch accountState status deleted, completedAt. `purgeStep` internalMutation: deletes up to RETENTION_PAGE docs from one table in this order: followUps, claimNotes, drafts, replies, ledgerEvents, claims, priceChecks, items, purchases, policies, offerChecks, offers, marketPrices, watchChecks, watches, mailLog, usage (userId rows), alertSettings, processedEvents (by_user_status all statuses), profiles; stores progress in accountState.progress; returns `{ done }`. `purgeAuth` internalMutation deletes authSessions/authRefreshTokens/authAccounts/authVerificationCodes rows for the user then the users row; accountState row remains as tombstone. `deletionStatus` query (works while deleting for a still-authenticated tab) returns `{ status, inboxDeleted, attempts }`. All cron/scheduled readers already skip tombstoned users (T06/T10/T12).

**Acceptance:**
- account.test.ts: export returns only user A's rows for every table (user B seeded); cursor paging covers > 200 rows; wrong confirmation throws; requestDeletion tombstones and purge removes every owned row across tables, keeps accountState deleted; provider inbox failure -> status stays deleting, attempts 1, retry scheduled, no false 'deleted'; a claimDrop/watch check/priceWatch/market request for the tombstoned user does nothing; a second requestDeletion is a no-op
- Sessions invalidated: isAuthenticated false after deletion in test (or documented if convex-test cannot exercise)

**Invariants:** Deletion cannot target another user (userId only from ctx.auth); No scheduled job resurrects records (all readers check accountState); Provider failure never reports all data removed

**Risks:** Auth table names/fields for session revocation must be read from @convex-dev/auth types; purge order must delete children before parents to keep partial states consistent.

### T19 — P09 UI: Settings export (paged fetch to a JSON download), account deletion with typed confirmation and post-deletion sig
**Owner:** sonnet-frontend · **Phase:** 3 · **Blocks on:** T18 · **High-risk:** True
**Files:** src/pages/Settings.tsx, src/pages/Privacy.tsx, src/App.tsx, src/pages/SignIn.tsx, src/components/shell/UserCard.tsx

**Contract:**

Settings: `Export my data` button iterates api.account.exportPage over every table with cursor until null, assembles `{ exportedAt, tables: {...} }`, triggers a Blob download `recoup-export-<date>.json` (app context, not artifact). `Delete account` section: explains what is removed now, what is retained (tombstone only, provider inbox deletion may take time, emails already sent to stores cannot be recalled), a text input that must equal "delete my account", then api.account.requestDeletion, then signOut() and navigate to /signin with a static confirmation. Privacy.tsx (route /privacy, public, added in App.tsx outside the auth gate): sections Providers (Convex, OpenAI, Firecrawl, AgentMail, ShopSavvy — what each receives), Retention (values from limits.ts mirrored as constants with a note), Alerts & consent, Export/deletion, Contact (env-free: repository issues link or a placeholder the lead fills), Limitations (no legal certification claims). Links from SignIn footer and Settings.

**Acceptance:**
- Typecheck/lint clean; e2e (T20) covers export button and deletion flow against the disposable deployment
- Privacy page reachable signed-out; no fabricated certifications

**Invariants:** No private content uploaded to telemetry; no analytics added

**Risks:** Large exports in-browser memory; page size 200 keeps it bounded.

### T20 — P10 browser acceptance suite (Playwright) against a disposable Convex dev deployment with controlled fixtures and mocked
**Owner:** sonnet-tester · **Phase:** 3 · **Blocks on:** T08, T14, T17, T19 · **High-risk:** True
**Files:** e2e/auth.spec.ts, e2e/watches.spec.ts, e2e/purchases.spec.ts, e2e/claims.spec.ts, e2e/resilience.spec.ts, e2e/isolation.spec.ts, e2e/fixtures.ts, e2e/README.md, convex/testing.ts, convex/testing.test.ts

**Contract:**

convex/testing.ts (internal mutations only, every handler first asserts `process.env.E2E_SEED_ENABLED === "true"` else throws): `seedUser({ email, verified: boolean })` creates users/authAccounts rows with a known password hash via the provider's Scrypt (or documents using the real signUp flow with a code-capture mutation `latestCode({ email })` that returns the pending authVerificationCodes code for the e2e user), `seedWatch`, `seedPurchaseWithClaim`, `seedDropRow({ status })`, `setProviderMode({ mode: "mock" | "fail" })` stored in opsState and honoured by priceWatch/offers/market/notify through an existing injectable deps seam (mock scrape returns a fixed price). e2e/fixtures.ts runs seeds via `npx convex run testing:seedUser` (CONVEX_DEPLOY_KEY from env, never logged) or via a ConvexHttpClient admin call. Specs: auth (sign-up, code entry using latestCode, sign-in, logout, reset), direct-route refresh on /watching and /purchases/:id, watch create/check-now/pause/resume, convert to purchase, policy review confirm, draft edit + approve (recipient confirm) with mocked send, ledger confirm credit, unknown ids (/purchases/abc, other user's claim) show ErrorBox not blank, provider failure mode shows retryable state, two-user isolation (user B cannot open A's claim URL), offline banner (context.setOffline), keyboard completion of watch create and draft approve, axe scan with no serious violations on Board/Watching/Claim/Settings/SignIn. Projects: desktop chromium 1280x800 and mobile Pixel 5. trace on-first-retry, screenshot on failure, video off.

**Acceptance:**
- `npx playwright test` green against E2E_BASE_URL with the seeds; report and traces uploaded by CI on failure
- Each listed flow has a spec; skipped flows documented with reason
- axe: zero serious/critical violations on the five pages
- Provider smoke (real AgentMail/Firecrawl) lives in a separate `e2e/smoke/*.smoke.ts` tag not run in CI

**Invariants:** Seeds refuse to run unless E2E_SEED_ENABLED=true; never deploy testing.ts seeds enabled to production; No real provider calls in CI

**Risks:** Needs a disposable deployment the user authorizes (scope question); the mock-provider seam must exist in priceWatch/offers/market (they already take injectable deps in tests; expose an env-gated mock).

### T21 — P09 and P08 cross-user tests in tester files: export/deletion isolation, deletion vs scheduled work, webhook after delet
**Owner:** sonnet-tester · **Phase:** 3 · **Blocks on:** T18 · **High-risk:** True
**Files:** convex/lifecycle.test.ts, docs/reviews/endpoint-inventory.md

**Contract:**

lifecycle.test.ts: user B cannot export/delete A; after A requests deletion: inbound webhook for A's inbox routes to ignored, claimDrop suppressed/deleted, sweep/runAll skip A, market.refresh refused, drafts.approveAndSend refused (requireUserId fails after purgeAuth), followUps.fire no-op; purge resumability: interrupt after N steps then rerun purge completes. Inventory refresh: every public function now lists returns validator presence, bound sizes, spend kind.

**Acceptance:**
- All cases pass; inventory has no unexplained public mutator and lists the testing.ts seeds as internal/env-gated

**Invariants:** Tester files only

**Risks:** None beyond harness limits.

### T22 — P12 operations and docs: structured redacted failure logging with correlation ids, operator pause switch, smoke script, 
**Owner:** sonnet-verifier · **Phase:** 3 · **Blocks on:** T12, T13, T16 · **High-risk:** False
**Files:** convex/lib/log.ts, convex/lib/log.test.ts, convex/ops.ts, convex/ops.test.ts, scripts/smoke.mjs, README.md, hackathon.md, docs/ops/RUNBOOK.md, docs/ops/ENVIRONMENT.md, docs/ops/RELEASE.md, docs/ops/RETENTION.md, convex/notify.ts, convex/priceWatch.ts, convex/watches.ts, convex/offers.ts, convex/policies.ts, convex/market.ts, convex/inbound.ts

**Contract:**

lib/log.ts: `logFailure(event: { kind: "extract"|"notify"|"price_check"|"budget"|"callback"|"scheduler"|"market"|"policy"|"offers"|"webhook"|"deletion", id: string, correlationId?: string, err?: unknown, detail?: Record<string, string|number|boolean> })` -> single `console.error(JSON.stringify({ level: "error", ...event, message: redact(String(err?.message ?? err)) }))` where `redact` masks `Bearer …`, `sk-…`, `fc-…`, `whsec_…`, emails (keeps domain) and truncates to 500 chars; `correlationId` = processedEvents.externalId for inbound work, mailLogId/outboundId for mail, watchId/itemId for checks. Replace every console.error in the listed files with logFailure (only those lines; wave-exclusive edit rights). `logBudgetExhausted(kind, scope)` called from lib/budget try* refusals (backend file; the call is added by T22 in the wave, backend idle). ops.ts: `pauseKind` internalMutation `{ kind: v.string(), day?: v.string() }` sets the global usage row to its max (documented as the operator kill switch, dashboard-runnable), `resumeKind` resets it, `status` internalQuery mirrors budget.status globally plus counts of mailLog unknown/queued older than 1h and processedEvents needs_review (bounded takes). scripts/smoke.mjs: `SMOKE_BASE_URL` -> asserts `/` 200 html, `/watching` 200 html (SPA), `/.well-known/openid-configuration` 200 json, unsigned POST `/agentmail/webhook` 401, `/alerts/unsubscribe?token=x` 200, bundle contains no `sk-|fc-|whsec_|CONVEX_DEPLOY_KEY`; prints a table, exit 1 on any failure. README: env table adds SHOPSAVVY_API_KEY (optional), ALERTS_INBOX_ID (required for alerts and auth mail), APP_URL (optional), AGENTMAIL_BASE_URL (optional), OPENAI model constant location; fix line 16 vs 79-80, cron cadence 2h, decisions range D01-D6x, deploy commands and order (backend `npx convex deploy` then `npm run deploy` static), supported install mode. hackathon.md: cadence and live-status lines. RUNBOOK.md: pause/resume procedures, stalled mail, needs_review queue, deletion retries, Convex export/import backup and isolated restore steps, migration policy (additive schema only; run migrateStamps after deploy), rollback limits (schema/data/emails), security headers (nosniff only from static-hosting; CSP not available). ENVIRONMENT.md: required/optional per feature with fail-closed behaviour; production vs dev deployment identity recorded as names without values. RELEASE.md: manifest template (backend commit, frontend build hash from dist filename, env presence, smoke results).

**Acceptance:**
- log.test.ts: redaction of each pattern; output parses as JSON
- ops.test.ts: pauseKind makes tryConsumeGlobalBudget refuse for the rest of the day; resumeKind restores; status counts
- `node scripts/smoke.mjs` passes against the linked dev deployment (or documents which checks were blocked)
- README/hackathon contradictions listed in the P12 report are gone (grep-verified)
- No console.error left in the listed files outside logFailure

**Invariants:** Invariant 16: no secrets in logs; raw provider bodies never logged; Docs describe only mechanisms that exist in code

**Risks:** Editing console.error lines in files owned by other lanes: strictly wave-exclusive, mechanical replacement only.

### T23 — Phase 4 verification: clean isolated install and all gates, browser suite run against the disposable deployment, schedul
**Owner:** sonnet-verifier · **Phase:** 4 · **Blocks on:** T09, T15, T20, T21, T22 · **High-risk:** True
**Files:** docs/reviews/phase4-verification.md, docs/reviews/read-budgets.md

**Contract:**

From a detached `git worktree` at the candidate revision: `npm ci` (scripts on), check-patch, codegen diff, typecheck, lint, test:ci (record count), build (record dist hash and chunk sizes), `npx playwright test` (record pass/skip), smoke.mjs against the dev deployment, scheduler scenario via `npx convex run` of internal.watches.sweep, internal.priceWatch.runAll, internal.notify.sweepStalled, internal.retention.sweep, internal.market.migrateStamps on the disposable deployment with seeded data (ops.status before/after), and — only if the user authorized live provider use — one real verification email, one real alert to the verifier's own verified address, one ShopSavvy lookup, recorded with message ids and no secrets. Table of every P01-P12 acceptance line with PASS/FAIL/BLOCKED and evidence path. Findings register with severity for the auditor; anything high/critical becomes T24 input.

**Acceptance:**
- phase4-verification.md names the exact commit, node version, lockfile hash, and every gate result
- BLOCKED items state the external access missing
- read-budgets.md updated with final numbers

**Invariants:** Verification changes no source; findings go to T24; No production deployment performed here

**Risks:** Live scenarios depend on user authorization and provider keys.

### T24 — Resolve critical/high findings and failed required gates from Phase 4 verification and the fresh Opus audit (conditional
**Owner:** sonnet-backend · **Phase:** 4 · **Blocks on:** T23 · **High-risk:** True
**Files:** convex/**/*.ts (only files named in the findings register), src/**/*.tsx (only files named in the findings register)

**Contract:**

One commit per finding, each with a regression test in the owning module's test file; no scope beyond the register. If a finding belongs to a frontend or integrations file, the lead reassigns that finding's commit to that owner (this task is the default sink).

**Acceptance:**
- Every high/critical register entry closed with test evidence or explicitly accepted by the lead in DECISIONS.md
- All gates green again on the fixed revision

**Invariants:** No new features

**Risks:** Unknown until Phase 4 runs.

### T25 — Phase 5 release preparation: reproducible release manifest for the exact release candidate, environment checklist, backu
**Owner:** sonnet-verifier · **Phase:** 5 · **Blocks on:** T24 · **High-risk:** True
**Files:** docs/ops/RELEASE.md, docs/reviews/release-candidate.md, docs/team/HANDOFF.md

**Contract:**

release-candidate.md: commit SHA, tag `rc-<date>`, node/npm versions, lockfile sha256, dist file hashes, env presence matrix per deployment (names only), migrations to run (migrateStamps), crons expected, smoke output, Phase 4 table link, open findings (must be none high/critical). Backup proof: `npx convex export` of the disposable deployment, `npx convex import` into a second disposable deployment, run smoke + one read query; record commands and durations. Deploy order: backend `npx convex deploy` (schema additive), run migrateStamps, static `npm run deploy`, smoke. Rollback limits stated (cannot un-send mail, schema fields stay). If production deployment is authorized by the user: classify target (cool-oyster-399 vs dev), back up, deploy, rerun smoke, record; else state the exact single remaining action ("deploy rc-<date> to <target> and run scripts/smoke.mjs"). HANDOFF.md replaced with the current state.

**Acceptance:**
- Manifest reproducible from the tag alone
- Restore proof recorded or explicitly BLOCKED with reason
- No claim of a verified production release without production smoke evidence

**Invariants:** Local readiness is never equated with a verified production release

**Risks:** Production deployment authority and credentials belong to the user/co-author.
