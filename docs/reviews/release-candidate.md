# Release candidate — T25

Owner: T25 (sonnet-verifier). Contract: `docs/team/PLAN.md` "### T25 —"
(verbatim), authorizations: `docs/team/DECISIONS.md` D83 (dev deployment
`adorable-lion-138` disposable — its data and static site MAY be
overwritten; NO new deployments; NO production deploy to `cool-oyster-399`;
NO real provider sends), D108 (pathspec commits), D113 (F-T20-2), D119
(F-T18.4-1: do not extend `scripts/check-patch.mjs` — it is source; document
the manual check instead), D122, D125, D126 (F-AUD-6: what this manifest
must name), D128 (candidate = `3f5f739`). This document **changes no
source** — the four files this task owns are `docs/ops/RELEASE.md` (new),
this file (new), `docs/team/HANDOFF.md` (replace), and one note in
`e2e/README.md` (F-T23-2). **No production deployment was performed or
attempted.**

Model (self-reported from my system prompt): Sonnet 5 (claude-sonnet-5)

## 1. Candidate identity

| | |
|---|---|
| Candidate SHA | `3f5f739f27138eb1c77c6e8cd2559e66297b0a1c` (short `3f5f739`) — D128's designated release-preparation candidate |
| Tag | `rc-2026-09-21` (annotated, pushed to `origin`) |
| Code content | Byte-identical to `4c3c71e` (T18.5 + T24e, the last commit touching `convex/**`/`src/**`) — `3f5f739` only adds `docs/team/CONNECTIONS-2026-09-21-pre-audit.md` (42 lines, docs-only; `git diff --stat 4c3c71e 3f5f739` confirms exactly one file, zero code paths). Tagging the docs commit is equivalent to tagging the last code commit and matches D128's own wording ("Candidate for release preparation = 3f5f739"). |
| Built/verified from | A **detached git worktree** (`git worktree add --detach <scratch> 3f5f739`), never the shared main checkout — reproducible independent of anything else landing on `main` concurrently (same discipline as T23 §1 / D125). |

## 2. Toolchain

| | |
|---|---|
| `node -v` | `v25.2.1` |
| `npm -v` | `11.6.2` |
| `.nvmrc` | `22` |
| Mismatch | Same as **F-T23-1 (LOW)**, re-observed here: this verifier's local Node is 25, not the pinned 22. `npm ci` only warns (`EBADENGINE`), does not fail. **Not a candidate defect** — CI pins Node via `actions/setup-node` + `node-version-file: .nvmrc`, so the actual CI run (and any real release performed from CI) uses 22, not this machine's 25. Recorded here for reproducibility, not as a blocker. |
| `sha256sum package-lock.json` | `36352508cb1419cd58f5aa4f7dfd6172547af6ca405d8d267589dbb1123ca719` |

## 3. Clean install and gates (detached worktree at `3f5f739`)

All commands below ran in the worktree, in order, immediately after cloning
the exact candidate commit. Durations are wall-clock from this run.

| Step | Command | Result | Duration |
|---|---|---|---|
| Install | `npm ci` | OK — `added 174 packages, audited 175 packages`, `postinstall` applied `patches/@agentmail+convex+0.1.0.patch` (`patch-package 8.0.1 ... @agentmail/convex@0.1.0 ✔`), `found 0 vulnerabilities`. `EBADENGINE` warning only (§2). | 2s |
| `npm run verify:patch` | `node scripts/check-patch.mjs` | `[verify:patch] OK - node_modules/@agentmail/convex/dist/component/convex.config.js has the AGENTMAIL_API_KEY env declaration.` | 0s |
| `npm run typecheck` | `tsc -p tsconfig.app.json --noEmit && tsc -p convex/tsconfig.json --noEmit` | OK, no output (no errors) | 6s |
| `npm run lint -- --max-warnings=1` | `oxlint --max-warnings=1` | OK, no output (0 warnings ≤ the pinned ceiling of 1; the one pre-existing `convex/lib/passage.ts` warning this ceiling accounts for — D88/INSTALL.md — was not present in this run) | 0s |
| `npm run test:ci` | `node scripts/check-test-count.mjs 600` | `[test:ci] OK - 1322 tests passed across 65 file(s) (minimum 600).` Matches D128's "1321 pass + 1 expected fail" (the `fairness.test.ts` `it.fails` regression for F-D74-1 counts as a pass from the runner's own perspective — an `it.fails` that fails as designed reports "passed"); 65 files, 1322 total, zero real failures. | 47s |
| `npm run codegen:check` | `node scripts/check-codegen.mjs` (isolated worktree, real `npx convex codegen` against `adorable-lion-138`) | `[codegen:check] OK - convex/_generated matches \`npx convex codegen\` output.` — no drift | 9s |
| `npm run build` | `tsc -b && vite build` | OK, `dist/` 708 KB total (18 modules → 20 files under `dist/`), 168 modules transformed | 4s |

