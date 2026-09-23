# Recoup

Price dropped after you bought? Recoup checks the store's own price-adjustment policy and helps you ask for the difference. Haven't bought yet? It watches the price at the stores you add and tells you when it falls.

Recoup checks supported recovery paths. Today that means a lower price inside a store's own price-adjustment window. This check is tested; live verification is still pending.

- **Status:** Recoup runs on this repo's dev deployment only (`adorable-lion-138`), with placeholder provider keys. Deploying to production is not authorized in the current mission (`docs/team/DECISIONS.md` D191); a production deployment named in older docs, `cool-oyster-399`, is not claimed to be current. The build log below is historical: it records what was actually run against real providers and when, rather than a single blanket "live" claim.
- There is no billing, no pricing and no paid plan. Recoup is not a law firm, does not represent you, and never promises that money will come back.
- Demo video: TODO (placeholder, not recorded yet; under three minutes)

## What it does

Recoup is about one thing: the price of something you care about, before and after you buy it.

**Before you buy.** Paste a product link on the Watching page, with a target price if you have one. Recoup reads the page, stores the price with its source link and the time it was read, and checks again about every two hours and whenever you press "check now". Each watched item carries a one-line verdict: good price, fair, wait, or discount looks inflated, with one sentence of why. The verdict is a pure function over Recoup's own stored observations plus the "was" price the page claims (`convex/lib/verdict.ts`). With fewer than three observations or less than a week of history it says "not enough history yet" instead of guessing.

**After you buy.** If the store lowers the price inside its own price-adjustment window, Recoup opens a claim for the exact difference and helps you ask for it. The store decides: its policy is its own promise, not a law, and the amount is an estimate until the money arrives.

1. **Intake.** Paste an order confirmation, or forward it to your own Recoup inbox address. The order is extracted into a purchase with line items (name, unit price, quantity, product URL). Every extracted purchase starts as `needs_review`; nothing is active until you confirm it.
2. **Policy.** On confirmation, Recoup searches the store's own site for its price-adjustment policy, scrapes the page, and stores a snapshot: window length, contact channel, contact email, the supporting sentence, the source URL and the retrieval time. The sentence is kept only if it is found verbatim in the scraped page.
3. **Price watch.** Product pages of items whose window is still open are checked every two hours and on "check now". A claim opens only when the observed price is a single price in the purchase currency, the variant matches, the extraction confidence is at least 0.7, and the drop is at least the greater of 100 cents or 2 percent. The price dashboard shows paid price, latest price, history chart and the days left in the window for every tracked item.
4. **Ask.** Recoup drafts a short message that names the order, the item, the amount and the policy sentence. You edit it, confirm the recipient and approve. The message goes out from your Recoup inbox. If the store's channel is a form, chat or phone, the same content is shown as a copyable packet instead.
5. **Reply.** Replies are routed back to the claim and classified as promise, credit issued, refusal, question or other. A promise moves the claim to `promised`. It never counts as money received.
6. **Confirm.** Only you confirming a posted credit writes a `confirmed_credit` event. When confirmed credits cover the expected amount, the claim is `confirmed`. A later charge reopens that one claim without touching its history.

At submission time the board showed three totals: unresolved, asked and confirmed. Since Mission 2 the dashboard reads one per-currency recovery summary instead: recovered (confirmed by you), then potential ("estimated, not guaranteed"), ready to ask, sending or unknown, asked, refused and promised, with provisional credit shown inside its step. Each loss counts once, alternatives for the same loss are never added together, and currencies are never summed. Example records are labelled and excluded from the totals.

### Since the submission

- **Price-drop email, "I bought it" and the same item at other stores** are in the UI and were exercised live on the dev deployment on 2026-09-20 (see the build log).
- **Returns.** A refund email for a returned item is held until you confirm it with one tap, because an email's sender cannot be verified. Once confirmed, it is recorded as a promised refund on a return-credit claim. It counts as money back only when you confirm it arrived.
- **Mission 2: transactions and recovery paths.** Every purchase is also a transaction with facts (each labelled confirmed, observed, read from a document but not confirmed, or disputed), stored evidence, and recovery opportunities evaluated by versioned rule packs. Only an active pack produces a card, and the pages list the paths that were not checked. Flights and card charges can be entered by hand; no recovery path is checked for them until their packs are activated. Uploaded documents are stored, not read, while live reading is switched off.

