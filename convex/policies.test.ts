import { ConvexError } from "convex/values";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { setup, signedIn } from "./test.setup";
import { researchPolicy } from "./policies";
import { verifyPassage } from "./lib/passage";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const baseSnapshot = {
  merchantDomain: "n.example",
  kind: "returns" as const,
  channel: "email" as const,
  contactEmail: "help@n.example",
  passage: "You may return items within 30 days.",
  sourceUrl: "https://n.example/returns",
  confidence: 0.9,
};

describe("insertSnapshot / latest", () => {
  it("always inserts a new row; latest returns the newest by retrievedAt", async () => {
    const t = setup();
    const { userId } = await signedIn(t);

    const firstId = await t.mutation(internal.policies.insertSnapshot, { userId, ...baseSnapshot, passage: "First passage" });
    const secondId = await t.mutation(internal.policies.insertSnapshot, { userId, ...baseSnapshot, passage: "Second passage" });

    expect(firstId).not.toBe(secondId);

    const rows = await t.run(async (ctx) =>
      ctx.db.query("policies").withIndex("by_user_domain_kind", (q) => q.eq("userId", userId).eq("merchantDomain", "n.example").eq("kind", "returns")).collect(),
    );
    expect(rows).toHaveLength(2);

    const found = await t.run(async (ctx) => {
      const { latest } = await import("./policies");
      return latest(ctx, userId, "n.example", "returns");
    });
    expect(found?._id).toBe(secondId);
    expect(found?.passage).toBe("Second passage");
    expect(found?.confirmedByUser).toBe(false);
  });
});

describe("confirm", () => {
  it("patches only the owner's snapshot and sets confirmedByUser", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t, "Owner");
    const policyId = await t.mutation(internal.policies.insertSnapshot, { userId, ...baseSnapshot });

    await as.mutation(api.policies.confirm, { policyId, channel: "email", contactEmail: "confirmed@n.example", windowDays: 30 });

    const patched = await t.run(async (ctx) => ctx.db.get(policyId));
    expect(patched?.confirmedByUser).toBe(true);
    expect(patched?.contactEmail).toBe("confirmed@n.example");
    expect(patched?.windowDays).toBe(30);
  });

  it("rejects an out-of-range windowDays (D43)", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t, "Owner");
    const policyId = await t.mutation(internal.policies.insertSnapshot, { userId, ...baseSnapshot });
    for (const windowDays of [-1, 1.5, 3651]) {
      await expect(
        as.mutation(api.policies.confirm, { policyId, channel: "email", windowDays }),
      ).rejects.toThrow(/windowDays/);
    }
  });

  it("an edited passage or sourceUrl clears the evidence markers (D45)", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t, "Owner");
    const policyId = await t.mutation(internal.policies.insertSnapshot, {
      userId,
      ...baseSnapshot,
      passageStart: 12,
    });

    // Re-submitting the same passage keeps the evidence.
    await as.mutation(api.policies.confirm, { policyId, channel: "email", passage: baseSnapshot.passage });
    let row = await t.run(async (ctx) => ctx.db.get(policyId));
    expect(row?.passageStart).toBe(12);
    expect(row?.confidence).toBe(0.9);
    expect(row?.userEdited).toBeUndefined();

    await as.mutation(api.policies.confirm, { policyId, channel: "email", passage: "Returns within 45 days." });
    row = await t.run(async (ctx) => ctx.db.get(policyId));
    expect(row?.passageStart).toBeUndefined();
    expect(row?.confidence).toBe(0);
    expect(row?.userEdited).toBe(true);
    expect(row?.confirmedByUser).toBe(true);
  });

  it("throws when a different user tries to confirm someone else's snapshot", async () => {
    const t = setup();
    const { userId } = await signedIn(t, "Owner");
    const { as: asOther } = await signedIn(t, "Other");
    const policyId = await t.mutation(internal.policies.insertSnapshot, { userId, ...baseSnapshot });

    await expect(asOther.mutation(api.policies.confirm, { policyId, channel: "email" })).rejects.toThrow();
  });
});

