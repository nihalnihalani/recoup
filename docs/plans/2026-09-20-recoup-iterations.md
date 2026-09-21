# Recoup: iteration plan (working first, then better)

Date: 2026-09-20. Companion to `2026-09-20-recoup.md`, not a replacement. That plan says **what** to build, task by task. This one says **in what order we prove it works**, one thin slice at a time, so there is always a working app to submit.

Deadline: 2026-09-22 12:00 PT. Code freeze: 2026-09-22 08:00 PT. After the freeze only rehearsal, recording, `hackathon.md` and submission happen.

## Where we actually are

Most of the code already exists: backend Tasks 1 to 10 are written and unit-tested, the four frontend pages are written, keys are set on the dev deployment `earnest-setter-354`, the AgentMail webhook is registered. **None of it has ever run live.** No user has signed up, no email has been sent or received, no real OpenAI or Firecrawl call has been made from the app.

So the risk is not unwritten code. It is unproven code. Each iteration below takes one slice of what exists, runs it for real, fixes what breaks, and ships it. We do not start the next slice until the current one works on a real URL.

## Rules

1. **One iteration at a time.** An iteration is done only when its exit check passes live, in a browser, against the real deployment, plus `npm test`, `npm run typecheck`, `npm run build` green, plus a commit.
2. **A bug found live is fixed before moving on.** Anything else discovered goes to the backlog at the bottom, not into the current iteration.
3. **Every iteration ends shippable.** If the clock ran out right after any iteration from I1 onward, we could record a truthful video of what works and submit.
4. **No new features inside an iteration.** New code is written only when the slice cannot pass without it.
5. **Smallest fix wins.** Hardening, refactors and architecture gaps wait for the backlog unless they block the exit check.
6. **Timeboxes are real.** If a slice is over its box by 50 percent, cut scope inside the slice (see "fallback" on each) and move on.

## Iterations

| # | Slice | What it proves | Exit check (done live) | Fallback if stuck | Box |
|---|---|---|---|---|---|
| **I0** | Walking skeleton | Auth, routing, Convex connection | Sign up, sign out, sign in on `npm run dev` against the dev deployment. Empty Board renders. Settings shows "create inbox" and creating it returns an address. | Skip inbox creation until I4. | 1h |
| **I1** | The ledger loop, no AI, no email | Schema, ownership, claims, ledger math, Board totals, the core UI | Click "Load an example". Open the Northwind purchase, open the scarf claim, see expected $40 / unresolved $40. Confirm a $40 credit. Claim shows `confirmed`, Board "confirmed" total moves. **Then deploy the static site to `convex.site` and repeat the check on the public URL.** | If the example loader is not ready, create the purchase through a temporary form. | 2h |
| **I2** | Paste intake | OpenAI structured extraction, review-then-confirm | Paste a real order confirmation text in Settings. A `needs_review` purchase appears with correct merchant, items and cents. Edit one field, confirm, it becomes `active`. Paste garbage: it lands as `needs_review` with a reason, nothing crashes. | Manual purchase form stays as the entry path. | 2h |
| **I3** | Policy lookup | Firecrawl search + scrape, passage verification | Confirming the I2 purchase produces policy cards for returns and price adjustment with a verbatim passage, source link and retrieval time, or an honest `unknown`. User can confirm the policy and contact. | User pastes the policy URL or rule by hand. | 2h |
| **I4** | Draft and send | OpenAI drafting, approval binding, AgentMail outbound, `queued` to `sent` | On the scarf claim: generate draft, edit it, tick recipient confirmation, approve. Message arrives in an inbox we control. Claim shows `queued` then `sent` with the message id. Double-click does not send twice. | "Packet" path: copyable message, user marks it sent. | 3h |
| **I5** | Reply and close | Inbound webhook, dedupe, routing to the right claim, classification, promise is not payment | From the controlled inbox reply "Your refund is being processed". Claim moves to `promised`, unresolved stays $40. Confirm the credit: `confirmed`, follow-up cancelled, Board updates. **Record a backup take of video act one here.** | Record the reply by hand through a "log a reply" action. | 3h |
| **I6** | Price drop | Firecrawl price extraction, threshold, window countdown | On a real product URL (or the example), "Check price now" stores an observation. A qualifying drop opens a `price_adjustment` claim for the right amount with a live countdown. Draft and send works on it (reuses I4). | Use the example purchase's seeded price check for the video. | 2h |
| **I7** | Submission | Production deploy, judges can use it | Prod deployment with prod env vars and a second webhook, `npm run deploy`, smoke test of I1 on the prod URL in a private window. `hackathon.md` has live URL and video link. Video recorded against the deployed app. Social post. Submit. Needs Charlie's explicit go-ahead for deploy, post and submit. | Submit the dev `convex.site` URL if prod setup fights back. | 4h |

