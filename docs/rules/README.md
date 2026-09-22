# docs/rules — rule packs, sources, and fixtures

Owner: opus-rules-researcher (M02). This directory is the **research and provenance layer** for Recoup's eligibility rules. It holds specs, captured source text, and hand-written fixtures. It holds no executable code. Evaluators live in `convex/lib/rules/**` (M01 contract §7) and are written by the backend/domain engineers **from** these specs.

Engineering research is not legal certification. Every pack here is at most `researched` until an independent reviewer signs it off.

## Layout

```
docs/rules/
  README.md                         this file
  manifest.json                     machine-readable index: packs, lifecycle, sources + SHA-256, fixture hashes
  R01-retail-price-adjustment.md    framework spec + merchant packs (merchant promise)
  R02-airline-refund.md             14 CFR 260 / 49 USC 42305 / 399.80(l)
  R03-credit-card-billing-error.md  15 USC 1666 / 12 CFR 1026.13 + official interpretation
  R04-baggage.md                    14 CFR 260.5 (bag fee) + 14 CFR 254 (liability) — three paths
  R05-mail-internet-order.md        16 CFR 435 (MITOR)
  TRIAGE.md                         R06–R25 sources, legal status, verdicts
  fixtures/R01.json                 15 cases, R01 v1 legacy snapshot tier (M1C, M2D)
  fixtures/R01v2.json               16 cases, R01 v2 merchant-pack tier (M2D)
  fixtures/R02.json … R05.json      12 cases each, constructed from source text, never from code
  sources/                          captured first-party text (US federal works) + excerpts file
```

## Lifecycle

```
draft ──► researched ──► reviewed ──► active ──► superseded
                                          └────► withdrawn
```

| State | Meaning | Who moves it | Exit criteria |
|---|---|---|---|
| `draft` | Being written; sources not all fetched | researcher | every §8 field present; every threshold/amount/deadline backed by a passage captured in this run |
| `researched` | Complete spec + captured sources + fixtures | researcher | an independent reviewer (not the author) checks each passage against its source URL and each fixture against the passage |
| `reviewed` | Reviewer signed: name, date, findings | reviewer | evaluator implemented; **all** fixtures pass; source still current (within the refresh window) |
| `active` | Evaluator may return `eligible` | lead (records a DECISIONS entry) | a new version is reviewed (→ `superseded`), or a source becomes invalid (→ `withdrawn`) |
| `superseded` | Replaced by version N+1; kept so historical evaluations stay explainable | lead | terminal |
| `withdrawn` | The source no longer supports the rule (repealed, vacated, enforcement change) | lead | terminal |

Rules:
1. **Immutability.** A pack version never changes after `reviewed`. Any change to a passage, threshold, or logic makes a new version (`v2`). The old spec stays in git history and in `manifest.json` as `superseded`.
2. **Scraped updates never rewrite logic.** A changed source hash opens a review item. The diff is reviewed; affected fixtures are re-run; prior versions are preserved (mission §8).
3. **Staleness blocks conclusions.** Each pack has a refresh window (R02 30 days, R03 90, R04 30 with monthly checks until the 2026 biennial adjustment, R05 180, reviewed R01 merchant packs 7). An evaluation whose pack was last verified outside the window returns `source_unverified`. Fixtures R02-11, R03-10, R04-10 and R05-11 test this.
   **R01 v1 exception (legacy per-purchase policy snapshots).** For R01 v1, freshness is measured against the purchase date and only adds an assumption. It never blocks and never makes the outcome `eligible`. The 7-day merchant freshness window applies to reviewed merchant packs (the R01 v2 tier). Contract rev 4 (`044b20d`) §2.7, "Reconciliation for R01 v1 (D145 d)", in its own words: "So README rule 3's 7-day merchant window applies to **reviewed merchant packs** (the R01 v2 tier). For the v1 snapshot tier, freshness is measured **relative to the purchase**". A snapshot retrieved within ±7 days of `purchasedAt` gets assumption A-T1; otherwise it gets A-T2 and the next action "refresh policy". "Both are assumption-class. Neither yields `eligible` or blocks the case, so parity holds (KM1)." Fixture R01-11 tests this: a stale snapshot is assumption-only, **not** `source_unverified`.
