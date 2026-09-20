# Recoup: design

Date: September 20, 2026. Status: approved by the builder in conversation. Supersedes the BackToCard positioning in `BACKTOCARD_DEEP_RESEARCH.md`; that document's research, fixtures and invariants remain the evidence base.

Deadline: All Gas hackathon, September 22, 2026, 12:00 Pacific (September 23, 00:30 IST). Requirements: new build, Convex backend, public GitHub repository with a root `hackathon.md`, public `convex.site` deployment, video under three minutes, social post tagging sponsors.

## Product

**Name:** Recoup.

**Pitch:** "Refund didn't add up? Price dropped after you bought? Recoup gets the difference back."

**Job:** After you buy something online, the store can owe you money for two reasons. You returned it and the credit does not match what you sent back. Or the price dropped inside the store's own price-adjustment window. Recoup turns your order email into an item-level record, reads the store's published policy, opens a claim for the exact gap, sends one precise request with your approval, reads the reply, and tracks the money until you confirm it is on your card.

**Positioning rules.** Do not claim "first" or "automatic recovery". Refundly, Capital One Shopping and Recourse exist. Recoup's difference is item-level accounting across both triggers and one honest state machine from detected to confirmed. Say "the store's own policy", never "illegal" or "guaranteed".

**Users.** Real accounts, real purchases. No demo mode. A one-click "load an example purchase" seeds two example cases into the signed-in user's own account so judges can see the product without forwarding an email. Example records are labelled as examples in the UI.

## Approach chosen

One case, two claim types. A purchase is the case. A claim on a purchase is either `price_adjustment` or `return_credit`. Both share one ledger, one policy snapshot model, one email thread, one follow-up scheduler, one board. Rejected: two separate modules sharing only email (double the build), and a generic detector engine (over-engineered for the time available).

## Stack

- React 19, Vite, TypeScript, Tailwind. Deployed with `@convex-dev/static-hosting` to the project's `convex.site` URL.
- Convex for database, functions, crons, scheduler, file storage, HTTP actions.
- Convex Auth: password and Google providers.
- `@firecrawl/firecrawl-convex` for search and scrape.
- `@agentmail/convex` for per-user inboxes, threads, messages, inbound webhooks with Svix verification and queued sends.
- OpenAI through the Convex AI gateway (or the OpenAI SDK from actions) for structured extraction, classification and drafting. All model output is proposed data that the user confirms; money arithmetic is deterministic in mutations.
- Amounts are integer minor units with a currency code. First build supports one currency per purchase and USD in examples.

## Data model

| Table | Purpose | Key fields |
|---|---|---|
| `purchases` | The case | `userId`, `merchant`, `merchantDomain`, `orderRef`, `purchasedAt`, `currency`, `sourceMessageId`, `status` |
| `items` | Line items | `purchaseId`, `name`, `unitCents`, `qty`, `productUrl`, `returned` (bool), `returnedAt` |
| `policies` | Snapshot of a merchant rule | `merchantDomain`, `kind` (`price_adjustment` or `returns`), `windowDays`, `channel` (`email`, `form`, `chat`, `phone`, `unknown`), `contactEmail`, `passage`, `sourceUrl`, `retrievedAt`, `confidence`, `confirmedByUser` |
| `priceChecks` | One observation of a product page | `itemId`, `observedCents`, `observedAt`, `sourceUrl`, `screenshotId` |
| `claims` | Money the store owes on one item | `purchaseId`, `itemId`, `type`, `expectedCents`, `status`, `windowEndsAt`, `threadId`, `policyId`, `openedFromPriceCheckId` |
| `ledgerEvents` | Facts about money on a claim | `claimId`, `kind` (`promised_credit`, `confirmed_credit`, `later_debit`), `cents`, `evidence` (message id, file id or user note), `confirmedAt` |
| `drafts` | Versioned outbound messages | `claimId`, `version`, `to`, `subject`, `body`, `attachments`, `approvedAt`, `sentMessageId` |
| `followUps` | Scheduled next actions | `claimId`, `draftId`, `scheduledFnId`, `fireAt`, `kind` (`remind_user` or `auto_send`) |
| `processedEvents` | Idempotency for inbound webhooks and cron runs | `externalId`, `kind`, `processedAt` |

