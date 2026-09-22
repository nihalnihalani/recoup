# M18 — Code-pack review: R01 v1 (legacy snapshot tier)

| Field | Value |
|---|---|
| Task | M18: the code-pack review that gates activation of R01 v1 (contract §2.7 and §11.1; D158, D160, D161, D171, D179) |
| Reviewer | `opus-rules-reviewer` (Opus 5.5, `claude-opus-5-5`). This is the same independent instance that approved the spec at M09, M09b and M09c. I did not consult the code's authors. |
| Revision reviewed | `935ed03`, re-checked at `origin/main` `1cf3f63`. The reviewed files are byte-identical at both revisions. The only change between them is the subject-scoped read in `lib/facts/legacyRetail.ts` (`90acfee`, M11d), which does not touch pack logic. |
| Pack file | `convex/lib/rules/r01_price_adjustment_v1.ts`, SHA-256 `2f9b609d79add2dce3e0613888823f623eec91002b6fe7401eb38ae8cbc6173f` |
| Reviewed against | `docs/rules/R01-retail-price-adjustment.md` (R01 v1 legacy snapshot tier: §1.4, §4, §5 last bullet, L1), `docs/rules/fixtures/R01.json` (36 runnable results), contract §2.7 and §4, README cross-pack rules, and D145 d, D147(2), D154, D158, D160, D161 |
| Code read | Pack + tests; `lib/rules/{types,outcome,conditions,registry,testRegistry,activation,verification,coverage,applicable}.ts`; `lib/deadlines/engine.ts` (the `elapsed_24h_days` path); `testing/ruleFixtures.loader.ts`; the R01 parts of `priceWatch.ts` (`recordCheck`, `recordCheckV1`, `watchWindow`); `opportunities.ts` (`autoOpenR01`, `openCase`, R01 snapshot build); `lib/facts/{snapshot_retail,legacyRetail,write,keys_retail}.ts`; `lib/money.isTwoDecimalCurrency`; legacy `lib/ledger.priceDropCents` and `windowEndsAt` |

> **Engineering review is not legal certification.** This review checks that the code does what the M09-approved spec and the hand-written fixtures say. It does not certify legal compliance. "Active" will mean independently reviewed against the spec and its sources (D145 DA-A-11).

## Verdict: **changes_required** (2 items)

The pack is sound:
- Every one of the 36 fixtures passes unchanged.
- The engine precedence is used exactly.
- Legacy parity values are reproduced to the constant.
- `eligible` is unreachable.
- `retail.policy_confirmed` is assumption-class.
- D160 is honoured.

One latent correctness defect has to be fixed **before** the file is frozen at `reviewed`. After review, any change needs a v2 (README rule 1; `check-rule-packs` immutability). One documentation item the lead's check (1) requires can go in the same edit. Both are small. See "Required changes".

## Check 1 — every normative parameter cites its basis

