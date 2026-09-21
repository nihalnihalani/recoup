import { ConvexError } from "convex/values";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { setup, signedIn } from "./test.setup";
import { researchPolicy, fetchBothImpl } from "./policies";
import { verifyPassage } from "./lib/passage";
import { inboxTransport } from "./account";
import type { ResearchDeps } from "./policies";

const DAY = 86_400_000;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/**
 * T18.6 (D129 B-1): `insertSnapshot` now refuses (returns `null`) for a
 * tombstoned user -- every pre-existing test in this file inserts for a
 * live, never-deleted one and always expects a real id back, so this thin
 * wrapper keeps every one of those call sites unchanged in shape while
 * asserting that away in one place. The B-1 regression tests below call the
 * raw mutation directly instead, since they specifically assert the `null`
 * refusal.
 */
async function insertSnapshotForTest(t: ReturnType<typeof setup>, args: Parameters<typeof t.mutation<typeof internal.policies.insertSnapshot>>[1]) {
  const id = await t.mutation(internal.policies.insertSnapshot, args);
  if (id === null) throw new Error("insertSnapshot unexpectedly refused (tombstoned user?)");
  return id;
}

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

    const firstId = await insertSnapshotForTest(t, { userId, ...baseSnapshot, passage: "First passage" });
    const secondId = await insertSnapshotForTest(t, { userId, ...baseSnapshot, passage: "Second passage" });

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
    const policyId = await insertSnapshotForTest(t, { userId, ...baseSnapshot });

    await as.mutation(api.policies.confirm, { policyId, channel: "email", contactEmail: "confirmed@n.example", windowDays: 30 });

    const patched = await t.run(async (ctx) => ctx.db.get(policyId));
    expect(patched?.confirmedByUser).toBe(true);
    expect(patched?.contactEmail).toBe("confirmed@n.example");
    expect(patched?.windowDays).toBe(30);
  });

  it("rejects an out-of-range windowDays (D43)", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t, "Owner");
    const policyId = await insertSnapshotForTest(t, { userId, ...baseSnapshot });
    for (const windowDays of [-1, 1.5, 3651]) {
      await expect(
        as.mutation(api.policies.confirm, { policyId, channel: "email", windowDays }),
      ).rejects.toThrow(/windowDays/);
    }
  });

  it("an edited passage or sourceUrl clears the evidence markers (D45)", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t, "Owner");
    const policyId = await insertSnapshotForTest(t, {
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

  // D116 (checkpoint-6b inventory bound gap, T18.2 addendum): passage,
  // sourceUrl and contactEmail all gain bounds mirroring the auto-extracted
  // path's own caps.
  describe("bounds (D116)", () => {
    it("accepts a passage at exactly the 600-char cap (matching the auto-extracted path)", async () => {
      const t = setup();
      const { userId, as } = await signedIn(t, "Owner");
      const policyId = await insertSnapshotForTest(t, { userId, ...baseSnapshot });
      const passage = "a".repeat(600);

      await as.mutation(api.policies.confirm, { policyId, channel: "email", passage });
      const row = await t.run((ctx) => ctx.db.get(policyId));
      expect(row?.passage).toBe(passage);
    });

    it("rejects a passage over the 600-char cap", async () => {
      const t = setup();
      const { userId, as } = await signedIn(t, "Owner");
      const policyId = await insertSnapshotForTest(t, { userId, ...baseSnapshot });
      const passage = "a".repeat(601);

      await expect(as.mutation(api.policies.confirm, { policyId, channel: "email", passage })).rejects.toThrow(
        ConvexError,
      );
    });

    it("accepts a sourceUrl at exactly the 2,048-char cap", async () => {
      const t = setup();
      const { userId, as } = await signedIn(t, "Owner");
      const policyId = await insertSnapshotForTest(t, { userId, ...baseSnapshot });
      const prefix = "https://n.example/";
      const sourceUrl = `${prefix}${"a".repeat(2_048 - prefix.length)}`;
      expect(sourceUrl.length).toBe(2_048);

      await as.mutation(api.policies.confirm, { policyId, channel: "email", sourceUrl });
      const row = await t.run((ctx) => ctx.db.get(policyId));
      expect(row?.sourceUrl).toBe(sourceUrl);
    });

    it("rejects a sourceUrl over the 2,048-char cap", async () => {
      const t = setup();
      const { userId, as } = await signedIn(t, "Owner");
      const policyId = await insertSnapshotForTest(t, { userId, ...baseSnapshot });
      const prefix = "https://n.example/";
      const sourceUrl = `${prefix}${"a".repeat(2_049 - prefix.length)}`;

      await expect(as.mutation(api.policies.confirm, { policyId, channel: "email", sourceUrl })).rejects.toThrow(
        ConvexError,
      );
    });

    it("rejects a non-http(s) sourceUrl", async () => {
      const t = setup();
      const { userId, as } = await signedIn(t, "Owner");
      const policyId = await insertSnapshotForTest(t, { userId, ...baseSnapshot });

      await expect(
        as.mutation(api.policies.confirm, { policyId, channel: "email", sourceUrl: "javascript:alert(1)" }),
      ).rejects.toThrow(ConvexError);
    });

    it("accepts a contactEmail at exactly the 320-char cap", async () => {
      const t = setup();
      const { userId, as } = await signedIn(t, "Owner");
      const policyId = await insertSnapshotForTest(t, { userId, ...baseSnapshot });
      const local = "a".repeat(320 - "@n.example".length);
      const contactEmail = `${local}@n.example`;
      expect(contactEmail.length).toBe(320);

      await as.mutation(api.policies.confirm, { policyId, channel: "email", contactEmail });
      const row = await t.run((ctx) => ctx.db.get(policyId));
      expect(row?.contactEmail).toBe(contactEmail);
    });

    it("rejects a contactEmail over the 320-char cap", async () => {
      const t = setup();
      const { userId, as } = await signedIn(t, "Owner");
      const policyId = await insertSnapshotForTest(t, { userId, ...baseSnapshot });
      const local = "a".repeat(321 - "@n.example".length);
      const contactEmail = `${local}@n.example`;

      await expect(as.mutation(api.policies.confirm, { policyId, channel: "email", contactEmail })).rejects.toThrow(
        ConvexError,
      );
    });

    it("rejects a contactEmail that parses as more than one address", async () => {
      const t = setup();
      const { userId, as } = await signedIn(t, "Owner");
      const policyId = await insertSnapshotForTest(t, { userId, ...baseSnapshot });

      await expect(
        as.mutation(api.policies.confirm, { policyId, channel: "email", contactEmail: "a@n.example, b@n.example" }),
      ).rejects.toThrow(ConvexError);
    });
  });

  it("throws when a different user tries to confirm someone else's snapshot", async () => {
    const t = setup();
    const { userId } = await signedIn(t, "Owner");
    const { as: asOther } = await signedIn(t, "Other");
    const policyId = await insertSnapshotForTest(t, { userId, ...baseSnapshot });

    await expect(asOther.mutation(api.policies.confirm, { policyId, channel: "email" })).rejects.toThrow();
  });

  it("C3(c)/D107: confirming a price_adjustment snapshot clears this merchant's items' schedule stamp; a returns snapshot does not", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t, "Owner");
    const merchantDomain = "clears.example";
    const purchaseId = await t.run((ctx) =>
      ctx.db.insert("purchases", { userId, merchant: "M", merchantDomain, currency: "USD", status: "active" }),
    );
    const itemId = await t.run((ctx) =>
      ctx.db.insert("items", {
        purchaseId, userId, name: "X", unitCents: 1_000, qty: 1, returned: false, nextCheckAt: Date.now() + 999_999,
      }),
    );

    const priceId = await insertSnapshotForTest(t, {
      userId, merchantDomain, kind: "price_adjustment", channel: "email", passage: "", sourceUrl: `https://${merchantDomain}`, confidence: 0,
    });
    await as.mutation(api.policies.confirm, { policyId: priceId, channel: "email", windowDays: 14 });
    expect((await t.run((ctx) => ctx.db.get(itemId)))!.nextCheckAt).toBeUndefined();

    // Re-stamp, then confirm a RETURNS snapshot for the same merchant: price-watch
    // eligibility never depends on a returns policy (see `priceWatch.watchWindow`),
    // so this must not be touched.
    await t.run((ctx) => ctx.db.patch(itemId, { nextCheckAt: Date.now() + 999_999 }));
    const returnsId = await insertSnapshotForTest(t, {
      userId, merchantDomain, kind: "returns", channel: "email", passage: "", sourceUrl: `https://${merchantDomain}`, confidence: 0,
    });
    await as.mutation(api.policies.confirm, { policyId: returnsId, channel: "email", windowDays: 30 });
    expect((await t.run((ctx) => ctx.db.get(itemId)))!.nextCheckAt).toBeDefined();
  });
});

