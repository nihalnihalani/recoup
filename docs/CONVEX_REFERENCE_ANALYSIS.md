# Convex reference analysis: ClaimHero and bipolar

Date: 2026-09-20. Sources: `ClaimHero/` (Best Architecture, 224.5) and `bipolar/` (second, 220.5), cloned and gitignored at the repo root. Both were read end to end at the signature level; citations are `repo/path:line`. This document is the evidence behind `docs/ARCHITECTURE_PATTERNS.md` and lists what Recoup's plan must change to match.

Rule for using the references: copy what **both** do, or what one does and the other's weakness list confirms. Neither repo is clean; each section below ends with what not to copy.

## 1. The two repos at a glance

| | ClaimHero | bipolar |
|---|---|---|
| Size | 27 tables, 90 indexes, 273 functions, ~40k lines | 30 tables, 62 indexes, 163 functions, ~24k lines |
| Layout | `convex/<domain>.ts` + `convex/actions/` (all `"use node"`) + `convex/lib/` | flat `convex/<domain>.ts` + `convex/lib/` (pure, no `ctx`) |
| Components | 13: static-hosting, rate-limiter, aggregate, firecrawl, auth, agentmail, workflow, agent, presence, action-retrier, workpool, batch-worker | 3 used: better-auth, static-hosting, rate-limiter (2 workpools declared, never used) |
| Auth | Convex Auth v2 alpha, role ladder in `lib/auth.ts` | Better Auth, `currentUser` / `requireUser` / `requirePermission` |
| Return validators | 26 of 273 | **157 of 157** |
| Tests | 84 files, hand-rolled `vi.fn()` mock db (no `convex-test`) | 28 files, `convex-test` + edge-runtime, co-located |
| LLM | `openai` SDK, JSON-schema `response_format`, classified retries | raw `fetch`, forced tool call, hostile-output normaliser, no retries |
| Inbound email | Yes: Svix verify, dedupe tables, re-fetch by id | None (outbound only) |
| Delayed follow-ups | `workflow` `step.sleep()` up to 90 days | None (`runAfter(0)` only) |

ClaimHero is the closer domain match (claims, AgentMail inbound, Firecrawl policy crawl, append-only audit chain). bipolar is the cleaner codebase (validators, bounded reads, tests, money ledger). Recoup should take **structure and discipline from bipolar, integration mechanics from ClaimHero**.

## 2. What both agree on (non-negotiable for Recoup)

1. **Domain files at the top level, pure logic in `lib/`.** A file is either Convex function registrations or it is `lib/` with no `ctx`. `bipolar/convex/topics.ts:270`, `ClaimHero/convex/lib/` (no function defs).
2. **Business logic is a plain `async function (ctx, ...)`; registrations are thin wrappers.** Public wrapper authorises, internal wrapper serves crons, webhooks and actions. `ClaimHero/convex/appeals.ts:173,324,350`; `bipolar/convex/voteWrite.ts:36` called from `votes.ts:58` and `telegramData.ts:68`. Hoist the shared `args` object so twins cannot drift (`ClaimHero/convex/workflows.ts:618-644`).
3. **Identity comes from `ctx.auth`, never from an argument.** No public function takes `userId`. `bipolar/convex/users.ts:23-38`. Internal functions are unauthenticated on purpose and say so in a comment (`ClaimHero/convex/actions/sentinelPipeline.ts:75-80`).
4. **Queries return `null` or `[]` for callers without access; mutations throw.** `ClaimHero/convex/lib/auth.ts:232` vs `:280`; `bipolar/convex/users.ts` `currentUser` vs `requireUser`.
5. **Actions never touch the db.** Read with `ctx.runQuery(internal...)`, call the API, write with one `ctx.runMutation(internal...)` that holds the whole transaction. `bipolar/convex/ingestStore.ts:14-19`, `bipolar/convex/images.ts:13-23` (pending query / resolve action / apply mutation).
6. **Webhook shape: verify, dedupe, ack fast, schedule the work with ids only.** `ClaimHero/convex/http.ts:39-242`, `bipolar/convex/telegram.ts:16-62`. Dedupe is re-checked **inside** the insert mutation, not only as a pre-check (`ClaimHero/convex/emails.ts:532-561`, `bipolar/convex/ingestStore.ts:166-171`).
7. **One `RateLimiter` instance with named buckets, each number justified in a comment**, keyed on server-resolved identity, consumed inside the mutation it guards. `ClaimHero/convex/lib/rateLimiter.ts:4-146`, `bipolar/convex/limits.ts:8-45`. Every public action that spends OpenAI or Firecrawl credit is limited.
8. **Static catch-all registered last in `http.ts`.** Both. Recoup already does this.
9. **Money is integer cents, time is epoch ms, ledgers append and never delete.** `bipolar/convex/schema.ts:9-16`, `bipolar/convex/retract.ts:26-29,89-101` (a refund row joins the spend row), `ClaimHero/convex/auditLogs.ts:342-461` (single `appendAuditLog` chokepoint).
10. **Progress reaches the UI as rows and a plain `useQuery`.** No polling, no SSE. Open the status row in the mutation *before* scheduling the action so the UI has something to watch immediately. `bipolar/convex/adminQueue.ts:178-179`, `ClaimHero/convex/pipelineActivities.ts:29-90`.
11. **Secrets are declared, not scattered.** ClaimHero declares them in `defineApp({ env })` with `v.optional` for keys that may be absent (`convex.config.ts:20-38`); bipolar keeps a typed `env.d.ts` and accessors so a missing key quiets one feature instead of crashing (`config.ts:267-278`).