| Parameter / behaviour | In code | Parity with legacy code (`5cc326d` reference) | Spec / fixture basis | Result |
|---|---|---|---|---|
| Drop threshold `max(100, round(unit × 2 %))` | `R01_V1_PARAMS.thresholdFloorMinor: 100`, `thresholdPercent: 2`; `Math.max(p.thresholdFloorMinor, Math.round(unit × (2/100)))` | `ledger.priceDropCents`: `Math.max(100, Math.round(unitCents * 0.02))`. In JS, `2/100 === 0.02`, so the results are identical. | R01.json `conventions.threshold`; contract §2.7 parity (KM1) | correct; **citation missing on the param** (item 2) |
| Quantity: ask = drop × qty; per-unit threshold | `perUnit >= threshold ? perUnit * qty : null` | `priceDropCents` returns `drop * qty` | `conventions.threshold`; mission §17 "2 × 12,000 vs 9,500 → 5,000" (R01-08 passes) | correct |
| After a paid claim: remainder ≥ `max(100, round(unit × qty × 2 %))` | `remainderThreshold` | `recordCheck`: `remaining < Math.max(100, Math.round(item.unitCents * item.qty * 0.02))` | `conventions.after_settled_claim` (R01-09a/b/c pass) | correct |
| Observation bars: single price, > 0, variant `exact`, same currency, confidence ≥ 0.7, ≥ round(10 % of unit) | `r01ObservationRejection`; `minConfidence: 0.7`, `minPlausiblePercent: 10` | `rejectionReason`, `MIN_CONFIDENCE = 0.7`, `implausiblyCheap` with `MIN_PLAUSIBLE_FRACTION = 0.1` | `conventions.observation`; D16 (R01-06a–e and R01-07a pass) | correct **for observed cells only** (item 1); **citation missing** (item 2) |
| Window = `purchasedAt + windowDays × 86,400,000 ms`, open while `now ≤ end` | `windowSpec`: `elapsed_24h_days`, `endInclusive: true`, `exact_instant`, `obligor: "user"`, `lateAskAcknowledgeable: true`, `sourcePassageId: "policy_snapshot.windowDays"`; engine `dueAt = anchor + n × DAY_MS` | `ledger.windowEndsAt`; `watchWindow` closes only on `endsAt < now` | spec §5 last bullet (R01 v1 keeps 24-hour multiples); O15/HC-11; C1; `conventions.window` (R01-05a/b/c/d pass across the DST change) | correct |
| Temporal assumption A-T1 (±7 days, inclusive) / A-T2 + "refresh policy" | `temporalToleranceDays: 7`; `add_evidence {docTypes: ["policy_page"]}` | none (new in v1) | contract §2.7 "Reconciliation for R01 v1"; README rule 3 exception; D160 (R01-11/11b pass) | correct; **citation missing on the param** (item 2) |
| Currency: two-decimal only; JPY/KWD `unsupported` | `isTwoDecimalCurrency` (ISO list + `Intl` `maximumFractionDigits === 2`) → `flags.unsupportedReason` | the one intended divergence from legacy (HC-8) | D160; DA-A-13 carve-out (R01-07b GBP passes; the JPY invariant test passes) | correct. KWD is not tested (N3). |
| No snapshot / no `windowDays` → `source_unverified` | `flags.sourceMissing` | legacy "No open price window" | contract §2.7 ("missing → source_unverified"); README rule 8; D160 (R01-04/04b pass) | correct |

## Check 2 — all 36 runnable fixtures pass unchanged through M08's loader

**Commands.** Run in an isolated worktree at `935ed03`, with `node_modules` linked and no edits:
- `vitest run convex/lib/rules/r01_price_adjustment_v1.test.ts --reporter=verbose` → **188 passed, 0 failed, 0 skipped**. That is 36 fixture results × 5 assertions, the file load test, and 7 invariants. Every id R01-01 … R01-16 appears in the verbose log.
- `vitest run` over `convex/lib/rules`, `convex/lib/deadlines`, `convex/lib/facts`, `ruleFixtures.loader.test.ts`, `priceWatch.test.ts`, `priceWatch.v1.test.ts` (the legacy suite re-run with R01 v1 forced active through the test-registry seam, C3), `priceWatch.parity.test.ts`, `freshness.v1.test.ts`, `opportunities.test.ts` and `opportunities.paths.test.ts` → **21 files, 615 passed, 2 todo**. The two todos are the DA-A-22 parity stubs for M2C that D179 records. Nothing is skipped or marked `.only`.
- `node scripts/check-rule-packs.mjs` → OK.

**Harness read line by line.**
- **Loader.** `loadRuleFixtureFile("R01")` hashes the bytes on disk against `manifest.json` **before** parsing, and checks the owning pack's ruleId, version and spec. It validates every case and variant, resolves `facts_from`, `change` and `context_change`, and yields every case and variant as runnable (36). It maps only the README alias (`likely_eligible_missing_evidence` → `likely_eligible`; `not_yet_due` 1:1). Nothing is filtered or computed.
- **Test.** `describe.each(FILE.cases…)` covers all 36 cases with no conditional skip.
- **Assertion mapping** is exactly D158/D161, compared as key sets per class:
  - `missing_facts` ↔ reasons `missing` | `user_unknown` | `conflicting`;
  - `unconfirmed_decisive_facts` ↔ `candidate_unconfirmed` | `conflict_capped`.
- **Fact → cell mapping** follows README cross-pack rule 2:
  - `user_confirmed` → confirmed; `observed` → observed; `derived` → derived;
  - `extracted_candidate` / `assumption` → candidate;
  - `missing` → no row;
  - `conflicting` → one row per candidate in its `conflict_kind`.
- **Case context.** `policy_snapshot` + `retail.window_days` become the parameter source, as contract §2.7 intends. `price_claims_on_item` becomes the case context (confirmed → settled; denied → DA-A-22 observation; other → open claim).
- **Two fidelity notes (not re-mappings):**
  - The fixture fact `retail.policy_confirmed` is not fed to the pack. The pack reads the snapshot's `confirmedByUser`, which is how production works (`latestPolicy`). In every case the two agree.
  - The `send.requires_acknowledgment` line compares the fixture to a literal. The behavioural assertion is the next line, `r01LateAskAcknowledgeable(r) === true` plus `continue_case`, and it passes.