### Not in the product today

- Recovery paths other than the store price adjustment above. Code packs for late online orders (R05), airline refunds (R02) and delayed, lost or damaged bags (R04) exist but are not active; the rest of the mission's 25 paths are not checked.
- Automatic reading of uploaded documents (switched off, D145).
- No production deployment, no billing and no paid plan.

## What Recoup promises

- No affiliate links and no sponsored ranking.
- You approve every message before it is sent. Recoup never files claims in bulk.
- Money only counts when you confirm it arrived.
- Every price shows where and when it was read. Every policy shows the exact sentence it came from.

Earlier tools in this category filed claims at scale without the customer in the loop, and stores and card issuers responded by tightening the benefits. Recoup sends one message per claim, approved by a person, stated in the store's own policy words.

## Stack and what each sponsor does in the app

**Convex** is the whole backend.
- Database: the application tables in `convex/schema.ts` plus the Convex Auth tables. The table list below is the submission-time set; Mission 2 added `transactions`, `facts`, `incidents`, `evidence`, `opportunities`, `evaluations` and `nonCashRemedies`.
- Functions: queries, mutations and actions for purchases, claims, policies, drafts, replies, intake, price watch, watches, the price dashboard, profiles and follow-ups. Money arithmetic happens only in mutations, in integer minor units.
- Crons (`convex/crons.ts` is the source of truth; at submission there were five jobs): `price watch` every 2 hours (owned-item price reads), `watch sweep` hourly, `retry failed inbound` hourly (re-runs failed inbound processing that still has attempts left), `mail sweep` hourly (re-drives stalled outbound mail), and `retention sweep` daily (D75: prunes/redacts aged rows in bounded, resumable pages — see `convex/retention.ts`). The watch sweep is bounded: it reads one indexed page of at most 50 due watches (`by_status_nextCheck`), staggers the checks, and a tick with nothing due costs one indexed read. Each watch carries its own `nextCheckAt`, two hours after its last check. Spend is capped in `convex/limits.ts`: 50 watches per user, 20 new watches per hour, a ten-minute cooldown on manual checks, plus deployment-wide daily kill switches an operator can pause on demand (`docs/ops/RUNBOOK.md` §1).
- Scheduler: inbound event processing, send reconciliation with backoff (30s, 60s, 120s, 300s, 600s), reminder follow-ups, on-demand price checks.
- Auth: Convex Auth with the Password provider. Identity always comes from `ctx.auth`, never from an argument.
- HTTP actions: auth routes and the AgentMail webhook at `/agentmail/webhook` (`convex/http.ts`).
- Static hosting: `@convex-dev/static-hosting` serves the built React app from the same deployment on `convex.site`, registered as the last catch-all route.
- Components: `@agentmail/convex`, `@firecrawl/firecrawl-convex`, `@convex-dev/static-hosting` (`convex/convex.config.ts`).

**OpenAI** (`gpt-5.6-terra`, one constant in `convex/lib/ai.ts`) does structured output against strict zod schemas (`convex/lib/schemas.ts`):
- extraction of order emails into purchases and items,
- extraction of the current price from a product page, with range and variant-match flags and the list ("was") price the page claims,
- extraction of policy terms and the supporting passage from a scraped page,
- classification of store replies,
- drafting of the request message.
All model output is proposed data. The verdict is computed from stored numbers and is never model output. The user confirms what the model proposes, and no model output moves money in the ledger on its own.

**Firecrawl** (`@firecrawl/firecrawl-convex`):
- search, restricted to the store's domain, to find the price-adjustment policy page, and scrape of that page for the policy text (`convex/policies.ts`),
- scrape of product pages for price reads, shared by owned items and watches (`convex/priceWatch.ts`, `convex/watches.ts`),
- web search and scrape for the same item at other stores (`convex/offers.ts`; written, not yet run live).

**AgentMail** (`@agentmail/convex`):
- one inbox per user, created on demand (`convex/profiles.ts`),
- outbound send of the approved claim email through the component's queued send (`convex/drafts.ts`),
- inbound webhook, signature-verified by the component, routed to intake or to a claim's reply thread (`convex/inbound.ts`, `convex/intake.ts`, `convex/replies.ts`),
- price-drop alerts to the account address from the user's own Recoup inbox (`convex/notify.ts`; written, not yet run live).

