# M09 — Independent spec review of rule packs R01–R05

| Field | Value |
|---|---|
| Task | M09 — spec-level review before any pack can become `active` (mission §8 lifecycle; D145 DA-A-11(a)) |
| Reviewer | `opus-rules-reviewer` (Opus 5.5, `claude-opus-5-5`). Independent of `opus-rules-researcher`; the researcher was not consulted. |
| Date | 2026-09-23 |
| Base revision | `c6e0371` (no change to `docs/rules/**`, `docs/team/DECISIONS.md` or the mission doc since `0b7084b`) |
| Inputs | mission §8, §9, §10, §17; D143, D144, D145; `docs/rules/README.md`; specs R01–R05; fixtures R02–R05; `docs/rules/sources/*` |
| Output | this file only. It changes no lifecycle value. Per README and D145, the lead records `reviewed`/`active` in DECISIONS. |

> **Engineering review is not legal certification.** This review checks whether each spec says what the captured first-party text says. It checks whether each fixture follows from that text. It does not give legal advice or certify legal compliance. A verdict of `approve_*` means only "independently reviewed against the captured first-party text" (D145 DA-A-11(a)).

---

## 0. Summary

| Pack | Verdict | Blocking edits | `unsupported` / `contradicted` claims | Fixture outcome disagreements | Fixture construction defects |
|---|---|---|---|---|---|
| R01 retail price adjustment | **reject** (resubmit). The four sample merchant passages check out verbatim against the live pages. The pack can't be activated as written. | 6 (§R01.6) | 0 source claims. 1 internal contradiction. | n/a — **no fixtures exist** | n/a |
| R02 airline fare refund | **approve_with_changes** | 7 (§R02.6) | 1 unsupported (partial-itinerary refund scope) | 0 of 17 | 3 (R02-07, R02-11, R02-05 convention) |
| R03 credit billing error | **approve_with_changes** | 5 (§R03.6) | 1 contradicted (effective-date label). 3 not in captures. | 0 of 15 | 2 (R03-07, R03-04 text) |
| R04 baggage | **approve_with_changes**. Also needs a lead ruling on the D143(4) wording. | 8 (§R04.6) | 3 not in captures (one confirmed true by the reviewer) | 0 of 15 | 3 (R04-09, R04-01 text, R04-04 convention) |
| R05 MITOR shipment | **approve_with_changes** | 7 (§R05.6) | 1 contradicted (effective date). 2 not in captures. | 0 of 18 | 3 (R05-10, R05-03 text, R05-05b tz) |

"Not in captures" means the spec states it as fact, but no file in `docs/rules/sources/` contains it. Cross-cutting items X1–X6 (§1) apply to every pack. They are counted in each pack's blocking edits where they block.

**Outcome verdicts.** I decided every fixture before reading its `expected` block. For all 65 runnable case/variant results in R02–R05 (48 cases + 22 variants), my outcome, amount and deadline dates match the fixture's. The defects are in how some fixtures are **built**:
- The expected value can't be derived from the fixture's facts.
- Prose makes a claim the sources don't support.
- The spec doesn't state a rule the fixture silently assumes.

---

## 1. Method and integrity checks

### 1.1 Capture hashes

| File | SHA-256 (computed) | manifest `capturedSha256` | Match |
|---|---|---|---|
| ecfr-12cfr1005.11ab-excerpt.txt | 16e13c2a…1940 | 16e13c2a…1940 | yes |
| ecfr-12cfr1026-suppI-13.txt | a0ed1cac…c2d8 | a0ed1cac…c2d8 | yes |
| ecfr-12cfr1026.12c-excerpt.txt | 0ee951da…f439 | 0ee951da…f439 | yes |
| ecfr-12cfr1026.13.txt | c08ddd0f…a0f | c08ddd0f…a0f | yes |
| ecfr-14cfr250.txt | 4955755f…c65c | 4955755f…c65c | yes |
| ecfr-14cfr254.txt | 2da86030…6bd4a | 2da86030…6bd4a | yes |
| ecfr-14cfr260.txt | d6371ba3…9d5a | d6371ba3…9d5a | yes |
| ecfr-14cfr399.80l-excerpt.txt | 64d5ec8b…bdf | 64d5ec8b…bdf | yes |
| ecfr-16cfr435.txt | 7faa2022…55b1 | 7faa2022…55b1 | yes |
| federal-web-pages-excerpts.md | 570f8186…b8e | 570f8186…b8e | yes |
| usc-15-1666.txt | e67549bf…70a2 | e67549bf…70a2 | yes |
| usc-49-42305.txt | 4295929a…8f99 | 4295929a…8f99 | yes |
| fixtures/R02.json … R05.json | bc1e8fb5…, c82d3124…, 9e03d540…, 4a617860… | same | yes (all four) |

All 12 captures and 4 fixture files match `manifest.json` byte for byte. I relied on them.

### 1.2 Primary-source re-checks

These are outside the repo. The brief allows re-checks where a capture is missing, truncated or ambiguous. All web content was treated as data.

| Why | Source | Method | Result |
|---|---|---|---|
| R01 has **no in-repo capture** (merchant text not stored for copyright reasons) | apple.com `retail_us.html` | curl; tag-strip; text search | Passage AP-1 plus the 10-unit / proof-of-possession sentence match verbatim. No effective date shown. **Raw-HTML SHA-256 today = `9e6012…6d77` ≠ manifest `99bc75…5d2`**, although the passage text is identical. `consumer_us.html` → HTTP 404, as the spec says. |
| same | Costco a_id/628 | curl | CO-1, CO-2, the promo-window rule, "5 to 10 business days", the warehouse Returns counter and "no competitor / no warehouse price" all match. No effective date shown. |
| same | Target Price Match Guarantee | curl | TG-1 and its exclusions match: same-store-only, no screenshots, GiftCard/coupon/clearance and "Other exclusions may apply". No effective date shown. **The page also has a separate Target Plus Partner clause that the spec omits.** |
| same | Best Buy PMG and Return & Exchange | WebFetch (model-mediated, so **lower assurance** than a raw capture). curl was blocked. | "Effective date: September 2, 2026", BB-1 and BB-2 match. Return policy "Effective date: February 23, 2026", BB-3, and 15/60/14 days plus Verizon 30 days match. |
| FR rows in the excerpts file are table summaries, not passages | federalregister.gov API (`/api/v1/documents/<n>.json`) | JSON `dates` / `abstract` / `effective_on` | See temporal findings in each pack. **2014-22092 (79 FR 55615) effective 2014-12-08**. 2016-24503 effective date delayed to **2019-04-01** (83 FR 6364). 2024-23588 abstract: **$3,800 → $4,700**, effective 2025-01-22. 2025-02814: *enforcement* delayed to 2025-03-20. 2025-22140: pause from 2025-12-05 **until 2026-06-30**. 2026-13675: extension "As of July 7, 2026" to 2027-07-07. 2025-20042: ANPRM withdrawn as of 2025-11-17. 2024-07177 effective 2024-06-25. 2024-17602 effective 2024-08-12. |

`transportation.gov` and `consumerfinance.gov` were not re-fetched; they return 403 to non-browser clients. DOT-*, FTC-* and CFPB-* passages are judged as captured. Where a spec relies on them, this review says so.

### 1.3 Fixture procedure

For each file I printed the cases with every `expected` and `justification` key removed (`jq 'del(.. | .expected?)'`). I wrote down outcome, missing facts, amount and deadline from the primary text. Only then did I print the `expected` blocks and compare. I recomputed every date, duration and sum with a script: business/working days use the 5 U.S.C. 6103 holidays that appear (2026-09-07, 10-12, 11-11), and durations use instant arithmetic.

### 1.4 Verdict vocabulary

- `supported` — the quoted text says it.
- `supported_with_caveat` — the text supports it, with a qualification the spec should carry.
- `unsupported` — no captured text supports it as stated.
- `contradicted` — a primary text says otherwise.
- `assumption-honest` / `assumption-mislabelled` — for items the spec marks as assumptions.
- `guidance-only` — supported only by agency web guidance, not by the regulation.

### 1.5 Cross-cutting findings (all packs)

| # | Finding | Evidence | Required change |
|---|---|---|---|
| **X1** | **The fact-state threshold for `eligible` is undefined.** Mission §9 says `eligible` means "eligible under the evaluated rule and confirmed facts". Yet most `eligible` fixture results rest on at least one `extracted_candidate` fact (e.g. R02-01 `event_type`, `fare_paid`; R04-01 `mbr_filed`; R05-01 `properly_completed_order_at`). No spec or README says whether a verified-quote extraction counts as confirmed. | README "Fixture format"; mission §9 | Add to README and each fixture `conventions`: "`extracted_candidate` in fixtures denotes an extraction whose quote is **verified** under D145 DA-A-6 and counts as evidence-backed. An `unverifiable` extraction caps the outcome at `likely_eligible`." Or change the fixtures. Blocking for every pack: the evaluator can't pass fixtures whose threshold is unstated. |
| **X2** | **Conflicting-fact candidates are not encoded.** R02-07, R03-07, R04-09 and R05-10 set the fact to `{value:null, state:"conflicting"}`. The candidate values exist only in `expected.question` prose. So an evaluator can't test the spec's "straddles the threshold" rule. R03-07's `conservative_act_by` of 2026-09-30 is not computable from the fixture at all: it needs the candidate 2026-08-01. | the four fixtures | Encode the candidates as `value: {candidates: [...]}` or a `candidates` array on the fact, and document it in `conventions`. Add one variant per file where both candidates fall on the **same** side of the threshold (expected: no `needs_facts`). |
| **X3** | **"Not yet" states are encoded as `not_eligible` with the reason only in prose.** Examples: R05-04c, R05-05a/b, R05-07, and the spec's R04 `mbr_filed=false`. The UI and evaluator can't tell "never under this rule" from "re-evaluate on date D". Mission §9 says an expired path is not "no recovery", and the same care applies to paths that aren't ripe yet. | R05 §16 step 5; R04 §15 2.2 | Add a machine-checkable `expected.reevaluate_at` (date) or `expected.reason: "not_yet_due" \| "action_required"`, and specify it in the spec outlines. |
| **X4** | **Effective dates are mixed up with Federal Register publication dates.** eCFR source notes give the FR citation and **publication** date. Two headers present those as effective dates (R03, R05). The manifest copies them. | FR API (§1.2) | Relabel: `published` vs `effective` vs `compliance`. Where the effective date isn't captured, say so. |
| **X5** | **"Missing source" (no pack or source unavailable) is untested.** Only "stale source" is tested. Mission §17 lists "missing/stale source". | fixtures | Add one case per pack with no current source record → `source_unverified`. Not blocking. |
| **X6** | **The time zone that defines a calendar day is unspecified outside R02.** R05-05b uses 2026-08-31T23:00-04:00, which is 2026-09-01T03:00Z. The expected result is correct only if days are local (-04:00). R03 day 60 and R04 have the same exposure. | R05-05b; R03 §11 | Each spec's deadline table states the zone that defines a day: R03 the creditor's receipt location or consumer's zone as a labelled assumption; R05 the buyer's zone as a labelled assumption. |

---

## R01 — Retail price adjustment (framework + 4 sample merchant packs)

### R01.1 Claims

Merchant texts are copyrighted and are not reproduced here. "Verified" means a verbatim match on the live page on 2026-09-23 (§1.2).

