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
3. **Staleness blocks conclusions.** Each pack has a refresh window (R02 30 days, R03 90, R04 30 with monthly checks until the 2026 biennial adjustment, R05 180, R01 merchant packs 7). An evaluation whose pack was last verified outside the window returns `source_unverified`. Fixtures `R0x-10/11` test this.
4. **Text presence ≠ legal force.** eCFR still displays §1026.62 (overdraft rule disapproved by Pub. L. 119-10) and the stayed §1026.52 $8 late-fee safe harbor. A pack records legal status separately (TRIAGE, cross-cutting finding).
5. **Temporal applicability.** A pack version applies to a transaction only if its effective date is on or before the anchor date and no later version was effective at the anchor. When applicability is unknown, see R01 §1.4 (unknown → capped at likely eligible with an explicit assumption; known mismatch → `source_unverified`).

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

A fixture loader should map `likely_eligible_missing_evidence` → `likely_eligible`. The fixtures keep the mission's longer name so the expected meaning is explicit.

### Fixture format (`recoup.rule-fixtures/v1`)

- `conventions` in each file define fact encoding (`{type, value, state}` with `state ∈ user_confirmed | extracted_candidate | derived | missing | conflicting`), money (`amount_minor` + ISO-4217), calendars, and deadline meaning.
- A case has **either** a top-level `expected` **or** an `expected` on every variant. `clock` (ISO-8601 with offset) and optional `source` (`last_verified_on`, `refresh_window_days`) may be set on the case or on a variant; the variant wins.
- `facts_from: "<case id>"` + `facts_override: {…}` copies another case's facts. A variant's `change` replaces the named facts for that variant.
- `expected` may also carry `missing_facts`, `amount`, `deadline` (`kind`, `date`, `semantics`, `anchor`), `packet_readiness`, `dedupe`, `overlap`, `totals`, and `forbidden_outputs` (things the UI or evaluator must **not** produce, e.g. displaying a liability cap as the payout).
- `justification.passages` cite passage ids from the spec or `sources/federal-web-pages-excerpts.md`.
- Every fixture clock must be injected as `now`. Evaluators must not read the wall clock (D138).

## Captured sources

`sources/*.txt` are tag-stripped renderings of US federal text fetched from the eCFR versioner API (point-in-time 2026-09-18) or govinfo. Each file header records the URL, method, and the SHA-256 of the raw response. `sources/federal-web-pages-excerpts.md` holds verbatim excerpts of DOT, FTC and CFPB pages and Federal Register notices. `transportation.gov` and `consumerfinance.gov` return 403 to non-browser clients, so those were read in a real browser pane and have no raw hash. Merchant and card-issuer texts are **not** stored (copyright). Specs quote at most two sentences and link the rest. Downloaded PDFs are identified by SHA-256 in TRIAGE.md.

## Status on 2026-09-23

All five Phase-1 packs are `researched`. None is `reviewed` or `active`. R06–R25 are triaged only (see `TRIAGE.md`).
