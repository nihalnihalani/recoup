# Endpoint inventory — public Convex functions (T02)

Audited against `main` at commit `3db122a` (the last commit landed by a concurrent lane as this task finished). Other lanes were actively committing to `main` throughout this task (T01's schema/limits/rate-limiter/tombstone slices, T03's frontend fixes); per this task's instructions, their concurrent work is tracked as it lands but their still-**uncommitted** work is out of scope and not audited here — in particular `convex/alerts.ts`/`convex/alerts.test.ts` existed uncommitted in the working tree at the time of this audit (two more public functions, `alerts.settings` and `alerts.setAlerts`) and are deliberately excluded from the counts and tables below, since they belong to a different in-flight task and had not landed on `main`. Re-run the counting command below after future lands to catch drift.

Every exported `query`/`mutation`/`action` in `convex/*.ts` (excluding `*.test.ts` and `convex/lib/**`, which export no public functions). Counted directly: `grep -nE '^export const [A-Za-z0-9_]+ = (query|mutation|action)\(' convex/*.ts | wc -l` → **50**, across **15** files. `convex/auth.ts` is the 16th file and contributes 3 more public identifiers (`signIn`, `signOut`, `isAuthenticated`) that are framework-managed by `@convex-dev/auth`, listed separately below as intentional exceptions per the P08 checklist, not counted in the 50.

Columns:
- **Identity check** — how the caller's identity is resolved. `requireUserId` (lib/access.ts) throws `ConvexError("Not signed in")` when signed out, and (as of a concurrent T01 landing during this task, commit `3db122a`) also refuses a tombstoned account after resolving the session — every function below listed as using `requireUserId` inherits that refusal automatically, so it is not repeated per row. `getAuthUserId` (branch) resolves identity and, when absent, returns a safe empty/`null` value instead of throwing (documented per-function as intentional: signed-out, missing and someone-else's-id all look the same to the caller).
- **Ownership helper** — the specific check that ties the caller to the row(s) the args name. `ownedX` names are from `convex/lib/access.ts` (`ownedPurchase`, `ownedItem`, `ownedClaim`, `ownedPolicy`, `ownedDraft`, `ownedWatch`); `ownedOffer` is a local equivalent in `convex/offers.ts` (not in `lib/access.ts`). "inline" means the check is written out in the function itself rather than via a shared helper.
- **Relation checks** — secondary cross-references beyond "does this row belong to me" (e.g. "does this item belong to this purchase").
- **Args validator** — present for all 50 (Convex requires it; spot-confirmed for every row below).
- **Returns validator** — present/absent. Absent means the function's output shape has no server-enforced contract; a future field added to the underlying table/helper flows straight to the client unreviewed.
- **Spend/budget path** — the `usage`-table budget kind charged (see `convex/limits.ts` `DAILY_BUDGETS`/`GLOBAL_DAILY_BUDGETS`, charged via `convex/lib/budget.ts`), or the bespoke limiter used instead, or "none".
- **Output projection risk** — whether the response is a narrow, purpose-built shape (low risk) or includes a raw/spread document with no validator bounding it (higher risk — not necessarily a cross-user leak, since ownership is checked first, but an unreviewed and growing surface).

## claims.ts

| Fn | Kind | Line | Identity check | Ownership helper | Relation checks | Args validator | Returns validator | Spend/budget | Output projection risk |
|---|---|---|---|---|---|---|---|---|---|
| `open` | mutation | 121 | `requireUserId` | `ownedItem` | item must be `returned`; `openClaim` re-checks item.userId/purchaseId, and (if present) policy.userId+merchantDomain, priceCheck.userId+itemId | present | **absent** | none | Returns a bare `Id<"claims">` — low risk despite the missing validator |
| `confirmCredit` | mutation | 236 | `requireUserId` | `ownedClaim` | `applyEvent` re-derives status from the full ledger | present | **absent** | none | Returns `{deduped, status}` (small, low risk) |
| `recordLaterDebit` | mutation | 245 | `requireUserId` | `ownedClaim` | same as above; `applyEvent` refuses a later-debit exceeding confirmed−debited | present | **absent** | none | Same as above |
| `adjustExpected` | mutation | 260 | `requireUserId` | `ownedClaim` | re-derives status from balance; unapproves any not-yet-sent draft on the claim | present | **absent** | none | Returns `undefined`/`null`; low risk |
| `dismiss` | mutation | 301 | `requireUserId` | `ownedClaim` | refuses a `confirmed` claim; best-effort `agentmail.cancel` on a queued send | present | **absent** | none | Returns nothing; low risk |
| `clearAttention` | mutation | 344 | `requireUserId` | `ownedClaim` | — | present | **absent** | none | Returns nothing; low risk |
| `get` | query | 353 | `requireUserId` | `ownedClaim` | pulls item/purchase/policy by the claim's own foreign keys (already scoped) | present | **absent** | none | **Higher**: returns the raw `claim` doc (includes `token`, the value later matched out of inbound-reply subjects), raw `drafts` (recipient `to`, full `body` text), and `messages` — every inbound message on the claim's AgentMail thread via `components.agentmail.lib.listInboundMessages` (full email bodies). Correctly scoped to the owner (no cross-user leak found), but nothing bounds the shape if any of these grow new fields. |