| # | Claim | Spec loc. | Support | Verdict |
|---|---|---|---|---|
| R01-C1 | Authority is a merchant promise. There is no general US legal duty to refund a later price drop. | header | Framing; absence claim | supported |
| R01-C2 | Best Buy PMG displays effective date 2026-09-02 | §1.1, §7.1 | Best Buy page (WebFetch) | supported (lower-assurance fetch) |
| R01-C3 | Target and Apple pages show no effective date | §1.2 | curl text search found no "effective"/"updated" on Target, Costco or Apple | supported |
| R01-C4 | Costco says restrictions "will be shown at the point of purchase" | §1.3 | Costco page | supported |
| R01-C5 | Best Buy "may amend these terms at any time" | §1.3 | not re-checked | unverified by reviewer (non-normative) |
| R01-C6 | Temporal rule: known mismatch → `source_unverified`; unknown → capped at `likely_eligible` with assumption and missing fact `retail.policy_confirmed` | §1.4 | D143(1); mission §8 | supported. **Caveat:** D143(1) also requires a user-initiated "ask anyway" next action for the known-mismatch case. The spec doesn't have it. |
| R01-C7 | Bracketing captures (identical normalized hash at t1 ≤ p ≤ t2) permit applicability, labelled "unchanged between captures" | §1.4(b) | inference | assumption-honest |
| R01-C8 | `content_hash` = SHA-256 of normalized main-content text | §2 | — | supported as design. **The manifest records a raw-HTML hash for Apple that does not reproduce on the same day with identical text (§1.2).** Raw hashes can't serve as the change detector. |
| R01-C9 | Calculation: (paid − comparison) × min(qty, limit) − prior adjustments; 2 × 12,000 vs 9,500 → 5,000 | §4 | mission §17 | supported |
| R01-C10 | Undisclosed boundary → inclusive last day in the merchant's local time | §5 | — | assumption-honest |
| R01-C11 | Apple two clocks: drop within 14 calendar days of receipt; request within 14 days of the drop; 10 units; proof of possession | §5, §7.4 | Apple page (AP-1 + next sentence) | supported |
| R01-C12 | Best Buy: own-price drop "during the return and exchange period"; competitor match at time of sale only; window anchored on receipt; 15/60/14 days, Verizon 30 | §7.1 | BB-1, BB-2, BB-3 and return page | supported. **Caveat:** BB-1 limits when **the price is lowered**, not when the **request** is made. The spec's `window` model `{length, unit, anchor, inclusive}` has no field for which event must fall inside the window (see R01.4). |
| R01-C13 | Target: 14 days from purchase; Target.com or local-store price; same-store-only; no screenshots; listed exclusions; "other exclusions may apply" | §7.2 | Target page | supported. **Omission:** Target Plus Partner items have a separate clause (match against Target.com only). |
| R01-C14 | Costco: price reduces within 30 days of purchase; sole-discretion clause; promo window; no competitor or warehouse match; 5–10 business days; warehouse via Returns counter | §7.3 | Costco page | supported. **Omission:** CO-1 excludes resellers; §3 has no reseller/membership fact for Costco. |
| R01-C15 | Apple online-store policy page returns 404 → online purchases `source_unverified` | §7.4 | curl 404 | supported |
| R01-C16 | Home Depot is source_blocked; the snippet is a lead only | §7.5 | not re-checked | honest |
| R01-C17 | ShopSavvy is context only | §3 | mission §10 | supported |

### R01.2 Fixtures

**None.** `manifest.json` has `"fixtures": null` for R01. Mission §8 requires "test fixtures" in every activated pack. Mission §17 requires the core financial fixture: "two units at 12,000 with eligible matching price 9,500 → 5,000 difference; wrong variant/currency or unsupported policy → no false price claim". D143(1) requires that "the reviewed tier … gets its own fixtures". Nothing can be checked here.

### R01.3 Temporal accuracy and source conflicts

- Best Buy 2026-09-02 (PMG) and 2026-02-23 (return policy) are correct. Target, Costco and Apple are correctly "not displayed".
- **Gap:** the Best Buy pack draws on **two** documents with different effective dates. The spec's temporal note mentions only 2026-09-02. The rule should state that a pack's `effective_from` = max(effective dates of every constituent source).
- There are no source conflicts to preserve.

### R01.4 Scope honesty and §10 completeness

- Scope is honest: merchant promise, discretion clause → "merchant decides", never a guaranteed amount.
- **Internal contradiction in §6:** `source_unverified` is defined as including "no captured pack for the merchant/channel", while `unsupported` is "merchant without a captured pack". The analogous "channel not captured" cases also diverge: Costco warehouse → `unsupported` (§7.3), but Apple online → `source_unverified` (§7.4).
- **Structural gap in the window model:** Best Buy and Costco (CO-1) constrain the **price-drop** date. Target ("bought … in the past 14 days") constrains the **request** date against purchase. Apple constrains both. Without a `window.constrains ∈ {price_change, request, both}` field per pack, the deadline engine can't compute `deadline_passed` correctly (mission §9: "Never infer the legal anchor from whichever date is easiest").

### R01.5 Verdict — **reject (resubmit as R01 framework v1 + merchant packs with fixtures)**

The research is sound and every sample merchant passage matches its live page. It can't be activated because there are no fixtures. The remaining items are design edits; they don't fix the missing fixtures.

### R01.6 Required before resubmission

1. Add `docs/rules/fixtures/R01.json`, built independently. At minimum:
   - the mission §17 example (5,000);
   - wrong variant → no claim; wrong currency → no claim;
   - Best Buy purchase dated 2026-08-25 → `source_unverified` plus the "ask anyway" action;
   - Target/Costco/Apple purchase with unknown effective date → capped at `likely_eligible` with the assumption;
   - Apple two-clock boundaries (day 14 and day 15 on each clock);
   - Costco discretion → no guaranteed amount;
   - Target cross-store → `not_eligible`;
   - ShopSavvy-only comparison → no claim;
   - quantity above the limit (Apple 10);
   - stale pack (> 7 days) → `source_unverified`;
   - duplicate evaluation.
2. §2: add `window.constrains ∈ {price_change, request, both}` with a passage id per pack. Set Best Buy = price_change (BB-1), Target = request (TG-1), Costco = price_change (CO-1; promo items also request-bounded), Apple = both.
3. §6: resolve the `unsupported`/`source_unverified` contradiction. Suggested: merchant with no pack at all → `unsupported`; merchant pack exists but channel or version not captured, or pack stale → `source_unverified`. Apply the same rule to §7.3 and §7.4.
4. §1.4: add D143(1)'s user-initiated "ask anyway" next action for the known-mismatch case. Add "pack `effective_from` = max over constituent sources" (Best Buy has two).
5. Manifest and §2: record `content_hash` of the **normalized** captured text for each merchant pack. Keep `rawResponseSha256` as provenance only, never for change detection.
6. §7.2 and §7.3: add Target Plus Partner items (separate clause, or out of scope) and the Costco reseller exclusion (fact or limitation).

---

## R02 — Airline fare refund (14 CFR 260 / 49 U.S.C. 42305 / 14 CFR 399.80(l))

### R02.1 Claims

| # | Claim | Spec loc. | Supporting passage (captured, verbatim) | Verdict |
|---|---|---|---|---|
| R02-C1 | Covered flight = scheduled, covered carrier, to/from/within the US | header, §2.1 | 260.2: "Covered flight means a scheduled flight operated or marketed by a covered carrier to, from, or within the United States, including itineraries with brief and incidental stopover(s) at a foreign point without a break in journey." | supported |
| R02-C2 | Part 260 effective 2024-06-25, amended 2024-08-12; refund compliance 2024-10-28 | header | FR-2024-07177-COMPLIANCE: "…regulated entities will have six months from the date of publication of the final rule, or October 28, 2024, to implement the relevant requirements." Effective dates confirmed via FR API. | supported_with_caveat. The outline has **no temporal gate**: an incident before 2024-10-28 would be evaluated under part 260 (see R02.3). |
| R02-C3 | §42305 added 2024-05-16 | header | usc-49-42305: "(Added Pub. L. 118–63, title V, §503(a), May 16, 2024, 138 Stat. 1188.)" | supported |
| R02-C4 | Covers airfare refund only when the consumer does not take the changed flight and does not accept a voucher | §1 | 260.1(c): "Airfare including nonrefundable airfare for a flight that is cancelled or significantly changed where the consumer does not accept the significantly changed flight or rebooking on an alternative flight, or accept any voucher, credit, or other compensation offered by the carrier." | supported |
| R02-C5 | No federal cash compensation for delay; ANPRM withdrawn 2025-11-17 | §1 | Excerpts: table row only. FR API `dates`: "…withdrawing the advance notice proposed rulemaking published December 11, 2024 (89 FR 99760) as of November 17, 2025." | supported_with_caveat. Absence claim; the withdrawal passage should be captured verbatim. |
| R02-C6 | Downgrade fare difference while still flying → `manual_review` | §1, L4 | DOT-REF-6: "…the airline must refund the difference between the original fare and the downgraded fare." Part 260 has no such text. | guidance-only; labelled honestly |
| R02-C7 | Nonrefundable ticket required; refundable → `unsupported` | §2.2 | 260.6(a)(1): "…to a consumer that holds a nonrefundable ticket on a scheduled flight to, from, or within the United States…" | supported |
| R02-C8 | Carrier merchant of record → automatic refund | §2.4 | 260.6(a)(1): "A covered carrier that is the merchant of record must provide a full and prompt refund of the airfare, including any taxes and ancillary fees…" | supported |
| R02-C9 | Ticket agent merchant of record → refund on request; carrier informs agent | §2.4 | 399.80(l): "Failing to make a prompt refund of airfare (including any taxes and ancillary fees) to a consumer, upon request, … when the ticket agent is the merchant of record." 260.6(d): "…must inform the ticket agent without delay whether the consumer is eligible for a refund…" | supported |
| R02-C10 | Merchant of record = entity on the charge statement | §5 | 260.2: "Merchant of record means the entity … as shown in the consumer's financial charge statements, such as debit or credit card charge statements." | supported. Cash/check buyers have no card statement, so §5 should allow the receipt as the source. |
| R02-C11 | A renumbered flight is a cancellation under the text | §4, L1 | 260.2: "Cancelled flight … means a covered flight with a specific flight number … published in the carrier's Computer Reservation System at the time of the ticket sale but not operated by the carrier." FR 2025-22140 abstract says the same. | supported |
| R02-C12 | Significance criteria 1–7 with 3 h / 6 h thresholds | §4 | 260.2 (1): "…three hours or more for domestic itineraries and six hours or more for international itineraries earlier than the original scheduled departure time;" (2): "…three or more hours for domestic itineraries or six or more hours for international itineraries after the original scheduled arrival time;" (3)–(7) as quoted in spec §13 | supported |
| R02-C13 | Exactly 3:00 is significant; 2:59 is not; compare UTC instants | §4 | "three or more hours" | supported. The UTC comparison is the only coherent reading across time zones. |
| R02-C14 | The statute sets 3 h / 6 h arrival as a floor | §4, L9 | 42305(d): "…includes, at a minimum, a flight where the passenger arrives at a destination airport— (1) in the case of a domestic flight, 3 or more hours after the original scheduled arrival time…" | supported_with_caveat. The statute says the passenger **arrives**; the regulation says the consumer **is scheduled to arrive**. The spec should record this as a preserved nuance: when the revised schedule is below the threshold and actual arrival is above it (or the reverse) → `manual_review`. |
| R02-C15 | Deemed-request events (i)–(iii) | §4 | 260.6(a)(2)(i)–(iii) as quoted in spec P-260.6-A2; 42305(f) identical | supported |
| R02-C16 | Silence ≠ acceptance of a voucher | §4 | 260.7: "A covered carrier must not deem a consumer to have accepted an offer for travel credits, vouchers, or other compensation … unless the consumer affirmatively agrees…" | supported |
| R02-C17 | Flying, or accepting rebooking, disqualifies; accepted-then-not-flown → `manual_review` | §4, L5 | 260.6(a)(1)(i): "…where the consumer chooses not to: (i) Fly on the significantly delayed or changed flight or accept rebooking on an alternative flight" | supported. The `manual_review` for reversal is an honest gap label. |
| R02-C18 | Full refund including taxes and ancillary fees, original form unless a cash equivalent is agreed, no processing fee | §7 | 260.10: "…the refund must be issued promptly in the original form of payment … unless the consumer agrees to receive the refunds in a different form of payment that is a cash equivalent… Carriers may not retain a processing fee for issuing refunds that are due." | supported |
| R02-C19 | `refund_due = fare + taxes + Σ ancillary fees (for the affected flight) − already_refunded` | §8 | 260.6(a)(1) says only "full and prompt refund of the airfare, including any taxes and ancillary fees". Nothing addresses a partly flown itinerary (e.g., outbound flown, return cancelled) or limits fees to "the affected flight". | **unsupported** as stated. It's an unlabelled assumption, and it can overstate the amount when part of a ticket was used. |
| R02-C20 | Ticket agent may keep a disclosed per-passenger service fee | §8 | 399.80(l): "A ticket agent may retain a service fee charged when issuing the original ticket to the extent that service is for more than processing payment for a flight that the consumer found. That fee must be on a per-passenger basis and its existence, amount, and the non-refundable nature if that is the case must be clearly and prominently disclosed…" | supported |
| R02-C21 | No consumer filing or federal claim deadline for R02.a | §10 | Absence in part 260 / 42305 | supported_with_caveat (absence claim) |
| R02-C22 | Carrier may set an offer-acceptance deadline; non-response plus departure is still a deemed request | §10 | DOT-REF-7; 260.6(a)(2)(iii)(A): "…and the flight departs without the consumer" | supported (guidance plus regulation) |
| R02-C23 | Carrier must notify of the change and of the refund right | §10 | 260.9(b): "…notify passengers owed a refund pursuant to § 260.6(a) and (b) of their right to receive a refund." | supported |
| R02-C24 | Email/app/chat rejection is sufficient evidence | §10 | The text is silent on the channel for rejection | supported_with_caveat. Product assumption; label it as one. |
| R02-C25 | Credit card: 7 business days after the anchor; count starts the next day; 7th day inclusive | §11 | 260.2: "Prompt refund means refunds made within 7 business days after the earliest date the refund was requested as set forth in § 260.6(a)(2)…"; "Business days means Monday through Friday, excluding Federal holidays in the United States." | supported |
| R02-C26 | Cash, check, **debit**, other: 20 calendar days | §11 | 260.2: "…within 20 calendar days after the earliest date the refund was requested … for cash, check, debit card, or other forms of purchases." 42305(b)(2): "not later than 20 days" | supported |
| R02-C27 | Anchor list for R02.a | §11 | 260.6(a)(2)(iii)(B): "…by the date on which the cancelled flight was scheduled to depart **or the date that the significantly delayed or changed flight departs**." | supported_with_caveat. (a) The table lists only the cancelled-flight date for the voucher-non-response anchor and omits the changed-flight departure. (b) For (a)(2)(i) "cancellation with nothing offered", the text gives no date; the spec should label its choice (cancellation notice instant vs scheduled departure) as an assumption. |
| R02-C28 | R02.b credit: 7 business days from the agent's receipt of carrier information; other: 20 calendar days from refund becoming due | §11 | 399.80(l): "A prompt refund is one that is made within 7 business days of the ticket agent receiving information from a carrier as specified in 14 CFR 260.6(d), … and within 20 calendar days of refund becoming due for cash, check, debit card, or other forms of purchases." | supported |
| R02-C29 | "On or about" when the anchor is within ±12 h of midnight in any relevant zone | §11, A1 | — | assumption-honest, **but the rule is defective**: every instant is within 12 h of some midnight, so the condition is always true. |
| R02-C30 | Holidays = 5 U.S.C. 6103 | §11, A2 | 260.2 "Federal holidays in the United States" | assumption-honest |
| R02-C31 | R03 fallback: 1026.13(a)(3) or (a)(4) | §12.4 | 1026.13(a)(4): "…the creditor's failure to credit properly a payment or other credit **issued** to the consumer's account." | supported_with_caveat. (a)(4) applies only if a credit was issued. A refund that is owed but never issued fits (a)(3). |
| R02-C32 | DOT does not enforce for renumbered-only flights until 2027-07-07 | L1 | FR-2026-13675-DATES: "…extending the pause … for flights that are merely renumbered. This enforcement discretion is extended for 1-year from the date of this publication, expiring on July 7, 2027." | supported_with_caveat. The history is missing; see R02.3. |
| R02-C33 | Refund-timing conflict preserved: regulation 20 calendar days vs DOT-REF-3 "20 business days" | L2 | DOT-REF-3: "…within 7 business days (for credit card purchases) or 20 business days (for cash purchases) after the airline becomes aware that you don't accept the alternative…" vs 260.2 as in C26 | supported. Preserved, not blended. |
| R02-C34 | `operational_delay_only` → `not_eligible` | §16 step 3 | 260.2: "Significantly delayed or changed flight means a covered flight itinerary with a **delay** or change made by a covered carrier where, as the result of the delay or change: …" | supported_with_caveat. Only correct when the delay is **below** the thresholds. A same-day delay of ≥ 3 h domestic that the consumer declines is a significantly delayed flight. The step's "with no qualifying change" is ambiguous and the enum name invites misclassification. |
| R02-C35 | Ancillary and bag fees "must be requested from the airline" even when an agent charged them | §17.3 | DOT-REF-8: "…you must request a refund from the airline." vs 260.4(a): "…the carrier that operated the flight … is responsible for providing a prompt and **automatic** refund…" | guidance-only; **undisclosed guidance-vs-regulation tension**. Record it as a conflict. The regulation governs (automatic); DOT-REF-8 names who to contact if the refund doesn't arrive. |

