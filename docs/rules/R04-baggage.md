# R04 — Delayed, lost, or damaged checked baggage (US domestic liability + bag-fee refund)

| Field | Value |
|---|---|
| Stable id | `R04.baggage.us_dot` with three **separate** paths: `R04.a` bag-fee refund · `R04.b` delayed-bag incidental expenses · `R04.c` lost/damaged property |
| Version | `v1` |
| Review status | **researched** — not `active`; needs an independent reviewer. Not legal advice. |
| Authority class | a: legal entitlement (a regulatory refund duty, 260.5). b/c: **carrier liability** — the regulation sets a federal floor on the cap a carrier may impose (254.4); the duty to reimburse rests on carrier liability and DOT enforcement guidance (DOT-BAG-1/2), not on a regulation granting reimbursement. |
| Authority subtype | Federal regulation (14 CFR 260.2, 260.5, 260.10 for path a; 14 CFR part 254 for b/c) + DOT guidance (consumer page) |
| Jurisdiction | a: covered flights to/from/within the US (part 260). b/c: **interstate/intrastate (domestic) US air transportation** (254.2). International itineraries are governed by treaty (Montreal/Warsaw) → `unsupported` for b/c in v1. |
| Published | part 260: 89 FR 32760 (2024-04-26); §254.4 $4,700: 89 FR 84815 (2024-10-24, FR 2024-23588) |
| Effective | part 260: 2024-06-25. $4,700 figure: **2025-01-22** (FR-2024-23588 DATES; its SUMMARY: "…from the current amount of $3,800 to $4,700."). Enforcement of the new figures delayed from 2025-02-20 to 2025-03-20 (FR-2025-02814 DATES). All in `sources/federal-register-notices.txt`. |
| Compliance | part 260 bag-fee refund: **2024-10-28** (FR-2024-07177-COMPLIANCE) |
| Retrieval date | 2026-09-23 |
| Last verification date | 2026-09-23 (eCFR point-in-time 2026-09-18) |
| Refresh policy | **30 days for every path.** In addition, from 2026-10-01 the Federal Register is checked monthly for the 2026 biennial adjustment (254.6: reviewed every two years using July CPI-U; 2024 was the last review year, so 2026 is a review year). |
| Reviewer | — (unassigned) |

Captured sources: `sources/ecfr-14cfr260.txt`, `sources/ecfr-14cfr254.txt`, `sources/federal-web-pages-excerpts.md` (DOT-BAG-*, DOT-REF-8).

---

## 1. Paths — separate opportunities, never merged (mission §10)

| Path | Remedy | Basis | Cash? | Relationship |
|---|---|---|---|---|
| `R04.a` bag-fee refund | refund ≥ the fee paid for **that** bag | 14 CFR 260.5 | cash (original payment form) | **complementary** to b and c (distinct loss line: the fee) |
| `R04.b` delayed-bag incidental expenses | reimbursement of reasonable, verifiable, actual expenses | 14 CFR 254.4 (liability) + DOT-BAG-1/2 | cash | complementary to a; shares the **per-passenger** liability limit with c |
| `R04.c` lost / damaged property | repair / depreciated value of bag + contents | 14 CFR 254.4 + DOT-BAG-6/7 | cash or repair (non-cash) | shares the per-passenger limit with b |
| card baggage-delay / lost-luggage benefit | per exact guide | contract (R12/R06) | varies | **not R04**; coordination per guide; the same receipt line may be allocated to only one remedy |

## 2. Applicability

