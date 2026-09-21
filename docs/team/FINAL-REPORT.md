# Recoup production-hardening mission — final report

Status line: **implementation complete locally; live integration verification incomplete.**
Release candidate: **`rc-2026-09-21.2` = `357dc37`** (annotated tag on origin; `rc-2026-09-21` = `3f5f739` kept as the prior manifest). Production deployment was not authorized and was not performed.

## 1. What now works

Compared with the mission start (`70bf996`, 575 tests), main now carries 240+ hardening commits and 1,338 tests (1,337 pass + 1 documented expected-fail). Everything below is proven by tests under `convex-test` with `transactionLimits: true`, by the Playwright suite against the disposable dev deployment `adorable-lion-138`, or by a dated live run named in the evidence column of `docs/team/CONNECTIONS.md`.

- **Auth (P01):** Password sign-up/sign-in/verify/reset with mandatory email verification; codes bound to the account; wrong-password, lockout and unknown-address errors byte-identical (no oracle); sign-up on an existing address never authenticates; per-email and global rate limits; legacy-account normalisation migration; sign-in refused for deleted accounts via `beforeSessionCreation`; reset codes not sent to deleted accounts.
- **Money (P02–P04):** integer cents everywhere; only user confirmation creates `confirmed_credit`; `unresolved = expected − confirmed + later debits`; append-only ledger with per-claim idempotency (internal keys now SHA-256 so long Message-IDs cannot drop a merchant's credit reply); approval bound to draft+claim version; outbound mail is `queued` until the provider returns a message id; recipient gate; bounded evidence/reason strings.
- **Mail (P05):** AgentMail webhook verified + deduped, fails closed with 401 even when the secret is unset; inbound routed by inbox→profile→user with per-inbox rate limit and per-user + global extraction budgets; alert gate order deleted → no_email → unverified → opted_out → suppressed; one-click unsubscribe (GET never unsubscribes); stalled-send sweep; structured redacted logging with correlation ids replacing every `console.error`.
- **Price tracking (P06):** no wall clock in reactive queries (coarse `now`); watches/items scheduling cannot starve or permanently drop an item (resurrection paths proven against 500 rotating fillers); market lookups are a transactional state machine with truthful retry accounting; stale prices excluded from "lowest" and flagged in the UI; dashboards budget reads by rows actually read and report `truncated` only on real cuts (read budgets down ~4×; `purchases.board` and `tracking.overview` under 4,096 ranges at 200×50).
- **Retention & lifecycle (P07, P09):** daily resumable retention sweep (payload strip, per-parent check pruning, mail-log/opsState pruning, never-verified-account hygiene) that provably never touches money tables; paged data export (IDOR-proof, terminating); typed-confirmation deletion that tombstones first, revokes sessions, suppresses queued mail, purges every owned table child-before-parent, purges the AgentMail component's stored mail (own inbox and alerts sent to the user), deletes the remote inbox with bounded retry, and reports `inboxDeleted`/`mailDataPurged` truthfully; every write lane and read query is tombstone-gated; stuck deletions re-driven daily and surfaced in `ops.backlog`.
- **Ops (P10–P12):** `returns` validators on 57/57 public functions; operator pause/resume, backlog and retention-cursor reset; smoke script; RUNBOOK/ENVIRONMENT/INSTALL/RELEASE docs; CI with pinned Node, patch verification, minimum test count; Playwright suite with axe (12/12 page checks real and passing at WCAG AA); public `/privacy` page with truthful copy.

## 2. Opus/Sonnet roster and model verification status

| Role | Agent name | Self-reported model | Work |
|---|---|---|---|
| Lead (planning, orchestration, checkpoints routing, docs/team, wave-close gates, codegen, deploys) | this session | Opus 5 (`claude-opus-5`) | 133 decisions D01–D133, PLAN/CONNECTIONS/VERIFICATION |
| Devil's advocate (read-only) | `opus-devils-advocate` | Opus 5 | checkpoints 4, 4-recheck, 5, 5-recheck, 6a, 6b, 6c, 6d, 6e |
| Contract mentor / auditor (read-only) | `opus-mentor`, `opus-auditor` | Opus 5 | T01/T05/T06 contract; fresh 36-connection audit |
| Backend implementers | `sonnet-backend`, `-2`, `-3`, `-4` | Sonnet 5 (`claude-sonnet-5`) | T01–T06, T10–T13, T12.2/3, T16, T16.1, T18, T18.1/3/4/5/6, T24b/e |
| Integrations implementer | `sonnet-integrations` | Sonnet 5 | T04, T07, T18.2 |
| Frontend implementer | `sonnet-frontend` | Sonnet 5 | T08, T14, T14.2, T19, T24a/c/d |
| Testers | `sonnet-tester`, `-2` | Sonnet 5 | T02, T09, T15, T20, T21 |
| Verifier | `sonnet-verifier` | Sonnet 5 | T17, T22, T23, T25 |

Model verification status: **self-reported only.** The harness exposes no API-level model identity to the lead; every agent was launched with an explicit `model` parameter (`opus` / `sonnet`) and printed the model from its own system prompt as the first line of every report. No teammate ever reported a different model than requested. Only Sonnet teammates edited production code; the lead edited only `docs/team/**` and committed the regenerated `convex/_generated/api.d.ts` at wave closes (D92).

## 3. Implemented scope and deliberate deferred items

Implemented: P01–P12 as scoped in `docs/team/PLAN.md` (T01–T25 plus fix tasks T05.1/2, T06.2, T12.1/2/3, T13.1, T14.2, T16.1, T18.1–T18.6, T24a–e), every Opus checkpoint condition through 6d, and the audit's HIGH/MEDIUM findings.

Deliberately deferred (all LOW, recorded in the D119–D133 register rows and `docs/reviews/release-candidate.md`):
- F-D74-1 single-tick fairness of `watches.sweep` (one user's more-overdue backlog can take one 50-row tick; rows are bumped, so no monopoly) — kept as the suite's one `it.fails`.
- F-T18.5-1 `readParentTable` O(n²) `take(skip+need+1)` — unreachable under current caps.
- F-T18.4-1 `scripts/check-patch.mjs` asserts only the env declaration, not the purge functions — manual check documented in RELEASE.md.
- F-T24d-1 `INBOX_DELETE_MAX_ATTEMPTS` mirrored by hand in `Settings.tsx`.
- F-T18.1-1 `purgeInboxData` `complete:false` reported but not auto re-driven.
- F-T18.6-1 a `mailLog` row whose message carries ≥ 1,000 component events is skipped by the purge and retains the address/subject/cents fields (RUNBOOK §12 re-drive); F-T18.6-2 the `inboxProvision` limiter unit is not released with a failed placeholder.
- N1 `cleanupFinalizedOutbound` is non-resumable (per-sweep budget to add); N2 shared-inbox component rows with no `mailLog`/`drafts` row (auth-mail events, replies to the alerts inbox) are never swept; N4 `releaseProvisioning` should compare-and-clear and the inbox POST has no fetch timeout.
- F-T23-1 local Node 25 vs `.nvmrc` 22 (CI uses 22).
- Not in scope by decision (D83): grandfathering unverified legacy accounts; production deployment; real provider sends; new deployments.

## 4. Validation results and links to test/connection evidence

- Lead gates on the candidate (`357dc37`): `npm test` 65 files, 1,337 passed, 1 expected fail; `npm run typecheck`, `npm run lint --max-warnings=0`, `node scripts/check-patch.mjs`, `npx convex codegen` (no diff) all clean; `npx convex dev --once` → adorable-lion-138 ready. Log: `docs/team/VERIFICATION.md`.
- Phase 4 clean-install verification (T23, `docs/reviews/phase4-verification.md`): detached worktree `npm ci` → 8/8 gates; scheduler scenario (six internal sweeps on seeded data, `ops:backlog` before/after); placeholder-key provider calls fail closed with sanitized structured logs; browser suite passes at its designed `workers: 1`.
- Browser suite (`e2e/`, D113/D120): 6 spec files × desktop + mobile against local Vite + `dev:adorable-lion-138`; all 12 axe page checks real and passing.
- Read budgets: `docs/reviews/read-budgets.md` (before/after per query; e.g. `insights.activity` 9,348 → 2,199 docs; `purchases.board` 125 ranges / 3,061 docs at 200×50 and 3,065 ranges at 60×50×2 claims).
- Endpoint inventory: `docs/reviews/endpoint-inventory.md` (57 public functions, 57/57 `returns`, bounds, spend kind, tombstone gating).
- Connection register: `docs/team/CONNECTIONS.md` (fresh Opus audit at `ba15aaf`, 36 rows with status/evidence; prior register archived alongside).
- Release candidate: `docs/reviews/release-candidate.md` (§15 = the .2 manifest), `docs/ops/RELEASE.md`. T25 (D130): gates re-run in a detached worktree at 3f5f739 (`npm ci` 2 s, test:ci 1,322, codegen no-diff, build 4 s, dist 708 KB with per-file sha256); static upload of the candidate `dist/` to adorable-lion-138 (`npx @convex-dev/static-hosting upload --dist dist` — `npm run deploy` would have targeted production and was not used); smoke 6/7 before the F-T25-1 regex fix and 7/7 after (lead re-ran: 7/7 live against adorable-lion-138 with the .2 build); backup/restore proof on the disposable deployment: `npx convex export` 70,690 B in 4 s → `npx convex import --replace-all` 670 docs in 21 s → `ops:backlog` and smoke identical before/after → E2E lead re-seeded. Tag `rc-2026-09-21` on 3f5f739 (kept); re-issued as `rc-2026-09-21.2` on 357dc37 after T18.6 (eaeb928; lockfile unchanged, `dist/` byte-identical, schema unchanged so the restore proof stands).

## 5. Opus integration verdict, remaining risks, and exact external blockers

Opus checkpoints (all read-only, each with independent repros): checkpoint 5 accepted Phase 1; 6a accepted Phase 2 and T16 with conditions (closed by T16.1/T12.3); 6b withheld T18 on five HIGHs (export IDOR, non-terminating export, ungated late writers, sign-in not tombstone-gated, mail-component retention) — closed by T18.1–T18.4; 6c accepted T18 with six conditions — closed by T18.5; **6d (D129) final verdict: T18 ACCEPT WITH CONDITIONS, F-AUD-1 CLOSED, F-AUD-2 CLOSED**, all 15+ prior repros re-run as closed, regression files 338/338; the one remaining MEDIUM (alert webhook events older than 7 days surviving deletion) and the listed LOWs were fixed in T18.6 and re-verified at **checkpoint 6e (D133): T18 ACCEPT, 357dc37 releasable as `rc-2026-09-21.2` with a LOW-only remaining list** (217/217 in the touched regression files; every prior defect assertion now fails-as-closed). Reviewer's money-history answer: the ledger is deleted with the account, no write path can land a ledger row past `deleted`, and the only survivor is the anonymous tombstone (no amounts, claims or merchants).

Fresh 36-connection audit (`opus-auditor`, D126): 16/17 invariants proven at `ba15aaf`; the two exceptions (bounded `purchases.board`, late-writer tombstone gates) were closed by T24e and T18.5 and rechecked at 6d. Nothing attacked at a trust boundary (webhook, unsubscribe, export, deletion, sign-in, approval/recipient gate, ledger) gave way.

Exact external blockers (all BLOCKED_EXTERNAL; names only, no values):
1. `OPENAI_API_KEY` — placeholder on adorable-lion-138 → extraction, classification and drafting run only through mocks.
2. `AGENTMAIL_API_KEY` — placeholder → real verification/reset mail, real alert, real claim send/reconcile/bounce, inbox create/delete never exercised live for this candidate.
3. `AGENTMAIL_WEBHOOK_SECRET` — unset on dev → the signed-webhook path is verified only in tests (the unsigned/unset path is verified live: 401).
4. `ALERTS_INBOX_ID` — absent → alerts and auth mail have no live sender.
5. `SHOPSAVVY_API_KEY` — absent → market lookups verified locally only.
6. Production deployment to `cool-oyster-399` — not authorized (D83); its env/status unverified in this mission.
7. CI secrets for `codegen:check` and the CI Playwright job (names in `.github/workflows/ci.yml`, listed in RELEASE.md).
8. No static build was deployed anywhere before T25; T25 deployed the candidate `dist/` to the disposable deployment only.

Remaining risks: shared-working-tree coordination (two index sweeps and one stash collision occurred, all recovered and now forbidden by rule); the co-author's earlier production run (`d88c5f8`, 2026-09-20) is 1,242 insertions behind this candidate in the mail/draft files, so its VERIFIED_LIVE evidence does not transfer.

## 6. How to run and review the app

```bash
git clone https://github.com/nihalnihalani/recoup && cd recoup && git checkout rc-2026-09-21.2
nvm use            # Node 22 per .nvmrc
npm ci             # postinstall applies patches/@agentmail+convex+0.1.0.patch (--error-on-fail)
npm test && npm run typecheck && npm run lint
npx convex dev     # link a dev deployment; set env by name per docs/ops/ENVIRONMENT.md
npm run dev        # Vite on :5173
```

- Browser suite: `npx playwright test` (uses `workers: 1` by design; needs `E2E_SEED_ENABLED=true` on the dev deployment and the seeded lead account — `e2e/README.md`).
- Smoke: `SITE_URL=https://<deployment>.convex.site npm run smoke`.
- Operations: `docs/ops/RUNBOOK.md` (pause/resume, backlog, retention cursor, account-deletion health, key rotation, migrations `lib/authMigrate:normalizeLegacyAccounts` and `market:migrateStamps`), `docs/ops/ENVIRONMENT.md`, `docs/ops/INSTALL.md`, `docs/ops/RELEASE.md`.
- Review trail: `docs/team/PLAN.md` (task statuses), `docs/team/DECISIONS.md` (D01–D129), `docs/team/CONNECTIONS.md`, `docs/team/VERIFICATION.md`, `docs/team/HANDOFF.md`, `docs/reviews/*`.
- The single remaining release action, not performed: deploy `rc-2026-09-21.2` to the chosen target and run `scripts/smoke.mjs` against it (RELEASE.md).
