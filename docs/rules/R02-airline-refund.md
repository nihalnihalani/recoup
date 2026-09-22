# R02 — Airline fare refund for a cancelled or significantly delayed/changed flight

| Field | Value |
|---|---|
| Stable id | `R02.airline_fare_refund.us_dot` |
| Version | `v1` (immutable once reviewed; any change → `v2`) |
| Review status | **researched** — not `active`. Activation requires an independent reviewer (mission §8). This is engineering research, not legal certification. |
| Authority class | Legal entitlement |
| Authority subtype | Federal statute + federal regulation (49 U.S.C. 42305; 14 CFR part 260; 14 CFR 399.80(l) for ticket agents) |
| Jurisdiction | United States — "covered flight": scheduled flight operated or marketed by a covered carrier **to, from, or within** the US (14 CFR 260.2) |
| Effective date | Part 260 effective 2024-06-25 (89 FR 32760), amended 2024-08-12 (89 FR 65534); compliance date for the refund provisions **2024-10-28** (FR-2024-07177-COMPLIANCE). Statute §42305 added 2024-05-16 (Pub. L. 118-63 §503). |
| Retrieval date | 2026-09-23 |
| Last verification date | 2026-09-23 (eCFR point-in-time 2026-09-18; Federal Register API queried 2026-09-23) |
| Refresh policy | Every 30 days **and** on any Federal Register document tagged 14 CFR part 260/399 or RIN 2105-AF36 (Refund III). Mandatory re-review on or before **2027-07-07** (expiry of the renumbered-flight enforcement discretion). |
| Researcher | opus-rules-researcher (M02) |
| Reviewer | — (unassigned) |

Captured sources: `sources/ecfr-14cfr260.txt`, `sources/usc-49-42305.txt`, `sources/ecfr-14cfr399.80l-excerpt.txt`, `sources/federal-web-pages-excerpts.md` (DOT-REF-*, FR-2026-13675-*).

---

## 1. What this rule does and does not cover

Covers **only** the refund of airfare (including taxes and ancillary fees paid with it) when the carrier cancels or significantly delays/changes the flight and the consumer does **not** take the changed/alternative flight and does **not** affirmatively accept a voucher/credit/other compensation.

Explicitly **not** this rule (separate rules, never merged — mission §10):

| Not R02 | Where it lives | Why separate |
|---|---|---|
| Refund of an ancillary fee for a service not provided while the passenger still flew (Wi-Fi, seat, lounge) | R14 (14 CFR 260.4) | different trigger, different refund-start event |
| Bag-fee refund for lost / significantly delayed bag | R04 path `a` (14 CFR 260.5) | different trigger (MBR) |
| Meals / hotel / transport / rebooking for controllable disruptions | R15 (carrier customer-service plan; DOT dashboard) | carrier promise, not law (DOT-REF-5, DOT-DASH-1) |
| Denied-boarding compensation | R09 (14 CFR 250.5) | different trigger (oversale) |
| Card trip-delay / trip-cancellation insurance | R12 (exact benefit guide) | contract benefit |
| Cash compensation for delay inconvenience | **none** — no federal rule. DOT withdrew the "Airline Passenger Rights" ANPRM on 2025-11-17 (FR 2025-20042). A one-hour delay creates **no** R02 opportunity. |
| Fare difference after an involuntary downgrade when the passenger still flies | `manual_review` (see §15 L4) | DOT page states it (DOT-REF-6) but the regulatory text located this run does not |

## 2. Applicability conditions (all must hold)

1. Flight is a **covered flight** (260.2): scheduled; operated or marketed by a covered carrier; to, from, or within the US (brief stopovers without a break in journey allowed).
2. Consumer holds a **nonrefundable** ticket (260.6(a)(1)). A fully refundable ticket has a separate, simpler refund basis (DOT-REF page "Fully refundable ticket") — out of scope for v1 → `unsupported`.
3. A **cancelled flight** or **significantly delayed or changed flight** occurred (definitions in §4).
4. Refund path by **merchant of record** (the entity shown on the card/bank statement, 260.2):
   - `carrier` → path **R02.a** automatic refund (260.6(a)(2)).
   - `ticket_agent` → path **R02.b** refund **upon request** from the ticket agent (399.80(l)); the carrier must tell the agent whether the consumer is eligible (260.6(d)).