Total boxed time: about 19 hours of the roughly 43 available. The slack is for the bugs that live runs always find.

After I5 the app already delivers the first half of the pitch ("refund didn't add up"). After I6 it delivers the whole pitch. Everything below is improvement, not rescue.

## Direction change, 2026-09-20 evening (Charlie)

Product focus moves to **price**: never overpay, before or after you buy. The under-credited-return story is dropped from the pitch, the video and the UI. Its backend (`return_credit` claims, refund-email attribution) stays in place untouched because removing it is surgery with no demo value; the UI simply stops offering it.

Status when this was written: I0 and I1 passed live (local and on `https://earnest-setter-354.convex.site`), H7 fixed, I2 interrupted mid-run.

Revised order after I2 and I3 (both still needed: a purchase and its price-adjustment policy):

| # | Slice | Exit check (live) | Box |
|---|---|---|---|
| **I6** (moved up) | Price drop after purchase | "Check price now" on a real product URL stores an observation; a qualifying drop opens a `price_adjustment` claim with a countdown | 2h |
| **I4 / I5** | Ask and reply, on the price claim | Draft, approve, send to a controlled inbox, reply moves it to `promised`, confirm closes it | 5h |
| **W1** | Watchlist: track something I have not bought | Add an item by product URL with an optional target price. It is checked on the same cron and "check now" as owned items. Price history shows on the item. Reuses `priceChecks` and the extractor; new `watches` table | 3h |
| **W2** | Tell me when it drops | When a watched item falls below target, or by the threshold, one email goes to the account address through AgentMail, deduped per item per price. In-app "drops" list on the Board | 2h |
| **W3** | Same item, other stores | For a watch, Firecrawl search finds candidate listings on other merchants; each is price-extracted with the variant-match check; the item page ranks offers cheapest first with store, price, last checked, link. User confirms which listings are truly the same product | 4h |
| **I7** | Submission | unchanged | 4h |

Honest limits to state in `hackathon.md`: price history starts the day we start watching (we have no archive of past prices); stores that block automated access or require login (Facebook Marketplace, parts of Amazon and eBay) are covered only when a page can be read publicly, and marketplace listings are individual sellers, not a stable product price; matching "the same item" across stores is a model judgement the user confirms.

## Known defects, assigned to the iteration that would hit them

From the independent backend review on 2026-09-20 (read-only, nothing was run; it reviewed the tree just before the teammate merge, so re-check line numbers in `purchases.ts`, `claims.ts`, `policies.ts`). Auth and ownership, ledger invariants, webhook dedupe and routing, external API call shapes, and the cron sweep came back clean. Fix each item inside its iteration, not before.

| Iteration | Finding | Fix |
|---|---|---|
| I2 / I3 | H7: `merchantDomain` stored raw on purchases but normalised on policies; `www.bestbuy.com` yields no policy card and `openClaim` throws "different merchant" | `normalizeDomain` in `purchases.create` and `confirm` |
| I3 | M1: every confirm or refresh inserts a snapshot that shadows a user-confirmed policy; price watch then stops silently | skip refetch when a snapshot is under 24h old, or prefer the newest `confirmedByUser` row |
| I4 | **passed** 2026-09-20 | `59a9df4` | Real email sent through AgentMail from the user's Recoup inbox to a controlled inbox; claim went `queued` then `sent`, reminder scheduled. Found live: the AgentMail component could not see `AGENTMAIL_API_KEY` (isolated runtime, no env declared in 0.1.0); fixed with the same patch-package patch ClaimHero ships. The component's own retry delivered the queued message after the fix. Also fixed H3, H5, H6 with tests. |
| I4 | H6: `approveAndSend` has no claim-status guard; two drafts can both send; a send reopens a closed claim | refuse when `queued`, `dismissed`, `confirmed` |
| I4 | H5: password sign-up never sets a name, drafts are signed "the customer" | fall back to email local part |
| I4 | M4: after five status checks a claim is stuck `queued` | manual "check again" |
| I5 | **passed** 2026-09-20 | `59a9df4` | Reply sent from the controlled inbox arrived by webhook, routed to the right claim, classified `promise` with $50.00; status `promised`, unresolved stayed $50.00. Confirming the credit moved it to `confirmed`, unresolved $0.00, reminder cancelled. H2 and H4 fixed beforehand with tests. |
| I5 | H4: `emailDomain("Acme <help@acme.com>")` returns `acme.com>`, so every real reply is flagged sender mismatch | extract the address before the domain |
| Backlog 1 | H1: inbound prefers `extracted_text`, which strips forwarded content; a forwarded order can reach the model as "FYI" | store both; intake reads `text` first, replies read `extractedText` first |
| Backlog | M2, M3 (stuck or duplicate intake events), M5 (`adjustExpected` drops the reminder), M6 (no rate limits), M7 (60 KB payloads in a reactive query), and the LOW items | see `docs/reviews/2026-09-20-backend-review.md` |

