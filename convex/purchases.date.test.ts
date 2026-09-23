/**
 * QA-M16-4 (D217): a purchase date is never a future instant. The old client stored noon UTC of the picked day, so
 * "today" picked east of UTC before 12:00 UTC (e.g. 09:30 in Asia/Kolkata = 04:00Z) was up to ~12 h ahead, and
 * every window counted from it (the legacy price-adjustment window, R01's deadline, a claim's `windowEndsAt`) ran
 * that much past the store's rule. `assertTimestamp` allows +24 h, so the server accepted it.
 *
 * Server defence: `purchases.create`, `purchases.confirm` and `watches.markBought` clamp `purchasedAt` to the
 * server's now (`watches.purchasedAtNotAfterNow`), and still refuse anything more than a day ahead. Expected values
 * are written by hand.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./lib/rules/registry", async () => await import("./lib/rules/testRegistry"));

import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { pinClockEach, setup, signedIn } from "./test.setup";
import { windowEndsAt } from "./lib/ledger";
import { resetTestRegistry } from "./lib/rules/testRegistry";
import { purchasedAtNotAfterNow } from "./watches";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** 2026-09-23 09:30 in Asia/Kolkata (UTC+05:30) = 04:00Z: noon UTC of "today" is 8 h in the future. */
const NOW = Date.UTC(2026, 8, 23, 4, 0);
const SIX_HOURS_AHEAD = NOW + 6 * HOUR;
const DOMAIN = "acme.example";
const WINDOW_DAYS = 14;
type T = ReturnType<typeof setup>;

afterEach(() => resetTestRegistry());

/** A needs_review purchase with one watched item, a 14-day price-adjustment policy and a lower observed price. */
async function reviewWorld(t: T, userId: Id<"users">) {
  return await t.run(async (ctx) => {
    const purchaseId = await ctx.db.insert("purchases", {
      userId, merchant: "Acme", merchantDomain: DOMAIN, currency: "USD", status: "needs_review",
    });
    const itemId = await ctx.db.insert("items", {
      purchaseId, userId, name: "Jacket", unitCents: 12_000, qty: 1, productUrl: `https://${DOMAIN}/p/1`, returned: false,
    });
    await ctx.db.insert("priceChecks", {
      itemId, userId, observedCents: 9_500, currency: "USD", confidence: 0.92, variantMatch: "exact",
      observedAt: NOW - 60_000, sourceUrl: `https://${DOMAIN}/p/1`,
    });
    await ctx.db.insert("policies", {
      userId, merchantDomain: DOMAIN, kind: "price_adjustment", windowDays: WINDOW_DAYS, channel: "email",
      contactEmail: "help@acme.example", passage: "We adjust the price within 14 days of purchase.",
      sourceUrl: `https://${DOMAIN}/policy`, retrievedAt: NOW - 60_000, confidence: 0.9, confirmedByUser: false,
    });
    return { purchaseId, itemId };
  });
}

describe("purchasedAtNotAfterNow", () => {
  it("clamps a future instant to now, keeps a past one, and still refuses more than a day ahead", () => {
    expect(purchasedAtNotAfterNow(SIX_HOURS_AHEAD, NOW)).toBe(NOW);
    expect(purchasedAtNotAfterNow(NOW - DAY, NOW)).toBe(NOW - DAY);
    expect(() => purchasedAtNotAfterNow(NOW + 25 * HOUR, NOW)).toThrow(/purchasedAt/);
  });
});

describe("a purchase date six hours ahead of the server clock (QA-M16-4)", () => {
  pinClockEach(NOW);

  it("watches.markBought stores now, not the future instant", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const watchId = await t.run((ctx) =>
      ctx.db.insert("watches", {
        userId, name: "Jacket", productUrl: `https://${DOMAIN}/p/1`, merchantDomain: DOMAIN, currency: "USD",
        status: "active", nextCheckAt: NOW,
      }),
    );
    const purchaseId = await as.mutation(api.watches.markBought, { watchId, paidCents: 12_000, purchasedAt: SIX_HOURS_AHEAD });
    const purchase = await t.run((ctx) => ctx.db.get(purchaseId));
    expect(purchase!.purchasedAt).toBe(NOW);
    // The legacy window counted from it ends exactly 14 days after the purchase, not 14 days and 6 hours.
    expect(windowEndsAt(purchase!.purchasedAt!, WINDOW_DAYS)).toBe(NOW + WINDOW_DAYS * DAY);
  });

  it("purchases.create stores now, and still refuses a date more than a day ahead", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    const base = {
      merchant: "Acme", merchantDomain: DOMAIN, currency: "USD",
      items: [{ name: "Jacket", unitCents: 12_000, qty: 1 }],
    };
    const purchaseId = await as.mutation(api.purchases.create, { ...base, purchasedAt: SIX_HOURS_AHEAD });
    expect((await t.run((ctx) => ctx.db.get(purchaseId)))!.purchasedAt).toBe(NOW);
    await expect(as.mutation(api.purchases.create, { ...base, purchasedAt: NOW + 25 * HOUR })).rejects.toThrow(/purchasedAt/);
  });

  it("purchases.confirm stores now, and R01's window end is never later than purchase + policy days", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const w = await reviewWorld(t, userId);
    await as.mutation(api.purchases.confirm, {
      purchaseId: w.purchaseId, merchant: "Acme", merchantDomain: DOMAIN, purchasedAt: SIX_HOURS_AHEAD, currency: "USD",
      items: [{ itemId: w.itemId, name: "Jacket", unitCents: 12_000, qty: 1, productUrl: `https://${DOMAIN}/p/1` }],
    });
    const purchase = (await t.run((ctx) => ctx.db.get(w.purchaseId)))!;
    expect(purchase.purchasedAt).toBe(NOW);

    // M11d: confirming re-evaluates. R01's user deadline counts from the stored purchase instant.
    const opps = await t.run((ctx) => ctx.db.query("opportunities").collect());
    const r01 = opps.find((o) => o.scenarioId === "R01");
    expect(r01).toBeDefined();
    expect(r01!.nextDeadlineAt).toBeDefined();
    expect(r01!.nextDeadlineAt!).toBeLessThanOrEqual(purchase.purchasedAt! + WINDOW_DAYS * DAY);
    expect(r01!.nextDeadlineAt!).toBeLessThanOrEqual(NOW + WINDOW_DAYS * DAY);

    // A claim opened on it carries the same window end.
    const opened = await as.mutation(api.opportunities.openCase, { opportunityId: r01!._id });
    expect(opened.ok).toBe(true);
    const claim = await t.run((ctx) => ctx.db.query("claims").withIndex("by_item", (q) => q.eq("itemId", w.itemId)).first());
    expect(claim!.windowEndsAt).toBeDefined();
    expect(claim!.windowEndsAt!).toBeLessThanOrEqual(NOW + WINDOW_DAYS * DAY);
  });
});
