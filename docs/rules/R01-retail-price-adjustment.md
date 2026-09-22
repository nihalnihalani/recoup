# R01 — Retail price adjustment (framework spec for merchant rule packs)

| Field | Value |
|---|---|
| Stable id | `R01.retail_price_adjustment` (framework). Merchant packs: `R01.<merchant_slug>.<channel>` (e.g., `R01.bestbuy.all_channels`) |
| Version | framework `v1` (resubmitted in M2D after the M09 review). Two tiers: **R01 v1** = legacy per-purchase policy-snapshot tier (contract rev 4 §2.7; fixtures `fixtures/R01.json`); **R01 v2** = reviewed merchant-pack tier (this spec §2–§7; fixtures `fixtures/R01v2.json`). Each merchant pack is versioned independently, one version per captured policy version. |
| Review status | **researched** (framework, both tiers, and the four sample packs below). Not `active`. |
| Authority class | **Merchant promise** (never "consumer law" — no general US legal duty to refund a later price drop) |
| Authority subtype | merchant published policy (price match / price adjustment / price protection) |
| Jurisdiction | United States; per merchant; per channel (store / online / app / marketplace); some merchants carve out Puerto Rico or specific states |
| Published / effective / compliance | Merchant pages have no publication or compliance dates. **Effective:** as displayed per pack (Best Buy PMG 2026-09-02; Best Buy returns 2026-02-23); Target, Costco and Apple display none. A pack's `effective_from` = the **latest** effective date among its constituent sources (§1.5). |
| Retrieval date | 2026-09-23 (sample packs) |
| Last verification date | 2026-09-23 |
| Refresh policy | v2 merchant packs: re-captured at least every **7 days** while any user has an open window with that merchant, and on every evaluation older than 24 h; a pack last verified more than 7 days ago → `source_unverified`. A changed `content_hash` creates a **new pack version**; it never rewrites the old one. v1 snapshot tier: see README rule 3 (freshness measured against the purchase; assumption only). |
| Reviewer | — (M09 reviewed the first submission and rejected it for resubmission; M09b re-check pending) |

Quotations from merchant pages are limited to ≤ 2 sentences each (copyright); follow the URL for the full text. Merchant texts are not stored in `sources/`; instead each quoted passage carries a reproducible **passage hash** and each pack a reproducible **content hash** (§2.1), so a reviewer can re-fetch and verify.

---

## 1. Why the current policy page is not proof of the purchase-date policy

1. **Policies change without notice to past buyers.** Best Buy's Price Match Guarantee page displays "Effective date: September 2, 2026" (retrieved 2026-09-23). A Best Buy purchase made on 2026-08-25 is governed by the **previous** version, which Recoup has not captured.
2. **Many pages show no effective date.** Target's, Costco's and Apple's pages captured today show none. A snapshot proves only what the page said **at retrieval time**.
3. **Merchants reserve the right to change the terms.** Costco: restrictions "will be shown at the point of purchase". Best Buy: "may amend these terms at any time".
4. **Therefore** a merchant pack version `V` may govern a purchase at time `p` only if one of these holds:
   - (a) `V.effective_from` is displayed and `V.effective_from ≤ p`, and no later version with `effective_from ≤ p` exists in the capture history; **or**
   - (b) there is a capture of `V` at `t1 ≤ p` **and** a capture with an identical `content_hash` at `t2 ≥ p` (bracketed; label as the assumption "unchanged between captures"); **or**
   - (c) the user provides the policy as shown at purchase (receipt text, order-confirmation terms, a dated screenshot), recorded as user evidence.
   - If none of (a)–(c) holds, two cases are kept apart:
     - **Known mismatch:** the captured version displays `effective_from` **after** `p`. The current page is affirmatively **not** the purchase-date policy → **`source_unverified`**, no amount, no automatic claim, and the next action **"ask anyway"** — a user-initiated request to the merchant, labelled "the merchant changed this policy after your purchase; we don't have the version that applied" (D143(1)).
     - **Unknown applicability:** no effective date is displayed and no bracketing capture exists → outcome **capped at `likely_eligible_missing_evidence`** (contract `likely_eligible`), with the assumption "the current policy text is assumed to be the one in effect on <purchase date>" and the missing fact `retail.policy_confirmed`. It is **never** `eligible`.
5. **Multi-document packs.** When a pack draws on more than one merchant document (Best Buy: the Price Match Guarantee **and** the Return & Exchange Policy), `effective_from` = the **latest** displayed effective date among them, and any constituent with an unknown effective date makes the pack's applicability unknown for §1.4 purposes.

