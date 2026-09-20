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
