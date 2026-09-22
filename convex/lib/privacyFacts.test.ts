/**
 * M14 (DA-A-7, D146, D142, SEC-DEL-5): `lib/privacyFacts.ts` is what the
 * Privacy page renders, so these tests tie every constant to the code's
 * actual behaviour. Each window is exercised at its boundary through the
 * real sweeps. Each listed keep reason is seeded and must keep its row, so
 * an unimplemented or mistyped reason has no seeder and fails. Each
 * statement must contain its numbers.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { setup, signedIn } from "../test.setup";
import { evidenceKind } from "../schema";
import {
  RETENTION_KEEP_NEWEST,
  RETENTION_MAILLOG_DAYS,
  RETENTION_OBSERVATION_DAYS,
  RETENTION_PAYLOAD_DAYS,
  RETENTION_STASH_DAYS,
  RETENTION_UNVERIFIED_DAYS,
} from "../limits";
import {
  EVALUATION_KEEP_REASONS,
  EVALUATION_RETENTION_DAYS,
  EVIDENCE_KEEP_REASONS,
  EVIDENCE_RETENTION_DAYS,
  EVIDENCE_TEXT_KINDS,
  FACT_QUOTE_MAX_CHARS,
  MAIL_COMPONENT_RAW_COPY,
  ORPHAN_BLOB_MIN_AGE_HOURS,
  PRIVACY_STATEMENTS,
  UPLOAD_KEEP_REASONS,
} from "./privacyFacts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
type T = ReturnType<typeof setup>;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

async function runCycle(t: T, fn: "sweepRecovery" | "sweepOrphanBlobs") {
  for (let i = 0; i < 60; i++) {
    const res = await t.mutation(internal.retention[fn], {});
    if (res.done) return;
  }
  throw new Error(`${fn} did not finish a cycle`);
}

async function transaction(t: T, userId: Id<"users">, status: "active" | "archived" = "active") {
  return await t.run(async (ctx) => {
    const purchaseId = await ctx.db.insert("purchases", { userId, merchant: "Acme", merchantDomain: "acme.example", currency: "USD", status: "active" });
    const itemId = await ctx.db.insert("items", { purchaseId, userId, name: "Widget", unitCents: 1_000, qty: 1, returned: false });
    const transactionId = await ctx.db.insert("transactions", { userId, category: "retail_order", status, counterpartyName: "Acme", currency: "USD", purchaseId, liveFactCount: 0 });
    return { purchaseId, itemId, transactionId };
  });
}

async function evidence(t: T, userId: Id<"users">, kind: string, extra: { transactionId?: Id<"transactions">; pinnedAt?: number } = {}) {
  return await t.run(async (ctx) => {
    const storageId = kind === "upload" ? await ctx.storage.store(new Blob(["file"])) : undefined;
    return await ctx.db.insert("evidence", {
      userId, transactionId: extra.transactionId, kind: kind as never, docType: "receipt", sourceChannel: "manual", provenance: "user_pasted",
      storageId, contentHash: Math.random().toString(16).slice(2).padEnd(64, "0"), text: kind === "upload" ? undefined : "content",
      receivedAt: Date.now(), pinnedAt: extra.pinnedAt, extractionStatus: "succeeded", extractionAttempts: 1, retention: "active",
    });
  });
}

async function retentionOf(t: T, id: Id<"evidence">) {
  return (await t.run((ctx) => ctx.db.get(id)))?.retention;
}

describe("lib/privacyFacts — the published copy matches the code", () => {
  it("is frontend-importable: its only import is ../limits (itself import-free)", () => {
    const own = readFileSync(path.join(HERE, "privacyFacts.ts"), "utf8");
    const imports = [...own.matchAll(/^import[\s\S]*?from\s+"([^"]+)";/gm)].map((m) => m[1]);
    expect(imports).toEqual(["../limits"]);
    const limits = readFileSync(path.join(HERE, "..", "limits.ts"), "utf8");
    expect(limits).not.toMatch(/^import /m);
  });

  it("every statement contains the numbers it promises", () => {
    const expectations: Array<[keyof typeof PRIVACY_STATEMENTS, number[]]> = [
      ["evidenceText", [EVIDENCE_RETENTION_DAYS]],
      ["evidenceAfterClearing", [FACT_QUOTE_MAX_CHARS]],
      ["uploads", [EVIDENCE_RETENTION_DAYS]],
      ["unfinishedUploads", [ORPHAN_BLOB_MIN_AGE_HOURS]],
      ["evaluations", [EVALUATION_RETENTION_DAYS]],
      ["inboundPayload", [RETENTION_PAYLOAD_DAYS]],
      ["observations", [RETENTION_OBSERVATION_DAYS, RETENTION_KEEP_NEWEST]],
      ["mailLog", [RETENTION_MAILLOG_DAYS]],
      ["stash", [RETENTION_STASH_DAYS]],
      ["unverifiedAccounts", [RETENTION_UNVERIFIED_DAYS]],
    ];
    for (const [key, numbers] of expectations) {
      for (const n of numbers) expect(PRIVACY_STATEMENTS[key], key).toContain(String(n));
    }
    // D146 R4-1 wording, verbatim apart from the number.
    expect(PRIVACY_STATEMENTS.evidenceText).toContain(
      `Raw email content is cleared ${EVIDENCE_RETENTION_DAYS} days after Recoup finishes handling it, unless you start a claim with it or choose to keep it.`,
    );
  });

  it("the evidence window is exactly EVIDENCE_RETENTION_DAYS: kept an hour before it, cleared an hour after", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const id = await evidence(t, userId, "email");
    vi.advanceTimersByTime(EVIDENCE_RETENTION_DAYS * DAY_MS - HOUR_MS);
    await runCycle(t, "sweepRecovery");
    expect(await retentionOf(t, id)).toBe("active");
    vi.advanceTimersByTime(2 * HOUR_MS);
    await runCycle(t, "sweepRecovery");
    expect(await retentionOf(t, id)).toBe("content_deleted");
  });

  it("EVIDENCE_TEXT_KINDS are exactly the kinds whose text is cleared; every other non-upload kind is left alone", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const kinds = evidenceKind.members.map((m) => m.value as string);
    const ids = new Map<string, Id<"evidence">>();
    for (const kind of kinds) if (kind !== "upload") ids.set(kind, await evidence(t, userId, kind));
    vi.advanceTimersByTime((EVIDENCE_RETENTION_DAYS + 1) * DAY_MS);
    await runCycle(t, "sweepRecovery");
    const cleared = [];
    for (const [kind, id] of ids) if ((await retentionOf(t, id)) === "content_deleted") cleared.push(kind);
    expect(cleared.sort()).toEqual([...EVIDENCE_TEXT_KINDS].sort());
  });

  it("every EVIDENCE_KEEP_REASONS and UPLOAD_KEEP_REASONS entry keeps its row past the window (each reason has a seeder, so an unimplemented one fails)", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const seeders: Record<string, (kind: string) => Promise<Id<"evidence">>> = {
      claim_started: async (kind) => {
        const txn = await transaction(t, userId);
        await t.run((ctx) =>
          ctx.db.insert("claims", {
            purchaseId: txn.purchaseId, itemId: txn.itemId, userId, type: "price_adjustment", expectedCents: 100, status: "detected",
            token: `tok-${kind}`, version: 1, transactionId: txn.transactionId,
          }),
        );
        return await evidence(t, userId, kind, { transactionId: txn.transactionId });
      },
      user_kept: async (kind) => await evidence(t, userId, kind, { pinnedAt: Date.now() }),
      attached_to_open_transaction: async (kind) => await evidence(t, userId, kind, { transactionId: (await transaction(t, userId)).transactionId }),
    };
    const kept: Array<[string, Id<"evidence">]> = [];
    for (const reason of EVIDENCE_KEEP_REASONS) kept.push([`email:${reason}`, await seeders[reason]("email")]);
    for (const reason of UPLOAD_KEEP_REASONS) kept.push([`upload:${reason}`, await seeders[reason]("upload")]);
    const control = await evidence(t, userId, "email"); // no reason: must be cleared, or the test proves nothing
    vi.advanceTimersByTime((EVIDENCE_RETENTION_DAYS + 1) * DAY_MS);
    await runCycle(t, "sweepRecovery");
    for (const [label, id] of kept) expect(await retentionOf(t, id), label).toBe("active");
    expect(await retentionOf(t, control)).toBe("content_deleted");
  });

  it("the evaluation window is exactly EVALUATION_RETENTION_DAYS, and every EVALUATION_KEEP_REASONS entry keeps its row", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const opportunity = async (tag: string) => {
      const txn = await transaction(t, userId);
      return await t.run((ctx) =>
        ctx.db.insert("opportunities", {
          userId, transactionId: txn.transactionId, scenarioId: "R01", remedyKey: "price_difference", subjectKey: tag, dedupeKey: tag,
          status: "open", ruleId: "r01", ruleVersion: 1, outcome: "needs_facts", authorityClass: "merchant_promise",
          remedyType: "price_difference", cashClass: "cash", lossKeys: [], lastEvaluatedAt: Date.now(),
        }),
      );
    };
    const evaluation = async (opportunityId: Id<"opportunities">) =>
      await t.run((ctx) =>
        ctx.db.insert("evaluations", {
          userId, opportunityId, scenarioId: "R01", ruleId: "r01", ruleVersion: 1, factSnapshotHash: "f", resultHash: "r", evaluatedAt: Date.now(),
          trigger: "observation", outcome: "needs_facts",
          dimensions: { applies: "pass", factsKnown: "unknown", evidenceSupports: "unknown", windowOpen: "pass", amountCalculable: "unknown", readyForApproval: "fail" },
          conditions: [], missingFacts: [], assumptions: [], disqualifierIds: [], amount: null, deadlines: [], sourceRefs: [], overlap: [],
          nextAction: { kind: "none", reason: "t" }, explanation: [],
        }),
      );
    const seeders: Record<string, () => Promise<Id<"evaluations">>> = {
      current: async () => {
        const opp = await opportunity("current");
        const id = await evaluation(opp);
        await t.run((ctx) => ctx.db.patch(opp, { currentEvaluationId: id }));
        return id;
      },
      claim_or_approval: async () => {
        const opp = await opportunity("claim");
        const txn = await transaction(t, userId);
        await t.run((ctx) =>
          ctx.db.insert("claims", {
            purchaseId: txn.purchaseId, itemId: txn.itemId, userId, type: "price_adjustment", expectedCents: 100, status: "detected",
            token: "tok-eval", version: 1, opportunityId: opp,
          }),
        );
        return await evaluation(opp);
      },
    };
    const kept: Array<[string, Id<"evaluations">]> = [];
    for (const reason of EVALUATION_KEEP_REASONS) kept.push([reason, await seeders[reason]()]);
    const control = await evaluation(await opportunity("control"));

    vi.advanceTimersByTime(EVALUATION_RETENTION_DAYS * DAY_MS - HOUR_MS);
    await runCycle(t, "sweepRecovery");
    expect(await t.run((ctx) => ctx.db.get(control))).not.toBeNull();

    vi.advanceTimersByTime(2 * HOUR_MS);
    await runCycle(t, "sweepRecovery");
    expect(await t.run((ctx) => ctx.db.get(control))).toBeNull();
    for (const [reason, id] of kept) expect(await t.run((ctx) => ctx.db.get(id)), reason).not.toBeNull();
  });

  it("the orphan-blob age is exactly ORPHAN_BLOB_MIN_AGE_HOURS: kept a minute before it, deleted a minute after", async () => {
    const t = setup();
    const blob = await t.run((ctx) => ctx.storage.store(new Blob(["never finalized"])));
    vi.advanceTimersByTime(ORPHAN_BLOB_MIN_AGE_HOURS * HOUR_MS - 60_000);
    await runCycle(t, "sweepOrphanBlobs");
    expect(await t.run((ctx) => ctx.db.system.get("_storage", blob))).not.toBeNull();
    vi.advanceTimersByTime(120_000);
    await runCycle(t, "sweepOrphanBlobs");
    expect(await t.run((ctx) => ctx.db.system.get("_storage", blob))).toBeNull();
  });

  it("D142: the mail component's raw copy is disclosed as unmasked and kept until account deletion, and account.purge drains it", () => {
    expect(MAIL_COMPONENT_RAW_COPY).toEqual({ maskedByRecoup: false, keptUntil: "account_deletion", purgedOnAccountDeletion: true });
    expect(PRIVACY_STATEMENTS.mailComponentCopy).toMatch(/cannot mask/);
    expect(PRIVACY_STATEMENTS.mailComponentCopy).toMatch(/kept until you delete your account/);
    // The purge half of the promise: `account.purge` calls the component drain (behaviour covered by account.test.ts's T18.4 block).
    const account = readFileSync(path.join(HERE, "..", "account.ts"), "utf8");
    expect(account).toContain("internal.mailPurge.purgeInboxData");
  });
});