## 2. What a merchant rule pack must record

| Field | Type | Notes |
|---|---|---|
| `merchant_id`, `merchant_display_name` | string | legal seller; marketplace sellers are separate merchants |
| `channel_scope` | enum[] | `store`, `online`, `app`, `phone`; marketplace excluded unless the policy says otherwise |
| `policy_urls` | URL[] | every constituent document, canonical + observed redirect target |
| `captured_at` | datetime | retrieval instant |
| `content_hash` | sha256 | of the **normalized section text** (§2.1) — the change detector |
| `raw_response_sha256` | sha256 \| null | provenance only; **never** used for change detection (raw HTML carries nonces and changes when the text does not) |
| `captured_passages` | {id, text ≤ 2 sentences, passage_hash} | the exact passages the evaluator relies on |
| `effective_from` | date \| `unknown` | as displayed; max over constituents (§1.5) |
| `superseded_by` | pack version \| null | set when a later capture differs |
| `program_type` | enum | `own_price_drop` \| `competitor_match_at_sale` \| `competitor_match_post_sale` \| `price_protection` |
| `window` | {length, unit (`calendar_days` \| `days_unspecified` \| `return_period`), anchor (`purchase_date` \| `receipt_date` \| `price_change_date`), inclusive: bool, **`constrains`** (`price_change` \| `request` \| `both`), passage_id} | **which event must fall inside the window** (M09 R01.4). Two-clock policies list two windows. |
| `window_dependencies` | enum[] | `membership_tier`, `product_category` (e.g., activatable devices), `promotion_dates` |
| `comparison_price_source` | enum[] | `same_merchant_same_channel`, `same_merchant_any_channel`, `named_competitors`, `specific_store_only`, `target_dot_com_only` |
| `identity_match_requirements` | enum[] | `brand`, `model_number`, `color`, `size`, `weight`, `quantity`, `condition_new`, `sku` |
| `quantity_limit` | integer \| null | e.g., Apple 10 units; Costco promotional limits |
| `eligible_buyer` | enum[] | e.g., Costco `non_reseller_member` |
| `exclusions` | enum[] + passage ids | clearance, open-box, refurbished, marketplace, limited-time events, Black Friday week, coupons, gift-card promos, membership pricing, typographical errors, precious metals, … |
| `request_channel` | enum + detail | chat, phone, form, in-store counter |
| `remedy_form` | enum | `refund_original_payment` \| `credit` \| `gift_card` \| `unspecified` |
| `discretion_clause` | boolean + passage id | "sole discretion" → never a guaranteed amount; UI says "merchant decides" |
| `proof_requirements` | enum[] | receipt, live price page (screenshots refused by Target), order number, possession (Apple) |
| `calendar_zone` | string | zone that defines a calendar day (D147(4)); default assumption: the buyer's local date (store location for in-store purchases, ship-to address for online) |
| `jurisdiction_carveouts` | string[] | e.g., Puerto Rico |

### 2.1 Reproducible hashes

- **`content_hash`**: fetch each URL (HTTP GET, follow redirects); drop `<script>`, `<style>`, `<noscript>`, `<svg>` elements; replace every other tag with a space; decode HTML entities; Unicode NFC; collapse every whitespace run to one space; cut from the first occurrence of the pack's `section_start` marker (inclusive) to the next `section_end` marker (exclusive); SHA-256 of the UTF-8 bytes.
- **`passage_hash`**: SHA-256 of the passage text exactly as quoted, NFC and whitespace-collapsed.
- Verified 2026-09-23: two independent curl fetches gave identical `content_hash` values for Apple, Costco and Target (below). The Apple **raw** HTML hash in the first submission is kept only as provenance.

## 3. Facts the evaluator needs (typed)

