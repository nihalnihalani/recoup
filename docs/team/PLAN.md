# Team plan (lead-owned)

Source plan: `docs/plans/2026-09-20-recoup.md` (T01–T16 map 1:1 to its Tasks 1–16). Patterns: `docs/ARCHITECTURE_PATTERNS.md`. Decisions: `DECISIONS.md`.

Statuses: pending · ready · in_progress · review · changes_requested · verified · blocked

| ID | Purpose | Owner (model) | Blocks on | Status | Evidence required |
|---|---|---|---|---|---|
| T01 | Scaffold + Convex project | done (sonnet) | – | verified | review-task1 APPROVE; build/test exit 0 |
| T02 | Components, auth, http, main.tsx | sonnet-backend (sonnet) | T01 | verified | commits f710722, 2084ac0; lead re-ran typecheck+lint exit 0; components installed; FIRECRAWL_API_KEY set |
| T03 | Schema (final) + ledger + money + test harness + stubs | sonnet-backend | T02 | verified | ledger tests pass; schema deploys |
| T04 | Access helpers, purchases/items | sonnet-backend | T03 | review (opus recheck) | cross-user rejection test passes |
| T05 | Claims + ledger events + notes | sonnet-backend | T04 | review (opus recheck) | promise≠confirmed; dedupe; later-debit; version bump tests |
| T06 | zod schemas + OpenAI helper | sonnet-integrations | – (own files) | verified | schema tests; no network |
| T07 | Inbox provisioning, inbound routing, intake | sonnet-integrations | T05,T06 | in_progress | routing tests; dedupe with status |
| T08 | Policy research (Firecrawl) | sonnet-integrations | T06 | verified (live BLOCKED_EXTERNAL) | upsert test; live BLOCKED_EXTERNAL until keys |
| T09 | Price watch cron + checkNow | sonnet-backend | T05,T08 | in_progress (after T12) | threshold/window/dedupe tests |
| T10 | Drafts, approved send, replies, reminders | sonnet-integrations | T07 | pending | stale-version + empty-recipient tests |
| T11 | Frontend screens (T11a scaffold now; T11b flows after T05/T10) | sonnet-frontend | T11a: T02 · T11b: T05,T07,T10 | T11a verified · T11b in_progress | browser rehearsal against dev deployment |
| T12 | Example loader | sonnet-backend | T05 | in_progress | owned+labelled; no real recipients |
| T13 | Hardening pass | sonnet-tester + opus-devils-advocate | T10,T11 | pending | invariant checklist; adversarial fixtures |
| T14 | Deploy to convex.site | sonnet-verifier | T13 | blocked | needs OPENAI/AGENTMAIL keys for live path |
| T15 | hackathon.md, README, video | lead + sonnet-frontend | T14 | pending | honest limits section |
| T16 | Submit + social | user | T15 | blocked | user authorization required |

Waves: W1 = T02 (backend) + planner + devils-advocate. W2 = T03–T05 (backend) ‖ T06 (integrations). W3 = T07–T10 (integrations) ‖ T11 (frontend). W4 = T12, T13, verifier. W5 = auditor, T14, T15.