### R02.2 Fixtures (decided before reading `expected`)

| Case | My independent result | Fixture | Agree? | Note |
|---|---|---|---|---|
| R02-01 | eligible, path a; 44,880 USD; carrier deadline 2026-10-13 (anchor 10-01; 10-12 holiday) | same | agree | Rests on X1 (extracted_candidate) |
| R02-01b | eligible, path b; request the refund from the agent; deadline not computable | same | agree | — |
| R02-02a | not_eligible (2h59m) | same | agree | — |
| R02-02b | eligible; 25,020; 2026-11-12 (11-11 holiday) | same | agree | "three or more hours" is inclusive; boundary correct |
| R02-02c | eligible; 25,020; 2026-11-12 | same | agree | — |
| R02-03 | not_eligible (flew; change was 3h01m) | same | agree | — |
| R02-04 | needs_facts [consumer_response] | same | agree | 3h30m change is significant |
| R02-05 | not_eligible; no cash compensation | same | agree | **Convention break:** `delay_cause_controllable` = `{value:"unknown", state:"missing"}`. The file's conventions say a missing fact has `value: null`. First reported by the M08 fixture loader (QA); the reviewer confirmed it. |
| R02-06 | eligible; 73,045; 2026-10-21 (20 calendar days); disclose DOT-REF-3 (literal reading 2026-10-30) | same | agree | — |
| R02-07 | needs_facts [changed_sched_arrival_at] | same | agree | **Construction defect X2**: candidates 4:10 pm and 3:40 pm appear only in the question text |
| R02-08 | unsupported | same | agree | — |
| R02-09a | not_eligible (affirmative acceptance) | same | agree | — |
| R02-09b | eligible; 21,210; 2026-10-26 (anchor 10-15 per (iii)(B)) | same | agree | `already_refunded` absent: amount is gross; fine |
| R02-10 | manual_review | same | agree | The consumer **rejected** the renumbered flight. The pause text covers a passenger who "is successfully rebooked on the new flight", so this case is arguably outside the pause. Manual review is still right. |
| R02-10b | source_unverified | same | agree | — |
| R02-11 | source_unverified (84 days > 30) | same | agree | **Construction defect**: facts come from R02-01 (response on 2026-10-01) but the clock is 2026-09-23, so facts post-date `now`. Move the clock to ≥ 2026-10-02 and `last_verified_on` back to keep > 30 days. |
| R02-12 | eligible; reuse the opportunity; R12 alternative, not additive; total 44,880 | same | agree | — |

**Boundaries.** R02-02 checks arrival at 2:59, 3:00 and 3:01 against "three or more hours" — correct. **Missing** (recommended, not blocking):
- departure-earlier 3 h boundary;
- international 6 h boundary;
- same-day operational delay ≥ 3 h where the passenger did not fly (would catch C34);
- partly flown round trip → `manual_review` amount (C19);
- incident before 2024-10-28 (R02.3).

### R02.3 Temporal accuracy and source conflicts

- **Compliance date not used by the outline.** Part 260's refund provisions have a compliance date of 2024-10-28 (C2). Per mission §8 and README rule 5, an incident before then must not be evaluated under v1 → `source_unverified` or `unsupported`.
- **Renumbered-flight pause history.** FR 2025-22140 `dates`: "As of December 5, 2025, the Department is pausing until June 30, 2026…". FR 2026-13675: "As of July 7, 2026, … extending the pause… expiring on July 7, 2027."
  - Read literally, no notice covered 2026-07-01 → 2026-07-06.
  - Renumbered flights before 2025-12-05 were within normal enforcement.
  - The spec's blanket `manual_review` is conservative and acceptable, but L1 should record this history. It should not imply a continuous pause.
  - After 2027-07-07 the mandatory re-review triggers; R02-10b tests that.
- **Preserved conflicts:** DOT-REF-3 vs 260.2 (C33) — correct. DOT-REF-2's "departs from its destination" (sic) is noted — correct.
- **Conflicts to add:**
  - statute "arrives" vs regulation "scheduled to arrive" (C14);
  - DOT-REF-8 "must request" vs 260.4(a) "automatic" (C35).

### R02.4 Scope honesty and §10 completeness

- No cash compensation for delay: correct and explicit.
- Denied boarding, R12, R14, R15 and R04 are kept separate: correct.
- Mission §10's "A one-hour delay … must not produce a universal cash-compensation opportunity" is met (R02-05).
- §10 items captured: original and changed itinerary, operating and marketing carrier, merchant of record (seller), payment method, notice, acceptance/use, already refunded, ancillary fees.
- **Limitations to add:**
  - 260.6(b) disability path: triggered "upon notification by the individual", and it extends to companions on the same reservation — not modelled;
  - cash/check purchasers' merchant-of-record source.

### R02.5 Verdict — **approve_with_changes**

### R02.6 Required edits (all blocking for `active`)

1. **§16 step 3 / §5 `event_type`:** replace with "operational delay: evaluate significance with the carrier's revised schedule (criterion 2). Only below the thresholds → `not_eligible`. Revised schedule and actual arrival straddle the threshold → `manual_review` (statute 'arrives' vs regulation 'scheduled to arrive')." Add the R02 fixture recommended in R02.2.
2. **§8:** label "ancillary fees for the affected flight" and full-ticket `fare_paid` as assumption A4. Add: "itinerary partly flown, or only some segments affected → amount `manual_review` (260.6(a)(1) does not address partial use)." Update the §16 idempotency note if segment-level keys remain.
3. **§11 anchors:**
   - add the (iii)(B) "date that the significantly delayed or changed flight departs";
   - label the (a)(2)(i) anchor date as an assumption;
   - add "response unknown and the changed flight has already departed without the consumer → `needs_facts` (ask whether a voucher was accepted)" to §16 step 7.
4. **§11 / A1:** replace "within ±12 h of midnight in any relevant zone" with "when the anchor instant falls on different calendar dates in the consumer's zone and the carrier's origin zone".
5. **Temporal gate:** new §16 step 1b — incident (or deemed-request) date before 2024-10-28 → `source_unverified` ("refund rule compliance date"). Expand L1 with the pause history in R02.3.
6. **§12.4 and §17.3:** qualify the (a)(4) cross-reference ("only if a credit was issued"). Record the DOT-REF-8 vs 260.4(a) tension as a disclosed conflict.
7. **Fixtures:** X1 convention; X2 candidates for R02-07; fix the R02-11 clock so facts don't post-date `now`; R02-05 `delay_cause_controllable.value` → `null`.

---

## R03 — Credit-card billing error (15 U.S.C. 1666 / 12 CFR 1026.13 / Supp. I)

### R03.1 Claims