Threads and messages live in the AgentMail component's tables. `claims.threadId` points at them.

Claim status: `detected` → `drafted` → `sent` → `promised` → `confirmed` → `closed`, with side states `reopened`, `dismissed`, `packet` (for non-email merchants). `confirmed` is reached only by a user-confirmed `confirmed_credit` event that covers the expected amount.

Derived balance per claim, computed in a query, never stored: `unresolved = expected - sum(confirmed_credit) + sum(later_debit)`. Promised credits are shown separately and never reduce `unresolved`.

## Flows

**Intake.** Each user gets an AgentMail inbox on sign-up. The user forwards an order confirmation to it, or pastes the text into an intake box. The inbound webhook (or paste action) calls an OpenAI extraction with a strict schema: merchant, domain, order ref, date, currency, items with name, unit price, quantity, product URL. The user reviews the proposed purchase and confirms. Unparseable input becomes a purchase with status `needs_review`, never a silent failure.

**Policy.** On confirmation, an action uses Firecrawl search to find the merchant's price-adjustment and returns pages on the merchant's domain, scrapes them, and asks OpenAI to extract window length, channel, contact email and the exact supporting passage with character offsets. The passage, source URL and retrieval time are stored and shown. If confidence is low or no page is found, the policy shows `unknown` and the user can paste a URL or the rule themselves. Current policy is labelled as current; the app does not claim it applied at purchase time.

**Price watch.** A Convex cron runs every six hours. For each item whose price-adjustment window is open and whose `productUrl` is set, it scrapes the page with Firecrawl and asks OpenAI to extract the current price for the matching variant. A `priceCheck` is stored. If the observed price is below `unitCents` by at least the greater of 100 cents or 2 percent, and no open `price_adjustment` claim exists for the item, a claim opens with `expectedCents = (unitCents - observedCents) * qty` and `windowEndsAt = purchasedAt + windowDays`. The board shows a live countdown from `windowEndsAt`. A manual "check now" button runs the same action on demand.

**Returns.** On the purchase detail the user marks items as returned with a date. The user records credits they have seen post, either by forwarding the refund email (extracted) or by entering the amount. The ledger view shows, per returned item, expected credit and confirmed credit. Any returned item with a gap after the returns window's stated processing period, or on user request, opens a `return_credit` claim for exactly that item and gap. Fees stated in the confirmed policy passage (for example a mail-label fee) are shown as a proposed deduction the user accepts or rejects; an accepted fee reduces the expected credit and is recorded as evidence.

**Ask.** For an open claim, OpenAI drafts a short message referencing the order ref, the specific item, the amount, the policy passage and the attached evidence. The user edits recipient, subject and body, then approves. Approval freezes a draft version. AgentMail sends it through the component's queued send; the UI shows `queued` until the component reports the message id, then `sent`. If the policy channel is not email, the app renders a copyable packet with the same content and the claim moves to `packet`; the user marks it sent.

**Reply.** Inbound replies on the claim's thread trigger classification: `promise`, `credit_issued`, `refusal`, `question`, `other`. `promise` and `credit_issued` create a `promised_credit` event and set status `promised`; they never create `confirmed_credit`. `refusal` and `question` surface the reply and a suggested next draft. The user confirms an actual posted credit with a button and an optional amount; that creates `confirmed_credit`. When confirmed credits cover expected, status becomes `confirmed`, open follow-ups are cancelled, and the claim closes.

**Follow-up.** When a claim reaches `sent` or `promised`, a follow-up is scheduled at the later of the policy's stated processing period or seven days. Default kind is `remind_user`: it surfaces a prepared next draft. `auto_send` requires the user to approve that specific draft in advance; the scheduled function re-reads the claim and refuses to send if status, expected amount or draft version changed.

