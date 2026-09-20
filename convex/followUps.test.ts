import { describe, expect, it } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { setup, signedIn } from "./test.setup";
import { cancelPending, scheduleReminder } from "./followUps";

async function seedClaim(
  t: ReturnType<typeof setup>,
  userId: Id<"users">,
  status: "sent" | "confirmed" | "dismissed" = "sent",
) {
  return await t.run(async (ctx) => {
    const purchaseId = await ctx.db.insert("purchases", {
      userId,
      merchant: "Acme",
      merchantDomain: "acme.example",
      currency: "USD",
      status: "active",
    });
    const itemId = await ctx.db.insert("items", {
      purchaseId,
      userId,
      name: "Widget",
      unitCents: 1000,
      qty: 1,
      returned: false,
    });
    const claimId = await ctx.db.insert("claims", {
      purchaseId,
      itemId,
      userId,
      type: "price_adjustment",
      expectedCents: 500,
      status,
      token: "AAAAAA",
      version: 1,
    });
    return await ctx.db.get(claimId);
  });
}

describe("followUps.scheduleReminder + fire", () => {
  it("inserts a pending row that fires and sets attentionAt on an open claim", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const claim = await seedClaim(t, userId, "sent");
    if (!claim) throw new Error("claim not created");

    const fireAt = Date.now() - 1000; // already due (D42)
    await as.run((ctx) => scheduleReminder(ctx, claim, fireAt));

    const rows = await as.run((ctx) =>
      ctx.db
        .query("followUps")
        .withIndex("by_claim", (q) => q.eq("claimId", claim._id))
        .collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("pending");
    expect(rows[0].claimVersion).toBe(claim.version);

    await t.mutation(internal.followUps.fire, { claimId: claim._id });

    const after = await as.run((ctx) =>
      ctx.db
        .query("followUps")
        .withIndex("by_claim", (q) => q.eq("claimId", claim._id))
        .collect(),
    );
    expect(after[0].status).toBe("fired");
    const updatedClaim = await as.run((ctx) => ctx.db.get(claim._id));
    expect(updatedClaim?.attentionAt).toBeDefined();
  });

  it("cancels pending reminders without setting attentionAt when the claim is confirmed", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const claim = await seedClaim(t, userId, "confirmed");
    if (!claim) throw new Error("claim not created");

    await as.run((ctx) => scheduleReminder(ctx, claim, Date.now() - 1000));
    await t.mutation(internal.followUps.fire, { claimId: claim._id });

    const rows = await as.run((ctx) =>
      ctx.db
        .query("followUps")
        .withIndex("by_claim", (q) => q.eq("claimId", claim._id))
        .collect(),
    );
    expect(rows[0].status).toBe("cancelled");
    const updatedClaim = await as.run((ctx) => ctx.db.get(claim._id));
    expect(updatedClaim?.attentionAt).toBeUndefined();
  });

  it("fire is a no-op when no pending row is due (D42)", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const claim = await seedClaim(t, userId, "sent");
    if (!claim) throw new Error("claim not created");

    // No row at all.
    await t.mutation(internal.followUps.fire, { claimId: claim._id });
    expect((await as.run((ctx) => ctx.db.get(claim._id)))?.attentionAt).toBeUndefined();

    // A pending row that is not due yet.
    await as.run((ctx) => scheduleReminder(ctx, claim, Date.now() + 86_400_000));
    await t.mutation(internal.followUps.fire, { claimId: claim._id });
    const rows = await as.run((ctx) =>
      ctx.db
        .query("followUps")
        .withIndex("by_claim", (q) => q.eq("claimId", claim._id))
        .collect(),
    );
    expect(rows[0].status).toBe("pending");
    expect((await as.run((ctx) => ctx.db.get(claim._id)))?.attentionAt).toBeUndefined();

    // A cancelled row that is past due.
    await as.run((ctx) => cancelPending(ctx, claim._id));
    await as.run((ctx) => ctx.db.patch(rows[0]._id, { fireAt: Date.now() - 1000 }));
    await t.mutation(internal.followUps.fire, { claimId: claim._id });
    expect((await as.run((ctx) => ctx.db.get(claim._id)))?.attentionAt).toBeUndefined();
  });

  it("scheduleReminder cancels a prior pending reminder before scheduling the new one", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const claim = await seedClaim(t, userId, "sent");
    if (!claim) throw new Error("claim not created");

    await as.run((ctx) => scheduleReminder(ctx, claim, Date.now() + 1000));
    await as.run((ctx) => scheduleReminder(ctx, claim, Date.now() + 2000));

    const rows = await as.run((ctx) =>
      ctx.db
        .query("followUps")
        .withIndex("by_claim", (q) => q.eq("claimId", claim._id))
        .collect(),
    );
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.status === "pending")).toHaveLength(1);
    expect(rows.filter((r) => r.status === "cancelled")).toHaveLength(1);
  });

  it("cancelPending is a no-op when there are no follow-ups", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const claim = await seedClaim(t, userId, "sent");
    if (!claim) throw new Error("claim not created");

    await as.run((ctx) => cancelPending(ctx, claim._id));
    const rows = await as.run((ctx) =>
      ctx.db
        .query("followUps")
        .withIndex("by_claim", (q) => q.eq("claimId", claim._id))
        .collect(),
    );
    expect(rows).toHaveLength(0);
  });
});
