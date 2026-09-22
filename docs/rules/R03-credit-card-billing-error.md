# R03 — Credit-card billing-error notice (Fair Credit Billing Act / Regulation Z §1026.13)

| Field | Value |
|---|---|
| Stable id | `R03.credit_billing_error.us_fcba` |
| Version | `v1` |
| Review status | **researched** — not `active`; needs an independent reviewer. Not legal advice or certification. |
| Authority class | Legal entitlement (procedural right: the creditor must investigate and correct or explain within set times) |
| Authority subtype | Federal statute + federal regulation + official interpretation (15 U.S.C. 1666; 12 CFR 1026.13; Supplement I to Part 1026, comments 13(a)–13(i)) |
| Jurisdiction | United States; **consumer** open-end credit — credit card accounts and other open-end (revolving) consumer credit plans |
| Published | eCFR source note: "[76 FR 79772, Dec. 22, 2011, as amended at 81 FR 84369, Nov. 22, 2016]" — these are **publication** citations: FR 2011-31715 (76 FR 79768, published 2011-12-22) and FR 2016-24503 (81 FR 83934, published 2016-11-22). No later amendment in the source notes as of 2026-09-18. |
| Effective | 2011-31715: "This interim final rule is effective December 30, 2011." 2016-24503 (which added §1026.13(i)(2)): effective date delayed to **2019-04-01** (FR 2017-08341, FR 2018-01305). All in `sources/federal-register-notices.txt`. |
| Compliance | no separate compliance date captured |
| Retrieval date | 2026-09-23 |
| Last verification date | 2026-09-23 (eCFR point-in-time 2026-09-18; USC 2024 edition via govinfo) |
| Refresh policy | 90 days, and on any Federal Register document amending 12 CFR 1026.13, 1026.7(a)(9)/(b)(9), 1026.12, or Supplement I §13 |
| Reviewer | — (unassigned) |

Captured sources: `sources/ecfr-12cfr1026.13.txt`, `sources/ecfr-12cfr1026-suppI-13.txt`, `sources/usc-15-1666.txt`, `sources/ecfr-12cfr1026.12c-excerpt.txt`, `sources/ecfr-12cfr1005.11ab-excerpt.txt`, `sources/federal-web-pages-excerpts.md` (FTC-CC-*).

---

## 1. Scope — four channels that must never be conflated (mission §10)

| Channel | What it is | Governing source | In R03 v1? |
|---|---|---|---|
| **Formal billing-error notice** | written notice to the creditor's billing-error address; triggers statutory duties | 15 U.S.C. 1666; 12 CFR 1026.13 | **yes — this rule** |
| Merchant outreach | asking the seller to fix it | merchant policy | no (optional; **not a prerequisite**, comment 13(a)(3)-3) |
| Informal issuer support (phone/chat/app "dispute" button) | issuer customer-service process | issuer terms | only counts as the formal notice if the issuer's billing-rights statement stipulates that electronic channel (comment 13(b)-2) |
| Card-network chargeback | issuer↔acquirer network process | private network rules (not public; not captured) | no |
| Claims and defenses (quality disputes about accepted goods) | withhold payment against issuer | 12 CFR 1026.12(c) | no — separate future rule; see §15 L4 |

## 2. Applicability conditions

1. Payment was made on a **consumer** credit card or other **open-end consumer credit** plan. Not debit card, ACH, prepaid-asset, P2P balance, wire, or check → those are Regulation E or other regimes (`unsupported` for R03; route to R13). Business-purpose credit → `unsupported` (Reg Z applies to consumer credit). **Third-party payment intermediaries** (comment 13(a)(3)-2): (a)(3) "generally applies" to goods bought through a person-to-person payment service funded by the credit plan when the credit is extended at purchase for the full amount; v1 still returns `unsupported` for `p2p` (conservative; limitation L9).
2. The disputed item appears **on or with a periodic statement** (the definition of "billing error" is tied to statement reflection).
3. The dispute is one of the billing-error types in §4.
4. Mixed debit+overdraft-credit transactions follow Regulation E for error resolution (1026.13(i); comment 13(i)) → `unsupported` for R03.