- **a:** checked bag (incl. gate-checked/valet, 260.2) on a covered flight; bag **lost** (per the carrier's declaration) or **significantly delayed** (§4); passenger filed a **Mishandled Baggage Report (MBR)** with the operating carrier (or the carrier operating the last segment); a bag fee was actually paid.
- **b/c:** domestic itinerary; loss, damage, or delay of property **in the carrier's custody**; claim filed with the carrier under its contract of carriage.

## 3. Trigger

Bag not received at the final destination at deplaning, or received damaged, or later declared lost.

## 4. Significant delay (path a) — definition and measurement

| Itinerary | Threshold (bag not delivered/picked up **within**) |
|---|---|
| Domestic | **12 hours** |
| International with a non-stop US↔foreign segment **≤ 12 h** in duration | **15 hours** |
| International with a non-stop US↔foreign segment **> 12 h** | **30 hours** |
| Domestic segments of international itineraries | the 15 h / 30 h standard applies |

- **Start:** when the passenger "is given the opportunity to deplane" at the final destination (not scheduled arrival, not gate arrival) — 260.5(a).
- **End:** delivery to the agreed location, or pickup by the passenger (or someone acting for them) at the final-destination airport — 260.5(a).
- **Boundary:** "not delivered … within 12 hours" → delivered at exactly 12:00:00 elapsed is within → **not** significantly delayed; 12:00:01 or more → significantly delayed (assumption A1 — inclusive "within"). Minute granularity in fixtures.

## 5. Required facts (typed)

| Fact | Type | Unit / domain | Source of truth | Paths |
|---|---|---|---|---|
| `itinerary_scope` | enum | `domestic` \| `international` \| `non_us` | ticket | all |
| `longest_us_foreign_nonstop_segment_minutes` | integer | minutes | itinerary | a (15 h vs 30 h) |
| `operating_carrier_last_segment` | string | IATA | ticket / boarding pass | a (who refunds / who got MBR) |
| `bag_fee_merchant_of_record` | enum | `carrier` \| `ticket_agent` \| `unknown` | card statement | a (claim from airline either way — DOT-REF-8) |
| `bag_fee_paid` | money | minor units + currency, per bag tag | receipt / statement | a |
| `bag_tag_number` | string | 10-digit license plate | bag tag stub / receipt | a, b, c |
| `deplane_opportunity_at` | datetime | ISO-8601 with offset | carrier arrival record; user | a |
| `bag_delivered_or_picked_up_at` | datetime \| null | ISO-8601 with offset | delivery record / courier receipt; user | a, b |
| `large_aircraft_segment_on_ticket` | boolean \| unknown | any segment on the ticket uses an aircraft with more than 60 seats (254.3/254.4) | itinerary equipment codes; user | b, c |
| `exemption_documented_by_carrier` | boolean \| unknown | for 260.5(f)(2): the carrier documented the passenger's fault | carrier record | a |
| `bag_status` | enum | `delivered` \| `delayed_undelivered` \| `declared_lost` \| `damaged` \| `pilfered` | carrier file / user | all |
| `mbr_filed` | boolean \| unknown | – | MBR reference number / screenshot | a (precondition), b, c |
| `mbr_reference`, `mbr_filed_at` | string, datetime | – | carrier | a, b, c |
| `exemption_facts` | object | `failed_recheck_at_first_us_entry`, `failed_pickup_on_time_bag`, `voluntary_separation_agreed` (booleans) | user / carrier record | a |
| `expense_lines` | array | {date, merchant, description, amount (minor+currency), receipt evidence id, allocated_to (remedy id \| null)} | receipts | b |
| `property_items` | array | {item, purchase date, cost, claimed value, proof} | receipts / photos | c |
| `carrier_liability_limit` | money \| unknown | carrier's contract-of-carriage limit (must be ≥ floor) | carrier CoC (captured per carrier) | b, c |
| `carrier_claim_deadlines` | object \| unknown | carrier CoC report/claim deadlines | carrier CoC | b, c |
| `reimbursements_received` | money[] | from carrier, card benefit, insurer | statements | b, c, overlap |

## 6. Exclusions

- a: delay caused by failure to pick up and recheck at the **first US international entry point** (CBP); failure to pick up an on-time bag (e.g., "hidden city") **if documented by the carrier** (260.5(f)(2) — a user statement alone does not trigger this exemption; `exemption_documented_by_carrier` must be true); **voluntary** agreement to travel without the bag (late check-in / standby) — 260.5(f). The voluntary-separation exemption does not waive refund of the fee if the bag is **lost**, or incidental expenses beyond the agreed delivery date (260.5(g)).
- a: no MBR filed → the obligation does not arise (260.5(b)).
- b/c: items excluded in the carrier's contract of carriage are not compensable on **domestic** travel (DOT-BAG-7, guidance-only); pre-existing damage / improper packing (DOT-BAG-9, guidance-only); international itineraries → `unsupported` (treaty; not captured).

## 7. Remedies and calculation

- **a:** `refund ≥ fee paid for that bag` (260.5(e)); escalated fee scales: fee correlated to the bag's unique identifier, else the **highest** per-bag fee; subscription programs: lowest fee a comparable non-subscriber would pay (260.5(e)(1)-(2)). Original form of payment (260.10). No cap.
- **b:** `estimate = Σ documented, reasonable, actual expense lines not allocated to another remedy`. Undocumented lines are shown separately as "needs receipt" and **excluded** from the estimate. No arbitrary per-day cap may be imposed by the carrier (DOT-BAG-2).
- **c:** `estimate = unknown` until the carrier's depreciation and valuation are known; show documented purchase values as **evidence**, never as the payout.
- **b+c combined ceiling:** the carrier may limit its liability for all provable direct/consequential damages from loss, damage, or delay of a passenger's property to **its own stated limit, which may not be less than $4,700 per passenger** (254.4). The limit is a **ceiling on liability, not a payout** (mission §10). Display: "Carrier liability limit: at least $4,700 per passenger (federal floor on the carrier's cap); actual reimbursement depends on documented losses."
- Money: integer minor units; per currency; the bag fee (a) must not also appear as an expense line (b).

