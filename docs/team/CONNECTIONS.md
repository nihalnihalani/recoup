# Connection audit (lead-owned; filled from auditor reports)

Statuses: VERIFIED_LOCAL · VERIFIED_LIVE · FAILED · BLOCKED_EXTERNAL · NOT_IMPLEMENTED

| ID | Scenario | Producer | Consumer | Contract | Auth | Idempotency/failure | Evidence | Status | Reviewer |
|---|---|---|---|---|---|---|---|---|---|
| C01 | Frontend env → Convex client | `.env.local:VITE_CONVEX_URL` | `src/main.tsx:ConvexReactClient` | URL = adorable-lion-138.convex.cloud | n/a | n/a | review-task1 | VERIFIED_LOCAL | review-task1 |
| C02 | Sign-in/out → auth routes → gated app | `convex/auth.ts`, `http.ts:auth.addHttpRoutes` | `src/App.tsx` Authenticated gates | Password provider | session | n/a | – | NOT_IMPLEMENTED | – |
| C03 | Identity → access helpers → owned fns | `convex/lib/access.ts` | every query/mutation/action | requireUserId/ownedX | yes | throws ConvexError | – | NOT_IMPLEMENTED | – |
| C04 | Account → inbox provisioning → settings | `profiles.ensureInbox` → `agentmail.createInbox` | `pages/Settings.tsx` | snake_case inbox_id/email (D32) | requireUserId | idempotent; orphan inbox deleted on race | profiles.test 5; live: **FAILED** `Couldn't resolve agentmail.lib.createInbox` (lead repro via CLI; component reachable directly) | FAILED (live) / VERIFIED_LOCAL | lead |
| C05 | Inbound webhook → verify → dedupe → route | `http.ts:/agentmail/webhook` → component → `inbound.onMessageReceived` | intake/replies | eventId, inbox_id | inbox→profile→user | processedEvents status | – | NOT_IMPLEMENTED | – |
| C06 | Content → extraction → review → persist | `intake.extractFromText`/`paste` | `intake.applyExtraction` | zod InboundEmail | userId arg | needs_review on low conf | – | NOT_IMPLEMENTED | – |
| C07 | Domain → policy search/scrape → card | `policies.researchPolicy`→`insertSnapshot` | `policies.latest` ← `purchases.get` | zod Policy; passage verified verbatim (lib/passage) | userId on row; `confirm` owner-checked | immutable snapshots; errors → confidence 0 note | policies.test 8, passage.test 4 (injected deps) | VERIFIED_LOCAL; live BLOCKED_EXTERNAL (OPENAI_API_KEY) | lead spot-check |
| C08 | URL → price check → claim | `priceWatch.checkItem` (cron `runAll` 6h, `checkNow`) → `recordCheck` | `openClaim`, Board countdown | D16 gates: currency, confidence ≥0.7, exact variant, not range, window open | item.userId; checkNow owner-checked | always inserts check; claim guard + concurrent test | priceWatch.test 10 | VERIFIED_LOCAL; live scrape BLOCKED_EXTERNAL (OPENAI) | lead |
| C09 | Returned item → gap → return claim | `purchases.setReturned`, `claims.open` | ledger, `pages/Purchase.tsx` | expected derived server-side (D20) | ownedItem; returned required | one open claim per item/type | claims.test; browser rehearsal | VERIFIED_LOCAL | sonnet-frontend + lead |
| C10 | ID referential ownership | `lib/access.ts` | all | purchase.userId = item.userId = claim.userId | yes | n/a | – | NOT_IMPLEMENTED | – |
| C11 | Claim → draft → immutable approval | `drafts.generate`/`insert` | `drafts.approveAndSend` | claimVersion bound | yes | version mismatch throws | – | NOT_IMPLEMENTED | – |
| C12 | Approval → queued send → status | `agentmail.sendMessage` | `drafts.sendStatus` | OutboundId | yes | outboundId set once | – | NOT_IMPLEMENTED | – |
| C13 | Reply → thread match → classify → event | `inbound` → `replies.classify/apply` | claim ledger | token/threadId | claim.userId = profile.userId | replies.by_message | – | NOT_IMPLEMENTED | – |
| C14 | Confirm credit → ledger → balance → board | `claims.confirmCredit` | `purchases.board`, `pages/Claim.tsx` | integer cents; client idempotencyKey per submit | ownedClaim | append-only; per-claim key (D38 pending) | claims.test; browser rehearsal + `convex data ledgerEvents` | VERIFIED_LOCAL | sonnet-frontend + lead |
| C15 | Later debit → reopen | `claims.recordLaterDebit` | claim status, `pages/Claim.tsx` | statusAfterEvent | ownedClaim | append-only; cap ≤ net confirmed (D40 pending) | claims.test; browser rehearsal (status reopened, version 4) | VERIFIED_LOCAL | sonnet-frontend + lead |
| C16 | Sent/promised → reminder | `drafts.reconcileSend`/`replies.apply`/`drafts.markPacketSent` → `followUps.scheduleReminder` | `followUps.fire` → `claims.attentionAt` → UI | schedule-first; fireAt ≤ now (D42) | claim.userId | status-gated, no-op on stale (D28/D42) | followUps.test, drafts.test | VERIFIED_LOCAL | pending opus checkpoint 2 |
| C17 | Change → invalidation | `claims.adjustExpected`/`dismiss`/`applyEvent` | drafts, followUps | version bump | yes | cancelPending | – | NOT_IMPLEMENTED | – |
| C18 | Non-email policy → packet | `drafts.markPacketSent` | claim status packet | channel≠email | yes | n/a | – | NOT_IMPLEMENTED | – |
| C19 | Example loader | `examples.load`/`remove` | Board, Settings | isExample on purchases/claims/policies; .example hosts | requireUserId | idempotent; archive on remove | examples.test 6; browser rehearsal (pill, totals 0) | VERIFIED_LOCAL | lead |
| C20 | Routes → queries → states | `src/App.tsx` | pages/* | react-router 7; QueryBoundary | Authenticated gate | loading/empty/error/alert | T11a/T11b-1/T11b-2 browser rehearsals | VERIFIED_LOCAL | sonnet-frontend + lead |
| C21 | Components/auth/webhook → http → static last | `convex.config.ts`, `http.ts` | convex.site | route order | n/a | n/a | – | NOT_IMPLEMENTED | – |
| C22 | Codegen → types | `convex/_generated` | frontend+backend | tsc | n/a | n/a | tsc app side passes | NOT_IMPLEMENTED | – |
| C23 | Secrets server-side only | `npx convex env` | actions | names only | n/a | redacted errors | – | NOT_IMPLEMENTED | – |
| C24 | Deploy → public site/API | static-hosting deploy | convex.site | SITE_URL, webhook URL | n/a | n/a | – | BLOCKED_EXTERNAL | – |
