# Backend review, 2026-09-20

Independent read-only review of `convex/` by the Convex reviewer agent. Nothing was run. It read the tree just before the teammate merge, so line numbers in `purchases.ts`, `claims.ts` and `policies.ts` may have moved. No finding is certain to stop the first live run. Each item is assigned to an iteration in `docs/plans/2026-09-20-recoup-iterations.md`.

## Clean areas

1. **Auth and ownership.** No public function accepts a `userId`; all D19 related-id checks are present.
2. **Inbound path.** Callback signature matches the component (`lib.js:423-427`); dedupe is re-checked in the mutation; D23 routing order holds; `userId` is checked at every hop, so no cross-user attachment.
3. **Send path.** Per-draft double-click guard, `queued` until a message id exists, and the D18 recipient gate are correct.
4. **Ledger.** Invariants hold (M5 is the only deviation).
5. **Actions.** OpenAI 7.20.0, Firecrawl and AgentMail calls match installed types. The direct fetch that bypasses `createInbox` is justified (the component registers it as `internalAction`). No action touches `ctx.db`, no mutation fetches, nothing needs `"use node"`. Verify on the first live send that the AgentMail component sees `AGENTMAIL_API_KEY` (`utils.js:31`).
6. **Crons and scheduler.** Sweep bounded by `take(500)` with scheduler fan-out; `followUps` follows D28 apart from M5.
7. **First-use runtime throws.** None found: index names, schema fields and returns validators match `schema.ts`.

## Blocker risk

- **H1 `convex/inbound.ts:104-106`.** Body prefers `extracted_text`, which AgentMail strips of forwarded content. A forwarded order can reach the model as "FYI" and end `needs_review` as "other"; HTML-only mail falls through to the short `preview`. Fix: store `text` and `extractedText` in `payload`; intake reads `text ?? stripped html ?? extractedText`; `replies.classify` reads `extractedText ?? text`. Unconfirmed how AgentMail treats forwarded blocks: check the first live forward.

## High

- **H2 `inbound.ts:148-161`, `replies.ts:79-106`, `intake.ts:572`.** Event marked `succeeded` before `classify` runs; `classify` has no try/catch and scheduled actions are not retried; `retryEvent` refuses non-intake routes. An OpenAI 429 on the merchant's reply loses it permanently (deviates from D10/D14). Fix: keep the event `processing`, pass `processedEventId` to `classify`, call `failEvent` in a catch, allow `route === "reply"` in `retryEvent`.
- **H3 `drafts.ts:452-483`.** `applySendOutcome` checks `agentmailMessageId` before failure statuses, and bounced rows keep their message id. A bounced recipient becomes `sent`, a reminder is scheduled, the board counts it as asked (deviates from D13). Later bounces are never seen because `mail.ts` registers no `onEvent`. Fix: check terminal failures first; optionally add `onEvent`.
- **H4 `drafts.ts:64-69`, used at `replies.ts:161-164`.** `emailDomain("Acme <help@acme.com>")` returns `acme.com>`, so `senderMismatch` is true on every real reply. Fix: extract the address with `/<([^>]+)>/` first.
- **H5 `drafts.ts:156,222`, `auth.ts:5`.** Password provider never sets `users.name`; drafts are signed "the customer". Fix: fall back to the email local part, or collect a name at sign-up.
- **H6 `drafts.ts:338-421`.** `approveAndSend` has no claim-status guard. Two generated drafts share `claimVersion` and both send; a send on a `dismissed` or `confirmed` claim sets it back to `queued`. Fix: refuse when `queued`, `dismissed` or `confirmed`; refuse closed claims in `generate`.
- **H7 `purchases.ts:71,142,157` vs `policies.ts:298,326,362`.** `merchantDomain` stored raw on purchases, normalised on policies. `www.bestbuy.com` gives no policy card, no price watch, empty recipient prefill, and `openClaim` throws "Policy is for a different merchant". Fix: `normalizeDomain` in `create` and `confirm`.

## Medium

- **M1 `purchases.ts:156-161`, `policies.ts:145-150`.** Every `confirm` or `refresh` inserts snapshots that shadow a manual or user-confirmed policy; the latest read returns a `confidence: 0` row with no `windowDays` and price watch stops silently. Fix: skip `fetchBoth` when a snapshot under 24h old exists, or prefer the newest `confirmedByUser` row.
- **M2 `intake.ts:171-193,569`.** A row can stay `processing` forever after an action timeout; `retryEvent` rejects it and `needsAttention` does not list it. Fix: allow retry on a `processing` row older than about 5 minutes.
- **M3 `intake.ts:293-298,569`.** A successful order intake ends `needs_review` and never clears; a retry with a null `orderRef` skips the D22 check and inserts a duplicate purchase. Fix: end it `succeeded`, or store the purchase id on the event and refuse retry when set.
- **M4 `drafts.ts:485-494`.** After five checks the claim is stuck `queued` with `sendUnknown: true`. Fix: a manual "check again" mutation, or one late recheck at about an hour.
- **M5 `claims.ts:270-289`.** `adjustExpected` cancels the reminder, never reschedules it, never recomputes status (deviates from D28/D41). Fix: reschedule for `sent`, `packet`, `promised`; recompute status from the balance.
- **M6 `policies.ts:321-330`.** `refresh`, `drafts.generate`, `intake.paste` have no rate limit; sign-up is open; the limiter mentioned at `priceWatch.ts:437-441` does not exist. Fix: per-user, per-domain cooldown plus a per-user counter.
- **M7 `intake.ts:590-607`.** `needsAttention` returns up to 60 KB of `payload` per row. Fix: drop `payload` from the query and its returns validator.

## Low

- `inbound.ts:170-186`: a routing failure before the `userId` patch leaves an invisible `failed` row that cannot be retried. Patch `userId` right after the profile lookup.
- `claims.ts:98`, `lib/ledger.ts:98`: a `later_debit` reopens the claim but schedules no reminder.
- `purchases.ts:59`: a client can set `isExample: true`. Harms only the caller; remove the argument.
- `drafts.ts:386`: `approveAndSend` does not cap the body with `MAX_BODY_CHARS`.
- `convex.config.ts:8`: `FIRECRAWL_API_KEY` is required at app level; keep it set before any deploy.
- `claims.ts:186`: `applyEventInternal` is unused and could write `confirmed_credit`; consider deleting it.