Frontend: React 19, Vite, TypeScript, Tailwind 4, React Router. Pages: Board (dashboard), Add, Transaction, Recovery paths, Watching, Purchase, Claim, Settings, Privacy, SignIn.

## Architecture

### Tables

| Table | Purpose |
|---|---|
| `profiles` | One AgentMail inbox per user; inbound mail is routed to a user by inbox id |
| `purchases` | The case. Status `needs_review`, `active` or `archived` |
| `items` | Line items: name, unit price, quantity, product URL |
| `policies` | Immutable policy snapshots. A refresh inserts a new row; claims keep the snapshot they were opened against |
| `priceChecks` | One observation of an owned item's product page. No usable price means no `observedCents` and a note |
| `watches` | A product the user has not bought yet: link, optional target price, status, `nextCheckAt` for the sweep |
| `watchChecks` | One observation of a watched page, including the page's claimed "was" price |
| `mailLog` | Notification mail to the account holder, claimed by a unique dedupe key before any send (drop email, not yet run live) |
| `offers` | The same product at another store; only user-confirmed offers are re-checked or ranked (not yet run live) |
| `claims` | What was asked of the store on one item, for one reason. The product opens `price_adjustment` and, from confirmed refund emails, `return_credit` claims |
| `ledgerEvents` | Append-only money facts: `promised_credit`, `confirmed_credit`, `later_debit` |
| `claimNotes` | Non-monetary audit trail: notes, status changes, expected-amount changes |
| `drafts` | Versioned outbound messages; approval is bound to a claim version |
| `replies` | Classified store replies, deduplicated by message id |
| `followUps` | Scheduled reminders |
| `processedEvents` | Idempotency and retry state for inbound webhooks and pastes |

Threads and messages themselves live in the AgentMail component's tables.

### Claim state machine

`detected` → `drafted` → `queued` → `sent` → `promised` → `confirmed`

Side states: `packet` (merchant has no email channel; the user sends the packet themselves), `reopened` (a later debit landed on a confirmed claim), `dismissed`.

- `queued` means the send was handed to the mail component. The claim becomes `sent` only after the component reports a message id. A failed, bounced or rejected send returns the claim to `drafted` with the error on the draft. If the outcome is still unknown after five checks, the claim stays `queued` and the UI says delivery is unknown.
- `promised` comes from a classified reply. `confirmed` comes only from user-confirmed credit that covers the expected amount.

### Ledger

`ledgerEvents` is append-only. The balance of a claim is derived in a query and never stored (`convex/lib/ledger.ts`, `convex/lib/balance.ts`):

`unresolved = expected - sum(confirmed_credit) + sum(later_debit)`

Promised amounts are shown separately (the latest stated promise, not a sum) and never reduce `unresolved`. Over-credit is shown as over-credit, not clamped away. Changes to the expected amount are written to `claimNotes`, not to the ledger.

### Invariants enforced in mutations

1. Every query and mutation resolves the user from `ctx.auth` and checks ownership of the purchase, item, claim, policy or draft it touches (`convex/lib/access.ts`). Related ids are re-checked against each other (item belongs to purchase, policy belongs to the same merchant, price check belongs to the item).
2. A `promised_credit` never changes `unresolved`.
3. Only a user action creates a `confirmed_credit`. A reply that says "refund issued" results in `promised` only.
4. User-entered ledger writes (confirm credit, later debit) require an idempotency key; a replay with the same key is a no-op. Inbound events are deduplicated by external id with a status, so a failed downstream step can be retried instead of being swallowed.
5. A claim's expected amount changes only through an explicit user action, which bumps the claim version. Draft approval is bound to recipient, subject, body, draft version and claim version; a stale approval cannot send.
6. A draft that already has an outbound id cannot be sent again.
7. No email goes to an address unless it came from a policy snapshot the user confirmed, or the user ticked "I confirm this recipient".
8. A later debit reopens that claim by appending an event; earlier ledger events are never edited. A dismissed claim accepts no further ledger events.
9. At most one open claim per item, including when the cron and "check now" overlap. A new one can be opened only after the previous one is confirmed or dismissed.
10. A watch check that is rejected or fails is still stored as a row with a note and no price, so a stale price is never shown as current. Unconfirmed other-store offers never drive a verdict or an alert.
11. Amounts are non-negative safe integers in minor units with a three-letter currency code; timestamps and window lengths are range-checked at the boundary.

