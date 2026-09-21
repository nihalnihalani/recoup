# Recoup — All Gas Hackathon build log

**Pitch:** Refund didn't add up? Price dropped after you bought? Recoup gets the difference back.

**Live URL:** _pending deploy (Task T14)_ · **Demo video:** _pending_ · **Repo:** https://github.com/nihalnihalani/recoup

## What it does

After you buy something online the store can owe you money for two reasons: you returned it and the credit doesn't match what you sent back, or the price dropped inside the store's own price-adjustment window. Recoup turns a forwarded order email into item-level records, reads the merchant's published policy, opens a claim for the exact gap, drafts one precise request you approve before it is sent from your own Recoup inbox, classifies the merchant's reply, and tracks the money until **you** confirm it posted. A promise from the merchant never counts as money back.

## Stack and what each sponsor actually does

| Sponsor | Job in the product | Where |
|---|---|---|
| **Convex** | Auth, per-user ownership on every function, append-only money ledger with derived balances, scheduled reminders that re-check state, cron price checks, idempotent webhook processing with retry state, static hosting on convex.site | `convex/` |
| **OpenAI** (`gpt-5.6-terra`, Responses API with zod strict schemas) | Extracts orders and refunds from emails, extracts policy passages, reads prices, classifies replies, drafts the request. Every output is proposed data the user confirms; no money arithmetic uses model output | `convex/lib/ai.ts`, `schemas.ts` |
| **Firecrawl** (Convex component) | Finds and scrapes the merchant's returns and price-adjustment pages; scrapes product pages for the price watch. Policy passages are stored only if found verbatim in the scraped page | `convex/policies.ts`, `priceWatch.ts` |
| **AgentMail** (Convex component) | One inbox per user; forwarded emails arrive by verified webhook; approved requests are sent from that inbox; replies land on the claim's thread | `convex/profiles.ts`, `inbound.ts`, `drafts.ts` |

## Invariants the code enforces (tests named after them)

1. A valid row id is never authorization; every owned read and write checks the signed-in user and related records.
2. Money is integer minor units with a currency; boundaries reject non-integers, negatives, and non-ISO currencies.
3. Merchant promises create `promised_credit`; only the user's confirmation creates `confirmed_credit`.
4. `unresolved = expected − confirmed + later debits`; promises are shown separately and never reduce it.
5. The ledger is append-only; a later charge reopens only that claim.
6. Idempotency keys are scoped per claim; a conflicting reuse is an error, not a silent no-op.
7. Any change to the expected amount or the draft invalidates the prior approval.
8. A claim shows "Sending…" until the mail component reports a message id; a failed send returns it to draft.
9. Recipients come only from a user-confirmed policy contact or an explicitly confirmed edit.
10. Follow-ups are reminders only; nothing is auto-sent.

## Build log

- **2026-09-20** · Research: audited all 48 current submissions with Firecrawl (repo + source review), chose the returns-plus-price-drop combination because no entry covers post-purchase money recovery; design doc and 16-task plan written.
- **2026-09-21** · Team build (Claude Code agent team: Opus lead/planner/adversary, Sonnet implementers). Two Opus adversarial reviews before and after the foundation produced 27 recorded decisions; three money-path blockers fixed before any UI depended on them. Foundation: schema, ledger, claims, purchases, policy snapshots, price watch, examples, intake, drafts, replies. _Test count and evidence: see `docs/team/VERIFICATION.md`._

## Honest limits

- No bank or card connection: the user confirms a posted credit by hand.
- Policy shown is the current published policy, labelled with retrieval time; it is not proof of the policy at purchase time.
- Email is used only where the merchant publishes a support address; otherwise the app produces a copyable packet for the merchant's form or chat.
- Price checks open a claim only for an exact variant, matching currency, single price, and confidence ≥ 0.7; anything ambiguous is recorded, not claimed.
- Example purchases are labelled, excluded from totals, and point at `.example` addresses so nothing real can be emailed.

## Team docs

`docs/team/PLAN.md`, `DECISIONS.md` (D01–D49), `CONNECTIONS.md` (24-connection audit), `VERIFICATION.md`, `HANDOFF.md`.