| Fact | Type | Source of truth | Decisive? |
|---|---|---|---|
| `merchant_id`, `channel` | string, enum | receipt / order confirmation | yes |
| `purchase_at` | datetime | receipt | yes |
| `received_at` | datetime \| unknown | delivery confirmation / pickup record | yes where a window anchors on receipt |
| `request_at` | datetime \| unknown | the user's request to the merchant (planned or made) | yes where `constrains ∈ {request, both}` |
| `price_change_at` | datetime \| unknown | first observation of the lower price (or the merchant's announced change) | yes where `constrains ∈ {price_change, both}` |
| `item_identity` | {brand, model_number, sku, variant: color/size/capacity, condition} | receipt + product page (never inferred from a similar title) | yes |
| `quantity` | integer | receipt | yes (amount) |
| `unit_price_paid` | money (minor + currency) | receipt (pre-tax, net of item-level discounts) | yes (amount) |
| `comparison_offer` | {price (minor + currency), source (merchant/channel/store/URL), observed_at, availability, clearance/open_box/limited_time flags, evidence id} | an accepted Firecrawl observation (`observed`) or a user-confirmed offer | yes |
| `purchase_store_id`, `comparison_store_id` | string \| null | receipt; offer source | Target store purchases |
| `membership_tier` | enum \| unknown | user (only when the pack depends on it) | Best Buy |
| `product_category` | enum \| unknown | receipt / product page | Best Buy (activatable devices) |
| `buyer_is_reseller` | boolean \| unknown | user | Costco (CO-1) |
| `target_plus_partner_item` | boolean \| unknown | order confirmation (seller shown as a Target Plus Partner) | Target (TG-2) |
| `prior_adjustments` | money[] | receipts / statements | amount |

ShopSavvy or any price-history service is **context only** and never independently authorizes a claim or an alert (mission §10). D147(2): `eligible` requires every decisive fact to be `user_confirmed`, or `observed`/`derived` from confirmed or observed facts; otherwise the outcome is capped at `likely_eligible_missing_evidence`.

## 4. Calculation

`difference_per_unit = unit_price_paid − comparison_price` (same currency; pre-tax unless the policy says otherwise). If ≤ 0 → no opportunity.
`eligible_units = min(quantity, quantity_limit ?? quantity)`.
`estimate = difference_per_unit × eligible_units − prior_adjustments`.
Example (mission §17): 2 units at 12,000 with an eligible matching price of 9,500 → 2 × 2,500 = **5,000**. Wrong variant, wrong currency, or an unverified purchase-date policy → **no** price claim (`not_eligible` or `source_unverified`, never a number). A `discretion_clause` pack shows the estimate labelled "merchant decides", never as a guaranteed amount.

## 5. Deadline semantics

- Each window: end = `anchor + length` in the pack's unit, in the pack's `calendar_zone`; inclusive/exclusive recorded per pack. If the merchant does not state it → **assumption:** inclusive of the last day on the buyer's local calendar.
- `constrains` decides which event is tested: `price_change` → `price_change_at` must fall inside the window (the request may come later, subject to any other window); `request` → `request_at` must fall inside; `both` → both.
- Two-clock policies (Apple): **both** windows must hold — (1) `price_change_at` within 14 calendar days of `received_at`; (2) `request_at` within 14 days of `price_change_at`.
- An expired window closes this path only (`deadline_passed`); a window whose tested event has not happened yet is not a failure.
- R01 v1 (legacy snapshot tier) keeps the legacy 24-hour-multiple instant semantics instead (contract HC-11/O15; `fixtures/R01.json`).

## 6. Outcomes

- `eligible` — identity match confirmed; purchase-date policy verified per §1.4 (a)–(c); every applicable window satisfied; comparison offer eligible and currently observed; every decisive fact confirmed (§3).
- `likely_eligible_missing_evidence` — e.g., receipt missing; a decisive fact only extracted; or purchase-date applicability unknown (§1.4 "unknown applicability").
- `needs_facts` — e.g., `received_at` for a receipt-anchored window; `membership_tier`; `request_at` for a request-constrained window.
- `source_unverified` — the merchant **has** a pack, but not for this channel or version: channel not captured (Apple online store; Costco warehouse), pack stale (> 7 days), or a known effective-date mismatch (§1.4, with "ask anyway").
- `unsupported` — the merchant has **no pack at all** (e.g., The Home Depot).
- `not_eligible` — excluded offer or item, identity mismatch, price drop outside a `price_change` window, reseller where the pack excludes resellers, cross-store comparison where the pack forbids it, no price difference.
- `deadline_passed` — a `request` window closed before the request.
- (Resolves the first submission's §6 contradiction: "no pack at all" is `unsupported`; "pack exists but not for this channel/version, or stale" is `source_unverified`.)

## 7. Sample merchant packs verified 2026-09-23

### 7.1 Best Buy — Price Match Guarantee (`R01.bestbuy.all_channels`, pack v1)

- URLs: https://www.bestbuy.com/site/help-topics/price-match-guarantee/pcmcat290300050002.c?id=pcmcat290300050002 and the Return & Exchange Policy https://www.bestbuy.com/site/help-topics/return-exchange-policy/pcmcat260800050014.c?id=pcmcat260800050014 (non-US visitors see a country splash; `&intl=nosplash` reaches the page). Retrieved 2026-09-23 by browser text extraction (curl is bot-walled) → **lower assurance**: passage hashes only, no reproducible `content_hash`.
- Displayed effective dates: PMG **2026-09-02**, returns **2026-02-23** → pack `effective_from` = **2026-09-02** (§1.5).
- Program: own-price drop after purchase **during the return and exchange period**, plus competitor match **at the time of sale** only.
- Passage BB-1 (passage_hash `aabf2ce5…586d9a`): "If we lower our in-store, online or app price during the return and exchange period, we will match our lower price, upon request."
- Passage BB-2 (`045d49b0…a4b40b`): "One price match at the time of purchase, per identical item, per customer, at the current pre-tax price available to all customers is allowed."
- Passage BB-3 (`970f0ccd…4adb9a`): "If you want to return or exchange your purchase, please know that the time period begins the day you receive your product and applies to new, clearance, open-box, refurbished and pre-owned products."
- **Window:** return period anchored on `received_at`; **`constrains: price_change`** (BB-1 limits when the price is **lowered**). The request timing is not stated ("upon request"); Recoup asks the user to request promptly (assumption, not a rule). Periods: most products **15 days** (Standard) / **60 days** (My Best Buy Plus™ and Total™ members); **activatable devices 14 days** for all (Verizon activatable devices 30 days).
- Identity: matching brand, model number and color; new product. Exclusions (summarized; see page): Marketplace products, clearance, refurbished, open-box; many offer types. Puerto Rico stores have their own policy.
- Evaluator facts: `received_at`, `price_change_at`, `membership_tier`, `product_category`.
- Temporal: a purchase before 2026-09-02 → known mismatch → `source_unverified` + "ask anyway".

### 7.2 Target — Price Match Guarantee (`R01.target.all_channels`, pack v1)

- URL: https://help.target.com/help/SubCategoryArticle?childcat=Price+Match+Guarantee&parentcat=Policies+%26+Guidelines. Effective date **not displayed**. Retrieved 2026-09-23.
- `content_hash` **9cc32d9c6c333b26fc9b5654ea5e5a92a6f66000bf74b71e27c28f39e035ee81** (section "It may qualify for a price match if..." → "Was this information helpful?"; identical on two fetches).
- Passage TG-1 (`19fc316e…b8f06ccd`): "It may qualify for a price match if it's an eligible Target product, bought from Target today, or in the past 14 days."
- Passage TG-2 (`298aa788…dc3999caa2`) — **Target Plus Partner items**: "It may qualify for a price match if it's an eligible Target Plus product, bought from a Target Plus Partner today, or in the past 14 days. It must be the identical item, purchased from a Target Plus Partner, brand name, size, weight, color, quantity and model number, and the price is now lower from Target.com."
- Passage TG-3 (`85d8936f…2b286b9a`) — cross-store exclusion: "If you bought it in a Target store, and the lower price is from a different Target store."
- **Window:** 14 days anchored on `purchase_at`; **`constrains: request`** ("bought … today, or in the past 14 days" is tested at the time of the request). Target items: comparison = Target.com or the buyer's local Target store (not a different Target store). Target Plus Partner items: comparison = **Target.com only** (TG-2).
- Identity: identical item, brand name, size, weight, color, quantity and model number. Exclusions (summarized): promotional Target GiftCard; Registry completion or other Target coupons; clearance, closeout, liquidation, refurbished, typographical errors; "Other exclusions may apply" (full policy page not captured → L4). Proof: screenshots not accepted.

### 7.3 Costco — Price Match, Costco.com orders (`R01.costco.online`, pack v1)

- URL: https://customerservice.costco.com/app/answers/detail/a_id/628/~/price-adjustment---costco.com-orders (page title "Price Match - Costco.com Orders"). Effective date not displayed. Retrieved 2026-09-23.
- `content_hash` **02f32d906b5d83c08693dd32f8fad4407b539ba8f7e852d1528b1ee3792eab95** (section "Please read the following to understand what purchases may be eligible for a price match" → "How to Request a Price Match"; identical on two fetches).
- Passage CO-1 (`e9098b0d…8fcff49e7`): "For members other than resellers, purchases that reduce in price within 30 days of the date of purchase are eligible for a price match." → `eligible_buyer: non_reseller_member`; fact `buyer_is_reseller`.
- Passage CO-2 (`2d62b24f…5da469`): "We reserve the right to deny a price match request at our sole discretion." → `discretion_clause = true`.
- Passage CO-3 (`299c753d…1c17c999`): "Items with specific sale dates (e.g., Holiday Savings Promotions): A price match request must be submitted within both the active promotional dates and 30 days of the purchase date."
- **Window:** 30 days from `purchase_at`; **`constrains: price_change`** (CO-1); for items with specific sale dates also **`request`** within the promotion dates and 30 days (CO-3) → `both`.
- Comparison: Costco.com's own price; no competitors; warehouse prices not matched for Costco.com purchases. Precious metals excluded. Remedy: credits "typically" within 5 to 10 business days (informational).
- Warehouse purchases: a separate channel whose policy was **not** captured → `source_unverified` (§6), not `unsupported`.

### 7.4 Apple — U.S. Retail Sales Policy, price protection (`R01.apple.retail_us`, pack v1)

- URL: https://www.apple.com/legal/sales-support/sales-policies/retail_us.html (redirect target of https://www.apple.com/shop/open/salespolicies). Effective date not displayed. Retrieved 2026-09-23.
- `content_hash` **2a44c2f69131c1c58d635fd44ade672e3d88f447f5964273de2597fb13415bb9** (section "Pricing and Price Reductions/Corrections" → "Order Acceptance/Confirmation"; identical on two fetches). Raw-HTML SHA-256 `99bc751e…55d2` kept as provenance only (M09 found the raw hash is not reproducible).
- Passage AP-1 (`7b90910b…a473e2362`): "Should Apple reduce the price on any Apple-branded product within 14 calendar days from the date you receive your product, visit an Apple Store location or contact Retail Customer Care at 1-800-MY-APPLE within 14 days of the price change to request a refund or credit of the difference in price. This excludes limited-time price reductions and special sales events, such as Black Friday."
- Passage AP-2 (`86efde27…2e`): "Price protection is limited to 10 units of a particular product and we may require that you have the product with you and/or have proof of possession to use it."
- **Windows:** (1) 14 calendar days from `received_at`, **`constrains: price_change`**; (2) 14 days from `price_change_at`, **`constrains: request`** → overall `both`. Boundary assumption: "within 14 … days from" includes day 14 (received 09-01 → through 09-15).
- Apple-branded products only; `quantity_limit` 10.
- Scope: this is the **Retail** (Apple Store) policy. The Apple Online Store's sales-policy page (`.../consumer_us.html`) returned 404 → online-store purchases are the Apple pack's **uncaptured channel** → `source_unverified` (§6).

### 7.5 The Home Depot — no pack

https://www.homedepot.com/c/price-match-and-price-check returned a bot-protection shell to both curl and the browser pane on 2026-09-23. A search-engine snippet claims a 30-day post-purchase adjustment; that is a **lead only**. No pack → `unsupported` (§6).

## 8. Relationship to other rules

- Merchant return window (not a separate R-number): an alternative to a price adjustment (return and rebuy). Not additive.
- Card price protection: none of the captured card guides (TRIAGE R06–R08) includes price protection → not modelled.
- R03 does not apply to price drops (not a billing error).

## 9. Known limitations

- L1: The legacy Firecrawl snapshots (R01 v1 tier) are not versioned packs. That tier follows contract rev 4 §2.7: best outcome `likely_eligible`, freshness measured against the purchase (README rule 3), 24-hour-multiple windows (`fixtures/R01.json`).
- L2: Membership tiers and product categories change the window (Best Buy) → ask only when the pack depends on them.
- L3: "Currently available" comparison offers must be observed at claim time.
- L4: Merchants' full exclusion lists are longer than the captured summaries (Target "other exclusions may apply").
- L5: Best Buy's pages are browser-captured (curl blocked): passage hashes only, lower assurance than a reproducible capture.
- L6: Best Buy's request timing is not stated; Recoup does not invent a request deadline for it.

## 10. Document B corrections

1. B's detection rule, "monitor the merchant price until the policy window closes", assumes one window anchored at purchase. Captured policies anchor on **purchase** (Target, Costco) or **receipt** (Best Buy return period, Apple), and constrain different events: Best Buy and Costco the **price drop**, Target the **request**, Apple **both** (drop within 14 days of receipt; request within 14 days of the drop).
2. B asks for the "policy effective on the purchase date" — **agreed**, and more strictly: without a dated or bracketed capture the result can never be `eligible`. It is `source_unverified` (+ "ask anyway") when the page's effective date postdates the purchase (Best Buy changed on 2026-09-02), and capped at "likely eligible" with an explicit assumption when no date is shown.
3. B implies a comparison against the "current price". Most captured programs match **only the merchant's own price** (Target, Costco, Apple; Target Plus items only Target.com). Best Buy matches competitors only **at the time of sale**; its post-purchase adjustment covers only Best Buy's own lower price.
