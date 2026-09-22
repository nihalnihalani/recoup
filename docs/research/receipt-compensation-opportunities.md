# Recoup expansion research: receipt-to-recovery opportunities

Date: 2026-09-22

## Executive recommendation

Recoup should expand from a price-drop product into a **transaction eligibility engine**:

> Forward any receipt, booking, bill, or transaction alert. Recoup tells you when money is owed, why, how much, what proof is required, and when the claim expires.

The winning frame is not “AI lawyer” and not “class-action finder.” It is **money recovery from deterministic consumer events**. Each supported claim type should have a reliable trigger, a primary policy or regulatory source, an amount formula, a deadline, an evidence checklist, a user-approved request, and a confirmed-money ledger.

This is a strong fit for the existing product. Recoup already ingests purchase email, researches policies, preserves exact passages, computes expected amounts, drafts a request, requires approval before sending, follows replies, and only counts money after the user confirms receipt.

## Important correction to the flight-delay example

A one-hour flight delay does not create a universal right to cash compensation.

- In the UK, fixed compensation generally begins when arrival is more than three hours late and UK261 applies. Care begins after two, three, or four hours depending on distance. A delay beyond five hours can create a right to abandon the trip and obtain a refund. Source: [UK Civil Aviation Authority](https://www.caa.co.uk/air-passengers/travel-problems-and-rights/flight-delays-and-cancellations/delays/).
- In Canada, compensation for an airline-controlled delay begins at three hours. Large-carrier compensation is CAD 400 for three to six hours, CAD 700 for six to nine hours, and CAD 1,000 above nine hours. The passenger generally has one year to claim and the carrier has 30 days to respond. Source: [Canadian Transportation Agency](https://otc-cta.gc.ca/eng/publication/flight-delays-and-cancellations-a-guide).
- In the United States, there is no blanket cash-compensation right for an ordinary domestic delay. A refund is due when the airline cancels or significantly changes a flight and the passenger chooses not to travel. DOT currently defines significant late arrival as at least three hours for domestic itineraries or six hours for international itineraries. Source: [US Department of Transportation](https://www.transportation.gov/individuals/aviation-consumer-protection/refunds).
- For EU rail, compensation generally starts at a 60-minute arrival delay. UK rail operators may pay Delay Repay from 15 or 30 minutes depending on the operator. Sources: [Your Europe](https://europa.eu/youreurope/citizens/travel/passenger-rights/rail/index_en.htm) and [National Rail](https://www.nationalrail.co.uk/help-and-assistance/compensation-and-refunds/).

Recoup therefore needs a jurisdiction and itinerary resolver before it shows an amount.

## Scenario inventory

Scores combine consumer value, rule determinism, document availability, implementation fit, and competitive intensity. Ten is best.

| Priority | Scenario | Trigger and proof | Potential recovery | Product fit | Score |
|---|---|---|---|---:|---:|
| 1 | Retail price adjustment | Receipt, item URL, purchase date, later lower price, merchant policy | Price difference | Already implemented; strongest bridge to the broader engine | 9.5 |
| 2 | IRCTC disruption refund | PNR, train status, boarding station, proof passenger did not travel, timely TDR | Full or partial fare; class or AC-failure difference | Deterministic events and strict deadlines make alerts valuable | 9.1 |
| 3 | Failed UPI, IMPS, card, ATM, or wallet transaction in India | Bank debit, failed or missing credit, transaction timestamp, delayed reversal | Automatic reversal plus generally Rs 100 per day after the prescribed TAT | High-frequency, easy ingestion from bank alerts, clear formula | 9.0 |
| 4 | Airline cancellation or significant schedule change | Ticket, airline notice, original and changed itinerary, travel decision | Refund, downgrade difference, or jurisdiction-specific compensation | High-value and document-rich, but jurisdiction-sensitive | 8.8 |
| 5 | Delayed, lost, or damaged baggage | Bag tag, property irregularity report, receipts for replacement items, delivery time | Actual reasonable expenses, baggage-fee refund, lost-item value subject to limits | Excellent evidence packet and follow-up workflow | 8.6 |
| 6 | UK, EU, or Canadian flight-delay compensation | Ticket, route, operating carrier, actual arrival time, cause, notice date | Fixed cash compensation plus care expenses | High recovery, but crowded by specialist competitors | 8.3 |
| 7 | Credit-card travel and purchase benefits | Card used, receipt, covered event, benefit guide, timely notice | Trip delay, baggage delay, purchase protection, return protection, warranty extension | Great receipt fit; benefit guides are card-specific | 8.3 |
| 8 | UK or EU rail delay compensation | Ticket, operator, scheduled and actual arrival, through-ticket details | 25% to 50% under EU rules; operator-specific UK Delay Repay | Simple formula and timestamp evidence | 8.2 |
| 9 | Duplicate, wrong-amount, returned, or undelivered credit-card charge | Receipt, statement line, delivery or return evidence, merchant contact | Charge reversal or refund | Strong deadline and evidence assistant; avoid casual chargeback abuse | 8.1 |
| 10 | Broadband or landline outage credit | Provider, fault-report timestamp, restoration timestamp, missed appointment | Ofcom scheme credits such as GBP 10.34 per outage day and GBP 32.31 per missed appointment in 2026 | Highly deterministic where schemes exist | 8.0 |
| 11 | Subscription renewal or cancellation failure | Signup terms, renewal notice, cancellation attempt, later charge | Refund or chargeback for unauthorized or misrepresented billing | High frequency, but consent facts can be disputed | 7.8 |
| 12 | Warranty repair, replacement, or refund | Receipt, serial number, warranty terms, defect photos, repair history | Repair, replacement, refund, or extended coverage | Strong for electronics, appliances, and vehicles | 7.8 |
| 13 | Safety recall or manufacturer service program | Model and serial number, purchase proof, recall or service notice | Refund, repair, replacement, reimbursement | The iPhone-style scenario becomes real when a model-specific program exists | 7.7 |
| 14 | Late or missing delivery | Order confirmation, promised date, tracking, merchant communications | Refund, reshipment, shipping-fee refund, or card dispute | Common and easy to detect from email | 7.6 |
| 15 | Cancelled event or materially changed service | Ticket, cancellation or change notice, refund policy | Ticket and fee refund, sometimes travel-related card benefits | Straightforward, but event and local-law rules vary | 7.4 |
| 16 | Hotel or rental-car price guarantee and service failure | Reservation, lower comparable rate, guarantee terms, incident proof | Rate difference, points, voucher, or refund | Policy-based rather than statutory; still easy to monitor | 7.2 |
| 17 | Utility outage or missed-service credit | Account, outage period, tariff or regulator rule | Bill credit or guaranteed-standard payment | Valuable, but fragmented by utility and region | 7.0 |
| 18 | Medical or insurance overpayment | EOB, bill, policy, denial reason, payment record | Corrected bill, insurer payment, refund | High value but regulated, sensitive, and operationally complex | 6.6 |
| 19 | FTC, regulator, or class-action settlement eligibility | Merchant, product, date range, model, account history, proof of purchase | Settlement payment or automatic refund | Attractive discovery feature, but deadlines and legitimacy checks are critical | 6.5 |
| 20 | Unclaimed property | Identity, past addresses, employer or institution match | Dormant funds or property | Useful acquisition feature, but weak connection to a receipt | 5.8 |

## What an iPhone receipt could unlock

Buying an iPhone does not by itself create a compensation right. The receipt becomes a key that Recoup can test against multiple programs:

1. A merchant price-adjustment window after a price drop.
2. A card's price-protection benefit, if the specific card still offers it.
3. Purchase protection if it is stolen or accidentally damaged within the covered period.
4. Return protection if the merchant refuses a covered return.
5. An extended-warranty benefit after the manufacturer's warranty expires.
6. An Apple or regulator safety recall, repair extension, or model-specific service program.
7. A warranty claim for a defect, with the serial number and repair history as evidence.
8. An App Store or digital-content refund for an eligible purchase.
9. A trade-in shortfall, late delivery, duplicate charge, or missing accessory dispute.
10. A settlement whose class definition includes the model, serial range, purchase date, or account.

The user-facing result should never say “you are owed money” from the receipt alone. It should say one of: **eligible**, **likely eligible but missing evidence**, **not eligible**, **deadline passed**, or **manual review required**.

## India-first opportunities

### Failed-payment compensation

The RBI framework is unusually automation-friendly. It states that compensation should be credited suo moto without waiting for a complaint. Examples in the framework include:

- ATM debit without cash: reversal by T+5, then Rs 100 per day of delay.
- IMPS or UPI transfer debit without beneficiary credit: reversal by T+1, then Rs 100 per day.
- UPI merchant payment debit without merchant confirmation: reversal by T+5, then Rs 100 per day.
- Card-not-present or point-of-sale debit without merchant confirmation: reversal by T+5, then Rs 100 per day.

Source: [Reserve Bank of India](https://www.rbi.org.in/Commonperson/english/Scripts/Notification.aspx?Id=3074).

Recoup can detect the debit alert, ask whether the recipient or merchant received the money, start the clock, check for reversal, compute compensation, and draft a bank complaint or RBI Ombudsman escalation if the automatic credit is missing.

### IRCTC refunds

The official IRCTC rules include several machine-detectable events:

- Full train cancellation: automatic full refund for confirmed e-tickets.
- Train more than three hours late and passenger does not travel: full refund if the TDR is filed before actual departure.
- Diversion, short termination, failure to touch boarding or destination station: TDR within the specified window.
- Lower class or missing proper coach: refund of fare difference.
- AC failure: TDR within 20 hours of actual arrival.

Source: [IRCTC cancellation and TDR rules](https://contents.irctc.co.in/en/CancellationRulesforIRCTCTrain.pdf).

This is a very good wedge because Recoup's primary value is the deadline alert. Many rights disappear not because the claim is invalid, but because the TDR was not filed in time.

### Indian flight rights

Recoup should ingest the Passenger Name Record, scheduled and actual times, airline notice, reason code, ticket price, and passenger decision. It should apply the current DGCA Passenger Charter and airline policy, then link escalation to AirSewa. The current Ministry page publishes the charter as a PDF, so production should version and verify the exact operative DGCA circular rather than encode amounts from memory.

Sources: [Ministry of Civil Aviation Passenger Charter](https://www.civilaviation.gov.in/ministry-documents/passenger-charter-of-rights) and [AirSewa](https://airsewa.gov.in/).

## Product architecture

### Ingestion

- Forwarded receipt, ticket, itinerary, bank alert, bill, cancellation email, or claim reply.
- Manual upload or paste for users who do not connect inboxes.
- Optional read-only Gmail or Outlook integration later.
- Calendar and travel-status feeds only after the document path works.

### Normalized transaction record

Every record should extract:

- merchant or service provider;
- item or service type;
- amount and currency;
- purchase, travel, delivery, or service dates;
- payment method and last four digits where available;
- route, PNR, ticket, serial number, tracking number, or transaction ID;
- user jurisdiction and event jurisdiction;
- original promise, changed outcome, and timestamps;
- attached receipts and communications.

### Rule pack

Each claim type needs a versioned rule pack containing:

- jurisdiction and applicability test;
- trigger event;
- exclusions and extraordinary-circumstance rules;
- amount formula and cap;
- evidence checklist;
- filing deadline and response deadline;
- first-party policy or regulator source;
- claim channel and escalation path;
- effective dates and version history.

### Eligibility states

Use a conservative state machine:

`detected -> needs evidence -> likely eligible -> user verified -> ready to send -> submitted -> paid / denied / escalated / expired`

“Likely eligible” should show the assumptions that can change the outcome. For example: “This assumes the delay was within the airline's control and not required for safety.”

### Claim packet

The generated packet should contain:

- a one-sentence request;
- the exact amount and formula;
- the relevant source passage and effective date;
- a timeline of what happened;
- attachments and receipt index;
- a response deadline;
- an escalation path if denied.

Recoup should continue its existing rule: the user approves every outbound message.

## Monetization

### Recommended model

1. **Free eligibility scan** for every forwarded receipt or ticket.
2. **Recoup Plus**, roughly USD 6 to 10 per month or a localized equivalent, for continuous monitoring, deadline alerts, card-benefit matching, and unlimited claim packets.
3. **Success fee for high-value recovery**, perhaps 15% to 25%, only where permitted and only after money is received. Use a clear cap and never take a percentage of tiny automated credits.
4. **One-time claim fee** for medium-value claims where percentage fees are awkward.
5. **B2B2C employee benefit** sold to employers, banks, card issuers, travel agencies, and insurers.
6. **Merchant recovery SaaS for small businesses** later: vendor SLA credits, parcel guarantees, cloud-service credits, duplicate invoices, and card disputes.

AirHelp validates both success-fee and membership demand, but its current standard fee is 35% and can reach 50% when legal action is required. Recoup can differentiate with lower fees, transparent self-service, and cross-category monitoring. Source: [AirHelp fees](https://www.airhelp.com/en-int/price-list/).

### What not to do

- Do not market Recoup as a lawyer or substitute for professional advice. The FTC's DoNotPay order is a direct warning. Source: [FTC DoNotPay case](https://www.ftc.gov/legal-library/browse/cases-proceedings/donotpay).
- Do not bulk-file speculative claims.
- Do not sell claim leads to law firms without explicit consent and legal review.
- Do not take affiliate commissions that can influence recommendations.
- Do not encourage friendly fraud or card disputes before the merchant has a fair chance to resolve the problem.
- Do not promise a recovery before jurisdiction, cause, deadlines, and evidence are verified.

## Suggested rollout

### Phase 1: extend the existing claim engine

Ship four claim types behind one inbox:

1. Retail price adjustment.
2. IRCTC disruption refund.
3. RBI failed-payment compensation.
4. Airline cancellation or significant-change refund.

These four prove the generalized architecture without requiring legal escalation.

### Phase 2: travel recovery

Add UK, EU, and Canadian flight compensation; baggage expenses; and UK/EU rail delay claims. Travel has high average recovery and excellent email evidence, but every result must show the governing jurisdiction and carrier.

### Phase 3: card and billing recovery

Add card-benefit matching, duplicate and undelivered-charge disputes, subscription renewals, telecom credits, and warranty or recall programs.

### Phase 4: discovery marketplace

Add regulator refunds, class-action settlements, unclaimed property, utility credits, and small-business service-level credits. Keep these as discovery and evidence tools until the legal and operational model is proven.

## MVP screens

1. **Money found**: ranked opportunities with amount, confidence, deadline, and missing evidence.
2. **Why you qualify**: formula, timeline, source passage, exclusions, and jurisdiction.
3. **What Recoup needs**: a short evidence checklist with upload or confirmation actions.
4. **Ready to send**: editable claim packet and recipient.
5. **Recovery timeline**: sent, acknowledged, due, followed up, escalated, paid.
6. **Confirmed money**: only user-confirmed recoveries count toward the total.

## Go-to-market frame

Recommended headline:

> Your receipts know when money is owed. Recoup finds it and helps you get it back.

Alternative:

> Forward the receipt. Recoup checks every refund, compensation, credit, and protection you may qualify for.

The product should lead with concrete examples, not legal language:

- “Your train is three hours late. File this before departure for a full refund.”
- “Your failed UPI payment was not reversed on time. The RBI formula indicates Rs 300 in compensation.”
- “Your bag arrived 18 hours late. Upload your clothing and toiletry receipts.”
- “This TV is now USD 140 cheaper and the store's 30-day adjustment window closes Friday.”
- “Your broadband repair crossed the automatic-credit threshold.”

## Research notes

The last-30-days scan found recent evidence around Amazon Prime settlement refunds, subscription refund friction, and disputed flight-compensation denials. The strongest community signal was that consumers struggle with eligibility and escalation, not merely awareness. Coverage was partial because X was unavailable and TikTok and Instagram returned provider credit errors. The durable scan is stored at `~/Documents/Last30Days/receipt-based-consumer-refunds-compensation-and-overlooked-money-back-rights-raw-v3.md`; Firecrawl source captures are stored in the repository's ignored `.firecrawl/` directory.
