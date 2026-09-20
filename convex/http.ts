import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { components } from "./_generated/api";
import { registerStaticRoutes } from "@convex-dev/static-hosting";
import { auth } from "./auth";
import { agentmail } from "./mail";

const http = httpRouter();

auth.addHttpRoutes(http);

http.route({
  path: "/agentmail/webhook",
  method: "POST",
  handler: httpAction(async (ctx, req) =>
    // Cast: @agentmail/convex@0.1.0's RunMutationCtx type predates the
    // `runMutation(fn, args, options)` transactionLimits overload convex
    // 1.46 added to GenericActionCtx, so the structural check between the
    // two `runMutation` signatures fails even though the runtime call here
    // (`ctx.runMutation(fn, args)`, no options) is fully compatible.
    agentmail.handleWebhook(
      ctx as unknown as Parameters<typeof agentmail.handleWebhook>[0],
      req,
    ),
  ),
});

// Must be last: exact routes above win over the static catch-all.
registerStaticRoutes(http, components.staticHosting);

export default http;