describe("clearMerchantSchedule (C3(c)/D107: internal wrapper `refresh` calls after a fresh snapshot lands)", () => {
  it("un-stamps every item this user owns at the merchant", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const merchantDomain = "refreshed.example";
    const purchaseId = await t.run((ctx) =>
      ctx.db.insert("purchases", { userId, merchant: "M", merchantDomain, currency: "USD", status: "active" }),
    );
    const itemId = await t.run((ctx) =>
      ctx.db.insert("items", {
        purchaseId, userId, name: "X", unitCents: 1_000, qty: 1, returned: false, nextCheckAt: Date.now() + 999_999,
      }),
    );

    await t.mutation(internal.policies.clearMerchantSchedule, { userId, merchantDomain });
    expect((await t.run((ctx) => ctx.db.get(itemId)))!.nextCheckAt).toBeUndefined();
  });
});

describe("fetchBothImpl un-stamps after an automatic price_adjustment re-research (6a-5/D112)", () => {
  it("a new snapshot widening the window makes a stamped item eligible within 2 ticks", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const merchantDomain = "reopens.example";
    const purchaseId = await t.run((ctx) =>
      ctx.db.insert("purchases", {
        userId,
        merchant: "M",
        merchantDomain,
        currency: "USD",
        status: "active",
        purchasedAt: Date.now() - 30 * DAY,
      }),
    );
    // A closed 14-day window (the purchase is 30 days old): priceWatch's
    // first tick stamps the item permanently ineligible, same as the
    // "closed window reopened via policies.confirm" C3/D107 resurrection
    // path -- except here the re-research is the AUTOMATIC one (fetchBoth),
    // not the user calling `confirm`.
    const staleId = await insertSnapshotForTest(t, {
      userId,
      merchantDomain,
      kind: "price_adjustment",
      channel: "email",
      windowDays: 14,
      passage: "",
      sourceUrl: `https://${merchantDomain}`,
      confidence: 0,
    });
    // Old enough that fetchBothImpl's freshness check does not skip re-researching it.
    await t.run((ctx) => ctx.db.patch(staleId, { retrievedAt: Date.now() - 25 * 3_600_000 }));
    const itemId = await t.run((ctx) =>
      ctx.db.insert("items", {
        purchaseId,
        userId,
        name: "X",
        unitCents: 1_000,
        qty: 1,
        productUrl: `https://${merchantDomain}/p`,
        returned: false,
      }),
    );

    // Tick 1: the window is closed -- permanently ineligible, stamped out.
    expect(await t.mutation(internal.priceWatch.eligibleItems, {})).toEqual([]);
    expect((await t.run((ctx) => ctx.db.get(itemId)))!.nextCheckAt).toBeDefined();

    // The automatic re-research (fetchBothImpl, the scheduler's own call
    // shape) lands a widened window through the existing mocked
    // ResearchDeps seam -- no live Firecrawl/OpenAI call.
    const markdown = "# Price Match\n\nWe match a lower price within 60 days of purchase.\n" + " ".repeat(150);
    const passage = "We match a lower price within 60 days of purchase.";
    const deps: ResearchDeps = {
      search: async () => ({ web: [{ url: `https://${merchantDomain}/policy`, markdown }] }),
      extract: async () => ({
        found: true,
        windowDays: 60,
        channel: "email",
        contactEmail: `help@${merchantDomain}`,
        passage,
        confidence: 0.9,
      }),
    };
    await fetchBothImpl(
      { runMutation: (ref: any, a: any) => t.mutation(ref, a), runQuery: (ref: any, a: any) => t.query(ref, a) },
      { userId, merchantDomain },
      deps,
    );

    // The new, wider snapshot really landed.
    const rows = await t.run((ctx) =>
      ctx.db
        .query("policies")
        .withIndex("by_user_domain_kind", (q) => q.eq("userId", userId).eq("merchantDomain", merchantDomain).eq("kind", "price_adjustment"))
        .collect(),
    );
    expect(rows.some((r) => r.windowDays === 60)).toBe(true);

    // Tick 2 (well within the "2 ticks" budget -- the very next one):
    // clearMerchantSchedule reset the item's stamp, so it is found again.
    expect(await t.mutation(internal.priceWatch.eligibleItems, {})).toEqual([itemId]);
  });
});