**Later debit.** The user records a later charge with evidence. A `later_debit` event on a confirmed claim reopens only that claim (`reopened`) with `unresolved` recomputed from the ledger. The original history is untouched.

## Screens

1. **Board.** Purchases with money at stake. Three totals across the account: owed, asked, confirmed. Each row shows merchant, items, and for each open claim its type, amount, status and countdown. Sorted by soonest window end.
2. **Purchase.** Items with paid price, latest observed price and a small price history. Returned toggles and confirmed credits per item. Policy card with passage, source, retrieval time, channel. "Open claim" on any item with a gap.
3. **Claim.** Ledger strip (expected, promised, confirmed, unresolved). Draft editor with recipient, attachments and approve button. Thread of sent and received messages with classification labels. Next action and follow-up date. Confirm credit and record later charge actions.

Sign-in page and inbox address shown on a small settings page.

## Invariants enforced in mutations

1. Every query and mutation checks that the caller owns the purchase.
2. A `promised_credit` never changes `unresolved`.
3. A ledger event is inserted once; duplicate webhook or cron deliveries are dropped through `processedEvents`.
4. A claim's `expectedCents` changes only through an explicit user action, and any change invalidates approved drafts and pending `auto_send` follow-ups.
5. A scheduled send re-checks status and draft version immediately before sending.
6. A later debit reopens a claim; it never deletes history.
7. The UI shows `sent` only after the mail component reports a message id.
8. No email is sent to an address that did not come from a confirmed policy snapshot or the user's own edit.

## Testing

- Convex function tests with `convex-test` for the ledger: partial credit, promise, confirmed credit, later debit, duplicate event, accepted fee, ambiguous amount. Inputs come from `backtocard-demo-kit/fixtures.json`, adapted to items without parcels.
- One test per invariant above.
- An end-to-end rehearsal through two real AgentMail inboxes before recording.

## Video, 2:45, returns first

| Time | Screen | What happens |
|---|---|---|
| 0:00–0:15 | Board | "I returned two items in one parcel. One credit came back. Recoup shows me the $40 that didn't." |
| 0:15–0:40 | Purchase | Forwarded refund email appears live; per-item ledger shows sweater credited, scarf not. Policy passage and contact route shown. |
| 0:40–1:00 | Claim | Draft asks about the scarf only; approve; sent through AgentMail. |
| 1:00–1:20 | Claim | Reply "refund is being processed" arrives; status `promised`, not paid; follow-up scheduled. |
| 1:20–1:35 | Claim | User confirms the posted $40; claim confirmed; follow-up cancelled; board updates. |
| 1:35–2:15 | Purchase → Claim | Act two: another purchase, price-adjustment policy with a live countdown; "check now" finds $120 became $95; claim opens for $25; draft; send. |
| 2:15–2:35 | Board | Both claims on one board with owed, asked, confirmed totals. |
| 2:35–2:45 | Board | Pitch line and public URL. |

Everything in the video runs against the deployed app with real integrations and inboxes the builder controls. Example purchases are labelled as examples. No recovered money is claimed unless it happened.

## Cut list

Bank or card connections, Gmail OAuth, multi-currency in one purchase, household sharing, parcel and parcel-item modelling, chargebacks and legal escalation, browser automation of merchant chat, analytics dashboards, pricing.

## Build order

1. Convex project, auth, schema, ownership helpers, ledger mutations and tests.
2. Intake: AgentMail inbox per user, inbound webhook, paste path, OpenAI extraction, review screen.
3. Policy: Firecrawl search and scrape, extraction, policy card.
4. Claims: open from returns gap and from price check; claim screen; draft, approve, send; reply classification; confirm credit; later debit.
5. Price watch cron and "check now"; board with countdowns and totals.
6. Follow-ups, packet path, example loader, polish.
7. Deploy, `hackathon.md`, end-to-end rehearsal, record, post, submit.