## 8. Evidence checklist

1. Boarding pass / e-ticket (itinerary, carrier, segments).
2. Bag tag stub / bag tag number.
3. MBR (reference number, filing timestamp).
4. Delivery record: courier slip / carrier message with delivery time; or pickup time.
5. Bag-fee receipt (per bag) and merchant of record.
6. b: itemized receipts for each expense line with date after the arrival and before delivery (reasonableness is the carrier's determination).
7. c: photos of damage; repair estimate; purchase receipts for contents; the carrier's lost declaration.
8. Any reimbursement already received (carrier, card benefit, insurer).

## 9. Notice / filing / response requirements

- a: MBR with the carrier that operated the flight / last segment (260.5(b)). No federal deadline for filing the MBR is stated; DOT "encourage[s]" filing immediately (DOT-BAG-8). The refund is then automatic.
- b/c: claim filed with the carrier under its **contract of carriage**; deadlines are carrier-specific and were **not** captured in this run (no federal deadline in part 254). DOT: "Report any problems to the airline before leaving the airport" (DOT-BAG-10, Baggage Tips) — guidance-only, not a legal deadline.
- Ordinary email: part 254 sets no notice form; the carrier's contract sets the channel. Recoup must use the carrier's stated channel (captured per carrier) and not assume that email suffices.

## 10. Deadlines

| Item | Anchor | Semantics | Status |
|---|---|---|---|
| a — carrier issues the bag-fee refund | the date all of the following hold: bag significantly delayed (or declared lost), MBR filed, and (multi-carrier) the MBR carrier notified the refunding carrier — 260.5(d) | 260.5 requires a **prompt refund**; the regulation's 7-business-day / 20-calendar-day definition of "prompt refund" (260.2) is anchored to §260.6(a)(2) fare-refund events, which have no bag-fee analogue, so Recoup computes **no date** for bag fees | informational |
| a — consumer MBR filing | none in federal text | – | none |
| b/c — carrier claim deadlines | carrier contract of carriage | carrier-specific | **not captured** → `manual_review` for timeliness until captured per carrier |
| Liability-limit figure | FR adjustment effective date | the evaluator uses the limit in force on the **incident date** — $4,700 for incidents on/after 2025-01-22, $3,800 before (FR-2024-23588 SUMMARY/DATES, captured). For incidents 2025-01-22 … 2025-03-19, display that DOT delayed **enforcement** of the new figure to 2025-03-20 (FR-2025-02814); the legal effective date is unchanged | versioned parameter |
| Calendar-day zone (D147(4)) | path a uses durations between instants (no calendar day). The incident **date** that selects the limit version is the local date at the final-destination airport (assumption A3). b/c carrier deadlines: not captured | – | – |

## 11. Claim channel and escalation

a: automatic after the MBR → track; if no refund, request via the carrier's refund channel; escalate to a DOT complaint. b/c: the carrier's baggage-claim channel per contract of carriage → DOT complaint → small claims (out of scope). Card benefit (R12/R06) is a separate claim with its own guide. Third-party preparation: no restriction found in parts 254/260; the claim is the passenger's.

## 12. Exact supporting passages (verbatim; public domain)

**P-260.2-SDB** — 14 CFR 260.2
> Significantly delayed checked bag means a checked bag not delivered to or picked up by the consumer or another person authorized to act on behalf of the consumer within 12 hours of the last flight segment's arrival for domestic itineraries, within 15 hours of the last flight segment's arrival for international itineraries with a non-stop flight segment between the United States and a foreign point that is 12 hours or less in duration, and within 30 hours of the last flight segment's arrival for international itineraries with a non-stop flight segment between the United States and a foreign point that is more than 12 hours in duration. The 15-hour and 30-hour standards apply to domestic segments of international itineraries.

**P-260.5-A** — 14 CFR 260.5(a)
> (a) Determining the length of delay for the bag. For the purpose of determining whether a checked bag is significantly delayed as defined in § 260.2, the length of delay is calculated from the time the passenger is given the opportunity to deplane from a flight at the passenger's final destination airport (the beginning of the delay) to the time that the carrier has delivered the bag to a location agreed upon by the passenger and carrier (e.g., passenger's home or hotel) or the time that the bag has been picked up by the passenger or another person acting on behalf of the passenger at the passenger's final destination airport (the end of the delay).