## Check 3 — never `eligible` from a candidate; `policy_confirmed` is assumption-class

**Never eligible.**
- An A-T1 or A-T2 assumption is pushed whenever a policy and a purchase date exist.
- Without a policy the outcome is `source_unverified`; without a date it is `needs_facts`.
- So `deriveOutcome` rule 8 always yields at most `likely_eligible`.
- Any candidate among the decisive cells also sets `evidenceSupports: "unknown"` and lists the key as `candidate_unconfirmed` (D147(2)).
- The fixtures, the "extracted-candidate unit price caps" invariant, and a forbid-`eligible` assertion on all 36 results confirm this.

**Assumption-class.** `retail.policy_confirmed`, `retail.policy_temporal` and `retail.currency` are assumption-class in `requirements`. They are added as `Assumption`s and never appear in `missingFacts` (R01-03 and the currency invariant assert this; DA-A-2, DA-A-33).

**Gap (item 1).** Being capped is not the same as being safe. A **candidate** `retail.observed_price` is used with **none** of the D16 bars and **no currency check**. I reproduced this with a throwaway test in the isolated worktree (not committed). With a USD 499.99 purchase and a confirmed policy:

| Observed-price cell | Outcome | Estimate | `r01AutoOpen` |
|---|---|---|---|
| `observed` EUR 300.00 | `needs_facts` (rejected: currency) | none | no |
| **`extracted_candidate` EUR 300.00** | **`likely_eligible`** | **USD 199.99** (a cross-currency subtraction) | **opens: true** |
| **`extracted_candidate` USD 9.99** (implausibly cheap) | **`likely_eligible`** | **USD 490.00** | **opens: true** |
| `observed` USD 449.99 with no observation metadata | `likely_eligible` | USD 50.00 | yes. With no metadata, the variant and confidence bars are skipped. Safe today only because legacy price checks are D16-vetted at write time. |

`likely_eligible` is approvable, so `openCase` (user-initiated) would open a claim with that amount. The auto-open path in `recordCheckV1` is protected by the legacy gates, which run first.

**Reachable today? No.**
- Nothing writes an `extracted_candidate` or evidence-sourced `observed` row for `retail.observed_price`.
- The legacy adapter writes only D16-vetted price checks as `observed`.
- Intake "never write[s] money".
- The key is not `userAssertable`.

**But the catalog and `putFact` do allow it:** `SOURCES_FOR_STATE` has `extracted_candidate ← evidence` and `observed ← price_check | evidence`, and the key is not excluded. Once this file is frozen at `reviewed`, a future extractor (M23) or evidence writer would turn this into a live violation of mission §6 ("never sum different currencies") and of D16. Fixing it would then require a v2. The contract §2.7 definition of the fact ("an accepted observation in the purchase currency with `variantMatch: exact` and confidence ≥ 0.7") is not what the pack enforces.

## Check 4 — outcomes follow the engine's precedence

**Precedence.**
- Every outcome comes from `deriveOutcome`: directly, or through `outcomeOf` for candidate testing.
- The pack only builds dimensions and flags.
- The precedence in `outcome.ts` matches contract §4 rules 1 → 9 as amended by D154, D158 and D160.

**Conflict handling in the pack (D152/D154/D161).**
- **5a (`confirmed_vs_*`):** `manual_review`. The key is not asked. The explanation names both values and "upload proof" (R01-16).
- **5b (candidates, different answers):** `needs_facts`, with the key as `conflicting` (R01-15).
- **5c (same outcome and same amount, via `sameAnswer`):**
  - the outcome is capped;
  - the key is listed as `conflict_capped`;
  - the representative is the earliest-window candidate;
  - the deadline is kept as `disputed_anchor` (no `dueAt`);
  - auto-open's `windowEndsAt` falls back to the labelled advisory, i.e. the earliest candidate (R01-15b).
- More than 16 combinations → not testable → `needs_facts`, which is conservative.

**Per-fixture check.** I traced every R01.json result to the rule that decides it:
- Rule 1: R01-07 JPY invariant.
- Rule 2: R01-04/04b.
- Rule 3: R01-02a/02d, 09b/09c, 13; the returned item.
- Rule 4: R01-05c/05d.
- Rule 5a: R01-16.
- Rule 5b: R01-15.
- Rule 6: R01-06a–e, 07a, 14/14b.
- Rule 8, and 5c then 8: all `likely_eligible` results.

