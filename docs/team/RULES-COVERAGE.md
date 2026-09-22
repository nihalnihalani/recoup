# Scenario coverage registry — R01–R25 (lead-owned)

Source: `docs/research/usa-receipt-compensation-opportunities.md` (document B, 2026-09-22) ranked inventory. This registry records **actual** implementation, not intent. A placeholder card is not "implemented".

Statuses: implemented_verified · implemented_live_unverified · assisted_only · manual_review_only · blocked_source · blocked_provider · blocked_privacy_review · explicitly_deferred_by_scope · not_implemented

| ID | Scenario | Phase | Status | Supported scope | Governing source (verified?) | Automation | UI entry | Evaluator / packet | Tests | Limitations / blockers |
|---|---|---|---|---|---|---|---|---|---|---|
| R01 | Retail price adjustment | 1 | implemented_live_unverified (legacy flow) | merchant policy snapshots via Firecrawl; `price_adjustment` claims | per-merchant policy pages (captured per snapshot; not a versioned rule pack) | assisted | Board / Purchase / Watching | legacy `priceWatch` + `claims`; not yet on the rule/opportunity model | priceWatch/claims/policies suites | policy shown is current, not purchase-time (known limit); migration to rule pack pending |
| R02 | Airline cancellation / significant change | 1 | not_implemented | – | DOT refunds (unverified this mission) | – | – | – | – | – |
| R03 | Credit-card billing error (FCBA) | 1 | not_implemented | – | FTC / Reg Z (unverified) | – | – | – | – | formal notice channel must be source-backed |
| R04 | Delayed / lost / damaged baggage | 1 | not_implemented | – | DOT baggage (unverified) | – | – | – | – | liability ceiling ≠ payout |
| R05 | Late / missing online order (MITOR) | 1 | not_implemented | – | FTC MITOR 16 CFR 435 (unverified) | – | – | – | – | – |
| R06 | Card purchase protection | 2 | not_implemented | – | exact benefit guides (none captured) | – | – | – | – | never infer from network logo |
| R07 | Card return protection | 2 | not_implemented | – | exact benefit guides | – | – | – | – | – |
| R08 | Card extended warranty | 2 | not_implemented | – | exact benefit guides | – | – | – | – | – |
| R09 | Involuntary denied boarding | 2 (tracked travel slice) | not_implemented | – | 14 CFR 250 (unverified) | – | – | – | – | – |
| R10 | Warranty defect | 3 | not_implemented | – | written warranty + Magnuson-Moss / state law | – | – | – | – | – |
| R11 | Product recall / service program | 3 | not_implemented | – | CPSC / manufacturer programs | – | – | – | – | candidate ≠ confirmed match |
| R12 | Trip-delay / trip-cancellation card benefit | 2 | not_implemented | – | exact benefit guides | – | – | – | – | – |
| R13 | Debit/ATM/ACH/EFT error (Reg E) | 3 | not_implemented | – | 12 CFR 1005.6 / 1005.11 (unverified) | – | – | – | – | payment-type classifier first |
| R14 | Unprovided airline ancillary service | 2 (tracked travel slice) | not_implemented | – | DOT ancillary refund rule (unverified) | – | – | – | – | – |
| R15 | Controllable airline-disruption commitment | 2 | not_implemented | – | DOT dashboard / carrier customer-service plans | – | – | – | – | carrier promise, not law |
| R16 | Subscription renewal / cancellation | 3 | not_implemented | – | state ARLs; FTC negative option status (unverified) | – | – | – | – | no nationwide click-to-cancel guarantee |
| R17 | Surprise medical bill / GFE dispute | gated | not_implemented | – | CMS No Surprises (unverified) | – | – | – | – | privacy/safeguard gate before any real document |
| R18 | Vehicle recall / state lemon law | 3 | not_implemented | – | NHTSA; state lemon laws | – | – | – | – | state-aware intake only |
| R19 | Cancelled event / undelivered service | 4 | not_implemented | – | contract / state law / card dispute | – | – | – | – | – |
| R20 | Hotel best-rate / rental guarantee | 4 | not_implemented | – | chain BRG terms | – | – | – | – | – |
| R21 | Telecom/utility outage or missed appointment | 4 | not_implemented | – | state tariffs / provider policy | – | – | – | – | – |
| R22 | FTC / state regulator refund program | 4 | not_implemented | – | ftc.gov/enforcement/refunds | – | – | – | – | – |
| R23 | Class settlement eligibility | 4 | not_implemented | – | court-approved administrators | – | – | – | – | match ≠ class membership |
| R24 | Unclaimed property | 4 | not_implemented | – | state programs / NAUPA | – | – | – | – | name match ≠ ownership |
| R25 | Small-business shipping / SaaS guarantee | 4 | not_implemented | – | carrier/SaaS terms | – | – | – | – | – |