## Backlog: making it better, in order

Pulled only after I6 passes, one item at a time, each with its own small exit check. Stop pulling at the code freeze.

1. **Forwarded-email intake.** Forward a real order email to the user's inbox address and get the same result as paste (the webhook path is proven in I5, so this is mostly routing).
2. **Refund-email intake.** Forward a refund email; credits attach to the right item or go to `needs_review` (D15).
3. **Review decisions D38 to D49** not already landed (per-claim idempotency keys, debit cap, status re-derivation, archive instead of delete).
4. **Price-watch cron** on a bounded, indexed sweep instead of a full-table read (analysis gap G2). "Check now" already covers the demo.
5. **Follow-up reminders** surfacing on the Board (`attentionAt`).
6. **Return validators on every function** and frontend types derived from them (G1).
7. **Rate limits** on paste, check-now, policy refresh, draft generate (G4).
8. **Later-debit reopen** shown in the UI.
9. **Packet path polish** for merchants with no email channel.
10. **Visible fetching and failed states** for policy and price actions (G5), env contract (G7), LLM output normalisation beyond what D16/D17 already do (G8), bounded board and cascade delete (G9).
11. Google sign-in, empty states, copy, mobile layout.

## How the two plans fit

- The task plan and `docs/team/DECISIONS.md` stay the reference for how each piece should be built.
- This plan decides what we are allowed to work on right now: the current iteration's exit check, nothing else.
- Parallel agents are still used, but inside an iteration (one fixes the backend bug, one fixes the page), not across future iterations.
- Status lives in the table at the bottom of this file. One line per iteration: date, result, commit, what broke.

## Status log

| Iteration | Status | Commit | Notes |
|---|---|---|---|
| I0 | **passed** 2026-09-20 | `3152758` | Sign-up, sign-in, empty Board, inbox created live. Note: after sign-up the page needed a reload to leave the sign-in screen; recheck. |
| I1 | **passed** locally 2026-09-20; public URL serves the app, signed-in recheck pending | `d49c3cb` | Example loaded, scarf claim confirmed for $40, status `confirmed`. Added the missing Board button; hid ask/dismiss on closed claims. Static site uploaded to `earnest-setter-354.convex.site` (SPA fallback verified by curl). Board totals exclude example money by decision D27, so the totals check moved to I6. |
| I2 | **passed** 2026-09-20 | `b93d19f` | Real OpenAI extraction from pasted Best Buy and Target orders: merchant, domain, order ref, date, items, cents, product URL all correct. Fixed H7 (domain normalisation). |
| I3 | **passed** 2026-09-20 | `b93d19f` | Target: verbatim passages at 0.99 / 0.93 confidence, 14-day window, channel chat. Best Buy serves Firecrawl a region splash, so it correctly lands as unknown; the note now says so. Passage match made tolerant of markdown and curly quotes. |
| I4 | **half passed**: drafting live; send not yet run | `9ff60d7` | Draft quotes the policy, amount and token correctly; recipient empty when the policy has no contact (D18). Fixed H3, H5, H6 with tests. Real send needs a recipient inbox and Charlie's go-ahead. |
| I5 | not run; known bugs pre-fixed | (this commit) | H2 (lost replies: retry with backoff, park as failed, user can re-run) and H4 (display-name From header) fixed with tests. |
| I6 | **passed** 2026-09-20 | `b93d19f` | Real Target product page: observed $499.99 against $549.99 paid, claim opened for $50.00, countdown 9d 12h, Board OWED $50.00. A wrong product URL correctly reports 'page does not price this product'. |
| I7 | not started | | |
| W1 + W1b | **passed** 2026-09-20 | (this commit) | Pasted a real Target product link on the new Watching page: name and $499.99 read from the page, target $449.99 stored, verdict 'Not enough history yet' with a plain reason. Backend: `watches`/`watchChecks`, bounded hourly sweep, per-watch cooldown and per-user caps, pure `lib/verdict.ts`; 336 tests. Next: W2 drop email, W4 'I bought it', W3 other stores, T1 copy. |