## 3. Best single ideas from each

**From bipolar**
- `returns:` on every function (`votes.ts:48-54`). Cheapest way to make the client contract real. Derive client types with `FunctionReturnType<typeof api.x.y>`; bipolar hand-wrote them and paid in casts.
- LLM output is hostile: validate, clamp, enum-check, drop the whole shape on violation (`lib/openai.ts:167-221`). "The model never returns a number" it is trusted with (`lib/insight.ts:8-17`).
- Store the prior state on the event row so a reversal restores rather than recomputes (`schema.ts:756-765`).
- Claim-before-send outbound dedupe key `kind:userId:bucket` (`notify.ts:35-56,240`).
- Cron tick is not the cadence: tick often, handler decides if work is due, a not-due tick costs two reads (`crons.ts:16-23`, `ingest.ts:68-81`).
- Tests assert invariants, including the *absence* of data in a payload (`gate.test.ts:11-19`). Rate limiter registered in tests via `@convex-dev/rate-limiter/test`.

**From ClaimHero**
- Compact existence-check table for inbound message ids plus a negative cache for ignored mail, so unmatched mail never loops (`schema.ts:328-340`, `emails.ts:655-696`).
- Re-fetch the message from AgentMail by id; do not trust the webhook payload (`http.ts:176-181`).
- Deterministic idempotency keys with a dedicated index: `claimId:eventType:YYYY-MM-DD` (`auditLogs.ts:67-74,365-377`).
- Optimistic concurrency on a versioned table: `expectedVersion` mismatch fails fast (`appeals.ts:211-250`).
- Degradation modelled as data, not exceptions: a failed crawl sets a status and the pipeline continues (`workflows.ts:156-180,507-527`).
- Self-rescheduling bounded cascade deletes: delete a page of 50, reschedule if the page was full (`clinicalEvidences.ts:346-349`).
- Shared literal-union validators exported once with a `const [...] as const` array and derived TS type (`lib/statutoryTierValidators.ts:14-18,84-129`).
- Post-deploy smoke test that curls real routes (`.github/workflows/deploy.yml:76-91`).

## 4. What not to copy

| Anti-pattern | Where | Why it matters to Recoup |
|---|---|---|
| Hand-rolled mock db, and the `typeof ctx.db.x === "function"` / bare `catch {}` shims it forces into production code | ClaimHero `lib/auth.ts:131-184`, `claims.ts:295-298` | Use `convex-test` (already planned). |
| `take(N)` then sort or filter in memory for a global answer | bipolar `notify.ts:140-176`, `boards.ts:34`; ClaimHero `claims.ts:526-543` | Silently wrong past N. Index it. |
| Full-table read in a cron or per-second job | bipolar `simulateActs.ts:30,40` | **Our plan does this in `priceWatch.eligibleItems`.** |
| `v.any()` on an inbound payload | ClaimHero `emails.ts:971-972`, bipolar `telegramBot.ts:72` | **Our plan does this in `inbound.onMessageReceived` and `intake.applyExtraction`.** |
| `v.string()` status with values in a comment | ClaimHero `schema.ts:58` | Ours are unions already. Keep it that way. |
| Missing auth on a public action | ClaimHero `serviceCertificateResolver.ts:12-61`, `sentinelAgent.ts:414-460` | Task 13 grep must cover actions. |
| God module | ClaimHero `claims.ts` 3,882 lines | Split when a file passes ~400 lines. |
| Zero retries on external calls | bipolar `lib/openai.ts:143` | One classified retry on 429/5xx. |
| Declared but unused components and tables | bipolar `convex.config.ts:22-23`, `schema.ts:573` | Do not add a component until a function imports it. |
| Plain `Error` instead of `ConvexError` | ClaimHero (23 `ConvexError` in 273 functions) | Client ends up regex-stripping messages. |

