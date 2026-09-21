# Pre-launch security review of the price-first modules, 2026-09-20

Read-only review by the Convex reviewer agent before the first public production deploy. Nothing was run. Status of each finding is tracked in the commit that fixes it.

## BLOCKER

### B1. Open mail relay through example claims, with no send cap
Files: `drafts.ts:341-430`, `examples.ts:115,198`.

- **What is wrong:**
  - `approveAndSend` sends to any address the caller supplies when `recipientConfirmed: true` (`drafts.ts:373-387`).
  - It never checks `claim.isExample`; `isExample` appears nowhere in `drafts.ts`.
  - `examples.ts:21-22` says the `.example` contacts mean "no real mail can be sent by accident", but `to` is caller-supplied.
  - The only status guard is `queued`, `confirmed` or `dismissed` (`drafts.ts:368-371`). Once `reconcileSend` moves the claim to `sent` about 30s later, another send is allowed.
  - `args.body` is not length-capped at send (`drafts.ts:395`), although `update` caps it at 1,200 characters (`drafts.ts:304`).
- **Abuse:** sign up, call `profiles.ensureInbox`, `examples.load` (two claims) and `drafts.generate`, then `approveAndSend({to: victim, subject: <anything>, body: <anything>, recipientConfirmed: true})`. Repeat generate and send forever. That is thousands of fully attacker-written emails per account per day from your AgentMail domain, which gets the domain blocklisted.
- **Minimal fix:**
  1. Throw in `approveAndSend` and `generate` when `claim.isExample || purchase.isExample`.
  2. Add a per-user daily outbound cap (about 10 a day), counted off `drafts` via a new `by_user` index with an `approvedAt` range, plus a per-claim cap, in the same mutation.
  3. `body.slice(0, MAX_BODY_CHARS)`, and strip CR/LF from the subject.

### B2. Drop alerts go to an unverified address
Files: `auth.ts:4-6`, `notify.ts:112-119`, `notify.ts:159-164`.

- **What is wrong:** `Password` is configured with no `verify` step, so `users.email` is whatever the signer typed. `sendDrop` is correctly limited to `users.email`, but that address proves nothing.
- **Abuse:**
  - Sign up as `victim@corp.com`, call `ensureInbox`, then `watches.create({productUrl: attacker page, name: "<phishing text>", targetCents: 99999999})`.
  - `isAlertableDrop` fires on the first accepted price when it is at or under the target (`notify.ts:59-61`). The victim gets "Price drop: <attacker text>" containing the attacker's link (`notify.ts:186`).
  - The attacker's page can change its price on every check, which defeats `watch:<id>:<cents>`.
  - The cap is 20 mails a day per account, and accounts are unlimited.
- **Minimal fix:** add email verification (the Password `verify` option with an OTP provider), and in `claimDrop` and `dropContext` refuse to mail unless `user.emailVerificationTime` is set. Until that ships, store the alert as `failed` and show it in-app only.

### B3. `policies.refresh` has no cap, no domain validation and bypasses the freshness check
File: `policies.ts:223-230`.

- **What is wrong:**
  - It is a public action that calls `researchPolicy` directly: one Firecrawl search that scrapes 3 pages, plus up to 3 OpenAI extractions per call.
  - `merchantDomain` is an unvalidated `v.string()`. It goes into the search query and `includeDomains`, and it is stored.
  - There is no `returns` validator.
- **Abuse:** `while(true) refresh({merchantDomain: random, kind})` is unbounded spend from one free account. It also piles up unbounded `policies` rows.
- **Minimal fix:**
  1. Turn it into a mutation that requires `normalizeDomain(...)`.
  2. Require the domain to belong to one of the caller's purchases.
  3. Enforce `POLICY_REFETCH_MIN_AGE_MS` (or 1 hour) per domain and kind, plus a per-user daily cap.
  4. Then schedule an internal action.

### B4. `purchases.create` and `purchases.confirm` schedule `fetchBoth` with no cap, and nothing limits purchases or items
Files: `purchases.ts:21-70`, `purchases.ts:72-127`, `watches.ts:479`.

