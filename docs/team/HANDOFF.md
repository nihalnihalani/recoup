# Handoff (lead-owned) — updated 2026-09-21 ~03:30 UTC

## Where the product is
- **Production:** https://cool-oyster-399.convex.site (Charlie Gillet's deployment, all keys). Full loop verified live by their session (their status log I7a). Remaining on their side: video, social post, submission. Deadline 2026-09-22 12:00 PT; their code freeze 08:00 PT.
- **main** (acb5e6f): Charlie's line. Do not push to it from this team; coordinate by PR.
- **PR #1** https://github.com/nihalnihalani/recoup/pull/1: `port-checkpoint-fixes` = b878dc9 + our unique fixes (D52–D58, F3, F5). 564 tests, clean, no conflicts with acb5e6f. Awaiting Charlie/Nihal merge.
- **nihal-team**: this team's full line and all `docs/team/*` history (DECISIONS D01–D59, CONNECTIONS with live statuses from their log, VERIFICATION).

## Open decision (user)
Whether the under-credited-return story stays in the pitch/video. Charlie's handoff removes it; Nihal's approved design leads with it. Backend supports both.

## Our dev deployment
`adorable-lion-138` (team nihal-nihalani): no provider keys; superseded by production above. Can be deleted or kept for tests.

## Backlog (low severity, from checkpoint 3)
Single-label/internal hosts reach Firecrawl (their egress policy); patch-package is a devDependency (prod installs must include it); dashboard read budget on heavy accounts; verdict uses stale lastCents when all recent checks fail; insights double-counts a bought watch; no email verification on sign-up (global mail cap is the mitigation).

## If resuming this session
`ListAgents` first; no teammates are expected to be alive. Re-read this file, then PR #1 status.
