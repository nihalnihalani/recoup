# Handoff (lead-owned) — replaced by T25, 2026-09-21

Written by T25 (sonnet-verifier) at the close of Phase 5 release preparation.
Supersedes the previous version of this file (which described an earlier,
different session — Charlie Gillet's hackathon build on a different
deployment, `PR #1`, the `nihal-team` branch line). That earlier context is
historical now; see "Historical documents" at the bottom if you need it.
**This file describes the current "production hardening" mission (T01–T25,
`docs/team/PLAN.md`/`docs/team/DECISIONS.md` D01 onward) only.**

## Where the product is

- **Implementation: complete locally, verified through Phase 4, release
  candidate cut and smoke-tested against the disposable dev deployment.**
  **Production deployment: not performed, not authorized in this mission.**
- **Candidate:** `3f5f739f27138eb1c77c6e8cd2559e66297b0a1c` (short `3f5f739`),
  code-identical to `4c3c71e` (T18.5 + T24e; `3f5f739` only adds one docs
  file). Tagged **`rc-2026-09-21`** (annotated, pushed to `origin`).
  **Superseded as of D129** (Opus checkpoint 6d, found concurrently with
  this task): one new MEDIUM (B-9, alert webhook `events` surviving past
  their `outboundMessages` row's 7-day purge) routed to **T18.6**
  (sonnet-backend, in flight). The next candidate will be tagged
  `rc-2026-09-21.2` — `rc-2026-09-21` itself never moves. See
  `docs/reviews/release-candidate.md`'s banner and §14 for the exact,
  mostly-mechanical reissue delta.
- **Dev deployment `adorable-lion-138`** (disposable, D83 item 3): current
  code deployed (`npx convex dev --once`, wave-11 close), current candidate's
  static site deployed and smoke-tested (6/7 — see below), one full
  export/import backup-restore cycle proven on it.
- **Production deployment `cool-oyster-399`** (co-author's team, D83 item
  6): **not touched by this mission.** No command in T23/T24/T25 read from,
  wrote to, or deployed to it. Whether it is currently running an older,
  unrelated build (e.g. the historical Charlie/PR#1 line referenced in the
  old version of this file) is unknown to this mission and out of scope to
  check.

## What is done

Every task T01–T24 is `verified` in `docs/team/PLAN.md`'s status column.
Highlights relevant to resuming:

- **Phases 1–3** (auth/verification, durable mail, market recovery,
  dashboard accounting, freshness/fairness, retention, account
  export/deletion): implemented, tested, Opus-checkpointed (checkpoints
  6a/6b/6c all closed with fail-before/pass-after regressions).
- **Phase 4** (`docs/reviews/phase4-verification.md`, T23; fresh 36-connection
  audit, `docs/team/CONNECTIONS.md`, adopted D126): P01–P12 all PASS or
  PASS-local/BLOCKED-live except P12, which was PARTIAL pending this task's
  backup/restore proof — now closed (`docs/reviews/release-candidate.md`
  §7).
- **Phase 5** (this task, T25): release manifest, static deploy + smoke
  proof, backup/restore proof, release procedure, this handoff. See "Where
  every doc lives" below.

## What is BLOCKED, and why

| What | Why | Where documented |
|---|---|---|
| Production deploy to `cool-oyster-399` | D83 item 6: not authorized in this mission — "Production deployment authority and credentials belong to the user/co-author." | `docs/ops/RELEASE.md` §5 ("The single remaining action"); `docs/reviews/release-candidate.md` §13 |
| Real provider sends (live verification/reset email, live price-drop alert, live ShopSavvy lookup) | D83 item 3: `adorable-lion-138` carries placeholder AgentMail/OpenAI keys and no `ALERTS_INBOX_ID`/`SHOPSAVVY_API_KEY` by design — real sends were never authorized in this mission, on any deployment | `docs/ops/ENVIRONMENT.md`; `docs/reviews/phase4-verification.md` §5 |
| CI codegen-drift check (`codegen:check`) | Needs a dedicated Convex deployment's admin key as a repo secret; none is provisioned | `docs/ops/RELEASE.md` §4; `docs/ops/INSTALL.md` |
| CI Playwright job (`e2e`) | Needs `E2E_CONVEX_URL`/`E2E_DEPLOY_KEY` repo secrets pointing at a dedicated deployment; none is provisioned | `docs/ops/RELEASE.md` §4 |
| `scripts/check-patch.mjs` asserting the full AgentMail patch (not just the env declaration) | F-T18.4-1 (D119): scripts are source, out of every `sonnet-verifier` task's file-ownership list so far; a manual check is documented instead | `docs/ops/RELEASE.md` §2 |
| `rc-2026-09-21.2` tag/manifest reissue | Blocked on **T18.6** (sonnet-backend, in flight) landing the B-9 MEDIUM fix + B-1…B-7 LOWs from checkpoint 6d (D129); the lead will message the new candidate hash once it's gated | `docs/reviews/release-candidate.md` banner + §14 (the reissue delta — mostly mechanical, not a redo) |

None of the above blocks the release candidate itself — every open finding
in the register is LOW (`docs/reviews/release-candidate.md` §11). They block
only the *next* action past this candidate (an actual production deploy, or
tightening CI further).

## Where every doc lives

| Doc | What it is |
|---|---|
| `docs/team/PLAN.md` | The task roster (T01–T25), file ownership, verbatim contracts, wave sequencing |
| `docs/team/DECISIONS.md` | D01–D128: every lead adjudication, in order, each with rationale and what it affects. D83 is the authorization anchor most other decisions reference. |
| `docs/team/CONNECTIONS.md` | The current (post-D126) 36-connection audit: register, invariants, findings, verdict. Prior register archived as `docs/team/CONNECTIONS-2026-09-21-pre-audit.md`. |
| `docs/reviews/phase4-verification.md` | T23's full Phase 4 run: gates, smoke, scheduler scenario, browser suite, P01–P12 table, findings F-T23-1…4 |
| `docs/reviews/endpoint-inventory.md` | Every public Convex function, its auth/validation/spend shape |
| `docs/reviews/read-budgets.md` | Bounded-read measurements referenced by the invariants table |
| `docs/reviews/release-candidate.md` | **New, this task.** The release manifest: candidate identity, toolchain, gates, `dist/` hashes, env presence matrix, static deploy + smoke proof, backup/restore proof, crons, findings register, rollback limits, the one remaining production action |
| `docs/ops/RELEASE.md` | **New, this task.** How to actually ship: deploy order, the `CONVEX_DEPLOYMENT`-vs-`CONVEX_DEPLOY_KEY` footgun, manual patch check, rollback procedure, the four missing CI secrets |
| `docs/ops/RUNBOOK.md` | Day-2 operations: pause/resume, key rotation, migrations, backlog reading, log kinds, webhook disable, rollback limits, backup/restore commands, retention cursor reset, account deletion |
| `docs/ops/ENVIRONMENT.md` | Every env var this app reads, by deployment tier, with what happens if it's unset |
| `docs/ops/INSTALL.md` | Node pinning, `npm ci` requirements, CI gates, dependency-audit triage |
| `e2e/README.md` | Browser suite: how to run it, why `workers: 1` is required (F-T23-2, now named explicitly), known findings/gaps |
| `docs/team/VERIFICATION.md` | Append-only verification log from early in the mission (Phase 0/1 era; largely superseded by `phase4-verification.md`/`release-candidate.md` for current status) |
| `docs/team/HANDOFF-charlie-session.md`, `HANDOFF-product-direction.md`, `HANDOFF-ui-session.md` | **Historical** — a different, earlier session (2026-09-20, Charlie Gillet's hackathon build, deployment `earnest-setter-354`/`allgas` team). Not part of this mission's current state; kept for archival reference only. |

## How to resume

1. Read this file, then `docs/reviews/release-candidate.md` in full (the
   manifest for the current candidate) — it tells you exactly what has and
   has not been verified, and against which deployment.
2. If your job is to **ship to production**: read `docs/ops/RELEASE.md` in
   full before running anything — §0 explains a real footgun in
   `npx convex deploy`'s deployment-selection rule that this task avoided by
   using the static-hosting package's `upload` subcommand instead. Confirm
   you actually hold the D83-item-6 authorization to deploy to
   `cool-oyster-399` before proceeding; if you don't, stop and ask the
   user/co-author.
3. If your job is to **continue hardening** (a new finding, a new feature):
   read `docs/team/PLAN.md` for the task/file-ownership convention and
   `docs/team/DECISIONS.md` for precedent before writing anything — this
   mission has strong conventions (pathspec-only commits, no `git stash` on
   the shared tree, additive-only schema, fail-closed on every missing
   secret) that are cheaper to follow than to rediscover.
4. If your job is to **verify again** (a future T2x-style pass): the
   detached-worktree pattern used throughout (`git worktree add --detach
   <scratch> <commit>`) is how every gate run in this mission stays
   reproducible independent of concurrent edits on the shared `main`
   checkout — use it rather than running gates in the shared checkout
   directly.
5. `git log --oneline -20` and `docs/team/DECISIONS.md`'s last few entries
   are the fastest way to confirm nothing has moved since this file was
   written — this mission runs several concurrent agent lanes against the
   same working tree by design (see `docs/reviews/endpoint-inventory.md`'s
   own header), so `origin/main` can advance between sessions.