5. Consumer did **not** fly the changed/alternative flight, and did **not** affirmatively accept a voucher/credit/other compensation (260.6(a)(1), 260.7).

## 3. Trigger

A carrier notice or observed operation showing cancellation or a significant change of a covered flight, **plus** the consumer's decision state (rejected / no response and did not fly / no alternative offered).

## 4. Definitions that drive the evaluator (verbatim-backed, §13)

- **Cancelled flight** (P-260.2-CANCEL): a flight number/city pair published at ticket sale "but not operated by the carrier". A flight that is merely **renumbered** is technically a cancellation under this text — see §15 L1 (enforcement paused to 2027-07-07).
- **Significantly delayed or changed flight** (P-260.2-SIG): any one of —
  1. scheduled departure **≥ 3 h earlier** (domestic) / **≥ 6 h earlier** (international);
  2. scheduled arrival **≥ 3 h later** (domestic) / **≥ 6 h later** (international);
  3. different origin or destination airport;
  4. more connection points;
  5. downgrade to a lower class of service;
  6. (individual with a disability) different connecting airport(s);
  7. (individual with a disability) substitute aircraft lacking a needed accessibility feature.
- Threshold semantics: "three hours **or more**" → a change of exactly 3:00 **is** significant; 2:59 is not. Compare **scheduled** times (original vs changed schedule), in absolute UTC instants, not wall-clock strings across time zones.
- The statute sets the 3 h / 6 h arrival thresholds as a floor ("includes, at a minimum", P-42305-D), so a future Refund III rule cannot lower them below the statutory floor for arrival delays.
- **Automatic refund** (P-260.2-AUTO) and deemed-request events (P-260.6-A2): (i) cancelled and no alternative / compensation offered; (ii) consumer rejects the changed flight, rebooking, or compensation; (iii) consumer does not respond **and** the changed/alternative flight departs without them, or does not respond to a voucher offer by the scheduled/changed departure date.
- **Affirmative acceptance** (P-260.7): the carrier "must not deem a consumer to have accepted" a voucher/credit "unless the consumer affirmatively agrees". Silence ≠ acceptance of compensation.
- **Accepting alternative transportation**: the regulation's disqualifier is choosing to "fly on the significantly delayed or changed flight or accept rebooking on an alternative flight" (260.6(a)(1)(i)). DOT's consumer page frames it as "you chose to take" the flight (DOT-REF-4). For evaluation: **flying** the changed/alternative flight is disqualifying; an explicit acceptance of rebooking not yet flown is disqualifying under the regulation text, but a consumer who accepted and then did not fly is **`manual_review`** (the regulation does not address later reversal).

## 5. Required facts (typed)

