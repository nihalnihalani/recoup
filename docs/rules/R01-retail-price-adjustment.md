# R01 — Retail price adjustment (framework spec for merchant rule packs)

| Field | Value |
|---|---|
| Stable id | `R01.retail_price_adjustment` (framework). Merchant packs: `R01.<merchant_slug>.<channel>` (e.g., `R01.bestbuy.online`) |
| Version | framework `v1`; each merchant pack is versioned independently (`v1`, `v2`, … one per captured policy version) |
| Review status | **researched** (framework and the four sample packs below). Not `active`. |
| Authority class | **Merchant promise** (never "consumer law" — no general US legal duty to refund a later price drop) |
| Authority subtype | merchant published policy (price match / price adjustment / price protection) |
| Jurisdiction | United States; per merchant; per channel (store / online / app / marketplace); some merchants carve out Puerto Rico or specific states |
| Effective date | per merchant policy version; frequently **not displayed** |
| Retrieval date | 2026-09-23 (sample packs) |
| Last verification date | 2026-09-23 |
| Refresh policy | Each merchant pack is re-captured at least every **7 days** while any user has an open window with that merchant, and on every evaluation older than 24 h. A changed content hash creates a **new pack version**; it never rewrites the old one. |
| Reviewer | — (unassigned) |

Quotations from merchant pages are limited to ≤ 2 sentences each (copyright); follow the URL for the full text. The existing Recoup price-watch flow already captures merchant policy snapshots via Firecrawl (RULES-COVERAGE R01). This spec defines what those snapshots must become to count as a versioned rule pack.

---

## 1. Why the current policy page is not proof of the purchase-date policy

