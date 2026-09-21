/**
 * T07 (P07 measurement) — fairness.
 *
 * `priceWatch.eligibleItems`/`runAll` and `watches.sweep` both read one
 * global, cross-user page per tick (no per-user slice), so a single
 * account's backlog can crowd out every other account. D74 is the accepted
 * fix (item-level `nextCheckAt` rotation + a per-user slice per tick,
 * `PRICE_CHECK_PER_USER_PER_TICK`/`WATCH_SWEEP_PER_USER` in convex/limits.ts
 * — both already defined there but not yet wired into either function,
 * confirming this is pre-fix); D80 raised the priceWatch half of this to
 * HIGH severity (docs/reviews/2026-09-21-phase0-reproduction.md's
 * `refute:P07:security` #2). This file does not need transaction-limit
 * enforcement (`eligibleItems` never opens a claim for these items, so
 * `hasOpenPriceClaim`'s collect stays at 0 documents per item), so it uses
 * the ordinary `setup()`/`signedIn()` from ./test.setup, unlike
 * readBudget.test.ts.
 *
 * Tests that encode the desired (not-yet-true) behavior are `it.fails` with
 * a `// FINDING:` comment, per T07's brief, so T12 flips them to plain `it`
 * once the per-user slice lands.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConvexError } from "convex/values";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { setup, signedIn } from "./test.setup";
import { GLOBAL_DAILY_BUDGETS } from "./limits";
import { utcDay } from "./lib/budget";

type T = ReturnType<typeof setup>;

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 21, 12);

// Every function under test reads `Date.now()` directly (eligibleItems,
// sweep, create's budget charge). Fake time keeps `NOW`-derived fixture
// timestamps (purchasedAt, nextCheckAt, the `usage` day string) exactly
// aligned with what the code under test sees, regardless of which real
// calendar day the suite runs on.
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

// ---------------------------------------------------------------------------
// priceWatch.runAll / eligibleItems: permanent starvation (D74, D80 HIGH)
// ---------------------------------------------------------------------------

/**
 * One item with an open, unclaimed price-adjustment window: an active,
 * non-example purchase (with `purchasedAt`) plus a confirmed price-adjustment
 * policy whose window covers `NOW`, and no claims at all — i.e. eligible,
 * the same shape `eligibleItems`/`watchWindow` (priceWatch.ts:142-167) require.
 */
async function seedEligibleItem(
  t: T,
  userId: Id<"users">,
  merchantDomain: string,
  slug: string,
): Promise<Id<"items">> {
  return await t.run(async (ctx) => {
    const purchaseId = await ctx.db.insert("purchases", {
      userId,
      merchant: merchantDomain,
      merchantDomain,
      purchasedAt: NOW - 5 * DAY,
      currency: "USD",
      status: "active",
    });
    await ctx.db.insert("policies", {
      userId,
      merchantDomain,
      kind: "price_adjustment",
      windowDays: 365,
      channel: "email",
      passage: "Price match within 365 days.",
      sourceUrl: `https://${merchantDomain}/policy`,
      retrievedAt: NOW - 5 * DAY,
      confidence: 1,
      confirmedByUser: true,
    });
    return await ctx.db.insert("items", {
      purchaseId,
      userId,
      name: `Item ${slug}`,
      unitCents: 5_000,
      qty: 1,
      productUrl: `https://${merchantDomain}/p/${slug}`,
      returned: false,
    });
  });
}

/** Every `internal.priceWatch.checkItem` job scheduled since the last call (system table diff, watches.test.ts's `scheduled()` pattern). */
function scheduledItemIdsSince(seen: Set<string>) {
  return async (t: T): Promise<Id<"items">[]> => {
    const jobs = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    const fresh = jobs.filter((j) => !seen.has(String(j._id)));
    for (const j of jobs) seen.add(String(j._id));
    return fresh.map((j) => (j.args[0] as { itemId: Id<"items"> }).itemId);
  };
}

