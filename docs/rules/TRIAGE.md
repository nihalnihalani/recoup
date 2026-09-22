# R06–R25 source triage (M02, 2026-09-23)

Purpose: for each later-phase scenario, record the first-party sources located **in this run**, their fetch status, the current legal status where it has recently changed, whether the claim channel accepts email, any restriction on third-party preparation, and a feasibility verdict. This is triage, not a rule spec. Nothing here is `researched` or `active`.

**Fetch status legend:** `OK-curl` (raw HTTP 200 fetched; SHA-256 recorded where given) · `OK-browser` (read in a real browser pane; site returns 403 to non-browser clients) · `blocked` (bot wall / 403 in both) · `404` · `not attempted`.
**Verdicts:** `ready_for_spec` · `needs_exact_guide` · `source_blocked` · `privacy_gated` · `defer`.
All retrievals: 2026-09-23. Federal Register status comes from the federalregister.gov API. eCFR text comes from the versioner API (point-in-time 2026-09-18).

> **Cross-cutting finding:** eCFR still displays provisions that are **not in force**. §1026.62 (CFPB overdraft rule) is shown even though Pub. L. 119-10 (2025-05-09) says the rule "shall have no force or effect". §1026.52(b)(1)(ii) still shows the $8 late-fee safe harbor, which the CFPB's own page says "is stayed". A rule pack must therefore record **legal status** separately from **text presence**.

---

## Summary

| ID | Scenario | Verdict |
|---|---|---|
| R06 | Card purchase protection | needs_exact_guide |
| R07 | Card return protection | needs_exact_guide |
| R08 | Card extended warranty | needs_exact_guide |
| R09 | Involuntary denied boarding | ready_for_spec |
| R10 | Warranty defect | ready_for_spec |
| R11 | Product recall / service program | ready_for_spec |
| R12 | Trip-delay / trip-cancellation card benefit | needs_exact_guide |
| R13 | Debit/ATM/ACH/EFT error (Reg E) | ready_for_spec |
| R14 | Unprovided airline ancillary service | ready_for_spec |
| R15 | Controllable airline-disruption commitment | ready_for_spec |
| R16 | Subscription renewal / cancellation | ready_for_spec |
| R17 | Surprise medical bill / GFE dispute | privacy_gated |
| R18 | Vehicle recall / state lemon law | ready_for_spec (recall candidate matching); lemon law: defer |
| R19 | Cancelled event / undelivered service | defer |
| R20 | Hotel best-rate / rental guarantee | ready_for_spec (Hilton only); others source_blocked |
| R21 | Telecom / utility outage or missed appointment | defer |
| R22 | FTC / state regulator refund program | ready_for_spec |
| R23 | Class settlement eligibility | defer |
| R24 | Unclaimed property | defer |
| R25 | Small-business shipping / SaaS guarantee | defer |

**Counts (one primary verdict per row, 20 rows):** **ready_for_spec 10** (R09, R10, R11, R13, R14, R15, R16, R18, R20, R22) · **needs_exact_guide 4** (R06, R07, R08, R12) · **privacy_gated 1** (R17) · **defer 5** (R19, R21, R23, R24, R25) · **source_blocked 0** as a primary verdict. Partial source blocks are noted inside R01 (Home Depot), R20 (Hyatt, Marriott, IHG), R24 (NAUPA) and R11/R18 (cpsc.gov / nhtsa.gov HTML; the APIs work).

---

## Card benefits (R06, R07, R08, R12) — exact guides located

Never infer a benefit from a network logo (mission §11). The guides below were downloaded as PDFs on 2026-09-23. **Caveat:** each guide says its own effective date. Whether it is the guide currently in force for **every** holder of that product is not proven by the URL. Chase restructured Sapphire Reserve in 2025 (secondary knowledge — not verified here), and the captured CSR guide says "Effective 10/1/24". Guide version must be matched to the cardholder's account and purchase date before activation.

