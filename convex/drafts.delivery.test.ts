/// <reference types="vite/client" />
/**
 * M13 (contract rev 5 §6; security baseline S-M03-1/4/5, DA-A-31): truthful claim-email delivery.
 *
 * These are the M03 appendix repros A.1–A.4 INVERTED, plus the resend-after-unknown path. They drive the real
 * AgentMail component (registered by `test.setup.ts`) with `fetch` stubbed at the provider boundary, so the
 * component's own workpool retry behaviour is what is under test — not a mock of it.
 *
 *   A.1  a lost provider response must not cause a second POST (at-most-once send), and the claim is `unknown`,
 *        never `sent` on the strength of a retry nobody approved;
 *   A.2  an ambiguous outcome is `unknown`, never `failed`: the approval stays bound and a second plain approval is
 *        refused — resending requires `resendAfterUnknown` with an acknowledgment of the earlier attempt;
 *   A.3  a provider error body never reaches the owner (`sendStatus`, `drafts.sendError`);
 *   A.4  `approveAndSend.to` is length-capped before any regex runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { setup, signedIn } from "./test.setup";
import { applySendOutcome, BACKOFF_MS, isPermanentSendFailure } from "./drafts";
import { MAIL_RECONCILE_STALL_MS, MAIL_SWEEP_PAGE, MAX_SENDS_PER_CLAIM } from "./limits";
import { agentmail } from "./mail";

type T = ReturnType<typeof setup>;

const T0 = Date.UTC(2026, 8, 23, 12);
const CONTACT = "support@acme.example";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function seed(t: T, userId: Id<"users">, over: { isExample?: boolean } = {}) {
  return await t.run(async (ctx) => {
    await ctx.db.insert("profiles", { userId, inboxId: "inbox_user_1", inboxEmail: "u1@agentmail.to" });
    const purchaseId = await ctx.db.insert("purchases", {
      userId, merchant: "Acme", merchantDomain: "acme.example", orderRef: "AC-1",
      purchasedAt: Date.UTC(2026, 0, 2), currency: "USD", status: "active",
    });
    const itemId = await ctx.db.insert("items", {
      purchaseId, userId, name: "Scarf", unitCents: 4000, qty: 1, returned: true, returnedAt: Date.UTC(2026, 0, 9),
    });
    const claimId = await ctx.db.insert("claims", {
      purchaseId, itemId, userId, type: "return_credit", expectedCents: 4000, status: "drafted", token: "AB12CD", version: 1,
      ...(over.isExample ? { isExample: true } : {}),
    });
    const draftId = await ctx.db.insert("drafts", {
      claimId, userId, version: 1, claimVersion: 1, to: CONTACT, subject: "Refund [RC-AB12CD]", body: "Please confirm the credit.",
    });
    return { claimId, draftId, purchaseId };
  });
}

async function drive(t: T, steps: number, stepMs: number) {
  for (let i = 0; i < steps; i++) {
    vi.advanceTimersByTime(stepMs);
    await t.finishInProgressScheduledFunctions();
  }
}

const approve = (as: Awaited<ReturnType<typeof signedIn>>["as"], draftId: Id<"drafts">, over: Record<string, unknown> = {}) =>
  as.mutation(api.drafts.approveAndSend, {
    draftId, to: CONTACT, subject: "Refund", body: "Please confirm the credit.", claimVersion: 1, draftVersion: 1,
    recipientConfirmed: true, ...over,
  });

/** Stubs the provider: `onSend(n)` answers the n-th POST to /messages/send (1-based); everything else is `{}`. */
function stubProvider(onSend: (n: number) => Response | Promise<Response>) {
  const posts: Array<Record<string, string>> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (String(url).includes("/messages/send")) {
        posts.push({ ...(init?.headers as Record<string, string>) });
        return await onSend(posts.length);
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
  return posts;
}

const okSend = (id: string) =>
  new Response(JSON.stringify({ message_id: id, thread_id: `th-${id}` }), { status: 200, headers: { "content-type": "application/json" } });

describe("S-M03-1: at-most-once claim email, ambiguous outcomes are unknown (A.1/A.2 inverted)", () => {
  it("A.1 inverted: a lost provider response causes exactly one POST, and the claim ends unknown — not sent, not failed", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const { claimId, draftId } = await seed(t, a.userId);
    const posts = stubProvider((n) => {
      if (n === 1) throw new TypeError("fetch failed: socket hang up"); // accepted by the provider, response lost
      return okSend("mid-2");
    });

    const outboundId = await approve(a.as, draftId);
    await drive(t, 120, 5_000);

    expect(posts.length).toBe(1); // before: 2 (the component's workpool re-POSTed with no idempotency key)
    const claim = await t.run((ctx) => ctx.db.get(claimId));
    expect(claim?.status).toBe("queued"); // before: "sent", on the strength of the unapproved second POST
    expect(claim?.sendUnknown).toBe(true);
    const draft = await t.run((ctx) => ctx.db.get(draftId));
    expect(draft?.outboundId).toBe(outboundId); // the approval stays bound to what was attempted
    expect(draft?.approvedAt).toBeDefined();
    expect(draft?.sendError).toBeUndefined(); // an unknown outcome is not reported as a failure
  });

  it("A.2 inverted: ambiguous exhaustion is unknown, keeps the binding, and a second plain approval is refused", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const { claimId, draftId } = await seed(t, a.userId);
    const posts = stubProvider(() => {
      throw new TypeError("fetch failed: timeout");
    });

    await approve(a.as, draftId);
    await drive(t, 400, 5_000);

    expect(posts.length).toBe(1); // before: 5 blind POSTs
    const claim = await t.run((ctx) => ctx.db.get(claimId));
    expect(claim?.status).toBe("queued"); // before: back to "drafted"
    expect(claim?.sendUnknown).toBe(true);
    const draft = await t.run((ctx) => ctx.db.get(draftId));
    expect(draft?.outboundId).toBeDefined(); // before: cleared, so a blind resend was accepted
    await expect(approve(a.as, draftId)).rejects.toThrow(/already sent/i);
    expect(posts.length).toBe(1);
  });

  it("a 5xx from the provider is ambiguous (the request may have been processed) → unknown", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const { claimId, draftId } = await seed(t, a.userId);
    stubProvider(() => new Response("upstream timeout", { status: 504 }));
    await approve(a.as, draftId);
    await drive(t, 20, 5_000);
    const claim = await t.run((ctx) => ctx.db.get(claimId));
    expect(claim?.status).toBe("queued");
    expect(claim?.sendUnknown).toBe(true);
  });

  it("a permanent 4xx is a definite failure: back to drafted, binding cleared, a corrected approval can send", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const { claimId, draftId } = await seed(t, a.userId);
    const posts = stubProvider((n) => (n === 1 ? new Response('{"error":"invalid recipient"}', { status: 422 }) : okSend("mid-ok")));

    await approve(a.as, draftId);
    await drive(t, 20, 5_000);

    const claim = await t.run((ctx) => ctx.db.get(claimId));
    expect(claim?.status).toBe("drafted");
    const draft = await t.run((ctx) => ctx.db.get(draftId));
    expect(draft?.outboundId).toBeUndefined();
    expect(draft?.sendError).toMatch(/refused/i);
    await approve(a.as, draftId);
    await drive(t, 20, 5_000);
    expect(posts.length).toBe(2);
    expect((await t.run((ctx) => ctx.db.get(claimId)))?.status).toBe("sent");
  });

  it("classifies component failures: only a provider 4xx response is permanent", () => {
    expect(isPermanentSendFailure("AgentMail API error 422: {\"error\":\"x\"}")).toBe(true);
    expect(isPermanentSendFailure("AgentMail API error 400")).toBe(true);
    expect(isPermanentSendFailure("AgentMail API error 429")).toBe(true); // a refusal: nothing was accepted
    expect(isPermanentSendFailure("AgentMail API error 500")).toBe(false);
    expect(isPermanentSendFailure("AgentMail API error 504: gateway timeout")).toBe(false);
    expect(isPermanentSendFailure("fetch failed: socket hang up")).toBe(false);
    expect(isPermanentSendFailure("AgentMail returned a 2xx without a JSON send response")).toBe(false);
    expect(isPermanentSendFailure("Workpool cancelled the send")).toBe(false);
    expect(isPermanentSendFailure(null)).toBe(false);
  });

  it("a component `failed` with an ambiguous reason is unknown and schedules no further poll (the component row is final)", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const { claimId, draftId } = await seed(t, a.userId);
    await t.run((ctx) => ctx.db.patch(draftId, { outboundId: "ob-1" as never, approvedAt: T0 }));
    await t.run((ctx) => ctx.db.patch(claimId, { status: "queued" }));
    const before = (await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).length;
    const outcome = await t.run((ctx) =>
      applySendOutcome(ctx, draftId, 1, { status: "failed", agentmailMessageId: null, threadId: null, errorMessage: "fetch failed" }, true),
    );
    expect(outcome).toBe("unknown");
    const after = (await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).length;
    expect(after).toBe(before);
    expect((await t.run((ctx) => ctx.db.get(claimId)))?.sendUnknown).toBe(true);
    expect((await t.run((ctx) => ctx.db.get(draftId)))?.outboundId).toBe("ob-1");
  });
});