describe("priceWatch.runAll fairness across users (D74)", () => {
  // FIXED by T12 (D74/D80/D93): `eligibleItems` now scans `items.by_nextCheck`
  // and caps each user at `PRICE_CHECK_PER_USER_PER_TICK` (checked before any
  // per-item read), and `runAll` rotates `items.nextCheckAt` for every item it
  // considers (scheduled or budget-skipped) via the new `rotateAndSchedule`
  // mutation, so a single user's backlog can no longer fill every tick's
  // fan-out forever. Flipped from `it.fails` to `it` now that this passes for
  // real (see convex/priceWatch.ts's `eligibleItems`/`rotateAndSchedule`).
  it(
    "gives each user with an eligible item at least one scheduled check across 3 ticks, even when one user has 480",
    async () => {
      const t = setup();
      const { userId: userA } = await signedIn(t, "A");
      const { userId: userC } = await signedIn(t, "C");
      const { userId: userB } = await signedIn(t, "B");

      // A and C: one older eligible item each.
      await seedEligibleItem(t, userA, "shop-a.example", "a");
      await seedEligibleItem(t, userC, "shop-c.example", "c");
      // B: 480 newer eligible items, sharing one purchase+policy (chunked inserts).
      const bPurchaseId = await t.run(async (ctx) =>
        ctx.db.insert("purchases", {
          userId: userB,
          merchant: "Shop B",
          merchantDomain: "shop-b.example",
          purchasedAt: NOW - 5 * DAY,
          currency: "USD",
          status: "active",
        }),
      );
      await t.run(async (ctx) =>
        ctx.db.insert("policies", {
          userId: userB,
          merchantDomain: "shop-b.example",
          kind: "price_adjustment",
          windowDays: 365,
          channel: "email",
          passage: "Price match within 365 days.",
          sourceUrl: "https://shop-b.example/policy",
          retrievedAt: NOW - 5 * DAY,
          confidence: 1,
          confirmedByUser: true,
        }),
      );
      const bItems = 480;
      const chunk = 60;
      for (let start = 0; start < bItems; start += chunk) {
        const end = Math.min(start + chunk, bItems);
        await t.run(async (ctx) => {
          for (let i = start; i < end; i++) {
            await ctx.db.insert("items", {
              purchaseId: bPurchaseId,
              userId: userB,
              name: `B item ${i}`,
              unitCents: 5_000,
              qty: 1,
              productUrl: `https://shop-b.example/p/${i}`,
              returned: false,
            });
          }
        });
      }

      const seen = new Set<string>();
      const scheduledSince = scheduledItemIdsSince(seen);
      const ownerOf = async (itemId: Id<"items">) => (await t.run((ctx) => ctx.db.get(itemId)))?.userId;

      const scheduledByTick: Array<{ a: boolean; c: boolean; total: number }> = [];
      for (let tick = 0; tick < 3; tick++) {
        await t.action(internal.priceWatch.runAll, {});
        const ids = await scheduledSince(t);
        const owners = await Promise.all(ids.map(ownerOf));
        scheduledByTick.push({
          a: owners.includes(userA),
          c: owners.includes(userC),
          total: ids.length,
        });
      }

      // Observed distribution today (kept here so the FINDING is self-contained
      // even if this assertion below is what flips green under T12):
      // tick 1-3: { total: 50, a: false, c: false } every time — user B's
      // newest 50 of 480 items monopolise all three ticks; A and C never run.
      expect(scheduledByTick.every((tick) => tick.a || tick.c)).toBe(true);
    },
    20_000,
  );
});

// ---------------------------------------------------------------------------
// watches.sweep: per-tick starvation is real too, but bounded (D74 medium)
// ---------------------------------------------------------------------------

async function seedDueWatch(t: T, userId: Id<"users">, nextCheckAt: number, slug: string): Promise<Id<"watches">> {
  return await t.run((ctx) =>
    ctx.db.insert("watches", {
      userId,
      name: `Watch ${slug}`,
      productUrl: `https://sweep.example/p/${slug}`,
      merchantDomain: "sweep.example",
      status: "active",
      nextCheckAt,
    }),
  );
}

