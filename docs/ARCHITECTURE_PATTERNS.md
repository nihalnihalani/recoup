# Convex architecture patterns for Recoup

Distilled from ClaimHero and bipolar, the two best-rated Convex architectures in the All Gas cohort. Implementers follow these unless the plan says otherwise.

## Schema
- One `convex/schema.ts`, `defineTable` per table, JSDoc comment on each table saying why it exists.
- Enum fields are `v.union(v.literal(...))`. Export the validators from `convex/schema.ts` (or `convex/lib/validators.ts`) and import them in functions: one source of truth.
- Every user-owned table has `userId: v.id("users")` and `index("by_user", ["userId"])`. Compound indexes list equality fields first, sort field last. Name `by_<a>_<b>`.
- Money is integer cents. Timestamps are epoch ms. Derived sums are computed in queries, never stored, unless the table is explicitly a counter.

## Auth and ownership
- Never call `ctx.auth.getUserIdentity()` inline. Use helpers in `convex/lib/access.ts`: `requireUserId(ctx)` throws `ConvexError("Not signed in")`; `ownedX(ctx, id, userId)` throws `ConvexError("X not found")` when missing or not owned. Actions use `getAuthUserId` and `ctx.runQuery(internal...)` because they have no `ctx.db`.
- A `profiles.me` style query returns `null` for signed-out callers instead of throwing where the UI needs to branch.

## Module layout
- `convex/lib/`: pure helpers (ledger math, AI schemas, access). Unit-testable without Convex where possible.
- Top-level `convex/<domain>.ts` per table: public `query`/`mutation`/`action` plus paired `internalMutation`/`internalAction` used by crons, webhooks and other actions.
- Internal functions live beside their public counterparts. Cron and webhook targets are always `internal.*`.
- `convex/mail.ts` holds the single `AgentMail` handle. `convex/http.ts` registers exact routes first and the static catch-all last.

## Actions calling external APIs
- Action: read via `ctx.runQuery(internal...)`, call the API, persist via `ctx.runMutation(internal...)`. On failure persist a failed state with the error message truncated to 1000 chars, then rethrow.
- Idempotency: dedupe by external id before writing (`processedEvents` for webhooks, `idempotencyKey` on ledger events, `replies.by_message`).
- LLM output is always a strict schema (zod via `responses.parse`). The user confirms proposed data; money arithmetic is deterministic in mutations.
- Rate-limit and size-cap anything public-facing. Fail closed: a failed check is a rejection, never a pass.

## Scheduling
- `convex/crons.ts` exports one `cronJobs()`. Cron targets are idempotent: a tick that is not due does nothing.
- Scheduled follow-ups re-read the row and check a version before acting. Cancel via `ctx.scheduler.cancel` and mark the row `cancelled`.

## Webhooks
- Verify signature first (the AgentMail component does Svix verification). Dedupe by event id. Return fast; schedule heavy work with `ctx.scheduler.runAfter(0, ...)`.
- Log rejections with ids and reasons, never secrets.

## Testing
- `convex-test` with `environment: "edge-runtime"` and `server.deps.inline: ["convex-test"]`. One `convex/test.setup.ts` exporting `setup()` (registers components) and `signedIn(t)` (inserts a user and returns `t.withIdentity`).
- Tests sit beside the module: `claims.ts` + `claims.test.ts`. Test business rules and invariants, not implementation details. Flush scheduled work with `t.finishAllScheduledFunctions(vi.runAllTimers)` only when the test needs it.

## Frontend
- `useQuery`/`useMutation`/`useAction` directly in components, no extra data layer.
- Auth gating with `<Authenticated>`, `<Unauthenticated>`, `<AuthLoading>` from `convex/react` at the top of `App.tsx`.
- `src/pages/` per route, `src/components/` for shared pieces. Keep `main.tsx` tiny.

## Commit cadence
- Commit after every plan step that leaves the tree compiling. Small commits with `feat:`, `test:`, `chore:`, `docs:`, `style:` prefixes.