Every one matches my M09b blind decisions.

## Check 5 — no behaviour the spec does not support

- **Framing.** Authority is `merchant_promise`. The copy is "estimate", "the store's price-adjustment window", "merchant". There is no legal-right language and no cash-compensation concept. `sources: []` is correct for the framework (D145 d); the parameter source is cited as `policy_snapshot.windowDays`.
- **Stated divergences.** The pack's only divergences from legacy are D160 (non-two-decimal → `unsupported`) and the DA-A-22 denied-claim rule. The DA-A-22 rule is fixture-backed (R01-10a/b/c) and labelled wave 2.
- **Past-window amount.** `AMOUNT_OUTCOMES` shows the estimate on `deadline_passed`. That serves the acknowledgeable late send (C1), not an entitlement claim. M15's copy must keep it an estimate.
- **Registry.** The production registry returns the pack only after the lead's `ACTIVATIONS` entry (empty today). Coverage reads `activation.ts` directly. `testRegistry` is test-only.

## Required changes (before the manifest records `reviewed`)

1. **Vet every observed-price value the pack computes with (pack code + tests).** In `core()`, a `retail.observed_price` value must pass the D16 bars and have the purchase currency before it can drive a drop or an amount. That applies to candidates and to any non-price-check source, not only `isKnown` cells.
   - **Simplest fix, and faithful to contract §2.7:** only an `observed` cell from a vetted price check (`source.kind` `legacy_price_check` / `price_check`, with its `RetailObservation` metadata) counts as the accepted observation. Any other status or source is treated as "not accepted": the key is listed `missing` → `needs_facts`, as today for a rejected reading.
   - **Alternative:** run `r01ObservationRejection` on every usable value, with `meta: null` treated as "not vetted" → rejected.
   - **Add tests:** a candidate in EUR, a candidate below 10 %, and an evidence-sourced `observed` value without metadata. Each must yield no amount and no auto-open.
   - All 36 fixtures must still pass unchanged. None uses a candidate observed price.
2. **Cite the basis of each parameter on the parameter** (JSDoc on `R01_V1_PARAMS` / `R01Params`), not only on the legacy line it reproduces:
   - `thresholdFloorMinor` / `thresholdPercent` → R01.json `conventions.threshold` + contract §2.7 (KM1 parity);
   - `minConfidence` / `minPlausiblePercent` → `conventions.observation` + D16;
   - `temporalToleranceDays` → contract §2.7 "Reconciliation for R01 v1" + README rule 3;
   - the window → spec §5 (last bullet) + `conventions.window` + O15/HC-11 + C1;
   - the currency gate → D160 / DA-A-13.
   - While there: `knownLimitations[2]` cites "(D147)" for the unmodelled window-event question. That point is M09 R01.6-2, implemented in R01 v2; cite it that way.

After (1) and (2), send me the new file hash. I will re-check only the diff and the tests, then approve for activation.

## Non-blocking notes (for the lead / later tasks)

- **N1 — immutability.** `packFileSha256` pins only this file. The pack's behaviour also depends on `outcome.ts`, `conditions.ts`, `deadlines/engine.ts`, `facts/resolve.ts` and `money.ts`, including the runtime's `Intl` currency data. Until `ENGINE_VERSION` becomes a content hash (M20, DA-A-23), the C3 full-suite re-run at the activation commit is the only guard. Keep it mandatory.
- **N2.** With both a settled claim and a denied claim on one item, the DA-A-22 branch replaces the estimate and ignores `settled`. No fixture covers this (wave-2 rule). Add a fixture when M2C lands.
- **N3.** Add a KWD (three-decimal) case next to the JPY invariant. D160 names both.
- **N4.** `r01AutoOpen` labels a returned item's `not_eligible` as "Drop below threshold". This is unreachable from `recordCheckV1`, where the legacy `watchWindow` returns "No open price window" first, but it would be wrong if reused.
- **N5.** `cashClass: "cash"` is legacy parity: price-adjustment claims count as cash recoveries today. The v1 spec states no remedy form; merchants may pay by refund or by credit (Apple AP-1 "refund or credit"). Record it as a known limitation; R01 v2's `remedy_form` resolves it.
- **N6.** The pack declares `lifecycle: "reviewed"`, which is informative only. Its manifest entry must not move to `reviewed` until this review approves.