**FINDING**: every one of the 7 functions above has no `returns` validator (`claims.ts` has zero). This reproduces `docs/reviews/2026-09-21-phase0-reproduction.md` row "(args/returns line item of the P08 checklist)... claims.ts has ZERO returns validators", already tracked; not re-flagged with `it.fails` here since it is not a runtime-provable defect (nothing crashes; the risk is an unreviewed contract), and the phase-0 review already recorded it as `partially_present`/medium.

## drafts.ts

| Fn | Kind | Line | Identity check | Ownership helper | Relation checks | Args validator | Returns validator | Spend/budget | Output projection risk |
|---|---|---|---|---|---|---|---|---|---|
| `generate` | action | 209 | `getAuthUserId` (throws `Not signed in`) | inline: `c.claim.userId !== userId` after an unauthenticated `internal.drafts.context` read | claim must have both `item` and `purchase`; refuses `confirmed`/`dismissed` claims | present | present (`v.id("drafts")`) | `draft_generate` (charged in `internal.budget.consume`, **after** the ownership/status checks, before the model call) | Low (returns an id) |
| `update` | mutation | 318 | `requireUserId` | `ownedDraft`, then `ownedClaim` | refuses once `draft.outboundId` is set; refuses if `claim.version !== draft.claimVersion` | present | present (`v.null()`) | none | Low |
| `approveAndSend` | mutation | 374 | `requireUserId` | `ownedDraft`, then `ownedClaim` | draft must be the newest version on the claim; `claim.version` must match both `args.claimVersion` and `draft.claimVersion`; refuses example claims/purchases; recipient must be policy-confirmed unless ticked | present | present (`vOutboundId`) | `claim_email` (charged last, after every refusal path) | Low (returns an outbound id string) |
| `recheckSend` | mutation | 591 | `requireUserId` | `ownedDraft` | must already have an `outboundId` | present | present (`v.null()`) | none | Low |
| `sendStatus` | query | 609 | `requireUserId` | `ownedDraft` | resolves the outbound id from the owned draft, never from the caller | present | present | none | Low, narrow shape |
| `markPacketSent` | mutation | 641 | `requireUserId` | `ownedClaim` | refuses claims already past `packet` (D52) | present | present (`v.null()`) | none | Low |
| `listForClaim` | query | 669 | `requireUserId` | `ownedClaim` | — | present | present (`v.array(schema.doc("drafts"))`) | none | Medium: raw draft docs (recipient `to`, full `body`) but correctly scoped to the owning claim and the shape is validator-bound |

## examples.ts

| Fn | Kind | Line | Identity check | Ownership helper | Relation checks | Args validator | Returns validator | Spend/budget | Output projection risk |
|---|---|---|---|---|---|---|---|---|---|
| `load` | mutation | 25 | `requireUserId` | N/A — no id args; writes only under the caller's own `userId` | idempotent per user (checks for an existing `isExample` purchase first) | present | present | none | Low; no id argument, so no foreign-id surface at all |

## insights.ts

