# Recoup

Price dropped after you bought? Recoup gets the difference back. Haven't bought yet? It watches the price everywhere and tells you when to.

Before you buy: paste a product link, and Recoup reads the price, keeps a history with the source and time of every read, and gives a one-line verdict computed from that history (good price, fair, wait, discount looks inflated, or not enough history yet).

After you buy: paste or forward the order email. Recoup reads the store's own published price-adjustment policy, watches the product page while the window is open, opens a claim for the exact difference when the price drops, sends one request with your approval, reads the reply, and tracks the money until you confirm it arrived.

What Recoup promises:

- No affiliate links and no sponsored ranking.
- You approve every message before it is sent. Recoup never files claims in bulk.
- Money only counts when you confirm it arrived.
- Every price shows where and when it was read. Every policy shows the exact sentence it came from.

Live: https://cool-oyster-399.convex.site. Price-drop emails, "I bought it" on a watched item, and the same item at other stores are in the UI and have run end to end on production (see the status log in `docs/plans/2026-09-20-recoup-iterations.md`).

Built for the Convex All Gas hackathon. The submission write-up, architecture and honest limits are in [`hackathon.md`](./hackathon.md).

## Local development

Requires a recent Node LTS and a Convex account.

```sh
npm install
npx convex dev     # terminal 1: creates/links a dev deployment, writes .env.local, pushes functions
npm run dev        # terminal 2: Vite on http://localhost:5173
```

Sign up with an email and password on the sign-in page. The Settings page creates and shows your Recoup inbox address.

## The gate

All four must pass before anything is called done:

```sh
npm test
npm run typecheck
npm run lint
npm run build
```

Tests run with `vitest` and `convex-test`. They do not touch the network; OpenAI, Firecrawl and AgentMail are stubbed or registered as test components (`convex/test.setup.ts`).

## Environment variables

Client-side, in `.env.local` (see `.env.example`; `npx convex dev` writes them):

- `VITE_CONVEX_URL`
- `VITE_CONVEX_SITE_URL`

Server-side secrets live only in the Convex deployment. Set each one with `npx convex env set NAME value`. Never put values in the repo, in `.env.example`, or in docs.

| Name | Used for |
|---|---|
| `OPENAI_API_KEY` | Extraction, classification, drafting |
| `FIRECRAWL_API_KEY` | Policy search and scrape, product page price reads for owned and watched items |
| `AGENTMAIL_API_KEY` | Inbox creation and outbound send. The key is bound into the AgentMail component by a patch-package patch (`patches/`) |
| `AGENTMAIL_WEBHOOK_SECRET` | Verifying the inbound webhook at `/agentmail/webhook` |
| `JWT_PRIVATE_KEY`, `JWKS`, `SITE_URL` | Convex Auth (set by `npx @convex-dev/auth`) |

The deployment stays healthy without the provider keys. Calls that need a missing key fail closed at call time, and the webhook route rejects events until its secret is set.

To receive mail, create an AgentMail webhook for received messages that points at `https://<your-deployment>.convex.site/agentmail/webhook` and set its signing secret as `AGENTMAIL_WEBHOOK_SECRET`.

## Where things are

| Path | What |
|---|---|
| `convex/schema.ts` | Tables and the shared enum validators |
| `convex/lib/ledger.ts`, `money.ts`, `balance.ts` | Pure ledger and money logic; derived claim balance |
| `convex/lib/access.ts` | Identity from `ctx.auth` and ownership checks |
| `convex/lib/schemas.ts`, `ai.ts` | Zod schemas for model output; OpenAI client and model id |
| `convex/lib/passage.ts`, `policyText.ts` | Verbatim passage verification and policy page selection |
| `convex/purchases.ts`, `claims.ts` | Purchases, items, board; claims and ledger events |
| `convex/policies.ts` | Policy research with Firecrawl, immutable snapshots |
| `convex/priceWatch.ts`, `crons.ts` | Price reads for owned items, six-hour price watch, hourly watch sweep, check-now |
| `convex/watches.ts`, `convex/lib/verdict.ts`, `watchUrl.ts` | Watched items not bought yet; the computed verdict; product link parsing |
| `convex/notify.ts` | Price-drop email to the account holder, once per watch per price (not yet run live) |
| `convex/offers.ts` | Same item at other stores: candidates from search, user-confirmed offers (not yet run live) |
| `convex/limits.ts` | Caps and cooldowns that bound spend |
| `convex/tracking.ts` | Price dashboard query for the Board |
| `convex/examples.ts` | Labelled example records on `.example` domains |
| `convex/profiles.ts`, `inbound.ts`, `intake.ts` | Inbox per user, inbound routing, order intake and paste |
| `convex/drafts.ts`, `replies.ts`, `followUps.ts` | Drafts and approved send, reply classification, reminders |
| `convex/http.ts`, `convex.config.ts`, `auth.ts` | HTTP routes, components, Convex Auth |
| `src/pages/` | Board, Watching, Purchase, Claim, Settings, SignIn |
| `docs/plans/` | Design and implementation plan |
| `docs/team/DECISIONS.md` | Decisions D01 to D49; these override the original plan |
| `docs/ARCHITECTURE_PATTERNS.md` | House style for Convex code |