## 3. Trigger

A charge or credit problem is identified on a statement **and** the user wants to assert it with the creditor.

## 4. Billing-error types (1026.13(a)) → Recoup classification

| Recoup `error_type` | Reg Z | Notes |
|---|---|---|
| `unauthorized_charge` | (a)(1) | Consumer liability for unauthorized use is limited separately by 1026.12(b)(1)(ii) ("the lesser of $50 or the amount of money, property, labor, or services obtained by the unauthorized use"; captured `sources/ecfr-12cfr1026.12b-excerpt.txt`) — separate concept; not computed here |
| `duplicate_charge` | (a)(1) (second extension of credit not made to the consumer) / USC 1666(b)(1) ("not in the amount reflected") | classification assumption A2 |
| `wrong_amount` | USC 1666(b)(1); (a)(1)/(a)(5) as applicable | |
| `not_delivered_as_agreed` / `not_accepted` | (a)(3) | includes **late delivery**, wrong quantity, wrong location, different goods (comment 13(a)(3)-1.i) |
| `credit_issued_not_reflected` (a payment or a credit **issued** by the merchant/creditor is not properly reflected) | (a)(4) | anchor = the statement on which the credit should have appeared (comment 13(b)(1)-2) |
| `promised_credit_not_issued` (goods returned or refused, refund promised but never issued) | (a)(3) (property "not accepted") | anchor = first statement reflecting the **charge**; if the return happened later, the formal window may already be closed (L10) |
| `computational_error` | (a)(5) | |
| `clarification_request` | (a)(6) | documentation request alone (e.g., for taxes) is **not** a billing error (comment 13(a)(6)-1) |
| `statement_not_sent` | (a)(7) | only if the address was received in writing ≥ 20 days before cycle end |
| `quality_dispute_accepted_goods` | **not a billing error** (comment 13(a)(3)-1.ii) | → `not_eligible` under R03; see L4 |

## 5. Required facts (typed)

| Fact | Type | Unit / domain | Source of truth | Needed for |
|---|---|---|---|---|
| `credit_issue_date` | date \| unknown | date the merchant/creditor issued the credit | merchant refund confirmation | (a)(4) act-by lower bound |
| `payment_instrument_class` | enum | `consumer_credit_card` \| `consumer_open_end_other` \| `business_credit_card` \| `debit_card` \| `prepaid` \| `ach` \| `p2p` \| `bnpl` \| `unknown` | statement header / card product (user-confirmed) | applicability gate |
| `error_type` | enum | §4 list | user + evidence | classification |
| `disputed_transaction` | object | date, merchant descriptor, amount (minor units + currency), statement line id | periodic statement | notice contents |
| `first_statement_transmitted_on` | date | calendar date the creditor **transmitted** (sent / made available) the **first** periodic statement reflecting the error | statement PDF metadata / e-statement availability notice / issuer | **deadline anchor** |
| `statement_closing_date` | date | – | statement | secondary evidence only; **not** the anchor |
| `transaction_posting_date` | date | – | statement / app | conservative lower bound only |
| `billing_error_address` | string | postal address (or stipulated electronic means) disclosed on the statement / billing-rights statement (1026.7(a)(9)/(b)(9)) | statement / billing-rights notice | channel |
| `electronic_notice_stipulated` | boolean \| unknown | whether the billing-rights statement says the creditor accepts billing-error notices electronically **and** states the means | billing-rights statement text (user upload) | channel |
| `notice_channel_planned` | enum | `mail_to_billing_error_address` \| `stipulated_electronic` \| `email_customer_service` \| `phone` \| `app_dispute_button` \| `unknown` | user | readiness |
| `notice_received_on` | date | date the creditor **received** the notice | delivery confirmation (certified mail return receipt), portal confirmation | timeliness |
| `merchant_contacted` | boolean \| unknown | – | user | **not** a gate (comment 13(a)(3)-3); used only for the letter narrative |
| `delivery_evidence` | object | promised delivery date/terms, actual delivery date or non-delivery evidence | order confirmation, tracking | (a)(3) |
| `credits_already_received` | money[] | minor units + currency, with source (merchant / issuer provisional / issuer final) | statement | overlap / ledger |
| `existing_dispute_open` | boolean \| unknown | – | issuer correspondence | duplicate prevention |