| Fn | Kind | Line | Identity check | Ownership helper | Relation checks | Args validator | Returns validator | Spend/budget | Output projection risk |
|---|---|---|---|---|---|---|---|---|---|
| `activity` | query | 104 | `getAuthUserId` (branch: `[]` when signed out) | N/A — no id args, reads only the caller's own rows by `userId` index | — | present | present | none | Low, curated event shape |
| `sources` | query | 267 | `getAuthUserId` (branch: `[]`) | N/A | — | present | present | none | Low, curated |
| `priceHistory` | query | 529 | `getAuthUserId` (branch: `null`) | inline: `watch.userId !== userId` → returns `null`, **not a throw** | archived watches also return `null` | present | present | none | Low: `null` on foreign/missing/archived, otherwise a curated shape (also pulls the watch's confirmed offers, correctly scoped by `confirmedOffers(ctx, watchId, userId)`) |
| `trackedTable` | query | 593 | `getAuthUserId` (branch: `[]`) | N/A — no id args | — | present | present | none | Low, curated |

## intake.ts

| Fn | Kind | Line | Identity check | Ownership helper | Relation checks | Args validator | Returns validator | Spend/budget | Output projection risk |
|---|---|---|---|---|---|---|---|---|---|
| `paste` | action | 607 | `getAuthUserId` (throws `Not signed in`) | N/A — no id args; the event is scoped to `userId` at creation | content hash includes `userId`, so two users pasting the same email are two independent events | present | present (`v.id("processedEvents")`) | `paste` (charged in `internal.intake.createPasteEvent`, only for a genuinely new hash) | Low (returns an id) |
| `retryEvent` | mutation | 693 | `requireUserId` | inline: `row.userId !== userId` | row must be `failed`/`needs_review`; a reply re-run requires `row.claimId` + a string `messageId` in the payload | present | present (`v.null()`) | `intake_retry` | Low |
| `needsAttention` | query | 859 | `requireUserId` | N/A — reads only `by_user_status` rows for the caller | deliberately strips `payload` and `processingStartedAt` before returning (D58) | present | present (`v.array(attentionRow)`) | none | Low — explicit redaction of the one field (`payload`, up to 60 KB of raw email) that would otherwise be a real risk |

## market.ts

| Fn | Kind | Line | Identity check | Ownership helper | Relation checks | Args validator | Returns validator | Spend/budget | Output projection risk |
|---|---|---|---|---|---|---|---|---|---|
| `refresh` | mutation | 258 | `requireUserId` | `ownedWatch` | refuses archived watches and a watch already looked up (`marketFetchedAt` set) | present | present (`v.null()`) | `market_lookup` (also draws the `market_lookup` global switch) | Low |

## notify.ts

| Fn | Kind | Line | Identity check | Ownership helper | Relation checks | Args validator | Returns validator | Spend/budget | Output projection risk |
|---|---|---|---|---|---|---|---|---|---|
| `drops` | query | 423 | `getAuthUserId` (branch: `[]`) | N/A — no id args, reads only `by_user` rows | — | present | present (`v.array(dropView)`) | none | Low, curated |

## offers.ts

| Fn | Kind | Line | Identity check | Ownership helper | Relation checks | Args validator | Returns validator | Spend/budget | Output projection risk |
|---|---|---|---|---|---|---|---|---|---|
| `find` | mutation | 272 | `requireUserId` | `ownedWatch` | watch must be active/paused and named/priced | present | present (`v.null()`) | **not** the `usage` table: a bespoke per-watch cooldown + per-user daily count read directly off `offers` rows (`consumeFindLimit`); a rejected call writes no marker row | Low |
| `confirm` | mutation | 325 | `requireUserId` | `ownedOffer` (local to offers.ts, excludes the `~find` marker row) | — | present | present (`v.null()`) | none | Low |
| `reject` | mutation | 332 | `requireUserId` | `ownedOffer` | — | present | present (`v.null()`) | none | Low |
| `listForWatch` | query | 349 | `getAuthUserId` | inline: `watch.userId !== userId` → returns the `EMPTY` shape, **not a throw** | archived watches also return `EMPTY` | present | present (`offersForWatch`) | none | Low: identical empty shape for signed-out/missing/foreign/archived; curated `offerView` fields otherwise |

## policies.ts

| Fn | Kind | Line | Identity check | Ownership helper | Relation checks | Args validator | Returns validator | Spend/budget | Output projection risk |
|---|---|---|---|---|---|---|---|---|---|
| `refresh` | action | 274 | `getAuthUserId` (throws `Not signed in`) | domain-based, not id-based: `internal.policies.beginRefresh` requires a non-example purchase or a live watch at `merchantDomain` for the caller | — | present | present (`v.id("policies")`) | `policy_refresh` (also draws the `policy_fetch` global switch); charged inside `beginRefresh`, before the paid research call | Low (returns an id) |
| `confirm` | mutation | 289 | `requireUserId` | `ownedPolicy` | clears `passageStart`/`confidence` and sets `userEdited` when the user's edit changes the passage/source (D45) | present | present (`v.null()`) | none | Low |

## priceWatch.ts

| Fn | Kind | Line | Identity check | Ownership helper | Relation checks | Args validator | Returns validator | Spend/budget | Output projection risk |
|---|---|---|---|---|---|---|---|---|---|
| `checkNow` | mutation | 504 | `requireUserId` | `ownedItem` | item must have a scrapeable `productUrl`; purchase must be non-example and not archived; per-item cooldown | present | present (`v.null()`) | `item_check` (also draws the `price_check` global switch) | Low |

## profiles.ts

| Fn | Kind | Line | Identity check | Ownership helper | Relation checks | Args validator | Returns validator | Spend/budget | Output projection risk |
|---|---|---|---|---|---|---|---|---|---|
| `me` | query | 26 | `getAuthUserId` (branch: `null`) | N/A — no id args, reads only the caller's own profile | — | present | present | none | Low |
| `ensureInbox` | action | 142 | `getAuthUserId` (throws `Not signed in`) | N/A — no id args; idempotent per `userId` (`internal.profiles.save` keeps the first-written profile on a race) | — | present | present (`v.string()`) | none (no `usage` row; naturally bounded to once per user since it is idempotent) | Low (returns an email string) |

## purchases.ts

| Fn | Kind | Line | Identity check | Ownership helper | Relation checks | Args validator | Returns validator | Spend/budget | Output projection risk |
|---|---|---|---|---|---|---|---|---|---|
| `create` | mutation | 54 | `requireUserId` | N/A — no id args; writes only under the caller's `userId` | — | present | present (`v.id("purchases")`) | none directly; `schedulePolicyFetch` best-effort draws `policy_fetch` (never throws on refusal) | Low (returns an id) |
| `confirm` | mutation | 128 | `requireUserId` | `ownedPurchase`, then `ownedItem` per item | **every** `items[].itemId` must belong to `purchaseId` (checked per item, so a caller's own purchase with someone else's item id is refused mid-loop before any patch) | present | present (`v.null()`) | none directly; `schedulePolicyFetch` best-effort | Low |
| `setReturned` | mutation | 196 | `requireUserId` | `ownedItem` | — | present | **absent** | none | Low (returns nothing) |
| `remove` | mutation | 214 | `requireUserId` | `ownedPurchase` | cancels pending follow-ups on every claim under the purchase | present | present (`v.null()`) | none | Low |
| `get` | query | 234 | `requireUserId` | `ownedPurchase` | refuses archived purchases (treated as not-found) | present | **absent** | none | **Higher**: returns raw `items` and, per item, `claims: claimsWithBalance(...)` which spreads the raw claim doc (including `token`) plus its derived `balance`. No cross-user leak (all scoped to the owned purchase), but unbounded by a validator. |
| `board` | query | 281 | `requireUserId` | N/A — reads only `by_user` rows | needs-attention rows explicitly project down to `{_id, status, kind, summary, attempts, errorSummary}` (no raw `lastError`/`payload`) | present | **absent** | none | **Higher** for the same reason as `get` (raw purchases/items/claims-with-token across the whole board), mitigated for the `attention` sub-list specifically by its explicit field allowlist |

**FINDING**: `setReturned`, `get` and `board` have no `returns` validator (3 of 6 in this file); combined with `claims.ts`, this is the full set of 10 functions (of 50) missing a returns validator, matching the phase-0 P08 finding.

## replies.ts

| Fn | Kind | Line | Identity check | Ownership helper | Relation checks | Args validator | Returns validator | Spend/budget | Output projection risk |
|---|---|---|---|---|---|---|---|---|---|
| `listForClaim` | query | 273 | `requireUserId` | `ownedClaim` | — | present | present (`v.array(schema.doc("replies"))`) | none | Low-medium: raw reply docs (merchant `from` address, `summary`), scoped and validator-bound |

## tracking.ts

| Fn | Kind | Line | Identity check | Ownership helper | Relation checks | Args validator | Returns validator | Spend/budget | Output projection risk |
|---|---|---|---|---|---|---|---|---|---|
| `overview` | query | 57 | `getAuthUserId` (branch: an all-zero `empty` shape) | N/A — no id args | — | present | present | none | Low, curated |

## watches.ts

| Fn | Kind | Line | Identity check | Ownership helper | Relation checks | Args validator | Returns validator | Spend/budget | Output projection risk |
|---|---|---|---|---|---|---|---|---|---|
| `list` | query | 248 | `getAuthUserId` (branch: `[]`) | N/A — no id args | — | present | present (`v.array(watchSummary)`) | none | Low, curated |
| `get` | query | 279 | `getAuthUserId` | inline: `watch.userId !== userId` → returns `null`, **not a throw** | archived watches also return `null` | present | present | none | Low: `null` on foreign/missing/archived, curated shape otherwise |
| `create` | mutation | 338 | `requireUserId` | N/A — no id args | `parseProductUrl` rejects non-http(s)/private/malformed URLs before anything is charged | present | present (`v.id("watches")`) | consumes the `price_check` global switch directly (`consumeGlobalBudget`, not a per-user `usage` kind) + a bespoke per-user hourly create-count limiter off the `watches` table itself | Low (returns an id) |
| `checkNow` | mutation | 380 | `requireUserId` | `ownedWatch` | refuses archived/bought watches; per-watch cooldown | present | present (`v.null()`) | `watch_check` (also draws `price_check` global) | Low |
| `setTarget` | mutation | 403 | `requireUserId` | `ownedWatch` | — | present | present (`v.null()`) | none | Low |
| `rename` | mutation | 415 | `requireUserId` | `ownedWatch` | — | present | present (`v.null()`) | none | Low |
| `setStatus` | mutation | 431 | `requireUserId` | `ownedWatch` | refuses archived/bought watches | present | present (`v.null()`) | none | Low |
| `archive` | mutation | 454 | `requireUserId` | `ownedWatch` | idempotent | present | present (`v.null()`) | none | Low |
| `markBought` | mutation | 480 | `requireUserId` | `ownedWatch` | refuses already-bought/archived watches; per-user purchase cap | present | present (`v.id("purchases")`) | none directly; `schedulePolicyFetch` best-effort | Low (returns an id) |

## Framework-protected exceptions (`convex/auth.ts:4`)

`export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({ providers: [Password] });` — `signIn` and `signOut` are public **actions**, `isAuthenticated` a public **query**; `store` is an `internalMutationGeneric` (not public). These are entirely owned and rate-limited by `@convex-dev/auth` (password attempts are throttled inside the provider itself), take no application-table id arguments, and are out of scope for `ownedX`-style checks by design — listed here, per the P08 checklist, as the intentional exceptions to "no unexplained public mutator."

## Totals

- 50 public functions across 15 files (`claims.ts` 7, `drafts.ts` 7, `examples.ts` 1, `insights.ts` 4, `intake.ts` 3, `market.ts` 1, `notify.ts` 1, `offers.ts` 4, `policies.ts` 2, `priceWatch.ts` 1, `profiles.ts` 2, `purchases.ts` 6, `replies.ts` 1, `tracking.ts` 1, `watches.ts` 9) plus 3 framework exceptions in `auth.ts` = 53 public identifiers total.
- Returns validator: **40 present / 10 absent** (all 7 in `claims.ts`; `setReturned`/`get`/`board` in `purchases.ts`).
- 34 functions take at least one other table's id as an argument. Of those, **31 throw** a fixed, generic "not found" message for a foreign id (via an `ownedX` helper or an equivalent inline check) and **3 return a null/empty value instead of throwing** (`insights.priceHistory`, `offers.listForWatch`, `watches.get`) — each documented in its own source comment as intentional, and none observed to leak any owner-specific field in either case (see `convex/boundary.test.ts`).
- `policies.refresh` is a 35th "ownership-shaped" check that is domain-based rather than id-based (`beginRefresh`).
- Every budget-consuming public function charges (or best-effort-charges) its budget **after** every ownership/status refusal and **before** the paid work, so a foreign-id or unauthenticated call is always a zero-spend no-op — verified for every applicable function in `convex/boundary.test.ts`.
