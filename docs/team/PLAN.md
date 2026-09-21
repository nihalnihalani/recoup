# Team plan (lead-owned)

Source plan: `docs/plans/2026-09-20-recoup.md` (T01–T16 map 1:1 to its Tasks 1–16). Patterns: `docs/ARCHITECTURE_PATTERNS.md`. Decisions: `DECISIONS.md`.

Statuses: pending · ready · in_progress · review · changes_requested · verified · blocked

| ID | Purpose | Owner (model) | Blocks on | Status | Evidence required |
|---|---|---|---|---|---|
| T01 | Scaffold + Convex project | done (sonnet) | – | verified | review-task1 APPROVE; build/test exit 0 |
| T02 | Components, auth, http, main.tsx | sonnet-backend (sonnet) | T01 | verified | commits f710722, 2084ac0; lead re-ran typecheck+lint exit 0; components installed; FIRECRAWL_API_KEY set |
| T03 | Schema (final) + ledger + money + test harness + stubs | sonnet-backend | T02 | verified | ledger tests pass; schema deploys |
| T04 | Access helpers, purchases/items | sonnet-backend | T03 | verified (R-fixes in dab69a1) | cross-user rejection test passes |
| T05 | Claims + ledger events + notes | sonnet-backend | T04 | verified (T05.1 D38-D48 in dab69a1) | promise≠confirmed; dedupe; later-debit; version bump tests |
| T06 | zod schemas + OpenAI helper | sonnet-integrations | – (own files) | verified | schema tests; no network |
| T07 | Inbox provisioning, inbound routing, intake | sonnet-integrations | T05,T06 | review (300605e; opus checkpoint) | routing tests; dedupe with status |
| T08 | Policy research (Firecrawl) + T08.1 D43/D45 | sonnet-integrations | T06 | verified (31ab7dc; live BLOCKED_EXTERNAL) | upsert test; live BLOCKED_EXTERNAL until keys |
| T09 | Price watch cron + checkNow | sonnet-backend | T05,T08 | review (10 tests; live BLOCKED_EXTERNAL) | threshold/window/dedupe tests |
| T10 | Drafts, queued send + reconcile, replies | sonnet-integrations | T07 | review (01cafa8; opus checkpoint) | stale-version + empty-recipient tests |
| T11 | Frontend screens (T11a scaffold now; T11b flows after T05/T10) | sonnet-frontend | T11a: T02 · T11b: T05,T07,T10 | T11a, T11b-1, T11b-2 verified (be2019b, 6c10942) | browser rehearsal against dev deployment |
| T12 | Example loader | sonnet-backend | T05 | verified (6 tests, archive semantics D47) | owned+labelled; no real recipients |
| T13 | Hardening: scenario suite ✓ (26), checkpoint 2 ✓ (S1–S12 → D52–D58), fixes T10.1/T05.2 in progress, T13.1 scheduler-driven tests pending | sonnet-integrations, sonnet-backend, sonnet-tester | T10,T11 | in_progress | invariant checklist; adversarial fixtures |
| T14 | Deploy to convex.site | sonnet-verifier | T13 | blocked | needs OPENAI/AGENTMAIL keys for live path |
| T15 | hackathon.md, README, video | lead + sonnet-frontend | T14 | pending | honest limits section |
| T16 | Submit + social | user | T15 | blocked | user authorization required |

Waves: W1 = T02 (backend) + planner + devils-advocate. W2 = T03–T05 (backend) ‖ T06 (integrations). W3 = T07–T10 (integrations) ‖ T11 (frontend). W4 = T12, T13, verifier. W5 = auditor, T14, T15.
