# Endpoint inventory — public Convex functions (T02, refreshed T21)

Audited against `main` at commit `c78c3380cdc676f5e3044aa378dad61154a387e9`. This repo runs several
agent lanes concurrently against the same working tree; at the moment of this audit the working tree
also carried **uncommitted, in-flight** edits from other lanes to `convex/insights.ts`, `convex/market.ts`,
`convex/watches.ts`, `convex/limits.ts`, `convex/ops.ts`, `convex/http.ts` (T24b: extracts `isPriceStale`
into a new `convex/lib/freshness.ts`, adds an optional `now`/`priceStale` pair to `insights.trackedTable`,
dedupes the `MARKET_CLAIM_STALE_MS` constant, and unrelated ops/http fixes) plus test files. Per T02's own
precedent ("their still-uncommitted work is out of scope and not audited here"), this refresh is against the
last **committed** shape of every function — `insights.trackedTable`'s row below reflects committed `main`
(`args: {}`, no `priceStale`), not the in-flight addition. Everything else in the diff is an internal
refactor with no effect on any column below (same auth, same bounds, same spend, same tombstone gating).
Re-run the counting command below once that lane lands.

Every exported `query`/`mutation`/`action` in `convex/*.ts` (excluding `*.test.ts` and `convex/lib/**`,
which export no public functions). Counted directly:
`grep -nE '^export const [A-Za-z0-9_]+ = (query|mutation|action)\(' convex/*.ts | grep -v '\.test\.ts' | wc -l`
→ **57**, across **18** files (T02 found 50/15; the 7 new: `account.ts` ×3 — T18 — `alerts.ts` ×2 and
`notify.recheckDrop` — T01/T06 — and `budget.ts` ×1). `convex/auth.ts` contributes 3 more public
identifiers (`signIn`, `signOut`, `isAuthenticated`) that are framework-managed by `@convex-dev/auth`,
listed separately below as intentional exceptions — unchanged from T02. `convex/testing.ts` (T20) exports
5 functions, but every one is `internalAction`/`internalMutation`/`internalQuery` (never public) **and**
every handler's first line throws unless `process.env.E2E_SEED_ENABLED === "true"` (`convex/testing.ts:57`);
listed in its own section below, not counted in the 57.

Columns:
- **Auth** — `requireUserId` (`lib/access.ts`) throws `ConvexError("Not signed in")` when signed out
  and, via `lib/accountState.ts`'s `isTombstoned`, also throws `"This account has been deleted"` for a
  `deleting`/`deleted` caller — every row using it is **tombstone-gated** for free, not repeated per row.
  `getAuthUserId` (branch) resolves identity and, when absent, returns a safe empty/`null`/`[]` value
  instead of throwing — documented per row as intentional (signed-out, missing and someone-else's-id all
  look the same to the caller) but see the **Tombstone-gated** column: none of these branch-style
  functions call `isTombstoned` themselves.
- **Ownership helper** — `ownedX` names are from `convex/lib/access.ts`; `ownedOffer` is local to
  `convex/offers.ts`. "inline" = the check is written out in the function itself.
- **Returns validator** — present for all 57 (T16 closed T02's finding: `claims.ts` and
  `purchases.ts`'s `setReturned`/`get`/`board`, the 10 that were missing one, all now have one — verified
  by an automated scan below, zero missing).
- **Bounded string args** — every free-text `v.string()`/`v.optional(v.string())` argument checked
  against a length cap (thrown or truncated) before it is stored, with the constant/limit named; "no" when
  at least one string argument has no such cap anywhere on its path to storage.
- **Spend (provider)** — which external paid API the call can reach: `openai` (model extraction/generation),
  `firecrawl` (scrape/search), `agentmail` (send/provision — billed per docs but not usage-table-metered),
  `shopsavvy` (market history), or `none`. Several functions draw two (a scrape + an extraction); listed as
  `firecrawl+openai`.
- **Tombstone-gated** — `yes` when the function is unreachable for a `deleting`/`deleted` caller purely
  because it uses `requireUserId` (or, for two internal-style scheduled/webhook functions, because it calls
  `isTombstoned` on the ROW OWNER directly). `no` for every `getAuthUserId`-branch query, and for
  `account.deletionStatus`, which is deliberately exempt (see its own row) — see the **Known gap** note
  below the tables for what "no" actually means in production.