describe("S-M03-4: no raw provider error body reaches the owner (A.3 inverted)", () => {
  it("sendStatus and drafts.sendError carry a fixed message, never the provider's body", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const { claimId, draftId } = await seed(t, a.userId);
    stubProvider(
      () => new Response('{"error":"invalid recipient","request":{"headers":{"authorization":"Bearer am-test"}}}', { status: 422 }),
    );
    await approve(a.as, draftId);
    await drive(t, 5, 1_000);
    const status = await a.as.query(api.drafts.sendStatus, { draftId });
    expect(status?.status).toBe("failed");
    expect(status?.errorMessage ?? "").not.toContain("Bearer");
    expect(status?.errorMessage ?? "").not.toContain("invalid recipient");
    expect(status?.errorMessage).toMatch(/refused/i);
    await drive(t, 20, 5_000);
    const [draft] = await a.as.query(api.drafts.listForClaim, { claimId });
    expect(draft.sendError ?? "").not.toContain("Bearer");
    expect(draft.sendError ?? "").not.toContain("request");
    expect(draft.sendError).toMatch(/refused/i);
  });
});

describe("S-M03-5: approveAndSend.to is capped before any regex (A.4 inverted)", () => {
  it("a 256k-character recipient is refused at once, without running the address regex over it", async () => {
    vi.useRealTimers();
    const t = setup();
    const a = await signedIn(t, "A");
    const { draftId } = await seed(t, a.userId);
    const huge = "a@" + ".".repeat(256_000) + "@";
    const started = performance.now();
    await expect(approve(a.as, draftId, { to: huge })).rejects.toThrow(/valid recipient/);
    // Before: EMAIL_RE backtracks quadratically (32k chars took ~0.5 s; 256k would take ~30 s).
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it("two addresses in one field are refused (one recipient per approval)", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const { draftId } = await seed(t, a.userId);
    await expect(approve(a.as, draftId, { to: "support@acme.example, other@evil.example" })).rejects.toThrow(/valid recipient/);
    await expect(approve(a.as, draftId, { to: "support@acme.example;other@evil.example" })).rejects.toThrow(/valid recipient/);
  });
});

describe("resendAfterUnknown (S-M03-1, DA-A-31): an explicit, acknowledged, fully re-checked resend", () => {
  async function unknownSend(t: T) {
    const a = await signedIn(t, "A");
    const seeded = await seed(t, a.userId);
    const posts = stubProvider((n) => {
      if (n === 1) throw new TypeError("fetch failed: timeout");
      return okSend(`mid-${n}`);
    });
    const outboundId = await approve(a.as, seeded.draftId);
    await drive(t, 20, 5_000);
    expect((await t.run((ctx) => ctx.db.get(seeded.claimId)))?.sendUnknown).toBe(true);
    return { a, ...seeded, posts, outboundId };
  }

  const resendArgs = (draftId: Id<"drafts">, acknowledgedOutboundId: string, over: Record<string, unknown> = {}) => ({
    draftId, acknowledgedOutboundId, to: CONTACT, subject: "Refund", body: "Please confirm the credit.",
    claimVersion: 1, draftVersion: 1, recipientConfirmed: true, ...over,
  });

  it("with the earlier attempt acknowledged: one more POST, a new draft version, a note naming the earlier attempt, one send used", async () => {
    const t = setup();
    const s = await unknownSend(t);
    const res = await s.a.as.mutation(api.drafts.resendAfterUnknown, resendArgs(s.draftId, s.outboundId));
    expect(res.ok).toBe(true);
    await drive(t, 20, 5_000);
    expect(s.posts.length).toBe(2);

    const drafts = await t.run((ctx) => ctx.db.query("drafts").withIndex("by_claim", (q) => q.eq("claimId", s.claimId)).collect());
    expect(drafts.map((d) => d.version).sort()).toEqual([1, 2]);
    const first = drafts.find((d) => d.version === 1)!;
    const second = drafts.find((d) => d.version === 2)!;
    expect(first.outboundId).toBe(s.outboundId); // the earlier attempt stays on record
    expect(second.outboundId).toBeDefined();
    expect(second.outboundId).not.toBe(s.outboundId);
    const claim = await t.run((ctx) => ctx.db.get(s.claimId));
    expect(claim?.status).toBe("sent");
    expect(claim?.sendUnknown).toBeUndefined();
    const notes = await t.run((ctx) => ctx.db.query("claimNotes").withIndex("by_claim", (q) => q.eq("claimId", s.claimId)).collect());
    expect(notes.some((n) => /earlier attempt/i.test(n.text))).toBe(true);
    const usage = await t.run((ctx) => ctx.db.query("usage").collect());
    expect(usage.find((u) => u.userId === s.a.userId && u.kind === "claim_email")?.count).toBe(2);
  });

  it("without the right acknowledgment it refuses and sends nothing", async () => {
    const t = setup();
    const s = await unknownSend(t);
    await expect(
      s.a.as.mutation(api.drafts.resendAfterUnknown, resendArgs(s.draftId, "some-other-outbound")),
    ).rejects.toThrow(/earlier attempt/i);
    await drive(t, 20, 5_000);
    expect(s.posts.length).toBe(1);
  });

  it("another user's draft → the identical not-found, nothing sent", async () => {
    const t = setup();
    const s = await unknownSend(t);
    const b = await signedIn(t, "B");
    await expect(b.as.mutation(api.drafts.resendAfterUnknown, resendArgs(s.draftId, s.outboundId))).rejects.toThrow(/^.*Draft not found/);
    expect(s.posts.length).toBe(1);
  });

  it("DA-A-31: a material change since the first attempt (claim version bumped) → refused, returned not thrown", async () => {
    const t = setup();
    const s = await unknownSend(t);
    await t.run((ctx) => ctx.db.patch(s.claimId, { version: 2 }));
    const res = await s.a.as.mutation(api.drafts.resendAfterUnknown, resendArgs(s.draftId, s.outboundId, { claimVersion: 2 }));
    expect(res).toMatchObject({ ok: false, code: "binding_changed" });
    await drive(t, 20, 5_000);
    expect(s.posts.length).toBe(1);
  });

  it("an example claim is never resent", async () => {
    const t = setup();
    const s = await unknownSend(t);
    await t.run((ctx) => ctx.db.patch(s.claimId, { isExample: true }));
    await expect(s.a.as.mutation(api.drafts.resendAfterUnknown, resendArgs(s.draftId, s.outboundId))).rejects.toThrow(/Example/);
    expect(s.posts.length).toBe(1);
  });

  it("a claim whose delivery is not unknown cannot use the resend path", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const { draftId } = await seed(t, a.userId);
    const posts = stubProvider((n) => okSend(`mid-${n}`));
    const outboundId = await approve(a.as, draftId);
    await drive(t, 20, 5_000);
    await expect(a.as.mutation(api.drafts.resendAfterUnknown, resendArgs(draftId, outboundId))).rejects.toThrow(/not unknown/i);
    expect(posts.length).toBe(1);
  });

  it("the earlier attempt resolved in the meantime (delayed success) → ok:false, recorded as sent, nothing resent", async () => {
    const t = setup();
    const s = await unknownSend(t);
    const { agentmail } = await import("./mail");
    vi.spyOn(agentmail, "status").mockResolvedValue({
      status: "sent", agentmailMessageId: "mid-late", threadId: "th-late", errorMessage: null,
    } as never);
    const res = await s.a.as.mutation(api.drafts.resendAfterUnknown, resendArgs(s.draftId, s.outboundId));
    expect(res).toMatchObject({ ok: false, code: "outcome_known" });
    const claim = await t.run((ctx) => ctx.db.get(s.claimId));
    expect(claim?.status).toBe("sent");
    expect(s.posts.length).toBe(1);
  });

  it(`counts toward the ${MAX_SENDS_PER_CLAIM}-sends-per-claim cap`, async () => {
    const t = setup();
    const s = await unknownSend(t);
    // Two earlier drafts already used sends on this claim (one approved and delivered, one resent).
    await t.run(async (ctx) => {
      for (const v of [2, 3]) {
        await ctx.db.insert("drafts", {
          claimId: s.claimId, userId: s.a.userId, version: v, claimVersion: 1, to: CONTACT, subject: "x", body: "x",
          approvedAt: T0, outboundId: `ob-old-${v}` as never,
        });
      }
    });
    await t.run((ctx) => ctx.db.patch(s.draftId, { version: 4 }));
    await expect(
      s.a.as.mutation(api.drafts.resendAfterUnknown, resendArgs(s.draftId, s.outboundId, { draftVersion: 4 })),
    ).rejects.toThrow(/at most 3 times/);
    expect(s.posts.length).toBe(1);
  });
});