- **What is wrong:**
  - Each call schedules 2 searches (3 scrapes each) and up to 6 extractions.
  - The 24-hour freshness check is per domain, so random domains defeat it.
  - `confirm` can be re-called on the same purchase with a new `merchantDomain` every time.
  - The `items` array and the `name` and `productUrl` strings are unbounded.
  - `watches.markBought` reaches the same spend: the 20-per-hour create rate allows about 480 `fetchBoth` a day per user.
- **Abuse:** a loop of `create` calls with random domains. This also sets up H1.
- **Minimal fix:**
  1. A per-user daily `fetchBoth` budget, consumed in the scheduling mutation.
  2. Cap purchases per user, items per purchase (about 50) and string lengths.
  3. Schedule from `confirm` only when the domain actually changed.

### B5. `intake.paste`, `intake.retryEvent` and `drafts.generate` make uncapped OpenAI calls
Files: `intake.ts:508-529`, `intake.ts:563-604`, `drafts.ts:186-241`.

- **What is wrong:**
  - `paste`: every distinct text up to 60,000 characters is one model call, with no per-user limit.
  - `retryEvent` re-runs any `needs_review` row, which is the normal outcome for an order, with no cooldown. It also resets `attempts: 0` (`intake.ts:599`), which voids `MAX_ATTEMPTS`.
  - `generate`: one call and one new `drafts` row per invocation, unbounded. The rows are later `.collect()`ed in `drafts.ts:261-264` and `insights.ts:195-198`.
- **Abuse:** a script does 10 pastes a second at about 15k tokens each.
- **Correctness bug on the same path:** re-running an order event that already inserted a purchase inserts a second purchase when the email has no `orderRef`. `applyOrder` has no "already applied" guard (`intake.ts:222-240`).
- **Minimal fix:**
  1. Per-user daily counters enforced inside `createPasteEvent`, inside `retryEvent`, and in a new mutation that gates `generate`. `generate` checks nothing transactionally today.
  2. Do not reset `attempts`.
  3. Refuse to retry an intake event that already produced a purchase (check by `sourceMessageId` or store the `purchaseId` on the row).

## HIGH

### H1. `priceWatch.checkNow` is effectively uncapped and lets one account starve the global cron
Files: `priceWatch.ts:497-517`, `priceWatch.ts:171-187`.

- **What is wrong:**
  - The cooldown only looks at a recorded check (`priceWatch.ts:505-512`). Every call made in the 15-30 seconds before the first record passes; the code comment at `priceWatch.ts:492-495` admits this.
  - There is no per-user cap, and items are unbounded (B4).
  - `eligibleItems` reads the newest 500 items globally and fans out at most 50.
- **Abuse:**
  - An attacker creates a purchase with 1,000 items, then calls `policies.confirm({windowDays: 3650})` on their own snapshot.
  - Their items then take all 50 slots on every 2-hour tick. Real users' items are never checked, and the attacker gets 600 scrapes a day.
  - On top of that, `checkNow` runs once a minute per item.
- **Minimal fix:**
  1. Stamp `checkRequestedAt` on the item, as `watches.checkNow` does.
  2. Add a per-user daily cap.
  3. Give items an indexed `nextCheckAt` plus a per-user slice in the fan-out.

### H2. `watches.checkNow` has a per-watch cooldown but no per-user budget
Files: `watches.ts:308-326`, `limits.ts:18`.

- 50 watches × 6 checks an hour is 7,200 scrapes and extractions a day per account.
- The cooldown stamp is transactional and correct. Archive-and-recreate is bounded by the 20-per-hour create cap, which is good.
- **Minimal fix:** a per-user daily manual-check cap of about 30, counted in the same mutation.

### H3. `limits.ts` budgets are stale by a factor of three
File: `limits.ts:10,20,32,36,48,64`.

- **What is wrong:**
  - The comments assume 4 checks a day, but `WATCH_CHECK_INTERVAL_MS` is 2 hours, which is 12 a day.
  - That works out to 600 paid checks per user per day, not 200.
  - The `DROP_EMAIL_COUNT_SCAN = 200` rationale of "sees the whole window" is no longer true. It fails closed, so an over-count produces a false "daily limit" rather than too much mail.