**P-260.5-B** — 14 CFR 260.5(b)
> (b) Notification by passenger about lost or significantly delayed bag. A covered carrier does not have an obligation to provide a refund of the fee for a lost or significantly delayed checked bag unless a passenger files a Mishandled Baggage Report (MBR) for the lost or delayed bag with the carrier that operated the flight, or for multiple-carrier itineraries, the carrier that operated the last segment of the consumer's itinerary.

**P-260.5-D** — 14 CFR 260.5(d)
> (d) Automatic refunds. An automatic refund of a bag fee is due when a checked bag is significantly delayed as determined according to paragraph (a) of this section, the passenger has filed an MBR as provided in paragraph (b) of this section, and, if applicable, notification has been provided by the carrier that received the MBR as set forth in paragraph (c) of this section.

**P-260.5-E** — 14 CFR 260.5(e) (opening)
> (e) Amount of the refund. The amount of the refund issued to a consumer must be a value equal to or greater than the fee that the consumer paid to transport his/her checked bag.

**P-260.5-F** — 14 CFR 260.5(f)
> (f) Exemptions from the refund obligation. A covered carrier is exempted from the obligation to refund the fee for a significantly delayed bag in situations where the delay resulted from:
>
> (1) A passenger's failure to pick up and recheck a bag at the first international entry point into the United States as required by U.S. Customs and Border Protection;
>
> (2) A passenger's failure to pick up a checked bag that arrived on time at the passenger's ticketed final destination due to the fault of the passenger if documented by the carrier (e.g., passenger ended the travel before reaching the final destination on the itinerary—“hidden city” itinerary, or the passenger failed to pick up the bag before taking a flight on a separate itinerary); and
>
> (3) A passenger's voluntary agreement to travel without the checked bag on the same flight as described in paragraph (g) of this section.

**P-254.2** — 14 CFR 254.2
> This part applies to any air carrier that provides charter or scheduled passenger service in interstate or intrastate air transportation.

**P-254.4** — 14 CFR 254.4
> On any flight segment using large aircraft, or on any flight segment that is included on the same ticket as another flight segment that uses large aircraft, an air carrier shall not limit its liability for provable direct or consequential damages resulting from the disappearance of, damage to, or delay in delivery of a passenger's personal property, including baggage, in its custody to an amount less than $4,700 for each passenger.

**P-254.3** — 14 CFR 254.3
> Large aircraft means any aircraft designed to have a maximum passenger capacity of more than 60 seats.

**P-254.6** — 14 CFR 254.6
> The Department of Transportation will review the domestic baggage liability limit prescribed in this part every two years. The Department will use the Consumer Price Index for All Urban Consumers as of July of each review year to calculate the revised domestic baggage liability limit amount. The Department will use the following formula: $2500 × (a/b) rounded to the nearest $100, where a = July CPI-U of year of current adjustment and b = the CPI-U figure in December 1999 when the inflation adjustment provision was added to this part.