## 5. Recoup plan versus the references

Checked against `docs/plans/2026-09-20-recoup.md` (counts are grep hits in the plan's code blocks).

**Already aligned:** domain-per-file with `lib/` pure ledger; `lib/access.ts` helpers; `openClaim` helper behind a public wrapper; `applyEventInternal` naming; `ConvexError` (31 uses); shared union validators exported from `schema.ts`; `by_a_b` index names; `processedEvents` with status (D10); `idempotencyKey` on ledger events; version-bound send (D11); co-located `convex-test` suites on edge-runtime; static catch-all last; single `MODEL` constant.

**Gaps, in priority order** (written before team decisions D13 to D35 landed; D17 already covers the verbatim-passage part of G8, D20 the cents checks, D28 resolves G6. D33 keeps `payload?: any` on `processedEvents`, which G3 still argues against: store a typed object of the retry fields D14 lists):

| # | Gap | Evidence in plan | Change |
|---|---|---|---|
| G1 | **No return validators.** 1 `returns:` in the whole plan. | every function in Tasks 4 to 10 | Add `returns:` to every `query`/`mutation`/`action`. Export row validators from `schema.ts` (`purchaseDoc`, `itemDoc`, `claimDoc`, `balanceValidator`) and reuse. Frontend types come from `FunctionReturnType`. This also removes most of the 16 `any` hits in the frontend task. |
| G2 | **Full-table scan in the price-watch cron.** `ctx.db.query("items").collect()` across all users, then N `get`s and N policy lookups, then a sequential loop of actions inside one action. | plan line 1772, 1790-1796 | Denormalise `items.watchUntil: v.optional(v.number())` (set when the purchase is active, has a `productUrl`, and a price-adjustment policy with `windowDays` exists; cleared on return or window end). Index `by_watch_until`. Cron target becomes an `internalMutation` that reads `withIndex("by_watch_until", q => q.gt("watchUntil", now)).take(100)` and fans out with `ctx.scheduler.runAfter(i * 2000, internal.priceWatch.checkItem, { itemId })`. No action-calls-action loop; one slow page cannot time out the sweep. |
| G3 | **`v.any()` at trust boundaries.** | plan lines 181, 1424, 1485 | `onMessageReceived` keeps the component's arg shape but the handler reads only `eventId`, message id, inbox id and thread id through a narrowing function in `lib/inboundShape.ts` that returns `null` on a bad shape (unit-tested). `applyExtraction.parsed` becomes a real `v.object` mirroring the zod `Order` schema. |
| G4 | **No rate limiting on anything that spends credits.** | not present | Add `@convex-dev/rate-limiter`, one `convex/limits.ts`. Buckets: `intakePaste` (per user), `checkNow` (per item), `policyRefresh` (per user+domain), `draftGenerate` (per claim), `inboundPerInbox` (per verified inbox id). Consume inside the mutation that schedules the action. Register in `test.setup.ts`. |
| G5 | **Actions run with no visible state.** `purchases.create` schedules `policies.fetchBoth`; the UI sees nothing until a policy row appears, and a failure is invisible. | plan lines 772-776 | The mutation inserts the `policies` row (or a `policyRuns` row) with `status: "fetching"` before scheduling. The action finishes it as `found`, `unknown` or `failed` with a truncated error. Same for `priceChecks` (`note` already exists; add `status`). Partial failure is data. |
| G6 | **Follow-up scheduling hack.** Schedules with `followUpId: "pending" as any`, cancels, reschedules. | plan lines 1056-1070 | **Resolved by D28** (2026-09-21): schedule-first with `fire({ claimId })`, then insert the row with the returned id. One scheduler call, no `any`, schema stays strict. `fire` re-reads the claim before acting, which matches ClaimHero's re-read-then-act. |
| G7 | **Env contract declares one key.** | `convex/convex.config.ts:8` | Declare all: `FIRECRAWL_API_KEY: v.string()`, and `OPENAI_API_KEY`, `AGENTMAIL_API_KEY`, `AGENTMAIL_WEBHOOK_SECRET`, `SITE_URL` as `v.optional(v.string())` so the deployment stays healthy without them (consistent with D12c). Read them through accessors in `convex/lib/env.ts`; features fail closed with a clear `ConvexError` when a key is absent. |
| G8 | **LLM output trusted after zod parse.** | `lib/ai.ts` `extract` | Add a `normalise` step per schema in `lib/ai.ts`: cents must be non-negative integers under a sane cap, currency must match the purchase, `contactEmail` must parse and its domain must relate to `merchantDomain` or be flagged, `passage` must be a substring of the scraped markdown (this enforces "verbatim"), `windowDays` within 1 to 365. Violations drop to `unknown`/`needs_review`. One classified retry on 429/5xx only. |
| G9 | **Unbounded `.collect()` on the board.** 32 `.collect()` in the plan. Per-claim children (events, drafts, replies) are naturally small and fine. The per-user purchase list and the cascade delete are not bounded. | plan lines 822-838, 872 | `board` takes the most recent 100 purchases and returns `capped: boolean`. `purchases.remove` deletes children in pages and reschedules itself if a page was full. |
| G10 | **Typed helper signatures.** `claimsWithBalance(ctx: any, itemId: any)`. | plan line 842 | `ctx: QueryCtx`, `itemId: Id<"items">`. No `any` in `convex/`. |

**Deliberately not adopting:** `@convex-dev/workflow` for follow-ups (scheduler + stored id + version check is enough for reminder-only follow-ups, D03, and avoids a pinned-version component two days before deadline); workpool, action-retrier, aggregate, batch-worker (no current need; bipolar shows the cost of declaring unused components); ClaimHero's `actions/` directory (we have no known Node-only dependency. The `openai` SDK is fetch-based and is expected to bundle for the default runtime, but this is unverified here: ClaimHero only ever imports it from `"use node"` files. If `npx convex dev` rejects it, the files that import `lib/ai.ts` move to `convex/actions/` with `"use node"`, which is exactly ClaimHero's layout); hash-chained ledger (our invariant is "user-confirmed credit", not tamper evidence).