- **Sustained worst case per account:** 600 sweep checks, 480 create checks, 7,200 manual checks and 480 `fetchBoth` a day. Add B3-B5 on top.
- **Minimal fix:** decide the real per-user ceiling, add a global daily kill-switch counter, and throttle sign-ups.

### H4. `retryFailed` blocks at the head of the queue
File: `intake.ts:637-642`.

- **What is wrong:**
  - `take(RETRY_PAGE)` on `by_status = "failed"` returns the oldest 50 rows.
  - Rows with `attempts >= MAX_ATTEMPTS` or no `userId` stay `failed` forever and are skipped with `continue`.
  - Once 50 such rows exist, no newer failed row is ever retried. The safety net silently stops working.
- **Minimal fix:** move exhausted rows to a terminal status such as `dead`. Alternatively, index `["status","attempts"]` and query `attempts < MAX`.

### H5. Stuck detection uses `_creationTime`, not the time processing started
File: `intake.ts:631-633`.

- **What is wrong:** any old row that is `processing` at tick time is marked `failed` immediately, even if it was retried one second earlier by `retryEvent`. The same transaction then sets it back to `received` and schedules a second `processEvent`.
- **Failure:** if that second `beginEvent` runs before the first action finishes, both extractions call `applyOrder`, and you get a duplicate purchase when there is no `orderRef`.
- **Minimal fix:** add `processingStartedAt` in `beginEvent` and in the reply branch, and compare against that.

## MEDIUM

### M1. Item URLs bypass `lib/watchUrl.ts` entirely
Files: `purchases.ts:18,60,119`, `intake.ts:253`.

- `items.productUrl` is stored from an arbitrary client string. Intake only checks `startsWith("http")`.
- The URL is then scraped by `checkItem`.
- **Minimal fix:** run `parseProductUrl` at every write.

### M2. SSRF validator is sound for literals, with gaps in internal names
File: `lib/watchUrl.ts:14-31`.

- **Sound:**
  - Scheme allow-list and credential rejection.
  - WHATWG `URL` canonicalises decimal, hex, octal and short IPv4 to a dotted quad, which the TLD regex rejects.
  - Bracketed IPv6, including `::ffff:` mapped addresses, fails `DOMAIN_RE`.
  - Single-label hosts such as `localhost` fail because `DOMAIN_RE` needs two labels (`policyText.ts:70`).
  - A trailing dot is handled.
- **Gaps:**
  - `.local`, `.internal`, `.localhost`, `.lan`, `.corp` and `.home.arpa` pass. For example, `metadata.google.internal` passes.
  - Public names that resolve to private IPs (nip.io, DNS rebinding) pass.
  - Any port is allowed.
  - Redirects are not controlled.
- **Real severity:** LOW for your own infrastructure, because Firecrawl performs the fetch. The remaining risk is abuse of your Firecrawl key or its terms of service.
- **Minimal fix:** add a suffix deny-list, and restrict ports to default, 80 or 443.

### M3. `Date.now()` inside reactive queries
Files: `watches.ts:202,220`, `offers.ts:358`, `tracking.ts` (the `overview` handler).

- `checking`, `searching`, `nextFindAt` and `watching` are not re-evaluated as time passes.
- If a search dies, `searching` stays true until some unrelated write invalidates the query. `SEARCH_PENDING_MS` never fires on its own.
- **Minimal fix:** pass a coarse `now` argument from the client, or have the action always finish the marker.

### M4. Heavy reactive fan-out on every check
- **Read volume:**
  - `watches.list` reads up to 50 × 60 `watchChecks` (`watches.ts:203-205`).
  - `insights.priceHistory` reads 30 × up to 100 `offers` rows just to build the `options` counts (`insights.ts:536-538`).
  - `trackedTable` reads 30 × (100 + 40 + 8×20) rows (`insights.ts:600-602`).
  - `activity` and `sources` are similar.
- **Invalidation:** each of these is invalidated by every `watchChecks` insert for the user, which is 600 a day.
- It stays under Convex read limits, but it is expensive in bandwidth and function calls.
- **Minimal fix:** denormalise the verdict inputs and the confirmed-offer count onto `watches`, and paginate `list`.

