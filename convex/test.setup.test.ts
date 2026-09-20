import { describe, expect, it } from "vitest";
import { setup, signedIn } from "./test.setup";

describe("test harness", () => {
  it("signedIn returns a userId and as.run can read it", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t, "Ada");
    expect(userId).toBeDefined();
    const user = await as.run(async (ctx) => ctx.db.get(userId));
    expect(user?.name).toBe("Ada");
  });
});