| Fact | Type | Unit / domain | Source of truth | Needed for |
|---|---|---|---|---|
| `itinerary_scope` | enum | `domestic` \| `international` \| `non_us` | derived from origin/destination airport countries on the ticket/itinerary | applicability, thresholds |
| `operating_carrier`, `marketing_carrier` | string | IATA code | ticket / e-ticket receipt | covered flight |
| `merchant_of_record` | enum | `carrier` \| `ticket_agent` \| `unknown` | card/bank statement descriptor (definition in 260.2) — not the booking website | path selection |
| `ticket_refundability` | enum | `nonrefundable` \| `refundable` \| `unknown` | fare rules on receipt | applicability |
| `event_type` | enum | `cancellation` \| `schedule_change` \| `downgrade` \| `airport_change` \| `added_connection` \| `renumbered_only` \| `operational_delay_only` | carrier notice; operations data | trigger |
| `original_sched_departure_at`, `original_sched_arrival_at` | datetime (ISO-8601 with offset) | instant | original booking confirmation | significance |
| `changed_sched_departure_at`, `changed_sched_arrival_at` | datetime (ISO-8601 with offset) | instant | schedule-change notice | significance |
| `original_airports`, `changed_airports` | object | IATA codes | confirmation vs notice | significance (3) |
| `original_connections`, `changed_connections` | integer | count | confirmation vs notice | significance (4) |
| `original_cabin`, `changed_cabin` | enum | `first` \| `business` \| `premium_economy` \| `economy` | confirmation vs notice / boarding pass | significance (5) |
| `passenger_disability_relevant` | boolean | – | user-confirmed only (sensitive; ask only if (6)/(7) could matter) | significance (6)(7), 260.6(b) |
| `offer_type` | enum | `none` \| `rebooking` \| `voucher_or_credit` \| `both` | carrier notice | deemed-request path |
| `consumer_response` | enum | `rejected` \| `accepted_rebooking` \| `accepted_compensation` \| `no_response` \| `unknown` | carrier correspondence + **user confirmation** | eligibility |
| `consumer_response_at` | datetime | instant | carrier correspondence timestamp | refund-due anchor |
| `flew_changed_or_alternative` | boolean \| unknown | – | boarding pass / user confirmation | eligibility |
| `changed_or_alternative_departed_at` | datetime | instant | carrier/ops data | no-response anchor |
| `payment_method_class` | enum | `credit_card` \| `debit_card` \| `cash` \| `check` \| `miles` \| `other` \| `unknown` | receipt / statement | refund timing |
| `fare_paid` | money | integer minor units + ISO-4217 currency | receipt | amount |
| `taxes_paid`, `ancillary_fees_paid` | money[] | minor units + currency | receipt | amount |
| `already_refunded` | money | minor units + currency | statement / carrier notice (user-confirmed) | outstanding amount |

`unknown` / missing ≠ `false` (mission §7).

## 6. Exclusions / disqualifiers

- Consumer flew the changed or alternative flight (P-260.6-A1, DOT-REF-4).
- Consumer **affirmatively** accepted voucher/credit/other compensation offered under 260.6(c) (P-260.6-A1(ii), P-260.7).
- Change does not meet any §4 significance criterion and no cancellation occurred (e.g., 1-hour delay).
- Non-covered flight (no US point, or non-scheduled/charter) → `unsupported`, not `not_eligible`.
- Refundable ticket → `unsupported` in v1.
- Renumbered-only flight with no significant change → `manual_review` (§15 L1).

## 7. Remedy

Full refund of airfare **including any taxes and ancillary fees** (260.6(a)(1)), in the **original form of payment** unless the consumer agrees to a cash equivalent; no processing fee may be retained (260.10). Cash remedy. A voucher is **not** this remedy unless affirmatively accepted — and then R02 no longer applies.

## 8. Calculation and cap

`refund_due = fare_paid + taxes_paid + Σ ancillary_fees_paid(for the affected flight) − already_refunded` per currency; no cap. Integer minor units; never sum across currencies. Ticket agent path: the agent **may retain** a disclosed, per-passenger, non-refundable service fee if the service went beyond processing payment (399.80(l)) → deduct only when the disclosure is evidenced; otherwise `manual_review` for that line.

## 9. Evidence checklist

1. Original itinerary/confirmation (flight numbers, scheduled times with time zones, airports, cabin).
2. Carrier schedule-change or cancellation notice (as received; keep headers/timestamps).
3. Record of the consumer's decision: rejection message / app screenshot / chat transcript with timestamp; or proof of non-response and that the flight departed without the consumer.
4. Payment record showing **merchant of record** and payment method (card statement line).
5. Receipt showing fare, taxes, ancillary fees.
6. Any refund / voucher already issued.

## 10. Notice / filing / response requirements

- Consumer: **no filing required** for path R02.a — the refund is automatic once a deemed-request event occurs. There is no federal consumer deadline to claim. Carriers may set a deadline to **accept** an offer (DOT-REF-7); missing it does not forfeit the refund — non-response followed by departure is itself a deemed request (P-260.6-A2(iii)).
- Carrier: must notify affected consumers of the change and of the right to a refund (260.9).
- Path R02.b (ticket agent MoR): consumer must **request** the refund from the ticket agent (399.80(l), "upon request").
- Ordinary email: no formal notice requirement exists for R02, so email/app/chat rejection is sufficient evidence of rejection; preserve the timestamped copy.

## 11. Deadlines — anchor and calendar semantics

These are **carrier payment deadlines** (used for status tracking and escalation), not consumer filing deadlines.

