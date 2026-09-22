# Recoup USA: receipt-to-recovery opportunity map

Date: 2026-09-22

## Executive recommendation

Frame Recoup as a **US transaction eligibility engine**:

> Connect or forward a receipt, ticket, bill, statement, or service notice. Recoup checks every refund, reimbursement, credit, warranty, card benefit, recall, and settlement path attached to that transaction.

The US does not have one broad consumer-compensation regime. The product must test four separate sources of value:

1. **Legal entitlement**: federal or state law requires a refund, reversal, reimbursement, repair, or payment.
2. **Contract benefit**: a credit card, insurance policy, warranty, or service plan pays after a covered event.
3. **Merchant or carrier promise**: a price-match policy, airline commitment, hotel guarantee, or service-level promise creates a credit or reimbursement.
4. **Settlement or goodwill**: a regulator refund, class settlement, recall program, or discretionary customer-service payment may be available.

This distinction should be visible in every result. Recoup should never present a merchant promise or goodwill request as a legal right.

## The key correction for US flight delays

A US flight delayed by one hour does **not** ordinarily create a federal right to cash compensation.

- If an airline cancels a flight or makes a significant change and the passenger declines the changed or alternative flight, the passenger is entitled to a refund. DOT defines a significant late arrival as at least 3 hours for a domestic itinerary or 6 hours for an international itinerary.
- If the passenger accepts and takes the delayed or rebooked flight, the DOT airfare-refund right generally no longer applies.
- For a controllable disruption, some airlines promise meals, hotel accommodation, ground transportation, or rebooking. These are carrier commitments shown in the DOT dashboard, not a universal cash-compensation law.
- Involuntary denied boarding due to oversales is different. If the substitute transportation arrives 1 to 2 hours late domestically, compensation is 200% of the one-way fare, capped at $1,075. Over 2 hours domestically is 400%, capped at $2,150. For international departures from the US, the 200% window is 1 to 4 hours and the 400% tier begins above 4 hours.
- Delayed baggage can create reimbursement for reasonable, verifiable, actual incidental expenses. The current domestic baggage liability ceiling is $4,700 per passenger. A lost or significantly delayed checked bag can also trigger an automatic refund of the bag fee after the passenger files a mishandled-baggage report.
- Tickets bought directly from an airline at least 7 days before departure must receive either a 24-hour penalty-free cancellation option or a 24-hour hold. The airline does not have to offer both, and the federal requirement does not apply to an online travel agency in the same way.

