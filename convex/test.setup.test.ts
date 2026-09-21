import { describe, expect, it } from "vitest";
import { components } from "./_generated/api";
import { setup, signedIn } from "./test.setup";

describe("test harness", () => {
  it("signedIn returns a userId and as.run can read it", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t, "Ada");
    expect(userId).toBeDefined();
    const user = await as.run(async (ctx) => ctx.db.get(userId));
    expect(user?.name).toBe("Ada");
  });

  // Regression test for the module-resolution bug fixed in `setup()`: dispatching
  // into the agentmail component (any function, not just "lib") used to throw
  // `Could not find module for: "lib"` because `agentmail.modules` is always `{}`
  // when that package is consumed from node_modules (see the comment in
  // test.setup.ts). This exercises the component through a real query dispatch.
  it("can dispatch into the agentmail component (listInboundMessages)", async () => {
    const t = setup();
    const result = await t.run(async (ctx) =>
      ctx.runQuery(components.agentmail.lib.listInboundMessages, { threadId: "x" }),
    );
    expect(result).toEqual([]);
  });
});
