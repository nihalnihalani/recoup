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

> **STATUS: `rc-2026-09-21` is SUPERSEDED. Do not deploy it.** While this
> manifest was being written, Opus checkpoint 6d (`docs/team/DECISIONS.md`
> D129, read-only at this exact candidate `3f5f739`) found one new **MEDIUM**
> finding — **B-9**: `mailPurge.cleanupFinalizedOutbound`'s daily sweep
> deletes a finalized `outboundMessages` row after 7 days but never its
> `events`, and `purgeOutbound({ outboundId })` (the account-deletion path)
> can no longer find them once the `outboundMessages` row is gone (it only
> has an `outboundId` key; `mailLog.agentmailMessageId` is the join key that
> would let it delete by message id too) — so alert delivery/bounce events
> older than 7 days can survive both the daily cleanup path and account
> deletion in the shared alerts inbox. Plus several LOW items (B-1, B-2,
> B-3, B-4, B-5, B-6, B-7). Routed to a new task **T18.6** (sonnet-backend,
> `convex/**` + `patches/**`). D129's own words: *"The release candidate
> moves to the commit after T18.6; T25's manifest is re-issued as
> `rc-2026-09-21.2` (tags never move)."*
>
> **Everything below (§1–§14) remains an accurate, truthful record of what
> was verified against commit `3f5f739`** — every gate, hash, smoke result
> and backup/restore proof is real and still holds for that exact commit. It
> is `3f5f739` itself that is no longer the team's intended release
> candidate.

## `rc-2026-09-21.2` is now the current candidate — read this first

T18.6 (D131, wave 12 close) landed and is gated. Per §14's playbook below,
the candidate is re-issued as **`rc-2026-09-21.2`** on commit **`357dc37`**.
**§15 is the current manifest section — read it before anything below.**
§1–§14 stay as the historical record for `rc-2026-09-21`/`3f5f739`; the tag
`rc-2026-09-21` itself is untouched ("tags never move").