describe("applySendOutcome after a resend: the earlier attempt never overwrites the current one", () => {
  it("an older attempt reaching unknown does not mark the newer send unknown", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const { claimId, draftId } = await seed(t, a.userId);
    await t.run(async (ctx) => {
      await ctx.db.patch(draftId, { outboundId: "ob-old" as never, approvedAt: T0 });
      await ctx.db.insert("drafts", {
        claimId, userId: a.userId, version: 2, claimVersion: 1, to: CONTACT, subject: "x", body: "x", approvedAt: T0, outboundId: "ob-new" as never,
      });
      await ctx.db.patch(claimId, { status: "queued" });
    });
    const outcome = await t.run((ctx) => applySendOutcome(ctx, draftId, BACKOFF_MS.length, null, false));
    expect(outcome).toBe("unknown");
    expect((await t.run((ctx) => ctx.db.get(claimId)))?.sendUnknown).toBeUndefined();
  });

  it("an older attempt that turns out delivered still records the truth: the claim is sent", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const { claimId, draftId } = await seed(t, a.userId);
    await t.run(async (ctx) => {
      await ctx.db.patch(draftId, { outboundId: "ob-old" as never, approvedAt: T0 });
      await ctx.db.insert("drafts", {
        claimId, userId: a.userId, version: 2, claimVersion: 1, to: CONTACT, subject: "x", body: "x", approvedAt: T0, outboundId: "ob-new" as never,
      });
      await ctx.db.patch(claimId, { status: "queued" });
    });
    const outcome = await t.run((ctx) =>
      applySendOutcome(ctx, draftId, 1, { status: "sent", agentmailMessageId: "mid-old", threadId: "th-old", errorMessage: null }, true),
    );
    expect(outcome).toBe("sent");
    expect((await t.run((ctx) => ctx.db.get(claimId)))?.status).toBe("sent");
  });
});

