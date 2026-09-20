# Connection audit (lead-owned; filled from auditor reports)

Statuses: VERIFIED_LOCAL · VERIFIED_LIVE · FAILED · BLOCKED_EXTERNAL · NOT_IMPLEMENTED

| ID | Scenario | Producer | Consumer | Contract | Auth | Idempotency/failure | Evidence | Status | Reviewer |
|---|---|---|---|---|---|---|---|---|---|
| C01 | Frontend env → Convex client | `.env.local:VITE_CONVEX_URL` | `src/main.tsx:ConvexReactClient` | URL = adorable-lion-138.convex.cloud | n/a | n/a | review-task1 | VERIFIED_LOCAL | review-task1 |
| C02 | Sign-in/out → auth routes → gated app | `convex/auth.ts`, `http.ts:auth.addHttpRoutes` | `src/App.tsx` Authenticated gates | Password provider | session | n/a | – | NOT_IMPLEMENTED | – |
| C03 | Identity → access helpers → owned fns | `convex/lib/access.ts` | every query/mutation/action | requireUserId/ownedX | yes | throws ConvexError | – | NOT_IMPLEMENTED | – |
| C04 | Account → inbox provisioning → settings | `profiles.ensureInbox` | `pages/Settings.tsx` | profiles.by_user unique | yes | idempotent by existing row | – | NOT_IMPLEMENTED | – |
| C05 | Inbound webhook → verify → dedupe → route | `http.ts:/agentmail/webhook` → component → `inbound.onMessageReceived` | intake/replies | eventId, inbox_id | inbox→profile→user | processedEvents status | – | NOT_IMPLEMENTED | – |
| C06 | Content → extraction → review → persist | `intake.extractFromText`/`paste` | `intake.applyExtraction` | zod InboundEmail | userId arg | needs_review on low conf | – | NOT_IMPLEMENTED | – |
| C07 | Domain → policy search/scrape → card | `policies.fetchOne` | `purchases.get` policies | zod Policy | userId | upsert by (user,domain,kind) | – | NOT_IMPLEMENTED | – |
| C08 | URL → price check → claim | `priceWatch.checkItem`/`recordCheck` | `claims` | priceDropCents | item.userId | one open claim per item/type | – | NOT_IMPLEMENTED | – |
| C09 | Returned item → gap → return claim | `purchases.setReturned`, `claims.open` | ledger | expected = unit×qty (− accepted fee) | yes | open-claim guard | – | NOT_IMPLEMENTED | – |
| C10 | ID referential ownership | `lib/access.ts` | all | purchase.userId = item.userId = claim.userId | yes | n/a | – | NOT_IMPLEMENTED | – |
| C11 | Claim → draft → immutable approval | `drafts.generate`/`insert` | `drafts.approveAndSend` | claimVersion bound | yes | version mismatch throws | – | NOT_IMPLEMENTED | – |
| C12 | Approval → queued send → status | `agentmail.sendMessage` | `drafts.sendStatus` | OutboundId | yes | outboundId set once | – | NOT_IMPLEMENTED | – |
| C13 | Reply → thread match → classify → event | `inbound` → `replies.classify/apply` | claim ledger | token/threadId | claim.userId = profile.userId | replies.by_message | – | NOT_IMPLEMENTED | – |
| C14 | Confirm credit → ledger → balance → board | `claims.confirmCredit` | `purchases.board` | integer cents | yes | append-only | – | NOT_IMPLEMENTED | – |
| C15 | Later debit → reopen | `claims.recordLaterDebit` | claim status | statusAfterEvent | yes | append-only | – | NOT_IMPLEMENTED | – |
| C16 | Sent/promised → reminder | `followUps.scheduleReminder` | `followUps.fire` | claimVersion | claim.userId | re-read + version check | – | NOT_IMPLEMENTED | – |
| C17 | Change → invalidation | `claims.adjustExpected`/`dismiss`/`applyEvent` | drafts, followUps | version bump | yes | cancelPending | – | NOT_IMPLEMENTED | – |
| C18 | Non-email policy → packet | `drafts.markPacketSent` | claim status packet | channel≠email | yes | n/a | – | NOT_IMPLEMENTED | – |
| C19 | Example loader | `examples.load` | board | isExample, *.example recipients | yes | n/a | – | NOT_IMPLEMENTED | – |
| C20 | Routes → queries → states | `src/App.tsx` | pages | react-router | Authenticated | loading/empty/error | – | NOT_IMPLEMENTED | – |
| C21 | Components/auth/webhook → http → static last | `convex.config.ts`, `http.ts` | convex.site | route order | n/a | n/a | – | NOT_IMPLEMENTED | – |
| C22 | Codegen → types | `convex/_generated` | frontend+backend | tsc | n/a | n/a | tsc app side passes | NOT_IMPLEMENTED | – |
| C23 | Secrets server-side only | `npx convex env` | actions | names only | n/a | redacted errors | – | NOT_IMPLEMENTED | – |
| C24 | Deploy → public site/API | static-hosting deploy | convex.site | SITE_URL, webhook URL | n/a | n/a | – | BLOCKED_EXTERNAL | – |
