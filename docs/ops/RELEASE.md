# Release procedure

Owner: T25 (sonnet-verifier). Source contract: `docs/team/PLAN.md` "### T25
—", `docs/team/DECISIONS.md` D83 (authorizations), D119 (F-T18.4-1: manual
patch-completeness check, not a `scripts/check-patch.mjs` extension — scripts
are source, out of this task's owned files), D126 (F-AUD-6). Companion
documents: `docs/reviews/release-candidate.md` (the manifest for the current
candidate), `docs/ops/RUNBOOK.md` (day-2 operations), `docs/ops/ENVIRONMENT.md`
(the full variable reference this file only summarizes).

**This document describes how to ship a real production release. No command
in it has been run against production by this task.** `docs/reviews/
release-candidate.md` §6–§7 record what *was* actually run (static deploy +
smoke + backup/restore, all against the disposable `adorable-lion-138`
only). Production deploy to `cool-oyster-399` is not authorized in this
mission (D83 item 6) — see "The single remaining action" below.

> **Update: `rc-2026-09-21.2` is now the current candidate.** T18.6 (D131,
> commit `357dc37`) landed and closed the MEDIUM (B-9) and LOWs checkpoint
> 6d found against `rc-2026-09-21`/`3f5f739`, including **F-T18.4-1's own
> manual patch-completeness check below** (§2) — re-run against `357dc37`
> and still passing (`purgeOutbound` now appears twice in `lib.js`, matching
> its widened `{outboundId?, messageId?}` signature). `rc-2026-09-21` is
> untouched and still points at `3f5f739` (tags never move) — it is a
> historical record, not the deploy target. **The procedure below is
> unchanged** — deploy order, the `CONVEX_DEPLOYMENT` footgun, rollback
> limits, and the four missing CI secrets are all process documentation,
> independent of which commit is the current candidate; only the tag name in
> §5's final command changed (now `rc-2026-09-21.2`). Full delta:
> `docs/reviews/release-candidate.md` §15.

## 0. Before you start

- Read `docs/reviews/release-candidate.md` for the exact candidate you are
  about to ship (SHA, tag, dist hashes, findings register — confirm no open
  HIGH/CRITICAL).
- Confirm you have the authority and credentials D83 reserves to the
  user/co-author for a production deploy. This file assumes you do.
- **`CONVEX_DEPLOYMENT` vs `CONVEX_DEPLOY_KEY` — read this before running
  `npx convex deploy` for real.** `npx convex deploy --help` states its own
  deployment-selection rule: if `CONVEX_DEPLOYMENT` is set (the normal local
  shape, e.g. `dev:adorable-lion-138`), the target is *the project's default
  production deployment* regardless of what deployment `CONVEX_DEPLOYMENT`
  names — it does **not** mean "deploy to the dev deployment named there."
  If `CONVEX_DEPLOY_KEY` is set instead (the normal CI shape), the target is
  whatever deployment that key is scoped to. **Practical rule:** for a real
  production deploy, either (a) run from CI with a production
  `CONVEX_DEPLOY_KEY` secret scoped to `cool-oyster-399`, or (b) run locally
  authenticated as a user with access to the project, with `CONVEX_DEPLOYMENT`
  **unset** in the shell (so the CLI prompts/resolves the project's actual
  production deployment rather than silently reading a stray dev value) —
  never with `CONVEX_DEPLOYMENT` pointed at a dev deployment name "just to be
  safe", since `convex deploy` ignores that distinction entirely and still
  goes to prod. This is exactly the footgun this task's release-candidate
  manifest avoided by using the static-hosting package's `upload` subcommand
  (not `deploy`) for its own dev-only demonstration (`docs/reviews/
  release-candidate.md` §6) — `upload` has no such quirk and stays scoped to
  `CONVEX_DEPLOYMENT` unless `--prod` is passed explicitly.
- Take a backup first regardless (step 1) — cheap (took 4s / 70 KiB against
  the much smaller dev dataset; production will be larger but the mechanism
  is identical, proven end-to-end in `release-candidate.md` §7).

## 1. Deploy order

Run every command below with a deployment selector that actually reaches
`cool-oyster-399` — see the `CONVEX_DEPLOYMENT`/`CONVEX_DEPLOY_KEY` note
above before assuming any given invocation is safe to copy-paste.

