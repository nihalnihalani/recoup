import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { components, internal } from "./_generated/api";
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

/**
 * One-click unsubscribe (T06, contract T06(g).5). Mail scanners prefetch GET
 * links, so GET must never itself unsubscribe -- it only returns a page
 * whose POST form does. The token travels as a query param on both verbs
 * (not a form field), truncated defensively before it ever reaches a
 * database lookup. Both verbs always answer 200 and never reveal whether the
 * token was valid, so this endpoint cannot be used to probe token guesses.
 */
const UNSUBSCRIBE_TOKEN_MAX_CHARS = 128;

function unsubscribeTokenFrom(url: URL): string | null {
  const raw = url.searchParams.get("token");
  if (!raw) return null;
  const token = raw.slice(0, UNSUBSCRIBE_TOKEN_MAX_CHARS);
  return token.length > 0 ? token : null;
}

http.route({
  path: "/alerts/unsubscribe",
  method: "GET",
  handler: httpAction(async (_ctx, req) => {
    const url = new URL(req.url);
    const token = unsubscribeTokenFrom(url) ?? "";
    const action = `/alerts/unsubscribe?token=${encodeURIComponent(token)}`;
    const html = [
      "<!doctype html>",
      '<html lang="en"><head><meta charset="utf-8">',
      "<title>Unsubscribe from Recoup price alerts</title></head><body>",
      "<p>Stop receiving Recoup price alert emails?</p>",
      `<form method="POST" action="${action}"><button type="submit">Unsubscribe</button></form>`,
      "</body></html>",
    ].join("");
    // GET writes nothing: no ctx.runMutation call on this branch.
    return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  }),
});

http.route({
  path: "/alerts/unsubscribe",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const token = unsubscribeTokenFrom(new URL(req.url));
    if (token) {
      try {
        await ctx.runMutation(internal.alerts.unsubscribeByToken, { token });
      } catch (err) {
        // Never surface an error to the caller (would leak state); log and still answer 200.
        console.error("POST /alerts/unsubscribe failed", err);
      }
    }
    return new Response("You will no longer receive price alert emails from Recoup.", {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }),
});

// Must be last: exact routes above win over the static catch-all.
registerStaticRoutes(http, components.staticHosting);

export default http;
