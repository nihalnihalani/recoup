# Recoup

Refund didn't add up? Price dropped after you bought? Recoup gets the difference back.

- Live URL: TODO (placeholder, not deployed yet; will be the project's `convex.site` URL)
- Demo video: TODO (placeholder, not recorded yet; under three minutes)

## What it does

After you buy something online, the store can owe you money for two reasons. You returned an item and the credit does not match what you sent back. Or the price dropped inside the store's own price-adjustment window.

Recoup handles both as one kind of case:

1. **Intake.** Each user gets their own inbox address. Forward an order confirmation to it, or paste the text. The order is extracted into a purchase with line items (name, unit price, quantity, product URL). Every extracted purchase starts as `needs_review`; nothing is active until the user confirms it.
2. **Policy.** On confirmation, Recoup searches the merchant's own site for its price-adjustment and returns policies, scrapes the page, and stores a snapshot: window length, contact channel, contact email, the supporting passage, the source URL and the retrieval time. The passage is kept only if it is found verbatim in the scraped page.
3. **Price watch.** A cron checks product pages every six hours for items whose price-adjustment window is still open. There is also a "check now" action. A claim opens only when the observed price is a single price in the purchase currency, the variant matches, the extraction confidence is at least 0.7, and the drop is at least the greater of 100 cents or 2 percent.
4. **Returns.** The user marks items as returned. A `return_credit` claim is opened for exactly that item; the expected amount is derived on the server as unit price times quantity minus any fee the user accepted.
5. **Ask.** Recoup drafts a short message that names the order, the item, the amount and the policy passage. The user edits it, confirms the recipient and approves. The message goes out from the user's Recoup inbox. If the merchant's channel is a form, chat or phone, the same content is shown as a copyable packet instead.
6. **Reply.** Replies are routed back to the claim and classified as promise, credit issued, refusal, question or other. A promise moves the claim to `promised`. It never counts as money received.
7. **Confirm.** Only the user confirming a posted credit writes a `confirmed_credit` event. When confirmed credits cover the expected amount, the claim is `confirmed`. A later charge reopens that one claim without touching its history.

The board shows three totals across the account: owed (unresolved), asked (unresolved on claims that are sent, packet or promised) and confirmed. Example records are excluded from the totals.

## Stack and what each sponsor does in the app

**Convex** is the whole backend.
- Database: 12 application tables plus the Convex Auth tables (`convex/schema.ts`).
- Functions: queries, mutations and actions for purchases, claims, policies, drafts, replies, intake, price watch, profiles and follow-ups. Money arithmetic happens only in mutations, in integer minor units.
- Crons: `price watch`, every six hours (`convex/crons.ts`).
- Scheduler: inbound event processing, send reconciliation with backoff (30s, 60s, 120s, 300s, 600s), reminder follow-ups, on-demand price checks.
- Auth: Convex Auth with the Password provider. Identity always comes from `ctx.auth`, never from an argument.
- HTTP actions: auth routes and the AgentMail webhook at `/agentmail/webhook` (`convex/http.ts`).
- Static hosting: `@convex-dev/static-hosting` serves the built React app from the same deployment, registered as the last catch-all route.
- Components: `@agentmail/convex`, `@firecrawl/firecrawl-convex`, `@convex-dev/static-hosting` (`convex/convex.config.ts`).

**OpenAI** (`gpt-5.6-terra`, one constant in `convex/lib/ai.ts`) does structured output against strict zod schemas (`convex/lib/schemas.ts`):
- extraction of orders and refund emails into purchases, items and credits,
- extraction of policy terms and the supporting passage from a scraped page,
- extraction of the current price from a product page, with range and variant flags,
- classification of merchant replies,
- drafting of the request message.
All model output is proposed data. The user confirms it, and no model output moves money in the ledger on its own.

**Firecrawl** (`@firecrawl/firecrawl-convex`):
- search, restricted to the merchant's domain, to find the price-adjustment and returns policy pages (`convex/policies.ts`),
- scrape of those pages for the policy text,
- scrape of product pages for price checks (`convex/priceWatch.ts`).

**AgentMail** (`@agentmail/convex`):
- one inbox per user, created on demand (`convex/profiles.ts`),
- outbound send of approved drafts through the component's queued send (`convex/drafts.ts`),
- inbound webhook, signature-verified by the component, routed to intake or to a claim's reply thread (`convex/inbound.ts`, `convex/intake.ts`, `convex/replies.ts`).

Frontend: React 19, Vite, TypeScript, Tailwind 4, React Router. Pages: Board, Purchase, Claim, Settings, SignIn.

## Architecture

### Tables

| Table | Purpose |
|---|---|
| `profiles` | One AgentMail inbox per user; inbound mail is routed to a user by inbox id |
| `purchases` | The case. Status `needs_review`, `active` or `archived` |
| `items` | Line items. `returned` is set only by the user |
| `policies` | Immutable policy snapshots. A refresh inserts a new row; claims keep the snapshot they were opened against |
| `priceChecks` | One observation of a product page. No usable price means no `observedCents` and a note |
| `claims` | Money the store owes on one item for one reason (`price_adjustment` or `return_credit`) |
| `ledgerEvents` | Append-only money facts: `promised_credit`, `confirmed_credit`, `later_debit` |
| `claimNotes` | Non-monetary audit trail: notes, status changes, expected-amount changes |
| `drafts` | Versioned outbound messages; approval is bound to a claim version |
| `replies` | Classified merchant replies, deduplicated by message id |
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
9. At most one open claim of each type per item, including when the cron and "check now" overlap. A new one can be opened only after the previous one is confirmed or dismissed.
10. Amounts are non-negative safe integers in minor units with a three-letter currency code; timestamps and window lengths are range-checked at the boundary.

## Build log

Status source: `docs/team/PLAN.md`. Test counts: `docs/team/VERIFICATION.md`.

### 2026-09-20

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

- No bank or card link. Recoup cannot see your statement.
- Because of that, the user confirms each posted credit by hand. A merchant saying "refund issued" is recorded as a promise, not as money.
- The policy shown is the merchant's current published policy at retrieval time. Recoup does not know what the policy said on the purchase date.
- Email is sent only where the merchant publishes an address and the user confirms it. For form, chat and phone channels Recoup prepares a packet and the user sends it.
- Follow-ups are reminders only. Recoup never sends a follow-up message on its own.
- Price checks depend on a product URL in the order email and on the page showing one unambiguous price for the right variant. Ranges, "from" prices, other currencies and unclear variants are recorded and do not open a claim.
- One currency per purchase. One credit confirms one claim; there is no allocation of a single credit across claims.
- Similar products exist (Refundly, Capital One Shopping, Recourse). Recoup's difference is item-level accounting across both triggers and one state machine from detected to confirmed.
