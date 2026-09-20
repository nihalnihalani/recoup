import { ConvexError } from "convex/values";
import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import { setup, signedIn } from "./test.setup";
import { researchPolicy } from "./policies";
import { verifyPassage } from "./lib/passage";

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