// ---------------------------------------------------------------------------
// P02-OW-1, P02-OW-2, P02-SK-1 (D244): the re-audit's repros, inverted.
// ---------------------------------------------------------------------------

const componentStatus = (t: T, outboundId: string) => t.run((ctx) => agentmail.status(ctx as never, outboundId as never));

const resendArgsFor = (draftId: Id<"drafts">, acknowledgedOutboundId: string) => ({
  draftId, acknowledgedOutboundId, to: CONTACT, subject: "Refund", body: "Please confirm the credit.",
  claimVersion: 1, draftVersion: 1, recipientConfirmed: true,
});

async function cancelScheduled(t: T, fnName: string) {
  await t.run(async (ctx) => {
    const jobs = await ctx.db.system.query("_scheduled_functions").collect();
    for (const job of jobs) {
      if (job.name.includes(fnName) && job.state.kind === "pending") await ctx.scheduler.cancel(job._id);
    }
  });
}

describe("P02-OW-1: a resend cancels an earlier attempt still pending in the component (R4 inverted)", () => {
  it("the 5-check chain ran out while the earlier row was pending: the resend cancels it, one POST in total, the claim ends sent", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const { claimId, draftId } = await seed(t, a.userId);
    const posts = stubProvider((n) => okSend(`mid-${n}`));
    const outboundId = await approve(a.as, draftId);

    // A workpool backlog: the last scheduled check finds the component row still pending.
    await t.mutation(internal.drafts.reconcileSend, { draftId, attempt: BACKOFF_MS.length });
    expect((await t.run((ctx) => ctx.db.get(claimId)))?.sendUnknown).toBe(true);
    expect((await componentStatus(t, outboundId))?.status).toBe("pending");

    const res = await a.as.mutation(api.drafts.resendAfterUnknown, resendArgsFor(draftId, outboundId));
    expect(res.ok).toBe(true);
    const earlier = await componentStatus(t, outboundId);
    expect(earlier?.status).toBe("failed");
    expect(earlier?.errorMessage).toBe("Cancelled by user");

    await drive(t, 60, 5_000);
    expect(posts.length).toBe(1); // before: 2 (the backlogged earlier attempt was POSTed too)
    expect((await t.run((ctx) => ctx.db.get(claimId)))?.status).toBe("sent");
    const notes = await t.run((ctx) => ctx.db.query("claimNotes").withIndex("by_claim", (q) => q.eq("claimId", claimId)).collect());
    // P02-SK-3 wording: a cancel is requested, never claimed to have stopped the earlier email.
    expect(notes.some((n) => /asked for it to be cancelled, but it may already have reached the merchant/.test(n.text))).toBe(true);
  });

  it("a refused resend never cancels the earlier attempt", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const { claimId, draftId } = await seed(t, a.userId);
    stubProvider((n) => okSend(`mid-${n}`));
    const outboundId = await approve(a.as, draftId);
    await t.mutation(internal.drafts.reconcileSend, { draftId, attempt: BACKOFF_MS.length });
    await t.run((ctx) => ctx.db.patch(claimId, { version: 2 })); // a material change: the resend is refused

    const res = await a.as.mutation(api.drafts.resendAfterUnknown, { ...resendArgsFor(draftId, outboundId), claimVersion: 2 });
    expect(res).toMatchObject({ ok: false, code: "binding_changed" });
    expect((await componentStatus(t, outboundId))?.status).toBe("pending");
  });
});

