import { AgentMail, type AgentMailOptions } from "@agentmail/convex";
import { components, internal } from "./_generated/api";

// Single AgentMail handle (see docs/ARCHITECTURE_PATTERNS.md). Constructing
// this does not throw when AGENTMAIL_API_KEY is absent from the deployment:
// the constructor only reads AGENTMAIL_WEBHOOK_SECRET (defaulting to ""), and
// AGENTMAIL_API_KEY / the webhook secret are checked lazily by
// `assertConfigured` inside `sendMessage` ("send") and `handleWebhook`
// ("webhook") at call time, not at construction. See CHECK note in the T02
// report for the exact source line.
export const agentmail: AgentMail = new AgentMail(components.agentmail, {
  // Cast: `AgentMailOptions.onMessageReceived` declares `thread: unknown`
  // (required), but `inbound.onMessageReceived`'s own args validator now
  // declares `thread: v.optional(v.any())` (D86/T06 fix -- the component's
  // own event shape really can omit `thread`; see the docstring on that
  // function and http.test.ts's flipped test). A FunctionReference with an
  // optional field is not structurally assignable to one requiring it, even
  // though every real call site tolerates the field being absent. One cast,
  // same shape as the other accepted `RunMutationCtx`-vs-`MutationCtx`
  // deviations in this codebase (`drafts.sendCtx`, `notify.sendCtx`, D12a).
  onMessageReceived: internal.inbound.onMessageReceived as AgentMailOptions["onMessageReceived"],
  // T06/D85: late bounce/complaint propagation. Every event type (including
  // message.received/domain.verified, which mailEvents.onEvent ignores)
  // arrives here; it carries no outboundId, only AgentMail's own message id.
  onEvent: internal.mailEvents.onEvent,
});
