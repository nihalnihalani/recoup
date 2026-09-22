# Captured excerpts — federal agency web pages and Federal Register notices

All pages below are works of the US federal government (public domain). Passages are copied verbatim from the text rendering obtained on **2026-09-23** by the method stated. `transportation.gov` returns HTTP 403 to non-browser clients (curl, WebFetch, Firecrawl key revoked), so DOT pages were read in a real browser pane (text extraction of `<main>`); no raw-response hash is available for those. Federal Register documents were fetched from `federalregister.gov/documents/full_text/text/...` with the SHA-256 shown.

Passage ids (`DOT-REF-*`, `DOT-BAG-*`, …) are cited by the rule specs. Federal Register DATES/SUMMARY passages are captured verbatim, with per-document hashes, in `federal-register-notices.txt`; the FR table below is an index.

---

## DOT — Refunds (consumer page)

- URL: https://www.transportation.gov/individuals/aviation-consumer-protection/refunds
- Page footer: "Last updated: Friday, November 7, 2025"
- Method: browser text extraction, 2026-09-23. Raw hash: not captured.

**DOT-REF-1** (rejecting an offer — timing)
> A refund is due within 7 business days after you reject an offer if you paid for the ticket with a credit card, and within 20 calendar days after you reject the offer if you paid for the ticket with another form of payment, such as a check or cash.

**DOT-REF-2** (not responding and not flying — timing)
> If you do not respond to an airline’s offer for alternative transportation and do not fly on the offered alternative flight, the airline must provide the refund to the original form of payment within 7 business days for credit card payments or 20 calendar days for other payments (e.g., cash or check) after the significantly delayed or changed flight or alternative flight departs from its destination.

**DOT-REF-3** (automatic refund — timing, the conflicting passage)
> The automatic refund must be provided within 7 business days (for credit card purchases) or 20 business days (for cash purchases) after the airline becomes aware that you don’t accept the alternative to a refund (e.g., reject the offer of alternative transportation or compensation, don’t respond to an offer and don’t take the alternative transportation).

**DOT-REF-4** (consumer traveled)
> Consumer Traveled - If you chose to take a significantly delayed/changed flight or an alternative flight offered by the airline, you are not entitled to a refund under DOT rules.

**DOT-REF-5** (carrier commitments are separate)
> Although you are not entitled to a refund if you decide to take a significantly changed/delayed flight, you may be entitled to compensation for certain expenses and/or amenities if the delay was due to something in the airline’s control and causes a long enough inconvenience during travel. For more information on U.S. airline commitments to provide compensation and amenities for cancellations and delays within their control, review the airline’s customer service plan or the airline customer service dashboard.

**DOT-REF-6** (downgrade while continuing travel)
> If the downgraded consumer continues to travel on the flight, the consumer is not entitled to a refund of the full airfare, but the airline must refund the difference between the original fare and the downgraded fare.

**DOT-REF-7** (deadline to accept offers)
> When an airline lets you know that your flight has been significantly changed or offers to rebook you on another flight, it is not required to keep the offer open indefinitely and can set a deadline for you to accept the offer.

**DOT-REF-8** (ticket agents and ancillary fees)
> Ticket agents are not responsible for refunding optional service fees if the service is not provided or baggage fees if a checked bag is significantly delayed or lost. Even if a ticket agent is the merchant of record for the ancillary service fee (including the checked baggage fee) that you paid, you must request a refund from the airline.

**DOT-REF-9** (24-hour rule — agents)
> No, the 24-hour refund/reservation requirement for airlines does not apply to tickets booked through online travel agencies, travel agents, or other third-party agents.

---

## DOT — Lost, Delayed, or Damaged Baggage (consumer page)

- URL: https://www.transportation.gov/lost-delayed-or-damaged-baggage
- Page footer: "Last updated: Wednesday, October 29, 2025"
- Method: browser text extraction, 2026-09-23. Raw hash: not captured.

**DOT-BAG-1** (incidental expenses)
> Airlines are required to compensate passengers for reasonable, verifiable, and actual incidental expenses that they may incur while their bags are delayed - subject to the maximum liability limits.

**DOT-BAG-2** (no arbitrary daily caps)
> Airlines are not allowed to set an arbitrary daily amount for interim expenses. For example, an airline cannot have a policy that they will reimburse a passenger up to only $50 for each day that a passenger’s bag is delayed.

**DOT-BAG-3** (domestic liability limit — consumer-page wording)
> For DOMESTIC flights, DOT regulation allows airlines to limit their liability for a lost, damaged, or delayed bag. Airlines are free to pay more than the limit, but are not required to do so.
>
> The maximum liability amount allowed by the regulation is $4,700 per passenger.

**DOT-BAG-4** (international)
> The maximum baggage liability for flights covered by the Montreal Convention is currently 1,519 Special Drawing Rights (approximately $2,175.00 US) per passenger.