### M5. `intake.needsAttention` returns whole `processedEvents` documents
File: `intake.ts:671-688`.

- The documents include `payload.text`, which is up to 60 KB each, and there can be up to 100 rows in one reactive payload.
- **Minimal fix:** return a projection without `payload`.

### M6. `eligibleItems` read volume can exceed the transaction read limit
File: `priceWatch.ts:176-186`.

- 500 items × (purchase + up to 20 policies + claims `.collect()`).
- With B3 spam producing 20 snapshots per domain, the query can exceed the limit and throw.
- If it throws, the cron checks nothing for anyone.
- **Minimal fix:** the H1 fix removes this.

### M7. The watch sweep caps the whole service at 50 checks an hour
Files: `watches.ts:641-644`, `limits.ts:24`, `crons.ts:21`.

- That is 1,200 a day in total, while one full account wants 600.
- The order is FIFO by `nextCheckAt`, so nobody starves completely, but cadence degrades for everyone once there are more than 2 full accounts.
- It is a good spend ceiling and a bad guarantee.
- **Minimal fix:** raise the page size and add a per-user slice.

### M8. `insights.userWatches` takes the newest 40 watches including archived ones
File: `insights.ts:86-92`.

- After archive-and-recreate churn, the page can be all archived rows. `activity` and `sources` then show no live watches.
- **Minimal fix:** use `liveWatches`.
- Related: `sources` reads offers with `.take(20)` unordered (`insights.ts:316-319`), so it can miss confirmed offers beyond the first 20 rows.

## LOW

- **Subject injection, `watches.ts:280,347,608` and `notify.ts:120`:**
  - Names are only trimmed, so embedded CR/LF survive.
  - They come from the user and from the page-controlled `productName`, and they reach the mail subject.
  - The AgentMail API takes JSON, so header injection is unlikely.
  - Still, strip `[\x00-\x1f\x7f]` at write time and when building the subject.
- **Paste dedupe leaks across users, `intake.ts:545-546`:**
  - The paste hash is global, so "already been processed" tells a user that someone else pasted the same text.
  - It also lets a stranger pre-block a known email.
  - Put `userId` in the digest input.
- **`finishEvent` marks rows succeeded too eagerly, `replies.ts:105-107,114-121`:**
  - It marks `succeeded` even when `classifyOnce` returned early because the claim is gone.
  - It has no status guard.
- **`sameParty` trusts unparseable senders, `replies.ts:38-39`:**
  - An unparseable `From` yields `senderMismatch: false`. Treat unknown as a mismatch.
  - Shared mail domains such as gmail.com always match.
- **`emailDomain`, `drafts.ts:64-71`:** correct for `Name <a@b>` forms. No issue.
- **Missing validators and a client-settable flag:**
  - `returns` validators are missing on `purchases.create`, `purchases.confirm`, `policies.refresh` and `policies.insertSnapshot`.
  - `purchases.create` accepts a client-set `isExample` (`purchases.ts:31`). This is harmless, because it only hides the purchase from totals and scraping.
- **`examples.load`, `examples.ts:31-34`:** it does `.collect()` on the caller's purchases, which are unbounded per B4. Bound the read, or use a flag on the profile.
- **`offers.recheck` is dead code, `offers.ts:649`:** nothing schedules it, so confirmed offers' prices and `best` only refresh on a new `find`. That is good for spend and stale for users. The comment at `offers.ts:616` is wrong.
- **Domain comment is wrong, `watches.ts:435`:** the comment says "bare registrable host", but `normalizeDomain` keeps subdomains such as `shop.nike.com`. Policy rows are keyed on the subdomain as a result.

## Clean

- **Cross-user access:**
  - Every public function in `watches.ts`, `offers.ts`, `notify.ts`, `insights.ts`, `tracking.ts`, `examples.ts` and `drafts.ts` resolves identity from `ctx.auth`.
  - Each one checks ownership of every id it takes (`ownedWatch`, `ownedOffer`, inline `userId` compares). List reads are all `userId`-prefixed.
  - Internal mutations derive the owner from the row. `recordRechecks` verifies `offer.watchId` (`offers.ts:676`).
  - No other user's rows or email addresses appear in any return value.
