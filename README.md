# Recoup

Price dropped after you bought? Recoup checks the store's own price-adjustment policy and helps you ask for the difference. Haven't bought yet? It watches the price at the stores you add and tells you when it falls.

Recoup checks supported recovery paths. Today that means a lower price inside a store's own price-adjustment window. This check is tested; live verification is still pending.

That sentence is generated from the rule-pack activation data (`src/lib/coverageCopy.ts`; the pack is `R01.retail_price_adjustment` v1, activated in D186, live verification pending per D196), and a test fails if it goes stale or if any page claims a path that is not active. Code packs for late online orders (R05), airline refunds (R02) and delayed, lost or damaged bags (R04) exist but are not active, so the product does not check them yet. The other paths in the mission's list of 25, card billing errors (R03) included, are not checked.

Before you buy: paste a product link, and Recoup reads the price, keeps a history with the source and time of every read, and gives a one-line verdict computed from that history (good price, fair, wait, discount looks inflated, or not enough history yet).

After you buy: forward or paste the order email, upload a receipt, or enter the purchase yourself. Recoup reads the store's own published price-adjustment policy, watches the product page while the window is open, and when the price drops it shows the recovery path with its evidence: the authority behind it (a store's policy is the store's promise, not a law), an estimate that is never a guarantee, the deadline and the source. You approve every message before it goes out; Recoup reads the reply and tracks the money until you confirm it arrived. A refund email for a returned item is recorded as a promised refund only after you confirm it with one tap, because the sender of an email cannot be verified.

Since Mission 2, every purchase is also a transaction with facts (each labelled confirmed, observed, read from a document but not confirmed, or disputed), stored evidence, and recovery opportunities evaluated by versioned rule packs. Flights and card charges can be entered by hand today; no recovery path is checked for them until their packs are activated. The dashboard adds money up only per currency and never adds alternative paths for the same loss together.

What Recoup promises:

- No affiliate links and no sponsored ranking.
- You approve every message before it is sent. Recoup never files claims in bulk.
- Money only counts when you confirm it arrived. A promise is shown as a promise.
- Every price shows where and when it was read. Every policy shows the exact sentence it came from.
- Recoup is not a law firm and does not represent you. It never promises that money will come back.

**Status:** Recoup runs on this repo's dev deployment only (`adorable-lion-138`), with placeholder provider keys. Deploying to production is not authorized in this mission (`docs/team/DECISIONS.md` D191); the only deploy path is the gated `npm run deploy:dev` (`docs/ops/RUNBOOK.md` §13). A production deployment named in older docs, `cool-oyster-399`, is not claimed to be current. Reading uploaded documents is switched off (D145), so an uploaded file is stored, not read. There is no billing, no pricing and no paid plan.

Built for the Convex All Gas hackathon. The original submission write-up, architecture and honest limits are in [`hackathon.md`](./hackathon.md).

## Local development

Requires a recent Node LTS and a Convex account.

```sh
npm install
npx convex dev     # terminal 1: creates/links a dev deployment, writes .env.local, pushes functions
npm run dev        # terminal 2: Vite on http://localhost:5173
```

Sign up with an email and password on the sign-in page. The Settings page creates and shows your Recoup inbox address; the Add page takes pasted emails, uploads and manual entries.

## The gate

All of these must pass before anything is called done:

```sh
npm test
npm run typecheck
npm run typecheck:e2e
npm run lint -- --max-warnings=0
npm run build
node scripts/check-rule-packs.mjs
```

Tests run with `vitest` and `convex-test`. They do not touch the network; OpenAI, Firecrawl and AgentMail are stubbed or registered as test components (`convex/test.setup.ts`).

## Environment variables

Client-side, in `.env.local` (see `.env.example`; `npx convex dev` writes them):

- `VITE_CONVEX_URL`
- `VITE_CONVEX_SITE_URL` (the HTTP-actions origin: auth routes and the evidence upload and download routes)

Server-side secrets live only in the Convex deployment. Set each one with `npx convex env set NAME value`. Never put values in the repo, in `.env.example`, or in docs.