DOT guidance passages DOT-BAG-1 (incidental expenses "reasonable, verifiable, and actual"), DOT-BAG-2 (no arbitrary daily cap), DOT-BAG-3 (consumer-page wording of the limit), DOT-BAG-4 (Montreal 1,519 SDR), DOT-BAG-6/7, DOT-BAG-8 and DOT-REF-8 are in `sources/federal-web-pages-excerpts.md`. FR 2024-23588 abstract (limit raised from $3,800 to $4,700; effective 2025-01-22) is listed there with its hash.

## 13. Source register

| Id | URL | Kind | Retrieved | Effective / as-of | Integrity |
|---|---|---|---|---|---|
| S1 | https://www.ecfr.gov/current/title-14/chapter-II/subchapter-A/part-260 | regulation | 2026-09-23 | eff. 2024-06-25; compliance 2024-10-28 | `sources/ecfr-14cfr260.txt` |
| S2 | https://www.ecfr.gov/current/title-14/chapter-II/subchapter-A/part-254 | regulation | 2026-09-23 | $4,700 eff. 2025-01-22 (89 FR 84815/84819) | `sources/ecfr-14cfr254.txt` |
| S3 | https://www.transportation.gov/lost-delayed-or-damaged-baggage | agency guidance | 2026-09-23 (browser) | "Last updated: Wednesday, October 29, 2025" | no raw hash |
| S4 | https://www.federalregister.gov/documents/2024/10/24/2024-23588 | final rule | 2026-09-23 | eff. 2025-01-22 | hash in excerpts |
| S5 | https://www.federalregister.gov/documents/2025/02/20/2025-02814 | enforcement delay | 2026-09-23 | to 2025-03-20 | hash in excerpts |

## 14. Known limitations and source conflicts

- **L1 — "Ceiling" wording conflict.** The regulation (P-254.4) prohibits a carrier from limiting its liability **below** $4,700. The DOT consumer page (DOT-BAG-3) says "The maximum liability amount allowed by the regulation is $4,700 per passenger" and "Airlines are free to pay more than the limit". Both describe the same rule from different angles. The regulation text is the governing reading: $4,700 is the **minimum permissible carrier cap**. A carrier's contract may state a higher cap. Evaluator: `carrier_liability_limit` = the carrier's stated limit if captured (must be ≥ floor), otherwise "at least $4,700". **Never** display either figure as expected recovery.
- **L2 — Incidental-expense basis.** "Reasonable, verifiable, and actual" and "no arbitrary daily amount" are DOT **guidance/enforcement** positions (DOT-BAG-1/2). The regulation speaks of "provable direct or consequential damages". The spec cites both. Reasonableness is decided by the carrier; Recoup computes only documented amounts.
- **L3 — Large-aircraft condition.** §254.4 applies to segments on aircraft with more than 60 seats, or on the same ticket as such a segment. Small-aircraft-only itineraries → `manual_review`.
- **L4 — Carrier deadlines and exclusions not captured** (contracts of carriage per carrier). Timeliness for b/c → `manual_review` until captured.
- **L5 — Pending 2026 biennial adjustment.** 2026 is a review year (254.6). A new floor will apply only from its effective date. The evaluator uses the version in force on the **incident date** (versioned parameter). Refresh monthly until published.
- **L6 — Bag-fee refund timing.** 260.5 requires a prompt refund; the defined day counts are anchored to fare-refund events (see §10). Recoup computes no date.
- **L9 — DOT-REF-8 vs 260.5(d).** DOT's page says a bag fee charged by a ticket agent "must" be requested from the airline; 260.5(d) makes the refund **automatic** once its conditions hold. Both preserved: the regulation governs; DOT-REF-8 names whom to contact if the refund does not arrive.
- **L10 — Path a outside the 254.4 limit (inference).** The texts are silent on whether a 260.5 fee refund counts against a carrier's 254.4 liability limit; Recoup treats them as separate (assumption A4).
- **L7 — "Lost" declaration** varies by carrier (5–14 days typical per DOT-BAG-5). The evaluator uses the carrier's declaration, not elapsed time.
- **L8 — International b/c** (Montreal 1,519 SDR per DOT-BAG-4) → `unsupported` in v1; path a still applies to international covered flights.

## 15. Evaluation outline