1. **Policies change without notice to past buyers.** Best Buy's Price Match Guarantee page displays "Effective date: September 2, 2026" (retrieved 2026-09-23). A Best Buy purchase made on 2026-08-25 is governed by the **previous** version, which Recoup has not captured. Applying the 2026-09-02 text to it would be applying a later policy to an older transaction.
2. **Many pages show no effective date.** Target's and Apple's pages captured today show none. A snapshot proves only what the page said **at retrieval time**.
3. **Merchants reserve the right to change the terms.** Costco: restrictions "will be shown at the point of purchase". Best Buy: "may amend these terms at any time".
4. **Therefore** a merchant pack version `V` may govern a purchase at time `p` only if one of these holds:
   - (a) `V.effective_from` is displayed and `V.effective_from ≤ p`, and no later version with `effective_from ≤ p` exists in the capture history; **or**
   - (b) there is a snapshot of `V` captured at `t1 ≤ p` **and** a snapshot with an identical normalized content hash captured at `t2 ≥ p` (the policy text is bracketed; label as the assumption "unchanged between captures"); **or**
   - (c) the user provides the policy as shown at purchase (receipt text, order-confirmation terms, a dated screenshot), which is recorded as user evidence.
   - If none of (a)–(c) holds, two cases must be kept apart:
     - **Known mismatch:** the captured version displays `effective_from` **after** `p` (e.g., Best Buy's 2026-09-02 page applied to a 2026-08-25 purchase). The current page is affirmatively **not** the purchase-date policy → **`source_unverified`**, no amount, and the UI says "the merchant changed this policy after your purchase; we don't have the version that applied".
     - **Unknown applicability:** no effective date is displayed and no bracketing capture exists → the outcome is **capped at `likely_eligible_missing_evidence`** (M01 contract `likely_eligible`). The assumption shown is "the current policy text is assumed to be the one in effect on <purchase date>", and the missing fact is `retail.policy_confirmed`. It is **never** `eligible`. This keeps the existing price-watch flow working while stating the uncertainty (mission §1: preserve price-first functionality; mission §8: unknown historical applicability requires review).

## 2. What a merchant rule pack must record

| Field | Type | Notes |
|---|---|---|
| `merchant_id`, `merchant_display_name` | string | legal seller; marketplace sellers are separate merchants |
| `channel_scope` | enum[] | `store`, `online`, `app`, `phone`; marketplace excluded unless the policy says otherwise |
| `policy_url` | URL | canonical, plus any redirect target observed |
| `captured_at` | datetime | retrieval instant |
| `content_hash` | sha256 | of the normalized main-content text |
| `captured_passages` | {id, text ≤ 2 sentences, selector} | the exact passages the evaluator relies on |
| `effective_from` | date \| `unknown` | as displayed by the merchant |
| `superseded_by` | pack version \| null | set when a later capture differs |
| `program_type` | enum | `own_price_drop` (merchant lowers its own price) \| `competitor_match_at_sale` \| `competitor_match_post_sale` \| `price_protection` |
| `window` | {length, unit (`calendar_days` \| `days_unspecified` \| `return_period`), anchor (`purchase_date` \| `receipt_or_delivery_date` \| `price_change_date`), inclusive: bool} | several merchants use **two** clocks (Apple) |
| `window_dependencies` | enum[] | `membership_tier`, `product_category` (e.g., activatable devices), `promotion_dates` |
| `comparison_price_source` | enum[] | `same_merchant_same_channel`, `same_merchant_any_channel`, `named_competitors`, `specific_store_only` |
| `identity_match_requirements` | enum[] | `brand`, `model_number`, `color`, `size`, `weight`, `quantity`, `condition_new`, `sku` |
| `quantity_limit` | integer \| null | e.g., Apple 10 units; Costco promotional limits |
| `exclusions` | enum[] + passage ids | clearance, open-box, refurbished, marketplace, limited-time events, Black Friday week, coupons, gift-card promos, membership pricing, typographical errors, precious metals, … |
| `request_channel` | enum + detail | chat, phone, form, in-store counter |
| `remedy_form` | enum | `refund_original_payment` \| `credit` \| `gift_card` \| `unspecified` |
| `discretion_clause` | boolean + passage id | "sole discretion" → the evaluator may not return `eligible` without a `merchant_discretion` note |
| `proof_requirements` | enum[] | receipt, live price page (screenshots refused by Target), order number |
| `jurisdiction_carveouts` | string[] | e.g., Puerto Rico |

## 3. Facts the evaluator needs (typed)

| Fact | Type | Source of truth |
|---|---|---|
| `merchant_id`, `channel` | string, enum | receipt / order confirmation |
| `purchase_at` | datetime | receipt |
| `received_at` | datetime \| unknown | delivery confirmation / pickup record (needed where the anchor is receipt) |
| `item_identity` | {brand, model_number, sku, variant: color/size/capacity, condition} | receipt + product page (never inferred from a similar title) |
| `quantity` | integer | receipt |
| `unit_price_paid` | money (minor + currency) | receipt (pre-tax, net of item-level discounts) |
| `comparison_offer` | {price (minor + currency), source (merchant/channel/URL), observed_at, availability, is_clearance/open_box/limited_time flags, evidence id} | Firecrawl observation or user-confirmed alternate offer |
| `membership_tier` | enum \| unknown | user (only when the pack depends on it) |
| `prior_adjustments` | money[] | receipts / statements |

ShopSavvy or any price-history service is **context only** and never independently authorizes a claim or an alert (mission §10).

## 4. Calculation

`difference_per_unit = unit_price_paid − comparison_price` (same currency; pre-tax unless the policy says otherwise). If ≤ 0 → no opportunity.
`eligible_units = min(quantity, quantity_limit ?? quantity)`.
`estimate = difference_per_unit × eligible_units − prior_adjustments`.
Example (mission §17): 2 units at 12,000 with an eligible matching price of 9,500 → 2 × 2,500 = **5,000**. Wrong variant, wrong currency, or an unverified purchase-date policy → **no** price claim (`not_eligible` or `source_unverified`, never a number).

## 5. Deadline semantics

- Window end = `anchor + length` in the pack's unit; the inclusive/exclusive boundary must be recorded per pack. If the merchant does not state it → assume inclusive of the last day in the merchant's local time and label it an assumption.
- Two-clock policies (Apple): **both** must be open — (1) the price change occurred within 14 calendar days of receipt; (2) the request is made within 14 days of the price change.
- An expired window closes this path only — the return window, card price protection (none captured), and other paths are separate.

## 6. Outcomes

`eligible` (identity match confirmed, the purchase-date policy verified per §1.4 (a)–(c), window open, comparison offer eligible and currently observed) · `likely_eligible_missing_evidence` (e.g., receipt missing; or purchase-date applicability unknown per §1.4 "unknown applicability") · `needs_facts` (e.g., received date for a receipt-anchored window; membership tier) · `source_unverified` (no captured pack for the merchant/channel, stale pack, or a known effective-date mismatch per §1.4) · `not_eligible` (excluded offer, window closed before the drop, no price difference) · `deadline_passed` · `unsupported` (merchant without a captured pack). A `discretion_clause` pack never yields a guaranteed amount; the UI says "merchant decides".

## 7. Sample merchant packs verified 2026-09-23

### 7.1 Best Buy — Price Match Guarantee (`R01.bestbuy.all_channels`, pack v1)

- URL: https://www.bestbuy.com/site/help-topics/price-match-guarantee/pcmcat290300050002.c?id=pcmcat290300050002 (non-US visitors see a country splash; `&intl=nosplash` reaches the page)
- Displayed effective date: **2026-09-02**. Retrieved 2026-09-23 (browser text extraction).
- Program: own-price drop after purchase **during the return and exchange period** + competitor match **at the time of sale** only.
- Passage BB-1: "If we lower our in-store, online or app price during the return and exchange period, we will match our lower price, upon request."
- Passage BB-2: "One price match at the time of purchase, per identical item, per customer, at the current pre-tax price available to all customers is allowed."
- Identity: matching brand, model number and color; new product.
- Exclusions (summarized; see page): Marketplace products, clearance, refurbished, open-box; Qualified Competitor special daily/hourly sales and the Thursday before Thanksgiving through the Monday after; many offer types (bundles, gift-card offers, pricing errors, …). Puerto Rico stores have their own policy.
- Window depends on the **Return & Exchange Policy** (https://www.bestbuy.com/site/help-topics/return-exchange-policy/pcmcat260800050014.c?id=pcmcat260800050014; displayed effective date **2026-02-23**). Passage BB-3: "If you want to return or exchange your purchase, please know that the time period begins the day you receive your product and applies to new, clearance, open-box, refurbished and pre-owned products." Periods: most products **15 days** (Standard) / **60 days** (My Best Buy Plus™ and Total™ members); **activatable devices 14 days** for all (Verizon activatable devices 30 days).
- Evaluator facts: `received_at`, `membership_tier`, `product_category` (activatable device?).
- Temporal note: a purchase before 2026-09-02 → `source_unverified` unless an earlier version is captured.

### 7.2 Target — Price Match Guarantee (`R01.target.all_channels`, pack v1)

- URL: https://help.target.com/help/SubCategoryArticle?childcat=Price+Match+Guarantee&parentcat=Policies+%26+Guidelines
- Effective date: **not displayed**. Retrieved 2026-09-23.
- Program: own-price drop, **14 days**, anchored on the **purchase date**.
- Passage TG-1: "It may qualify for a price match if it's an eligible Target product, bought from Target today, or in the past 14 days."
- Comparison source: Target's own lower price on Target.com or the buyer's local Target store. The captured summary names no competitor matching. A store purchase cannot be matched to a different Target store's price.
- Identity: identical item, brand name, size, weight, color, quantity and model number.
- Exclusions (summarized): promotional Target GiftCard with the purchase or current offer; Registry completion or other Target coupons; clearance, closeout, liquidation, refurbished, typographical errors; "Other exclusions may apply" (full policy page linked but not captured → limitation).
- Proof: screenshots or pictures are not accepted.

### 7.3 Costco — Price Match, Costco.com orders (`R01.costco.online`, pack v1)

- URL: https://customerservice.costco.com/app/answers/detail/a_id/628/~/price-adjustment---costco.com-orders (page title now "Price Match - Costco.com Orders"). Effective date not displayed. Retrieved 2026-09-23.
- Passage CO-1: "For members other than resellers, purchases that reduce in price within 30 days of the date of purchase are eligible for a price match."
- Passage CO-2: "We reserve the right to deny a price match request at our sole discretion." → `discretion_clause = true`.
- Comparison source: Costco.com's own price; no competitors; warehouse prices are not matched for Costco.com purchases.
- Promotions: a request must be submitted within both the active promotional dates and 30 days of purchase; promotional item limits apply. Precious metals excluded.
- Remedy: credits "typically" to the original payment method within 5 to 10 business days (informational).
- Warehouse purchases: handled at the warehouse Returns counter; that policy was **not** captured → `R01.costco.store` = `unsupported`.

### 7.4 Apple — U.S. Retail Sales Policy, price protection (`R01.apple.retail_us`, pack v1)

- URL: https://www.apple.com/legal/sales-support/sales-policies/retail_us.html (redirect target of https://www.apple.com/shop/open/salespolicies). Effective date not displayed. Retrieved 2026-09-23 (curl, HTTP 200; SHA-256 of raw HTML 99bc751ea16bf7371b985f99ba04b2aff042f1e0004aadc41222c16bc41355d2).
- Passage AP-1: "Should Apple reduce the price on any Apple-branded product within 14 calendar days from the date you receive your product, visit an Apple Store location or contact Retail Customer Care at 1-800-MY-APPLE within 14 days of the price change to request a refund or credit of the difference in price. This excludes limited-time price reductions and special sales events, such as Black Friday."
- Two clocks: (1) the price reduction within **14 calendar days of receipt**; (2) the request within **14 days of the price change**. Apple-branded products only; limited to 10 units of a product; proof of possession may be required.
- Scope limitation: this is the **Retail** (Apple Store) policy. The Apple Online Store's own sales-policy page (`.../consumer_us.html`) returned 404, so online-store purchases → `source_unverified` until the online policy is captured.

### 7.5 The Home Depot — **source_blocked**

https://www.homedepot.com/c/price-match-and-price-check returned a bot-protection shell to both curl and the browser pane on 2026-09-23. A search-engine snippet claims a 30-day post-purchase adjustment; that is a **lead only**. No pack.

## 8. Relationship to other rules

- Merchant return window (not a separate R-number): can be an alternative to a price adjustment (return and rebuy). It is not additive.
- Card price protection: none of the captured card guides (TRIAGE R06–R08) includes price protection → not modeled.
- R03 does not apply to price drops (not a billing error).

## 9. Known limitations

- L1: Firecrawl snapshots in the existing flow are not yet versioned packs (no `effective_from`, no bracketing logic). Until migrated, legacy R01 results are capped at `likely_eligible_missing_evidence` with the purchase-date assumption (§1.4), or `source_unverified` where a displayed effective date postdates the purchase.
- L2: Membership tiers and product categories change the window (Best Buy) → ask only when the pack depends on them.
- L3: "Currently available" comparison offers must be observed at claim time. A price seen yesterday may not qualify (Hilton-style "available when we review" conditions appear in other merchants' programs too).
- L4: Merchants' full exclusion lists are longer than the captured summaries (Target "other exclusions may apply").

## 10. Document B corrections

1. B's detection rule, "monitor the merchant price until the policy window closes", assumes one window anchored at purchase. Captured policies anchor on **purchase** (Target, Costco) or **receipt** (Best Buy return period, Apple). Apple adds a second clock from the **price change**. Best Buy's window depends on **membership tier and product category** (14 days for activatable devices such as iPhones).
2. B asks for the "policy effective on the purchase date" — **agreed**, and more strictly: without a dated or bracketed capture, the result can never be `eligible`. It is `source_unverified` when the page's effective date postdates the purchase (the Best Buy page changed on 2026-09-02), and it is capped at "likely eligible" with an explicit assumption when no date is shown.
3. B implies a comparison against the "current price". Most captured programs match **only the merchant's own price** (Target, Costco, Apple). Best Buy matches competitors only **at the time of sale**. Its post-purchase adjustment covers only Best Buy's own lower price.