## 6. Exclusions

- Quality dispute about goods/services the consumer **accepted** (comment 13(a)(3)-1.ii).
- Documentation request without an alleged error (comment 13(a)(6)-1).
- Non-consumer (business-purpose) credit; debit/prepaid/ACH/P2P balance; incidental overdraft credit (1026.13(i)) → `unsupported`.
- Notice received after the 60-day window → `deadline_passed` **for the formal FCBA path only** (other paths — merchant refund, network chargeback, claims-and-defenses — are not evaluated by this rule and must not be reported as "no recovery").
- Reassertion of substantially the same error after the creditor fully complied (1026.13(h)) → `not_eligible`.

## 7. Remedy

Procedural: the creditor must acknowledge within 30 days (unless it resolves first) and, within **two complete billing cycles and no later than 90 days** after receiving the notice, either correct the error and credit the disputed amount with related charges, or send a written explanation after a reasonable investigation (1026.13(c), (e), (f)). Pending resolution, the consumer need not pay the disputed amount and related charges; no collection of it; no adverse credit report for non-payment of it (1026.13(d)). For non-delivery, the creditor may not deny without determining the goods were actually delivered, mailed, or sent as agreed (15 U.S.C. 1666(a), subparagraph (B)(ii); comment 13(f)-3.ii). Outcome money: a credit of the disputed amount if the error is confirmed; this is **not** guaranteed.

## 8. Calculation and cap

`disputed_amount` = the amount the consumer alleges is in error; for identification errors, the amount of the corresponding transaction; for (a)(7) (statement not sent), the entire balance owing (comment 13(d)-1). Integer minor units, one currency. No cap. A provisional/temporary credit (comment 13(c)-1) is **provisional** in the ledger, never confirmed recovery.

## 9. Evidence checklist

1. Periodic statement showing the disputed line and the statement date/closing date; proof of when it was transmitted/made available if possible.
2. The creditor's billing-rights statement (to capture the billing-error address and any electronic-notice stipulation).
3. Type-specific evidence: order confirmation with promised terms; tracking/non-delivery proof; return receipt/RMA; cancellation confirmation; receipt showing correct amount; the duplicate lines.
4. Merchant correspondence if any (optional).
5. Proof of the notice's **receipt** by the creditor (certified mail return receipt or portal confirmation).

## 10. Notice requirements

- **Form:** written notice (1026.13(b)); the creditor may require that it not be written on the payment stub (comment 13(b)-2).
- **Address:** received at the address disclosed under §1026.7(a)(9)/(b)(9) — the billing-error address, not the payment address (FTC-CC-1).
- **Contents:** enough to identify the consumer's name and account number (the notice need not state both if the creditor can identify the account — comment 13(b)(2)-1); the consumer's belief and reasons; to the extent possible, the type, date, and amount of the error.
- **Electronic notice / email:** the captured text establishes that a notice sent by the electronic means **stipulated in the billing-rights statement** satisfies the written-notice requirement (comment 13(b)-2 — a safe harbor: "will be deemed to satisfy"). Separately, 1026.13(b)(1) requires receipt "at the address disclosed". Recoup therefore treats no other electronic channel — including an ordinary email to customer service — as preserving the formal right. A phone call is not written notice. Recoup must not claim otherwise.
- **Merchant first?** Not required for (a)(3) disputes (comment 13(a)(3)-3). Recoup must not delay a time-sensitive notice to ask the user to contact the merchant first.

## 11. Deadline — anchor and calendar semantics

