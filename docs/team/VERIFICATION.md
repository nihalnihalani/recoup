# Verification log (lead-owned; appended from tester/verifier reports)

Each entry: date · env · revision · command/scenario · result · counts · limitation

- 2026-09-21 · local · e38efc5 · `npx vite build` · exit 0 · – · scaffold only
- 2026-09-21 · local · e38efc5 · `npm test` · exit 0, 0 tests collected · **not acceptance evidence** (passWithNoTests)
- 2026-09-21 · local · e38efc5 · `npm run typecheck` · app side exit 0; convex side TS18003 (no inputs) · expected until T02 lands

## Required scenarios (from the contract) — status
| Scenario | Test | Status |
|---|---|---|
| expected 4000, promise 4000 → unresolved 4000 | ledger.test / claims.test | pending |
| confirm 1500 → 2500; confirm 2500 → 0 + confirmed | claims.test | pending |
| later debit 1000 → unresolved 1000, only this claim reopens | claims.test | pending |
| replay processed inbound event → no duplicate | inbound.test | pending |
| retry after downstream failure → recoverable | inbound.test (status field) | pending |
| user B with user A ids → rejection | purchases.test, claims.test, drafts.test | pending |
| approve then edit → old approval cannot send | drafts.test | pending |
| simultaneous sends / provider timeout → no blind duplicate | drafts.test (outboundId guard) | pending |
| 2×12000 observed 9500 → claim 5000 | priceWatch.test | pending |
| wrong variant / currency / expired window / missing price → no claim | priceWatch.test | pending |
| manual + cron overlap → one open claim | priceWatch.test | pending |
| queued send without message id → UI queued | drafts.sendStatus + Claim page | pending |
| confirm credit while reminder fires → no stale action | followUps.test | pending |
| reply "refund issued" → promised only | replies.test | pending |
| form/chat/phone merchant → packet flow | drafts.test + Claim page | pending |
- 2026-09-21 · local · 2084ac0 · `npx convex dev --once` · components agentmail/firecrawl/staticHosting installed, functions ready · – · no provider keys; deploy does not require them (D12c)
- 2026-09-21 · local · 2084ac0 · `npm run typecheck`, `npm run lint`, `npx vite build` · all exit 0 (re-run by lead) · 0 tests · –
- 2026-09-21 · local · dfcd3a1 · `npx vitest run convex/lib` · 3 files, 40 passed · strict-mode guard covers all 5 schemas; `extract` fails closed without key (lead re-ran) · OpenAI never called live yet (D07)
- 2026-09-21 · local dev · T11a commits · browser rehearsal at localhost:5173 · sign-up → shell → /, /settings, /purchases/:id, /claims/:id, unknown route redirect, 400px width, sign-out; no console errors · – · placeholder pages; test account recoup.t11a.test@example.com exists on dev deployment
- 2026-09-21 · local · 5407483 · `npm test` · 6 files, 68 passed (money 18, ledger 23, harness 1, followUps 4, schemas 17, ai 5) · schema deploys via `convex dev --once` · workpool version mismatch found → D36
- 2026-09-21 · local · ddd26a3 · `npx vitest run convex/policies.test.ts convex/lib/passage.test.ts` · 12 passed · lead confirmed only `confirm` patches; research always inserts · live Firecrawl+OpenAI path untested (no OPENAI_API_KEY)
- 2026-09-21 · local · 747eb12 · `npm test` · 10 files, 101 passed (lead re-ran) · purchases 11, claims 10 added · Phase 1 money/ownership recheck dispatched to opus-devils-advocate
- 2026-09-21 · local dev deployment · b82eade · browser rehearsal (T11b-1) with server truth via `npx convex data` · seed purchase → mark returned → open claim $40 → confirm $15 (unresolved $25, status detected) → confirm $25 (settled) → later charge $10 (status reopened, unresolved $10) · 3 ledger events, 3 distinct keys · over-credit text path not exercised live; test account recoup.t11b.test@example.com left on dev
- 2026-09-21 · isolated worktree at HEAD 6bbe8c2 · `npx vitest run` · 15 files, 136 passed, 2 failed (examples remove → needs D47 uncommitted; inbound In-Reply-To route → needs T10 uncommitted) · typecheck fails only from stale committed `_generated/api.d.ts` → D50
- 2026-09-21 · local · dab69a1 · backend lane: `npx vitest run` on owned files · 107/107 (examples 6, priceWatch 10, claims, purchases, followUps, ledger, money) · full suite 180 collected, 167 pass, 13 fail in drafts/replies tests from harness `lib` resolution → T03.1 dispatched