1. **Backup.** `npx convex export --include-file-storage --path prod-backup-$(date +%Y%m%d-%H%M%S).zip` (the flag is mandatory since Mission 2: evidence files live in `_storage`, D244)
   against production. Keep this file somewhere durable outside the repo —
   it is the only way to recover if the release goes wrong (§3, "What a
   rollback does NOT undo").
2. **Backend deploy (schema additive).** `npx convex deploy` from a clean
   detached worktree at the release tag (`git worktree add --detach <path>
   rc-2026-09-21.2` — or whatever tag is current, per the notice above —
   `npm ci` inside it first). This repo's schema convention
   is additive-only (`docs/ops/RUNBOOK.md` §8.1), so this step never removes
   a field or breaks an in-flight older client.
3. **Run both migrations**, in either order (both are independent,
   resumable, idempotent — safe no-ops if there is nothing to migrate):
   ```sh
   npx convex run lib/authMigrate:normalizeLegacyAccounts '{}'
   npx convex run market:migrateStamps '{}'
   ```
   If `normalizeLegacyAccounts` reports `collisions > 0`, stop and resolve by
   hand before continuing (`docs/ops/RUNBOOK.md` §3) — do not re-run with
   `restart: true` until the colliding row is fixed.
4. **Static deploy.** `npm run deploy` (i.e. `npx @convex-dev/static-hosting
   deploy`) builds with the production `VITE_CONVEX_URL`, deploys the Convex
   backend again (harmless — same code as step 2, the CLI no-ops on no
   diff), and uploads `dist/`. This is the one place in this file where the
   *full* `deploy` subcommand (not `upload`) is correct: in a real
   production run with `CONVEX_DEPLOY_KEY` scoped to `cool-oyster-399` (or an
   interactive session correctly resolved to it, per §0), `convex deploy`'s
   "always targets prod when ambiguous" behavior is exactly what you want,
   not a footgun.
5. **Smoke.** `node scripts/smoke.mjs https://cool-oyster-399.convex.site` (or
   `SITE_URL=... npm run smoke`). Must be 7/7 — if check 4 ("bundle
   references exactly one `.convex.cloud` host") fails, first rule out a real
   misconfigured build (two different `VITE_CONVEX_URL`s baked into the same
   `dist/`) before assuming it is the same false positive this task
   documented against the dev deployment (F-T25-1, `docs/reviews/
   release-candidate.md` §6) — that finding is about a string literal inside
   the `convex` npm package's own error message, present in **every** build
   of this app regardless of target, so the production smoke run will very
   likely reproduce the identical FAIL on check 4 for the identical reason.
   Do not treat that specific, pre-diagnosed cause as a new incident; do
   treat any *different* second host as one.
6. **Set/verify environment by name** (never print or log values — `npx
   convex env list` names only):
   - `AGENTMAIL_WEBHOOK_SECRET` — must be **set**, and must match the value
     configured in the AgentMail webhook dashboard (rotate together per
     `docs/ops/RUNBOOK.md` §2 item 4, never independently).
   - `ALERTS_INBOX_ID` — must be **set** so auth verification/reset mail and
     price-drop alerts have a shared sending inbox (`docs/ops/ENVIRONMENT.md`
     "Server-side secrets required for one feature").
   - `CONVEX_SITE_URL` — platform-provided automatically on every
     deployment; **confirm it actually contains `cool-oyster-399`** (this is
     the literal substring `convex/testing.ts`'s `PRODUCTION_HOST_MARKER`
     and `convex/lib/authMail.ts`'s `recordE2ECode` both check against — if
     production ever moves to a different deployment name, both of those
     hardcoded constants must be updated in the same release, or the E2E
     production-refusal guard silently stops working, per
     `docs/ops/ENVIRONMENT.md`'s own warning).
   - `E2E_SEED_ENABLED` — **must be unset** (confirm with `npx convex env
     list`, not assumed). If it is ever set to `"true"` on this deployment,
     every real sign-up and password reset fails loudly and immediately
     (D107; `docs/ops/RUNBOOK.md` §10) — this is not a low-stakes variable to
     leave "just in case."
   - The full required/optional/E2E-only variable list, with what each one
     gates and what happens if it is missing, is `docs/ops/ENVIRONMENT.md` —
     this file only calls out the four most consequential to get right at
     release time.
   - Re-run `npx convex env list` (names only) **after** the deploy too, not
     just before — step 2/4's `npx convex deploy` cannot remove an env var by
     itself, but this closes the loop on any change made concurrently by
     someone else during the release window.

## 2. Patch-completeness check (F-T18.4-1)

> **Update (P11-W3 / P12-W11 re-audit, ingestion-integrations lane, D244):**
> `scripts/check-patch.mjs` (`npm run verify:patch`, also a CI step) now
> asserts the `purgeInbox`/`purgeOutbound`/`by_inbox` hunks below itself —
> it checks dist `lib.js`'s and `schema.js`'s exports/indexes against the
> `@agentmail/convex` package's own shipped `src/`, plus an explicit floor
> (both purge exports present; at least 3 `by_inbox` indexes) so a `src/`
> that regressed the same way cannot pass by matching a bad `dist/`. The
> manual grep this section used to require is now redundant with `npm run
> verify:patch` and is kept below only as a description of what that command
> checks, not as a separate release step. Regression coverage:
> `convex/checkPatch.reaudit.test.ts` (runs the real script against
> constructed dist/src fixtures, including a scratch copy with only the
> `lib.js`/`schema.js` hunks reverted — the exact case this section used to
> warn about, and the one D119 originally left as a manual step because
> `scripts/check-patch.mjs` was out of that task's owned files).

`scripts/check-patch.mjs` asserts that `node_modules/@agentmail/convex/dist/
component/convex.config.js` has the `env: { AGENTMAIL_API_KEY` declaration
from `patches/@agentmail+convex+0.1.0.patch`, AND that the same patch's
`purgeInbox`/`purgeOutbound` (T18.4/D119, account-deletion mail purging) and
their `by_inbox` indexes survived into dist `lib.js`/`schema.js`. `npm run
verify:patch` (part of the standard gate, and a CI step) is sufficient —
nothing below needs to be run by hand. Equivalent to what the script itself
checks, if you want to eyeball it:

```sh
grep -c 'purgeInbox' node_modules/@agentmail/convex/dist/component/lib.js
# expect a nonzero count (1, in the pinned 0.1.0 + patch combination)

grep -n 'by_inbox' node_modules/@agentmail/convex/dist/component/schema.js
# expect at least 3 matches — .index("by_inbox", ["inboxId"]) on the
# inboundMessages/outboundMessages/events tables (a 4th, unrelated
# `by_inboxId` index on a different table is expected too and is not part of
# this check)
```

If `verify:patch` fails on either the lib.js/schema.js parity check or the
floor check, `patch-package` silently failed to apply the full patch (or
`@agentmail/convex` was reinstalled without it) — do not deploy, re-run `npx
patch-package --error-on-fail`, and re-check.

## 3. Rollback limits

Full detail: `docs/ops/RUNBOOK.md` §8 ("What a code rollback does NOT
undo"). Summarized for release time:

1. **Cannot un-send mail.** A claim email or price-drop alert already handed
   to AgentMail is gone; `mailLog`/`drafts` rows only record what happened.
2. **An older tag may be undeployable.** Convex validates stored data
   against the schema pushed with the code, so a tag whose schema predates
   data already written is rejected. After Mission-2 data exists, a
   pre-Mission-2 tag cannot be redeployed; rollback is forward-only (revert
   on top of current main, use the operator pauses/flags, restore a backup
   with `--include-file-storage` into a fresh non-production deployment).
   See RUNBOOK §8 (D244).
3. **Data written by the new code stays.** Rolling back stops the bad code
   from writing *more* bad data; it does not touch rows already written. Fix
   forward, write a targeted migration, or restore from the backup taken in
   step 1 — there is no fourth option.

**To redeploy the previous tag** — only when the previous tag belongs to the
**same schema generation** (its `convex/schema.ts` accepts every document
already stored; check `git diff <previous-tag> HEAD -- convex/schema.ts` for
removed fields, narrowed unions or new required fields first). Production
deploys are not authorized in this mission (D136); this procedure is for a
future authorized operator:

```sh
git fetch origin --tags
git worktree add --detach <path> <previous-tag>
cd <path> && npm ci
npx convex deploy               # per §0's targeting note
npm run build
npx @convex-dev/static-hosting upload --dist dist --prod
node scripts/smoke.mjs https://cool-oyster-399.convex.site
```

This redeploys old *code* only — re-read rollback limits 1–3 above before
assuming it undoes anything else.

## 4. Missing CI secrets (four, named from `.github/workflows/ci.yml`)

None of these are currently provisioned as GitHub repo secrets. CI is not
broken by their absence — every gated step prints a skip notice and exits 0
(`.github/workflows/ci.yml`'s own comments say so at each site) — but CI is
running with less coverage than the workflow file describes until they
exist:

| Secret | Gates | Effect while absent |
|---|---|---|
| `CODEGEN_CHECK_CONVEX_URL` | `checks` job, `codegen:check` step | `scripts/check-codegen.mjs` prints a skip notice, exits 0 — codegen drift is never checked in CI (`docs/ops/INSTALL.md` "requires a live Convex deployment") |
| `CODEGEN_CHECK_CONVEX_ADMIN_KEY` | same step, paired with the URL above | same effect |
| `E2E_CONVEX_URL` | `e2e` job | The whole Playwright run is skipped in CI ("E2E_CONVEX_URL / E2E_DEPLOY_KEY are not configured -- skipping the Playwright run") |
| `E2E_DEPLOY_KEY` | same job, paired with the URL above | same effect |

Provisioning either pair requires a **dedicated** Convex deployment (never
`adorable-lion-138` — an ephemeral GitHub-hosted runner should not hold
write-capable admin credentials to the team's shared dev deployment, and
never `cool-oyster-399` — a CI secret is not an acceptable place to keep
production credentials either) — see `docs/ops/INSTALL.md`'s
`codegen:check` section for the exact provisioning steps for the first pair;
the same reasoning applies to a dedicated E2E deployment for the second
pair. `E2E_BASE_URL` (also read by the `e2e` job) is optional and not part
of the four — the job does not gate its presence, only `E2E_CONVEX_URL`/
`E2E_DEPLOY_KEY`.

## 5. The single remaining action

Everything above this line is documentation and a rehearsed, verified
procedure. **Nothing in this task deployed to production.** The exact
action still outstanding, worded the way it should be executed:

```
deploy rc-2026-09-21.2 to cool-oyster-399 and run scripts/smoke.mjs against it
```

(Substitute whatever tag is actually current if this file is read after a
further reissue — see the superseded notice at the top.) This requires the
production deploy authority D83 item 6 reserves to the user/co-author. See
`docs/reviews/release-candidate.md` §13 for the same statement alongside the
concrete command sequence.