describe("T24c (D109): fetchBothImpl's failure line is structured and redacted", () => {
  it("logs one extraction_failed JSON line via logEvent, never a raw console.error with the provider error object", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const merchantDomain = "extract-fails.example";
    // `researchPolicy` catches a `search` failure itself (never throws past it), but a `deps.extract`
    // failure is NOT caught internally -- it is the one path that still reaches fetchBothImpl's own
    // catch, which is what this sweep item replaced.
    const markdown = "# Returns\n\nReturns are accepted within 30 days of purchase.\n" + " ".repeat(200);
    const deps: ResearchDeps = {
      search: async () => ({ web: [{ url: `https://${merchantDomain}/policy`, markdown }] }),
      extract: async () => {
        throw new Error("upstream failed using key sk-abcdefghij1234567890, contact sam@home.example");
      },
    };
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    await fetchBothImpl(
      { runMutation: (ref: any, a: any) => t.mutation(ref, a), runQuery: (ref: any, a: any) => t.query(ref, a) },
      { userId, merchantDomain },
      deps,
    );

    // Once per kind ("price_adjustment", "returns") -- deps.extract fails identically both times.
    expect(spy).toHaveBeenCalledTimes(2);
    const lines = spy.mock.calls.map((call) => JSON.parse(call[0] as string) as Record<string, unknown>);
    spy.mockRestore();
    for (const line of lines) {
      expect(line.kind).toBe("extraction_failed");
      expect(line.merchantDomain).toBe(merchantDomain);
      expect(typeof line.error).toBe("string");
      // correlationId/at are excluded before the leak check below: correlationId is a random UUID
      // (crypto.randomUUID()) whose hex/hyphen characters can incidentally match the sk-/fc- shape
      // (~1% per run) -- not a leak, just a coincidental substring of a random id.
      delete line.correlationId;
      delete line.at;
    }
    // `policyKind` (not `kind`, which `logEvent`'s envelope reserves for its own tag) survives.
    expect(lines.map((l) => l.policyKind)).toEqual(["price_adjustment", "returns"]);
    const raw = JSON.stringify(lines);
    // sanitizeError collapses the raw provider error down to one of a small set of fixed, user-safe
    // categories (convex/lib/errors.ts) -- the injected secret/email never survives into the line.
    expect(raw).not.toMatch(/sk-[A-Za-z0-9_-]{10,}/);
    expect(raw).not.toMatch(/fc-[A-Za-z0-9_-]{10,}/);
    expect(raw).not.toMatch(/sam@home\.example/);
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

  // D115 6b-3 (T18.2): `refresh` used to resolve its caller with a bare
  // `getAuthUserId`, so a tombstoned account could still charge the
  // policy_refresh/policy_fetch budgets and trigger a Firecrawl search.
  it("refuses a tombstoned caller before charging or fetching anything", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    await purchaseAt(t, userId, "bought.example");
    await t.run((ctx) =>
      ctx.db.insert("accountState", { userId, status: "deleting", requestedAt: Date.now(), attempts: 0 }),
    );
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(as.action(api.policies.refresh, { merchantDomain: "bought.example", kind: "returns" })).rejects.toThrow(
      ConvexError,
    );
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

    const id = (await researchPolicy(
      { runMutation: (ref: any, args: any) => t.mutation(ref, args) },
      { userId, merchantDomain: "n.example", kind: "returns" },
      { search: async () => ({ web: [] }), extract: async () => { throw new Error("should not be called"); } },
    ))!;

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

    const id = (await researchPolicy(
      { runMutation: (ref: any, args: any) => t.mutation(ref, args) },
      { userId, merchantDomain: "n.example", kind: "returns" },
      {
        search: async () => ({ web: [{ url: "https://n.example/returns", markdown: markdown + " ".repeat(150) }] }),
        extract: async () => ({ found: true, windowDays: 45, channel: "email", contactEmail: "help@n.example", passage, confidence: 0.92 }),
      },
    ))!;

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

    const id = (await researchPolicy(
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
    ))!;

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

    const id = (await researchPolicy(
      { runMutation: (ref: any, args: any) => t.mutation(ref, args) },
      { userId, merchantDomain: "n.example", kind: "returns" },
      {
        search: async () => {
          throw new ConvexError({ status: 402, message: "Insufficient credits" });
        },
        extract: async () => { throw new Error("should not be called"); },
      },
    ))!;

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

    const oldConfirmed = await insertSnapshotForTest(t, { userId, ...baseSnapshot, windowDays: 14 });
    await as.mutation(api.policies.confirm, { policyId: oldConfirmed, channel: "email" });
    const confirmed = await insertSnapshotForTest(t, { userId, ...baseSnapshot, windowDays: 30 });
    await as.mutation(api.policies.confirm, { policyId: confirmed, channel: "email" });
    // A later failed re-fetch, the shape researchPolicy records.
    const failed = await insertSnapshotForTest(t, {
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
    const theirs = await insertSnapshotForTest(t, { userId: other.userId, ...baseSnapshot });
    await other.as.mutation(api.policies.confirm, { policyId: theirs, channel: "email" });
    const mine = await insertSnapshotForTest(t, { userId: owner.userId, ...baseSnapshot });
    await insertSnapshotForTest(t, { userId: owner.userId, ...baseSnapshot, kind: "price_adjustment" });

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
    const confirmed = await insertSnapshotForTest(t, { userId, ...baseSnapshot, kind: "price_adjustment", windowDays: 14 });
    await as.mutation(api.policies.confirm, { policyId: confirmed, channel: "email" });
    await insertSnapshotForTest(t, { userId, ...baseSnapshot, kind: "returns" });

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
    await insertSnapshotForTest(t, { userId, ...baseSnapshot });
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
    const stale = await insertSnapshotForTest(t, { userId, ...baseSnapshot, kind: "returns" });
    vi.setSystemTime(now + 25 * 3_600_000);
    await insertSnapshotForTest(t, { userId, ...baseSnapshot, kind: "price_adjustment" });

    await t.action(internal.policies.fetchBoth, { userId, merchantDomain: "n.example" });

    const rows = await rowsFor(t);
    expect(rows.filter((r) => r.kind === "price_adjustment")).toHaveLength(1);
    const returns = rows.filter((r) => r.kind === "returns");
    expect(returns).toHaveLength(2);
    expect(returns.find((r) => r._id === stale)?.passage).toBe(baseSnapshot.passage);
  });
});

describe("T18.5 (D124 B2): fetchBoth refuses to spend or write for a deleted user", () => {
  it("before/after: a scheduled fetchBoth landing after the owner's account is deleted makes no search call and inserts nothing [FAILS pre-T18.5]", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const merchantDomain = "acme-deleted.example";

    let searchCalls = 0;
    const deps: ResearchDeps = {
      search: async () => {
        searchCalls++;
        return { web: [{ url: `https://${merchantDomain}/policy`, markdown: "irrelevant" }] };
      },
      extract: async () => ({ found: true, channel: "email", passage: "n/a", confidence: 0.9 }),
    };

    await as.mutation(api.account.requestDeletion, { confirmation: "delete my account" });

    await fetchBothImpl(
      { runMutation: (ref: any, a: any) => t.mutation(ref, a), runQuery: (ref: any, a: any) => t.query(ref, a) },
      { userId, merchantDomain },
      deps,
    );

    expect(searchCalls).toBe(0);
    const rows = await t.run((ctx) =>
      ctx.db.query("policies").withIndex("by_user_domain_kind", (q) => q.eq("userId", userId).eq("merchantDomain", merchantDomain)).collect(),
    );
    expect(rows).toHaveLength(0);
  });

  it("an active (non-deleted) user's fetchBoth is unaffected by the new gate", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const merchantDomain = "acme-active.example";
    let searchCalls = 0;
    const deps: ResearchDeps = {
      search: async () => {
        searchCalls++;
        return { web: [] };
      },
      extract: async () => ({ found: false, channel: "unknown", passage: "", confidence: 0 }),
    };
    await fetchBothImpl(
      { runMutation: (ref: any, a: any) => t.mutation(ref, a), runQuery: (ref: any, a: any) => t.query(ref, a) },
      { userId, merchantDomain },
      deps,
    );
    expect(searchCalls).toBe(2); // both kinds researched
  });
});

