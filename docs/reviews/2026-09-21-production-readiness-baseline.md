# Production-readiness baseline — September 21, 2026

## Scope and verdict

Inspected local `main` at `70bf996` to update the Opus/Sonnet execution prompt. The working tree was clean before these documentation changes. This was a source/documentation review and execution of existing local checks, not a complete security audit or a live production certification. No deployment, provider call, real email, account creation, or remote mutation was performed.

**Verdict: implemented product with passing backend checks; production readiness remains unproven.** The old scaffold-building prompt is obsolete. The revised prompt preserves the current price-first product and assigns concrete hardening work instead of rebuilding it.

## Reproduced local checks

| Check | Result |
|---|---|
| `npm test` | 31 files, 575 tests passed; 4.63 seconds reported by Vitest |
| `npm run typecheck` | Passed |
| `npm run lint` | Exit 0; two warnings |
| `npm run build` | Passed; 153 modules; main JS 552.30 kB / 156.17 kB gzip |

Lint warnings: unnecessary escape in `convex/lib/passage.ts:25`; component/utility export combination in `src/components/Money.tsx:2`. Build warns about a chunk exceeding 500 kB. These warnings alone do not establish a release blocker.

Vitest includes `convex/**/*.test.ts`. The test command still uses `--passWithNoTests`. The current successful run contains real tests, but CI must not allow a future empty suite to pass. No checked-in `.github` workflow or browser/E2E test files were found in the inventory. Existing tests use local stubs/component registration; a passing suite does not certify real provider delivery or production configuration.

## Implemented capabilities to preserve

- Convex Auth password authentication and gated React routes.
- Purchase intake, immutable policy evidence, deterministic ledger, claims, approved merchant drafts, inbound replies, follow-up reminders.
- Before-purchase watches, price history/verdicts, email/in-app drop notifications, watch-to-purchase conversion, confirmed cross-store offers.
- Optional ShopSavvy history and candidate-store ingestion.
- Per-user/global spending controls and bounded scheduling paths.
- AgentMail component patch and integration registration; HTTP auth/webhook routes precede static hosting.
- Extensive tests for ledger, ownership, drafts, replies, policies, watches, offers, budgets, and parsing.

Do not replay historic findings as current defects. For example, scoped paste dedupe, current-draft checks, URL private-name filtering, and queued-to-sent notification reconciliation are present in current code. Earlier documents describe different branches and deployment revisions.

## Current findings and audit targets

### High priority: identity and notification abuse

`convex/auth.ts` registers `providers: [Password]`. `convex/notify.ts` explicitly documents that `users.email` is unverified, and `dropContext` uses that address without a verification check. Fixed subjects and quotas are useful mitigations but do not demonstrate destination ownership. Production automatic alerts need verified recipients, preferences/suppression, and appropriate recovery and unsubscribe behavior. SignIn/Settings contain no implemented recovery/verification settings flow in the inspected files.

### High priority audit target: alert delivery failure windows

`notify.sendDrop` reads a claimed row, calls component enqueue, records `outboundId`, then schedules reconciliation in separate steps. Concurrent calls or a crash after enqueue need explicit fault-injection verification. This review did not reproduce a duplicate email, so this is a concrete failure-window risk, not a demonstrated production incident. `applyDropOutcome` leaves pending rows queued after the last retry; recovery and honest unknown/stalled UI need verification.

### Confirmed recovery defect: market lookup permanently stamps failure

`convex/market.ts:recordSnapshot` stamps `marketFetchedAt` on every result. `lookup` calls it when credentials are absent or a provider call fails. `refresh` rejects any watch with that field. Configuring the missing key later therefore does not make those watches refreshable through this API. `refresh` also schedules work without persisting an in-flight claim; simultaneous requests before completion need concurrency testing. The inventory contains ShopSavvy helper tests but no `market.test.ts` orchestration suite.

### Confirmed source-level completeness issues: dashboard windows

`convex/insights.ts:userWatches` takes 40 newest records before its callers filter archived ones. `userPurchases` takes 40 before filtering active ones. Archive churn can exclude older active records. `sources` reads 20 offers before filtering confirmed offers. It increments bought counts for both bought watches and purchase items, creating a potential duplicate representation after conversion; reproduce with linked records and define canonical counting.

### Time/freshness audit target

`convex/watches.ts:list/get` pass `Date.now()` into summaries inside queries. Time alone does not trigger reactive query updates. Verify open-tab cooldowns/verdict age and failed-read freshness. This does not imply every countdown is broken: client-side timers may cover individual surfaces and must be checked before changing them.

### Performance, installation, and operational gaps

- `insights.ts` has bounded parent windows with multiple nested reads and some `.collect()` calls. Establish maximum legitimate child counts and measure payload/read cost rather than assuming every collect is unbounded or every bound is sufficient.
- `postinstall` invokes `patch-package`, a devDependency, to modify `@agentmail/convex@0.1.0`. The deployment build must use a compatible installation mode and verify the patch in a clean checkout. A production-only install was not run during this review.
- README contains conflicting live-status statements and stale cadence/decision references. It omits ShopSavvy and alert-sender/app-URL configuration used by current code.
- No application-level account export/deletion/preferences flow was found in the inspected Settings/auth files. A full cross-service lifecycle, retention policy, and recovery runbook need implementation or explicit release scope decisions.
- Historical handoff claims a production/main mismatch and a pending PR. These are not current remote evidence; do not use them to authorize a merge/deploy or declare today's deployment stale.

## Required next evidence

The revised prompt defines P01–P12 work packages and 36 connection checks. Priorities are verified-recipient delivery, recoverable/duplicate-safe external jobs, market recovery, correct dashboard results, meaningful browser coverage, clean-install CI, and a release manifest plus operational recovery proof.

A future release verdict must reference the exact candidate revision and distinguish source review, local automated proof, live controlled rehearsal, and production smoke checks. Outstanding external access prevents a full live-ready verdict but should not stop independent implementation and local verification.

## Deliverable

Updated `docs/prompts/recoup-opus-sonnet-agent-team.md`. This review changed documentation only; it did not implement the hardening backlog or launch an Opus/Sonnet team.
