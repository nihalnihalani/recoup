# R05 — Late or unshipped online / mail / telephone order (FTC Mail, Internet, or Telephone Order Merchandise Rule)

| Field | Value |
|---|---|
| Stable id | `R05.mitor_shipment.us_ftc` |
| Version | `v1` |
| Review status | **researched** — not `active`; needs an independent reviewer. Not legal advice. |
| Authority class | Legal entitlement — the seller has a duty (enforced by the FTC) to offer a delay option or cancel and promptly refund. See §15 L1 on private enforcement. |
| Authority subtype | Federal trade regulation rule, 16 CFR part 435 (authority 15 U.S.C. 57a), with FTC business guidance |
| Jurisdiction | United States — mail, Internet, or telephone order sales "in or affecting commerce" (435.2) |
| Published | 79 FR 55615, 2014-09-17 (FR 2014-22092; the eCFR source note's "79 FR 55619" is a page within it); no later amendment in the eCFR source notes as of 2026-09-18 |
| Effective | **2014-12-08** (FR-2014-22092 DATES: "The provisions of the final Rule will become effective on December 8, 2014." — `sources/federal-register-notices.txt`) |
| Compliance | no separate compliance date captured |
| Retrieval date | 2026-09-23 |
| Last verification date | 2026-09-23 |
| Refresh policy | 180 days, and on any Federal Register document tagged 16 CFR part 435 |
| Reviewer | — (unassigned) |

Captured sources: `sources/ecfr-16cfr435.txt`; FTC business guide excerpts FTC-MITOR-G1…G6 in `sources/federal-web-pages-excerpts.md`.

---

## 1. Scope: shipment, not delivery

The Rule regulates **shipment**: "the act by which the merchandise is physically placed in the possession of the carrier" (435.1(e)). It does **not** regulate delivery dates, in-transit delay, loss after shipment, porch theft, or disputed delivery. Mission §10 requires these to stay separate:

| Situation | R05? | Where else |
|---|---|---|
| Seller did not ship by the stated / default time | **yes** | – |
| Seller sent a delay-option notice; buyer consented / did not respond / cancelled | **yes** | – |
| Shipped on time, delivered after the promised **delivery** date | **no** (`not_eligible` under R05) | R03 (credit card: "late delivery" is a billing error type, comment 13(a)(3)-1.i.D); merchant policy |
| Shipped, never delivered / lost in transit | no | R03 (non-delivery); merchant/carrier claim |
| Delivered then stolen | no | card purchase protection (R06), merchant goodwill |
| Merchant refund requested for other reasons | no | merchant policy |

## 2. Applicability

1. Merchandise ordered by mail, Internet, or telephone — "regardless of the method of payment or the method used to solicit the order" (435.1(a)).
2. Not an excluded transaction (§6).
3. Seller identity known (the Rule binds the seller; marketplace orders need the actual seller).

## 3. Trigger

The applicable shipping time passes without shipment; or a delay notice arrives; or the buyer wants to cancel an unshipped order.

## 4. The applicable shipping time (435.2(a)(1))

| Case | Applicable time |
|---|---|
| Seller clearly and conspicuously stated a shipping time | that time (the order-time representation supersedes advertising — FTC-MITOR-G3) |
| No clear and conspicuous statement | **30 days** after receipt of a properly completed order |
| No statement **and** the buyer applied **to the seller** for credit to pay for the order | **50 days** |

- **Clock start:** receipt of a **properly completed order** — when the seller receives both payment (or authorization to charge an existing account, or other payment method) and all information needed to process and ship (435.1(c)). Dishonored payment / credit refused resets the clock (435.1(c)(1)-(3)).
- **Day semantics:** "within thirty (30) days after receipt" → calendar days; the 30th day after receipt is the last compliant day (assumption A1: an order received at any time on day 0 has until the end of day 30). **Calendar-day zone (D147(4)):** the buyer's local date at the ship-to address (assumption A5); the Rule does not name a zone. A seller-stated time such as "ships in 2 business days" is evaluated in the seller's stated unit (assumption A2: business = Mon–Fri excluding federal holidays).

## 5. Required facts (typed)

| Fact | Type | Unit / domain | Source of truth | Needed for |
|---|---|---|---|---|
| `order_channel` | enum | `internet` \| `mail` \| `telephone` \| `in_store` \| `unknown` | order confirmation | applicability |
| `seller_identity` | string \| unknown | legal seller (not marketplace operator unless it is the seller) | order confirmation / invoice | applicability |
| `buyer_country`, `ship_to_country`, `seller_country` | string | ISO-3166 | order | jurisdiction |
| `merchandise_category` | enum | `general_merchandise` \| `serial_subscription_after_first` \| `seeds_or_growing_plants` \| `service` \| `negative_option_plan` | order | exclusions |
| `payment_terms` | enum | `paid_at_order` \| `cod` \| `seller_credit_application` \| `bill_later` | order | exclusions / 50-day rule (the refund **form** comes from `payment_instrument_class`, 435.1(d)) |
| `delay_notice_offers_cancel_and_refund` | boolean \| unknown, per notice | the notice clearly and conspicuously offers the option to cancel and receive a prompt refund and "fully inform[s] the buyer" of that right (435.2(b)(1), (b)(1)(i)) | notice text | option analysis |
| `properly_completed_order_at` | datetime | ISO-8601 | order confirmation (payment authorization + complete information) | clock start |
| `shipping_representation` | object \| none | {text (verbatim), unit (`calendar_days` \| `business_days` \| `date`), value, location (`checkout` \| `order_confirmation` \| `ad`)} | captured page/email | applicable time |
| `delivery_representation` | object \| none | {text, date} | order confirmation | **kept separate** (not used for R05) |
| `shipped_at` | datetime \| null \| unknown | first carrier-possession event (tracking "picked up"/"accepted", not "label created") | tracking history | compliance |
| `delay_notices` | array | {received_at, revised_ship_date \| `indefinite`, reason_given, cancel_means_offered, text} | email / order page | option analysis |
| `buyer_response` | enum per notice | `consented` \| `cancelled` \| `no_response` \| `unknown`; its timestamp is `buyer_response_at` | buyer sent mail / portal | option analysis |
| `buyer_response_at` | datetime | instant the buyer **sent** the response (not when the seller received it) | buyer's sent mail / portal confirmation | cancellation before shipment (§16 step 4; erratum E-R05-1), vesting (A3) |
| `seller_cancelled_at` | datetime \| null | seller cancellation notice | – | refund anchor |
| `amount_tendered` | money | minor units + currency incl. shipping, handling, insurance | receipt | refund amount |
| `refund_received` | money[] | – | statement | outstanding |
| `payment_instrument_class` | enum | as R03 | statement | refund form, overlap with R03 |

## 6. Exclusions (435.3(a); FTC-MITOR-G5)

- Subscriptions ordered for serial delivery, **after** the initial shipment.
- Orders of seeds and growing plants.
- C.O.D. orders.
- Transactions under the Prenotification Negative Option Plans rule (16 CFR 425).
- Services (not merchandise) — FTC guide.
- Not a mail/Internet/telephone order (e.g., bought in store) → `not_eligible` under R05.

## 7. Remedy

Cancellation of the unshipped order and a **prompt refund** of the amount tendered — including shipping, handling, insurance and other costs if nothing shipped (FTC-MITOR-G6). Partial shipment: the Rule's refund is for the unshipped merchandise (435.1(d) "unshipped merchandise"); the FTC guide's method — the difference between the total paid and what the buyer would have paid for the shipped items under the seller's ordering instructions — is **guidance-only** (FTC-MITOR-G7), so a partial-shipment **amount** is `manual_review`. No store credit, vouchers, or scrip (FTC-MITOR-G2). Cash remedy (to the original payment method).

## 8. Option / cancellation logic (435.2(b)–(c)) — deterministic

Let `T` = end of the applicable shipping time (§4).

**Notice adequacy (435.2(b)(1), (b)(1)(i)).** A delay notice counts as the prescribed option only if it offers, clearly and conspicuously, the choice to consent to the delay **or cancel and receive a prompt refund**, and fully informs the buyer of that right. `delay_notice_offers_cancel_and_refund = false` → the notice is not the option → treat as case 1 (435.2(c)(5)). Unknown → `needs_facts`.

1. **No delay notice, not shipped by `T`** → the seller must deem the order cancelled and make a prompt refund (435.2(c)(5)). Right to refund vests when `T` ends without shipment (assumption A3: vesting **date** = the calendar day after the last day of `T`).
2. **Delay-option notice received ≤ `T`, definite revised date `R` with `R ≤ T + 30 days`:** buyer silence = consent to ship by `R` (435.2(b)(1)(ii)). Buyer may cancel **before shipment and before `R` expires** → refund vests on the seller's receipt of the cancellation (435.2(b)(1)(ii), (c)(1)). Not shipped by `R` → the seller must offer a **renewed** option before `R`; silence to a renewed option = **rejection** → cancellation if not shipped by `R` (435.2(b)(2)(ii), (c)(3)).
3. **Delay-option notice with `R > T + 30 days` or "indefinite":** the order is **automatically cancelled** unless shipped within 30 days of `T` or the buyer **expressly consented** within those 30 days (435.2(b)(1)(iii), (c)(2)). Refund vests when `T + 30 days` ends without shipment or express consent (vesting date = the next calendar day, A3).
4. **Notice sent after `T`** is not a valid first delay-option notice ("in no event later than said applicable time", 435.2(b)(1)) → treat as case 1.
5. **Buyer consented to an indefinite delay** → continuing right to cancel before shipment (435.2(b)(1)(iii)(B)).
6. **Seller decides not to ship** → prompt refund (435.2(b)(4), (c)(4)).

## 9. Prompt refund — timing (seller's duty; used for tracking and escalation)

| Payment | Refund form | Deadline | Anchor | Semantics |
|---|---|---|---|---|
| cash, check, money order | return of amount tendered | 7 **working** days | date the right to refund vests | refund **sent** (not posted: "a refund sent by any means at least as fast and reliable as first class mail", 435.1(b)); counting starts the day **after** the vesting date (assumption A6); "working days" is **not defined** in part 435 → assumption A2 (Mon–Fri excl. federal holidays) |
| third-party credit (ordinary credit card) | credit memo to the card issuer + copy to buyer, **or** a statement to the buyer acknowledging the cancellation and that no action was taken that will charge the account (435.1(d)(2)(ii)) | 7 working days | vesting date | same (sent) |
| seller is the creditor | credit memo / account statement | **one billing cycle** | vesting date | billing cycle of the seller-creditor account |
| other methods (wallets, debit, etc.) | instructions to the payment entity / return / statement | 7 working days | vesting date | same |
| seller cannot refund by the same method | cash, check, or money order | 7 working days | date the seller discovers it cannot | same |

**Unconfirmed or disputed anchor (D154 condition 2).** These are counterparty (seller) deadlines. If the vesting date rests on an extracted or conflicting fact (e.g., the order time or the shipping representation), Recoup computes **no** refund-by date and no overdue/escalation date (`deadline.date = null`, status `unknown_anchor` / `disputed_anchor`) until the fact is confirmed.

## 10. Notice requirements

- The seller's delay-option notice may be sent by email (FTC-MITOR-G4, guidance-only). Posting only on an order-status page may not meet the timing requirement (FTC-MITOR-G8, guidance-only).
- **Buyer cancellation:** the Rule requires the seller to provide "adequate means, at the seller's expense" (435.2(b)(3)). No specific buyer notice form is required. An email or portal cancellation is valid **only if received before shipment**. Keep timestamped proof.

## 11. Deadlines — summary

- Buyer: none to preserve the Rule's protections, except that a cancellation must reach the seller **before shipment**, and consent to a > 30-day or indefinite delay must be expressed within 30 days of `T` if the buyer wants to keep the order.
- Seller: shipping time `T`; option notice by `T`; refund within 7 working days / one billing cycle of vesting.
- If the buyer paid by consumer credit card: R03's 60-day billing-error clock runs **independently** from the first statement showing the charge — whichever path the user chooses, R03's clock must be shown.

## 12. Claim channel and escalation

1. Buyer cancellation/refund request to the seller (seller's channel), citing the missed shipping time / notice status.
2. If paid by credit card: R03 (goods not delivered as agreed; late delivery) — alternative path for the same money.
3. FTC report (ReportFraud.ftc.gov — named on the FTC consumer page captured for R03; not separately verified for MITOR) and state AG. These are reports, not claims for money.
4. Third-party preparation: no restriction found; the buyer acts through their own account.

## 13. Exact supporting passages (verbatim; public domain)

**P-435.1(b)** — 16 CFR 435.1(b)
> (b) Prompt refund shall mean:
>
> (1) Where a refund is made pursuant to paragraph (d)(1), (d)(2)(ii), (d)(2)(iii), or (d)(3) of this section, a refund sent by any means at least as fast and reliable as first class mail within seven (7) working days of the date on which the buyer's right to refund vests under the provisions of this part. Provided, however, that where the seller cannot provide a refund by the same method payment was tendered, prompt refund shall mean a refund sent in the form of cash, check, or money order, by any means at least as fast and reliable as first class mail, within seven (7) working days of the date on which the seller discovers it cannot provide a refund by the same method as payment was tendered;
>
> (2) Where a refund is made pursuant to paragraph (d)(2)(i) of this section, a refund sent by any means at least as fast and reliable as first class mail within one (1) billing cycle from the date on which the buyer's right to refund vests under the provisions of this part.

**P-435.1(e)** — 16 CFR 435.1(e)
> (e) Shipment shall mean the act by which the merchandise is physically placed in the possession of the carrier.

**P-435.2(a)(1)** — 16 CFR 435.2(a)(1)
> (a)(1) To solicit any order for the sale of merchandise to be ordered by the buyer through the mail, via the Internet, or by telephone unless, at the time of the solicitation, the seller has a reasonable basis to expect that it will be able to ship any ordered merchandise to the buyer:
>
> (i) Within that time clearly and conspicuously stated in any such solicitation; or
>
> (ii) If no time is clearly and conspicuously stated, within thirty (30) days after receipt of a properly completed order from the buyer. Provided, however, where, at the time the merchandise is ordered the buyer applies to the seller for credit to pay for the merchandise in whole or in part, the seller shall have fifty (50) days, rather than thirty (30) days, to perform the actions required in this paragraph (a)(1)(ii).

**P-435.2(b)(1)** — 16 CFR 435.2(b)(1) (opening)
> (b)(1) Where a seller is unable to ship merchandise within the applicable time set forth in paragraph (a)(1) of this section, to fail to offer to the buyer, clearly and conspicuously and without prior demand, an option either to consent to a delay in shipping or to cancel the buyer`s order and receive a prompt refund. Said offer shall be made within a reasonable time after the seller first becomes aware of its inability to ship within the applicable time set forth in paragraph (a)(1) of this section, but in no event later than said applicable time.

**P-435.2(b)(1)(ii)** — deemed consent (≤ 30 days)
> (ii) Where the seller has provided a definite revised shipping date which is thirty (30) days or less later than the applicable time set forth in paragraph (a)(1) of this section, the offer of said option shall expressly inform the buyer that, unless the seller receives, prior to shipment and prior to the expiration of the definite revised shipping date, a response from the buyer rejecting the delay and cancelling the order, the buyer will be deemed to have consented to a delayed shipment on or before the definite revised shipping date.

**P-435.2(b)(1)(iii)** — deemed cancellation (> 30 days / indefinite) (opening and (A)-(B))
> (iii) Where the seller has provided a definite revised shipping date which is more than thirty (30) days later than the applicable time set forth in paragraph (a)(1) of this section or where the seller is unable to provide a definite revised shipping date and therefore informs the buyer that it is unable to make any representation regarding the length of the delay, the offer of said option shall also expressly inform the buyer that the buyer's order will automatically be deemed to have been cancelled unless:
>
> (A) The seller has shipped the merchandise within thirty (30) days of the applicable time set forth in paragraph (a)(1) of this section, and has received no cancellation prior to shipment; or
>
> (B) The seller has received from the buyer within thirty (30) days of said applicable time, a response specifically consenting to said shipping delay.

**P-435.2(c)** — 16 CFR 435.2(c)
> (c) To fail to deem an order cancelled and to make a prompt refund to the buyer whenever:
>
> (1) The seller receives, prior to the time of shipment, notification from the buyer cancelling the order pursuant to any option, renewed option or continuing option under this part;
>
> (2) The seller has, pursuant to paragraph (b)(1)(iii) of this section, provided the buyer with a definite revised shipping date which is more than thirty (30) days later than the applicable time set forth in paragraph (a)(1) of this section or has notified the buyer that it is unable to make any representation regarding the length of the delay and the seller:
>
> (i) Has not shipped the merchandise within thirty (30) days of the applicable time set forth in paragraph (a)(1) of this section, and
>
> (ii) Has not received the buyer's express consent to said shipping delay within said thirty (30) days;
>
> (3) The seller is unable to ship within the applicable time set forth in paragraph (b)(2) of this section, and has not received, within the said applicable time, the buyer's consent to any further delay;
>
> (4) The seller has notified the buyer of its inability to make shipment and has indicated its decision not to ship the merchandise;
>
> (5) The seller fails to offer the option prescribed in paragraph (b)(1) of this section and has not shipped the merchandise within the applicable time set forth in paragraph (a)(1) of this section.

**P-435.3(a)** — 16 CFR 435.3(a)
> (a) This part shall not apply to:
>
> (1) Subscriptions, such as magazine sales, ordered for serial delivery, after the initial shipment is made in compliance with this part;
>
> (2) Orders of seeds and growing plants;
>
> (3) Orders made on a collect-on-delivery (C.O.D.) basis;
>
> (4) Transactions governed by the Federal Trade Commission`s Trade Regulation Rule entitled “Use of Prenotification Negative Option Plans,” 16 CFR Part 425.

FTC business-guide passages FTC-MITOR-G1…G6 are in `sources/federal-web-pages-excerpts.md`.

## 14. Source register

| Id | URL | Kind | Retrieved | Effective / as-of | Integrity |
|---|---|---|---|---|---|
| S1 | https://www.ecfr.gov/current/title-16/chapter-I/subchapter-D/part-435 | trade regulation rule | 2026-09-23 | 79 FR 55619 (2014-09-17); as of 2026-09-18 | `sources/ecfr-16cfr435.txt` |
| S2 | https://www.ftc.gov/business-guidance/resources/business-guide-ftcs-mail-internet-or-telephone-order-merchandise-rule | agency guidance | 2026-09-23 (browser) | no date shown | no raw hash |

## 15. Known limitations and source conflicts

- **L1 — Enforcement / private remedy.** Part 435 defines violations "in connection with" sales as unfair or deceptive acts (435.2), enforced by the FTC. The captured text states no private right of action. The consumer-facing remedy Recoup supports is: **ask the seller** to honor the cancellation/refund the Rule requires, and, if paid by credit card, use R03. Recoup must not describe this as "you can sue under the FTC rule".
- **L2 — "Working days"** is undefined → A2.
- **L3 — Shipment evidence.** Tracking "label created" ≠ shipment. The first carrier-possession scan is required. When only "label created" exists → `shipped_at = unknown`.
- **L4 — Marketplaces.** The seller may be a third party on a marketplace. Seller unknown → `needs_facts`.
- **L5 — Stated-time interpretation.** "Ships in 3–5 days" ranges → use the **upper** bound (the seller's representation covers the range; assumption A4). Contradictory statements in the same order → `needs_facts`.
- **L6 — State law** may add rights (435.3(b)); not evaluated.
- **L7 — Civil penalties.** The FTC guide states a civil-penalty figure that changes yearly; it is informational, not captured, and not used by the evaluator.
- **L8 — Non-US scope.** "In or affecting commerce" can include foreign commerce; returning `unsupported` for non-US buyers, sellers or ship-to addresses is a conservative scope choice.
- **L9 — An unrecorded cancellation before an on-time shipment (errata review round 1, ERR-R1-06).** The §16 step 4 exception applies only when a cancellation is recorded (`buyer_response = cancelled` under an option). When the buyer's response, or whether the seller sent a delay-option notice at all, is not recorded, step 4 treats the cancellation as none and gives `not_eligible` for a shipment within `T`. v1 does not ask whether the buyer cancelled under an option before such a shipment, although such a cancellation engages (c)(1): "The seller receives, prior to the time of shipment, notification from the buyer cancelling the order pursuant to any option, renewed option or continuing option under this part" (P-435.2(c)). This departs from the README's "missing ≠ false" (spec-to-evaluator table, §5 row). The approved fixture R05-02 requires it (shipped within `T`, no delay-notice or response facts → `not_eligible`, `missing_facts []`). A buyer who did cancel under an option can record it, and the step 4 exception then applies (R05-14).

## 16. Evaluation outline

1. No current source record, or source not current → `source_unverified`.
2. Non-US buyer/seller/ship-to → `unsupported`. `order_channel = in_store` → `not_eligible`. Excluded category or COD → `not_eligible` (the Rule does not apply). Seller unknown → `needs_facts`.
3. Determine `T` (§4). Missing `properly_completed_order_at` or contradictory representations → `needs_facts`.
4. `shipped_at ≤ T` (or ≤ consented revised date) → `not_eligible` (shipment promise met; attach an R03 / merchant pointer if a **delivery** promise was missed), **unless a cancellation was received before shipment** (erratum E-R05-1, D234(18)). The seller must "deem an order cancelled and ... make a prompt refund" whenever "The seller receives, prior to the time of shipment, notification from the buyer cancelling the order pursuant to any option, renewed option or continuing option under this part" (P-435.2(c), paragraph (c)(1)); see also P-435.2(b)(1)(ii) ("unless the seller receives, prior to shipment ... a response from the buyer rejecting the delay and cancelling the order") and P-435.2(b)(1)(iii), paragraph (A) ("and has received no cancellation prior to shipment"). So when `buyer_response = cancelled` under such an option (a delay-option notice that counts under §8 — received by `T` and offering cancellation and a prompt refund — or a renewed or continuing option):
   - `buyer_response_at` before `shipped_at` → **`manual_review`**, not `not_eligible`. (c)(1) turns on the seller's **receipt** before shipment, and Recoup records when the buyer **sent** the cancellation; the Rule's text also does not say what follows when a cancelled order is shipped anyway (compare R05-03b). No refund-by date is computed.
   - `buyer_response_at` equal to `shipped_at` → **`manual_review`**, not `not_eligible` (**lead ruling D253(4)**; fixture R05-14e). With equal timestamps the order of the two events cannot be known, so this step cannot find that the cancellation came after shipment. As in the case above, Recoup records when the buyer sent the cancellation, not when the seller received it, and no refund-by date is computed. This replaces the round-1 reading (ERR-R1-05) that "at" included the same instant and gave `not_eligible`; the lead did not adopt it.
   - `buyer_response_at` unknown → **`needs_facts`** (`buyer_response_at`).
   - `buyer_response_at` after `shipped_at` (strictly later) → the cancellation cannot have been received "prior to the time of shipment"; it is ignored in this step, which gives `not_eligible` (fixture R05-14c).
   - A cancellation not made under an option (no delay-option notice, no renewed or continuing option) does not engage (c)(1): a shipment within `T` still gives `not_eligible`.
   - A cancellation that is not recorded (`buyer_response` or `delay_notices` missing) is treated as none in this step, and v1 does not ask about it (L9).
   Fixtures: R05-14 and R05-14e (`manual_review`), R05-14b (`needs_facts`), R05-14c and R05-14d (`not_eligible`).
5. Now ≤ `T` (or ≤ `R`, or ≤ `T + 30 days` under case 3) and not shipped → **`not_yet_due`** with `reevaluate_at` = the day after the period ends (D147(6)); never `not_eligible`. Buyer consented to an indefinite delay → **`not_yet_due`** with `reevaluate_when: "buyer cancels before shipment"` and **`next_action`: "you can cancel before shipment for a prompt refund"** (D154: a user-controlled trigger is presented as an action, not a wait).
6. Apply §8 cases. Delay-notice state unknown → `needs_facts`. Refund right vested → `eligible`; compute the refund deadline (§9).
7. `eligible` requires every **decisive fact** to be confirmed (D147(2)): `order_channel`, `seller_identity`, countries, `merchandise_category`, `payment_terms`, `properly_completed_order_at`, `shipping_representation`, `shipped_at`, `delay_notices` (+ adequacy), `buyer_response`, `amount_tendered`. A user-confirmed "not shipped" plus no carrier-possession event is sufficient for `shipped_at`. Any decisive fact only extracted → `likely_eligible_missing_evidence`. Partial shipment → amount `manual_review`.
8. Overlap: R03 is an alternative for the same money (never additive); a merchant refund already received reduces the outstanding amount to zero → the opportunity closes as recovered, not as `not_eligible`.
9. Idempotency key = (owner, rule id, version, seller, order number).

## 17. Document B corrections

1. **Shipment vs delivery.** B frames R05 as "Late or missing online order" and says it is "highly automatable from order confirmation, promised date, tracking". The Rule governs **shipment** (placement with the carrier), not delivery. A missed delivery date, in-transit loss, or theft after shipment is **not** a MITOR violation. Those go to R03 (credit card), carrier, or merchant paths.
2. **The default is not only 30 days.** It is **50 days** when the buyer applies to the seller for credit. The clock starts at a **properly completed order**, not at checkout.
3. **What "prompt refund" and "consent" mean.** "Prompt refund" = **7 working days** (one billing cycle when the seller is the creditor) from the date the right vests. It cannot be store credit or scrip. Silence counts as consent **only** for a first delay with a definite revised date ≤ 30 days. For a longer or indefinite delay, silence leads to **automatic cancellation** after 30 days. A delay notice sent after the promised time does not cure the violation (the order must be deemed cancelled). B's example card ("The seller must obtain your consent … or offer cancellation and a prompt refund") omits the automatic-cancellation outcome.

## 18. Assumptions

- A1: Day counts in §4 are calendar days; day 30 inclusive.
- A5: Calendar days are the buyer's local dates at the ship-to address.
- A6: The 7-working-day count starts the day after the vesting date.
- A2: "Working days" / seller "business days" = Mon–Fri excluding 5 U.S.C. 6103 federal holidays.
- A3: Vesting date = the calendar day after the last day of the applicable period (`T`, `R`, or `T + 30 days`); for a buyer cancellation, the date the seller receives it; for a seller decision not to ship, the date of that notice.
- A4: For a range representation, the upper bound governs.

## 19. Errata (M27 code-pack review, lead rulings D234 and D253; 2026-09-23)

These edits are made while the pack is still `researched` (README lifecycle rule 1). Engineering research, not legal certification. They need an independent re-check. Summary: `docs/rules/review-items/2026-09-23-M27-errata.md`.

- **E-R05-1 — §16 step 4: "unless a cancellation was received before shipment" (D234(18); review finding R05-08).** Step 4 gave `not_eligible` for any shipment within `T` (or the consented revised date), even when the buyer had cancelled under an option before the seller shipped. Added the exception with its passages (P-435.2(c) paragraph (c)(1), P-435.2(b)(1)(ii), P-435.2(b)(1)(iii) paragraph (A)), the outcome for each case, and the §5 fact `buyer_response_at` (the send time already named in §5 "with timestamp"). Fixtures: R05-14, R05-14b, R05-14c, R05-14d. No existing fixture changes (R05-03 has `no_response`).
- **Errata review round 1 (2026-09-23).** ERR-R1-05: step 4 stated that "at or after `shipped_at`" includes the same instant, and fixture R05-14e pinned it (`not_eligible`). *Superseded by round 3 (below).* ERR-R1-06: new limitation L9 (an unrecorded cancellation is treated as none in step 4; R05-02). No existing fixture changes.
- **Round 3 (lead ruling D253(4), 2026-09-23).** Equal timestamps (`buyer_response_at` = `shipped_at`): "the order cannot be known" → **`manual_review`**, not `not_eligible`. For a known send time, step 4 now gives: before → `manual_review`; equal → `manual_review`; strictly after → `not_eligible`. Fixture R05-14e now expects `manual_review` (its note, `forbidden_outputs` and justification changed with it). No approved fixture changes. The M21 comparison `n.responseAt <= atMs` (`convex/lib/rules/r05_late_order_v1.ts:509` on `origin/main`) already gives `manual_review` at equality, so the round-1 request to change `<=` to `<` is withdrawn.
