import { internalMutation } from "./_generated/server";
import { v } from "convex/values";

// Stub: Task 7 replaces this with real inbound-email handling.
export const onMessageReceived = internalMutation({
  args: { message: v.any(), thread: v.any(), eventId: v.string() },
  handler: async () => {},
});
