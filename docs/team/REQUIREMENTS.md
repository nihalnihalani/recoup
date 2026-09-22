# Requirements → evidence map — Mission 2 (lead-owned)

Mission: evolve Recoup into a US transaction-eligibility and recovery platform (user prompt 2026-09-23, "RECOUP: US TRANSACTION-RECOVERY PLATFORM — ALL–OPUS 5.5 AGENT TEAM"). Governing inputs: A = `docs/prompts/recoup-opus-sonnet-agent-team.md` + `docs/reviews/2026-09-21-production-readiness-baseline.md`; B = `docs/research/usa-receipt-compensation-opportunities.md`. Precedence per mission §1 (D136).

Status vocabulary: open · in_progress · verified_local · verified_live · blocked · deferred_by_scope. "verified" requires an evidence pointer.

| Req | Mission § | Requirement (short) | Task(s) | Evidence | Status |
|---|---|---|---|---|---|
| Q-RT | §2 | Runtime/team/model verified and recorded honestly | lead | D135 (probe: both alias paths self-report Opus 5.5) | verified_local (self-reported) |
| Q-TEAM | §3 | Named Opus 5.5 roles in waves; reviewers ≠ sole reviewers of own work | lead | PLAN.md Mission 2 roster | in_progress |
| Q-BASE | §4 | Current baseline reproduced (not historical counts) | M00 | VERIFICATION.md 2026-09-23 | verified_local |
| Q-INV-OWN | §6 | Ownership + relationship validation on every user-owned surface | M03, all impl tasks | – | open |
| Q-INV-MONEY | §6 | Integer minor units + explicit currency; no cross-currency sums; no additive alternatives | M01 contract, impl | – | open |
| Q-INV-RECOVERY | §6 | Potential / estimate / claimed / submitted / promised / provisional / confirmed / reversal / non-cash kept distinct | M01 | – | open |
| Q-INV-LEDGER | §6 | Append-only; unresolved = expected − confirmed + later debits; over-credit preserved; only affected claim reopens | existing + regression | Mission 1 claims/ledger suites | open (regression gate) |
| Q-INV-OVERLAP | §6 | Overlap groups: alternative / complementary / primary-secondary / distinct lines | M01 | – | open |
| Q-INV-AI | §6 | AI extracts/drafts only; never eligibility, approval, money, or executable rules | M01, M03 | – | open |
| Q-INV-OUTBOUND | §6 | Approval bound to recipient/subject/body/attachments/amount/facts/version; re-read before side effect | existing + new channels | Mission 1 drafts suite | open |
| Q-INV-DELIVERY | §6 | draft→approved→queued→accepted→sent→delivered (+failed/bounced/unknown/stalled); prepared ≠ filed | M01 | – | open |
| Q-INV-SCHED | §6 | Scheduled work re-reads state/version; reminders only for merchant follow-ups | existing | Mission 1 followUps/notify suites | open (regression gate) |
| Q-INV-EX | §6 | Examples owned, labelled, isolated, no side effects | existing + new scenarios | – | open |
| Q-DM | §7 | Transaction / asset / evidence / fact / incident / rule pack / opportunity / case / correspondence / recovery / jobs | M01 → impl | – | open |
| Q-RULE | §8 | First-party provenance, temporal accuracy, disagreement handling, lifecycle draft→researched→reviewed→active→superseded | M02 → impl | – | open |
| Q-ELIG | §9 | Six-dimension evaluation, explicit outcomes, deadline engine with injected clock | M01 → impl | – | open |
| Q-R01..R05 | §10 | Phase 1 slices end to end (intake → recovery confirmation) | impl waves | RULES-COVERAGE.md | open |
| Q-R06..R25 | §11 | Every scenario accounted for with actual status | RULES-COVERAGE.md | RULES-COVERAGE.md | open |
| Q-IPHONE | §12 | Cross-category iPhone acceptance case without invented money | impl + QA | – | open |
| Q-INTAKE | §13 | Forward/paste/manual/upload; typed extraction; owner-scoped dedupe; injection-safe | impl | – | open |
| Q-UX | §14 | Opportunity card, questions, separated states, packet, manual channels, dashboard, a11y | impl | – | open |
| Q-P01..P12 | §15 | Inherited hardening reclassified on the current revision | M03, M04 | – | open |
| Q-DA | §16 | Adversarial review at contract, per slice, and release | DA checkpoints | – | open |
| Q-TEST | §17 | Deterministic, authorization, failure, concurrency, browser, migration tests | QA | – | open |
| Q-CONN | §18 | C01–C58 audited | auditor | CONNECTIONS.md | open |
| Q-COPY | §20 | Copy matches coverage; no billing activation | frontend + lead | – | open |
| Q-DOD | §22 | Definition of done | lead | FINAL report | open |