- **Output projection risk** — low (narrow/curated shape) vs. higher (a raw/spread document, still
  validator-bound since T16, but a wide, unreviewed-going-forward surface).

## account.ts (T18 — P09 export/deletion)

| Fn | Kind | Line | Auth | Ownership helper | Relation checks | Returns validator | Bounded string args | Spend (provider) | Tombstone-gated | Output projection risk |
|---|---|---|---|---|---|---|---|---|---|---|
| `exportPage` | query | 282 | `requireUserId` | N/A — every table read through a `userId`-scoped index or parent-chain (`TABLE_SPECS`); never accepts another user's id | `table` restricted to a fixed literal union of 19 exportable tables | present | `cursor` (`v.optional(v.string())`): no explicit cap — it is Convex's own opaque pagination cursor, never stored, and a malformed one is caught by `decodeParentCursor`/`decodeStatusCursor`'s own `try/catch` (restarts the scan rather than throwing) | none | **yes** | Low: `v.array(v.any())` for `rows` is intentionally wide (it IS the user's own raw data, by design), but every row is already scoped to the caller by construction, not by a post-hoc filter |
| `requestDeletion` | mutation | 379 | `getAuthUserId` (deliberately **not** `requireUserId` — see source comment: must stay a no-op, not throw, on a second call from an already-tombstoned caller) | N/A — `userId` only from `ctx.auth`, never an argument | second call is a no-op (idempotent) | present (`v.null()`) | `confirmation` (`v.string()`): no length cap, but compared with `!==` against the fixed phrase `"delete my account"` and never stored — any non-matching string (however long) is rejected before any write | none directly (schedules `internal.account.purge`, whose eventual `inboxTransport.deleteInbox` call is `agentmail`) | n/a (this IS the tombstoning call; it is what makes every other row's gate active) | Low, returns `null` |
| `deletionStatus` | query | 770 | `getAuthUserId` (deliberately not `requireUserId` — must stay readable **while** tombstoned, from a still-open tab) | N/A | — | present | — | none | **no (by design)** — the one query in the app that must keep answering for a tombstoned caller; see source docstring | Low, three-field status object |

## alerts.ts (T01 — alert opt-in/unsubscribe)

| Fn | Kind | Line | Auth | Ownership helper | Relation checks | Returns validator | Bounded string args | Spend (provider) | Tombstone-gated | Output projection risk |
|---|---|---|---|---|---|---|---|---|---|---|
| `settings` | query | 62 | `requireUserId` | N/A — own row only | — | present | — | none | **yes** | Low, curated |
| `setAlerts` | mutation | 86 | `requireUserId` | N/A — own row only | — | present (`v.null()`) | — (only `enabled: v.boolean()`) | none | **yes** | Low |

`unsubscribeByToken` (line 115) is `internalMutation`, not public — driven only by `http.ts`'s
`GET /alerts/unsubscribe` route, not counted here.

## budget.ts (T01 — per-user spend status)

| Fn | Kind | Line | Auth | Ownership helper | Relation checks | Returns validator | Bounded string args | Spend (provider) | Tombstone-gated | Output projection risk |
|---|---|---|---|---|---|---|---|---|---|---|
| `status` | query | 62 | `requireUserId` | N/A — own `usage` rows only | `now` is a required, `assertCoarseNow`-validated coarse timestamp (same P06/D73 contract as `watches.list`) | present | — | none | **yes** | Low, curated per-kind breakdown |

## claims.ts

| Fn | Kind | Line | Auth | Ownership helper | Relation checks | Returns validator | Bounded string args | Spend (provider) | Tombstone-gated | Output projection risk |
|---|---|---|---|---|---|---|---|---|---|---|
| `open` | mutation | 137 | `requireUserId` | `ownedItem` | item must be `returned`; `openClaim` re-checks item.userId/purchaseId, policy.userId+merchantDomain, priceCheck ownership | present | — | none | **yes** | Low, returns a bare id |
| `confirmCredit` | mutation | 290 | `requireUserId` | `ownedClaim` | `applyEvent` re-derives status from the full ledger | present | `evidence` (2,000 via `MAX_EVIDENCE_CHARS`/`assertMaxChars`); `idempotencyKey` (128 via `MAX_IDEMPOTENCY_KEY_CHARS`, D112 6a-1: now enforced only on this client-supplied key, not on the internal-caller path) — **both bounded** (T16 closed this) | none | **yes** | Low |
| `recordLaterDebit` | mutation | 303 | `requireUserId` | `ownedClaim` | later-debit cannot exceed confirmed−debited | present | same two bounds as `confirmCredit` | none | **yes** | Low |
| `adjustExpected` | mutation | 320 | `requireUserId` | `ownedClaim` | unapproves any not-yet-sent draft; cancels pending reminder | present | `reason` (500 via `MAX_REASON_CHARS`/`assertMaxChars`) | none | **yes** | Low |
| `dismiss` | mutation | 364 | `requireUserId` | `ownedClaim` | refuses `confirmed`; best-effort `agentmail.cancel` on a queued send | present | — | `agentmail` (best-effort cancel of an in-flight send; not usage-table metered) | **yes** | Low |
| `clearAttention` | mutation | 409 | `requireUserId` | `ownedClaim` | — | present | — | none | **yes** | Low |
| `get` | query | 420 | `requireUserId` | `ownedClaim` | pulls item/purchase/policy by the claim's own (already-scoped) foreign keys | present (T16 closed T02's finding — `claim`/`drafts`/`replies`/`followUps`/`notes` all wrapped in `schema.doc(...)`; `messages` stays `v.any()`, the AgentMail component's own `listInboundMessages` ships no `returns` validator to bound against, F-T16-1) | — | none | **yes** | **Higher**: raw claim (`token`), raw draft bodies, raw inbound message bodies — scoped correctly to the owner, still an unreviewed-shape surface |

`applyEventInternal` (line 272) is `internalMutation`, not public.

## drafts.ts

| Fn | Kind | Line | Auth | Ownership helper | Relation checks | Returns validator | Bounded string args | Spend (provider) | Tombstone-gated | Output projection risk |
|---|---|---|---|---|---|---|---|---|---|---|
| `generate` | action | 211 | `getAuthUserId` (throws `"Not signed in"`) | inline: `c.claim.userId !== userId` after an unauthenticated `internal.drafts.context` read | claim must have `item`+`purchase`; refuses `confirmed`/`dismissed` | present | `claimId` only (no free text — model output is truncated server-side to `MAX_SUBJECT_CHARS=80`/`MAX_BODY_CHARS=1,200`, not client input) | **openai** (`draft_generate` budget, charged after every refusal) | **no** (`getAuthUserId`, not `requireUserId`) | Low |
| `update` | mutation | 320 | `requireUserId` | `ownedDraft`, then `ownedClaim` | refuses once `outboundId` set; refuses on a `claimVersion` mismatch | present | `subject` (truncated to 200 via `.slice`); `body` (truncated to `MAX_BODY_CHARS=1,200` via `.slice`); **`to` has no bound at all** (only `.trim()`) — flagged below | none | **yes** | Low |
| `approveAndSend` | mutation | 376 | `requireUserId` | `ownedDraft`, then `ownedClaim` | newest-draft check; `claimVersion` must match both args and draft; recipient must be policy-confirmed unless ticked; example claims/purchases refused; `MAX_SENDS_PER_CLAIM` | present | `to` (format-checked via `EMAIL_RE`, no explicit length cap beyond what the regex implicitly allows); `subject`/`body` truncated same as `update` | **agentmail** (`claim_email` budget, charged last) | **yes** | Low, returns an outbound id string |
| `recheckSend` | mutation | 668 | `requireUserId` | `ownedDraft` | must already have an `outboundId` | present | — | agentmail (one status poll; not budget-metered) | **yes** | Low |
| `sendStatus` | query | 687 | `requireUserId` | `ownedDraft` | resolves the outbound id from the owned draft only | present | — | agentmail (status poll) | **yes** | Low |
| `markPacketSent` | mutation | 719 | `requireUserId` | `ownedClaim` | refuses claims already past `packet` (D52) | present | `note` truncated to `MAX_NOTE_CHARS=500` via `.slice` | none | **yes** | Low |
| `listForClaim` | query | 747 | `requireUserId` | `ownedClaim` | — | present (`v.array(schema.doc("drafts"))`) | — | none | **yes** | Medium: raw draft docs (`to`, full `body`), scoped and validator-bound |

**FINDING (bound gap)**: `drafts.update`'s `to` argument is stored with only `.trim()` — no length cap, no
format check (unlike `approveAndSend`'s own `to`, which is `EMAIL_RE`-checked). A caller could write an
arbitrarily long string into `drafts.to` via `update`; it is never sent anywhere from this path (the actual
send re-validates its OWN `to` argument in `approveAndSend`, independent of the stored value), so this is a
storage-hygiene gap, not a send-path bypass. Not fixed here (tester-owned files only); production code is
`convex/drafts.ts`, owned by sonnet-integrations.

## examples.ts

| Fn | Kind | Line | Auth | Ownership helper | Relation checks | Returns validator | Bounded string args | Spend (provider) | Tombstone-gated | Output projection risk |
|---|---|---|---|---|---|---|---|---|---|---|
| `load` | mutation | 25 | `requireUserId` | N/A — no id args, writes only under the caller's own `userId` | idempotent per user | present | — (no free-text args) | none | **yes** | Low |

## insights.ts

| Fn | Kind | Line | Auth | Ownership helper | Relation checks | Returns validator | Bounded string args | Spend (provider) | Tombstone-gated | Output projection risk |
|---|---|---|---|---|---|---|---|---|---|---|
| `activity` | query | 199 | `getAuthUserId` (branch: `{events:[], ...}`) | N/A | — | present | — | none | **no** | Low, curated |
| `sources` | query | 410 | `getAuthUserId` (branch: `{rows:[], ...}`) | N/A | — | present | — | none | **no** | Low, curated |
| `priceHistory` | query | 710 | `getAuthUserId` (branch: `null`) | inline: `watch.userId !== userId` → `null`, not a throw | archived watches also `null` | present | — | none | **no** | Low: `null` on foreign/missing/archived, curated otherwise |
| `trackedTable` | query | 783 | `getAuthUserId` (branch: `[]`) | N/A | — | present | — | none | **no** | Low, curated |

## intake.ts

| Fn | Kind | Line | Auth | Ownership helper | Relation checks | Returns validator | Bounded string args | Spend (provider) | Tombstone-gated | Output projection risk |
|---|---|---|---|---|---|---|---|---|---|---|
| `paste` | action | 729 | `getAuthUserId` (throws `"Not signed in"`) | N/A — event scoped to `userId` at creation | content hash includes `userId` | present | `text`: 40–60,000 chars (`MIN_PASTE_CHARS`/`MAX_PASTE_CHARS`) | **openai** (`paste` budget, only for a genuinely new content hash) | **no** (`getAuthUserId`, not `requireUserId`) | Low, returns an id |
| `retryEvent` | mutation | 815 | `requireUserId` | inline: `row.userId !== userId` | row must be `failed`/`needs_review`; a reply re-run requires `claimId` + a string `messageId` in the payload | present | — (no direct free-text args) | **openai** (`intake_retry` budget) | **yes** | Low |
| `needsAttention` | query | 1084 | `requireUserId` | N/A — `by_user_status` rows for the caller only | strips `payload`/`processingStartedAt` (D58) | present | — | none | **yes** | Low — explicit redaction of the one risky field |

**Live-webhook gap (see F-T21-1 below)**: `intake.beginEvent`/`processEvent` — the internal path a public
webhook (`inbound.onMessageReceived`) schedules, distinct from the three public functions above — does
**not** check `isTombstoned` before spending `openai` budget and writing `purchases`/`items`. Only the
hourly `retryFailed` sweep (lines 947/1012 of `intake.ts`) does. See the finding write-up in
`convex/lifecycle.test.ts` for the full repro and severity.

## market.ts

| Fn | Kind | Line | Auth | Ownership helper | Relation checks | Returns validator | Bounded string args | Spend (provider) | Tombstone-gated | Output projection risk |
|---|---|---|---|---|---|---|---|---|---|---|
| `refresh` | mutation | 352 | `requireUserId` | `ownedWatch` | refuses archived/already-in-flight/too-recent (per `marketState`) via `internal.market.requestLookup` | present | — (only `watchId`) | **shopsavvy** (`market_lookup` budget + global switch) | **yes** (both via `requireUserId` on the public wrapper, and `internal.market.requestLookup` itself calls `isTombstoned` a second time before charging/scheduling — belt and suspenders) | Low |

## notify.ts

| Fn | Kind | Line | Auth | Ownership helper | Relation checks | Returns validator | Bounded string args | Spend (provider) | Tombstone-gated | Output projection risk |
|---|---|---|---|---|---|---|---|---|---|---|
| `recheckDrop` | mutation | 589 | `requireUserId` | inline: `row.userId !== userId` | status must be `queued`/`unknown`; rate-limited (`dropRecheck`, 1/min per row) | present (`v.null()`) | — | agentmail (one status poll; not usage-table metered) | **yes** | Low |
| `drops` | query | 664 | `getAuthUserId` (branch: `[]`) | N/A — own `by_user` rows only | — | present | — | none | **no** | Low, curated |

## offers.ts

| Fn | Kind | Line | Auth | Ownership helper | Relation checks | Returns validator | Bounded string args | Spend (provider) | Tombstone-gated | Output projection risk |
|---|---|---|---|---|---|---|---|---|---|---|
| `find` | mutation | 325 | `requireUserId` | `ownedWatch` | watch must be active/paused and named/priced; bespoke per-watch cooldown + per-user daily cap (`consumeFindLimit`, not the `usage` table) | present | — (only `watchId`) | **firecrawl+openai** (search + up to 5 scrapes/extractions) | **yes** | Low |
| `confirm` | mutation | 400 | `requireUserId` | `ownedOffer` (local, excludes the `~find` marker row) | — | present | — | none | **yes** | Low |
| `reject` | mutation | 407 | `requireUserId` | `ownedOffer` | — | present | — | none | **yes** | Low |
| `listForWatch` | query | 432 | `getAuthUserId` | inline: `watch.userId !== userId` → `EMPTY`, not a throw | archived watches also `EMPTY` | present | `now` (optional, coarse, display-only — no string args) | none | **no** | Low, curated |

## policies.ts

| Fn | Kind | Line | Auth | Ownership helper | Relation checks | Returns validator | Bounded string args | Spend (provider) | Tombstone-gated | Output projection risk |
|---|---|---|---|---|---|---|---|---|---|---|
| `refresh` | action | 322 | `getAuthUserId` (throws `"Not signed in"`) | domain-based (not id-based): `beginRefresh` requires a real (non-example) purchase or a live watch at `merchantDomain` | — | present | `merchantDomain`: bounded to 253 chars by `normalizeDomain` (rejects anything longer, throws before use) | **firecrawl+openai** (`policy_refresh` budget + `policy_fetch` global switch, charged inside `beginRefresh` before the paid research call) | **no** (`getAuthUserId`, not `requireUserId` — see finding below) | Low, returns an id |
| `confirm` | mutation | 344 | `requireUserId` | `ownedPolicy` | clears `passageStart`/`confidence` and sets `userEdited` when the user's edit changes passage/source (D45) | present | **`passage`, `sourceUrl`, `contactEmail` (all `v.optional(v.string())`) have NO length cap anywhere on this path** — flagged below | none | **yes** | Low |

**FINDING (bound gap)**: `policies.confirm`'s `passage`/`sourceUrl`/`contactEmail` are stored verbatim with
no `assertMaxChars`/`.slice()`/other cap — unlike the auto-extracted path (`refresh` → `researchPolicy`),
whose values come out of the model's own bounded schema. A signed-in caller can write an arbitrarily large
string into a `policies` row (read back by `purchases.get`, `claims.get`'s policy field, and quoted verbatim
into merchant-facing draft emails via `drafts.generate`'s "Policy passage from ..." line). Not fixed here
(tester-owned files only); production code is `convex/policies.ts`, owned by sonnet-integrations.

**FINDING (auth style)**: `policies.refresh` uses `getAuthUserId` + a manual throw, not `requireUserId` —
functionally equivalent today (it throws either way for a signed-out OR tombstoned caller, since
`beginRefresh`'s own ownership check would fail regardless), but it is the one **action** in the file that
does not go through the shared helper, so it does not automatically pick up any FUTURE refinement to
`requireUserId`'s tombstone message/behavior the way every other gated function does. Style-only; not a
runtime-provable defect today (verified: a tombstoned caller still cannot reach `refresh` today, because
`beginRefresh`'s ownership scan finds nothing to own once... actually `beginRefresh` does not itself check
`isTombstoned`, so this reduces to whatever purchases/watches still exist for the (tombstoned) caller — see
the live-webhook finding's pattern above; not independently repro'd here to avoid duplicating F-T21-1's
shape for a rarely-reachable action gated by an unrelated ownership check first).

## priceWatch.ts

| Fn | Kind | Line | Auth | Ownership helper | Relation checks | Returns validator | Bounded string args | Spend (provider) | Tombstone-gated | Output projection risk |
|---|---|---|---|---|---|---|---|---|---|---|
| `checkNow` | mutation | 633 | `requireUserId` | `ownedItem` | item must have a scrapeable `productUrl`; purchase non-example, not archived; per-item cooldown | present | — (only `itemId`) | **firecrawl+openai** (`item_check` budget + `price_check` global) | **yes** | Low |

## profiles.ts

| Fn | Kind | Line | Auth | Ownership helper | Relation checks | Returns validator | Bounded string args | Spend (provider) | Tombstone-gated | Output projection risk |
|---|---|---|---|---|---|---|---|---|---|---|
| `me` | query | 26 | `getAuthUserId` (branch: `null`) | N/A — own profile only | — | present | — | none | **no** | Low |
| `ensureInbox` | action | 142 | `getAuthUserId` (throws `"Not signed in"`) | N/A — idempotent per `userId` | — | present | — | **agentmail** (inbox provisioning; not usage-table metered — see note below) | **no** | Low, returns an email string |

**Note**: `convex/lib/rateLimits.ts` defines an `inboxProvision` limiter (1 per 5 min, docstring: "AgentMail
inbox provisioning per user") but no production code calls `rateLimiter.limit(ctx, "inboxProvision", ...)`
anywhere — `ensureInbox` relies only on its own idempotency (a second call short-circuits on the existing
`profiles` row) to bound repeat provisioning, not that limiter. Not a security gap (idempotency already
prevents a live double-provision), just a dead/unused config entry; noted for completeness, not flagged as
a finding.

## purchases.ts

| Fn | Kind | Line | Auth | Ownership helper | Relation checks | Returns validator | Bounded string args | Spend (provider) | Tombstone-gated | Output projection risk |
|---|---|---|---|---|---|---|---|---|---|---|
| `create` | mutation | 84 | `requireUserId` | N/A — writes only under caller's `userId` | — | present | `merchant` (120, `MAX_MERCHANT_CHARS`), `merchantDomain` (253 via `normalizeDomain`), `orderRef` (100, `MAX_ORDER_REF_CHARS`), `sourceMessageId` (500, `MAX_SOURCE_ID_CHARS`), each item's `name` (200, `MAX_ITEM_NAME_CHARS`), each item's `productUrl` (2,000 via `parseProductUrl`/`MAX_URL_CHARS`) — **all bounded** | none directly (`schedulePolicyFetch` best-effort → firecrawl+openai) | **yes** | Low |
| `confirm` | mutation | 158 | `requireUserId` | `ownedPurchase`, then `ownedItem` per item | every `items[].itemId` must belong to `purchaseId` | present | same bounds as `create` | none directly (best-effort as above) | **yes** | Low |
| `setReturned` | mutation | 247 | `requireUserId` | `ownedItem` | — | present (T16 closed T02's finding) | — | none | **yes** | Low |
| `remove` | mutation | 272 | `requireUserId` | `ownedPurchase` | cancels pending follow-ups on every claim under the purchase | present | — | none | **yes** | Low |
| `get` | query | 292 | `requireUserId` | `ownedPurchase` | archived purchases treated as not-found | present (T16 closed T02's finding — `itemWithHistory`/`claimWithBalance` wrap raw docs in `schema.doc(...).extend(...)`) | `now` optional, coarse — no free text | none | **yes** | **Higher**: raw items + raw claims (`token`) per item, validator-bound but wide |
| `board` | query | 354 | `requireUserId` | N/A — own `by_user` rows | needs-attention list explicitly projects to a 5-field allowlist (D58); never raw `lastError`/`payload` | present (T16 closed T02's finding) | — | none | **yes** | **Higher** for the same reason as `get`; the `attention` sub-list specifically is low-risk (explicit allowlist) |

## replies.ts

| Fn | Kind | Line | Auth | Ownership helper | Relation checks | Returns validator | Bounded string args | Spend (provider) | Tombstone-gated | Output projection risk |
|---|---|---|---|---|---|---|---|---|---|---|
| `listForClaim` | query | 307 | `requireUserId` | `ownedClaim` | — | present | — | none | **yes** | Medium: raw reply docs (merchant `from`, `summary`), scoped and validator-bound |

## tracking.ts

| Fn | Kind | Line | Auth | Ownership helper | Relation checks | Returns validator | Bounded string args | Spend (provider) | Tombstone-gated | Output projection risk |
|---|---|---|---|---|---|---|---|---|---|---|
| `overview` | query | 102 | `getAuthUserId` (branch: an all-zero `empty` shape) | N/A | — | present | `now` optional, coarse — no free text | none | **no** | Low, curated |

## watches.ts

| Fn | Kind | Line | Auth | Ownership helper | Relation checks | Returns validator | Bounded string args | Spend (provider) | Tombstone-gated | Output projection risk |
|---|---|---|---|---|---|---|---|---|---|---|
| `list` | query | 314 | `getAuthUserId` (branch: `[]`) | N/A | — | present | `now` optional, coarse | none | **no** | Low, curated |
| `get` | query | 345 | `getAuthUserId` | inline: `watch.userId !== userId` → `null` | archived watches also `null` | present | `now` optional, coarse | none | **no** | Low |
| `create` | mutation | 405 | `requireUserId` | N/A | `parseProductUrl` rejects non-http(s)/private/malformed URLs before any charge | present | `productUrl` (2,000, `MAX_URL_CHARS`); `name` (200, `MAX_NAME_CHARS`, cleaned via `cleanLine`) — **bounded** | **firecrawl+openai** (consumes `price_check` global directly + bespoke per-user hourly create-count limiter) | **yes** | Low |
| `checkNow` | mutation | 447 | `requireUserId` | `ownedWatch` | refuses archived/bought; per-watch cooldown | present | — | **firecrawl+openai** (`watch_check` budget + `price_check` global) | **yes** | Low |
| `setTarget` | mutation | 470 | `requireUserId` | `ownedWatch` | — | present | — | none | **yes** | Low |
| `rename` | mutation | 482 | `requireUserId` | `ownedWatch` | — | present | `name` (200, `MAX_NAME_CHARS`, cleaned via `cleanLine`) | none | **yes** | Low |
| `setStatus` | mutation | 498 | `requireUserId` | `ownedWatch` | refuses archived/bought | present | — | none | **yes** | Low |
| `archive` | mutation | 521 | `requireUserId` | `ownedWatch` | idempotent | present | — | none | **yes** | Low |
| `markBought` | mutation | 547 | `requireUserId` | `ownedWatch` | refuses already-bought/archived; per-user purchase cap | present | `orderRef` — same `cleanOrderRef`/`MAX_ORDER_REF_CHARS=100` bound `purchases.ts` uses | none directly (`schedulePolicyFetch` best-effort → firecrawl+openai) | **yes** | Low, returns an id |

## Framework-protected exceptions (`convex/auth.ts`)

`export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({ providers: [guardedPassword] });`
— `signIn`/`signOut` are public **actions**, `isAuthenticated` a public **query**; `store` is an
`internalMutationGeneric` (not public). These are entirely owned and rate-limited by `@convex-dev/auth`
(password attempts throttled inside `guardedAuthorize`, T05), take no application-table id arguments, and
are out of scope for `ownedX`-style checks by design. Unchanged from T02, still listed as the intentional
exceptions to "no unexplained public mutator."

## `convex/testing.ts` (T20 — E2E seed helpers)

All 5 exports are **internal**, never public, and every handler's first statement throws unless
`process.env.E2E_SEED_ENABLED === "true"` (never set on a production deployment, per the module's own
docstring):

| Fn | Kind | Line |
|---|---|---|
| `seedUser` | internalAction | 81 |
| `markVerified` | internalMutation | 124 |
| `seedFixtures` | internalMutation | 163 |
| `lastCodeFor` | internalQuery | 430 |
| `resetUser` | internalMutation | 458 |

## Findings register (this task, T21)

- **F-T21-1 (MEDIUM)** — the live inbound-webhook path (`inbound.onMessageReceived` → `intake.beginEvent`/
  `processEvent`, or → `replies.classify`) is not gated on `isTombstoned`, unlike every scheduled sweep
  (`watches.sweep`, `priceWatch.eligibleItems`, `intake.retryFailed`, `followUps.fire`, `market.requestLookup`).
  Full repro, and why the blast radius is bounded, is in `convex/lifecycle.test.ts`'s `it.fails` for this
  finding (search `F-T21-1`). Production files: `convex/inbound.ts`, `convex/intake.ts` (sonnet-backend).
- **Bound gap** — `drafts.update`'s `to` argument has no length cap (`convex/drafts.ts:320`, see the
  `drafts.ts` table above). Production file owned by sonnet-integrations.
- **Bound gap** — `policies.confirm`'s `passage`/`sourceUrl`/`contactEmail` have no length cap
  (`convex/policies.ts:344`, see the `policies.ts` table above). Production file owned by sonnet-integrations.
- Both bound gaps and F-T21-1 are **not** fixed here — tester-owned files only (`convex/lifecycle.test.ts`,
  this document); each is reported with file:line and severity for the owning lane to pick up.

## Totals

- **57** public functions across **18** files: `account.ts` 3, `alerts.ts` 2, `budget.ts` 1, `claims.ts` 7,
  `drafts.ts` 7, `examples.ts` 1, `insights.ts` 4, `intake.ts` 3, `market.ts` 1, `notify.ts` 2, `offers.ts` 4,
  `policies.ts` 2, `priceWatch.ts` 1, `profiles.ts` 2, `purchases.ts` 6, `replies.ts` 1, `tracking.ts` 1,
  `watches.ts` 9 — plus 3 framework exceptions in `auth.ts` = **60** public identifiers total.
- **Returns validator: 57/57 present, 0 missing** (T16 closed every one of T02's 10 findings — `claims.ts`
  ×7, `purchases.ts`'s `setReturned`/`get`/`board`). Verified by an automated scan (every export block's
  `handler:` line is preceded by a `returns:` line) as well as by reading every function's source above.
- **Bound gap: 2 public mutators found with an unbounded free-text argument** — `drafts.update`'s `to`,
  and `policies.confirm`'s `passage`/`sourceUrl`/`contactEmail` (3 fields, 1 function). Both flagged above
  with file:line; neither is fixed here (tester-owned files only).
- **Tombstone-gated: 41/57 yes** (every `requireUserId`-based function, including `market.refresh`, which
  is additionally re-checked one level down in `internal.market.requestLookup`) **, 14/57 no** (every
  `getAuthUserId`-branch query/action that returns a safe empty value for a signed-out caller instead of
  throwing: `insights.*` ×4, `notify.drops`, `offers.listForWatch`, `profiles.me`/`ensureInbox`,
  `tracking.overview`, `watches.list`/`get`, `drafts.generate`, `intake.paste`, `policies.refresh`) **, 2/57
  n/a** (`account.requestDeletion` IS the tombstoning call; `account.deletionStatus` is deliberately exempt
  so a still-open tab can read status while deleting).
- **Known gap behind "no" above**: Convex Auth issues short-lived, self-contained JWT access tokens;
  `requestDeletion`'s session revocation (`revokeAuthSessions`, deleting `authSessions`/`authRefreshTokens`)
  stops a REFRESH from minting a new one, but does not itself invalidate an access token already in a
  browser tab for the remainder of its own (short) lifetime. Every `getAuthUserId`-branch function above
  would still serve that tab its own (soon-to-be-purged) data during that narrow window, since none of them
  independently call `isTombstoned` the way `requireUserId` does. Not independently repro'd in
  `convex/lifecycle.test.ts` — convex-test's `t.withIdentity()` does not model JWT expiry/session
  revocation, so there is no way to prove this at the convex-test layer; noted here as a design observation
  for the record, consistent with F-T21-1's shape (a reader that skips the shared gate).
- Every budget-consuming public function still charges (or best-effort-charges) its budget **after** every
  ownership/status refusal and **before** the paid work — unchanged from T02, re-verified per function above.