| # | Claim | Spec loc. | Supporting passage (captured, verbatim) | Verdict |
|---|---|---|---|---|
| R03-C1 | Consumer open-end credit only; business-purpose → `unsupported` | header, §2.1, L6 | 1026.13(a)(1): "…authority to use the consumer's credit card or open-end credit plan." The business-purpose exemption (1026.3) is not captured. | supported_with_caveat. Conservative. |
| R03-C2 | "Effective date: §1026.13 as amended 76 FR 79772 (2011-12-22) and 81 FR 84369 (2016-11-22)" | header | Capture: "[76 FR 79772, Dec. 22, 2011, as amended at 81 FR 84369, Nov. 22, 2016]" — these are FR **publication** dates. FR API: 2016-24503 (81 FR 83934) "effective on October 1, 2017", later "further delayed … to April 1, 2019" (83 FR 6364). | **contradicted** as an effective-date label (X4). No practical effect on current transactions. |
| R03-C3 | Four channels are not conflated; merchant contact is not a prerequisite | §1 | Comment 13(a)(3)-3: "A consumer is not required to first notify the merchant … before providing a billing-error notice to the creditor under § 1026.13(a)(3)…" | supported |
| R03-C4 | Debit, ACH, prepaid, P2P → Regulation E / `unsupported` | §2.1, §16.2 | 1026.13(i); comment 13(i)-2: "…credit inadvertently extended incident to an electronic fund transfer using a debit card … is governed solely by the Regulation E error resolution procedures…" | supported_with_caveat. Comment 13(a)(3)-2 says (a)(3) "generally applies to disputes about goods and services that are purchased using a third-party payment intermediary, such as a person-to-person Internet payment service, funded through use of a consumer's open-end credit plan" when funded at purchase for the full amount. Blanket `p2p → unsupported` is conservative (unsupported ≠ not eligible) but must be listed as a limitation. |
| R03-C5 | Billing error must be reflected on or with a periodic statement | §2.2 | 1026.13(a)(3): "A reflection on or with a periodic statement of an extension of credit…" | supported |
| R03-C6 | Mixed debit + overdraft credit → Regulation E | §2.4 | 1026.13(i)(1); comment 13(i)-3.i: "An error asserted with respect to the transaction is subject, for error resolution purposes, to the applicable Regulation E … provisions … for the entire transaction." | supported |
| R03-C7 | Unauthorized charge = (a)(1) | §4 | 1026.13(a)(1) | supported |
| R03-C8 | Duplicate charge = (a)(1) / 1666(b)(1) | §4, A2, L7 | 1666(b)(1): "A reflection on a statement of an extension of credit which was not made to the obligor or, if made, was not in the amount reflected on such statement." | assumption-honest; the text supports it |
| R03-C9 | Wrong amount = 1666(b)(1) | §4 | same | supported |
| R03-C10 | Not delivered / not accepted, including late delivery, wrong quantity, wrong location | §4 | Comment 13(a)(3)-1.i: "…C. Delivery of the wrong quantity. D. Late delivery. E. Delivery to the wrong location." | supported |
| R03-C11 | `credit_not_posted` (return/refund/payment not credited) → (a)(4) | §4 | 1026.13(a)(4): "…failure to credit properly a payment or other credit **issued** to the consumer's account." 1666(b)(4): "…a credit issued to the obligor." | supported_with_caveat. A merchant's promised but **un-issued** refund is not (a)(4); it maps to (a)(3) (goods returned or not accepted). Mission §10 "missing promised credit" needs this split, and the anchor differs (comment 13(b)(1)-2 applies only to (a)(4)). |
| R03-C12 | Computational error (a)(5); clarification (a)(6); a documentation-only request is not a billing error | §4 | Comment 13(a)(6)-1: "A request for documentation such as receipts or sales slips, unaccompanied by an allegation of an error … does not trigger the error resolution procedures." | supported |
| R03-C13 | Statement not sent: only if the address was received ≥ 20 days before cycle end | §4 | 1026.13(a)(7): "…if that address was received by the creditor, in writing, at least 20 days before the end of the billing cycle…" | supported |
| R03-C14 | Quality dispute about accepted goods is not a billing error | §4, §6 | Comment 13(a)(3)-1.ii: "Section 1026.13(a)(3) does not apply to a dispute relating to the quality of property or services that the consumer accepts." | supported |
| R03-C15 | Unauthorized-use liability capped at $50 by 1026.12(b) | §4 | 1026.12(b) not captured. Comment 13(c)-3 confirms only that the rights are independent. | not in captures. Informational, not used by the evaluator. |
| R03-C16 | Reassertion after full compliance → `not_eligible` | §6 | 1026.13(h): "A creditor that has fully complied with the requirements of this section has no further responsibilities under this section … if a consumer reasserts substantially the same billing error." | supported |
| R03-C17 | Acknowledge ≤ 30 days; resolve ≤ 2 complete cycles and ≤ 90 days | §7, §11 | 1026.13(c)(1)–(2) as quoted in spec; comment 13(c)(2)-1: "…two actual billing cycles occurring after receipt of the billing error notice…" | supported |
| R03-C18 | Pending resolution: need not pay, no collection, no adverse report | §7 | 1026.13(d)(1): "The consumer need not pay (and the creditor may not try to collect) any portion of any required payment that the consumer believes is related to the disputed amount…"; (d)(2) | supported |
| R03-C19 | Non-delivery can't be denied without a delivery determination | §7 | 1666(a) subparagraph (B)(ii): "…a creditor may not construe such amount to be correctly shown unless he determines that such goods were actually delivered, mailed, or otherwise sent…"; comment 13(f)-3.ii | supported. **Citation fix:** "15 U.S.C. 1666(a)(3)(B)(ii)" → "1666(a)(B)(ii)". Subparagraph (B) follows paragraph (3); it is not within it. |
| R03-C20 | Disputed amount per comment 13(d)-1; no cap | §8 | Comment 13(d)-1: "Disputed amount is the dollar amount alleged by the consumer to be in error. When the allegation concerns the description or identification of the transaction … the disputed amount is the amount of the transaction…" | supported. Omits the (a)(7) rule "the disputed amount is the entire balance owing" (minor). |
| R03-C21 | Provisional credit stays provisional | §8 | Comment 13(c)-1: "A creditor may temporarily correct the consumer's account in response to a billing error notice…" | supported |
| R03-C22 | Written notice, at the disclosed address, not on the payment stub if the creditor stipulates | §10 | 1026.13(b)(1): "Is received by a creditor at the address disclosed under § 1026.7(a)(9) or (b)(9)…"; comment 13(b)-2 first sentence | supported |
| R03-C23 | Quoted passage P-1026.7(b)(9) | §13 | **1026.7 is not among the captures** | not in captures. The address requirement itself is supported by 13(b)(1). Capture 1026.7(b)(9) or drop the verbatim quote. |
| R03-C24 | Not the payment address | §10 | FTC-CC-1: "Use the address given for billing inquiries, not the address for sending your payments." | supported (guidance consistent with 13(b)(1)) |
| R03-C25 | Contents: identify name and account; belief, reasons, type/date/amount | §10 | 1026.13(b)(2)–(3); comment 13(b)(2)-1 | supported |
| R03-C26 | Email counts as written "**only if**" the billing-rights statement stipulates electronic notice and states the means; ordinary email to customer service does not preserve the right | §10 | Comment 13(b)-2: "…if the creditor stipulates in the billing rights statement that it accepts billing error notices submitted electronically, and states the means by which a consumer may electronically submit a billing error notice, a notice sent in such manner will be deemed to satisfy the written notice requirement…" | supported_with_caveat. The comment is a safe harbor ("will be deemed"), not an exclusive rule. The conclusion about customer-service email still holds, because 13(b)(1) requires receipt "at the address disclosed". Reword to say what the text establishes, not "only if". |
| R03-C27 | Phone is not written notice | §10 | 1026.13(b) "written notice"; contrast 1005.11(b)(1) "any oral or written notice of error" | supported |
| R03-C28 | Anchor = transmittal of the first statement; held statements; unsent statement; missing credit | §11 | 1026.13(b)(1) "…no later than 60 days after the creditor transmitted the first periodic statement that reflects the alleged billing error"; comments 13(b)(1)-1 to -3 as quoted in spec | supported |
| R03-C29 | 60 **calendar** days | §11 | The text says "60 days". The same section uses "3 business days" (1026.13(d)(1)) where business days are meant. | supported_with_caveat (well-grounded inference; state the reason) |
| R03-C30 | Day 60 inclusive; **received**, not sent | §11 | "Is received … no later than 60 days after…" | supported |
| R03-C31 | No weekend/holiday roll-forward | A1, L2 | — | assumption-honest |
| R03-C32 | Unknown anchor → `needs_facts` + conservative act-by = posting + 60, never `dueAt` | §11 | D143(3); logic: a statement reflecting a charge can't be transmitted before the charge posts | supported for charge-type errors. **Caveat:** for `credit_not_posted` the relevant date is when the credit should have appeared (comment 13(b)(1)-2), not a charge posting date. For (a)(7) there is no posting. Define the lower bound per error type. |
| R03-C33 | The notice must come "from a consumer" | §12.5 | 1026.13(b): "A billing error notice is a written notice from a consumer that:" | supported |
| R03-C34 | Claims and defenses: good-faith attempt; > $50; same state or 100 miles; FTC's "$5" recorded as a conflict | L4 | 1026.12(c)(3)(i)(A): "The cardholder has made a good faith attempt to resolve the dispute…"; (B): "…exceeds $50, and the disputed transaction occurred in the same state … or, if not within the same state, within 100 miles from that address." vs FTC-CC-3 | supported. Conflict preserved, regulation governs. |
| R03-C35 | BNPL interpretive rule withdrawn 2025-05-12 | L5 | Not captured (hash cited only) | not in captures. Effect is conservative (`unsupported`). |
| R03-C36 | eCFR presence ≠ in force (late-fee rule stayed; overdraft rule disapproved) | L8 | CFPB-LATEFEE-1: "…the Credit Card Penalty Fees Final Rule … is stayed."; PL119-10-1: "…such rule shall have no force or effect." | supported |
| R03-C37 | Double-credit reversal is permitted | §16.9 | Comment 13(c)(2)-2: "…if a consumer receives more than one credit to correct the same billing error, § 1026.13 does not prevent a creditor from reversing amounts it has previously credited…" | supported |

### R03.2 Fixtures

| Case | My independent result | Fixture | Agree? | Note |
|---|---|---|---|---|
| R03-01 | eligible; disputed 12,999; received by 2026-11-09; ready | same | agree | X1 |
| R03-02a | eligible; deadline 2026-08-31 met | same | agree | — |
| R03-02b | eligible (day 60 inclusive) | same | agree | Boundary matches "no later than 60 days after" |
| R03-02c | deadline_passed (formal path only) | same | agree | C11: whether a credit was *issued* isn't stated ("return accepted"). If none was issued, the type is (a)(3); for this fixture the anchor is the same. |
| R03-03 | needs_facts [first_statement_transmitted_on]; disputed 45,000; act-by 2026-11-02 (advisory) | same | agree | — |
| R03-04 | unsupported; route to Regulation E | same | agree (outcome) | **Text defect:** the `explanation` asserts Reg E's "2-business-day clocks" and `route_to` cites 1005.6. Neither is in the captures (1005.11(b)(2) says "10 business days"). Capture 1005.6 or remove the claim. |
| R03-05 | eligible; 2026-11-09; readiness blocked (channel) | same | agree | — |
| R03-05b | eligible; ready (stipulated electronic) | same | agree | — |
| R03-06 | not_eligible; pointer to 1026.12(c) ($50, not $5) | same | agree | — |
| R03-07 | needs_facts [first_statement_transmitted_on] | same | agree (outcome) | **X2 defect:** expected act-by 2026-09-30 needs the candidate 2026-08-01, which is not in the facts |
| R03-08 | eligible; 54,000; 2026-10-27; no merchant-first gate | same | agree | — |
| R03-09 | unsupported | same | agree | — |
| R03-10 | source_unverified (145 days > 90) | same | agree | — |
| R03-11 | eligible; reuse the case; no second letter | same | agree | — |
| R03-12 | eligible; 2026-11-09; merchant promise is an alternative; counted once (12,999) | same | agree | Could also assert `packet_readiness: blocked_address`, since the address is absent (optional). |

### R03.3 Temporal accuracy and source conflicts

- Effective-date label: C2 / X4.
- The FTC "$5" vs regulation "$50" conflict is preserved correctly (L4).
- eCFR-presence caveats are correct (L8).
- No other conflicts.

### R03.4 Scope honesty and §10 completeness

- Correct on all four §10 guardrails:
  - no email-preserves-notice claim (C26, subject to rewording);
  - no merchant-first delay;
  - letter plus evidence index, user sends;
  - channel separation.
- Remedy is "not guaranteed" and provisional credit stays provisional — correct.
- Gaps: the §10 "missing promised credit" split (C11); P2P limitation (C4).

### R03.5 Verdict — **approve_with_changes**

### R03.6 Required edits

1. **Header / manifest:** relabel the dates as FR publication dates. Effective: 76 FR 79772 per its notice (not captured); 81 FR 83934 effective 2019-04-01 after delays (X4).
2. **§4 / §5 / §11:** split `credit_not_posted` into (a)(4) (credit **issued** but not reflected; anchor per comment 13(b)(1)-2) and a promised but un-issued refund → (a)(3). Define the conservative act-by lower bound per error type (C32).
3. **§10 wording (C26):** "The captured text establishes that a notice sent by the electronic means stipulated in the billing-rights statement satisfies the written-notice requirement. Recoup treats no other electronic channel as preserving the formal right." Keep the "must not claim otherwise" rule.
4. **Captures and citations:**
   - capture 1026.7(b)(9), or drop P-1026.7(b)(9) as a verbatim passage;
   - fix the 1666 citation (C19);
   - add a comment 13(a)(3)-2 (third-party payment intermediary) limitation to L-list and §2.1.
5. **Fixtures:** X1; X2 for R03-07; remove or capture the Reg E "2-business-day" / 1005.6 claims in R03-04; X6 (zone that defines day 60).

---

## R04 — Baggage (14 CFR 260.5 bag fee; 14 CFR 254 liability)

### R04.1 Claims