describe("P02-OW-2: the claim-email sweep recovers a lost reconcile chain", () => {
  it("R5 inverted: chain lost, the provider accepted → one hourly sweep leaves the claim sent with its reminder scheduled", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const { claimId, draftId } = await seed(t, a.userId);
    const posts = stubProvider((n) => okSend(`mid-${n}`));
    await approve(a.as, draftId);
    await cancelScheduled(t, "reconcileSend"); // the chain is lost
    await drive(t, 5, 1_000); // the workpool POSTs; the component records `sent`
    expect(posts.length).toBe(1);
    expect((await t.run((ctx) => ctx.db.get(claimId)))?.status).toBe("queued"); // before: stuck here for good

    vi.setSystemTime(T0 + 3_600_000);
    expect(await t.mutation(internal.drafts.sweepStalled, {})).toBe(1);
    await drive(t, 2, 1_000);

    const claim = await t.run((ctx) => ctx.db.get(claimId));
    expect(claim?.status).toBe("sent");
    expect(claim?.threadId).toBe("th-mid-1");
    const reminders = await t.run((ctx) => ctx.db.query("followUps").withIndex("by_claim", (q) => q.eq("claimId", claimId)).collect());
    expect(reminders.filter((r) => r.status === "pending")).toHaveLength(1);
    const draft = await t.run((ctx) => ctx.db.get(draftId));
    expect(draft?.agentmailMessageId).toBe("mid-1");
    expect(draft?.nextCheckAt).toBeUndefined(); // a definite outcome leaves the sweep's index
    expect(await t.mutation(internal.drafts.sweepStalled, {})).toBe(0);
  });

  it("S1b inverted: chain lost, the outcome is ambiguous → the sweep marks the claim sendUnknown, so a resend is possible", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const { claimId, draftId } = await seed(t, a.userId);
    const posts = stubProvider((n) => {
      if (n === 1) throw new TypeError("fetch failed: socket hang up");
      return okSend(`mid-${n}`);
    });
    const outboundId = await approve(a.as, draftId);
    await cancelScheduled(t, "reconcileSend");
    await drive(t, 5, 1_000);
    expect((await a.as.query(api.drafts.sendStatus, { draftId }))?.outcome).toBe("unknown");
    // Before: sendStatus says unknown, yet the resend path refuses.
    await expect(a.as.mutation(api.drafts.resendAfterUnknown, resendArgsFor(draftId, outboundId))).rejects.toThrow(/not unknown/);

    vi.setSystemTime(T0 + 3_600_000);
    expect(await t.mutation(internal.drafts.sweepStalled, {})).toBe(1);
    await drive(t, 2, 1_000);
    expect((await t.run((ctx) => ctx.db.get(claimId)))?.sendUnknown).toBe(true);
    expect((await t.run((ctx) => ctx.db.get(draftId)))?.nextCheckAt).toBeUndefined(); // the component row is final

    const res = await a.as.mutation(api.drafts.resendAfterUnknown, resendArgsFor(draftId, outboundId));
    expect(res.ok).toBe(true);
    await drive(t, 20, 5_000);
    expect(posts.length).toBe(2);
  });

  it("a live chain is never swept: each hop keeps nextCheckAt ahead of it", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const { draftId } = await seed(t, a.userId);
    stubProvider((n) => okSend(`mid-${n}`));
    await approve(a.as, draftId);
    const stamped = (await t.run((ctx) => ctx.db.get(draftId)))?.nextCheckAt;
    expect(stamped).toBe(T0 + BACKOFF_MS[0] + 5 * 60_000);
    vi.setSystemTime(T0 + BACKOFF_MS[0] + 60_000); // the first hop is a minute late: still within the grace
    expect(await t.mutation(internal.drafts.sweepStalled, {})).toBe(0);
  });

  it("a still-pending attempt found by the sweep is checked once and pushed to the next sweep, never given a second chain", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const { draftId } = await seed(t, a.userId);
    await t.run((ctx) => ctx.db.patch(draftId, { outboundId: "ob-stuck" as never, approvedAt: T0, nextCheckAt: T0 }));
    vi.spyOn(agentmail, "status").mockResolvedValue({ status: "pending", agentmailMessageId: null, threadId: null, errorMessage: null } as never);

    expect(await t.mutation(internal.drafts.sweepStalled, {})).toBe(1);
    const job = (await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).find((j) => j.name.includes("reconcileSend"))!;
    await t.mutation(internal.drafts.reconcileSend, job.args[0] as { draftId: Id<"drafts">; attempt: number; fromSweep?: boolean });
    const pendingHops = (await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).filter(
      (j) => j.name.includes("reconcileSend") && j.state.kind === "pending" && j._id !== job._id,
    );
    expect(pendingHops).toHaveLength(0);
    expect((await t.run((ctx) => ctx.db.get(draftId)))?.nextCheckAt).toBe(T0 + MAIL_RECONCILE_STALL_MS + 5 * 60_000);
  });

  it(`bounded: one sweep schedules at most ${MAIL_SWEEP_PAGE} checks, the next picks up the rest`, async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const { claimId } = await seed(t, a.userId);
    await t.run(async (ctx) => {
      for (let i = 0; i < MAIL_SWEEP_PAGE + 5; i++) {
        await ctx.db.insert("drafts", {
          claimId, userId: a.userId, version: 10 + i, claimVersion: 1, to: CONTACT, subject: "x", body: "x",
          approvedAt: T0, outboundId: `ob-${i}` as never, nextCheckAt: T0 - 1,
        });
      }
    });
    expect(await t.mutation(internal.drafts.sweepStalled, {})).toBe(MAIL_SWEEP_PAGE);
    expect(await t.mutation(internal.drafts.sweepStalled, {})).toBe(5);
    expect(await t.mutation(internal.drafts.sweepStalled, {})).toBe(0);
  });

  it("a tombstoned user's attempts leave the index without a check, so they never clog the page", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const { claimId, draftId } = await seed(t, a.userId);
    await t.run(async (ctx) => {
      await ctx.db.patch(draftId, { outboundId: "ob-t" as never, approvedAt: T0, nextCheckAt: T0 - 1 });
      await ctx.db.insert("accountState", { userId: a.userId, status: "deleting", requestedAt: T0, attempts: 0 });
    });
    expect(await t.mutation(internal.drafts.sweepStalled, {})).toBe(0);
    expect((await t.run((ctx) => ctx.db.get(draftId)))?.nextCheckAt).toBeUndefined();
    const jobs = (await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).filter((j) => j.name.includes("reconcileSend"));
    expect(jobs).toHaveLength(0);
    expect(claimId).toBeDefined();
  });
});

