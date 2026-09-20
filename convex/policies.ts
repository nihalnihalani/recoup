import { internalAction } from "./_generated/server";
import { v } from "convex/values";

// Stub: Task 8 replaces this with real policy-fetching logic.
export const fetchBoth = internalAction({
  args: { userId: v.id("users"), merchantDomain: v.string() },
  handler: async () => {},
});