| Product | Guide (official URL) | Guide id / date | SHA-256 | Benefits in the guide (verified text) |
|---|---|---|---|---|
| **Chase Sapphire Preferred® (Visa Signature®)** | https://static.chasecdn.com/content/services/structured-document/document.en.pdf/card/benefits-center/product-benefits-guide-pdf/BGC11387_v2.pdf | BGC11387; "Effective 10/01/24"; section codes dated 20240311 | e7c9f93d6d49798661765aa99e8eca8da498f5431a7a4a3089b98b88c0f837d1 | Purchase Protection: 120 days (90 for NY residents), $500/item, $50,000/account (code `PP_CON_$500 ITEM_$50K ACCT`); Extended Warranty: +1 year on warranties ≤ 3 years; Trip Delay: > 12 hours, $500 (`TD_CON_12 HRS_$500`); Baggage Delay; Lost Luggage; Trip Cancellation/Interruption. **No Return Protection section.** Claims: chasecardbenefits.com or 1-800-350-1362. |
| **Chase Sapphire Reserve® (Visa Infinite®)** | https://asset.chase.com/content/services/structured-document/document.en.pdf/card/benefits-center/product-benefits-guide-pdf/BGC11388_v2.pdf | BGC11388; "Effective 10/1/24" | 9a99960b952d299e0e871a149030536bc4a359ada8782bcfde33a35c99b14d35 | Purchase Protection: 120 days (90 NY), $10,000/item, $50,000/year, **secondary** coverage; Return Protection: 90 days, $500/item, $1,000 per 12 months, secondary; Extended Warranty; Trip Delay: > 6 hours, $500 (`TD_CON_6 HRS_$500`). Notice: e.g., Trip Delay claim notice "sixty (60) days of the Trip delay or as soon as reasonably possible". |
| **The Platinum Card® from American Express** — Purchase Protection | https://www.americanexpress.com/content/dam/amex/us/credit-cards/features-benefits/PP-Benefit-Guide_316-404_EDT_10.20_REV_4.24_a11y.pdf (linked from the Platinum entry on https://www.americanexpress.com/us/credit-cards/features-benefits/policies/purchase-protection-terms.html) | 316-404; "Rev. 4/19/2024" | d2daf83d23cb5f2baa6b194c553bb9a1eb1f49cbf3fb0e65185d056fa3bf954e | Up to 90 days from purchase; up to $10,000 per covered purchase; up to $50,000 per eligible card per calendar year; natural-disaster occurrence cap $500. Underwritten by AMEX Assurance Company. The card-to-PDF mapping was inferred from link order on the terms page → verify before activation. |
| **American Express** — Trip Delay (TD500 guide; linked for Platinum, Business Platinum, Delta Reserve, Hilton Aspire, and others) | https://www.americanexpress.com/content/dam/amex/us/credit-cards/features-benefits/TD500_846bff_a11y.pdf | TD500 (no revision date in the extracted text) | d03e108978f39df590a8ccb10f4f95d2010fd117a55ea330f1a0ee6220d71b23 | Covered Trip delayed more than six (6) hours by a covered hazard; "You must notify the Administrator of your claim within sixty (60) days"; claims by phone 1-844-933-0648 or online (Travel Guard). |
| **American Express** — Return Protection | https://www.americanexpress.com/content/dam/amex/us/credit-cards/features-benefits/RP_Benefit_Guide_Rev_10-20_10.09.23-final.pdf | "Rev 10-20" / file dated 10.09.23 | 6a00cb5df02ad3845260c331ddc5f128057213070426b5c4dda5e83e845ed268 | Return within 90 days of purchase when the merchant refuses; $300 per item; $1,000 per card member account per calendar year; notify by phone 1-800-228-6855 within 90 days of purchase; documents within 30 days of the call. |

Chase educational pages cited in document B (chase.com/…/trip-delay…, …/how-chase-return-protection-works) are **marketing/education**, not benefit guides. They are leads only.

### R06 — Card purchase protection → `needs_exact_guide`
- Sources: CSP, CSR, and Amex 316-404 guides above (OK-curl).
- Status: contract benefit; coverage "secondary and in excess" of other insurance (CSR guide text), so coordination with homeowner/renter insurance is required.
- Email: no. Claims go through the benefit administrator's portal or phone (chasecardbenefits.com; Amex Claims Center).
- Third-party preparation: the claim is the cardholder's. Guides use "You" = cardholder. Recoup may prepare the evidence packet; the cardholder files.
- Next: pick 2 products (CSP + Amex Platinum). Capture guide version per account opening/renewal; model payment allocation ("all or a portion" for Chase PP vs "entire cost" for Chase RP).

### R07 — Card return protection → `needs_exact_guide`
- Sources: CSR guide (RP 90 days, $500/item, $1,000 per 12 months, secondary); Amex RP guide (90 days, $300/item, $1,000/year, phone notice within 90 days of purchase). CSP has **no** return protection — a CSP holder must get `not_eligible` / "not in your card's guide", never "possible".
- Email: no (phone/portal). Third-party: cardholder files.

