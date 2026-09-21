import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConvexError } from "convex/values";
import { internal } from "./_generated/api";
import { setup, signedIn } from "./test.setup";
import {
  charge,
  consumeBudget,
  consumeGlobalBudget,
  takeGlobalBudget,
  tryCharge,
  tryConsumeBudget,
  utcDay,
} from "./lib/budget";
import { DAILY_BUDGETS, GLOBAL_DAILY_BUDGETS } from "./limits";

const T0 = Date.UTC(2026, 8, 20, 12);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());

type T = ReturnType<typeof setup>;

async function usageRows(t: T) {
  return await t.run(async (ctx) => await ctx.db.query("usage").collect());
}

describe("utcDay", () => {
  it("is the UTC calendar day, whatever the local zone", () => {
    expect(utcDay(Date.UTC(2026, 8, 20, 23, 59, 59))).toBe("2026-09-20");
    expect(utcDay(Date.UTC(2026, 8, 21, 0, 0, 0))).toBe("2026-09-21");
  });
});

describe("consumeBudget", () => {
  it("increments one row per (user, day, kind)", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    await t.run(async (ctx) => {
      await consumeBudget(ctx, userId, "paste", 5);
      await consumeBudget(ctx, userId, "paste", 5);
      await consumeBudget(ctx, userId, "paste", 5);
    });
    expect(await usageRows(t)).toMatchObject([{ userId, day: "2026-09-20", kind: "paste", count: 3 }]);
  });

  it("throws a readable ConvexError at the cap and does not count the refused call", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    await t.run(async (ctx) => {
      await consumeBudget(ctx, userId, "paste", 2);
      await consumeBudget(ctx, userId, "paste", 2);
    });
    const refused = t.run(async (ctx) => await consumeBudget(ctx, userId, "paste", 2));
    await expect(refused).rejects.toThrow(ConvexError);
    await expect(t.run(async (ctx) => await consumeBudget(ctx, userId, "paste", 2))).rejects.toThrow(
      "You have reached today's limit for reading pasted emails. It resets at midnight UTC.",
    );
    expect((await usageRows(t))[0].count).toBe(2);
  });

  it("a kind with no label in limits.ts still reads as words", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    await expect(t.run(async (ctx) => await consumeBudget(ctx, userId, "made_up_kind", 0))).rejects.toThrow(
      "today's limit for made up kind",
    );
  });

  it("users, kinds and days do not interfere", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const b = await signedIn(t, "B");
    await t.run(async (ctx) => await consumeBudget(ctx, a.userId, "paste", 1));
    await expect(t.run(async (ctx) => await consumeBudget(ctx, a.userId, "paste", 1))).rejects.toThrow(ConvexError);

    // Another user, another kind: both fresh.
    await t.run(async (ctx) => await consumeBudget(ctx, b.userId, "paste", 1));
    await t.run(async (ctx) => await consumeBudget(ctx, a.userId, "draft_generate", 1));

    // Still refused one second before midnight UTC, allowed one second after.
    vi.setSystemTime(Date.UTC(2026, 8, 20, 23, 59, 59));
    await expect(t.run(async (ctx) => await consumeBudget(ctx, a.userId, "paste", 1))).rejects.toThrow(ConvexError);
    vi.setSystemTime(Date.UTC(2026, 8, 21, 0, 0, 1));
    await t.run(async (ctx) => await consumeBudget(ctx, a.userId, "paste", 1));

    expect(await usageRows(t)).toHaveLength(4);
  });

  it("tryConsumeBudget reports instead of throwing", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    expect(await t.run(async (ctx) => await tryConsumeBudget(ctx, userId, "paste", 1))).toBe(true);
    expect(await t.run(async (ctx) => await tryConsumeBudget(ctx, userId, "paste", 1))).toBe(false);
    expect((await usageRows(t))[0].count).toBe(1);
  });
});