describe("refresh", () => {
  it("requires auth", async () => {
    await expect(setup().action(api.policies.refresh, { merchantDomain: "n.example", kind: "returns" })).rejects.toThrow();
  });

  it("rejects a merchantDomain that does not normalise to a real domain", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    await expect(as.action(api.policies.refresh, { merchantDomain: "not a domain", kind: "returns" })).rejects.toThrow(
      ConvexError,
    );
  });
});

describe("refresh is gated before anything is paid for (pre-launch review B3)", () => {
  async function purchaseAt(t: ReturnType<typeof setup>, userId: any, merchantDomain: string, isExample = false) {
    await t.run(async (ctx) => {
      await ctx.db.insert("purchases", { userId, merchant: "M", merchantDomain, currency: "USD", status: "active", isExample });
    });
  }
  const usage = async (t: ReturnType<typeof setup>) => await t.run(async (ctx) => await ctx.db.query("usage").collect());

  it("rejects something that is not a domain, and a store the caller has nothing at, without charging or fetching", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const other = await signedIn(t, "Other");
    await purchaseAt(t, other.userId, "theirs.example");
    await purchaseAt(t, userId, "demo.example", true);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    for (const merchantDomain of ["not a domain", "", "random-store.example", "theirs.example", "demo.example"]) {
      await expect(as.action(api.policies.refresh, { merchantDomain, kind: "returns" })).rejects.toThrow(ConvexError);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await usage(t)).toHaveLength(0);
    expect(await t.run(async (ctx) => (await ctx.db.query("policies").collect()).length)).toBe(0);
  });

  it("accepts a store the caller bought from or watches, normalised, up to 10 a day", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    await purchaseAt(t, userId, "bought.example");
    await t.run(async (ctx) => {
      await ctx.db.insert("watches", {
        userId, name: "W", productUrl: "https://watched.example/p", merchantDomain: "watched.example", status: "paused", nextCheckAt: 0,
      });
      await ctx.db.insert("watches", {
        userId, name: "Gone", productUrl: "https://archived.example/p", merchantDomain: "archived.example", status: "archived", nextCheckAt: 0,
      });
    });
    await expect(t.mutation(internal.policies.beginRefresh, { userId, merchantDomain: "archived.example" })).rejects.toThrow(
      /stores you have bought from or are watching/,
    );
    await t.mutation(internal.policies.beginRefresh, { userId, merchantDomain: "watched.example" });
    for (let i = 0; i < 9; i++) await t.mutation(internal.policies.beginRefresh, { userId, merchantDomain: "bought.example" });
    await expect(t.mutation(internal.policies.beginRefresh, { userId, merchantDomain: "bought.example" })).rejects.toThrow(
      /today's limit for re-reading store policies/,
    );
    const rows = await usage(t);
    expect(rows.find((r) => r.userId === userId)).toMatchObject({ kind: "policy_refresh", count: 10 });
    expect(rows.find((r) => r.userId === undefined)).toMatchObject({ kind: "policy_fetch", count: 10 });
  });
});