All six gates PASS. No source was changed to make them pass — this is the
candidate exactly as committed.

## 4. `dist/` file hashes (sha256, this build)

Built with `VITE_CONVEX_URL=https://adorable-lion-138.convex.cloud` (the
worktree's `.env.local` was populated with this repo's own public
client-side values — `VITE_CONVEX_URL`/`VITE_CONVEX_SITE_URL`/
`CONVEX_DEPLOYMENT`, none of which are secrets; see `docs/ops/ENVIRONMENT.md`
"Client-side (build-time, public, `.env.local`)"). `du -sh dist` = **708K**.

```
54b4f53e0feda1508bdbfd7b0f30664699f68b25fd097c84499e4245e68f3c95  dist/assets/AreaChart-DPUOpQNI.js
9ae7a7433d195516ac2cb0af707f4f93f1ca0d5925eb76cf0c8aefbb99c307cb  dist/assets/Board-DYHtT0Tv.js
8e09d608c1d2eb18e57f560839b5a8ea3f73c6592abb85c51921a0aba0143663  dist/assets/Claim-C-pKz-5i.js
ed2820b59e66d19b7e9da895acb4a0b3acbd9270d2eee70b3a6936a518b08ccc  dist/assets/DeltaBadge-BmkbbiWq.js
e19c835b06bfc4c5fed3df6b861b3f2ce9fe301e2d8a0b9f326c9ef2baa3f5da  dist/assets/Privacy-B4jmNOWp.js
c5843fef911acd53ed5b3230a67f3f08107f8f0c56c708bcc41568b13f3a8a61  dist/assets/ProductThumb-TfWT4xdX.js
72e0924928a2f00fb39722de84c5f6d05251c30e8899dcaa59f662f78ec70df3  dist/assets/Purchase-CnAApJXo.js
15bc67568f36d7cc4983a208cdb17b7fdaa881a0e591ea79f0533e14747928f6  dist/assets/Settings-HkH6cSMC.js
ed6dd2181261f5e4d9e883d3b62fac20f72f3f0576b47b1e57e9d645c500953c  dist/assets/Watching-D-XUu3yf.js
4ff50763bb81c39bdeea08227c140fb47fac0deeab5f1c250e289edfbff09ebf  dist/assets/WindowMeter-Cze3qSbW.js
9dae639fdcc8802cae50b0fc884e6ecdabd105746076dc68e3f4d0e262ac6f7f  dist/assets/accountDeletion-BgVqpQQK.js
0fc30d59685901978ab61b8bcfcb0a722b068b008587d82748ba7c86e6857806  dist/assets/index-CXBYc6Dv.css
4c14a8a4ec0416f060ba3226e4b9ee101ffca0cca96751a5b242600d0573a900  dist/assets/index-DzrTKFj7.js
39de6e198f8cc555bf3b90286c8c92a55cb3c8f34a73dcfa2db8be70b8024324  dist/assets/priceStats-Cc2dtEYs.js
bbf7c5086ae414dc3f33777e3eebf16ea8631325b8bb4690d25091c03567f31a  dist/assets/rolldown-runtime-CbXtAM7H.js
344405744e044fda9c3bc1f9f2e0da28d796f6ad35b6fff425f9dced900faedc  dist/assets/vendor-convex-Cpzj2qgY.js
da596c427d478925a8aaee486e4f6872ed1a168633a82a9f9e8f6d545e24fde6  dist/assets/vendor-react-DATI_BkD.js
f21386cbecd7f1c043abfc92c1db0253c1a9b473b7250b7374bfe8c8b23a34c7  dist/assets/vendor-router-BzhgdUnx.js
61bc9a161de58248288e6905425d7180f0624c2865007b97d763fdac12043a66  dist/favicon.svg
e8721effb15b76e1d3078ec605ffa2a19de0e4fdf4bc597b1b7ad93ed070ed96  dist/index.html
```