**DOT-BAG-5** (lost-bag declaration varies)
> Most airlines will declare a bag lost between five and fourteen days after the flight, but this can vary from one airline to another.

**DOT-BAG-6** (lost bag contents)
> Once an airline determines that your bag is lost, the airline is responsible for compensating you for your bags’ contents - subject to depreciation and maximum liability limits.

**DOT-BAG-7** (exclusions in contracts of carriage — domestic)
> For DOMESTIC travel, airlines are not required to compensate passengers for items they have excluded in their contracts of carriage.

**DOT-BAG-9** (pre-existing damage / improper packing — guidance)
> Airlines are not responsible for pre-existing damage to the bag or if the damage was caused by improper packing.

**DOT-BAG-10** (report before leaving the airport — guidance, "Baggage Tips")
> If your bag arrives open, unlocked or visibly damaged, immediately check to see if any of the contents are missing or damaged. Report any problems to the airline before leaving the airport; insist on having a report created.

(DOT-BAG-9 and DOT-BAG-10 were captured in the same 2026-09-23 browser session as DOT-BAG-1…8 and added to this file during M2D.)

**DOT-BAG-8** (bag-fee refund after MBR)
> In order to receive a refund of the baggage fee for a significantly delayed bag, you must file a mishandled baggage report with the airline. You are encouraged to file the report as soon as you learn that your bag did not arrive with you at the destination. Once the airline has the mishandled baggage report on file and the bag delay becomes “significant” as described above, a refund of the bag fee should be issued to you automatically.

---

## DOT — Airline Customer Service Dashboard

- URL: https://www.transportation.gov/airconsumer/airline-customer-service-dashboard
- Page footer: "Last updated: Tuesday, December 10, 2024"
- Method: browser text extraction, 2026-09-23.

**DOT-DASH-1**
> DOT will hold airlines accountable if they fail to fulfill a customer service commitment. If you believe an airline has not fulfilled its commitment, contact the airline first to ensure it gives you what is owed.

---

## Federal Register — DOT notices affecting 14 CFR part 260

| Doc | Published | Action | SHA-256 (full_text .txt) |
|---|---|---|---|
| 2024-07177 (89 FR 32760) | 2024-04-26 | Final rule "Refunds and Other Consumer Protections"; effective 2024-06-25 | 1f3a3196e40cc0fa7bf152b90baf8a2ecc7f344d97cc2d0c9f71294839f85bb4 |
| 2024-17602 (89 FR 65534) | 2024-08-12 | Final rule conforming to FAA Reauthorization Act of 2024; effective 2024-08-12 | 4b2b56e413d4249d4f238756bf7a942abcfb78b283e1862b30b05915d75d7cb0 |
| 2025-22140 (90 FR 55999) | 2025-12-05 | Notification of enforcement discretion (renumbered flights) until 2026-06-30 | 5b8d3c44af05fe68989e90756096882052b6febe42c22c69584f407a82d4f6c9 |
| 2026-13675 (91 FR 41556) | 2026-07-07 | Extension of that enforcement discretion to 2027-07-07 | 86ca72bf61fc5da2f25b5621ec5800299afbfe6510d1ac99f81ffd9c4daa7396 |
| 2025-20042 | 2025-11-17 | Withdrawal of the "Airline Passenger Rights" ANPRM (cash compensation for disruptions, RIN 2105-AF20) | d40c41dedb9d105b8879530345a0b515d1849b489d395841292755d9f0d42bfc |
| 2024-23588 (89 FR 84815) | 2024-10-24 | Periodic revision: DBC caps $1,075/$2,150; domestic baggage $4,700; effective 2025-01-22 | 6dddf07aa286a45fc9aadc0369b44aaa59097c0d507b855751577f59060d8408 |
| 2025-02814 (90 FR 9952) | 2025-02-20 | Enforcement of 2024-23588 delayed until 2025-03-20 | a01949618e887ca05a12fb00ae611e592f8d44d3c542d6792c66bbf4338060cd |

**FR-2024-07177-COMPLIANCE** (compliance date for refund provisions)
> For provisions regarding ticket refunds due to airline cancellation or significant change, refunds of baggage fees for significantly delayed bags, and refunds of ancillary service fees when services are not provided, regulated entities will have six months from the date of publication of the final rule, or October 28, 2024, to implement the relevant requirements.

**FR-2026-13675-DATES**
> As of July 7, 2026, the Department is extending the pause on the enforcement of airline refunds requirements regarding cancelled flights under 14 CFR parts 260 and 399 for flights that are merely renumbered. This enforcement discretion is extended for 1-year from the date of this publication, expiring on July 7, 2027.

**FR-2026-13675-SCOPE**
> It applies solely to situations where a flight is given a different flight number but the passenger is successfully rebooked on [page break] the new flight without experiencing a ``significant change or delay'' (e.g., changes to departure/arrival times by three or more hours domestically, changes in departure/arrival airports, or downgrades in class of service). If a flight number change is accompanied by any such significant delay or disruptions, standard consumer refund mandates remain fully enforceable.