describe("researchPolicy", () => {
  it("inserts an unknown snapshot with a note when there are no hits", async () => {
    const t = setup();
    const { userId } = await signedIn(t);

    const id = await researchPolicy(
      { runMutation: (ref: any, args: any) => t.mutation(ref, args) },
      { userId, merchantDomain: "n.example", kind: "returns" },
      { search: async () => ({ web: [] }), extract: async () => { throw new Error("should not be called"); } },
    );

    const doc = await t.run(async (ctx) => ctx.db.get(id));
    expect(doc?.channel).toBe("unknown");
    expect(doc?.passage).toBe("");
    expect(doc?.confidence).toBe(0);
    expect(doc?.sourceUrl).toBe("https://n.example");
    expect(doc?.note).toBe("No policy page found on the merchant's domain");
  });

  it("stores the passage with passageStart when it is verbatim in the markdown", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const markdown = "# Returns Policy\n\nWe accept returns within 45 days of delivery for a full refund.\nContact us at help@n.example.";
    const passage = "We accept returns within 45 days of delivery for a full refund.";

    const id = await researchPolicy(
      { runMutation: (ref: any, args: any) => t.mutation(ref, args) },
      { userId, merchantDomain: "n.example", kind: "returns" },
      {
        search: async () => ({ web: [{ url: "https://n.example/returns", markdown: markdown + " ".repeat(150) }] }),
        extract: async () => ({ found: true, windowDays: 45, channel: "email", contactEmail: "help@n.example", passage, confidence: 0.92 }),
      },
    );

    const doc = await t.run(async (ctx) => ctx.db.get(id));
    expect(doc?.passage).toBe(passage);
    expect(doc?.confidence).toBe(0.92);
    expect(doc?.passageStart).toBe(verifyPassage(markdown + " ".repeat(150), passage));
    expect(doc?.note).toBeUndefined();
    expect(doc?.windowDays).toBe(45);
  });

  it("zeroes confidence and notes when the extracted passage is not verbatim in the markdown", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const markdown = "# Returns Policy\n\n" + "Some unrelated boilerplate content padding this page out. ".repeat(6);

    const id = await researchPolicy(
      { runMutation: (ref: any, args: any) => t.mutation(ref, args) },
      { userId, merchantDomain: "n.example", kind: "returns" },
      {
        search: async () => ({ web: [{ url: "https://n.example/returns", markdown }] }),
        extract: async () => ({
          found: true,
          windowDays: 45,
          channel: "email",
          contactEmail: "help@n.example",
          passage: "This exact sentence is not present on the page.",
          confidence: 0.92,
        }),
      },
    );

    const doc = await t.run(async (ctx) => ctx.db.get(id));
    expect(doc?.passage).toBe("");
    expect(doc?.confidence).toBe(0);
    expect(doc?.note).toBe("passage not found verbatim in source");
    // Untrusted fields are still kept from the extraction (confidence 0 marks them unconfirmed).
    expect(doc?.channel).toBe("email");
    expect(doc?.contactEmail).toBe("help@n.example");
    expect(doc?.windowDays).toBe(45);
  });

  it("records a Firecrawl error without throwing", async () => {
    const t = setup();
    const { userId } = await signedIn(t);

    const id = await researchPolicy(
      { runMutation: (ref: any, args: any) => t.mutation(ref, args) },
      { userId, merchantDomain: "n.example", kind: "returns" },
      {
        search: async () => {
          throw new ConvexError({ status: 402, message: "Insufficient credits" });
        },
        extract: async () => { throw new Error("should not be called"); },
      },
    );

    const doc = await t.run(async (ctx) => ctx.db.get(id));
    expect(doc?.confidence).toBe(0);
    expect(doc?.channel).toBe("unknown");
    expect(doc?.note).toMatch(/^Firecrawl/);
  });
});

describe("latest prefers a user-confirmed snapshot (review M1)", () => {
  it("returns the newest confirmed snapshot over any newer unconfirmed one, without editing either (D17)", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const read = () =>
      t.run(async (ctx) => {
        const { latest } = await import("./policies");
        return latest(ctx, userId, "n.example", "returns");
      });

    const oldConfirmed = await t.mutation(internal.policies.insertSnapshot, { userId, ...baseSnapshot, windowDays: 14 });
    await as.mutation(api.policies.confirm, { policyId: oldConfirmed, channel: "email" });
    const confirmed = await t.mutation(internal.policies.insertSnapshot, { userId, ...baseSnapshot, windowDays: 30 });
    await as.mutation(api.policies.confirm, { policyId: confirmed, channel: "email" });
    // A later failed re-fetch, the shape researchPolicy records.
    const failed = await t.mutation(internal.policies.insertSnapshot, {
      userId,
      ...baseSnapshot,
      channel: "unknown",
      passage: "",
      confidence: 0,
      note: "No policy page found on the merchant's domain",
    });

    const found = await read();
    expect(found?._id).toBe(confirmed);
    expect(found?.windowDays).toBe(30);
    // The failed row is still there, untouched: the read changed, not the data.
    expect((await t.run((ctx) => ctx.db.get(failed)))?.confirmedByUser).toBe(false);
  });

  it("is scoped to the user, domain and kind", async () => {
    const t = setup();
    const owner = await signedIn(t, "Owner");
    const other = await signedIn(t, "Other");
    const theirs = await t.mutation(internal.policies.insertSnapshot, { userId: other.userId, ...baseSnapshot });
    await other.as.mutation(api.policies.confirm, { policyId: theirs, channel: "email" });
    const mine = await t.mutation(internal.policies.insertSnapshot, { userId: owner.userId, ...baseSnapshot });
    await t.mutation(internal.policies.insertSnapshot, { userId: owner.userId, ...baseSnapshot, kind: "price_adjustment" });

    const found = await t.run(async (ctx) => {
      const { latest } = await import("./policies");
      return latest(ctx, owner.userId, "n.example", "returns");
    });
    expect(found?._id).toBe(mine);
  });
});