| Path | Payment | Anchor event (legal) | Count | Calendar semantics | Source |
|---|---|---|---|---|---|
| R02.a | credit card | earliest deemed-request date under 260.6(a)(2): rejection timestamp; or departure of the changed/alternative flight without the consumer (no response); or scheduled departure of cancelled flight (no response to voucher offer); or cancellation with nothing offered | 7 | **business days** = Mon–Fri excluding US federal holidays (260.2); count starts the day **after** the anchor; the 7th business day is the last compliant day | P-260.2-PROMPT, P-42305-B |
| R02.a | cash, check, **debit card**, other | same | 20 | **calendar days** (260.2 "20 calendar days"); last compliant day = anchor + 20 | P-260.2-PROMPT |
| R02.b | credit card | date the **ticket agent receives** the carrier's eligibility information (260.6(d)) — not observable to the consumer | 7 | business days | P-399.80(l) |
| R02.b | other | date the refund "becom[es] due" | 20 | calendar days | P-399.80(l) |

- Time zone: anchor instants are UTC; the day boundary uses the **carrier's** notice time converted to the consumer's jurisdiction date is **not** specified by the regulation → store the anchor instant and the time zone used, and display the computed date as "on or about" when the anchor is within ±12 h of midnight in any relevant zone (assumption A1).
- Holidays: 5 U.S.C. 6103 federal holidays (incl. observed dates). Injected clock in tests.
- Anchor unknown (e.g., no evidence of rejection time) → no computed date; outcome `needs_facts`.

## 12. Claim channel and escalation

