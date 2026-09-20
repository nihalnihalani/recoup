# Recoup

Refund didn't add up? Price dropped after you bought? Recoup gets the difference back.

Recoup turns an order email into an item-level record, reads the store's own published policy, opens a claim for the exact gap (a short return credit or a price drop inside the adjustment window), sends one request with your approval, reads the reply, and tracks the money until you confirm it is on your card.

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
| `FIRECRAWL_API_KEY` | Policy search and scrape, product page price checks |
| `AGENTMAIL_API_KEY` | Inbox creation and outbound send |
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
| `convex/priceWatch.ts`, `crons.ts` | Six-hour price watch and check-now |
| `convex/profiles.ts`, `inbound.ts`, `intake.ts` | Inbox per user, inbound routing, order intake and paste |
| `convex/drafts.ts`, `replies.ts`, `followUps.ts` | Drafts and approved send, reply classification, reminders |
| `convex/http.ts`, `convex.config.ts`, `auth.ts` | HTTP routes, components, Convex Auth |
| `src/pages/` | Board, Purchase, Claim, Settings, SignIn |
| `docs/plans/` | Design and implementation plan |
| `docs/team/DECISIONS.md` | Decisions D01 to D49; these override the original plan |
| `docs/ARCHITECTURE_PATTERNS.md` | House style for Convex code |