### R08 — Card extended warranty → `needs_exact_guide`
- Sources: CSP/CSR guides — extends an eligible US manufacturer's warranty by one (1) additional year when the original warranty is three (3) years or less; claim notice "within ninety (90) days of product failure or as soon as reasonably possible"; documents within 120 days. Amex extended-warranty terms page (https://www.americanexpress.com/us/credit-cards/features-benefits/policies/extended-warranty-terms.html) links 54 PDFs; none downloaded this run.
- Depends on R10 (the manufacturer's warranty must be identified first).

### R12 — Trip-delay / trip-cancellation card benefit → `needs_exact_guide`
- Sources: CSP (> 12 h), CSR (> 6 h), Amex TD500 (> 6 h). Thresholds differ by product, so a network logo tells nothing.
- Overlap: interacts with R02 (airline refund first; refunded fare is not a non-refundable loss), R04 (baggage-delay vs airline incidental expenses: single allocation per receipt), and R15.
- Email: no (portal/phone). Third-party: cardholder files.

---

## Travel (R09, R14, R15)

### R09 — Involuntary denied boarding → `ready_for_spec`
- Sources: 14 CFR part 250 (OK-curl; `sources/ecfr-14cfr250.txt`). §250.5: domestic — 200% of one-way fare up to **$1,075** (arrival > 1 h and < 2 h late), 400% up to **$2,150** (≥ 2 h); international departures from the US — 200%/$1,075 for 1–4 h, 400%/$2,150 beyond 4 h. Caps effective **2025-01-22** (FR 2024-23588; OK-curl), with DOT enforcement delayed to 2025-03-20 (FR 2025-02814). §250.8: tender compensation on the day and place of the denied boarding by cash or immediately negotiable check (with the §250.5 conditions for travel vouchers). §250.5(e): biennial CPI-U review; **2026 is a review year** → refresh monthly until published.
- Document B's caps ($1,075 / $2,150) and time bands are **confirmed**. B omits that these are "whichever is lower" caps on 200%/400% of the fare, the "no compensation" band (alternate arrival planned ≤ 1 h late), that exactly 2 h (domestic) / 4 h (international) already falls in the 400% tier ("less than two hours" is the 200% condition), and the effective date.
- Email: the carrier tenders payment at the airport. Recoup's role is to check the amount and track a missed tender. DOT consumer page (bumping-oversales): OK-browser access presumed (same site as refunds page), not fetched this run.
- Third-party: none found.

### R14 — Unprovided airline ancillary service → `ready_for_spec`
- Source: 14 CFR 260.4 (OK-curl; `sources/ecfr-14cfr260.txt`). Service not provided "through no fault of the consumer" → prompt, automatic refund by the merchant-of-record carrier (or the operating carrier if a ticket agent was merchant of record). For service unavailable to an individual (not all passengers), the refund obligation starts when the consumer **notifies the operating carrier** and it is confirmed. That notification "is considered a request for a refund" (260.4(c)).
- Same enforcement/refresh cycle as R02 (Refund III pending).
- Email: 260.4(c) sets no channel for the consumer notification. Use the carrier's channel and keep a timestamped copy.

### R15 — Controllable airline-disruption commitment → `ready_for_spec` (per-carrier packs)
- Sources: DOT Airline Customer Service Dashboard (OK-browser; "Last updated: Tuesday, December 10, 2024"): per-carrier commitments for controllable cancellations and delays. Each carrier's customer-service plan is linked from the page. DOT-DASH-1: "DOT will hold airlines accountable if they fail to fulfill a customer service commitment."
- Status: carrier promise (not statute). DOT withdrew the cash-compensation ANPRM on **2025-11-17** (FR 2025-20042, OK-curl), so there is no federal cash right for delays.
- Next: capture each carrier's plan PDF, versioned, with the commitment thresholds. The plans were not downloaded this run.
- Email: carrier channel; commitments are usually provided at the airport (vouchers) or by receipt reimbursement.

---

## Assets and warranties (R10, R11, R18)

### R10 — Warranty defect → `ready_for_spec` (framework + per-warranty packs)
- Sources: FTC "Businessperson's Guide to Federal Warranty Law" (https://www.ftc.gov/business-guidance/resources/businesspersons-guide-federal-warranty-law — OK-curl, HTTP 200); Magnuson-Moss (15 U.S.C. 2301 et seq.) and 16 CFR 700–703 (not fetched this run). Example exact warranty: **Apple One (1) Year Limited Warranty** for iPhone/iPad/etc. (https://www.apple.com/legal/warranty/products/ios-warranty-document-us.html — OK-curl, SHA-256 7ee9c4ff1b30f602e90a1f63893d5693a954ca0409c6b6533302acf8fe3b01d8).
- Eligibility must identify the governing written warranty and the covered defect (mission §11). State implied-warranty law is not evaluated.
- Email: manufacturer channel (Apple: online/phone/in-store service). Third-party: the owner requests service.

### R11 — Product recall / service program → `ready_for_spec` (candidate matching only)
- Sources: CPSC recalls API `https://www.saferproducts.gov/RestWebServices/Recall?format=json&RecallDateStart=…` (OK-curl; returned 2026-09-17 recalls; SHA-256 of sample 25973c00…7943). cpsc.gov/Recalls HTML is `blocked` (403) to curl.
- A model match is a **candidate**. Confirmation needs the exact model / serial / date range in the recall notice (mission §11). Manufacturer service programs (non-recall) have no central source → per-manufacturer.
- Email: remedy via the recalling firm's channel named in each recall.

### R18 — Vehicle recall / state lemon law → recall: `ready_for_spec`; lemon law: `defer`
- Sources: NHTSA API `https://api.nhtsa.gov/recalls/recallsByVehicle?make=…&model=…&modelYear=…` (OK-curl; returns campaigns by make/model/year — **not** VIN-specific open status). nhtsa.gov/recalls (VIN lookup) is `blocked` to curl. California Song-Beverly §1793.22 (Tanner Act presumption: within 18 months / 18,000 miles; 2+ repairs for a safety defect or 4+ repairs, etc.) — OK-curl, SHA-256 cc0f6c06…53d9.
- A make/model/year hit is a candidate, never a confirmed VIN match. Lemon law is state-specific; never declare repurchase entitlement (mission §11).

---

## Money movement and billing (R13, R16, R19)

### R13 — Debit / ATM / ACH / electronic-transfer error (Reg E) → `ready_for_spec`
- Sources: 12 CFR 1005.6 and 1005.11 (OK-curl; captured in `sources/ecfr-12cfr1005.6.txt`, `sources/ecfr-12cfr1005.11ab-excerpt.txt` and `sources/ecfr-12cfr1005.11c-excerpt.txt` since M2D). Verified: liability tiers — $50 if notified within **two business days** of learning of loss/theft; up to $500 otherwise; and, for failure to report an unauthorized transfer within **60 days** of the statement's transmittal, liability for later transfers the institution shows would not have occurred with timely notice, with no dollar cap stated (1005.6(b)(3)); extenuating circumstances extend the times (1005.6(b)(4)). Error notice: **oral or written**, received within 60 days after the institution sends the statement; written confirmation may be required within 10 business days of an oral notice (1005.11(b)). Investigation: **10 business days**, or up to **45 days** with provisional credit within 10 business days; 20 business days / 90 days in the new-account, POS, and foreign cases (1005.11(c)).
- Document B's Reg E summary (2-business-day and 60-day rules; $50/$500 tiers; 10 business days / 45 days; 20 business days / 90 days) is **consistent** with the regulation text.
- Legal status: CFPB overdraft rule (89 FR 106768) — **disapproved**, "no force or effect" (Pub. L. 119-10, 2025-05-09; OK-curl; passage PL119-10-1 in `sources/federal-web-pages-excerpts.md`). Still shown in eCFR §1026.62. CFPB P2P "larger participant" rule — also disapproved (Pub. L. 119-11). CFPB credit-card penalty-fee ($8) rule — CFPB page says "stayed" (OK-browser; page last modified 2024-06-03); later court disposition **not verified first-party**.
- Email: Reg E accepts oral notice; institutions often accept online/secure messages. Recoup should still recommend a written, timestamped notice.
- Payment-type classifier first (credit vs debit vs ACH vs P2P vs prepaid vs wire vs check). Wires and checks are outside Reg E error resolution.

### R16 — Subscription renewal / cancellation → `ready_for_spec` (state packs + federal status)
- Federal status (verified first-party):
  - FTC final rule 2026-02-12 (FR 2026-02866, OK-curl): "In light of Federal court decisions", the FTC recodified the Negative Option Rule text **as it existed before** its 2024 amendments — i.e., the 2024 click-to-cancel amendments are not in force.
  - FTC **ANPRM** 2026-03-13 (FR 2026-04952; comments were due 2026-04-13): the FTC restarted rulemaking on amendments "to allow [consumers] to cancel such payments without unwarranted obstacles".
  - ftc.gov rule page (https://www.ftc.gov/legal-library/browse/rules/negative-option-rule, OK-browser) shows the ANPRM docket.
  - The underlying court decision (reported as an 8th Circuit vacatur in 2025) was **not** read first-party this run.
  - Document B's "vacated … FTC restarted rulemaking in 2026" is **consistent** with the FTC's own documents. ROSCA (15 U.S.C. 8401–8405) was not fetched.
- State statutes verified (strongest found this run):
  - **California** Bus. & Prof. Code §17602 (OK-curl; SHA-256 fc425572…dd95): online cancellation "exclusively online, at will"; a "click to cancel" button when retention offers are shown; annual reminder; material-change notice. Amended by AB 2863 (Stats. 2024 ch. 515), **applying to contracts entered, amended, or extended on or after 2025-07-01** (§17602(j)).
  - **New York** GBL §527-a (OK-browser; revision 2025-11-07): cancel through the same medium; price-increase consent or a 14-day cancel-and-prorated-refund option; 15–45-day notice before annual renewals.
  - **Minnesota** §325G.57 (OK-curl; new 2024 c 114).
  - Document B's "more than 30 states" is **not verified**.
- Email: CA requires offering an email address, toll-free number, postal address, or equivalent mechanism for cancellation (§17602(c)). An email cancellation is valid evidence where the business offers email. Keep proof.
- Third-party: none found in these statutes. The consumer cancels.

### R19 — Cancelled event / materially undelivered service → `defer`
- Sources: R03 already covers services "not delivered … as agreed" paid by consumer credit card (1026.13(a)(3)). FTC Unfair or Deceptive Fees rule (16 CFR 464; FR 2024-30293, final rule 2025-01-10) concerns **price disclosure** for live-event tickets and short-term lodging, not refunds. No general federal event-refund rule located.
- Next: assisted path via R03 plus per-ticketing-platform terms.

---

## Program and service discovery (R20–R25)

### R20 — Hotel best-rate guarantee → `ready_for_spec` (Hilton pack); others `source_blocked`
- Hilton "Price Match Guarantee" (https://www.hilton.com/en/p/price-match-guarantee/ — OK-browser): claim within 24 hours of booking; same room/terms/dates; the comparison price must be ≥ 1% lower and publicly bookable; claims invalid after check-in. Benefit: match plus an additional 25% off the room rate. Passage: "The name and email address on the claim must match the name and email address on the reservation." → **third-party preparation restricted**: the claim must be filed by the guest.
- Hyatt (hyatt.com/info/best-rate-guarantee) `blocked` (403). Marriott guessed URL `404`. IHG terms URL found by search only (lead).
- Rental-car guarantees: not researched.

### R21 — Telecom / utility outage or missed appointment → `defer`
- No first-party source was fetched this run. Tariffs and outage-credit rules are state-PUC and provider specific.

### R22 — FTC / state regulator refund program → `ready_for_spec` (program registry)
- FTC Refunds page (https://www.ftc.gov/enforcement/refunds — OK-curl, SHA-256 dbc67ab7…edf7) lists active programs with date and administrator/phone (e.g., "Amazon Refunds — September 2026"; "AT&T Data Throttling Refunds — August 2026, JND Legal Administration"). Warning on the page: "The FTC will never threaten you, say you must transfer money to 'get a refund,' or promise you a prize."
- Each program page must be verified for claim method (automatic payment vs claim form), deadline, and eligibility. Settlement match ≠ membership. Never submit an unreviewed attestation.
- Email: per program. Third-party: FTC impersonation warning; claims generally by the affected consumer (per-program terms not captured).

### R23 — Class settlement eligibility → `defer`
- No first-party central registry exists. Each settlement has a court-approved administrator site that must be verified individually. Not attempted.

### R24 — Unclaimed property → `defer`
- USAGov (https://www.usa.gov/unclaimed-money — OK-curl): "There is no single place to look for all unclaimed money"; search each state's unclaimed-property office, plus federal databases (DOL back wages, PBGC pensions, VA insurance). NAUPA search (unclaimed.org/search) `blocked` (403).
- Identity-matching risk (name match ≠ ownership). Many states regulate fee-charging "finders" — **not verified** this run.

### R25 — Small-business shipping or SaaS guarantee → `defer`
- UPS and FedEx service-guarantee URLs returned HTTP 200 with JS shells (< 1 KB), so their content was not verified. SaaS SLAs are per-vendor contracts. Not a consumer rule; out of Phase 1–3 scope.

---

## R17 — Surprise medical bill / good-faith-estimate dispute → `privacy_gated`
- Source: CMS No Surprises (https://www.cms.gov/nosurprises — OK-curl, SHA-256 3da7fc3d…03a1): consumer and provider guidance, independent dispute resolution, and a patient-provider dispute path entry point.
- Mission §11 gate: no real medical documents until data flow, minimum-necessary collection, retention/deletion, access and redaction, and human review are approved. Synthetic fixtures only. Detailed thresholds (e.g., the uninsured/self-pay dispute trigger and filing window) were **not** captured this run → capture before any spec.
