# Recoup

Price dropped after you bought? Recoup gets the difference back. Haven't bought yet? It watches the price everywhere and tells you when to.

- Live URL: TODO (production placeholder, not deployed yet; will be the project's `convex.site` URL). The dev preview is https://earnest-setter-354.convex.site
- Demo video: TODO (placeholder, not recorded yet; under three minutes)

## What it does

Recoup is about one thing: the price of something you care about, before and after you buy it.

**Before you buy.** Paste a product link on the Watching page, with a target price if you have one. Recoup reads the page, stores the price with its source link and the time it was read, and checks again about every six hours and whenever you press "check now". Each watched item carries a one-line verdict: good price, fair, wait, or discount looks inflated, with one sentence of why. The verdict is a pure function over Recoup's own stored observations plus the "was" price the page claims (`convex/lib/verdict.ts`). With fewer than three observations or less than a week of history it says "not enough history yet" instead of guessing.

**After you buy.** If the store lowers the price inside its own price-adjustment window, Recoup opens a claim for the exact difference and helps you ask for it:

1. **Intake.** Paste an order confirmation, or forward it to your own Recoup inbox address. The order is extracted into a purchase with line items (name, unit price, quantity, product URL). Every extracted purchase starts as `needs_review`; nothing is active until you confirm it.
2. **Policy.** On confirmation, Recoup searches the store's own site for its price-adjustment policy, scrapes the page, and stores a snapshot: window length, contact channel, contact email, the supporting sentence, the source URL and the retrieval time. The sentence is kept only if it is found verbatim in the scraped page.
3. **Price watch.** Product pages of items whose window is still open are checked every six hours and on "check now". A claim opens only when the observed price is a single price in the purchase currency, the variant matches, the extraction confidence is at least 0.7, and the drop is at least the greater of 100 cents or 2 percent. The price dashboard shows paid price, latest price, history chart and the days left in the window for every tracked item.
4. **Ask.** Recoup drafts a short message that names the order, the item, the amount and the policy sentence. You edit it, confirm the recipient and approve. The message goes out from your Recoup inbox. If the store's channel is a form, chat or phone, the same content is shown as a copyable packet instead.
5. **Reply.** Replies are routed back to the claim and classified as promise, credit issued, refusal, question or other. A promise moves the claim to `promised`. It never counts as money received.
6. **Confirm.** Only you confirming a posted credit writes a `confirmed_credit` event. When confirmed credits cover the expected amount, the claim is `confirmed`. A later charge reopens that one claim without touching its history.

The board shows three totals across the account: owed (unresolved), asked (unresolved on claims that are sent, packet or promised) and confirmed. Example records are labelled and excluded from the totals.

### In progress at the time of writing

- **Price-drop email.** One email to the account address when a watched item gets cheaper, once per item per price, with a daily cap. The backend is written (`convex/notify.ts`: a `mailLog` row is claimed under a unique key in the same transaction that accepts the price, then the send is scheduled; the rows double as an in-app drops list). It has not been run live and is not in the UI yet.
- **"I bought it".** Marking a watched item as bought turns it into a purchase that carries its price history, with the price-adjustment window counting down. The backend mutation is written (`watches.markBought`). It has not been run live and is not in the UI yet.
- **Same item at other stores.** One Firecrawl web search for the product name, at most one page per store, each price-read with the same extractor and variant check. Every result is stored as a candidate; only an offer you confirm is re-checked or ranked. The backend is written (`convex/offers.ts`). It has not been run live and is not in the UI yet.

### Not in the product today

- Return-credit claims exist in the backend and are not surfaced.

## What Recoup promises

- No affiliate links and no sponsored ranking.
- You approve every message before it is sent. Recoup never files claims in bulk.
- Money only counts when you confirm it arrived.
- Every price shows where and when it was read. Every policy shows the exact sentence it came from.

Earlier tools in this category filed claims at scale without the customer in the loop, and stores and card issuers responded by tightening the benefits. Recoup sends one message per claim, approved by a person, stated in the store's own policy words.

## Stack and what each sponsor does in the app

**Convex** is the whole backend.
- Database: 16 application tables plus the Convex Auth tables (`convex/schema.ts`).
- Functions: queries, mutations and actions for purchases, claims, policies, drafts, replies, intake, price watch, watches, the price dashboard, profiles and follow-ups. Money arithmetic happens only in mutations, in integer minor units.
- Crons (`convex/crons.ts`): `watch sweep`, hourly, and `price watch`, every six hours. The sweep is bounded: it reads one indexed page of at most 50 due watches (`by_status_nextCheck`), staggers the checks, and a tick with nothing due costs one indexed read. Each watch carries its own `nextCheckAt`, six hours after its last check. Spend is capped in `convex/limits.ts`: 50 watches per user, 20 new watches per hour, a ten-minute cooldown on manual checks.
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

Frontend: React 19, Vite, TypeScript, Tailwind 4, React Router. Pages: Board (price dashboard), Watching, Purchase, Claim, Settings, SignIn.

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
| `claims` | Money the store owes on one item for one reason. The product opens `price_adjustment` claims |
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
