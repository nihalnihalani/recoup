/// <reference types="vite/client" />
/**
 * P01-P12 re-audit, batch 2 (P10-MW-2; D244): `drafts.generate` called `extract()` (OpenAI) with no try/catch, so
 * any provider failure -- an invalid/expired key, a rate limit, a 5xx -- reached the claim page unsanitized:
 *  - Dev: the provider's own error text, a masked key fragment, and a server stack line.
 *  - Production: an opaque, unactionable "Server Error".
 * It was the only provider-backed public action in the codebase that did not sanitize its own failure (every other
 * caller of a paid model/provider call -- `intake.processEvent`, `replies.classify`, `evidence.ts` -- already wraps
 * it and writes `sanitizeError`'s fixed-vocabulary summary instead of the raw message).
 *
 * Fix: `generate` wraps its `writeRetail`/`writeScenario` call (both bottom out in `extract()`) in try/catch, logs
 * with `logEvent("extraction_failed", ...)` + `sanitizeError`, and throws a `ConvexError` with a fixed, non-leaking
 * copy (`DRAFT_GENERATE_FAILED_MESSAGE`). Budget: no refund primitive exists anywhere in this codebase for a paid
 * call that fails after `budget.consume` runs (nothing un-charges a failed `extraction_failed` call elsewhere
 * either), so the `draft_generate` charge stays spent -- same as every other paid call in Recoup that fails after
 * the charge is taken.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConvexError } from "convex/values";

vi.mock("./lib/ai", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./lib/ai")>();
  return { ...orig, extract: vi.fn() };
});

import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { setup, signedIn } from "./test.setup";
import { extract } from "./lib/ai";
import { DRAFT_GENERATE_FAILED_MESSAGE } from "./drafts";

type T = ReturnType<typeof setup>;

afterEach(() => {
  vi.mocked(extract).mockReset();
});

async function seedClaim(t: T, userId: Id<"users">): Promise<Id<"claims">> {
  return await t.run(async (ctx) => {
    const purchaseId = await ctx.db.insert("purchases", {
      userId,
      merchant: "Acme",
      merchantDomain: "acme.example",
      orderRef: "AC-1",
      purchasedAt: Date.UTC(2026, 0, 2),
      currency: "USD",
      status: "active",
    });
    const itemId = await ctx.db.insert("items", {
      purchaseId,
      userId,
      name: "Scarf",
      unitCents: 4000,
      qty: 1,
      returned: true,
      returnedAt: Date.UTC(2026, 0, 9),
    });
    return await ctx.db.insert("claims", {
      purchaseId,
      itemId,
      userId,
      type: "return_credit",
      expectedCents: 4000,
      status: "detected",
      token: "AB12CD",
      version: 1,
    });
  });
}

async function withInbox(t: T, userId: Id<"users">) {
  await t.run((ctx) => ctx.db.insert("profiles", { userId, inboxId: "inbox_1", inboxEmail: "user@agentmail.to" }));
}

async function usageRows(t: T) {
  return await t.run((ctx) => ctx.db.query("usage").collect());
}

describe("P10-MW-2: drafts.generate sanitizes a failed model call", () => {
  // A realistic shape for what the OpenAI SDK actually throws on a bad/expired key: the provider's own text, a
  // masked key fragment, and (in the SDK) a stack trace underneath it -- exactly what must never reach the client.
  const RAW_PROVIDER_ERROR = "401 Incorrect API key provided: sk-abcd***************************wxyz. You can find your API key at https://platform.openai.com/account/api-keys.";

  it("wraps a provider failure in a fixed ConvexError instead of leaking the provider's text or key fragment", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    await withInbox(t, userId);
    const claimId = await seedClaim(t, userId);
    vi.mocked(extract).mockRejectedValue(new Error(RAW_PROVIDER_ERROR));

    let caught: unknown;
    try {
      await as.action(api.drafts.generate, { claimId });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ConvexError);
    expect((caught as InstanceType<typeof ConvexError>).data).toBe(DRAFT_GENERATE_FAILED_MESSAGE);
    const serialized = JSON.stringify(caught, Object.getOwnPropertyNames(caught));
    expect(serialized).not.toContain("sk-abcd");
    expect(serialized.toLowerCase()).not.toContain("api key provided");
    expect(serialized).not.toContain("platform.openai.com");
  });

  it("still charges draft_generate (no refund primitive exists in this codebase) and writes no draft row", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    await withInbox(t, userId);
    const claimId = await seedClaim(t, userId);
    vi.mocked(extract).mockRejectedValue(new Error(RAW_PROVIDER_ERROR));

    await expect(as.action(api.drafts.generate, { claimId })).rejects.toThrow(ConvexError);

    const usage = await usageRows(t);
    expect(usage.filter((u) => u.userId === userId && u.kind === "draft_generate")).toHaveLength(1);
    const drafts = await t.run((ctx) => ctx.db.query("drafts").collect());
    expect(drafts).toHaveLength(0);
  });

  it("a successful extract still returns a draft normally (the try/catch does not swallow the happy path)", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    await withInbox(t, userId);
    const claimId = await seedClaim(t, userId);
    vi.mocked(extract).mockResolvedValue({ subject: "Refund request", body: "Please refund my scarf." } as never);

    const draftId = await as.action(api.drafts.generate, { claimId });
    const draft = await t.run((ctx) => ctx.db.get(draftId));
    expect(draft?.body).toBe("Please refund my scarf.");
  });
});
