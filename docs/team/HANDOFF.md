# Handoff (lead-owned) — updated 2026-09-21 ~01:00 UTC

## Situation
Two lines exist:
- **origin/main** (345e8da): a collaborator's line ("Charlie", Convex team `allgas`, dev deployment `earnest-setter-354` with all keys). 394 tests. Live-verified I0–I3, I6, W1–W4, T1 on their deployment. Product pivot recorded in `docs/team/HANDOFF-product-direction.md`: returns story removed from pitch/UI (backend kept). Pushed over our main at 17:49 PT with their implementations winning conflicts.
- **origin/nihal-team** (22690c6): this team's line. 233 tests. Contains D39, D45 floor, D52–D58, T10.1, scenario suite. Our dev deployment `adorable-lion-138` has no provider keys.

## Open decision (user)
Which line is canonical, and whether the returns case stays in the pitch. Lead recommends: adopt origin/main, keep returns in product and demo per the approved design. See the lead's report in the session transcript.

## In flight
- `sonnet-porter`: porting D39, D45 floor, D52–D58 onto origin/main as branch `port-checkpoint-fixes` (pushed as a branch only; never to main).

## Rules now in force
- Nobody pulls/merges/rebases/pushes `main` until the user decides.
- Our local checkout stays on our line until then.

## External blockers (unchanged for our deployment)
OPENAI_API_KEY, AGENTMAIL_API_KEY, AGENTMAIL_WEBHOOK_SECRET absent on `adorable-lion-138`. Charlie's deployment has them.

## C04 root cause
`ctx.runAction(components.agentmail.lib.createInbox)` fails to resolve on our unpatched component; Charlie's line patches `@agentmail/convex` `convex.config.js` (patch-package) to declare `env: { AGENTMAIL_API_KEY }` and created an inbox live. Adopting their line closes C04.
