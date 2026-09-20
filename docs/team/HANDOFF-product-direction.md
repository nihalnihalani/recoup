# Handoff to the main build session: product direction and next work

Written 2026-09-20 ~16:40 PDT by the research/product session, in `/Users/charlie/hackathons/recoup`. This session wrote no code after `d49c3cb` except the H7 domain fix, which the main session already committed in `b93d19f`. It is now stopping; nothing it owns is running (no agents, no workflow). The dev server preview `recoup-web` on port 5173 may still be up from this session; reuse or restart it.

Read this, then `docs/plans/2026-09-20-recoup-product-plan.md` (what and why), then the status log at the bottom of `docs/plans/2026-09-20-recoup-iterations.md` (where things stand; you maintain it).

## Decisions Charlie made in this session (treat as settled)

1. **Product focus is price, before and after you buy.** Pitch line, approved verbatim: "Price dropped after you bought? Recoup gets the difference back. Haven't bought yet? It watches the price everywhere and tells you when to."
2. **The under-credited-return story is out** of the pitch, the video, `hackathon.md` and the UI. Charlie's words: nobody has this problem. Do not delete the backend (`return_credit` claims, refund-email attribution, D15): it is tested and removing it is surgery with no demo value. Just stop offering it: no "Open claim" for returned items on the Purchase page, no returns story in the example loader's visible copy, no returns policy card emphasis. The example loader's Northwind returns purchase should be replaced or hidden; keep the price-adjustment example.
3. **Notifications go by email** to the account address through AgentMail. No SMS or push provider before the deadline.
4. **Two extensions approved:** (a) watch items not yet bought and notify on a drop; (b) find the same item at other stores, with history, cheapest first.
5. **Working style:** simple but working, one thin slice at a time, proven live before the next. Parallel agents inside a slice are fine.
6. **No key rotation needed** (Charlie: this is a test project). Still never commit or print keys. `.env.local` is gitignored; scan staged diffs before any push.
7. **Build on Nihal's `origin/main`.** Done in merge `3152758`. Local `main` is 13 ahead of `origin/main` and **nothing is pushed**. Pushing still needs Charlie's explicit go-ahead; Nihal's team was active as of 22:54 UTC, so tell them before pushing.

## What the research found (one paragraph; details and sources in the product plan)

The "money back after a price drop" category is empty because Paribus and Earny filed claims automatically at scale and issuers and merchants responded by removing the benefits. So **never bulk-file**: one claim, one human-approved message, in the store's own policy words. That is already our design (D03, D11, D18) and is now the positioning. Honey's affiliate-hijacking scandal broke trust in shopping tools, so **no affiliate links, no sponsored ranking, and say so in the UI**. Incumbent trackers are Amazon-first and built for power users; open-source any-store trackers exist but need self-hosting. Normal people want a verdict ("good price", "wait", "fake discount"), not a chart, and fake sales are common enough that this matters. Caveat: the social scan returned little on-topic signal and X was unreachable; the conclusions rest on six web searches read at snippet level.

## What to build next, in order

Finish what is open first:

- **I4 send and I5 reply, live.** Needs a recipient inbox Charlie controls and his go-ahead for a real send. Ask him for the address. Charlie's Recoup inbox is `recoup-qe4wuqcg@agentmail.to`. The claude.ai AgentMail connector can read and reply from an inbox in his org if he authorises its use for the rehearsal.
- **I1 public-URL recheck** signed in on `https://earnest-setter-354.convex.site` (Charlie must sign in there himself), and the I0 note: after sign-up the page stayed on the sign-in screen until reload. Reproduce and fix; judges will hit it.
- Re-upload the static site after UI changes: `npx @convex-dev/static-hosting upload --build` (dev deployment; no `--prod`).

Then the new slices. Each gets a live exit check and a row in the status log.