| Item | Value |
|---|---|
| Anchor event | creditor **transmitted** the **first** periodic statement reflecting the alleged error (`first_statement_transmitted_on`). For statements held until called for: when first made available (comment 13(b)(1)-3). Statement never sent: from when it should have been sent; after it is sent, a new 60 days (comment 13(b)(1)-1). Missing credit: from the statement on which the credit should have appeared (comment 13(b)(1)-2). |
| Count | 60 |
| Unit | **calendar days** (no business-day language) |
| Boundary | "no later than 60 days after" → the notice is timely if **received** on or before anchor + 60 days (day 60 inclusive). No weekend/holiday roll-forward is provided (assumption A1: no extension). "60 days" is read as calendar days because the same section says "3 business days" where business days are meant (1026.13(d)(1)). |
| Calendar-day zone (D147(4)) | Day arithmetic is on calendar **dates**: the transmittal date as stated by the creditor, and the receipt date as recorded at the billing-error address (e.g. the delivery scan's local date). If only instants are known, convert with the **billing-error address's time zone** (assumption A4). |
| Sent vs received | **Received** by the creditor at the billing-error address. Mailing on day 60 is **not** enough. The UI should compute a "mail by" date that allows for transit time (product policy, not law) and label it as such. |
| Unknown anchor | no legal deadline computed; outcome `needs_facts`; display a **conservative act-by** date, clearly labelled "earliest possible deadline — not the legal deadline". Lower bound by error type: charge-type errors ((a)(1)–(3), (a)(5), (a)(6), `promised_credit_not_issued`) → `transaction_posting_date + 60` (no statement reflecting the charge can precede posting); `credit_issued_not_reflected` → `credit_issue_date + 60` (the statement on which the credit should appear cannot precede its issue); `statement_not_sent` → none (manual). |
| Conflicting anchors | use the **earliest** candidate for the conservative act-by date; outcome `needs_facts`. |
| Creditor response clocks | acknowledgment ≤ 30 days after receipt; resolution ≤ two complete billing cycles and ≤ 90 days after receipt ("two actual billing cycles occurring after receipt", comment 13(c)(2)-1). |

## 12. Claim channel and escalation

1. Generate a factual letter + evidence index addressed to the **billing-error address** (from the user's statement; never guessed).
2. User sends it themselves by a trackable method, or through the stipulated electronic channel; user records proof of receipt. Recoup never files it.
3. Track the creditor's 30-day acknowledgment and two-cycle/90-day resolution clocks.
4. Escalation: CFPB complaint (consumerfinance.gov/complaint — channel noted on the FTC page "FIle a complaint with the Consumer Financial Protection Bureau"; the CFPB complaint URL was not separately verified this run).
5. Third-party preparation: the notice must come "from a consumer" (1026.13(b)); Recoup drafts, the consumer signs/sends. Whether an agent may send on the consumer's behalf was not researched → out of scope.

## 13. Exact supporting passages (verbatim; public domain)

**P-1026.13(a)(3)** — 12 CFR 1026.13(a)(3)
> (3) A reflection on or with a periodic statement of an extension of credit for property or services not accepted by the consumer or the consumer's designee, or not delivered to the consumer or the consumer's designee as agreed.

**P-1026.13(b)** — 12 CFR 1026.13(b)
> (b) Billing error notice. A billing error notice is a written notice from a consumer that:
>
> (1) Is received by a creditor at the address disclosed under § 1026.7(a)(9) or (b)(9), as applicable, no later than 60 days after the creditor transmitted the first periodic statement that reflects the alleged billing error;
>
> (2) Enables the creditor to identify the consumer's name and account number; and
>
> (3) To the extent possible, indicates the consumer's belief and the reasons for the belief that a billing error exists, and the type, date, and amount of the error.

**P-1026.13(c)** — 12 CFR 1026.13(c)
> (1) The creditor shall mail or deliver written acknowledgment to the consumer within 30 days of receiving a billing error notice, unless the creditor has complied with the appropriate resolution procedures of paragraphs (e) and (f) of this section, as applicable, within the 30-day period; and
>
> (2) The creditor shall comply with the appropriate resolution procedures of paragraphs (e) and (f) of this section, as applicable, within 2 complete billing cycles (but in no event later than 90 days) after receiving a billing error notice.

**P-1026.7(b)(9)** — 12 CFR 1026.7(b)(9) (captured: `sources/ecfr-12cfr1026.7-9-excerpt.txt`)
> (9) Address for notice of billing errors. The address to be used for notice of billing errors. Alternatively, the address may be provided on the billing rights statement permitted by § 1026.9(a)(2).

**P-C13(a)(3)-1** — Supplement I, comment 13(a)(3)-1
> i. Section 1026.13(a)(3) covers disputes about goods or services that are “not accepted” or “not delivered * * * as agreed”; for example:
>
> A. The appearance on a periodic statement of a purchase, when the consumer refused to take delivery of goods because they did not comply with the contract.
>
> B. Delivery of property or services different from that agreed upon.
>
> C. Delivery of the wrong quantity.
>
> D. Late delivery.
>
> E. Delivery to the wrong location.
>
> ii. Section 1026.13(a)(3) does not apply to a dispute relating to the quality of property or services that the consumer accepts. Whether acceptance occurred is determined by state or other applicable law.

**P-C13(a)(3)-3** — Supplement I, comment 13(a)(3)-3
> 3. Notice to merchant not required. A consumer is not required to first notify the merchant or other payee from whom he or she has purchased goods or services and attempt to resolve a dispute regarding the good or service before providing a billing-error notice to the creditor under § 1026.13(a)(3) asserting that the goods or services were not accepted or delivered as agreed.

**P-C13(b)-2** — Supplement I, comment 13(b)-2 (electronic notice)
> 2. Form of written notice. The creditor may require that the written notice not be made on the payment medium or other material accompanying the periodic statement if the creditor so stipulates in the billing rights statement required by §§ 1026.6(a)(5) or (b)(5)(iii), and 1026.9(a). In addition, if the creditor stipulates in the billing rights statement that it accepts billing error notices submitted electronically, and states the means by which a consumer may electronically submit a billing error notice, a notice sent in such manner will be deemed to satisfy the written notice requirement for purposes of § 1026.13(b).

**P-C13(b)(1)** — Supplement I, comments 13(b)(1)-1 to -3
> 1. Failure to send periodic statement—timing. If the creditor has failed to send a periodic statement, the 60-day period runs from the time the statement should have been sent. Once the statement is provided, the consumer has another 60 days to assert any billing errors reflected on it.
>
> 2. Failure to reflect credit—timing. If the periodic statement fails to reflect a credit to the account, the 60-day period runs from transmittal of the statement on which the credit should have appeared.
>
> 3. Transmittal. If a consumer has arranged for periodic statements to be held at the financial institution until called for, the statement is “transmitted” when it is first made available to the consumer.

**P-C13(c)(2)-2 (excerpt)** — double credit
> However, if a consumer receives more than one credit to correct the same billing error, § 1026.13 does not prevent a creditor from reversing amounts it has previously credited to correct that error, provided that the total amount of the remaining credits is equal to or more than the amount of the error and that the consumer does not incur any fees or other charges as a result of the timing of the creditor's reversal.

**P-C13(f)-3.ii** — nondelivery investigation
> ii. Nondelivery of property or services. In conducting an investigation of a billing error notice alleging the nondelivery of property or services under § 1026.13(a)(3), the creditor shall not deny the assertion unless it conducts a reasonable investigation and determines that the property or services were actually delivered, mailed, or sent as agreed.

**P-C13(i)-2 (excerpt)** — debit/overdraft boundary
> For example, credit inadvertently extended incident to an electronic fund transfer using a debit card, such as under an overdraft service not subject to Regulation Z, is governed solely by the Regulation E error resolution procedures, if the bank and the consumer do not have an agreement to extend credit when the consumer's account is overdrawn.

**P-1666(a)** — 15 U.S.C. 1666(a) (opening clause)
> If a creditor, within sixty days after having transmitted to an obligor a statement of the obligor's account in connection with an extension of consumer credit, receives at the address disclosed under section 1637(b)(10) of this title a written notice (other than notice on a payment stub or other payment medium supplied by the creditor if the creditor so stipulates with the disclosure required under section 1637(a)(7) of this title) from the obligor in which the obligor—

**P-1005.11(b)(1)** — 12 CFR 1005.11(b)(1)(i) (contrast: Regulation E accepts oral notice)
> A financial institution shall comply with the requirements of this section with respect to any oral or written notice of error from the consumer that:
>
> (i) Is received by the institution no later than 60 days after the institution sends the periodic statement or provides the passbook documentation, required by § 1005.9, on which the alleged error is first reflected;

## 14. Source register

| Id | URL | Kind | Retrieved | Effective / as-of | Integrity |
|---|---|---|---|---|---|
| S1 | https://www.ecfr.gov/current/title-12/chapter-X/part-1026/subpart-B/section-1026.13 | regulation | 2026-09-23 | am. 2011-12-22, 2016-11-22; as of 2026-09-18 | `sources/ecfr-12cfr1026.13.txt` |
| S2 | https://www.ecfr.gov/current/title-12/chapter-X/part-1026/appendix-Supplement%20I%20to%20Part%201026 (§13 commentary) | official interpretation | 2026-09-23 | as of 2026-09-18 | `sources/ecfr-12cfr1026-suppI-13.txt` |
| S3 | https://www.govinfo.gov/content/pkg/USCODE-2024-title15/html/USCODE-2024-title15-chap41-subchapI-partD-sec1666.htm | statute | 2026-09-23 | USC 2024 ed. | `sources/usc-15-1666.txt` |
| S4 | https://consumer.ftc.gov/articles/using-credit-cards-and-disputing-charges | agency guidance | 2026-09-23 | page dated May 2022 | excerpts FTC-CC-* |
| S5 | https://www.ecfr.gov/current/title-12/chapter-X/part-1005/subpart-A/section-1005.11 | regulation (contrast) | 2026-09-23 | as of 2026-09-18 | `sources/ecfr-12cfr1005.11ab-excerpt.txt` |

consumerfinance.gov's own Regulation Z pages return HTTP 403 to non-browser clients; the eCFR text was used as the regulatory source.

## 15. Known limitations and source conflicts

- **L1 — Transmittal date is often unobservable.** Statements show a closing date. The legal anchor is the **transmittal** date. The closing date is not the anchor. The evaluator requires `first_statement_transmitted_on` (e.g., e-statement "available" notification date); otherwise `needs_facts` with a conservative act-by date.
- **L2 — No weekend roll-forward.** Neither the regulation nor the statute provides one (assumption A1). The UI's "mail by" buffer is product policy.
- **L3 — Electronic channels vary by issuer.** Each issuer's billing-rights statement must be captured (per issuer, per version) before Recoup can label a web form "formal notice". Until then, web/app dispute buttons are "informal issuer support".
- **L4 — Claims and defenses (§1026.12(c))** is a different right with different conditions: a good-faith attempt to resolve with the merchant **is** required, and the amount must exceed **$50** plus a same-state / 100-mile condition (with exceptions). The FTC consumer page says "more than **$5**" (FTC-CC-3). **Conflict:** the regulation says $50; the regulation governs; the FTC page figure is recorded, not used. Not implemented in R03 v1.
- **L5 — BNPL.** Whether a given BNPL product is a "credit card" / open-end plan under Reg Z is unresolved. The CFPB's 2024 interpretive rule "Use of Digital User Accounts to Access Buy Now, Pay Later Loans, 89 FR 47068 (May 31, 2024)" is listed among the interpretive rules withdrawn "as of May 12, 2025" (FR-2025-08286, captured in `sources/federal-register-notices.txt`). → `unsupported` in v1.
- **L6 — Business cards.** §1026.13 applies to consumer credit; business-purpose accounts → `unsupported` (not `not_eligible`).
- **L9 — Third-party payment intermediaries.** Comment 13(a)(3)-2 brings some intermediary-funded purchases within (a)(3); v1 returns `unsupported` for `p2p` rather than evaluating the funding conditions.
- **L10 — Refunds promised after a late return.** For `promised_credit_not_issued` the anchor is the statement reflecting the original charge; a return months later may fall outside that window. The formal path is then `deadline_passed`; the merchant path and other channels are not evaluated here.
- **L7 — Duplicate charge classification** (A2) is a mapping choice; the statute's (b)(1) ("not in the amount reflected") covers it more directly than Reg Z's (a) list.
- **L8 — eCFR shows rules that are not in force elsewhere in Reg Z** (e.g., §1026.52 $8 late-fee safe harbor — stayed per CFPB page; §1026.62 overdraft — disapproved by Pub. L. 119-10). This does not affect §1026.13 but shows why eCFR presence ≠ in-force status (see TRIAGE R13/R16).

## 16. Evaluation outline

1. No current source record, or source not current → **`source_unverified`**.
2. `payment_instrument_class` ∈ {debit_card, prepaid, ach, p2p} → **`unsupported`** (route to R13; explain "a different federal rule — Regulation E — governs debit/electronic transfers; it accepts oral notice and has different clocks"). `business_credit_card`, `bnpl` → **`unsupported`**. `unknown` → **`needs_facts`**.
3. `error_type = quality_dispute_accepted_goods` → **`not_eligible`** (under R03) + pointer to future §1026.12(c) rule. `clarification_request` without an alleged error → **`not_eligible`**.
4. `existing_dispute_open = true` for the same transaction → reuse the existing case (duplicate prevention); do not create a second notice.
5. Anchor known: if `notice_received_on` exists and > anchor+60 → **`deadline_passed`** (formal path only). If no notice yet and today > anchor+60 → **`deadline_passed`**. Else continue.
6. Anchor unknown or conflicting → **`needs_facts`** (+ conservative act-by date).
7. Facts and evidence present and every **decisive fact** confirmed → **`eligible`** (rule applies, window open). Decisive facts (D147(2)): `payment_instrument_class`, `error_type`, `disputed_transaction` (incl. amount), `first_statement_transmitted_on`, `notice_received_on` when present, `delivery_evidence` for (a)(3), `credit_issue_date` for (a)(4). Any of them only extracted → **`likely_eligible_missing_evidence`**. Evidence missing (e.g., no tracking for a non-delivery claim) → **`likely_eligible_missing_evidence`**.
8. Packet readiness (separate from eligibility): blocked if `notice_channel_planned ∈ {email_customer_service, phone}` and not stipulated, or the billing-error address is unknown.
9. Overlaps: merchant refund promised/pending → alternative for the same loss; never add. If both a merchant credit and an issuer credit post, flag the possible double credit (comment 13(c)(2)-2) — the ledger must not count both.

## 17. Document B corrections

1. **Merchant-first advice is wrong for this path.** B says Recoup should "first ask the user to attempt a merchant resolution when appropriate." For goods/services not accepted or not delivered as agreed, the official interpretation says no merchant contact is required (P-C13(a)(3)-3). A merchant attempt is a condition of the **different** §1026.12(c) claims-and-defenses right. Recoup must not delay a time-sensitive notice for it.
2. **The 60-day clock's anchor and "reach" semantics.** B: notice "must reach the issuer within 60 days after the first statement containing the error". More precisely: the notice must be **received at the billing-error address disclosed on the statement**, no later than 60 days after the creditor **transmitted** the first statement reflecting the error. B's example card ("This charge first appeared 48 days ago … may close in 12 days") anchors on when the charge appeared. That is the wrong event, and it ignores mail transit.
3. **Email and electronic channels.** B does not say which channel preserves the right. Email/web counts only when the issuer's billing-rights statement stipulates electronic notices and states the means (P-C13(b)-2). "Unauthorized charge … $50" is the separate §1026.12(b) liability limit, not part of the §1026.13 procedure.

## 18. Assumptions

- A1: No roll-forward of day 60 on weekends/holidays.
- A2: `duplicate_charge` is asserted under (a)(1)/USC (b)(1).
- A3: The e-statement availability date = transmittal date for e-statement users (comment 13(b)(1)-3 by analogy).
- A4: When only instants are known, calendar dates are taken in the billing-error address's time zone.