describe("P02-SK-1: after the component's 7-day cleanup, sendStatus falls back to the draft", () => {
  it("a confirmed send still reads sent 8 days later, with its message id and thread", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const { claimId, draftId } = await seed(t, a.userId);
    stubProvider((n) => okSend(`mid-${n}`));
    const outboundId = await approve(a.as, draftId);
    await drive(t, 20, 5_000);
    expect((await t.run((ctx) => ctx.db.get(claimId)))?.status).toBe("sent");

    vi.setSystemTime(T0 + 8 * 86_400_000);
    await t.mutation(internal.mailPurge.cleanupFinalizedOutbound, {});
    expect(await componentStatus(t, outboundId)).toBeNull(); // the component row is gone

    const status = await a.as.query(api.drafts.sendStatus, { draftId });
    expect(status).toEqual({ status: "sent", agentmailMessageId: "mid-1", threadId: "th-mid-1", errorMessage: null, outcome: "sent" });
  });

  it("with no recorded message id the outcome is unknown, never null (null reads as Sending…)", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const { draftId } = await seed(t, a.userId);
    await t.run((ctx) => ctx.db.patch(draftId, { outboundId: "ob-gone" as never, approvedAt: T0 }));
    vi.spyOn(agentmail, "status").mockResolvedValue(null as never);
    expect((await a.as.query(api.drafts.sendStatus, { draftId }))?.outcome).toBe("unknown");
    await t.run((ctx) => ctx.db.patch(draftId, { sendError: "The store's mail server refused the message." }));
    expect(await a.as.query(api.drafts.sendStatus, { draftId })).toMatchObject({ outcome: "failed", errorMessage: "The store's mail server refused the message." });
  });
});
