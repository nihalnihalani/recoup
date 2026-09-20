import { AgentMail } from "@agentmail/convex";
import { components, internal } from "./_generated/api";

// Single AgentMail handle (see docs/ARCHITECTURE_PATTERNS.md). Constructing
// this does not throw when AGENTMAIL_API_KEY is absent from the deployment:
// the constructor only reads AGENTMAIL_WEBHOOK_SECRET (defaulting to ""), and
// AGENTMAIL_API_KEY / the webhook secret are checked lazily by
// `assertConfigured` inside `sendMessage` ("send") and `handleWebhook`
// ("webhook") at call time, not at construction. See CHECK note in the T02
// report for the exact source line.
export const agentmail: AgentMail = new AgentMail(components.agentmail, {
  onMessageReceived: internal.inbound.onMessageReceived,
});