## Build log

Status source: `docs/team/PLAN.md`. Test counts: `docs/team/VERIFICATION.md`.

### 2026-09-20, late: the price dashboard

- W2, W3 and W4 passed live: a drop email went out once through AgentMail and was deduplicated per watch and price; "Find other stores" on a stand mixer returned Best Buy, Amazon, KitchenAid and Walmart listings, with Walmart flagged as possibly a different version, and confirming Amazon produced "Cheapest confirmed: amazon.com at $479.00"; "I bought it" turned a watch into a purchase with its price history and a 14-day window counting down.
- The UI was rebuilt around prices. The dashboard shows a price chart per product, an overview with a Watching and Bought toggle, a products table with low-to-high range bars and adjustment-window meters, a stores card, a live activity feed, and a strip of every open adjustment window. The Watching page shows a large chart per product with lowest, highest, average and swing, a verdict chip, and the same item compared across stores. Charts are hand-written SVG with no chart library.
- Two read models feed it, both derived on read from rows that already exist: `insights.activity` (price drops and rises with signed changes, unreadable pages, alerts sent, claims opened, asks sent, replies, credits promised and confirmed) and `insights.sources` (per store: what is watched there, how many checks ran, how many pages could actually be read, drops caught, last check). An unchanged price is not an event; the chart already shows it.
- The stores card reports readability honestly: a store where pages cannot be read shows a low read rate, and marketplaces carry a note that prices belong to individual listings. Store icons are loaded from the store's own domain only, never a third-party icon service, so nobody else learns which stores a user watches.
- Price checks now run every two hours for owned items and watches. Charts contain only prices the app actually read; history starts the day watching starts. The one seeded history belongs to the example product and is labelled as an example.
- The other team's later commits were merged into this branch. Where both sides had written the same module, the version that had been exercised live was kept.

### 2026-09-20, evening: what passed live

Source: the status log at the bottom of `docs/plans/2026-09-20-recoup-iterations.md`. "Live" means against the real providers on the dev deployment, not in tests.

- Direction change: the product is about price, before and after you buy.
- I0 passed: sign-up, sign-in, empty Board, inbox created.
- I1 passed locally: example records load and a claim can be confirmed by hand. The static site is served from `earnest-setter-354.convex.site` with the single-page fallback checked by curl; a signed-in recheck on the public URL is still pending.
- I2 passed: real OpenAI extraction from pasted Best Buy and Target orders got store, domain, order reference, date, items, cents and product URL right.
- I3 passed: Target's policy came back with verbatim passages at 0.99 and 0.93 confidence and a 14-day window.
- I6 passed: a real Target product page read $499.99 against $549.99 paid, a claim opened for $50.00 with a countdown, and the Board showed $50.00 owed. A wrong product URL correctly reported that the page does not price this product.
- I4 passed: a real email went through AgentMail from the user's Recoup inbox to a controlled inbox; the claim went `queued` then `sent` and a reminder was scheduled.
- I5 passed: a reply from the controlled inbox arrived by webhook, was routed to the right claim and classified as a promise of $50.00; the claim became `promised` with $50.00 still unresolved. Confirming the credit moved it to `confirmed`, unresolved $0.00, reminder cancelled.
- W1 and W1b passed: a real Target product link pasted on the Watching page read the name and $499.99, stored a $449.99 target, and showed "Not enough history yet" with a plain reason. Backend: `watches` and `watchChecks`, bounded hourly sweep, per-watch cooldown and per-user caps, pure `lib/verdict.ts`; 336 tests at that point.
- Bugs found only by running live:
  - The AgentMail component could not see `AGENTMAIL_API_KEY`, because the component runs in an isolated runtime and version 0.1.0 declares no env. Fixed with a patch-package patch that binds the key into the component. The component's own retry then delivered the queued message.
  - Best Buy serves Firecrawl a region splash page instead of the policy. The policy correctly lands as unknown and the note now says why.
  - Domain normalisation: `www.bestbuy.com` on a purchase did not match `bestbuy.com` on a policy, so no policy card appeared and opening a claim failed. Domains are now normalised when a purchase is created and confirmed.
  - After sign-up the page needed a reload to leave the sign-in screen; noted for recheck.
- Found by a read-only backend review and fixed with tests before the live reply run: a From header with a display name produced a broken sender domain, which would have flagged every real reply as a sender mismatch.
- Next: drop email, "I bought it", other-store offers, then submission (I7, not started).

