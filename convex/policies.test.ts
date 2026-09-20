import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { setup, signedIn } from "./test.setup";

/**
 * Policy snapshots (D17). These tests exercise the mutations and the query
 * only: `fetchBoth`/`fetchOne` call Firecrawl and OpenAI and are verified
 * live against the dev deployment instead.
 */

const DOMAIN = "acme.example";

type SnapshotOverrides = {
  kind?: "price_adjustment" | "returns";
  windowDays?: number;
  passage?: string;
  passageStart?: number;
  sourceUrl?: string;
  confidence?: number;
  note?: string;
  merchantDomain?: string;
};

async function insert(
  t: ReturnType<typeof setup>,
  userId: Id<"users">,
  o: SnapshotOverrides = {},
): Promise<Id<"policies">> {
  return await t.mutation(internal.policies.insertSnapshot, {
    userId,
    merchantDomain: o.merchantDomain ?? DOMAIN,
    kind: o.kind ?? "returns",
    windowDays: o.windowDays,
    channel: "email",
    contactEmail: "support@acme.example",
    passage: o.passage ?? "Return most items within 30 days.",
    passageStart: o.passageStart ?? 120,
    sourceUrl: o.sourceUrl ?? `https://${DOMAIN}/returns`,
    confidence: o.confidence ?? 0.9,
    note: o.note,
  });
}

/** Snapshots are ordered by _creationTime; make sure two inserts differ. */
async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 3));
}

describe("policies.insertSnapshot", () => {
  it("inserts a new row per refresh and never mutates the previous snapshot", async () => {
    const t = setup();
    const { userId } = await signedIn(t);

    const firstId = await insert(t, userId, { windowDays: 30, passage: "within 30 days" });
    const before = await t.run((ctx) => ctx.db.get(firstId));
    await tick();
    const secondId = await insert(t, userId, { windowDays: 14, passage: "within 14 days" });

    expect(secondId).not.toBe(firstId);
    const after = await t.run((ctx) => ctx.db.get(firstId));
    expect(after).toEqual(before);

    const all = await t.run((ctx) => ctx.db.query("policies").collect());
    expect(all).toHaveLength(2);
  });

  it("defaults confirmedByUser to false and stamps retrievedAt", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const id = await insert(t, userId);
    const row = await t.run((ctx) => ctx.db.get(id));
    expect(row?.confirmedByUser).toBe(false);
    expect(row?.retrievedAt).toBeGreaterThan(0);
  });

  it("stores a failed research pass as a zero-confidence snapshot, not an error", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const id = await t.mutation(internal.policies.insertSnapshot, {
      userId,
      merchantDomain: DOMAIN,
      kind: "returns",
      channel: "unknown",
      passage: "",
      sourceUrl: `https://${DOMAIN}`,
      confidence: 0,
      note: "passage not found verbatim",
    });
    const row = await t.run((ctx) => ctx.db.get(id));
    expect(row?.confidence).toBe(0);
    expect(row?.passage).toBe("");
    expect(row?.passageStart).toBeUndefined();
    expect(row?.note).toBe("passage not found verbatim");
  });
});

describe("policies.latestForDomain", () => {
  it("returns the newest snapshot per kind", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);

    await insert(t, userId, { kind: "returns", windowDays: 30 });
    await insert(t, userId, { kind: "price_adjustment", windowDays: 7 });
    await tick();
    await insert(t, userId, { kind: "returns", windowDays: 14 });

    const latest = await as.query(api.policies.latestForDomain, { merchantDomain: DOMAIN });
    expect(latest.returns?.windowDays).toBe(14);
    expect(latest.price_adjustment?.windowDays).toBe(7);
  });

  it("returns nulls for a kind never researched", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    await insert(t, userId, { kind: "returns" });
    const latest = await as.query(api.policies.latestForDomain, { merchantDomain: DOMAIN });
    expect(latest.price_adjustment).toBeNull();
    expect(latest.returns).not.toBeNull();
  });

  it("accepts a messy domain the UI might pass", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    await insert(t, userId, { kind: "returns" });
    const latest = await as.query(api.policies.latestForDomain, {
      merchantDomain: `https://WWW.${DOMAIN}/returns`,
    });
    expect(latest.returns).not.toBeNull();
  });

  it("returns nulls for a signed-out caller instead of throwing", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    await insert(t, userId);
    const latest = await t.query(api.policies.latestForDomain, { merchantDomain: DOMAIN });
    expect(latest).toEqual({ price_adjustment: null, returns: null });
  });

  it("never returns another user's snapshot", async () => {
    const t = setup();
    const owner = await signedIn(t, "Owner");
    const other = await signedIn(t, "Other");
    await insert(t, owner.userId, { kind: "returns", windowDays: 30 });

    const mine = await other.as.query(api.policies.latestForDomain, { merchantDomain: DOMAIN });
    expect(mine).toEqual({ price_adjustment: null, returns: null });
  });
});