**Full reference, every var grepped from the source (required vs optional, safe defaults, what fails closed and how, the E2E flag's production refusal): [`docs/ops/ENVIRONMENT.md`](./docs/ops/ENVIRONMENT.md).** Short version:

| Name | Used for |
|---|---|
| `OPENAI_API_KEY` | Extraction, classification, drafting |
| `FIRECRAWL_API_KEY` | Policy search and scrape, product page price reads for owned and watched items |
| `AGENTMAIL_API_KEY` | Inbox creation and outbound send. The key is bound into the AgentMail component by a patch-package patch (`patches/`) |
| `AGENTMAIL_WEBHOOK_SECRET` | Verifying the inbound webhook at `/agentmail/webhook` |
| `ALERTS_INBOX_ID` | Which AgentMail inbox sends auth verification/reset codes (required for those) and price-drop alert mail (optional there; falls back to the recipient's own inbox) |
| `SHOPSAVVY_API_KEY` | Third-party price-history lookups. Fully optional: unset just turns that one panel off, with no error |
| `APP_URL` | Where a price-drop alert email links back to. Optional: falls back to `SITE_URL`, and omits the link entirely rather than ever printing a `localhost` URL |
| `JWT_PRIVATE_KEY`, `JWKS`, `SITE_URL` | Convex Auth (set by `npx @convex-dev/auth`) |

The deployment stays healthy without the optional provider keys above: every call site fails closed at call time rather than crashing an unrelated request. `AGENTMAIL_WEBHOOK_SECRET` is the one exception worth knowing about precisely: unset, the inbound webhook route answers a bare 500 (not a clean 401) because the component's own config check throws before signature verification runs — see `docs/ops/RUNBOOK.md` §6. No inbound event is ever applied either way.

To receive mail, create an AgentMail webhook for received messages that points at `https://<your-deployment>.convex.site/agentmail/webhook` and set its signing secret as `AGENTMAIL_WEBHOOK_SECRET`.

## Where things are

| Path | What |
|---|---|
| `convex/schema.ts` | Tables and the shared enum validators |
| `convex/lib/ledger.ts`, `money.ts`, `balance.ts` | Pure ledger and money logic (integer minor units, explicit currency); derived claim balance |
| `convex/lib/access.ts` | Identity from `ctx.auth` and ownership checks |
| `convex/lib/schemas.ts`, `ai.ts` | Zod schemas for model output; OpenAI client and model id |
| `convex/lib/passage.ts`, `policyText.ts` | Verbatim passage verification and policy page selection |
| `convex/purchases.ts`, `claims.ts` | Purchases, items, board; claims, ledger events and non-cash remedies |
| `convex/transactions.ts`, `facts.ts`, `convex/lib/facts/` | Mission 2: transactions, the fact catalogue, fact states and the single fact writer |
| `convex/evidence.ts`, `convex/http.ts` | Stored evidence; the upload and download routes (`/evidence/upload`, `/evidence/file`) |
| `convex/lib/rules/`, `convex/lib/deadlines/` | Versioned rule packs, activation data, coverage, the outcome engine and the deadline engine |
| `convex/opportunities.ts`, `recovery.ts` | Recovery opportunities and case opening; the per-currency recovery summary behind the dashboard |
| `convex/policies.ts` | Policy research with Firecrawl, immutable snapshots |
| `convex/priceWatch.ts`, `crons.ts` | Price reads for owned items and check-now; the cron schedule (`convex/crons.ts` is the source of truth) |
| `convex/watches.ts`, `convex/lib/verdict.ts`, `watchUrl.ts` | Watched items not bought yet; the computed verdict; product link parsing |
| `convex/notify.ts`, `offers.ts` | Price-drop email to the account holder; the same item at other stores |
| `convex/limits.ts` | Caps and cooldowns that bound spend |
| `convex/examples.ts` | Labelled example records on `.example` domains |
| `convex/profiles.ts`, `inbound.ts`, `intake.ts` | Inbox per user, inbound routing, email intake and paste |
| `convex/drafts.ts`, `replies.ts`, `followUps.ts` | Drafts, the prepared and approved send, reply classification, reminders |
| `convex/account.ts`, `retention.ts`, `convex/lib/privacyFacts.ts` | Export, deletion and retention; the statements the Privacy page shows |
| `src/pages/` | Board, Add, Transaction, Opportunities, Watching, Purchase, Claim, Settings, Privacy, SignIn |
| `src/lib/coverageCopy.ts` | What the product may say it checks, derived from the activation data |
| `docs/plans/`, `docs/prompts/` | Design and implementation plans; the Mission 2 brief |
| `docs/ops/` | Environment variable reference, operator runbook, install and release notes |
| `docs/team/DECISIONS.md` | Decisions D01 onward; these override the original plan |
| `docs/ARCHITECTURE_PATTERNS.md` | House style for Convex code |
