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
- **Current candidate:** `357dc373ced764ef59a14a785055663315d8d8ee` (short
  `357dc37`, D131 "wave 12 close"), tagged **`rc-2026-09-21.2`** (annotated,
  pushed to `origin`). This is the candidate to deploy, once authorized —
  full manifest at `docs/reviews/release-candidate.md` §15.
- **Prior candidate:** `3f5f739f27138eb1c77c6e8cd2559e66297b0a1c` (short
  `3f5f739`), tagged `rc-2026-09-21` — **superseded**, kept only as a
  historical record (`docs/reviews/release-candidate.md` §1–§14; "tags never
  move" so this tag still points at `3f5f739` forever). It was superseded by
  D129 (Opus checkpoint 6d found one MEDIUM — B-9, alert webhook `events`
  surviving past their `outboundMessages` row's 7-day purge — plus LOWs
  B-1…B-7), all fixed in **T18.6**, gated in D131, producing the current
  candidate above.
- **Dev deployment `adorable-lion-138`** (disposable, D83 item 3): current
  code deployed, current candidate's (`357dc37`) static site deployed and
  smoke-tested **7/7** (F-T25-1, the one prior smoke failure, is fixed and
  confirmed closed — see below), one full export/import backup-restore
  cycle proven on it (not re-run for `.2` — `convex/schema.ts` is unchanged
  since `3f5f739`, so the `rc-2026-09-21` proof still stands).
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
| Production deploy of `rc-2026-09-21.2` to `cool-oyster-399` | D83 item 6: not authorized in this mission — "Production deployment authority and credentials belong to the user/co-author." | `docs/ops/RELEASE.md` §5 ("The single remaining action"); `docs/reviews/release-candidate.md` §15.9 |
| Real provider sends (live verification/reset email, live price-drop alert, live ShopSavvy lookup) | D83 item 3: `adorable-lion-138` carries placeholder AgentMail/OpenAI keys and no `ALERTS_INBOX_ID`/`SHOPSAVVY_API_KEY` by design — real sends were never authorized in this mission, on any deployment | `docs/ops/ENVIRONMENT.md`; `docs/reviews/phase4-verification.md` §5 |
| CI codegen-drift check (`codegen:check`) | Needs a dedicated Convex deployment's admin key as a repo secret; none is provisioned | `docs/ops/RELEASE.md` §4; `docs/ops/INSTALL.md` |
| CI Playwright job (`e2e`) | Needs `E2E_CONVEX_URL`/`E2E_DEPLOY_KEY` repo secrets pointing at a dedicated deployment; none is provisioned | `docs/ops/RELEASE.md` §4 |
| `scripts/check-patch.mjs` asserting the full AgentMail patch (not just the env declaration) | F-T18.4-1 (D119): scripts are source, out of every `sonnet-verifier` task's file-ownership list so far; a manual check is documented instead | `docs/ops/RELEASE.md` §2 |
| ~~`rc-2026-09-21.2` tag/manifest reissue~~ | **Done.** T18.6 landed and gated (D131); reissued on `357dc37`, tag pushed, manifest delta at §15, smoke 7/7. Not a current blocker — kept as a row here only so the resolution is visible next to where the blocker used to be. | `docs/reviews/release-candidate.md` §15 |

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

## Mission 2 handoff — 2026-09-23 13:15 IST (lead)

Main: `158ab1f`. Active pack: R01 v1 only (epoch 2). R02–R05 implemented, not active (M27/M27b/M27c reviews; activation needs re-review approval + VERIFICATION source records + coverageCopy/README update per D232). Live extraction flag OFF. Production never deployed (D136). Dev deployment adorable-lion-138 last deployed at `7e6001a`.

**Paused lanes (durable worktrees; resume one batch at a time, D267):**
| Lane | Worktree / branch | State |
|---|---|---|
| Retention + privacy batch (this run) | `recoup-wt-batch1` / batch1 | Sonnet integrating backend batch B (from `recoup-wt-m2c` land-b, staged) + P09-F2 (from `recoup-wt-m30ui`); Opus audit reserved |
| M21c R03/R05 fixes (D260, D264) | `recoup-wt-m21` / m21c-wip | uncommitted, mid-way (keys_card/catalog/values) — lands with the R03 errata |
| R03 spec errata (D260) | `recoup-wt-errata-r03` / errata-r03 | workflow failed at start (usage limit); re-run |
| E6–E9 engine (D260, D264, D265) | `recoup-wt-e678` / eng678 | 2 dirty files, early |
| QA follow-up (QA-M25-1 real timers, KX3 widening, offline api.d.ts test, P10-OW-12 isolation…) | `recoup-wt-m16` / m25b | 19 dirty files, near landing |
| Ingestion re-audit batches (P07-W1/SK-1, P10-MW-2, P11-W3, P09-F1 sweep, …) | `recoup-wt-ra1` / ra2 | 3 dirty files, early (batch 1 market quality landed `d5db6b1`) |
| Frontend batch remainder (held-promise UI, deadline attention, P02-OW-4, P03-A, P05-OW3, P06 display, P09-SK-2 UI, P10-MW-1, P12-W6) | `recoup-wt-m30ui` / m30ui | WIP commits + 11 dirty files |
| M27c re-review of R02/R04 + templates | `recoup-wt-m27c` | workflow failed at start; re-run after the batch |
| R06–R25 research | `recoup-wt-rules3` / rules3 | 113 files written; 21 review/revise steps failed on the limit; resume workflow `wf_6997236e-e9c` |
Lead decisions not yet on main: D248–D262 and D266–D267 (in `docs/team/DECISIONS.pending-lead.md` in this worktree). D263 is on main (M22c). D264 and D265 were issued to M21c and E6–E9 but their lanes have not landed; each lane appends its own line when it lands.