describe("fetchBoth skips a kind researched in the last 24h (review M1)", () => {
  const rowsFor = (t: ReturnType<typeof setup>) => t.run((ctx) => ctx.db.query("policies").collect());

  it("inserts nothing and makes no request when both kinds are fresh", async () => {
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 500 }));
    vi.stubGlobal("fetch", fetchSpy);
    const t = setup();
    const { userId, as } = await signedIn(t);
    const confirmed = await t.mutation(internal.policies.insertSnapshot, { userId, ...baseSnapshot, kind: "price_adjustment", windowDays: 14 });
    await as.mutation(api.policies.confirm, { policyId: confirmed, channel: "email" });
    await t.mutation(internal.policies.insertSnapshot, { userId, ...baseSnapshot, kind: "returns" });

    await t.action(internal.policies.fetchBoth, { userId, merchantDomain: "n.example" });

    expect(await rowsFor(t)).toHaveLength(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("hasFreshSnapshot: false with no snapshot, true inside 24h, false after, and per user", async () => {
    vi.useFakeTimers();
    const now = Date.UTC(2026, 8, 20, 12);
    vi.setSystemTime(now);
    const t = setup();
    const { userId } = await signedIn(t);
    const other = await signedIn(t, "Other");
    const key = { merchantDomain: "n.example", kind: "returns" as const };

    expect(await t.query(internal.policies.hasFreshSnapshot, { userId, ...key })).toBe(false);
    await t.mutation(internal.policies.insertSnapshot, { userId, ...baseSnapshot });
    expect(await t.query(internal.policies.hasFreshSnapshot, { userId, ...key })).toBe(true);
    expect(await t.query(internal.policies.hasFreshSnapshot, { userId: other.userId, ...key })).toBe(false);
    expect(await t.query(internal.policies.hasFreshSnapshot, { userId, ...key, kind: "price_adjustment" })).toBe(false);

    vi.setSystemTime(now + 24 * 3_600_000 - 1);
    expect(await t.query(internal.policies.hasFreshSnapshot, { userId, ...key })).toBe(true);
    vi.setSystemTime(now + 24 * 3_600_000);
    expect(await t.query(internal.policies.hasFreshSnapshot, { userId, ...key })).toBe(false);
  });

  it("researches only the stale kind; the new row is an insert, not an edit (D17)", async () => {
    // Only the clock is faked: the Firecrawl client's own timers must still run.
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = Date.UTC(2026, 8, 20, 12);
    vi.setSystemTime(now);
    // No network: any request the Firecrawl component makes fails, which researchPolicy records as a snapshot.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
    const t = setup();
    const { userId } = await signedIn(t);
    const stale = await t.mutation(internal.policies.insertSnapshot, { userId, ...baseSnapshot, kind: "returns" });
    vi.setSystemTime(now + 25 * 3_600_000);
    await t.mutation(internal.policies.insertSnapshot, { userId, ...baseSnapshot, kind: "price_adjustment" });

    await t.action(internal.policies.fetchBoth, { userId, merchantDomain: "n.example" });

    const rows = await rowsFor(t);
    expect(rows.filter((r) => r.kind === "price_adjustment")).toHaveLength(1);
    const returns = rows.filter((r) => r.kind === "returns");
    expect(returns).toHaveLength(2);
    expect(returns.find((r) => r._id === stale)?.passage).toBe(baseSnapshot.passage);
  });
});
