import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { components, internal } from "./_generated/api";
import { registerStaticRoutes } from "@convex-dev/static-hosting";
import { auth } from "./auth";
import { agentmail } from "./mail";
import { logEvent } from "./lib/log";
import { sanitizeError } from "./lib/errors";

const http = httpRouter();

auth.addHttpRoutes(http);

/** Always the same shape for a rejected webhook delivery (F-T22-1): 401, empty body, nothing about why leaked to the caller. */
function webhookRejected(reason: string): Response {
  logEvent("webhook_rejected", { reason });
  return new Response(null, { status: 401 });
}

http.route({
  path: "/agentmail/webhook",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    // F-T22-1: fail closed with 401 whenever the deployment has no webhook
    // secret configured, BEFORE ever calling into the component. The
    // component's own `AgentMail` instance (convex/mail.ts) captures
    // `AGENTMAIL_WEBHOOK_SECRET` once at module construction and its
    // `assertConfigured("webhook")` throws a plain `Error` when that
    // captured value is empty -- left uncaught, that becomes an unhandled
    // exception and Convex turns it into a 500 with the deployment's own
    // stack trace, not a clean 401. Checked by name only; the value itself
    // is never read into a log line, only whether it is present.
    if (!process.env.AGENTMAIL_WEBHOOK_SECRET) {
      return webhookRejected("webhook_secret_not_configured");
    }
    let res: Response;
    try {
      // Cast: @agentmail/convex@0.1.0's RunMutationCtx type predates the
      // `runMutation(fn, args, options)` transactionLimits overload convex
      // 1.46 added to GenericActionCtx, so the structural check between the
      // two `runMutation` signatures fails even though the runtime call here
      // (`ctx.runMutation(fn, args)`, no options) is fully compatible.
      res = await agentmail.handleWebhook(
        ctx as unknown as Parameters<typeof agentmail.handleWebhook>[0],
        req,
      );
    } catch (err) {
      // Any other failure inside the component (a bad signature the
      // component itself throws instead of returning, a parse error, an
      // unexpected shape) -- never a 500, never the raw error back to the
      // caller. `sanitizeError` reduces it to one of a small set of
      // user-safe categories before it ever reaches the log line.
      return webhookRejected(sanitizeError(err instanceof Error ? err.message : String(err)));
    }
    // The component's own signature-verification failure returns a 401
    // itself (with a body of "invalid signature") rather than throwing;
    // normalize it to the same empty-body shape as every other rejection.
    if (res.status === 401) {
      return webhookRejected("invalid_signature");
    }
    return res;
  }),
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
        // T24c (D109): structured, redacted line instead of a bare console.error.
        logEvent("notification_failed", { route: "/alerts/unsubscribe", error: sanitizeError(err instanceof Error ? err.message : String(err)) });
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