describe("the global kill switch", () => {
  it("is one row with no user, shared by everybody, and independent of per-user rows", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    await t.run(async (ctx) => {
      await consumeBudget(ctx, a.userId, "price_check", 10);
      await consumeGlobalBudget(ctx, "price_check", 3);
      await consumeGlobalBudget(ctx, "price_check", 3, 2);
    });
    const rows = await usageRows(t);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.userId === undefined)).toMatchObject({ kind: "price_check", count: 3 });
    expect(rows.find((r) => r.userId === a.userId)).toMatchObject({ count: 1 });

    await expect(t.run(async (ctx) => await consumeGlobalBudget(ctx, "price_check", 3))).rejects.toThrow(
      "Recoup has reached today's limit for price checks. It resets at midnight UTC.",
    );
  });

  it("is all or nothing: a charge that does not fit takes nothing", async () => {
    const t = setup();
    await t.run(async (ctx) => await consumeGlobalBudget(ctx, "policy_fetch", 3, 2));
    await expect(t.run(async (ctx) => await consumeGlobalBudget(ctx, "policy_fetch", 3, 2))).rejects.toThrow(ConvexError);
    expect((await usageRows(t))[0].count).toBe(2);
  });

  it("takeGlobalBudget grants a sweep only what is left, then nothing, then a full day again", async () => {
    const t = setup();
    const max = GLOBAL_DAILY_BUDGETS.price_check.max;
    await t.run(async (ctx) => await ctx.db.insert("usage", { day: "2026-09-20", kind: "price_check", count: max - 7 }));
    expect(await t.run(async (ctx) => await takeGlobalBudget(ctx, "price_check", 50))).toBe(7);
    expect(await t.run(async (ctx) => await takeGlobalBudget(ctx, "price_check", 50))).toBe(0);
    vi.setSystemTime(T0 + 24 * 3_600_000);
    expect(await t.run(async (ctx) => await takeGlobalBudget(ctx, "price_check", 50))).toBe(50);
  });
});

describe("charge / tryCharge (named budgets from limits.ts)", () => {
  it("charges the user and the global switch the kind draws from", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    await t.run(async (ctx) => await charge(ctx, userId, "policy_fetch"));
    const rows = await usageRows(t);
    expect(rows.find((r) => r.userId === userId)).toMatchObject({ kind: "policy_fetch", count: 1 });
    // One fetchBoth is two researches.
    expect(rows.find((r) => r.userId === undefined)).toMatchObject({ kind: "policy_fetch", count: 2 });
  });

  it("a spent global switch refuses every user, and tryCharge then charges nobody", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    await t.run(
      async (ctx) =>
        await ctx.db.insert("usage", { day: "2026-09-20", kind: "policy_fetch", count: GLOBAL_DAILY_BUDGETS.policy_fetch.max }),
    );
    expect(await t.run(async (ctx) => await tryCharge(ctx, userId, "policy_fetch"))).toBe(false);
    expect((await usageRows(t)).filter((r) => r.userId === userId)).toHaveLength(0);
    await expect(t.run(async (ctx) => await charge(ctx, userId, "policy_refresh"))).rejects.toThrow(/Recoup has reached/);
  });
});

describe("internal.budget.consume (for actions)", () => {
  it("looks the cap up by kind and throws at it", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    for (let i = 0; i < DAILY_BUDGETS.policy_refresh.max; i++) {
      await t.mutation(internal.budget.consume, { userId, kind: "policy_refresh" });
    }
    await expect(t.mutation(internal.budget.consume, { userId, kind: "policy_refresh" })).rejects.toThrow(
      /today's limit for re-reading store policies/,
    );
  });

  it("refuses a kind it does not know rather than letting it through uncapped", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    await expect(t.mutation(internal.budget.consume, { userId, kind: "free_lunch" })).rejects.toThrow(/Unknown budget kind/);
    await expect(t.mutation(internal.budget.consume, { userId, kind: "toString" })).rejects.toThrow(/Unknown budget kind/);
    expect(await usageRows(t)).toHaveLength(0);
  });

  it("takeGlobalPriceChecks bounds the cron's fan-out", async () => {
    const t = setup();
    expect(await t.mutation(internal.budget.takeGlobalPriceChecks, { want: 50 })).toBe(50);
    expect(await t.mutation(internal.budget.takeGlobalPriceChecks, { want: 0 })).toBe(0);
    expect(await t.mutation(internal.budget.takeGlobalPriceChecks, { want: Number.NaN })).toBe(0);
  });
});