Primary sources: [DOT refunds](https://www.transportation.gov/individuals/aviation-consumer-protection/refunds), [DOT denied boarding](https://www.transportation.gov/individuals/aviation-consumer-protection/bumping-oversales), [DOT baggage](https://www.transportation.gov/lost-delayed-or-damaged-baggage), and the [DOT airline dashboard](https://www.transportation.gov/airconsumer/airline-customer-service-dashboard).

## Ranked US scenario inventory

Scores combine value to the consumer, rule determinism, evidence availability, implementation fit, and legal or operational complexity. Ten is best.

| Priority | Scenario | Trigger and proof | Recovery | Authority type | Fit |
|---:|---|---|---|---|---:|
| 1 | Retail price adjustment | Receipt, exact SKU, current price, purchase date, merchant policy | Price difference | Merchant promise | 9.5 |
| 2 | Airline cancellation or significant change | Ticket, original itinerary, change notice, decision not to travel | Automatic fare and fee refund | Federal right | 9.3 |
| 3 | Credit-card billing error | Statement, receipt, delivery or return proof, merchant contact, notice date | Reversal or corrected charge | Federal dispute right | 9.1 |
| 4 | Delayed, lost, or damaged baggage | Ticket, bag tag, baggage report, delivery time, replacement receipts | Actual expenses, bag-fee refund, property value subject to limits | Federal right | 9.0 |
| 5 | Late or missing online order | Order, promised ship date, delay notice, consent history | Cancellation and prompt refund | Federal rule plus card dispute | 8.9 |
| 6 | Card purchase protection | Card used, receipt, covered theft or damage, police or repair record | Repair, replacement, or reimbursement within plan limits | Card contract | 8.7 |
| 7 | Card return protection | Receipt, attempted merchant return, card terms | Reimbursement when a covered merchant refuses a return | Card contract | 8.6 |
| 8 | Card extended warranty | Receipt, original warranty, card used, failure date, repair estimate | Repair, replacement, or reimbursement | Card contract | 8.6 |
| 9 | Involuntary denied boarding | Confirmed reservation, on-time check-in and gate arrival, oversale notice, replacement arrival time | 200% or 400% of one-way fare, subject to current caps | Federal right | 8.5 |
| 10 | Warranty defect | Receipt, serial number, written warranty, failure evidence, repair history | Repair, replacement, or refund depending on warranty and state law | Warranty plus federal/state law | 8.4 |
| 11 | Product safety recall or service program | Brand, model, serial number, purchase date, recall match | Repair, replacement, refund, or reimbursement | Regulator or manufacturer program | 8.3 |
| 12 | Trip-delay or trip-cancellation card benefit | Ticket charged to covered card, cause, delay length, expense receipts | Meals, hotel, transport, or nonrefundable trip costs within plan limits | Card insurance contract | 8.2 |
| 13 | Debit card, ATM, ACH, or electronic-transfer error | Statement, transaction identifier, notice date, authorization facts | Provisional credit, correction, fee refund, limited consumer liability | Regulation E | 8.2 |
| 14 | Unprovided airline ancillary service | Fee receipt plus evidence Wi-Fi, seat, upgrade, lounge, or other service was unavailable | Fee refund | Federal right | 8.1 |
| 15 | Controllable airline delay commitment | Ticket, cause, delay duration, airline-specific commitment, expense receipts | Meal, hotel, transport, or rebooking | Airline promise | 8.0 |
| 16 | Subscription renewal after cancellation or inadequate consent | Signup terms, cancellation attempt, renewal notice, charge | Merchant refund, state-law remedy, or payment dispute | State law, federal enforcement, contract | 7.9 |
| 17 | Surprise medical bill or good-faith-estimate dispute | Bill, EOB, provider type, location, estimate, consent forms | Reduced or corrected bill; formal dispute path | Federal and state law | 7.8 |
| 18 | Vehicle recall or state lemon-law claim | VIN, purchase or lease contract, repair orders, days out of service | Free repair, repurchase, replacement, or incidental costs | Federal recall plus state law | 7.8 |
| 19 | Cancelled event or materially undelivered service | Ticket, cancellation notice, policy, service evidence | Refund and possibly card-benefit recovery | Contract, state law, card dispute | 7.6 |
| 20 | Hotel best-rate or rental guarantee | Confirmed reservation, comparable lower offer, policy conditions | Rate difference, free night, points, or voucher | Merchant promise | 7.2 |
| 21 | Telecom or utility outage or missed appointment | Account, outage or appointment timestamps, tariff or provider policy | Bill credit or guaranteed payment | State tariff or provider promise | 7.1 |
| 22 | FTC or state regulator refund program | Merchant, account, purchase dates, program eligibility | Automatic or claimed refund | Enforcement program | 6.9 |
| 23 | Class settlement eligibility | Merchant, product, date range, model, account, proof of purchase | Cash, voucher, credit, repair, or replacement | Court-approved settlement | 6.7 |
| 24 | Unclaimed property | Identity, prior addresses, employer or institution match | Dormant funds or property | State custody program | 6.2 |
| 25 | Small-business shipping or SaaS service guarantee | Shipment or account record, promised SLA, failure timestamp | Shipping-fee refund or service credit | Commercial contract | 6.1 |

## Detailed eligibility patterns

### 1. Retail price drops

**Detection:** Match a receipt to the same SKU and monitor the merchant price until the policy window closes.

**Evidence:** Original receipt, product identifier, purchase channel, payment method, current listing, and policy effective on the purchase date.

**Caution:** US merchants are not generally required to refund a later price difference. This is normally a store policy or, less commonly, a card benefit. Recoup should label it “merchant promise,” not “consumer law.”

### 2. Airline refund and fee recovery

**Detection:** Compare the original itinerary with carrier notices and actual operations. Ask whether the passenger accepted or used alternative transportation.

**Potential outcomes:** Airfare refund, downgrade fare difference, unused ancillary-fee refund, baggage-fee refund, denied-boarding payment, or expense reimbursement.

**Deadlines and timing:** Required airline refunds generally go to the original payment method within 7 business days for credit-card purchases or 20 calendar days for other payment methods. DOT's page separately describes some automatic-refund timing using 20 business days for cash purchases, so the rule pack should preserve the exact source passage and event path rather than flattening every situation into one timer.

### 3. Credit-card disputes under the Fair Credit Billing Act

**Detection:** Duplicate or wrong amount, returned item without credit, goods or services not delivered as agreed, or an unauthorized charge.

**Evidence:** Statement, receipt, order and delivery history, cancellation or return record, merchant conversation, and the billing-error address from the statement.

**Deadline:** To preserve the formal FCBA procedure, written notice generally must reach the issuer within 60 days after the first statement containing the error. Recoup should generate the letter and evidence index, but first ask the user to attempt a merchant resolution when appropriate.

Source: [FTC credit-card disputes](https://consumer.ftc.gov/articles/using-credit-cards-and-disputing-charges).

### 4. Debit-card and electronic-transfer errors

Regulation E is not the same as a credit-card chargeback. Consumer liability can depend heavily on when an unauthorized transfer or lost access device is reported. The regulation contains 2-business-day and 60-day timing rules and potential liability tiers of up to $50, up to $500, or more in late-reporting cases.

For a qualifying notice of error, the institution generally investigates within 10 business days. If it needs more time, it may take up to 45 days if it provisionally credits the account within the required period. Some cases extend to 20 business days or 90 days.

Recoup should implement a payment-type classifier before suggesting any dispute: credit card, debit card, ACH, ATM, wallet, P2P payment, check, and wire do not share one rule.

Sources: [Regulation E liability](https://www.consumerfinance.gov/rules-policy/regulations/1005/6/) and [error resolution](https://www.consumerfinance.gov/rules-policy/regulations/1005/11/).

### 5. Late shipment or missing merchandise

The FTC Mail, Internet, or Telephone Order Merchandise Rule requires a seller to have a reasonable basis for the promised shipping time. If no time is stated, the default expectation is generally shipment within 30 days. If the seller cannot ship on time, it must seek consent to the delay or provide cancellation and prompt refund options.

This is highly automatable from order confirmation, promised date, tracking, and delay emails.

Source: [FTC merchandise rule guide](https://www.ftc.gov/business-guidance/resources/business-guide-ftcs-mail-internet-or-telephone-order-merchandise-rule).

### 6. Card-linked protections

Purchase protection, return protection, extended warranty, trip delay, trip cancellation, baggage delay, lost luggage, rental coverage, and cell-phone protection can be attached to the exact card used. Eligibility depends on the exact card, benefit guide version, payment allocation, event cause, exclusions, notice deadline, and documentation.

Recoup needs a versioned card-benefit library. The product should never infer benefits from a network logo alone because benefits differ by issuer and card product.

Examples: [American Express benefit policies](https://www.americanexpress.com/us/credit-cards/features-benefits/policies/), [Chase trip-delay guidance](https://www.chase.com/personal/credit-cards/education/basics/chase-trip-delay-insurance-what-to-know), and [Chase return protection](https://www.chase.com/personal/credit-cards/education/basics/how-chase-return-protection-works).

### 7. Warranty, recall, and lemon-law recovery

The receipt identifies the seller, date, model, and sometimes serial number. Recoup can then test:

- written manufacturer or retailer warranty;
- card extended warranty;
- CPSC recall or manufacturer service program;
- NHTSA vehicle or equipment recall;
- state implied-warranty or lemon-law rules;
- prior repairs, days out of service, and repeat failures.

Lemon law is state-specific. Recoup should initially provide a state-aware evidence and deadline assistant rather than automatically declaring that a repurchase is owed.

Sources: [FTC warranty guide](https://www.ftc.gov/business-guidance/resources/businesspersons-guide-federal-warranty-law), [CPSC recalls](https://www.cpsc.gov/Recalls), and [NHTSA recalls](https://www.nhtsa.gov/recalls).

### 8. Subscription and auto-renewal recovery

This requires special care in 2026. The FTC's 2024 nationwide Click-to-Cancel amendments were vacated by a federal appeals court. The FTC restarted rulemaking in 2026. Other federal authorities, including the FTC Act, ROSCA, the Telemarketing Sales Rule, and the older Negative Option Rule, may still apply, while more than 30 states have their own automatic-renewal requirements.

Recoup should use state-specific rule packs and focus on facts: disclosure, affirmative consent, renewal reminder, cancellation method, cancellation timestamp, and post-cancellation charges. It should not tell every US user that one nationwide click-to-cancel rule currently guarantees a refund.

Source: [FTC Negative Option Rule status](https://www.ftc.gov/legal-library/browse/rules/negative-option-rule).

### 9. Medical billing disputes

The No Surprises Act can protect insured consumers from certain out-of-network bills for emergency services and some non-emergency services at in-network facilities. Uninsured or self-pay patients may have a patient-provider dispute path when a bill is substantially above the good-faith estimate.

Recoup would need health-data safeguards, precise location and provider classification, EOB parsing, consent-form checks, and strong disclaimers. This is high-value but should follow less sensitive claim types.

Source: [CMS No Surprises](https://www.cms.gov/nosurprises).

### 10. Regulator refunds, settlements, and unclaimed property

These are valuable matching products but should not be marketed as receipt-created rights.

- FTC refund programs can issue payments to affected consumers, sometimes automatically and sometimes through a claim process.
- Class settlements can use purchase dates, models, serial numbers, account data, or proof of purchase to determine class membership.
- State unclaimed-property programs return dormant funds using identity, past address, employer, bank, or institution matching.

Sources: [FTC refunds](https://www.ftc.gov/enforcement/refunds), [USAGov unclaimed money](https://www.usa.gov/unclaimed-money), and [NAUPA search](https://unclaimed.org/search/).

## What an iPhone receipt can unlock in the US

Buying an iPhone does not automatically produce compensation. The receipt can start an eligibility stack:

1. **Merchant price adjustment:** Did the exact model and configuration drop in price during the store's adjustment window?
2. **Return window:** Is the purchase still returnable, and are restocking or carrier activation conditions satisfied?
3. **Card purchase protection:** Was it stolen or accidentally damaged during a covered period?
4. **Card return protection:** Did the merchant refuse a return that the card benefit covers?
5. **Extended warranty:** Did a covered defect occur after the manufacturer warranty but inside the card's extension?
6. **Apple warranty or AppleCare:** Does the device, failure type, and purchase date fit the coverage?
7. **Recall or service program:** Does the exact model or serial range match a repair, replacement, or reimbursement program?
8. **Trade-in discrepancy:** Is the paid trade-in value lower than the quoted value without a supported reason?
9. **Delivery or billing error:** Was it late, missing, duplicated, misconfigured, or charged at the wrong amount?
10. **Digital-content refund:** Is an App Store or Apple-services purchase eligible for Apple's refund request process?
11. **Carrier promotion failure:** Did the user satisfy activation, trade-in, port-in, or installment terms but miss promised bill credits?
12. **Settlement match:** Does a model, purchase date, account, or serial range fit an open settlement?

The result card should say one of: **eligible**, **likely eligible but missing evidence**, **possible contractual benefit**, **manual review required**, **not eligible**, or **deadline passed**.

## Product design

### Input channels

- forwarded receipt, booking, bill, order confirmation, or statement;
- email connection with explicit scopes and clear deletion controls;
- photo or PDF upload;
- bank or card transaction feed later;
- manual event reporting for delay, damage, cancellation, outage, or theft.

### Normalized transaction record

Extract and retain:

- merchant, provider, issuer, carrier, and operating carrier;
- item, service, SKU, model, serial, VIN, ticket, PNR, bag tag, or tracking number;
- amount, taxes, fees, currency, and payment method;
- purchase, billing, shipment, delivery, travel, repair, cancellation, and notice timestamps;
- user state, transaction state, travel origin and destination, and governing jurisdiction;
- original promise and actual outcome;
- source documents and a tamper-evident timeline.

### Versioned rule pack

Each scenario needs:

- authority class: law, card contract, merchant promise, settlement, or goodwill;
- jurisdiction and applicability test;
- trigger and exclusions;
- payout formula, cap, and tax treatment where relevant;
- evidence checklist;
- notice, filing, and response deadlines;
- first-party source passage, URL, effective date, and last verification date;
- claim channel and escalation path;
- automation level: automatic, assisted, or manual review.

### Eligibility state machine

`detected -> needs facts -> likely eligible -> user verified -> ready to send -> submitted -> paid / denied / escalated / expired`

Every “likely eligible” result should show the assumptions that can change the answer. The user must approve every outbound claim or dispute.

### User-facing opportunity card

Show:

- estimated recovery and recovery type;
- confidence and the reason for it;
- deadline countdown;
- authority badge;
- missing facts or documents;
- exact formula and cap;
- first-party source and effective date;
- action button: claim, ask merchant, dispute, upload proof, or dismiss.

## Recommended US MVP

### Phase 1: deterministic transaction recovery

1. Existing retail price adjustments.
2. Airline cancellation and significant-change refunds.
3. Baggage expense packets and bag-fee refunds.
4. Late or missing order refunds.
5. Credit-card billing-error evidence packets.

These flows are document-rich, understandable, and close to Recoup's current receipt workflow.

### Phase 2: benefit matching

1. Purchase protection.
2. Return protection.
3. Extended warranty.
4. Trip-delay and baggage-delay benefits.
5. Airline controllable-disruption commitments.

Start with a small set of cards whose official benefit guides can be versioned reliably.

### Phase 3: asset and billing protection

1. Product recalls and service programs.
2. Warranty claims.
3. Subscription cancellation evidence.
4. Regulation E deadline assistant.
5. Vehicle recall and state lemon-law intake.

### Phase 4: discovery marketplace

1. FTC and state refund programs.
2. Class settlements.
3. Unclaimed property.
4. Utility and telecom credits.
5. Small-business shipping and SaaS credits.

## Monetization

### Recommended mix

1. **Free money scan:** limited active opportunities and one basic claim packet.
2. **Recoup Plus at roughly $6 to $10 per month:** continuous receipt monitoring, deadline alerts, card-benefit matching, recall matching, and unlimited assisted packets.
3. **One-time assisted claim fee:** useful for medium-value recovery where a subscription is unattractive.
4. **Success fee on high-value recoveries:** potentially 15% to 25%, only where lawful, clearly disclosed, and charged after confirmed payment. Cap the fee and exclude tiny automatic credits.
5. **B2B2C distribution:** employee benefit, premium card perk, bank or credit-union feature, travel-agency add-on, insurer retention feature, or merchant post-purchase support.
6. **Small-business edition later:** parcel guarantees, card disputes, vendor SLA credits, duplicate invoices, and software credits.

### Revenue guardrails

- Do not claim to be a law firm or promise legal representation.
- Do not file speculative disputes or encourage friendly fraud.
- Do not take affiliate money that changes eligibility recommendations.
- Do not sell sensitive claim leads without explicit, separate consent.
- Do not calculate the success fee on refunds that would have arrived automatically before Recoup acted.
- Show the user the self-service path before offering paid assistance.
- Confirm actual receipt of money before counting recovery or charging a success fee.

## Community signal from the last 30 days

Recent discussion reinforces that the product value is not merely finding a rule. It is making the path usable. A YouTube commenter, @nileshpatil5644, summarized the friction as: “Not easy process for normal consumer....justice is not for poor people.” Another, @satyapaul1851, replied: “Correct - too much tough even for an educated person”.

That supports a product built around evidence collection, deadline tracking, exact forms, and escalation rather than a directory of generic consumer tips. The scan also surfaced a current FTC refund program and current discussion about US airline refund limits. Coverage was partial because TikTok and Instagram authentication failed, X was not enabled, and some YouTube transcripts were rate-limited. The durable raw file is `/Users/nihalnihalani/Documents/Last30Days/us-receipt-based-refunds-compensation-and-consumer-money-back-rights-raw-v3.md`.

## Go-to-market positioning

Recommended headline:

> Every transaction may come with money-back rights. Recoup finds yours before the deadline.

Alternative:

> Forward the receipt. Recoup checks refunds, credits, warranties, card benefits, recalls, and compensation.

Example cards:

- “Your domestic flight now arrives 3 hours 22 minutes late. If you decline the changed itinerary, DOT rules indicate a refund to your original payment method.”
- “Your checked bag was delayed. Upload replacement clothing and toiletry receipts so Recoup can prepare the expense claim.”
- “This iPhone may still be covered by your card's extended warranty. We need the original warranty and a repair estimate.”
- “This order missed its promised shipment date. The seller must obtain your consent to the delay or offer cancellation and a prompt refund.”
- “This charge first appeared 48 days ago. The formal credit-card billing-error window may close in 12 days.”
- “Your vehicle VIN matches a recall. The repair should be provided without charge; schedule it with a dealer.”

## Final product thesis

The defensible product is not a static list of compensation schemes. It is a continuously versioned system that joins transaction evidence to rules and benefits, watches deadlines, asks only the missing questions, creates a source-backed claim packet, and records confirmed recovery.

The best US launch promise is:

> Recoup turns receipts, tickets, bills, and statements into a live map of money you can recover.