Reproduce: `git worktree add --detach <path> 3f5f739 && cd <path> && npm ci &&
npm run build && find dist -type f | sort | xargs shasum -a 256`.

## 5. Environment presence matrix (names only — no values printed)

Per `docs/ops/ENVIRONMENT.md`'s own variable inventory. Read via
`npx convex env list --deployment adorable-lion-138` (names only; every
value below is redacted, never inspected or printed by this task).

### `adorable-lion-138` (disposable dev deployment — D83 item 3)

| Variable | Status | Note |
|---|---|---|
| `FIRECRAWL_API_KEY` | **present** | Real key (D83 item 3: "real FIRECRAWL key" on this deployment, per `docs/reviews/phase4-verification.md`'s own header) |
| `AGENTMAIL_API_KEY` | **present (placeholder)** | D83 item 3: placeholder, never real, on this deployment |
| `OPENAI_API_KEY` | **present (placeholder)** | D83 item 3: placeholder, never real |
| `JWT_PRIVATE_KEY` | **present** | Convex Auth signing key (deploy-blocking if absent) |
| `JWKS` | **present** | Convex Auth (deploy-blocking if absent) |
| `SITE_URL` | **present** | Convex Auth issuer domain |
| `E2E_SEED_ENABLED` | **present** | Must be exactly `"true"` for `convex/testing.ts` to work — confirmed functional in §7 below (re-seed succeeded) |
| `AGENTMAIL_WEBHOOK_SECRET` | **absent** | Fails closed: `convex/http.ts` returns a clean 401 with no body before ever reaching the component (F-T22-1 fix), confirmed live in §6 (smoke check 5 PASS, "got 401") |
| `ALERTS_INBOX_ID` | **absent** | Price-drop alerts fall back to the recipient's own profile inbox id; auth verification/reset mail would fail closed if triggered for real (not exercised here — no real sends, D83) |
| `SHOPSAVVY_API_KEY` | **absent** | Safe no-op default (`market.fetchSnapshot` returns `null`, `marketState: "not_configured"`) |
| `AGENTMAIL_BASE_URL` | **absent** | Uses the library default (`https://api.agentmail.to/v0`) |
| `APP_URL` | **absent** | Falls back to `SITE_URL` |

### `cool-oyster-399` (production, co-author's team)

| Variable | Status |
|---|---|
| every variable above | **unknown, not verified** — this task has no access to and did not query the production deployment (D83 item 6: production deploy/access is not authorized in this mission) |

## 6. Static deploy of the candidate + smoke

**Command used** (not `npm run deploy` / bare `npx convex deploy` — see
"Why not `npm run deploy`" below):

```sh
CONVEX_DEPLOYMENT=dev:adorable-lion-138 npx @convex-dev/static-hosting upload --dist dist
```

Output: `🚀 Deploying to development environment` → 20 files uploaded →
`✨ Upload complete! Your app is now available at:
https://adorable-lion-138.convex.site`. Duration: 18s. The Convex backend
itself was not redeployed by this step (`npx convex dev --once` earlier in
the wave already pushed the current backend — D128's wave-11-close line
"deployed to adorable-lion-138"; this step only uploads the static `dist/`).

**Why not `npm run deploy`:** `package.json`'s `deploy` script is
`npx @convex-dev/static-hosting deploy`, whose own `--help` states its flow
as "1. Build frontend ... 2. Deploy Convex backend (`npx convex deploy`) ...
3. ... 4. Deploy static files" — step 2 always shells out to `npx convex
deploy`. `npx convex deploy --help` states its own deployment-selection rule
verbatim: *"If the `CONVEX_DEPLOYMENT` environment variable is set (typical
during local development), the target is the project's default **production**
deployment."* In other words, setting `CONVEX_DEPLOYMENT=dev:adorable-lion-138`
does **not** redirect `convex deploy` to the dev deployment — it still
targets `cool-oyster-399`. Running `npm run deploy` (or bare `npx convex
deploy`) in this session would therefore have deployed backend code to
production, which is explicitly not authorized (D83 item 6). The
static-hosting package's own `upload` subcommand (used above) is a separate
code path (`node_modules/@convex-dev/static-hosting/dist/cli/upload.js`) that
never calls `convex deploy` and only appends `--prod` to its internal `convex
run` calls when the caller passes `--prod` itself (confirmed by reading
`dist/cli/upload.js`/`dist/cli/commands.js`) — omitting `--prod`, as done
here, keeps every call scoped to the deployment named in `CONVEX_DEPLOYMENT`
(`adorable-lion-138`). The README's own release guidance agrees: *"Before
release, run one hosted smoke test against the development deployment: `npx
@convex-dev/static-hosting upload --build`."*

**`npm run smoke` — run twice (before and after the backup/restore in §7;
both runs identical):**

| # | Check | Result | Detail |
|---|---|---|---|
| 0 | `GET /` | PASS | `200 text/html; charset=utf-8` |
| 1 | `GET /watching` | PASS | `200 text/html; charset=utf-8` |
| 2 | `GET /settings` | PASS | `200 text/html; charset=utf-8` |
| 3 | `GET /claims/x` | PASS | `200 text/html; charset=utf-8` |
| 4 | bundle references exactly one `.convex.cloud` host | **FAIL** | `found 2 distinct host(s): adorable-lion-138.convex.cloud, happy-otter-123.convex.cloud` |
| 5 | `POST /agentmail/webhook {} -> 401` | PASS | `got 401` |
| 6 | `GET /.well-known/openid-configuration -> 200` | PASS | `got 200` |

**Result: 6/7.** Not 7/7 — recorded honestly rather than claimed as clean,
per this task's own invariant ("no claim of a verified production release
without production smoke evidence" extends to not overstating a dev smoke
result either). Check 4's failure reason, verified precisely, not assumed:

**New finding — F-T25-1 (LOW, tooling false positive, not a product
defect).** `scripts/smoke.mjs`'s bundle-host check does a raw regex scan
(`/https?:\/\/([a-z0-9-]+\.convex\.cloud)/gi`) over every referenced JS/CSS
asset's *text*, with no awareness of string-literal context. The second host
it finds, `happy-otter-123.convex.cloud`, is not a real second backend the
app talks to — it is a hardcoded **example URL inside an error message** in
the `convex` npm package itself (`node_modules/convex/src/react/client.ts:358`,
version `1.46.0`, pinned by this project's own `^1.46.0` range): `` `ConvexReactClient
requires a URL like 'https://happy-otter-123.convex.cloud', received
something of type ${typeof address} instead.` ``, thrown only when
`ConvexReactClient`'s constructor receives a non-string `address` — a branch
this app's own code never triggers (`src/main.tsx` calls `new
ConvexReactClient(convexUrl)` exactly once, with `convexUrl` already
type/format-checked as a real `https://` string beforehand — grepped, one
call site, confirmed). The literal string survives minification because
minifiers do not statically prove a runtime `typeof` guard unreachable. This
is a smoke-script limitation (over-broad regex, no way to distinguish a
reachable network host from an inert string constant), not a real
second-backend connection and not a security issue. **Suggested owner:**
whoever owns `scripts/smoke.mjs` (T22/ops) — either scope the regex to
`new URL(...)`/`ConvexReactClient(...)`-adjacent call sites, or accept this
as a permanent, documented false positive for as long as `convex@1.46.x`'s
own source contains that string. Not fixed here: `scripts/smoke.mjs` is
source, out of this task's file ownership, same reasoning as F-T18.4-1
below.