1. No current source record, or source not current → **`source_unverified`**.
1b. **Temporal gate (path a):** the bag-fee refund conditions (significant delay or loss, MBR) were met — or the incident occurred — before the part 260 bag-fee compliance date **2024-10-28** (FR-2024-07177-COMPLIANCE) → **`source_unverified`** for path a.
2. Path a:
   1. `itinerary_scope = non_us` → `unsupported`.
   2. `mbr_filed = unknown` → `needs_facts`; `false` → **`not_yet_due`** with `reevaluate_when: "MBR filed"` and next action "file an MBR" (D147(6)); never `not_eligible`.
   3. Exemption fact true → `not_eligible` (path a only).
   4. Compute the delay (deplane opportunity → delivery/pickup). Missing either instant and the bag not yet declared lost → `needs_facts`. Conflicting instants straddling the threshold → `needs_facts`. `bag_status = declared_lost` → the delay test is not needed.
   5. Not significant → `not_eligible`. Significant or lost, fee paid → `eligible` (amount per §7) **when every decisive fact is confirmed** (D147(1), (2)): `itinerary_scope`, `deplane_opportunity_at`, `bag_delivered_or_picked_up_at` (or `bag_status = declared_lost`), `mbr_filed`, exemption facts, `bag_fee_paid`. Any decisive fact only extracted → `likely_eligible_missing_evidence`. Fee unknown → `likely_eligible_missing_evidence`. D143(4)'s `likely_eligible` cap does **not** apply to path a (D147(1)).
3. Path b (domestic only): international → `unsupported`. `large_aircraft_segment_on_ticket = false` → `manual_review` (254.4 floor does not apply); unknown → assumption shown. No delay → `not_eligible`. **v1 cap:** path b is capped at `likely_eligible_missing_evidence` while no carrier contract of carriage is captured (D143(4), D147(1)); estimate = documented, unallocated lines only. Carrier deadline known (future packs) and passed → `deadline_passed`.
4. Path c (domestic only): `large_aircraft_segment_on_ticket = false` → `manual_review`. `declared_lost` / `damaged` with evidence → `likely_eligible_missing_evidence` (valuation unknown; estimate `null`; v1 cap as path b). No carrier declaration → `needs_facts`.
5. Overlap and dedupe: each `expense_line` has at most one `allocated_to`. A line allocated to a card benefit (R12) is excluded from b. The bag fee (a) is never an expense line in b. b+c share the per-passenger liability limit. Opportunity key = (owner, rule id, version, bag tag, path).

## 16. Document B corrections

1. **"$4,700 ceiling."** B: "The current domestic baggage liability ceiling is $4,700 per passenger." The regulation sets **$4,700 as the lowest limit a carrier may impose**. A carrier may set a higher cap. It is never a payout. It applies to domestic itineraries on large aircraft, and to incidents on/after **2025-01-22**. 2026 is a biennial review year, so the figure may change. International bags are governed by the Montreal Convention (1,519 SDR), not $4,700.
2. **Bag-fee refund conditions.** B says only that the refund follows an MBR. The regulation adds the delay thresholds: **12 h domestic, 15 h / 30 h international**, measured from the **opportunity to deplane** to delivery/pickup. It also adds three exemptions and the carrier-to-carrier notification condition. DOT's page says to request it from the **airline** even when a ticket agent charged the fee (DOT-REF-8); the regulation makes the refund automatic (L9). 260.5 requires a prompt refund, but the defined day counts are anchored to fare-refund events, so no date can be computed for bag fees.
3. **Expense basis and deadlines.** "Reasonable, verifiable, actual" is DOT guidance; the regulation's measure is "provable direct or consequential damages". There is **no federal claim deadline** for b/c — the carrier's contract of carriage controls, and Recoup has not captured those yet.

## 17. Assumptions

- A1: "within 12 hours" is inclusive of exactly 12:00:00 elapsed (delivered at 12:00 → not significant).
- A2: Expense lines dated after `deplane_opportunity_at` and on or before `bag_delivered_or_picked_up_at` (plus the day of delivery) are candidates; reasonableness is not decided by Recoup.
- A3: The incident date that selects the liability-limit version is the local date at the final-destination airport.
- A4: A 260.5 bag-fee refund does not count against a carrier's 254.4 liability limit.
