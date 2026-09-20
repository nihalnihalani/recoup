# Convex architecture patterns for Recoup

Distilled from ClaimHero and bipolar, the two best-rated Convex architectures in the All Gas cohort. Implementers follow these unless the plan says otherwise. Evidence, citations and the gap list against our plan (G1 to G10) are in `docs/CONVEX_REFERENCE_ANALYSIS.md`; where the plan's code blocks disagree with this file, this file wins.

## Schema
- One `convex/schema.ts`, `defineTable` per table, JSDoc comment on each table saying why it exists.
- Enum fields are `v.union(v.literal(...))`. Export the validators from `convex/schema.ts` (or `convex/lib/validators.ts`) and import them in functions: one source of truth.
- Every user-owned table has `userId: v.id("users")` and `index("by_user", ["userId"])`. Compound indexes list equality fields first, sort field last. Name `by_<a>_<b>`.
- Also export document and return-shape validators (`claimDoc`, `balanceValidator`, ...) so `returns:` is one import, not a retyped object.
- No `v.any()` on anything that arrives from outside (webhook callbacks, LLM output passed between functions). Narrow in a pure `lib/` function that returns `null` on a bad shape.
- A cron or sweep never reads a whole table. Denormalise the field the sweep needs (for example `items.watchUntil`) and index it.
- Money is integer cents. Timestamps are epoch ms. Derived sums are computed in queries, never stored, unless the table is explicitly a counter.

## Auth and ownership
- Never call `ctx.auth.getUserIdentity()` inline. Use helpers in `convex/lib/access.ts`: `requireUserId(ctx)` throws `ConvexError("Not signed in")`; `ownedX(ctx, id, userId)` throws `ConvexError("X not found")` when missing or not owned. Actions use `getAuthUserId` and `ctx.runQuery(internal...)` because they have no `ctx.db`.
- Identity comes from `ctx.auth` only. No public function takes a `userId` argument. Internal functions that take `userId` carry a comment saying they are unauthenticated on purpose and who calls them.
- Queries return `null` or `[]` when the caller has no access; mutations and actions throw.
- A `profiles.me` style query returns `null` for signed-out callers instead of throwing where the UI needs to branch.

## Module layout
- `convex/lib/`: pure helpers (ledger math, AI schemas, access). Unit-testable without Convex where possible.
- Top-level `convex/<domain>.ts` per table: public `query`/`mutation`/`action` plus paired `internalMutation`/`internalAction` used by crons, webhooks and other actions.
- Every `query`, `mutation` and `action`, public or internal, declares `args` and `returns`.
- The rule lives in an exported plain `async function (ctx, userId, args)`. The public registration authorises then calls it; the `xInternal` twin calls it directly. Both share one hoisted `args` object.
- No `any` in `convex/`. Helpers take `QueryCtx`/`MutationCtx` and `Id<"table">`.
- Split a domain file when it passes roughly 400 lines.
- Internal functions live beside their public counterparts. Cron and webhook targets are always `internal.*`.
- `convex/mail.ts` holds the single `AgentMail` handle. `convex/http.ts` registers exact routes first and the static catch-all last.

## Actions calling external APIs
- Action: read via `ctx.runQuery(internal...)`, call the API, persist via `ctx.runMutation(internal...)`. On failure persist a failed state with the error message truncated to 1000 chars, then rethrow.
- Idempotency: dedupe by external id before writing (`processedEvents` for webhooks, `idempotencyKey` on ledger events, `replies.by_message`).
- LLM output is always a strict schema (zod via `responses.parse`). The user confirms proposed data; money arithmetic is deterministic in mutations.
- Before scheduling an action, the mutation writes the row the UI will watch with a `fetching`/`pending` status. The action ends it as a success state, `unknown`, or `failed`. Partial failure is a stored state, not only a thrown error.
- After schema parsing, LLM output goes through a `normalise` step: integer non-negative cents under a cap, bounded `windowDays`, `passage` must be a substring of the scraped text, emails must parse. A violation downgrades to `unknown` or `needs_review`. One retry, only on 429 or 5xx.
- Secrets are declared in `defineApp({ env })` (`v.optional` for keys the deployment can boot without) and read through accessors in `convex/lib/env.ts`. A missing key disables one feature with a clear `ConvexError`.
- One `RateLimiter` in `convex/limits.ts` with named buckets, each number justified in a comment, keyed on server-resolved identity, consumed inside the mutation that schedules the spend. Every public path that costs OpenAI or Firecrawl credit has a bucket.
- Rate-limit and size-cap anything public-facing. Fail closed: a failed check is a rejection, never a pass.

## Scheduling
- `convex/crons.ts` exports one `cronJobs()`. Cron targets are idempotent: a tick that is not due does nothing.
- A sweep is an `internalMutation` that reads a bounded page off an index and fans out with `ctx.scheduler.runAfter(i * stagger, ...)`. No action looping over `ctx.runAction`.
- Follow-ups are schedule-first (D28): `runAt(fireAt, internal.followUps.fire, { claimId })`, then insert the row with the returned id. The job is keyed by `claimId`, so no placeholder id and no `as any`.
- Deleting a parent deletes children in bounded pages and reschedules itself when a page was full.
- Scheduled follow-ups re-read the row and check a version before acting. Cancel via `ctx.scheduler.cancel` and mark the row `cancelled`.

## Webhooks
- Verify signature first (the AgentMail component does Svix verification). Dedupe by event id. Return fast; schedule heavy work with `ctx.scheduler.runAfter(0, ...)`.
- Pass ids only to the scheduled job and re-check the dedupe inside the writing mutation; a pre-check alone is a race.
- Log rejections with ids and reasons, never secrets.

## Testing
- `convex-test` with `environment: "edge-runtime"` and `server.deps.inline: ["convex-test"]`. One `convex/test.setup.ts` exporting `setup()` (registers components) and `signedIn(t)` (inserts a user and returns `t.withIdentity`).
- Components with a test helper (`@convex-dev/rate-limiter/test`, AgentMail, Firecrawl) are registered in `setup()`.
- Assert absence as well as presence: another user's purchase is not in the payload, a promise does not reduce `unresolved`.
- Tests sit beside the module: `claims.ts` + `claims.test.ts`. Test business rules and invariants, not implementation details. Flush scheduled work with `t.finishAllScheduledFunctions(vi.runAllTimers)` only when the test needs it.

## Frontend
- `useQuery`/`useMutation`/`useAction` directly in components, no extra data layer.
- Component prop types come from `FunctionReturnType<typeof api.x.y>` and `Doc<>`/`Id<>`. No hand-written copies of server shapes, no `any`.
- `"skip"` for queries whose args are not ready. Loading is `data === undefined`, never separate state.
- Auth gating with `<Authenticated>`, `<Unauthenticated>`, `<AuthLoading>` from `convex/react` at the top of `App.tsx`.
- `src/pages/` per route, `src/components/` for shared pieces. Keep `main.tsx` tiny.

## Commit cadence
- Commit after every plan step that leaves the tree compiling. Small commits with `feat:`, `test:`, `chore:`, `docs:`, `style:` prefixes.