## 7. Backup (export) / restore (import) proof — `adorable-lion-138` only

Per this task's authorization (D83 item 3: `adorable-lion-138`'s data MAY be
overwritten; **no new deployment was created** — PLAN.md's T25 contract text
says "a second disposable deployment," but this task's launch brief tightens
that to "the disposable deployment ONLY" / "NO new deployments," which this
report follows; restoring into the *same* deployment it was exported from is
the more conservative reading and still proves the mechanism end to end).

| Step | Command | Result | Duration |
|---|---|---|---|
| Export | `CONVEX_DEPLOYMENT=dev:adorable-lion-138 npx convex export --path backup.zip` | `Created snapshot export` → `Downloaded snapshot export to backup.zip` | **4s**, **70,690 bytes** (69 KiB) |
| Read (before) | `npx convex run ops:backlog '{}'` | `dueItems.count=4, dueWatches.count=2, mailLogQueued.count=4, mailLogUnknown.count=0, processedEventsFailed.count=0, staleMarketRunning.count=0, deletions={deletingTotal:0,stuck:0}, retention={rule:"processedEvents",cursorAgeMs≈5.19e6,stalled:false}` | — |
| Restore | `CONVEX_DEPLOYMENT=dev:adorable-lion-138 npx convex import --replace-all backup.zip -y` | `✔ Added 670 documents.` Full per-table change summary printed (app tables: `authAccounts` 6, `authRateLimits` 7, `authRefreshTokens` 13, `authSessions` 3, `authVerificationCodes` 3, `claims` 8, `items` 13, `ledgerEvents` 5, `mailLog` 8, `offers` 12, `opsState` 3, `policies` 12, `priceChecks` 55, `processedEvents` 1, `purchases` 11, `users` 6, `watchChecks` 14, `watches` 8; components: `rateLimiter.rateLimits` 440, `staticHosting.staticAssets` 20 + `cleanupState`/`deploymentInfo` 1 each; every other table 0/0) | **21s** |
| Smoke (after) | `npm run smoke` | **Identical to §6's table, 6/7**, same F-T25-1 reason on check 4 | 7s |
| Read (after) | `npx convex run ops:backlog '{}'` | **Identical to the "before" row** (same counts, same `retention` state) — confirms the restore reproduced the exact prior state, not just "some" data | — |