| # | Claim | Spec loc. | Supporting passage (captured, verbatim) | Verdict |
|---|---|---|---|---|
| R04-C1 | b/c apply to interstate/intrastate carriage; international b/c → `unsupported` (treaty) | header, L8 | 254.2: "This part applies to any air carrier that provides charter or scheduled passenger service in interstate or intrastate air transportation." DOT-BAG-4 (Montreal) | supported. International `unsupported` is conservative; the treaty text is not captured. |
| R04-C2 | $4,700 effective 2025-01-22; enforcement delayed to 2025-03-20 | header | FR API 2024-23588: "This rule is effective on January 22, 2025." 2025-02814: "As of February 20, 2025, enforcement of the amendments … is delayed until March 20, 2025." | supported. §10 must carry the non-enforcement window (R04.3). |
| R04-C3 | 2026 is a biennial review year | header, L5 | 254.6: "The Department of Transportation will review the domestic baggage liability limit prescribed in this part every two years." (last adjustment 2024) | supported_with_caveat (inference). The b/c refresh window **before** 2026-10-01 is unstated: manifest 30, fixture R04-10 uses 90. |
| R04-C4 | Checked bag includes gate-checked and valet bags | §2 | 260.2: "A checked bag includes a gate-checked bag and a valet bag." | supported |
| R04-C5 | Path a needs an MBR with the operating / last-segment carrier | §2, §6 | 260.5(b): "A covered carrier does not have an obligation to provide a refund of the fee for a lost or significantly delayed checked bag unless a passenger files a Mishandled Baggage Report (MBR)…" | supported |
| R04-C6 | 12 h / 15 h / 30 h thresholds; the 15/30 h standards apply to domestic segments of international itineraries | §4 | 260.2 "Significantly delayed checked bag means…" (quoted in full in spec P-260.2-SDB) | supported |
| R04-C7 | Delay runs from the opportunity to deplane to delivery or pickup | §4 | 260.5(a): "…the length of delay is calculated from the time the passenger is given the opportunity to deplane from a flight at the passenger's final destination airport … to the time that the carrier has delivered the bag…" | supported |
| R04-C8 | Exactly 12:00:00 is "within" → not significantly delayed | §4, A1 | "not delivered to or picked up … within 12 hours" | assumption-honest. The reviewer's reading agrees: an event at exactly 12 h happens within 12 h. |
| R04-C9 | Exemptions (f)(1)–(3) | §6 | 260.5(f)(2): "A passenger's failure to pick up a checked bag that arrived on time … due to the fault of the passenger **if documented by the carrier**…" | supported_with_caveat. §6's summary drops "if documented by the carrier". The evaluator should require carrier documentation, not only a user fact. |
| R04-C10 | Voluntary separation doesn't waive the lost-bag fee refund or expenses beyond the agreed date | §6 | 260.5(g): "The carrier must not require the passenger to waive the right to a refund of bag fees if the bag is lost, … or the right to incidental expenses reimbursement arising from delayed bags beyond the agreed upon delivery date…" | supported |
| R04-C11 | CoC-excluded items are not compensable on domestic travel | §6 | DOT-BAG-7: "For DOMESTIC travel, airlines are not required to compensate passengers for items they have excluded in their contracts of carriage." | guidance-only |
| R04-C12 | "pre-existing damage / improper packing (DOT consumer page)" exclusion | §6 | Not in the captured excerpts | **not in captures** (unsupported in repo) |
| R04-C13 | Refund ≥ fee; escalated scale; subscription rule; original form | §7 | 260.5(e): "…a value equal to or greater than the fee that the consumer paid to transport his/her checked bag."; (e)(1)–(2); 260.10 | supported |
| R04-C14 | Expenses: reasonable, verifiable, actual; no arbitrary daily cap | §7, L2 | DOT-BAG-1: "Airlines are required to compensate passengers for reasonable, verifiable, and actual incidental expenses…"; DOT-BAG-2 | guidance-only (disclosed in L2). The regulation's measure is 254.4 "provable direct or consequential damages". |
| R04-C15 | Property: estimate unknown until depreciation and valuation are known | §7 | DOT-BAG-6: "…subject to depreciation and maximum liability limits." | supported |
| R04-C16 | Shared b+c limit: carrier cap not below $4,700 per passenger; a ceiling, not a payout | §7, L1 | 254.4: "…an air carrier shall not limit its liability for provable direct or consequential damages resulting from the disappearance of, damage to, or delay in delivery of a passenger's personal property, including baggage, in its custody to an amount less than $4,700 for each passenger." | supported. Display copy mirrors 254.5(b): "Federal rules require any limit on an airline's baggage liability to be at least $4,700 per passenger." |
| R04-C17 | Path a is complementary and outside the 254.4 limit | §1, §7 | The text is silent on whether a 260.5 fee refund counts against a 254.4 limit | supported_with_caveat (inference; label it) |
| R04-C18 | No federal MBR deadline; DOT encourages filing immediately | §9 | DOT-BAG-8: "You are encouraged to file the report as soon as you learn that your bag did not arrive with you at the destination." | supported (absence plus guidance) |
| R04-C19 | "report damage 'before leaving the airport' (DOT Baggage Tips)" | §9 | Not in the captured excerpts | **not in captures** (labelled guidance, but uncaptured) |
| R04-C20 | Bag-fee refund: "DOT does not state a day count" / "the regulation states no day count" | §10, L6, fixture R04-01 | 260.2: "Prompt refund means refunds made within 7 business days after the earliest date the refund was requested **as set forth in § 260.6(a)(2)**…"; 260.5: "…must provide a **prompt refund** to a consumer of any fee…" | supported_with_caveat. The defined term *is* used in 260.5, so "states no day count" overstates. What is true: the defined counts are anchored to a §260.6(a)(2) event, which has no bag-fee analogue. Keep "no computed date", fix the copy. |
| R04-C21 | $4,700 for incidents on/after 2025-01-22; $3,800 before | §10, L5 | $3,800 is not in any capture. FR API 2024-23588 abstract: "…raises the liability limit U.S. carriers may impose for mishandled baggage in domestic air transportation from the current amount of $3,800 to $4,700." | supported_with_caveat. True (reviewer-verified) but uncaptured. Capture the abstract passage. |
| R04-C22 | Large-aircraft condition; small-aircraft-only → `manual_review` | L3 | 254.3: "Large aircraft means any aircraft designed to have a maximum passenger capacity of more than 60 seats." 254.4 opening clause | supported. **No required fact in §5** lets the evaluator apply it. |
| R04-C23 | Carrier refunds when a ticket agent charged the fee; "claim from airline either way" | §5 | 260.5: "…if a ticket agent is the merchant of record, the covered carrier that operated the flight or the last flight segment … must provide a prompt refund…"; 260.5(d): "An automatic refund of a bag fee is due when…" vs DOT-REF-8 "…you must request a refund from the airline." | supported_with_caveat. The same undisclosed "automatic" vs "must request" tension as R02-C35. |
| R04-C24 | Path a: significant or lost with fee paid → `eligible` | §15 2.5 | 260.5 as above | Supported by the text, but **conflicts with D143(4) as worded**: "carrier contract deadlines not captured → fee and property paths cap at `likely_eligible`". Path a has no carrier-deadline dependency (260.11 bars inconsistent CoC terms), so I read the text as permitting `eligible`. **The lead must rule** on whether D143(4)'s "fee" meant path a. |
| R04-C25 | Path b: all lines receipted and carrier deadline known → `eligible` | §15 3 | 254.4 limits liability *limitations*; the duty to reimburse rests on carrier liability law and DOT guidance (DOT-BAG-1) | supported_with_caveat. In v1 no CoC is captured, so path b can never reach `eligible` in practice. State an explicit v1 cap at `likely_eligible` to match D143(4) and avoid presenting a federal "reimbursement right". |

### R04.2 Fixtures

| Case | My independent result | Fixture | Agree? | Note |
|---|---|---|---|---|
| R04-01 | path a eligible; refund ≥ 4,000; delay 13h15m; no computed date | same | agree (outcome) | **Text defect:** `semantics` says "the regulation states no day count" (C20). |
| R04-02a | not_eligible (11h59m) | same | agree | — |
| R04-02b | not_eligible (12h00m, "within") | same | agree | A1; reviewer confirms the reading |
| R04-02c | eligible; ≥ 4,000 | same | agree | — |
| R04-03 | needs_facts [mbr_filed] | same | agree | The note "no → not_eligible for now" should become X3's `reason: action_required` |
| R04-04 | path b likely_eligible; estimate 41,250 (E1+E2+E3); E4 18,750 excluded; floor shown as a limit only | same | agree | **Convention break:** `expected.amount.excluded[0]` has `amount_minor` with no `currency`. Conventions define money as minor units + ISO-4217. First reported by the M08 loader (QA); the reviewer confirmed it. |
| R04-05 | a: eligible ≥ 3,500, refunded by XA (30h delay); b: likely_eligible 8,000; complementary; 11,500 distinct lines | same | agree | — |
| R04-06 | path c likely_eligible; estimate null; not 470,000 or 620,000 | same | agree | Aircraft size unknown (C22); fixture silent |
| R04-07 | not_eligible (CBP recheck exemption; 20h > 15h) | same | agree | `exemption_facts` is an `extracted_candidate`. (f)(1) doesn't need carrier documentation. |
| R04-08 | b: unsupported; a: eligible ≥ 10,000 (16h > 15h; 645 min ≤ 12 h segment) | same | agree | — |
| R04-08b | a: not_eligible (15h00m within) | same | agree | — |
| R04-09 | needs_facts [bag_delivered_or_picked_up_at] | same | agree (outcome) | **X2 defect:** candidates 9:10 and 10:30 are only in the question text |
| R04-10 | source_unverified (114 days) | same | agree | The window value (90) contradicts the manifest's `refreshDays: 30` (C3). Stale under either. |
| R04-11 | eligible; reuse | same | agree | — |
| R04-12 | path b likely_eligible; 12,000; E1 excluded (card-paid) | same | agree | — |

**Boundaries:** the 12 h and 15 h boundaries are tested and consistent with "within". **Recommended** additions:
- 30 h standard (> 12 h segment);
- incident before 2025-01-22 (floor $3,800);
- incident in 2025-02-20..03-19 (non-enforcement note);
- `mbr_filed=false`;
- `declared_lost` path a;
- small-aircraft itinerary.

### R04.3 Temporal accuracy and source conflicts

- **$4,700 effective date is correct.** The spec's parameter switch ($3,800 → $4,700 on 2025-01-22) should add the enforcement note: DOT delayed *enforcement* of the new figures from 2025-02-20 to 2025-03-20. That doesn't change the legal effective date, but the display for incidents in that window should say so.
- **The 2026 biennial adjustment is pending.** The monthly refresh from 2026-10-01 is reasonable. State the window before that date.
- Preserved conflict L1 (DOT-BAG-3 wording vs 254.4) is correct and not blended.
- **Missing conflict:** DOT-REF-8 vs 260.5(d) / 260.4(a) (C23).

### R04.4 Scope honesty and §10 completeness

- "A liability ceiling is not a guaranteed payout" is honoured throughout: copy, `forbidden_outputs` in R04-04 and R04-06, and a null estimate for c.
- Actual documented expenses only; single allocation per expense line (R04-12) — correct.
- Path separation correct.
- Gap: path b's "legal entitlement" framing (C25).

### R04.5 Verdict — **approve_with_changes** (and a lead ruling on D143(4))

### R04.6 Required edits

1. **Lead ruling:** does D143(4)'s "fee and property paths cap at `likely_eligible`" include path a? If yes, change §15 2.5 and fixtures R04-01, -02c, -05(a), -08(a), -11. If no, amend D143(4)'s wording to "expense and property paths".
2. **§15 step 3:** state that path b is capped at `likely_eligible` in v1 while no carrier CoC is captured. Label path b's basis as "carrier liability (federal floor on the cap, 254.4) + DOT enforcement guidance (DOT-BAG-1/2)", not a regulation granting reimbursement.
3. **§5:** add `large_aircraft_segment_on_ticket: boolean | unknown` (254.3/254.4). Unknown → state the assumption. False for all segments → `manual_review` (L3).
4. **§6:** add "if documented by the carrier" to exemption (f)(2) and require carrier documentation. Remove, or capture, "pre-existing damage / improper packing".
5. **§9:** remove, or capture, "report damage before leaving the airport".
6. **§10 / L6 and fixture R04-01 `semantics`:** replace "DOT does not state a day count" / "the regulation states no day count" with "260.5 requires a prompt refund; the regulation's 7-business/20-calendar-day definition is anchored to §260.6(a)(2) fare-refund events, so Recoup computes no date for bag fees".
7. **§10 and excerpts:** capture the FR 2024-23588 abstract ($3,800 → $4,700). Add the 2025-02-20..03-19 enforcement note. State the b/c refresh window before 2026-10-01 and make the manifest (30) and R04-10 (90) consistent.
8. **Conflicts and fixtures:** record DOT-REF-8 vs 260.5(d) as a disclosed conflict. X1; X2 for R04-09; X3 for `mbr_filed=false`; add `currency: "USD"` to R04-04 `expected.amount.excluded[0]`.

---

## R05 — Mail, Internet, or Telephone Order Merchandise Rule (16 CFR 435)

### R05.1 Claims