4. **Text presence ≠ legal force.** eCFR still displays §1026.62 (overdraft rule disapproved by Pub. L. 119-10) and the stayed §1026.52 $8 late-fee safe harbor. A pack records legal status separately (TRIAGE, cross-cutting finding).
5. **Temporal applicability.** A pack version applies to a transaction only if its effective date is on or before the anchor date and no later version was effective at the anchor. When applicability is unknown, see R01 §1.4 (unknown → capped at likely eligible with an explicit assumption; known mismatch → `source_unverified`).

## Cross-pack rules (D147, 2026-09-23)

These apply to every pack and every fixture file. They answer the M09 review's cross-cutting items X1–X6.

1. **Confirmed facts for `eligible` (D147(2), X1).** `eligible` requires every **decisive** fact to be `user_confirmed`, or `observed` / `derived` from confirmed or observed facts. If any decisive fact is only an `extracted_candidate`, the outcome is capped at `likely_eligible` (fixture alias `likely_eligible_missing_evidence`), and the missing item is the confirmation. Each spec's evaluation outline lists its decisive facts. Amount inputs are decisive for the **estimate**: an unconfirmed amount keeps the outcome at `likely_eligible` too, so no `eligible` packet ever carries an unconfirmed number.
2. **Fixture fact states → contract cell statuses (contract §2.5).** `user_confirmed` → `confirmed`; `observed` → `observed` (machine observation, e.g. an accepted price check); `derived` → `derived`; `extracted_candidate` → `candidate`; `conflicting` → `conflicting`; `missing` → `missing`; `assumption` → assumption-class `candidate` (R01 v1 only). A `missing` fact always has `value: null`.
3. **Conflicting facts (X2).** A `conflicting` fact carries `candidates: [{value, evidence}]`. The evaluator tests every candidate. If all candidates give the same outcome, the conflict is not material and the outcome stands. If they diverge, the outcome is `needs_facts`. Advisory dates (e.g. R03's conservative act-by) use the **earliest** candidate. Every file has one variant where both candidates fall on the same side.
4. **Not yet due (D147(6), X3).** A path that is not ripe yet is outcome **`not_yet_due`** with `reevaluate_at` (an ISO date) or `reevaluate_when` (a named event, e.g. "MBR filed"). It is never `not_eligible`. `not_eligible` means "not under this rule on these facts". Contract note: M01's `evaluationOutcome` has no `not_yet_due` value yet — the architect must add it before a loader can map it (flagged to the lead).
5. **Dates (D147(3), X4).** Every pack header records **published** (Federal Register date), **effective** and **compliance** dates separately, each from `sources/federal-register-notices.txt` or marked "not captured". eCFR source notes carry publication citations, not effective dates.
6. **Calendar-day zone (D147(4), X6).** Every deadline row names the time zone that defines a calendar day. Where the source does not say, the choice is a labelled assumption.
7. **Captured support (D147(5)).** Every normative statement in a spec cites a passage in `sources/`. Anything else is labelled **assumption** or **guidance-only** or is removed. Informational figures not used by any evaluator are removed rather than left uncaptured.
8. **Missing source (X5).** Each fixture file has a "no current source record" variant → `source_unverified`.

## From spec to evaluator (for the architect and backend engineers)

Each spec section maps to one field of M01's `RulePack<S, P>` (contract §7):

| Spec section | `RulePack` field | Notes |
|---|---|---|
| header: stable id, version, review status | `ruleId`, `version`, `lifecycle`, `review` | `version` is an integer in code (`v1` → `1`) |
| header: authority class/subtype | `authority: {class, subtype}` | classes: legal entitlement, contract benefit, merchant/carrier promise, settlement/program/goodwill |
| header: jurisdiction; §2 applicability | `jurisdiction`, `applicability` | "unsupported" when outside, never "not eligible" |
| §3 trigger | `trigger` | |
| §5 required facts (typed table) | `requiredFacts` (fact keys + types) | missing ≠ false |
| §6 exclusions | `exclusions` | |
| §7 remedy, §8 calculation/cap | `remedies[]`, `calculation`, `cap` | integer minor units; a cap is never an estimate |
| §9 evidence checklist | `evidenceChecklist` | |
| §10 notice requirements | `notice` | incl. whether email preserves a formal right |
| §11 deadlines | `deadlines: DeadlineSpec[]` | anchor event, count, unit (calendar/business/working), inclusive boundary, sent vs received, unknown-anchor behaviour |
| §12 channel + escalation | `channels` | |
| §13 passages, §14 source register | `sources: RuleSource[]` | `passageId` = the `P-…` / `DOT-…` ids; `capturedPath` + `capturedSha256` from `manifest.json` |
| refresh policy | `review.refreshPolicy` | |
| §15 limitations and conflicts | `knownLimitations` | conflicts are preserved, never blended |
| §16 evaluation outline | `evaluate` | ordered checks → one outcome; exhaustive precedence in `deriveOutcome` |
| fixtures/R0x.json | `fixturesPath` | expected values written by hand from the passage; the evaluator must pass them unchanged |
| numeric thresholds (3 h/6 h, 12/15/30 h, 60 days, 7 business / 20 calendar days, 30/50 days, $4,700) | `params: P` | each param cites its passage id; no literal legal number in evaluator code without one |

### Outcome vocabulary mapping

| Fixtures / specs (mission §9 wording) | M01 `evaluationOutcome` |
|---|---|
| `eligible` | `eligible` |
| `likely_eligible_missing_evidence` | `likely_eligible` (same meaning: rule applies, facts known, evidence or an assumption outstanding) |
| `possible_contract_benefit` | `possible_contract_benefit` |
| `needs_facts` | `needs_facts` |
| `manual_review` | `manual_review` |
| `not_eligible` | `not_eligible` |
| `deadline_passed` | `deadline_passed` |
| `source_unverified` | `source_unverified` |
| `unsupported` | `unsupported` |
| `not_yet_due` (D147(6)) | **none yet** — contract change needed; do not map it to `not_eligible` |

A fixture loader should map `likely_eligible_missing_evidence` → `likely_eligible`. The fixtures keep the mission's longer name so the expected meaning is explicit.

### Fixture format (`recoup.rule-fixtures/v1`)

**Canonical schema** (the M08 loader validates against this list, not against any one file):

| Element | Allowed values |
|---|---|
| Fact `type` | `enum`, `string`, `datetime` (ISO-8601 with UTC offset), `date` (`YYYY-MM-DD`), `boolean`, `integer`, `money` (`{amount_minor: int, currency: ISO-4217}` plus descriptive keys such as `label`, `note`), `money[]` (array of money), `observation` (a price observation: money plus `variantMatch`, `confidence`, `isRange`, `observedAt`, `source`, `seller`, `store_id`, `channel`, flags such as `is_clearance`), `object`, `array` |
| Fact `state` | `user_confirmed`, `observed`, `derived`, `extracted_candidate`, `conflicting` (requires `candidates: [{value, …}]`), `missing` (value `null`), `assumption` (assumption-class; R01 v1) |
| Fact keys | `type`, `value` (always present; `null` when missing), `state`, optional `candidates`, plus descriptive keys (`evidence`, `note`, `from`) |
| Top-level keys | `schema`, `rule_id`, `rule_version` (`v<N>`), optional `tier`, `spec`, `construction`, `conventions` (must include `outcome_vocabulary` and `loader`), `cases` |
| Case keys | `id`, `title`, `categories`, optional `path`, `clock`, `source`, `facts` \| (`facts_from` + `facts_override`), `expected`, `variants`, `action`, `context`, `justification`; annotations `mission_domain_fixture`, `window_end`, `applies_from` |
| Variant keys | `id`, optional `change`, `clock`, `source`, `action`, `context_change`, `expected`, `justification`; annotations `delta`, `day`, `delay`, `drop` |
| `source` | `{last_verified_on: date, refresh_window_days: int, note?}` or `{record: "missing", note?}` |
| `expected` | exactly one of `outcome` or `results: [{path, outcome, …}]`; other keys are carried through for the test to assert (`missing_facts`, `unconfirmed_decisive_facts`, `assumptions`, `amount`, `deadline`, `claim`, `reevaluate_at`, `reevaluate_when`, `next_action`, `packet_readiness`, `dedupe`, `overlap`, `totals`, `forbidden_outputs`, `note`, …) |
| `categories` | lower-case tags; every file covers each mission §17 group: `positive`, `negative`, `missing_fact`, `contradictory_fact`, `boundary_time`, unsupported (`unsupported_jurisdiction` \| `unsupported_product` \| `unsupported_payment`), stale/missing source (`stale_source` \| `stale_or_changing_source` \| `missing_source`), `exclusion`, `duplicate_evaluation`, `overlapping_remedy` |
| File ↔ manifest | each `fixtures/<stem>.json` has exactly one `manifest.json` pack whose `fixtures` is that path and whose `scenarioId` equals `<stem>` (so the R01 merchant-pack tier is `R01v2`, rule_id `R01v2.…`) |


- `conventions` in each file define fact encoding (`{type, value, state}` with `state ∈ user_confirmed | observed | derived | extracted_candidate | conflicting | missing | assumption`; mapping in cross-pack rule 2), money (`amount_minor` + ISO-4217, on every money object including exclusions), calendars, and deadline meaning. `conflicting` facts carry `candidates` (cross-pack rule 3).
- A case has **either** a top-level `expected` **or** an `expected` on every variant. `clock` (ISO-8601 with offset) and optional `source` (`last_verified_on`, `refresh_window_days`) may be set on the case or on a variant; the variant wins.
- `facts_from: "<case id>"` + `facts_override: {…}` copies another case's facts. A variant's `change` replaces the named facts for that variant.
- `expected` may also carry `reevaluate_at` / `reevaluate_when` (for `not_yet_due`), `missing_facts`, `amount`, `deadline` (`kind`, `date`, `semantics`, `anchor`), `packet_readiness`, `dedupe`, `overlap`, `totals`, and `forbidden_outputs` (things the UI or evaluator must **not** produce, e.g. displaying a liability cap as the payout).
- `justification.passages` cite passage ids from the spec or `sources/federal-web-pages-excerpts.md`.
- `context` holds non-fact state (existing claims on the item, price history, unconfirmed offers); a variant's `context_change` replaces named entries. `action` defaults to `evaluate`; R01-05d uses `send_existing_claim` to test the late-send warning.
- `fixtures/R01.json` covers the **R01 v1 legacy snapshot tier** (contract rev 4 §2.7, task M1C). Its best outcome is `likely_eligible`; it has no staleness → `source_unverified` case (rule 3 exception).
- `fixtures/R01v2.json` covers the **R01 v2 merchant-pack tier** (R01 spec §1–§7): known effective-date mismatch → `source_unverified` + ask anyway; unknown → capped; per-merchant window `constrains`; 7-day pack refresh.
- Every fixture clock must be injected as `now`. Evaluators must not read the wall clock (D138).

## Captured sources

`sources/*.txt` are tag-stripped renderings of US federal text fetched from the eCFR versioner API (point-in-time 2026-09-18) or govinfo. Each file header records the URL, method, and the SHA-256 of the raw response. `sources/federal-web-pages-excerpts.md` holds verbatim excerpts of DOT, FTC and CFPB pages and Federal Register notices. `transportation.gov` and `consumerfinance.gov` return 403 to non-browser clients, so those were read in a real browser pane and have no raw hash. Merchant and card-issuer texts are **not** stored (copyright). Specs quote at most two sentences and link the rest. Downloaded PDFs are identified by SHA-256 in TRIAGE.md.

## Status on 2026-09-23

All five Phase-1 packs are `researched`. None is `reviewed` or `active`. R06–R25 are triaged only (see `TRIAGE.md`).
