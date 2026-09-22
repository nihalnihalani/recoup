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
