import { internalAction } from "./_generated/server";
import { v } from "convex/values";

// Stub: Task 5/7 (reply classification) replaces this file (D34).
export const classify = internalAction({
  args: {
    claimId: v.id("claims"),
    messageId: v.string(),
    from: v.string(),
    subject: v.string(),
    text: v.string(),
  },
  handler: async () => {},
});