describe("watches.sweep fairness across users (D74)", () => {
  // FINDING: convex/watches.ts:739-763 `sweep` reads one global page off
  // `by_status_nextCheck` ascending (earliest-due first) across every user,
  // bounded to WATCH_SWEEP_PAGE=50, with no per-user slice
  // (`WATCH_SWEEP_PER_USER`, convex/limits.ts:173, is likewise defined but
  // unused). Unlike `eligibleItems`, a scheduled row's `nextCheckAt` IS
  // bumped forward (so this is not a permanent monopoly — see the passing
  // test below), but within any one tick, a user whose whole backlog is more
  // overdue than everyone else's still takes the entire page.
  it.fails(
    "does not let one user's backlog occupy the entire first tick when two other users also have a due watch",
    async () => {
      const t = setup();
      const { userId: userA } = await signedIn(t, "A");
      const { userId: userC } = await signedIn(t, "C");
      const { userId: userB } = await signedIn(t, "B");

      // A and C: due, but the LEAST overdue (largest nextCheckAt among the due set).
      await seedDueWatch(t, userA, NOW - 1, "a");
      await seedDueWatch(t, userC, NOW - 1, "c");
      // B: 480 watches, all MORE overdue than A/C's, so ascending order puts every one of them first.
      for (let start = 0; start < 480; start += 60) {
        const end = Math.min(start + 60, 480);
        await t.run(async (ctx) => {
          for (let i = start; i < end; i++) {
            await ctx.db.insert("watches", {
              userId: userB,
              name: `B watch ${i}`,
              productUrl: `https://sweep.example/p/b${i}`,
              merchantDomain: "sweep.example",
              status: "active",
              nextCheckAt: NOW - 1_000 - i,
            });
          }
        });
      }

      await t.mutation(internal.watches.sweep, {});
      const jobs = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
      const watchIds = jobs.map((j) => (j.args[0] as { watchId: Id<"watches"> }).watchId);
      const owners = await Promise.all(watchIds.map(async (id) => (await t.run((ctx) => ctx.db.get(id)))?.userId));

      // Observed today: tick 1 schedules exactly 50 watches, all owned by B; A and C get 0.
      expect(owners.includes(userA) || owners.includes(userC)).toBe(true);
    },
    20_000,
  );

  it("unlike priceWatch, the backlog drains: both other users are served within ceil(480/50)+1 ticks", async () => {
    const t = setup();
    const { userId: userA } = await signedIn(t, "A");
    const { userId: userC } = await signedIn(t, "C");
    const { userId: userB } = await signedIn(t, "B");

    await seedDueWatch(t, userA, NOW - 1, "a");
    await seedDueWatch(t, userC, NOW - 1, "c");
    for (let start = 0; start < 480; start += 60) {
      const end = Math.min(start + 60, 480);
      await t.run(async (ctx) => {
        for (let i = start; i < end; i++) {
          await ctx.db.insert("watches", {
            userId: userB,
            name: `B watch ${i}`,
            productUrl: `https://sweep.example/p/b${i}`,
            merchantDomain: "sweep.example",
            status: "active",
            nextCheckAt: NOW - 1_000 - i,
          });
        }
      });
    }

    // Each tick bumps scheduled rows WATCH_SWEEP_BUMP_MS=600_000 into the
    // future relative to the fixed NOW, so calling sweep repeatedly without
    // advancing the clock still drains the backlog page by page (600_000 >> 0,
    // so nothing already bumped becomes due again inside this loop).
    let servedA = false;
    let servedC = false;
    let ticks = 0;
    const maxTicks = Math.ceil(480 / 50) + 1; // 10
    for (; ticks < maxTicks; ticks++) {
      const scheduledCount = await t.mutation(internal.watches.sweep, {});
      if (scheduledCount === 0) break;
      const jobs = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
      const watchIds = jobs.map((j) => (j.args[0] as { watchId: Id<"watches"> }).watchId);
      const owners = await Promise.all(watchIds.map(async (id) => (await t.run((ctx) => ctx.db.get(id)))?.userId));
      servedA = servedA || owners.includes(userA);
      servedC = servedC || owners.includes(userC);
      if (servedA && servedC) break;
    }

    expect(servedA).toBe(true);
    expect(servedC).toBe(true);
    expect(ticks).toBeLessThan(maxTicks);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// Global budget exhaustion: fail closed, and the refusal shows up in `usage`.
// ---------------------------------------------------------------------------

describe("global budget exhaustion fails closed (visible in usage rows)", () => {
  it("watches.sweep schedules nothing once the global price_check switch is spent, and usage is not overspent", async () => {
    const t = setup();
    const { userId } = await signedIn(t, "Spender");
    await seedDueWatch(t, userId, NOW - 1, "1");
    await seedDueWatch(t, userId, NOW - 2, "2");

    const day = utcDay(NOW);
    const max = GLOBAL_DAILY_BUDGETS.price_check.max;
    await t.run((ctx) => ctx.db.insert("usage", { userId: undefined, day, kind: "price_check", count: max }));

    const scheduled = await t.mutation(internal.watches.sweep, {});
    expect(scheduled).toBe(0);

    const usageRows = await t.run((ctx) => ctx.db.query("usage").collect());
    // `userId: undefined` is stripped on insert (Convex drops undefined-valued
    // fields), so the stored row simply has no `userId` key at all.
    expect(usageRows).toMatchObject([{ day, kind: "price_check", count: max }]);
    expect(usageRows[0]).not.toHaveProperty("userId");

    // Fail closed: the due watches are still due (charging refused before any patch/schedule).
    const jobs = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(jobs).toHaveLength(0);
  });

  it("watches.create fails closed once the global price_check switch is spent, and usage is not overspent", async () => {
    const t = setup();
    const { as } = await signedIn(t, "Spender2");
    const day = utcDay(NOW);
    const max = GLOBAL_DAILY_BUDGETS.price_check.max;
    await t.run((ctx) => ctx.db.insert("usage", { userId: undefined, day, kind: "price_check", count: max }));

    // `create` charges the same global `price_check` switch `sweep` draws
    // from (watches.ts:358-359, `consumeGlobalBudget`), in the same
    // transaction as the insert — so a refusal here must create nothing.
    await expect(as.mutation(api.watches.create, { productUrl: "https://sweep.example/p/refused" })).rejects.toThrow(
      ConvexError,
    );

    const watches = await t.run((ctx) => ctx.db.query("watches").collect());
    expect(watches).toHaveLength(0);

    const usageRows = await t.run((ctx) =>
      ctx.db
        .query("usage")
        .withIndex("by_user_day_kind", (q) => q.eq("userId", undefined).eq("day", day).eq("kind", "price_check"))
        .collect(),
    );
    expect(usageRows).toMatchObject([{ count: max }]); // refused, not double-spent
  });
});