### 2026-09-20, earlier

- Design and implementation plan written (`docs/plans/`). Architecture review decisions recorded as D01 to D49 in `docs/team/DECISIONS.md`.
- T01 scaffold and Convex project: verified.
- T02 components (AgentMail, Firecrawl, static hosting), Convex Auth, HTTP router: verified.
- T03 final schema, pure ledger and money libraries, test harness: verified.
- T04 ownership helpers, purchases and items: in review.
- T05 claims, ledger events, notes: in review.
- T06 zod schemas and OpenAI helper: verified, tested without network.
- T07 inbox provisioning, inbound routing, intake: in progress.
- T08 policy research with Firecrawl: verified locally; the live path had not been exercised at the time of writing.
- T09 price watch cron and check-now: in progress.
- T10 drafts, approved send, reply classification, reminders: code and tests are in the repo; not yet verified in the plan.
- T11 frontend: shell and routing verified; flows in progress.
- T12 example loader: in progress. The schema carries `isExample` and board totals exclude example records; the loader itself is not in the repo yet.
- A teammate's branch with reworked purchases, claims, policies and access helpers was merged, and the remaining modules are being aligned to it.
- Not started or blocked: T13 hardening pass, T14 deploy to `convex.site`, T15 video, T16 submission.

## Honest limits
- Email verification is mandatory, not a suggestion. A new account cannot sign in until its address is verified by code, and an existing account created before this requirement verifies at its next sign-in; price-drop alerts are suppressed, with a visible reason in Settings, until that happens (`docs/team/DECISIONS.md` D83 item 2).
- Price-drop alert emails default to **on** for a verified account (an opt-out setting, not opt-in) — turn them off on the Settings page. Whatever that setting says, an address that is unverified, deleted, or has bounced/complained never receives one: the send-time gate (`convex/lib/accountState.ts`'s `alertGate`) checks verification and suppression state every time, not only when the setting was last changed.
- Every feature that depends on a provider key fails closed when that key is missing, not silently or with a crash: OpenAI extraction/classification/drafting, Firecrawl policy and price reads, ShopSavvy market history, and AgentMail send/inbox creation each refuse their own specific call with a clear error (or, for market history, just report "not configured" with no error at all) rather than touching money, opening a claim, or breaking an unrelated request. See [`docs/ops/ENVIRONMENT.md`](./docs/ops/ENVIRONMENT.md) for exactly what each variable enables and what happens without it.
- Price history before you start watching comes from the ShopSavvy Data API, and is labelled as theirs wherever it appears. It never opens a claim and never sends an alert: only a price Recoup reads from the store's own page does either. Most of what that API returns for a product is the date each retailer listing was last seen rather than a dense per-day series, so the history is a real but uneven record, and prices from a different variant or a bundle are filtered out by a band around the median rather than by knowing which is which.


- Price history starts the day watching starts. Recoup has no archive of past prices, so a new watch says "not enough history yet" until it has a week of observations.
- Stores that block automated reads or require a login are covered only when the public page can be read. When a page cannot be read, the check is stored as a failed read; it is never shown as a current price. Marketplace listings are individual sellers, not a stable product price.
- Whether a listing at another store is "the same item" is a model judgement that the user confirms. Unconfirmed listings are not ranked.
- The policy shown is the store's current published policy at retrieval time. Recoup does not know what the policy said on the purchase date.
- Follow-ups are reminders only. Recoup never sends a follow-up message on its own.
- No bank or card link. Recoup cannot see your statement, so you confirm each posted credit by hand. A store saying "refund issued" is recorded as a promise, not as money.
- Email is sent only where the store publishes an address and the user confirms it. For form, chat and phone channels Recoup prepares a packet and the user sends it.
- Price reads depend on the page showing one unambiguous price for the right variant. Ranges, "from" prices, other currencies and unclear variants are recorded and do not open a claim or count toward a verdict.
- The price read is the sticker price. Shipping, tax, coupons and membership prices are not included.
- One currency per purchase. One credit confirms one claim; there is no allocation of a single credit across claims.
- Price trackers and refund tools already exist. Recoup's difference is any store from a pasted link, a plain verdict from its own evidence, no affiliate conflict, and the step after purchase: one approved request for the exact difference, tracked until you confirm the money.