1. R02.a: none needed; track for refund receipt. If not received by the computed date → user-initiated request through the carrier's refund channel (URL per carrier, captured per carrier; not in this rule).
2. R02.b: request refund from the ticket agent (agent's channel).
3. Escalation: DOT Office of Aviation Consumer Protection complaint (DOT-DASH-1 references filing complaints; the complaint form URL was **not** verified in this run — capture before activation).
4. If paid by **credit card** and the refund is not credited: R03 may apply (services not delivered as agreed — 1026.13(a)(3), or failure to credit a credit — 1026.13(a)(4)); R03 deadlines are anchored to statements, independently of this rule.
5. Third-party preparation: no restriction found in part 260; the consumer's own carrier/OTA account is typically required to act. Recoup prepares, user submits.

## 13. Exact supporting passages (verbatim; public domain)

**P-260.1** — 14 CFR 260.1(c)
> (c) Airfare including nonrefundable airfare for a flight that is cancelled or significantly changed where the consumer does not accept the significantly changed flight or rebooking on an alternative flight, or accept any voucher, credit, or other compensation offered by the carrier.

**P-260.2-AUTO** — 14 CFR 260.2
> Automatic refund means issuing a refund to a consumer without waiting to receive an explicit refund request, when the consumer's right to a refund is undisputed because the contracted service was not provided and either the consumer rejected the alternative offered or no alternative was offered.

**P-260.2-CANCEL** — 14 CFR 260.2
> Cancelled flight or flight cancellation means a covered flight with a specific flight number scheduled to be operated between a specific origin-destination city pair that was published in the carrier's Computer Reservation System at the time of the ticket sale but not operated by the carrier.

**P-260.2-COVERED** — 14 CFR 260.2
> Covered flight means a scheduled flight operated or marketed by a covered carrier to, from, or within the United States, including itineraries with brief and incidental stopover(s) at a foreign point without a break in journey.

**P-260.2-MOR** — 14 CFR 260.2
> Merchant of record means the entity (carrier or ticket agent) responsible for processing payments by consumers for airfare or ancillary services or products (including the transport of checked bags), as shown in the consumer's financial charge statements, such as debit or credit card charge statements.

**P-260.2-PROMPT** — 14 CFR 260.2
> Prompt refund means refunds made within 7 business days after the earliest date the refund was requested as set forth in § 260.6(a)(2) as required by 14 CFR 374.3 for credit card purchases and within 20 calendar days after the earliest date the refund was requested as set forth in § 260.6(a)(2) for cash, check, debit card, or other forms of purchases.

**P-260.2-BD** — 14 CFR 260.2
> Business days means Monday through Friday, excluding Federal holidays in the United States.

**P-260.2-SIG** — 14 CFR 260.2
> Significantly delayed or changed flight means a covered flight itinerary with a delay or change made by a covered carrier where, as the result of the delay or change:
>
> (1) The consumer is scheduled to depart from the origination airport three hours or more for domestic itineraries and six hours or more for international itineraries earlier than the original scheduled departure time;
>
> (2) The consumer is scheduled to arrive at the destination airport three or more hours for domestic itineraries or six or more hours for international itineraries after the original scheduled arrival time;
>
> (3) The consumer is scheduled to depart from a different origination airport or arrive at a different destination airport;
>
> (4) The consumer is scheduled to travel on an itinerary with more connection points than that of the original itinerary;
>
> (5) The consumer is downgraded to a lower class of service;
>
> (6) The consumer who is an individual with a disability is scheduled to travel through one or more connecting airports different from the original itinerary; or
>
> (7) The consumer who is an individual with a disability is scheduled to travel on substitute aircraft on which one or more accessibility features needed by the customer are unavailable.

**P-260.6-A1** — 14 CFR 260.6(a)(1)
> A covered carrier that is the merchant of record must provide a full and prompt refund of the airfare, including any taxes and ancillary fees, as set forth in paragraph (a)(2) of this section to a consumer that holds a nonrefundable ticket on a scheduled flight to, from, or within the United States for any cancelled flight or significantly delayed or changed flight where the consumer chooses not to:
>
> (i) Fly on the significantly delayed or changed flight or accept rebooking on an alternative flight; or
>
> (ii) Accept any voucher, credit, or other form of compensation offered by the air carrier or foreign air carrier pursuant to paragraph (c) of this section.

**P-260.6-A2** — 14 CFR 260.6(a)(2)
> (i) A flight is canceled and a consumer is not offered an alternative flight or any voucher, credit, or other form of compensation by the air carrier or foreign air carrier pursuant to paragraph (c) of this section;
>
> (ii) A consumer rejects the significantly delayed or changed flight, rebooking on an alternative flight, or any voucher, credit, or other form of compensation offered by the covered carrier pursuant to paragraph (c) of this section; or
>
> (iii) A consumer does not respond to an offer of:
>
> (A) A significantly delayed or changed flight or an alternative flight and the flight departs without the consumer; or
>
> (B) A voucher, credit, or other form of compensation by the date on which the cancelled flight was scheduled to depart or the date that the significantly delayed or changed flight departs.

**P-260.7** — 14 CFR 260.7
> A covered carrier must not deem a consumer to have accepted an offer for travel credits, vouchers, or other compensation in lieu of a refund under § 260.6(c) unless the consumer affirmatively agrees to the alternative form of compensation.

**P-260.10** — 14 CFR 260.10
> When a refund of a fare or a fee for an ancillary service, including a fee for lost or significantly delayed checked baggage, is due pursuant to this part, the refund must be issued promptly in the original form of payment (i.e., money is returned to an individual using whatever payment method the individual used to make the original payment, such as a check, credit card, debit card, cash, or airline miles) unless the consumer agrees to receive the refunds in a different form of payment that is a cash equivalent as defined in § 260.2. Carriers may not retain a processing fee for issuing refunds that are due.

**P-42305-B** — 49 U.S.C. 42305(b)
> (1) in the case of a ticket purchased with a credit card, not later than 7 business days after the earliest date the refund was requested as set forth in subsection (f); or
>
> (2) in the case of a ticket purchased with cash or another form of payment, not later than 20 days after the earliest date the refund was requested as set forth in subsection (f).

**P-42305-D** — 49 U.S.C. 42305(d)
> In this section, the term "significantly delayed or changed flight" includes, at a minimum, a flight where the passenger arrives at a destination airport—
>
> (1) in the case of a domestic flight, 3 or more hours after the original scheduled arrival time; and
>
> (2) in the case of an international flight, 6 or more hours after the original scheduled arrival time.

**P-399.80(l)** — 14 CFR 399.80(l) (ticket agents; excerpt)
> A prompt refund is one that is made within 7 business days of the ticket agent receiving information from a carrier as specified in 14 CFR 260.6(d), as required by 12 CFR part 1026 for credit card purchases, and within 20 calendar days of refund becoming due for cash, check, debit card, or other forms of purchases.

DOT consumer-page passages DOT-REF-1…9 and FR notices FR-2026-13675-* are in `sources/federal-web-pages-excerpts.md`.

## 14. Source register

| Id | URL | Kind | Retrieved | Effective / as-of | Integrity |
|---|---|---|---|---|---|
| S1 | https://www.ecfr.gov/current/title-14/chapter-II/subchapter-A/part-260 (fetched via versioner API point-in-time 2026-09-18) | regulation | 2026-09-23 | eff. 2024-06-25, am. 2024-08-12; compliance 2024-10-28 | SHA-256 in `sources/ecfr-14cfr260.txt` |
| S2 | https://www.govinfo.gov/content/pkg/USCODE-2024-title49/html/USCODE-2024-title49-subtitleVII-partA-subpartii-chap423-sec42305.htm | statute | 2026-09-23 | added 2024-05-16 | SHA-256 in `sources/usc-49-42305.txt` |
| S3 | https://www.ecfr.gov/current/title-14/chapter-II/subchapter-F/part-399/subpart-G/section-399.80 | regulation (ticket agents) | 2026-09-23 | eCFR as of 2026-09-18 | `sources/ecfr-14cfr399.80l-excerpt.txt` |
| S4 | https://www.transportation.gov/individuals/aviation-consumer-protection/refunds | agency guidance | 2026-09-23 (browser) | page "Last updated: Friday, November 7, 2025" | no raw hash (403 to non-browser clients) |
| S5 | https://www.federalregister.gov/documents/2026/07/07/2026-13675/airline-refunds-and-other-consumer-protections | enforcement discretion | 2026-09-23 | 2026-07-07 → 2027-07-07 | SHA-256 in excerpts file |
| S6 | https://www.federalregister.gov/documents/2025/11/17/2025-20042 | ANPRM withdrawal (no cash delay compensation) | 2026-09-23 | 2025-11-17 | SHA-256 in excerpts file |

## 15. Known limitations and source conflicts

- **L1 — Renumbered flights.** Under P-260.2-CANCEL a renumbered flight is a cancellation. DOT is not enforcing 260.6/260.9/399.80(l) for renumbered flights with no significant change, until **2027-07-07** (FR-2026-13675-DATES/SCOPE), pending Refund III (RIN 2105-AF36; no NPRM published as of 2026-09-23). Evaluator: `event_type = renumbered_only` → `manual_review` with this explanation; never `eligible`, never silently `not_eligible`.
- **L2 — Refund timing conflict (preserved, not blended).** The regulation (P-260.2-PROMPT) says **20 calendar days** for cash, check, debit card, or other; the same DOT consumer page says 20 **calendar** days in two places (DOT-REF-1, DOT-REF-2) and **20 business days (for cash purchases)** in another (DOT-REF-3). The three DOT passages describe the **same** event paths (reject; no response + no travel). DOT-REF-3 is therefore an inconsistency within the guidance page, not a separate event path. The statute (P-42305-B) says "20 days" without "calendar"/"business". **Resolution:** evaluator uses the regulation (20 calendar days); UI discloses "DOT's consumer page states 20 business days in one place; the regulation states 20 calendar days". Only the display of the carrier-payment date for non-credit-card payments is affected; eligibility is unaffected. DOT-REF-2 also anchors the no-response path to when the flight "departs from its destination" (sic) — the regulation says "departs without the consumer"; the evaluator uses the regulation.
- **L3 — Document B's reading.** Document B describes the 20-business-day passage as possibly a separate "automatic-refund" event path. The captured text does not support that; see L2.
- **L4 — Downgrade fare difference.** DOT-REF-6 says the airline must refund the fare difference if a downgraded passenger still flies. That obligation is not in the part 260 text captured; its regulatory basis was not located in this run → `manual_review`, not `eligible`.
- **L5 — "Accepted rebooking but did not fly."** Not addressed by the regulation → `manual_review`.
- **L6 — Business-day / time-zone boundary.** Regulation does not say which time zone defines the anchor date (assumption A1).
- **L7 — Ticket-agent anchor** (R02.b) depends on carrier→agent communication the consumer cannot observe → deadline displayed as "not computable".
- **L8 — Refundable tickets, charters, non-US itineraries, and 24-hour cancellation (14 CFR 259.5(b)(4))** are out of scope for v1.
- **L9 — Pending change risk.** Refund III may change "cancelled flight". The statutory arrival thresholds (P-42305-D) are a floor. Early-departure, airport-change, connection and downgrade criteria are regulatory only and could change.

## 16. Evaluation outline (deterministic; for the backend evaluator)

1. Source state ≠ `verified_current` (last verification older than the refresh window, or a newer FR document on part 260/399 not yet reviewed) → **`source_unverified`**.
2. `itinerary_scope = non_us` or carrier not covered → **`unsupported`**. `ticket_refundability = refundable` → **`unsupported`** (v1).
3. `event_type = operational_delay_only` with no qualifying change → **`not_eligible`** (link R15 as a possible carrier commitment; never a cash-compensation card).
4. `event_type = renumbered_only` → **`manual_review`** (L1).
5. Compute significance from scheduled instants and the other criteria. Any required time missing → **`needs_facts`**. Conflicting candidate values that straddle a threshold → **`needs_facts`** (ask to confirm). No criterion met and not cancelled → **`not_eligible`**.
6. `flew_changed_or_alternative = true` → **`not_eligible`**. `consumer_response = accepted_compensation` (affirmative) → **`not_eligible`**. `accepted_rebooking` and did not fly → **`manual_review`**.
7. `consumer_response ∈ {unknown}` and the changed/alternative flight has not departed → **`needs_facts`** (ask: did you accept, reject, or not respond?).
8. Deemed-request event established → **`eligible`** (path by merchant of record). Missing receipt/payment-method evidence with facts otherwise confirmed → **`likely_eligible_missing_evidence`**.
9. Compute the refund amount (§8) and the carrier payment deadline (§11).
10. Overlaps: attach relationships to R12 (card trip-cancellation: alternative/secondary — not additive), R15 (carrier commitment: may be complementary for expenses actually incurred before the consumer abandoned the trip, e.g. a stranded-overnight hotel; evaluate per carrier plan, never assume additive or exclusive), R03 (payment dispute: fallback channel for the same money, alternative).
11. Idempotency: the opportunity key = (owner, rule id, rule version, ticket number, affected flight segment). Re-evaluation with an identical fact snapshot returns the same result and **reuses** the existing opportunity; no second claim.

## 17. Document B corrections (what B gets wrong or leaves out)

1. **Refund timing:** B presents "20 business days" as a possible separate automatic-refund event path. It is an inconsistency inside the DOT page; the regulation says 20 **calendar** days and explicitly includes **debit card** (L2). The anchor is the deemed-request date under 260.6(a)(2), not "the refund request".
2. **Scope of "significant change":** B mentions only late arrival (3 h / 6 h). The regulation also counts early departure (3 h / 6 h), airport change, extra connections, downgrade, and two disability-specific changes. A merely **renumbered** flight counts as a cancellation, but DOT is not enforcing that until 2027-07-07 (L1).
3. **Automatic vs on-request:** B's table says "automatic fare and fee refund". That is true only when the **carrier** is the merchant of record. When a ticket agent is the merchant of record, the fare refund is owed **upon request** by the agent (399.80(l)). Ancillary and bag fees must be requested from the **airline** even if the agent charged them (DOT-REF-8). Voucher acceptance must be **affirmative** (260.7); silence does not count.

(B's thresholds of 3 h domestic / 6 h international and its statement that a 1-hour delay creates no cash right are **confirmed**. The ANPRM that considered cash compensation was withdrawn on 2025-11-17.)

## 18. Assumptions (must be reviewed before activation)

- A1: The anchor date is the calendar date of the anchor instant in the consumer's home time zone; flagged "on or about" near midnight.
- A2: "Business days" excludes only 5 U.S.C. 6103 federal holidays (per 260.2), not state holidays.
- A3: Scheduled-time comparisons use the final changed schedule notified before departure; multiple successive changes are compared against the **original** schedule at ticket sale.