- **`offers.find` limits, `offers.ts:243-269`:**
  - The per-watch 6-hour cooldown and the 10-a-day per-user cap are consumed in the scheduling mutation.
  - They fail closed, and OCC serialises concurrent finds.
  - Markers cannot be bypassed, and archiving does not reset them.
- **`watches.create` limits, `watches.ts:241-262`:**
  - Transactional, and archived rows count toward the hourly cap.
  - Many watches on the same URL are bounded by the 50-watch and 20-per-hour caps.
- **`notify.claimDrop` dedupe, `notify.ts:105-126`:**
  - The check and the insert are in the same transaction as the price acceptance.
  - `sendDrop` re-reads `status === "claimed"`.
  - The recipient is only ever `users.email`. See B2 for why that is not enough.
- **Index names and fields against `schema.ts`:**
  - All index names and fields match. `_creationTime` ranges on `by_user` indexes are valid.
  - The `recordWatchCheck`, `recordCheck`, `recordCandidates` and `recordRechecks` arg validators accept what the callers spread in.
  - `watchSummary`, `offersForWatch`, `priceHistoryView`, `trackedRow` and the tracking `overview` returns match their handlers.
- **Other files with no issues:** `lib/verdict.ts`, `lib/offerMatch.ts`, `lib/latestPolicy.ts`, `crons.ts` and `convex.config.ts`.

## Public spend paths with no effective per-user cap

| Path | Location | Cap status |
|---|---|---|
| `policies.refresh` | `policies.ts:223` | none |
| `purchases.create` → `fetchBoth` | `purchases.ts:63` | none |
| `purchases.confirm` → `fetchBoth` | `purchases.ts:122` | none |
| `intake.paste` | `intake.ts:508` | none |
| `intake.retryEvent` | `intake.ts:563` | none, and resets attempts |
| `drafts.generate` | `drafts.ts:186` | none |
| `drafts.approveAndSend` | `drafts.ts:341` | one in flight per claim only |
| `priceWatch.checkNow` | `priceWatch.ts:497` | cooldown is racy, no user cap |
| `watches.checkNow` | `watches.ts:308` | per-watch cooldown only |
| `watches.markBought` → `fetchBoth` | `watches.ts:479` | create rate only |
| `profiles.ensureInbox` | `profiles.ts:142` | one per account, accounts unlimited |

Properly capped: `watches.create`, `offers.find`, `notify` (20 a day).

## Smallest route to launch

1. Add one `consumeBudget(ctx, userId, kind)` helper backed by a per-user per-day counter table, and call it in every scheduling mutation in the table above.
2. Convert the three public actions (`paste`, `refresh`, `generate`) to a mutation that schedules an internal action, so the budget check is transactional.
3. Block example claims from sending and cap outbound mail (B1).
4. Gate drop mail on a verified email (B2).

## Key files

- `/Users/charlie/hackathons/recoup/convex/drafts.ts`
- `/Users/charlie/hackathons/recoup/convex/auth.ts`
- `/Users/charlie/hackathons/recoup/convex/notify.ts`
- `/Users/charlie/hackathons/recoup/convex/policies.ts`
- `/Users/charlie/hackathons/recoup/convex/purchases.ts`
- `/Users/charlie/hackathons/recoup/convex/intake.ts`
- `/Users/charlie/hackathons/recoup/convex/priceWatch.ts`
- `/Users/charlie/hackathons/recoup/convex/watches.ts`
- `/Users/charlie/hackathons/recoup/convex/limits.ts`
- `/Users/charlie/hackathons/recoup/convex/offers.ts`
- `/Users/charlie/hackathons/recoup/convex/insights.ts`
- `/Users/charlie/hackathons/recoup/convex/lib/watchUrl.ts`
- `/Users/charlie/hackathons/recoup/convex/replies.ts`
- `/Users/charlie/hackathons/recoup/convex/examples.ts`
- `/Users/charlie/hackathons/recoup/convex/tracking.ts`
- `/Users/charlie/hackathons/recoup/convex/crons.ts`