| # | Claim | Spec loc. | Supporting passage (captured, verbatim) | Verdict |
|---|---|---|---|---|
| R05-C1 | "Effective date: Current text: 79 FR 55619 (2014-09-17)" (manifest: effectiveDate "2014-09-17") | header | Capture: "Source: 79 FR 55619, Sept. 17, 2014" is a **publication** citation. FR API: 2014-22092 (79 FR 55615) `publication_date` 2014-09-17, **`effective_on` 2014-12-08**. | **contradicted** (X4). No effect on current orders. |
| R05-C2 | Covers sales "in or affecting commerce" | header | 435.2: "In connection with mail, Internet, or telephone order sales in or affecting commerce…" | supported |
| R05-C3 | The Rule regulates shipment, not delivery | §1 | 435.1(e): "Shipment shall mean the act by which the merchandise is physically placed in the possession of the carrier." | supported |
| R05-C4 | Late delivery after on-time shipment → R03 | §1 | Comment 13(a)(3)-1.i "D. Late delivery." | supported |
| R05-C5 | Any payment method or solicitation | §2.1 | 435.1(a): "…regardless of the method of payment or the method used to solicit the order." | supported |
| R05-C6 | Applicable time: stated / 30 days / 50 days with a seller credit application | §4 | 435.2(a)(1)(i)–(ii): "(i) Within that time clearly and conspicuously stated in any such solicitation; or (ii) If no time is clearly and conspicuously stated, within thirty (30) days after receipt of a properly completed order … the seller shall have fifty (50) days…" | supported |
| R05-C7 | Order-time representation supersedes advertising | §4 | FTC-MITOR-G3: "The updated shipment information you provide on the telephone or the Internet supersedes any shipment representation you made in the advertising." | guidance-only |
| R05-C8 | Clock starts at a properly completed order; dishonoured payment or credit refusal resets it | §4 | 435.1(c): "…the time at which the seller receives both said payment and an order from the buyer containing all of the information needed by the seller to process and ship the order." plus proviso (1)–(3) | supported |
| R05-C9 | Calendar days; day 30 inclusive | §4, A1 | "within thirty (30) days after receipt" | assumption-honest. The zone that defines a day is unstated (X6). |
| R05-C10 | Exclusions: serial subscriptions after the first shipment, seeds/plants, COD, negative-option plans | §6 | 435.3(a)(1)–(4) as quoted in spec | supported |
| R05-C11 | Services are not covered | §6 | FTC-MITOR-G5: "The Rule also does not cover services…"; rule text says "merchandise" throughout | supported |
| R05-C12 | Refund = amount tendered, including shipping etc., if nothing shipped | §7 | 435.1(d)(1): "…a return of the amount tendered…"; FTC-MITOR-G6 | supported |
| R05-C13 | "Partial shipment: refund of the difference for unshipped items per the seller's ordering instructions" | §7 | No captured passage | **unsupported** (not in captures). Route partial shipments to `manual_review` until captured. |
| R05-C14 | No store credit, vouchers or scrip | §7 | FTC-MITOR-G2; 435.1(d) lists the permitted refund forms, none of which is store credit | supported |
| R05-C15 | No notice and not shipped by T → deemed cancelled plus prompt refund | §8.1 | 435.2(c)(5): "The seller fails to offer the option prescribed in paragraph (b)(1) of this section and has not shipped the merchandise within the applicable time…" | supported. Vesting date A3 is honest. |
| R05-C16 | Revised date ≤ T+30: silence = consent | §8.2 | 435.2(b)(1)(ii): "…unless the seller receives, prior to shipment and prior to the expiration of the definite revised shipping date, a response from the buyer rejecting the delay and cancelling the order, the buyer will be deemed to have consented…" | supported |
| R05-C17 | "Buyer may cancel any time before shipment" (≤ 30-day option) | §8.2 | same passage: "prior to shipment **and prior to the expiration of the definite revised shipping date**" | supported_with_caveat. Add "and before R". |
| R05-C18 | Not shipped by R → renewed option; silence = rejection | §8.2 | 435.2(b)(2)(ii): "…the buyer will be deemed to have rejected any further delay, and to have cancelled the order if the seller is in fact unable to ship…"; (c)(3) | supported |
| R05-C19 | R > T+30 or indefinite → automatic cancellation unless shipped, or express consent, within 30 days of T | §8.3 | 435.2(b)(1)(iii)(A)–(B); (c)(2) as quoted in spec | supported |
| R05-C20 | Notice sent after T is not a valid first option → case 1 | §8.4 | 435.2(b)(1): "…but in no event later than said applicable time." + (c)(5) | supported |
| R05-C21 | Consent to an indefinite delay → continuing right to cancel | §8.5 | 435.2(b)(1)(iii)(B): "…the buyer will have a continuing right to cancel the buyer's order at any time after the applicable time … by so notifying the seller prior to actual shipment." | supported |
| R05-C22 | Seller decides not to ship → prompt refund | §8.6 | 435.2(b)(4); (c)(4): "The seller has notified the buyer of its inability to make shipment and has indicated its decision not to ship the merchandise;" | supported |
| R05-C23 | (Omission) Notice adequacy is not checked | §8 | 435.2(b)(1): "…to fail to offer to the buyer, clearly and conspicuously and without prior demand, an option either to consent to a delay in shipping or to cancel the buyer's order and receive a prompt refund." (b)(1)(i): "Any offer … shall fully inform the buyer regarding the buyer's right to cancel the order and to obtain a prompt refund…" | **gap**. A notice that doesn't offer cancellation plus refund is not the prescribed option. §8 cases 2 and 3 assume it is. |
| R05-C24 | Refund within 7 working days of vesting; one billing cycle if the seller is the creditor; cash/check/money order within 7 working days if the same method is impossible | §9 | 435.1(b)(1): "…a refund **sent** by any means at least as fast and reliable as first class mail within seven (7) working days of the date on which the buyer's right to refund vests…"; (b)(2) one billing cycle | supported_with_caveat. The table omits that the deadline is for the refund being **sent**, not posted (mission §9 "sent vs received"). It also omits whether counting starts the day after vesting: fixtures assume "after"; counting the vesting day would give 2026-09-10 instead of 2026-09-11 in R05-05c. |
| R05-C25 | "Working days" is undefined | §9, A2 | Part 435 has no definition | assumption-honest |
| R05-C26 | Third-party credit: credit memo to the issuer plus a copy to the buyer | §9 | 435.1(d)(2)(ii) | supported. The alternative "statement … acknowledging the cancellation" also qualifies; add it. |
| R05-C27 | Delay notice may be emailed | §10 | FTC-MITOR-G4: "Q: Can we send the delay option notice to the customer's e-mail address? A: Yes." | guidance-only |
| R05-C28 | "Posting only on an order-status page may be insufficient (FTC guide Q&A)" | §10 | Not in the captured excerpts | **not in captures** |
| R05-C29 | Seller must provide adequate means to cancel; a cancellation counts only if received before shipment | §10 | 435.2(b)(3): "…to fail to furnish the buyer with adequate means, at the seller's expense, to exercise such option or to notify the seller regarding cancellation."; (c)(1) | supported |
| R05-C30 | The R03 clock runs independently from the first statement showing the charge | §11 | 1026.13(b)(1) | supported_with_caveat. Conservative reading; fine for an act-by. |
| R05-C31 | No private right of action in the captured text; never say "sue under the FTC rule" | L1 | 435.2 frames violations as unfair/deceptive acts; the text is silent on private suits | honest |
| R05-C32 | Range → upper bound | L5, A4 | — | assumption-honest |
| R05-C33 | State law may add rights | L6 | 435.3(b)(1): "This part does not annul or diminish any rights or remedies provided to consumers by any State law…" | supported |
| R05-C34 | Civil penalty "$53,088 per violation" | L7 | Not captured | not in captures (informational, unused) |
| R05-C35 | Non-US buyer, seller or ship-to → `unsupported` | §16.2 | "in or affecting commerce" can include foreign commerce | supported_with_caveat. Conservative scope choice; label it. |

### R05.2 Fixtures

| Case | My independent result | Fixture | Agree? | Note |
|---|---|---|---|---|
| R05-01 | eligible; T 2026-09-04; vests 09-05; refund sent by 2026-09-16 (09-07 holiday); 15,000 | same | agree | The spec's step-7 example ("no tracking history proving non-shipment → likely") could be read to cap this case. State that a user-confirmed non-shipment plus no carrier event is sufficient. |
| R05-02 | not_eligible (shipped on time); pointer to R03 late delivery | same | agree | — |
| R05-03 | not_eligible (notice before T; R 09-05 ≤ T+30 09-18; shipped 09-04) | same | agree (outcome) | **Text defect / spec gap (C23):** the notice text in the fixture doesn't tell the buyer of the right to cancel and get a prompt refund ((b)(1)(i)). Fix the text, or expect `manual_review` once the adequacy check exists. |
| R05-04 | eligible; auto-cancel after 10-10; vests 10-11; refund by 2026-10-21 (10-12 holiday); 89,900 | same | agree | — |
| R05-04b | not_eligible now; continuing right to cancel | same | agree | X3 |
| R05-04c | not_eligible yet; re-evaluate 2026-10-11 | same | agree | X3 |
| R05-05a | not_eligible yet (day 29) | same | agree | X3 |
| R05-05b | not_eligible yet (day 30 inclusive) | same | agree | **X6:** correct only on a local-date (-04:00) reading. UTC would be 09-01. |
| R05-05c | eligible; vests 09-01; by 2026-09-11; 4,599 | same | agree | C24 counting start |
| R05-06 | needs_facts [delay_notices]; T 2026-09-10 | same | agree | — |
| R05-07 | not_eligible yet (T50 2026-09-20) | same | agree | X3 |
| R05-07b | eligible; T 08-31; vests 09-01; by 2026-09-11 | same | agree | The enum `prepaid_card_or_cash` mixes "paid in advance" with "prepaid card" (different refund forms under 435.1(d)). Rename. |
| R05-08 / 08b | not_eligible (plants; COD) | same | agree | — |
| R05-09 | unsupported | same | agree | — |
| R05-10 | needs_facts [shipping_representation] | same | agree (outcome) | **X2:** candidates only in prose |
| R05-11 | source_unverified (207 days > 180) | same | agree | — |
| R05-12 | eligible; reuse; R03 alternative; 15,000 once | same | agree | — |

**Boundaries:** day 29/30/31 is consistent with "within thirty (30) days after receipt" (A1), and 50 days is tested. **Recommended** additions:
- inadequate delay notice;
- partial shipment → `manual_review`;
- buyer cancellation received after R under a ≤ 30-day option;
- seller-is-creditor billing-cycle refund.

### R05.3 Temporal accuracy and source conflicts

- Effective date: C1 / X4.
- No source conflicts. The FTC guide (G1) matches 435.1(b) on 7 working days and one billing cycle.

### R05.4 Scope honesty and §10 completeness

- Shipment vs delivery is kept strictly apart. No private-suit claims (L1). "Ask the seller" is the remedy channel.
- §10 items covered: promised ship and delivery dates, tracking, delay notices, consent, cancellation, merchant response, payment type.
- Gap: notice adequacy (C23).

### R05.5 Verdict — **approve_with_changes**

### R05.6 Required edits

