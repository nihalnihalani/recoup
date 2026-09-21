import { defineApp } from "convex/server";
import { v } from "convex/values";
import agentmail from "@agentmail/convex/convex.config";
import firecrawl from "@firecrawl/firecrawl-convex/convex.config";
import staticHosting from "@convex-dev/static-hosting/convex.config";
import rateLimiter from "@convex-dev/rate-limiter/convex.config.js";

const app = defineApp({
  env: { FIRECRAWL_API_KEY: v.string(), AGENTMAIL_API_KEY: v.string() },
});

// @agentmail/convex 0.1.0 sends from inside the isolated component runtime, which
// does not see deployment env vars, and the published component declares no env.
// patches/@agentmail+convex+0.1.0.patch adds the declaration; bind the key here.
app.use(agentmail, { env: { AGENTMAIL_API_KEY: app.env.AGENTMAIL_API_KEY } });
app.use(firecrawl, { env: { FIRECRAWL_API_KEY: app.env.FIRECRAWL_API_KEY } });
// No httpPrefix: auth routes and the AgentMail webhook stay at the root,
// the static site is a catch-all registered last in convex/http.ts.
app.use(staticHosting);
// Per-key quotas/cooldowns (auth attempts, auth mail, inbox provisioning,
// drop rechecks) — see convex/lib/rateLimits.ts (T01, D64).
app.use(rateLimiter);

export default app;