## 6. Target layout for `convex/`

```
convex/
  convex.config.ts      components + full env contract (G7)
  schema.ts             tables, exported union validators, exported doc validators (G1)
  http.ts               auth routes, /agentmail/webhook, static catch-all last
  crons.ts              one cronJobs(); targets are internal and idempotent
  limits.ts             the one RateLimiter (G4)
  auth.ts  auth.config.ts  mail.ts
  purchases.ts  claims.ts  drafts.ts  followUps.ts
  intake.ts  inbound.ts  policies.ts  priceWatch.ts  profiles.ts  examples.ts
  lib/
    access.ts           requireUserId, ownedX; nullable variants for queries
    ledger.ts           pure money math (done in Task 3)
    ai.ts               MODEL, zod schemas, extract(), normalise() (G8)
    inboundShape.ts     narrow the AgentMail callback payload (G3)
    env.ts              key accessors (G7)
  *.test.ts             beside the module; test.setup.ts registers components
```

Function shape for every domain file:

```ts
const openArgs = { itemId: v.id("items"), type: claimType, expectedCents: v.number() };

export async function openClaim(ctx: MutationCtx, userId: Id<"users">, a: ...): Promise<Id<"claims">> { /* rule */ }

export const open = mutation({ args: openArgs, returns: v.id("claims"),
  handler: async (ctx, a) => openClaim(ctx, await requireUserId(ctx), a) });

/** Unauthenticated on purpose: called by the price-watch sweep, which resolved the owner from the item. */
export const openInternal = internalMutation({ args: { ...openArgs, userId: v.id("users") }, returns: v.id("claims"),
  handler: async (ctx, { userId, ...a }) => openClaim(ctx, userId, a) });
```