**Opus checkpoint 6e (`docs/team/DECISIONS.md` D133, read-only at
`357dc37`) verdict: T18 ACCEPT — `357dc37` is releasable as
`rc-2026-09-21.2` with a LOW-only remaining list.** All ten T18.6 items
closed with fail-before/pass-after tests (217/217 in the touched regression
files). Four LOW items remain open (§15.8): F-T18.6-1 (wording corrected
here per checkpoint 6e's N3), F-T18.6-2, and two new ones checkpoint 6e
itself found — N1 and N2 — plus N4. None block the release; D133's own
words: "T18 ACCEPT."

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

**The single remaining action, exactly as it will need to be run — against
whichever tag is current at deploy time (`rc-2026-09-21` is superseded per
the banner at the top of this document; use `rc-2026-09-21.2` once it
exists):**

```sh
deploy rc-2026-09-21.2 to cool-oyster-399 and run scripts/smoke.mjs against it
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

## 14. Re-issuing as `rc-2026-09-21.2` (once T18.6 lands, D129)

The lead will message the new candidate hash once T18.6 (B-9 + the B-1…B-7
LOWs) is verified and gated. This section is written so that re-issue is a
short, mechanical delta against this document, not a from-scratch redo.

**Re-run, against the new commit (same commands as §3–§6 above, new
outputs):**

1. `git worktree add --detach <path> <new-hash>`, `npm ci`, all six gates
   (§3) — T18.6 touches `convex/mailPurge.ts`, `convex/account.ts` (or
   wherever the `messageId` key threads through), and `patches/
   @agentmail+convex+0.1.0.patch` (per D129: "`purgeOutbound` accepts
   `messageId` as an alternate key"), so re-run `npm run verify:patch`
   specifically, not just assume it still passes — the patch content is
   changing.
2. `npm run build`; re-hash every file under `dist/` (§4) — expect at least
   the JS chunk(s) touching `mailPurge`/`account` to change; hashes for
   unrelated chunks (e.g. `vendor-react-*`, `vendor-router-*`) should stay
   identical if their source didn't change (useful as a sanity check that
   the diff is scoped where D129 says it is).
3. Re-run the manual patch-completeness check (`docs/ops/RELEASE.md` §2) —
   the exact `grep` targets may need a third pattern for `purgeOutbound`'s
   new `messageId` parameter; check `patches/@agentmail+convex+0.1.0.patch`'s
   new diff before assuming the two existing `grep`s still cover it.
4. Static deploy the new `dist/` to `adorable-lion-138` (§6's `upload`
   command, unchanged) and **re-run `npm run smoke`**. Expect the same F-T25-1
   false positive on check 4 (it comes from the pinned `convex` package, not
   this app's code, and T18.6 does not touch dependency versions) — if check
   4 ever passes clean instead, that is itself worth a note (would mean
   something about the dependency tree changed).

**Reuse as-is (commit-independent; do not re-run):**

- §7's backup/restore proof. The export→import mechanism against
  `adorable-lion-138` was proven end-to-end and is not tied to any specific
  application commit — Convex's export/import operates on the deployment's
  data, not its code. Re-doing it for `.2` would prove nothing new. (If a
  fresh restore proof is ever wanted anyway — e.g. after T18.6 changes what
  gets written to `outboundMessages`/`events` — treat that as a deliberate
  new test, not a required part of the reissue.)
- §5's environment presence matrix, unless T18.6 adds/removes an env var
  (it does not, per D129's description — confirm with one `npx convex env
  list --deployment adorable-lion-138` names-only check rather than a full
  re-derivation).
- §9's crons list, unless T18.6 changes `convex/crons.ts` itself (D129
  describes changes to `mailPurge.ts`'s internals and the patch, not the
  cron registration/cadence).
- §8's migrations list (T18.6 does not touch `authMigrate.ts`/`market.ts`).
- §12's rollback limits and §13's deploy-sequence shape (process
  documentation, not candidate-specific) — only the tag name in the
  commands changes.

**Must be re-derived, not reused:**

- §1 (candidate SHA/tag), §2 if the toolchain machine differs, §11's
  findings register (close B-9 + whichever of B-1…B-7 T18.6 fixes; carry
  forward every LOW this document already lists that T18.6 does not touch,
  e.g. F-T25-1, F-T18.4-1, F-D74-1, F-T24d-1, F-T23-1, F-T18.1-1).
- A fresh `git tag -a rc-2026-09-21.2 <new-hash> -m ...` — **never** move or
  force-update the existing `rc-2026-09-21` tag (D129: "tags never move").

## 15. `rc-2026-09-21.2` — the current candidate (D131, wave 12 close)

Produced by following §14's playbook against the hash the lead supplied.
This section is the **current** manifest; §1–§14 above are historical for
`rc-2026-09-21`/`3f5f739`.

### 15.1 Candidate identity

| | |
|---|---|
| Candidate SHA | `357dc373ced764ef59a14a785055663315d8d8ee` (short `357dc37`) — D131's "Candidate for `rc-2026-09-21.2`" |
| Tag | `rc-2026-09-21.2` (annotated, pushed to `origin`); `rc-2026-09-21` is untouched and still points at `3f5f739` |
| Verified code-tip | `git diff 357dc37 origin/main --stat -- convex src scripts patches package.json` → **empty**. The two commits after `357dc37` on `origin/main` at verification time (`23dbebb` "wave 12 close (D131)") touch only `docs/team/{DECISIONS,PLAN,VERIFICATION}.md` |
| What changed since `3f5f739` | T18.6 (commits `a1d6670`…`357dc37`): B-9 (`purgeOutbound({outboundId?, messageId?})`; `cleanupFinalizedOutbound` deletes a purged message's events too), B-8 (`mailEvents.onEvent` purges orphaned raw events for an unmapped message id), B-1 (`policies.insertSnapshot` write-time tombstone gate), B-6 (`purchases.board` claims-read budget, `MAX_BOARD_CLAIMS_TOTAL`), B-2/B-3/B-4/B-5 (profiles provisioning gates/error handling/stale-reclaim), B-7 (`docs/ops/RUNBOOK.md` §12 bounds its own example query), and **F-T25-1** (`scripts/smoke.mjs` excludes `DOCUMENTED_EXAMPLE_HOST` — see 15.4). Full file list: `convex/{account,mailEvents,mailPurge,policies,profiles,purchases}.ts` + their `.test.ts` files, `patches/@agentmail+convex+0.1.0.patch`, `scripts/smoke.mjs`, `docs/ops/RUNBOOK.md`. `convex/schema.ts` — **unchanged** (`git diff 3f5f739 357dc37 -- convex/schema.ts` is empty) — this is why no backup/restore re-run was needed (15.3). `convex/crons.ts`, `convex/lib/authMigrate.ts`, `convex/market.ts` — also unchanged, so §8/§9 above still apply verbatim. |

### 15.2 Toolchain and gates (fresh detached worktree at `357dc37`)

| | |
|---|---|
| `node -v` / `npm -v` / `.nvmrc` | `v25.2.1` / `11.6.2` / `22` (same as §2; F-T23-1 unchanged) |
| `sha256sum package-lock.json` | `36352508cb1419cd58f5aa4f7dfd6172547af6ca405d8d267589dbb1123ca719` — **identical** to `3f5f739`'s (T18.6 touched no dependency) |

| Step | Result | Duration |
|---|---|---|
| `npm ci` | OK, same postinstall patch-package output as §3 | 2s |
| `npm run verify:patch` | OK | 0s |
| **Manual patch-completeness check** (F-T18.4-1, `docs/ops/RELEASE.md` §2) | `grep -c purgeInbox` → 1; `grep -c purgeOutbound` → 2 (widened signature confirmed — `messageId` parameter present, matches D131's B-9 description); `grep -c by_inbox` on `schema.js` → 4 | — |
| `npm run typecheck` | OK, clean | 6s |
| `npm run lint -- --max-warnings=1` | OK, clean | 0s |
| `npm run test:ci` | `[test:ci] OK - 1338 tests passed across 65 file(s)` — matches D131's "1337 pass + 1 expected fail" (1338 total) | 45s |
| `npm run codegen:check` | `[codegen:check] OK - convex/_generated matches` — no drift | 8s |
| `npm run build` | OK, `dist/` 708K, 20 files | 3s |

All gates PASS.

### 15.3 `dist/` hashes — byte-identical to `rc-2026-09-21`

T18.6 touched only `convex/**`, `patches/**`, `scripts/smoke.mjs`, and
`docs/ops/RUNBOOK.md` — no `src/**` file changed, so the built frontend is
**byte-for-byte identical** to §4's hashes (verified: every one of the 20
`dist/` file hashes from this build matches §4 exactly, filename-for-filename,
including `dist/index.html` = `e8721eff…70ed96`). Not re-listed here to
avoid duplication — see §4 for the full table.

### 15.4 Static deploy + smoke — **7/7**

```sh
CONVEX_DEPLOYMENT=dev:adorable-lion-138 npx @convex-dev/static-hosting upload --dist dist
```
(same command as §6, not `npm run deploy` — the reasoning in §6/`RELEASE.md`
§0 is unchanged) → `✨ Upload complete!`, 16s.

| # | Check | Result | Detail |
|---|---|---|---|
| 0 | `GET /` | PASS | `200 text/html; charset=utf-8` |
| 1 | `GET /watching` | PASS | `200 text/html; charset=utf-8` |
| 2 | `GET /settings` | PASS | `200 text/html; charset=utf-8` |
| 3 | `GET /claims/x` | PASS | `200 text/html; charset=utf-8` |
| 4 | bundle references exactly one `.convex.cloud` host | **PASS** | `adorable-lion-138.convex.cloud` |
| 5 | `POST /agentmail/webhook {} -> 401` | PASS | `got 401` |
| 6 | `GET /.well-known/openid-configuration -> 200` | PASS | `got 200` |

**Result: 7/7.** Check 4 now passes: `scripts/smoke.mjs` (commit `2d3b816`,
"fix(F-T25-1)") excludes `DOCUMENTED_EXAMPLE_HOST =
"happy-otter-123.convex.cloud"` by name before judging host uniqueness,
citing exactly the root cause this task diagnosed (`node_modules/convex/src/
react/client.ts:358`). **F-T25-1 is CLOSED.**

### 15.5 Backup/restore — not re-run, by design

`convex/schema.ts` is unchanged since `3f5f739` (confirmed: empty diff).
Per the lead's instruction and this document's own §14 guidance ("the
export→import mechanism ... is not tied to any specific application
commit"), the backup/restore proof was **not re-run**. §7's proof (export
4s/70,690 bytes, import 21s/670 docs, identical `ops:backlog`/smoke
before/after, E2E lead re-seeded) stands as current evidence for
`adorable-lion-138`'s backup/restore mechanism.

### 15.6 Environment presence matrix — unchanged

Re-checked with `npx convex env list --deployment adorable-lion-138`
(names only): identical set to §5 — `FIRECRAWL_API_KEY`, `AGENTMAIL_API_KEY`,
`OPENAI_API_KEY`, `JWT_PRIVATE_KEY`, `JWKS`, `SITE_URL`, `E2E_SEED_ENABLED`
present; `AGENTMAIL_WEBHOOK_SECRET`, `ALERTS_INBOX_ID`, `SHOPSAVVY_API_KEY`,
`AGENTMAIL_BASE_URL`, `APP_URL` absent. T18.6 added no new env var. §5's
table applies verbatim; `cool-oyster-399` remains unknown/not verified.

### 15.7 Migrations and crons — unchanged

`convex/lib/authMigrate.ts`, `convex/market.ts`, `convex/crons.ts` are all
unchanged since `3f5f739` (confirmed by diff). §8's migration list and §9's
7-cron table apply verbatim to `357dc37`.

### 15.8 Findings register update

| Finding | Was | Now |
|---|---|---|
| **F-T25-1** (smoke.mjs bundle-host false positive) | LOW, open | **CLOSED** — fixed in `scripts/smoke.mjs` (commit `2d3b816`); confirmed live, 15.4 |
| **B-9** (D129, MEDIUM — alert webhook events surviving 7-day purge) | MEDIUM, open | **CLOSED** — `purgeOutbound` widened, `cleanupFinalizedOutbound` deletes events too (D131) |
| **B-1, B-2, B-3, B-4, B-5, B-6, B-7** (D129 LOWs) | LOW, open | **CLOSED** — all landed in T18.6 per D131 |
| **F-T18.6-1** (D131; wording corrected per checkpoint 6e N3, D133) | — | **OPEN, LOW.** Corrected description — the original "slower to fully drain" framing understated it: a `mailLog` row whose message carries **≥ 1,000 component events is *skipped* by the purge, never drains**, and **retains** the user's email address, subject and cents fields, plus the shared-inbox `outboundMessages` row and the overflow `events` themselves. **Nothing currently reports it** — `ops.backlog.deletions` shows 0 regardless. Manual detection/re-drive documented in `docs/ops/RUNBOOK.md` §12. |
| **F-T18.6-2** (D131) | — | **OPEN, LOW.** The `inboxProvision` rate-limiter unit is not released with the placeholder after a failed provisioning POST — a deliberate secondary throttle (fails safe toward "provision less often" after an error), not a defect |
| **N1** (checkpoint 6e, D133) | — | **OPEN, LOW.** `mailPurge.cleanupFinalizedOutbound` is **non-resumable within a sweep** — it has no per-sweep delete budget, so a day with roughly ≥ 100 finalized rows at ~26 events/row (the practical ceiling before a single sweep's work exceeds what one function execution can do) can wedge the daily cron run for that inbox instead of making partial, resumed progress the way `mailPurge.purgeInboxData`/`retention.sweep` do |
| **N2** (checkpoint 6e, D133) | — | **OPEN, LOW.** Component rows in the **shared alerts inbox** (`ALERTS_INBOX_ID`) with no `mailLog`/`drafts` row behind them at all — auth-mail events (verification/reset codes) and a user's own replies sent *to* the alerts inbox — are never swept by anything; nothing walks `by_inbox` for that inbox on an age basis the way account-deletion purge walks a user's own inbox. Suggested fix (D133): a bounded daily sweep of `ALERTS_INBOX_ID` by `by_inbox` + age, independent of `mailLog` |
| **N4** (checkpoint 6e, D133) | — | **OPEN, LOW.** `profiles.ts`'s `releaseProvisioning` is not compare-and-clear (a concurrent/late caller can clear a different attempt's claim than the one it thinks it's releasing), and `createInboxRemote`'s `fetch` to the AgentMail API has no timeout (a hung provider request blocks the action indefinitely rather than failing closed on a bound) |
| Every other §11 LOW (F-T18.4-1, F-T18.1-1, F-D74-1, F-T24d-1, F-T23-1, F-T18.5-1) | LOW, open | **Still open, unchanged** — T18.6 did not touch any of these areas |

**Zero open HIGH or CRITICAL findings.** Every open item is LOW.

### 15.9 Production deployment — still NOT authorized, NOT performed

Unchanged from §13: D83 item 6 stands. **The single remaining action:**

```sh
deploy rc-2026-09-21.2 to cool-oyster-399 and run scripts/smoke.mjs against it
```

`docs/ops/RELEASE.md` §5 carries the same statement and the concrete command
sequence (now naming `rc-2026-09-21.2`).