describe("policies.confirm", () => {
  it("confirms only the snapshot named, leaving older ones untouched", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const oldId = await insert(t, userId);
    await tick();
    const newId = await insert(t, userId);

    await as.mutation(api.policies.confirm, { policyId: newId });

    expect((await t.run((ctx) => ctx.db.get(newId)))?.confirmedByUser).toBe(true);
    expect((await t.run((ctx) => ctx.db.get(oldId)))?.confirmedByUser).toBe(false);
  });

  it("rejects a caller who does not own the snapshot", async () => {
    const t = setup();
    const owner = await signedIn(t, "Owner");
    const other = await signedIn(t, "Other");
    const policyId = await insert(t, owner.userId);

    await expect(other.as.mutation(api.policies.confirm, { policyId })).rejects.toThrow(
      /Policy not found/,
    );
    expect((await t.run((ctx) => ctx.db.get(policyId)))?.confirmedByUser).toBe(false);
  });

  it("rejects a signed-out caller", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const policyId = await insert(t, userId);
    await expect(t.mutation(api.policies.confirm, { policyId })).rejects.toThrow(/Not signed in/);
  });
});

describe("policies.setManual", () => {
  it("creates a user-confirmed snapshot that wins as the latest", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    await insert(t, userId, { kind: "returns", windowDays: 30, confidence: 0.4 });
    await tick();

    const id = await as.mutation(api.policies.setManual, {
      merchantDomain: `https://www.${DOMAIN}/help`,
      kind: "returns",
      windowDays: 60,
      channel: "email",
      contactEmail: "returns@acme.example",
      passage: "Ninety day returns for members.",
      sourceUrl: `https://${DOMAIN}/help/returns`,
    });

    const row = await t.run((ctx) => ctx.db.get(id));
    expect(row?.confirmedByUser).toBe(true);
    expect(row?.confidence).toBe(1);
    expect(row?.merchantDomain).toBe(DOMAIN);
    expect(row?.windowDays).toBe(60);
    // Nothing was located in a scrape, so there is no offset to store (D17).
    expect(row?.passageStart).toBeUndefined();

    const latest = await as.query(api.policies.latestForDomain, { merchantDomain: DOMAIN });
    expect(latest.returns?._id).toBe(id);
  });

  it("accepts a URL on its own", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    const id = await as.mutation(api.policies.setManual, {
      merchantDomain: DOMAIN,
      kind: "price_adjustment",
      sourceUrl: `https://${DOMAIN}/price-match`,
    });
    const row = await t.run((ctx) => ctx.db.get(id));
    expect(row?.sourceUrl).toBe(`https://${DOMAIN}/price-match`);
    expect(row?.channel).toBe("unknown");
    expect(row?.passage).toBe("");
  });

  it("rejects empty input, a bad URL, a bad window and a bad email", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    const base = { merchantDomain: DOMAIN, kind: "returns" } as const;
    await expect(as.mutation(api.policies.setManual, base)).rejects.toThrow(/Enter a policy/);
    await expect(
      as.mutation(api.policies.setManual, { ...base, sourceUrl: "javascript:alert(1)" }),
    ).rejects.toThrow(/valid policy URL/);
    await expect(
      as.mutation(api.policies.setManual, { ...base, windowDays: -1 }),
    ).rejects.toThrow(/Window must be/);
    await expect(
      as.mutation(api.policies.setManual, { ...base, contactEmail: "nope" }),
    ).rejects.toThrow(/valid contact email/);
  });

  it("rejects a signed-out caller and an unusable domain", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    await expect(
      t.mutation(api.policies.setManual, {
        merchantDomain: DOMAIN,
        kind: "returns",
        sourceUrl: `https://${DOMAIN}/x`,
      }),
    ).rejects.toThrow(/Not signed in/);
    await expect(
      as.mutation(api.policies.setManual, {
        merchantDomain: "not a domain",
        kind: "returns",
        sourceUrl: `https://${DOMAIN}/x`,
      }),
    ).rejects.toThrow(/valid merchant domain/);
  });
});

describe("policies.refresh", () => {
  it("schedules fetchBoth for the signed-in user with a normalized domain", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    await as.mutation(api.policies.refresh, { merchantDomain: `https://WWW.${DOMAIN}/returns` });

    const scheduled = await t.run((ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].name).toContain("policies");
    expect(scheduled[0].args[0]).toEqual({ userId, merchantDomain: DOMAIN });
  });

  it("rejects a signed-out caller and schedules nothing", async () => {
    const t = setup();
    await expect(
      t.mutation(api.policies.refresh, { merchantDomain: DOMAIN }),
    ).rejects.toThrow(/Not signed in/);
    const scheduled = await t.run((ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(scheduled).toHaveLength(0);
  });

  it("rejects an unusable domain", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    await expect(
      as.mutation(api.policies.refresh, { merchantDomain: "not a domain" }),
    ).rejects.toThrow(/valid merchant domain/);
  });
});
