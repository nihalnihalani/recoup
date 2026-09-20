# Handoff (lead-owned)

Current state: see PLAN.md statuses and CONNECTIONS.md. On resume: re-read DECISIONS.md, run `ListAgents`, do not assume prior teammates survived.

External blockers requiring the user:
1. Set `OPENAI_API_KEY` and `AGENTMAIL_API_KEY` on the dev deployment: `npx convex env set OPENAI_API_KEY <value>` and `npx convex env set AGENTMAIL_API_KEY <value>` from the repo root.
2. Create an AgentMail webhook at `https://adorable-lion-138.convex.site/agentmail/webhook` for `message.received`, then `npx convex env set AGENTMAIL_WEBHOOK_SECRET <whsec_...>`.
3. Production deploy, real sends, social post and submission need explicit authorization (PLAN T14–T16).
