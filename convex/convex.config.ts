import { defineApp } from "convex/server";
import { v } from "convex/values";
import agentmail from "@agentmail/convex/convex.config";
import firecrawl from "@firecrawl/firecrawl-convex/convex.config";
import staticHosting from "@convex-dev/static-hosting/convex.config";

const app = defineApp({
  env: { FIRECRAWL_API_KEY: v.string() },
});

app.use(agentmail);
app.use(firecrawl, { env: { FIRECRAWL_API_KEY: app.env.FIRECRAWL_API_KEY } });
// No httpPrefix: auth routes and the AgentMail webhook stay at the root,
// the static site is a catch-all registered last in convex/http.ts.
app.use(staticHosting);

export default app;