**Restore proof: recorded and successful**, not BLOCKED. Both export and
import ran against `adorable-lion-138` only; no other deployment was created
or touched.

**Re-seeded the E2E lead account** after the restore (the task's own
instruction named a `verified` argument that does not exist on
`testing:seedUser` — checked `convex/testing.ts` directly per the task's own
"read for the exact args/password" instruction: the export handler is
`args: { email: v.string(), password: v.optional(v.string()) }` and
verification happens automatically inside the handler via
`internal.testing.markVerified`, not via a caller-supplied flag; the
matching password constant is `e2e/fixtures.ts`'s `SEEDED_PASSWORD =
"E2ePassword123!"`):

```sh
CONVEX_DEPLOYMENT=dev:adorable-lion-138 npx convex run testing:seedUser \
  '{"email":"e2e.lead@example.com","password":"E2ePassword123!"}'
# => {"userId":"jx77h5gr4e1wyfnkh0aqa48jf58etq0k"}
```

Succeeded (idempotent — same email+password as before, per `seedUser`'s own
doc comment: "Calling this twice with the SAME email+password is a no-op the
second time"). The browser suite's own `beforeAll` (`seedLead()` in
`e2e/fixtures.ts`) re-seeds fixtures on every run regardless, so this call
alone is sufficient to guarantee the account itself stays valid/verified for
the next suite run.

## 8. Migrations to run after a real deploy (not run here — see `docs/ops/RELEASE.md`)

| Function | Purpose |
|---|---|
| `lib/authMigrate:normalizeLegacyAccounts` | Lowercases/trims legacy `authAccounts.providerAccountId`/`users.email` rows predating D67's normalize-on-write; self-reschedules; safe no-op on a deployment with nothing to migrate |
| `market:migrateStamps` | Classifies pre-D71 watches with an old `marketFetchedAt` but no `marketState`; charges no budget, schedules no fetch; self-reschedules |

Both are resumable/idempotent (`docs/ops/RUNBOOK.md` §3). Not executed
against `adorable-lion-138` in this task — they are part of the *production*
deploy order (§9 / `docs/ops/RELEASE.md`), not a dev-verification step this
task's contract calls for.

## 9. Crons expected (from `convex/crons.ts`, read directly — 7 jobs)

| Name | Cadence | Function |
|---|---|---|
| `price watch` | every 2 hours | `internal.priceWatch.runAll` |
| `watch sweep` | every 1 hour | `internal.watches.sweep` |
| `retry failed inbound` | every 1 hour | `internal.intake.retryFailed` |
| `mail sweep` | every 1 hour | `internal.notify.sweepStalled` |
| `retention sweep` | every 24 hours | `internal.retention.sweep` |
| `offer prices` | daily, `0 13 * * *` UTC | `internal.offers.sweepRechecks` |
| `account re-drive` | every 24 hours | `internal.account.reDriveStuckDeletions` |
| `agentmail outbound cleanup` | every 24 hours | `internal.mailPurge.cleanupFinalizedOutbound` |

## 10. Phase 4 / connection-audit table links

- `docs/reviews/phase4-verification.md` §6 (P01–P12 acceptance table) — P12
  was **PARTIAL**, explicitly "backup/restore proof is explicitly deferred to
  T25" — closed by §7 above.
- `docs/team/CONNECTIONS.md` §5 (Verdict) — listed F-AUD-6 as the release
  blocker ("no release manifest, no backup/restore proof... T25 not
  started") — closed by this document.

## 11. Open findings (all LOW — none HIGH/CRITICAL)

Compiled from `docs/team/DECISIONS.md` D119–D128's own findings register
rows, cross-checked against the current tree (git log, grep) rather than
assumed still-open from the decision text alone.

| Finding | Severity | Status | Note |
|---|---|---|---|
| F-T18.4-1 (D119) | LOW, CI | **OPEN** | `scripts/check-patch.mjs` only asserts the env declaration, not `purgeInbox`/`by_inbox`. D119 routes the *code* extension to T25, but scripts are source and out of this task's authorized file list (owned files: `docs/ops/RELEASE.md`, this file, `docs/team/HANDOFF.md`, one `e2e/README.md` note). Documented as a **manual check** instead — see `docs/ops/RELEASE.md` "Manual patch-completeness check". |
| F-T24c-1 (D120) | LOW, a11y | CLOSED | `ExampleChip` fixed to 6.87:1 in D123 (T24d-frontend) |
| F-T18.1-1 (D121) | LOW | **OPEN** | `purgeInboxData`'s `complete:false` is reported but nothing re-drives it. D121 suggests "a T25 runbook line" — `docs/ops/RUNBOOK.md` is not in this task's owned-files list, so the line was not added; flagged here for whoever next touches RUNBOOK.md. |
| F-D74-1 (D122) | LOW | **OPEN, accepted** | `watches.sweep` single-tick fairness (one user's overdue backlog can absorb a whole 50-row tick); not a monopoly (rows are bumped, not starved); optional `WATCH_SWEEP_PER_USER` fix was not applied — still the sole expected-fail in the suite (§3 above, 1322 total incl. this one) |
| F-T24d-1 (D123) | LOW | **OPEN** | `INBOX_DELETE_MAX_ATTEMPTS` still hand-mirrored in `src/pages/Settings.tsx` instead of exported from `convex/limits.ts` (verified via grep — the constant and its "mirrors... not imported" comment are both still present); frontend/backend touch, out of T25's owned files |
| B1–B6 + LOWs + F-T18.5-1 (D124) | was MEDIUM/HIGH-adjacent (checkpoint 6c conditions) | **CLOSED**, except F-T18.5-1 | All six lettered conditions landed in T18.5 (D128: "T18.5 ... landed"); reset-code-for-tombstoned, `profiles.me` gating, and the `mailDataPurged` schema comment were verified fixed by direct code read this session. **F-T18.5-1 (LOW)** `readParentTable`'s O(n²) `take(skip+need+1)` remains, but was explicitly noted "unreachable under current caps" when filed — no fix required |
| F-T23-3 (D125) | was MEDIUM | CLOSED | `ops.resetRetentionCursor` added and RUNBOOK §11 rewritten (commit `a744168`) |
| F-T23-1 (D125) | LOW | **OPEN, informational** | Local Node version mismatch (§2) — process note, CI unaffected |
| F-T23-1b (D125) | LOW | CLOSED (documented) | `seedFixtures`' queued `mailLog` row is render-only — documented in `docs/ops/RUNBOOK.md` (§ "seedFixtures' queued mailLog row is render-only") and `docs/ops/ENVIRONMENT.md` is consistent with it |
| F-T23-2 (D125) | LOW/MEDIUM (labeled inconsistently across docs; CONNECTIONS.md's F-AUD-11 calls it LOW, "a test-invocation hazard, not a product defect") | **CLOSED by this task** | `e2e/README.md` now names F-T23-2 explicitly and warns against `--workers` > 1 — see the diff summary at the end of this document |
| F-AUD-1 (D126) | **HIGH** | **CLOSED** | `purchases.board` bounded in T24e (D127); fail-before/pass-after at 100×50 and 200×50 |
| F-AUD-2 (D126) | MEDIUM | **CLOSED** | Single-flight `ensureInbox` provisioning landed in T18.5 (commit `4c3c71e`, "single-flight provisioning") |
| F-AUD-3 (D126) | truthfulness of the register | **CLOSED** | Relabeling done directly in the adopted `docs/team/CONNECTIONS.md` table (D126: "done in the adopted table") |
| F-AUD-6 (D126) | MEDIUM, release completeness | **CLOSED by this document** | Static deploy + smoke (§6), export/import proof (§7), release manifest (this file) |

**Zero open HIGH or CRITICAL findings.** The only production action this
manifest does not perform is the production deploy itself, stated explicitly
as not authorized (§12).

## 12. Rollback limits (see `docs/ops/RELEASE.md` for the full deploy-order
writeup)

- **Cannot un-send mail.** A claim email or price-drop alert already handed
  to AgentMail is not unsent by any action in this app (`docs/ops/RUNBOOK.md`
  §8.3).
- **Schema fields stay.** This repo's schema changes are additive-only; a
  rollback to older code does not remove new (optional) fields, and old code
  redeployed over the *current* schema is not the same as redeploying the
  commit that shipped with an older schema (`RUNBOOK.md` §8.1).
- **Data written by the new code stays.** Rows already written by a
  since-rolled-back version are not reverted; fixing forward or restoring
  from a backup (§7's mechanism) are the only ways to correct bad data
  (`RUNBOOK.md` §8.2).
- Redeploying the previous tag is `git checkout <previous tag>` (or the
  commit it points at) into a fresh detached worktree, then the same
  `npm ci && npm run build && npx convex deploy && npm run deploy` sequence
  — see `docs/ops/RELEASE.md`.

## 13. Production deployment — NOT authorized, NOT performed

Per D83 item 6, restated by this task's own launch brief: **production
deploy to `cool-oyster-399` is not authorized in this mission.** No command
in this task touched, queried, or attempted to reach `cool-oyster-399`.

**The single remaining action, exactly as it will need to be run:**

```sh
deploy rc-2026-09-21 to cool-oyster-399 and run scripts/smoke.mjs against it
```

Concretely (see `docs/ops/RELEASE.md` for the full sequence with backup and
migrations interleaved):

```sh
git fetch origin --tags
git worktree add --detach <path> rc-2026-09-21
cd <path> && npm ci
CONVEX_DEPLOYMENT=<prod deployment name> npx convex deploy
CONVEX_DEPLOYMENT=<prod deployment name> npx convex run lib/authMigrate:normalizeLegacyAccounts '{}'
CONVEX_DEPLOYMENT=<prod deployment name> npx convex run market:migrateStamps '{}'
npm run build
CONVEX_DEPLOYMENT=<prod deployment name> npx @convex-dev/static-hosting upload --dist dist --prod
node scripts/smoke.mjs https://cool-oyster-399.convex.site
```

This has not been run. Whoever is authorized to run it (the user/co-author,
per D83's own risk note: "Production deployment authority and credentials
belong to the user/co-author") should read `docs/ops/RELEASE.md` in full
first — it also lists the env vars to set/verify by name and the four CI
secrets that are still missing.