| # | Slice | Exit check (live) | Notes |
|---|---|---|---|
| **W1** | Paste-a-link watch with optional target price | On a new "Watching" area, paste a real product URL (or a product name that Firecrawl search resolves to a page). It appears with name, current price, source link, checked time. "Check now" adds an observation. | New `watches` table (`userId`, `name`, `productUrl`, `merchantDomain`, `currency`, `targetCents?`, `status`, `watchUntil?`), index `by_user` and one the sweep can read bounded (`by_status_nextCheck` or similar; no full-table reads, see G2 in `docs/CONVEX_REFERENCE_ANALYSIS.md`). Reuse the `Price` schema, the D16 acceptance rules and the extractor in `priceWatch.ts`; store observations in `priceChecks` with an optional `watchId` alongside `itemId` (additive schema change), or a sibling table if that is cleaner. Rate-limit "check now" per watch. |
| **W1b** | Verdict line: Good price / Fair / Wait / Discount looks inflated / Not enough history yet | Shown on every watched item and owned item. With under ~7 days or under 3 observations it says "not enough history yet". | Pure function in `convex/lib/verdict.ts` with unit tests: inputs are our own observations plus the page's claimed "was" price (add `listPrice` nullable to the `Price` zod schema; per D30 no `.max()` on strings). Never let the model output the verdict; it is computed (bipolar's "the model never returns a number" rule). |
| **W2** | Drop email | Lower the target above the current price, run "check now": one email arrives at the account address with item, old and new price, source link, link back. Run it again: no second email. | AgentMail send from the user's own Recoup inbox to `users.email`. Dedupe with a claim-before-send row keyed `watch:<watchId>:<cents>` (bipolar `notify.ts` pattern). Plain text, clear subject. In-app "Drops" list on the Board as the backstop. Do not reuse `drafts.approveAndSend`; that path is for merchant mail with the D18 recipient gate. |
| **W4** | "I bought it" | On a watched item click "I bought it", enter price paid and date: it becomes an `active` purchase with the price-adjustment policy fetched and the window counting down; the watch is archived. | Small; mostly calls `purchases.create` plus `policies.fetchBoth`. This is the link nobody else has, so it goes before W3. |
| **W3** | Same item at other stores | For a watch, "Find other stores" lists candidate offers from Firecrawl search with store, price, checked time, link, and a match confidence. User confirms or rejects each. Confirmed offers rank cheapest first and are re-checked with the watch. | `offers` table keyed to the watch. Reuse the `variantMatch` field. Unconfirmed offers are greyed and never drive a verdict or an alert. No Facebook Marketplace; Amazon and eBay only when the public page reads. First to cut if time runs short. |
| **T1** | Trust copy | First screen and `hackathon.md` say: no affiliate links, you approve every message, money counts only when you confirm it, every price shows its source and time. New pitch line replaces "Refund didn't add up?" on the sign-in page, README and `hackathon.md`. | Copy only; ride along with the first UI touch. |

Then **I7** (prod deploy, second webhook, video, social, submit), which needs Charlie's explicit authorisation for each outward step. Code freeze 2026-09-22 08:00 PT; deadline 12:00 PT.

## Honest limits to keep in `hackathon.md`

Price history starts the day watching starts. Stores that block automated reads or need login are covered only when the public page reads (Best Buy already serves Firecrawl a region splash). "Same item" across stores is a model judgement the user confirms. Policy shown is the current policy, not the one at purchase time. Follow-ups are reminders only.

## State of the repo when this was written

- `main` at `50a31ff`, 13 ahead of `origin/main`, working tree clean except untracked Convex tooling (`CLAUDE.md`, `AGENTS.md`, `.claude/skills/`, `.agents/`, `skills-lock.json`); Charlie has not decided whether to commit those. Recommendation: commit them; both reference repos ship the same files.
- 253 tests pass, typecheck clean (verified by this session at handoff).
- Dev deployment `earnest-setter-354` has all keys; one user (Charlie); example purchases loaded; one real inbox.
- Open review items not yet fixed: H1 (forwarded mail body), M1 (policy snapshot shadowing; matters for W4 because price watch reads the latest policy), M2, M3, M4, M5, M6 (no rate limits; W1 adds public paths that spend credits, so add `convex/limits.ts` with it), M7. Full text in `docs/reviews/2026-09-20-backend-review.md`.
- A stale autopilot state from the oh-my-claudecode plugin was deactivated in this session; if a stop hook claims "autopilot not complete", run the plugin's cancel skill.
