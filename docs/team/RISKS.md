# Risk register — Mission 2 (lead-owned)

| ID | Risk | Likelihood | Impact | Mitigation | Owner | Status |
|---|---|---|---|---|---|---|
| K01 | Rules encoded from memory or secondary sources present non-existent entitlements as fact | high | critical | every active rule pack cites a first-party passage captured this mission; lifecycle draft→researched→reviewed→active; evaluator returns `source_unverified` otherwise | rules-researcher + DA | open |
| K02 | Generalising `claims` (purchaseId+itemId required) breaks the hardened price/return ledger | medium | critical | additive schema; legacy claim paths unchanged; full regression suite + ledger fixtures gate every wave | backend + QA | open |
| K03 | Potential/alternative remedies summed into a "money found" total | high | high | overlap groups; dashboard shows potential vs confirmed separately; no cross-path sums | backend + frontend + DA | open |
| K04 | Formal-notice claims (FCBA, Reg E) presented as filed by ordinary email | medium | high | channel model distinguishes email / portal / postal; formal notices are packets with manual-submission evidence unless the source supports email | commerce + rules | open |
| K05 | Document upload introduces unbounded processing, cross-user leakage, or prompt injection | medium | high | owned storage, type/size/page caps, per-owner dedupe, extraction as untrusted data | integrations + security | open |
| K06 | Scope explosion: 25 scenarios attempted shallowly | high | high | Phase 1 end-to-end first; registry marks true status; later phases only when unblocked | lead | open |
| K07 | Shared working tree collisions between concurrent writers | medium | medium | one writer per file; pathspec commits; worktrees for parallel code lanes; no stash | lead | open |
| K08 | Sensitive domains (medical, financial statements) ingested without safeguards | medium | critical | R17 gated; statements parsed with minimum-necessary fields; retention/deletion extended to evidence | security | open |
| K09 | Model substitution for teammates goes unnoticed | low | medium | alias probe (D135); first-line model report in every teammate report | lead | open |
| K10 | Co-author (Charlie Gillet) pushes concurrently to main | medium | medium | fetch+merge (never rebase) before every push; no force-push | lead | open |
| KM1 | R01 retrofit changes auto-open behaviour | medium | high | parity test against 5cc326d fixtures is a hard gate | backend + QA | open (M01) |
| KM2 | widening ledger kinds silently counts new kinds as debits (`balance()` else-branch) | medium | critical | exhaustive switch in the same commit + every-kind test | backend | open (M01) |
| KM3 | material-change version bumps invalidate drafts on price churn | medium | medium | materiality excludes estimate drift while a case is active; bump-count test | backend | open (M01) |
| KM6 | upload abuse / cost | medium | high | tickets, rate limit, size/page caps, per-user storage cap, budgets, statements store-only | integrations + security | open (M01, M03) |
| KM7 | rollback after the first scenario claim is unsafe | medium | medium | forward-fix policy; wave-2 deploy only after checkpoint C | lead | open (M01) |
| KM8 | rule-pack immutability relies on a script CI cannot run (missing secrets) | medium | medium | lead runs `scripts/check-rule-packs.mjs` at every wave close | lead | open (M01) |
| KM10 | a Phase-1 source cannot be verified | medium | high | pack stays `researched`; evaluator returns `source_unverified`; never marked implemented_verified | rules + lead | open (M01) |
| KS1 | provider retry re-sends mail after a lost response (S-M03-1) | medium | high | retryAttempts 1; ambiguous → unknown | integrations | open (M03) |
| KS2 | Card numbers split by double spaces, dots or newlines are not masked (SEC-SD-2 rule (c) deliberately limits separators to single space/hyphen to avoid false positives on identifiers) | low | medium | lead probe at beb8cf7 confirmed standard forms masked (spaced, hyphenated, Amex 4-6-5, trailing punctuation) and IMEI/ticket/order refs kept; statements stay store-only (no extraction) until the SEC-SD gates pass; revisit with a targeted extension (e.g. dot separators) only with keep-tests for dotted identifiers | M10 / security | accepted residual |
| KX1 | Convex team plan usage warning during deploy — the disposable dev deployment may be throttled or interrupted | medium | medium | report to the user (plan decision is theirs); keep test runs bounded; avoid unnecessary deploys | user / lead | open |