describe("T18.6 (D129 B-1): insertSnapshot itself is gated at the write -- D124 B2's fetchBoth-start check alone leaves the multi-second research window (search/extract) exposed to a deletion racing it", () => {
  async function purgeToCompletion(t: ReturnType<typeof setup>, userId: Id<"users">) {
    let done = false;
    for (let i = 0; i < 300 && !done; i++) {
      done = (await t.mutation(internal.account.purgeStep, { userId })).done;
    }
    expect(done).toBe(true);
  }

  it("fetchBothImpl: requestDeletion + full purge complete while `search` is in flight -> 0 policies rows survive for the dead userId", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    vi.spyOn(inboxTransport, "deleteInbox").mockResolvedValue(undefined);
    let fired = false;
    const deps: ResearchDeps = {
      search: async () => {
        if (!fired) {
          fired = true;
          await as.mutation(api.account.requestDeletion, { confirmation: "delete my account" });
          await purgeToCompletion(t, userId);
        }
        return { web: [] };
      },
      extract: (async () => { throw new Error("not reached"); }) as any,
    };
    await fetchBothImpl(
      { runMutation: (ref: any, a: any) => t.mutation(ref, a), runQuery: (ref: any, a: any) => t.query(ref, a) },
      { userId, merchantDomain: "acme-race.example" },
      deps,
    );
    const rows = await t.run((ctx) =>
      ctx.db.query("policies").withIndex("by_user_domain_kind", (q) => q.eq("userId", userId).eq("merchantDomain", "acme-race.example")).collect(),
    );
    console.log("[T18.6 B-1] policies rows surviving a mid-research deletion (fetchBothImpl):", rows.length);
    expect(rows).toHaveLength(0);
  });

  it("insertSnapshot refuses a direct call for a fully-purged user, returning null instead of writing", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    vi.spyOn(inboxTransport, "deleteInbox").mockResolvedValue(undefined);
    await as.mutation(api.account.requestDeletion, { confirmation: "delete my account" });
    await purgeToCompletion(t, userId);

    const id = await t.mutation(internal.policies.insertSnapshot, {
      userId, merchantDomain: "acme-race2.example", kind: "returns", channel: "unknown", passage: "", sourceUrl: "https://acme-race2.example", confidence: 0,
    });
    expect(id).toBeNull();
    expect(await t.run((ctx) => ctx.db.query("policies").withIndex("by_user_domain_kind", (q) => q.eq("userId", userId).eq("merchantDomain", "acme-race2.example")).collect())).toHaveLength(0);
  });

  it("researchPolicy (refresh's own write path): a deletion landing while `search` is in flight returns null instead of inserting a snapshot for the now-purged user", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    vi.spyOn(inboxTransport, "deleteInbox").mockResolvedValue(undefined);
    const deps: ResearchDeps = {
      search: async () => {
        await as.mutation(api.account.requestDeletion, { confirmation: "delete my account" });
        await purgeToCompletion(t, userId);
        return { web: [] };
      },
      extract: (async () => { throw new Error("not reached"); }) as any,
    };
    const ctx = { runMutation: (ref: any, a: any) => t.mutation(ref, a) };
    const result = await researchPolicy(ctx as any, { userId, merchantDomain: "acme-refresh-race.example", kind: "returns" }, deps);
    console.log("[T18.6 B-1] researchPolicy result for a mid-research deletion:", result);
    expect(result).toBeNull();
    expect(await t.run((ctx) => ctx.db.query("policies").withIndex("by_user_domain_kind", (q) => q.eq("userId", userId).eq("merchantDomain", "acme-refresh-race.example")).collect())).toHaveLength(0);
  });
});