**FR-2026-13675-REFUND-III**
> The Department is engaged in a rulemaking titled ``Airline Refunds and Other Consumer Protections III'' (Refund III), identified by RIN 2105-AF36. Among other things, this proposed rule aims to reduce unnecessary regulatory burdens by modifying the definition of a flight cancellation that would entitle consumers to ticket refunds.

(As of 2026-09-23 the Federal Register API lists only the two enforcement-discretion notices under RIN 2105-AF36; no Refund III NPRM has been published.)

---

## FTC — Business Guide to the Mail, Internet, or Telephone Order Merchandise Rule

- URL: https://www.ftc.gov/business-guidance/resources/business-guide-ftcs-mail-internet-or-telephone-order-merchandise-rule
- Method: browser text extraction, 2026-09-23. No publication/revision date is displayed in the extracted text.

**FTC-MITOR-G1** (refund timing, plain-language)
> If the customer paid by cash, check, money order, or by credit where a third party is the creditor, or by any other method except credit where you are a creditor, you must refund the correct amount within seven working days after the order is cancelled. If the customer paid by credit where you are a creditor, you must credit the customter's account or notify the customer that the account will not be charged within one billing cycle after the order is cancelled.

(The misspelling "customter's" is in the source.)

**FTC-MITOR-G2** (no scrip)
> When making Rule-required refunds, you cannot substitute credit toward future purchases, credit vouchers, or scrip.

**FTC-MITOR-G3** (order-time representation supersedes advertising)
> The updated shipment information you provide on the telephone or the Internet supersedes any shipment representation you made in the advertising. You also must have a reasonable basis for the updated shipment representation.

**FTC-MITOR-G4** (email notice)
> Q: Can we send the delay option notice to the customer’s e-mail address?
>
> A: Yes.

**FTC-MITOR-G5** (services not covered)
> The Rule also does not cover services, such as mail order photo-finishing.

**FTC-MITOR-G6** (how much to refund)
> If you cannot ship any of the merchandise ordered by the customer, you must refund the entire amount the customer "tendered," including any shipping, handling, insurance, or other costs.

**FTC-MITOR-G7** (partial shipment — guidance, "How Much You Must Refund")
> If you ship some, but not all, of the merchandise ordered, you must refund the difference between the total amount paid and the amount the customer would have paid, according to your ordering instructions, for the shipped items only.

**FTC-MITOR-G8** (order-status page — guidance, Q&A)
> A: If you provide a delay option notice, you must choose a way that is reasonably likely to provide all the required information within the time period required by the Rule. If the consumer doesn’t visit the order-status page until after she misses her order, you haven’t complied with the Rule’s requirements that the delay option notice be provided within the promised shipment time.

(FTC-MITOR-G7 and G8 come from the same 2026-09-23 browser capture as G1…G6 and were added to this file during M2D.)

---

## FTC — Using Credit Cards and Disputing Charges (consumer page)

- URL: https://consumer.ftc.gov/articles/using-credit-cards-and-disputing-charges
- Page date shown: "May 2022". Method: browser text extraction, 2026-09-23.

**FTC-CC-1**
> Write to the issuer. Use the address given for billing inquiries, not the address for sending your payments.

**FTC-CC-2**
> Send your letter so that it reaches the issuer within 60 days after the first bill with the error was sent to you.

**FTC-CC-3** (claims-and-defenses — conflicts with regulation, see R03 spec)
> The goods or services must have cost more than $5.

(12 CFR 1026.12(c)(3)(i)(B) says the amount "exceeds $50". The regulation governs; the FTC page figure is recorded as a source conflict.)

---

## CFPB — Credit Card Penalty Fees Final Rule page

- URL: https://www.consumerfinance.gov/rules-policy/final-rules/credit-card-penalty-fees-final-rule/
- "Page last modified Jun. 3, 2024". Method: browser text extraction, 2026-09-23.

**CFPB-LATEFEE-1**
> As a result of ongoing litigation, the Credit Card Penalty Fees Final Rule published in the Federal Register on March 15, 2024, is stayed.

(eCFR 12 CFR 1026.52(b)(1)(ii) as of 2026-09-18 still displays the $8 safe harbor text. eCFR text is therefore not proof that a provision is in force.)

---

## Public Law 119-10 (CFPB overdraft rule disapproval)

- URL: https://www.govinfo.gov/link/plaw/119/public/10?link-type=html — SHA-256 19ebf6ccae0ec92d09c425efd9fac0d001501156bde23f572321b9d86b16d8dc

**PL119-10-1**
> That Congress disapproves the final rule submitted by the Bureau of Consumer Financial Protection relating to ``Overdraft Lending: Very Large Financial Institutions'' (89 Fed. Reg. 106768 (December 30, 2024)), and such rule shall have no force or effect. Approved May 9, 2025.

(eCFR 12 CFR 1026.62 "Overdraft credit" is still displayed as of 2026-09-18.)