1. **Header / manifest:** "published 2014-09-17 (79 FR 55615); effective 2014-12-08" (X4).
2. **§8:** add a notice-adequacy fact, e.g. `delay_notice_offers_cancel_and_refund: boolean | unknown`, citing (b)(1)/(b)(1)(i). If false → the notice is not the prescribed option → case 1 (435.2(c)(5)). If unknown → `needs_facts`. Fix the R05-03 notice text accordingly.
3. **§8.2:** "Buyer may cancel before shipment **and before R**" (b)(1)(ii).
4. **§9:** add columns "sent, not posted" (435.1(b) "a refund sent …") and "count starts the day after the vesting date". Add the 435.1(d)(2)(ii) cancellation-statement alternative.
5. **§7 / §10:** remove, or capture, the partial-shipment rule and the order-status-page statement. Partial shipment → `manual_review` until captured.
6. **§4 / A1:** state the zone that defines a calendar day (buyer's local date, as a labelled assumption) (X6).
7. **Fixtures:** X1; X2 for R05-10; X3 `reevaluate_at` on R05-04b/04c/05a/05b/07; rename the `prepaid_card_or_cash` enum.

---

## Appendix A — Every `unsupported` / `contradicted` / not-in-captures claim

| Pack | Loc. | Claim | Verdict |
|---|---|---|---|
| R01 | §6 vs §7.3/§7.4 | "no captured pack" → `source_unverified` and → `unsupported` | internal contradiction |
| R02 | §8 | refund = fare + taxes + ancillary fees "for the affected flight"; partial itineraries not addressed | unsupported (unlabelled assumption) |
| R03 | header | §1026.13 effective dates 2011-12-22 / 2016-11-22 (publication dates; 2016 rule effective 2019-04-01) | contradicted (label) |
| R03 | §13 | verbatim P-1026.7(b)(9) (1026.7 not captured) | not in captures |
| R03 | §4 | 1026.12(b) $50 unauthorized-use cap | not in captures (informational) |
| R03 | L5 | BNPL interpretive rule withdrawn 2025-05-12 | not in captures (conservative effect) |
| R03 | fixture R03-04 | Reg E "2-business-day clocks", 1005.6 | not in captures |
| R04 | §6 | "pre-existing damage / improper packing" exclusion | not in captures |
| R04 | §9 | "report damage before leaving the airport" | not in captures |
| R04 | §10 | $3,800 floor before 2025-01-22 | not in captures (true per FR API; capture it) |
| R05 | header | effective date 2014-09-17 (actually effective 2014-12-08) | contradicted (label) |
| R05 | §7 | partial-shipment refund "per the seller's ordering instructions" | unsupported |
| R05 | §10 | "posting only on an order-status page may be insufficient" | not in captures |
| R05 | L7 | civil penalty $53,088 | not in captures (informational) |

## Appendix B — Fixture outcome disagreements

**None.** For all 65 runnable case/variant results in R02–R05, my independent outcome, missing facts, amount and deadline date match the fixture. The construction defects (not outcome disagreements) are:
- R02-07, R03-07, R04-09, R05-10 — X2: candidates not encoded; R03-07's `conservative_act_by` can't be computed from the facts.
- R02-11 — facts post-date the clock.
- R02-05 — a missing fact carries `value: "unknown"` instead of `null`. R04-04 — excluded amount has no currency. Both were found first by the M08 loader and confirmed by the reviewer.
- R03-04 — uncaptured Reg E claims in the prose.
- R04-01 — "regulation states no day count" wording.
- R05-03 — notice text lacks the cancel/refund statement.
- R05-05b — depends on an unstated local-day rule (X6).
- X3 "not yet" outcomes lack a machine-readable re-evaluation date.

R01 has no fixtures to review.

---

# M09b re-review of the revised R01–R05 (2026-09-23)

| Field | Value |
|---|---|
| Task | M09b — re-check M2D against the primary text; D152 sign-off; final verdicts |
| Reviewer | `opus-rules-reviewer` (Opus 5.5, `claude-opus-5-5`), same independent instance as M09. I did not consult the researcher and did not rely on its resolution table. |
| Base revision | `783a803`. Rules files as of `2ee5dac`: M2D commits `72fe1a2`, `29ea774`, `880ec8e`, `3ef4027`, `06be10a`, `ec9e603`, `2743862`, `2ee5dac`. No `docs/rules/**` change after `2ee5dac`. |
| Rulings read | D147, D151, D152; contract rev 5.3 §2.7 and §4 (`deriveOutcome` rules 4b and 5a–5c, `computeDeadline`) |
| Method | Same as M09:<br>• recomputed all 23 manifest hashes;<br>• re-fetched primary sources where a new capture or hash claim could be checked;<br>• decided every new or changed fixture result **before** reading its `expected` block: all 154 results in the six files (R01 v1 35, R01 v2 30, R02 24, R03 18, R04 24, R05 23). |

> Engineering review is not legal certification (M09 header applies unchanged).

## B.0 Final verdicts

| Pack | Verdict | Blocking items |
|---|---|---|
| **R01 v1** (legacy snapshot tier, `fixtures/R01.json`) | **approve_for_activation** | none |
| **R01 v2** (reviewed merchant tier, `fixtures/R01v2.json`) | **approve_with_changes** | 3 fixture staleness defects; 2 spec sentences (B.8) |
| **R02** | **approve_with_changes** | 2 fixture outcome disagreements; decisive-fact list does not match the fixtures (B.8) |
| **R03** | **approve_with_changes** | §11 / §16 step 6 conflict with D152 5c; R03-07; deadline representation in R03-01b/07b (B.8) |
| **R04** | **approve_with_changes** | 1 spec edit: path a temporal gate (B.8). Every fixture agrees. |
| **R05** | **approve_with_changes** | R05-04 notice adequacy; decisive-fact list vs fixtures; deadline representation in R05-01b/10b (B.8) |

- Every M09 source claim marked `unsupported` or `contradicted` is now resolved.
- No new claim is unsupported by the text.
- The remaining work is alignment between fixture, spec, contract and D152. No pack is rejected.

## B.1 Integrity and new captures

**Manifest.** All 23 manifest hashes match: 18 captures and 5 fixture files, recomputed with `shasum`.

**New captures — do they support what they are cited for?**

| Capture | Reviewer check | Supports its citation? |
|---|---|---|
| `federal-register-notices.txt` (12 FR passages) | Re-fetched the full text of 2011-31715, 2014-22092, 2025-08286 and 2024-23588: **SHA-256 identical** to the file's values. DATES passages found verbatim ("This interim final rule is effective December 30, 2011."; "…will become effective on December 8, 2014."; the BNPL interpretive rule listed; "$3,800 to $4,700"). The other 8 DATES texts match the FR API values I read in M09 (§1.2). | yes: R02 header dates, R02 L1 pause history and gap, R02 L12, R03 header and L5, R04 header and §10, R05 header |
| `ecfr-12cfr1026.7-9-excerpt.txt` | Re-fetched eCFR point-in-time 2026-09-18: raw SHA-256 **`cec7f74c…7bce8d` reproduced**. (a)(9) and (b)(9) text verbatim. | yes (R03 P-1026.7(b)(9)) |
| `ecfr-12cfr1026.12b-excerpt.txt` | Raw `c4b8895e…c67f38` reproduced. "…shall not exceed the lesser of $50 …" present. | yes (R03 §4 note) |
| `ecfr-12cfr1005.6.txt`, `ecfr-12cfr1005.11c-excerpt.txt` | Raw `0669a14f…10d0` reproduced. The two-business-day and 10-business-day texts are present. | yes (R03-04 explanation; TRIAGE R13) |
| Excerpts DOT-BAG-9, DOT-BAG-10 | transportation.gov still 403s curl and WebFetch, so I **could not re-verify** them. Added in M2D "from the same browser session". | Labelled guidance-only; used only as guidance. **Acceptable at lower assurance.** |
| Excerpts FTC-MITOR-G7, G8 | curl of the FTC business guide: **both passages verbatim** on the live page | yes (R05 §7 partial shipment → amount `manual_review`; §10 order-status page) |

## B.2 Resolution of every M09 item (checked in the files)

| M09 item | Status | Evidence / remainder |
|---|---|---|
| X1 confirmed-fact threshold | **partially** | README cross-pack rule 1, `unconfirmed_decisive_facts`, and cap variants R02-01d, R03-01b, R04-01b, R05-01b. **Remainder:** the decisive-fact lists in R02 §16.8 and R05 §16.7 name facts that several `eligible` fixtures omit (B.4). |
| X2 conflict candidates encoded | **resolved** (README wording, see B.7) | Candidates are encoded in R01-15, R01v2-15, R02-07, R03-07, R04-09, R05-10. Every file has a same-side variant. README rule 3 still says "the outcome stands" (uncapped), while D152 says capped. |
| X3 not-yet-due | **resolved** | `not_yet_due` + `reevaluate_at`/`reevaluate_when` in R04-03b and R05-04b/04c/05a/05b/07; contract rev 5.2 adds it. README rule 4 and the outcome-mapping row still say "no `not_yet_due` value yet", which is stale. |
| X4 publication vs effective dates | **resolved** | R03 and R05 headers corrected; manifest `dates`; FR captures verified (B.1) |
| X5 missing-source variants | **resolved** | R02-11b, R03-10b, R04-10b, R05-11b, R01v2-09b, R01-04 |
| X6 calendar-day zone | **resolved** | R02 A1 (fixed), R03 A4, R04 A3, R05 A5 (R05-05b now carries `ship_to_timezone`), R01 `calendar_zone` |
| R01.6-1 fixtures | **resolved** | `R01.json` (35 results), `R01v2.json` (30). Three construction defects in v2 (B.4). |
| R01.6-2 `window.constrains` | **resolved** | Best Buy `price_change`, Target `request`, Costco `price_change` (+`request` for promo items, CO-3), Apple `both`; manifest `windows` agrees |
| R01.6-3 `unsupported` vs `source_unverified` | **resolved** | §6: no pack → `unsupported`; pack exists but channel/version not captured or stale → `source_unverified`. §7.3 and §7.4 agree. |
| R01.6-4 ask anyway; max effective date | **resolved** | §1.4, §1.5; R01v2-02 |
| R01.6-5 normalized content hash | **resolved, one procedure gap** | See B.3. Reproducible only after a whitespace trim that §2.1 does not state. |
| R01.6-6 Target Plus, Costco reseller | **resolved** | TG-2/TG-3 and CO-1 facts; R01v2-05b, 06b, 06c |
| R02.6-1 operational delay | **resolved** | §4, §16.3, enum `operational_delay`; R02-05b/05c |
| R02.6-2 partial itinerary (A4) | **resolved** | §8; R02-01c amount `manual_review` |
| R02.6-3 anchors | **resolved** | (iii)(B) changed-flight date added, A7, §16.7 departed case |
| R02.6-4 "on or about" rule | **resolved** | A1 now "different calendar dates in the two zones" |
| R02.6-5 temporal gate; pause history | **resolved** | §16.1b; L1 history including the 2026-07-01..06 gap; R02-01e |
| R02.6-6 (a)(4) qualification; DOT-REF-8 | **resolved** | §12.4; L10 |
| R02.6-7 fixtures | **partially** | X1, X2, R02-11 clock and R02-05 null are fixed. **New:** R02-07b and R02-09b disagree (B.4). |
| R03.6-1 dates | **resolved** | 2011-12-30; 2019-04-01 |
| R03.6-2 credit split; act-by per type | **resolved** | `credit_issued_not_reflected` vs `promised_credit_not_issued`; per-type lower bound; `credit_issue_date` |
| R03.6-3 email wording | **resolved** | §10 now states the safe harbor and the receipt-at-address basis |
| R03.6-4 captures, citation, P2P | **resolved** | 1026.7 captured; "1666(a), subparagraph (B)(ii)"; L9 |
| R03.6-5 fixtures | **partially** | X1, X2, R03-04 text and X6 are fixed. **New:** §11 / §16.6 vs D152 5c (B.7); deadline representation (B.4). |
| R04.6-1 lead ruling (D147(1)) | **resolved** | Path a may be `eligible`; D143(4) cap on b/c only |
| R04.6-2 path b cap; authority class | **resolved** | §15.3 v1 cap; header |
| R04.6-3 large-aircraft fact | **resolved** | `large_aircraft_segment_on_ticket`; R04-04b, R04-06 assumption |
| R04.6-4 (f)(2) "documented by the carrier"; pre-existing damage | **resolved** | `exemption_documented_by_carrier`; R04-07b; DOT-BAG-9 (guidance-only, not re-verifiable) |
| R04.6-5 "before leaving the airport" | **resolved** | DOT-BAG-10 (guidance-only, not re-verifiable) |
| R04.6-6 bag-fee timing wording | **resolved** | §10, L6, fixture R04-01 |
| R04.6-7 $3,800 capture; enforcement note; refresh window | **resolved** | FR-2024-23588 SUMMARY; §10 enforcement-window display; 30 days everywhere; R04-06b, R04-10 |
| R04.6-8 conflict; fixtures | **resolved** | L9; X1/X2/X3; E4 currency. **New, small:** path a has no compliance-date gate (B.8). |
| R05.6-1 dates | **resolved** | effective 2014-12-08 |
| R05.6-2 notice adequacy | **partially** | Spec §8 and R05-03/03b are fixed. **R05-04's notice has no adequacy fact, and its text does not offer cancellation** (B.4). |
| R05.6-3 cancel before R | **resolved** | §8.2 |
| R05.6-4 sent; counting start; statement alternative | **resolved** | §9, A6 |
| R05.6-5 partial shipment; order-status page | **resolved** | G7 / G8 (verified live); amount `manual_review`; R05-01c |
| R05.6-6 calendar zone | **resolved** | A5; R05-05b |
| R05.6-7 fixtures; enum | **partially** | X1/X2/X3 fixed, `paid_at_order` renamed. **New:** decisive-list completeness (B.4). |

**Appendix A items (M09 unsupported/contradicted).** All 14 are resolved:
- **Captured and reproduced by me:** 1026.7(b)(9), 1026.12(b), the BNPL withdrawal, the Reg E clocks, and the $3,800 figure.
- **Relabelled with correct dates:** R03 and R05 effective dates.
- **Captured as guidance and verified live:** R05 partial shipment and order-status page.
- **Captured as guidance, not re-verifiable (403):** R04 pre-existing damage and "before leaving the airport".
- **Removed:** the R05 civil-penalty figure.
- **Fixed:** the R01 §6 contradiction and R02 §8.

## B.3 R01 redesign — reviewer checks

- **Content hashes reproduce, with one unstated step.** I re-fetched Apple, Costco and Target on 2026-09-23 and applied §2.1 exactly:
  - drop script/style/noscript/svg;
  - replace other tags with a space;
  - decode entities, apply NFC, collapse whitespace;
  - cut from `section_start` (inclusive) to `section_end` (exclusive).

  The result does **not** match `02f32d90…`, `9cc32d9c…` or `2a44c2f6…`. With a final **trim of leading and trailing whitespace**, all three match exactly. §2.1 must add the trim, or two implementations will disagree forever.
- **Passage hashes.** All 11 (BB-1..3, TG-1..3, CO-1..3, AP-1..2) reproduce from the quoted text. The nine non-Best-Buy passages are present verbatim on today's pages.
- **Best Buy "lower assurance, passage-only"** is honest: curl is still bot-walled, and my M09 WebFetch was model-mediated. §9 L5 records it.
- **Window model.** `constrains` per merchant matches the passages as I read them in M09.
- **Missing day-counting rule in the spec.** `R01v2.json` conventions state "Best Buy: receipt day = day 1" (from BB-3, "begins the day you receive"), which gives R01v2-01's 2026-09-24. Spec §5 says "end = anchor + length", which would give 2026-09-25. §5 / §7.1 must carry the day-1 rule.
- **R01 v1 parity constants.** I checked them against today's legacy code:
  - `priceDropCents` threshold `max(100, round(2%))`;
  - `windowEndsAt` 24-hour multiples, with `endsAt < now` = closed (so `now == endsAt` is open, as R01-05b expects);
  - remainder rule `max(100, round(unit×qty×2%))`;
  - `MIN_CONFIDENCE 0.7`;
  - `MIN_PLAUSIBLE_FRACTION 0.1`.

  All match the fixture conventions.

## B.4 Blind fixture decisions — disagreements only

I decided 154 results blind. The table lists every result where my decision differs from the fixture. The other 145 agree on outcome, missing facts, amount and dates.

| Fixture | Mine (from the text) | Fixture | Why | Fix |
|---|---|---|---|---|
| **R02-07b** | `needs_facts` [ticket_refundability] | `likely_eligible` | R02-07's facts have no `ticket_refundability`, which is an applicability condition (§2.2; 260.6(a)(1) "holds a nonrefundable ticket"). By contract `deriveOutcome`, rule 6 (applies unknown) fires after 5c. The same-side variant therefore tests two things at once. | Add `ticket_refundability`, `consumer_response_at` and the amount inputs as `user_confirmed` to R02-07 so the variant isolates the conflict. |
| **R02-09b** | `likely_eligible` | `eligible` (21,210) | `already_refunded` is absent. §16.8 lists it as a decisive amount input, and D147(2) says an unknown amount input keeps the outcome at `likely_eligible`. | Add `already_refunded {0 USD, user_confirmed}` to R02-09. |
| **R05-04**, **R05-04b**, **R05-04c** | `needs_facts` [delay_notice_offers_cancel_and_refund] | eligible 2026-10-21 / not_yet_due / not_yet_due | The notice has no adequacy fact, and its text ("We are unable to provide a new ship date.") offers no cancellation. Under revised §8, unknown → `needs_facts`. If the text is read as complete, the notice is inadequate → case 1 → vesting 2026-09-11 → refund sent by **2026-09-22**, not 10-21. | Add `delay_notice_offers_cancel_and_refund: true` (user_confirmed) and a notice text that offers cancel + prompt refund to R05-04. The expected blocks then stand. |
| **R01v2-03b** | `source_unverified` | `deadline_passed` | Inherits `last_verified_on 2026-09-20`, 7-day window. The clock of 2026-09-30 is 10 days later, so it is stale. `deriveOutcome` rule 2 precedes rule 4. | Give the variant `source.last_verified_on` ≥ 2026-09-23. |
| **R01v2-04c** | `source_unverified` | `likely_eligible` | Case source 2026-09-19; clock 2026-09-29 is 10 days later → stale | Variant source ≥ 2026-09-22 |
| **R01v2-04d** | `source_unverified` | `deadline_passed` | Clock 2026-09-30 is 11 days later → stale | Variant source ≥ 2026-09-23 |

**Decisive-fact lists vs fixtures (spec ↔ fixture; outcome unchanged if the list is narrowed).** Six `eligible` fixture results omit a fact that the pack's own decisive list names:
- **R02 §16.8:**
  - R02-02b, 02c, 05b, 06 and 09b lack `operating_carrier`/`marketing_carrier`;
  - R02-02b, 02c and 05b lack `offer_type`;
  - all of them lack `ancillary_fees_paid` (missing ≠ zero).
- **R05 §16.7:** R05-04, 05c and 07b lack the countries; R05-04 and 05c lack `payment_terms`.

Either complete the fixtures, or make the lists conditional. For example: carrier identity is decisive only when coverage is not derivable from a US-point scheduled itinerary; `offer_type` only on offer-based deemed-request paths; `payment_terms` only where the 50-day rule could apply. An evaluator cannot pass both the spec as written and these fixtures.

**Deadline representation vs contract `computeDeadline` (fixture ↔ contract).** Contract §4 says:
- a `candidate` anchor → `unknown_anchor`, with no `dueAt`;
- a `conflicting` anchor → `disputed_anchor`.

Four fixtures instead assert a firm `deadline.date` from an unconfirmed or disputed anchor:
- R03-01b (2026-11-09);
- R03-07b (2026-10-31);
- R05-01b (2026-09-16);
- R05-10b (2026-09-16).

Mission §9: "Never infer the legal anchor from whichever date is easiest to extract." Fix the fixtures:
- **User-obligor (R03):** `date: null`, status `unknown_anchor` / `disputed_anchor`, `advisory_act_by` = earliest candidate + 60.
- **Counterparty-obligor (R05 seller refund):** `date: null`. No "overdue" escalation is computed from an unconfirmed anchor.

R01-15b's `claim.windowEndsAt` = earliest candidate is a legacy claim field, not a `DeadlineResult`. It is conservative and acceptable.

**Non-blocking observations.**
- R01v2-15 models "carrier delivered to the leasing office on 09-01" vs "user picked it up on 09-03" as a fact conflict. Both can be true; the real question is what Apple's "the date you receive your product" means. The outcome (`needs_facts`) is acceptable, but a user answer cannot settle an interpretation. Consider `manual_review` ("merchant decides") for delivered-to-agent cases.
- R02 `conventions.fact_encoding` still lists 5 states while `fact_states` lists 7.
- R05-04b should carry `next_action` "you can cancel before shipment for a refund". Its `reevaluate_when` is the user's own action, not something to wait for.

## B.5 Sign-off (item 4): same-answer conflict capped at `likely_eligible` (D152 / contract rule 5c)

**I sign off, with four conditions.**

**Why the cap is right under mission §9.**
- A conflict whose candidates all give the same outcome leaves the rule's result certain but a decisive fact unconfirmed. `likely_eligible` states exactly that: "rule applies; evidence or a confirmation outstanding".
- It does **not** turn uncertainty into eligibility: `eligible` stays unreachable until the user resolves the fact (D147(2)).
- `needs_facts` would be worse. It is not approvable, so it would block a packet whose outcome cannot change. For R03 that would delay a time-sensitive notice, which mission §10 forbids.

**Conditions.**
1. **Same answer means the same outcome *and* the same amount.** If candidates give different claim amounts (e.g., two extracted fares), the conflict is material → rule 5b `needs_facts`. The contract's `sameAnswer` currently compares only the outcome. No current fixture has differing amounts, so this is a contract edit, not a fixture edit.
2. **Deadlines never take a candidate's date.**
   - A conflicting anchor stays `disputed_anchor` (no `dueAt`).
   - User-obligor paths show a labelled advisory act-by from the **earliest** candidate.
   - Counterparty paths compute no overdue/escalation date until resolved.
   - The four fixtures in B.4 must change accordingly.
3. **The cap is lifted only by confirmation.** The same "which is right?" question as 5b is asked, showing both values and sources. The fact appears in `unconfirmed_decisive_facts`.
4. **5c applies to kind `candidates` only.** A `confirmed_vs_observed` or `confirmed_vs_confirmed` conflict stays rule 5a `manual_review` even when every value gives the same outcome. A packet or letter would otherwise state a user-confirmed value that the system's own evidence contradicts (mission §6: AI must not present unsupported facts; packets must be truthful). The contract currently says "every conflict has sameAnswer = true → skip 5a/5b"; narrow that to "every conflict is of kind candidates and has sameAnswer = true".

**Consequential edit.** README cross-pack rule 3 must say "the outcome stands, **capped at `likely_eligible`**" to match D152. Fixture conventions R02–R05 already say this.

## B.6 Item 5: `not_yet_due` as its own result

**Agree.** Mission §9's outcome list is illustrative ("such as"), and its logic of "missing ≠ false" and "unsupported ≠ not eligible" applies equally to an unripe path. Reporting a path that will ripen as `not_eligible` would mislead.

The contract design (rule 4b) is right on each point:
- it sits below `not_eligible` and `deadline_passed`;
- an unknown ripeness fact stays `needs_facts`;
- it is not approvable;
- it is excluded from money tiles;
- date re-evaluation runs through the M29 sweep, which re-reads state (mission §6 scheduling).

Two conditions:
- When `reevaluate_when` is an action the user controls ("MBR filed", "buyer cancels before shipment"), the result must carry that action as `next_action` and the UI must present it as something the user can do now, not as "wait". R04-03b has it; R05-04b does not.
- README rule 4 and the mapping row still say the contract lacks the value. Rev 5.2 added it, so update the README.

## B.7 D152 alignment — fixtures whose expected result disagrees with D152

| Fixture | D152 rule that applies | Fixture expects | Should be |
|---|---|---|---|
| **R03-07** | 5c. Candidates (08-01 PDF; 09-01 user recollection) both leave the window open on the clock date, so the outcome is the same. | `needs_facts` | `likely_eligible_missing_evidence`, `unconfirmed_decisive_facts: [first_statement_transmitted_on]`, deadline `disputed_anchor` with advisory act-by **2026-09-30** (earliest + 60) |
| R03 spec §11 "Conflicting anchors → outcome `needs_facts`" and §16 step 6 | 5b / 5c split | always `needs_facts` | `needs_facts` only when candidates give different outcomes; otherwise 5c + advisory (as R03-07b already does) |
| README cross-pack rule 3 | 5c cap | "outcome stands" (uncapped) | "stands, capped at `likely_eligible`" |

Checked and **consistent** with D152:
- **Divergent candidates → `needs_facts`:** R01-15, R01v2-15, R02-07, R04-09, R05-10.
- **Same-answer variants → capped:** R01-15b, R01v2-15b, R02-07b, R03-07b, R04-09b, R05-10b. R02-07b's outcome is still wrong for a separate reason (B.4).
- **Rule 5a:** no fixture encodes a `user_confirmed` value against an observed or confirmed value, so none is tested. I recommend one 5a case per file in wave 2. D152's own example (user-confirmed delivery on the 3rd vs carrier tracking on the 9th) fits R05 or R03.

## B.8 Required changes (exact) before each pack can be encoded as active

**R01 v2**
1. §2.1: append "trim leading and trailing whitespace" before hashing. The three content hashes reproduce only with it.
2. §5 / §7.1: "Best Buy's period 'begins the day you receive' (BB-3): receipt day = day 1, so the last day = `received_at` + length − 1" (matches R01v2-01's 2026-09-24).
3. Fixtures R01v2-03b, 04c, 04d: set a variant `source.last_verified_on` within 7 days of the variant clock.

**R02**
1. R02-07: add `ticket_refundability`, `consumer_response_at`, `fare_paid`, `taxes_paid` and `already_refunded` (user_confirmed), so R02-07b tests only the conflict.
2. R02-09: add `already_refunded {0 USD, user_confirmed}`.
3. §16.8 decisive list vs fixtures: complete R02-02, 05, 06 and 09, or make the carrier and `offer_type` entries conditional (B.4). Add `ancillary_fees_paid: []` (confirmed) where no fees exist.

**R03**
1. §11 "Conflicting anchors" row and §16 step 6: apply D152 5b/5c.
2. R03-07 → capped result per B.7.
3. R03-01b and R03-07b: replace `deadline.date` with `date: null` + `unknown_anchor` / `disputed_anchor` + `advisory_act_by` (2026-11-09 / 2026-10-31).

**R04**
1. §15: add step 1b as in R02. Deemed-refund conditions met (or incident) before the part 260 bag-fee compliance date 2024-10-28 → `source_unverified`. Add one variant.

**R05**
1. R05-04: add the adequacy fact (true, user_confirmed) and an adequate notice text.
2. §16.7 decisive list vs fixtures: add countries and `payment_terms` to R05-04, 05c and 07b, or make those entries conditional.
3. R05-01b and R05-10b: `deadline.date: null`, no computed seller-refund date from an unconfirmed or disputed anchor.
4. R05-04b: add `next_action`.

**Cross-pack**
1. README rule 3: add the cap wording. README rule 4 and the mapping row: remove "no `not_yet_due` value yet".
2. Contract rule 5c (architect, rev 5.4): `sameAnswer` must compare the amount too, and 5c must apply to kind `candidates` only (B.5 conditions 1 and 4).
3. The lead records this sign-off in DECISIONS so M12 can un-pend the 5c variants.

**Recommended, not blocking.**
- One rule-5a fixture per file.
- R02 departure-earlier 3 h and international 6 h boundaries.
- R04 incident in the 2025-02-20..03-19 non-enforcement window.
- R05 cancellation received after R.
- R01v2-15 re-modelled as `manual_review`.
