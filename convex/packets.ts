/**
 * Manual-channel packets (M20; contract §6 "Manual approval", DA-A-9, DA-A-15, rev 5 N3/N6, SEC-AI-4).
 *
 * A packet is the text a user sends on a MANUAL channel (postal mail, a web form, a portal…) for a claim whose
 * `requiredChannel` is not email. Recoup never sends it: the user records the submission (`submissions.record`).
 * Versions are append-only: every prepare or edit writes a new version and supersedes the earlier live ones.
 *
 *   prepare  — re-evaluates the claim (approval_check, COMMITTED) and renders the pack's template from the bound
 *              evaluation (`lib/packets`); a template may state only bound, known facts (DA-A-15).
 *   update   — the user's edits (body, requested remedy, recipient, evidence index) as a new version.
 *   approve  — `packets.approve({ packetId, approvedHash })`, in this order: owner, example, closed, newest version,
 *              the rendered-hash echo, the per-user limit, the committed re-evaluation (N3: a withdrawn pack →
 *              `rule_withdrawn` once, then the legacy path), a current `binding.contextHash`, a recipient, every
 *              evidence item owned/active/unchanged, `APPROVABLE_OUTCOMES`, then SEC-AI-4 (acknowledgeable).
 *              A policy refusal is RETURNED, never thrown, so the committed evaluation survives (DA-A-14 pattern).
 *   get      — N6: the packet with the bound evaluation's `boundFacts` (the values the approval was made on).
 *
 * Legacy handling (N3): once a claim's opportunity is superseded, a packet binds only the claim version, amount and
 * attachments (no evaluation), renders from the last recorded evaluation, and skips the outcome check — the same
 * rule `drafts.prepareSend` applies to a superseded email claim.
 */
import { ConvexError, v, type Infer } from "convex/values";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import schema, { approvalBinding, boundFactValue, deadlineResult } from "./schema";
import { assertSameTransaction, ownedClaim, ownedEvidence, ownedPacket, requireUserId } from "./lib/access";
import { boundFactsHash, canonicalHash } from "./lib/canonical";
import { isClosedForAsk } from "./lib/claimState";
import { rateLimiter } from "./lib/rateLimits";
import { stripControl } from "./lib/text";
import { isApprovable } from "./lib/rules/types";
import {
  factReader,
  MAX_PACKET_BODY_CHARS,
  MAX_PACKET_EVIDENCE,
  MAX_RECIPIENT_CHARS,
  MAX_REQUESTED_REMEDY_CHARS,
  packetFindings,
  PacketRenderError,
  type ManualChannel,
  type PacketContext,
} from "./lib/packets/common";
import { templateById, templateFor } from "./lib/packets/index";
import { evaluateTransaction } from "./opportunities";

export type ApprovalBinding = Infer<typeof approvalBinding>;
type Packet = Doc<"packets">;
type Claim = Doc<"claims">;

/** Packet versions and submissions read per claim (a handful per case; bounded). */
export const PACKETS_PER_CLAIM = 50;
const MAX_LABEL_CHARS = 120;

const EXAMPLE_MESSAGE = "Examples never produce real packets.";
const RULE_WITHDRAWN_MESSAGE =
  "Recoup's automatic checks for this kind of claim were withdrawn. Review the packet and approve it again.";

// ---------------------------------------------------------------------------
// Shared with submissions.ts
// ---------------------------------------------------------------------------

export type PacketLink = { opportunity: Doc<"opportunities">; evaluation: Doc<"evaluations"> } | null;

/** The claim's live link — its opportunity (the claim's own, not superseded) and current evaluation — or null (legacy). */
export async function liveLink(ctx: QueryCtx | MutationCtx, claim: Claim): Promise<PacketLink> {
  if (!claim.opportunityId) return null;
  const opportunity = await ctx.db.get(claim.opportunityId);
  if (!opportunity || opportunity.userId !== claim.userId || opportunity.status === "superseded") return null;
  const evaluation = opportunity.currentEvaluationId ? await ctx.db.get(opportunity.currentEvaluationId) : null;
  if (!evaluation || evaluation.userId !== claim.userId) return null;
  return { opportunity, evaluation };
}

/**
 * Re-evaluates the claim's subject (`approval_check`) and COMMITS it — any material version bump and note (§2.8) and
 * an N3 supersession. Returns `"rule_withdrawn"` only for the call that finds the claim's pack withdrawn (its
 * opportunity was live and is superseded now); later calls see a superseded opportunity and take the legacy path.
 */
export async function reevaluateForPacket(ctx: MutationCtx, claim: Claim, now: number): Promise<"rule_withdrawn" | null> {
  if (!claim.opportunityId) return null;
  const before = await ctx.db.get(claim.opportunityId);
  if (!before || before.userId !== claim.userId || before.status === "superseded") return null;
  await evaluateTransaction(ctx, before.transactionId, "approval_check", now, { subjects: [before.subjectKey] });
  const after = await ctx.db.get(before._id);
  return after?.status === "superseded" ? "rule_withdrawn" : null;
}

/**
 * The approval binding of a packet (§2.4): the claim version, its amount, the bound evaluation's rule/engine version
 * and bound-fact hash (live link only) and the evidence content hashes. `contextHash` hashes VALUES only (DA-A-15):
 * the evidence enters by content hash, never by row id. Any material change bumps `claims.version` and breaks it.
 */
export async function packetBinding(
  claim: Claim,
  link: PacketLink,
  evidenceIndex: readonly { evidenceId: Id<"evidence">; contentHash: string }[],
): Promise<ApprovalBinding> {
  if (!claim.currency) throw new ConvexError("This claim's currency is unknown");
  const amount = { amountMinor: claim.expectedCents, currency: claim.currency };
  const attachments = evidenceIndex.map((e) => ({ evidenceId: e.evidenceId, contentHash: e.contentHash }));
  const ev = link?.evaluation ?? null;
  const bfh = ev ? await boundFactsHash(ev.boundFacts ?? []) : null;
  const contextHash = await canonicalHash({
    v: 1,
    claimVersion: claim.version,
    amount,
    ruleId: ev?.ruleId ?? null,
    ruleVersion: ev?.ruleVersion ?? null,
    engineVersion: ev?.engineVersion ?? null,
    boundFactsHash: bfh,
    attachments: attachments.map((a) => a.contentHash).sort(),
  });
  return {
    contextHash,
    claimVersion: claim.version,
    amount,
    ...(link && ev
      ? {
          opportunityId: link.opportunity._id,
          evaluationId: ev._id,
          ruleId: ev.ruleId,
          ruleVersion: ev.ruleVersion,
          ...(ev.engineVersion !== undefined ? { engineVersion: ev.engineVersion } : {}),
          ...(bfh !== null ? { boundFactsHash: bfh } : {}),
        }
      : {}),
    attachments,
  };
}

/** The hash the user approves: exactly what is shown (DA-A-15 values), plus the binding's context. */
export async function renderedHash(
  p: Pick<Packet, "version" | "channel" | "recipient" | "body" | "requestedRemedy" | "evidenceIndex" | "binding">,
): Promise<string> {
  return await canonicalHash({
    v: 1,
    version: p.version,
    channel: p.channel,
    recipient: { text: p.recipient.text, source: p.recipient.source },
    body: p.body,
    requestedRemedy: p.requestedRemedy,
    evidence: p.evidenceIndex.map((e) => ({ contentHash: e.contentHash, label: e.label })),
    contextHash: p.binding.contextHash,
  });
}

/** A claim that takes packets: a required manual channel. */
function manualChannelOf(claim: Claim): ManualChannel | null {
  const c = claim.requiredChannel;
  return c === undefined || c === "email" ? null : c;
}

async function packetsOf(ctx: QueryCtx | MutationCtx, claimId: Id<"claims">): Promise<Packet[]> {
  return await ctx.db.query("packets").withIndex("by_claim", (q) => q.eq("claimId", claimId)).order("desc").take(PACKETS_PER_CLAIM);
}

/** Supersedes every live (draft or approved) version before a new one is written; recorded ones stay history. */
async function supersedeLive(ctx: MutationCtx, claimId: Id<"claims">, now: number): Promise<number> {
  const all = await packetsOf(ctx, claimId);
  for (const p of all) {
    if (p.status === "draft" || p.status === "approved") await ctx.db.patch(p._id, { status: "superseded", supersededAt: now });
  }
  return all.reduce((m, p) => Math.max(m, p.version), 0);
}

/** Keeps newlines (a letter has paragraphs, an address has lines) but strips every other control character. */
function stripControlKeepLines(s: string): string {
  return s.replace(/\r\n/g, "\n").split("\n").map(stripControl).join("\n");
}

/** Bounded text: control characters out (newlines kept only when `multiline`), trimmed, length-capped. */
function boundedText(s: string, label: string, max: number, opts: { allowEmpty?: boolean; multiline?: boolean } = {}): string {
  const t = (opts.multiline ? stripControlKeepLines(s) : stripControl(s.replace(/[\r\n]+/g, " "))).trim();
  if (!opts.allowEmpty && t.length === 0) throw new ConvexError(`${label} must not be empty`);
  if (t.length > max) throw new ConvexError(`${label} is longer than ${max} characters`);
  return t;
}

function cleanBody(s: string): string {
  const t = stripControlKeepLines(s).trim();
  if (t.length === 0) throw new ConvexError("The packet text must not be empty");
  if (t.length > MAX_PACKET_BODY_CHARS) throw new ConvexError(`The packet text is longer than ${MAX_PACKET_BODY_CHARS} characters`);
  return t;
}

/**
 * SEC-AI-4 for one packet version: the verbatim text blocks of the template its text came from (kept across edits;
 * none → no exemptions), the claim's ask and the given bound facts allowed.
 */
function findingsFor(packet: Packet, claim: Claim, boundFacts: readonly Infer<typeof boundFactValue>[]): string[] {
  const t = packet.templateId !== undefined ? templateById(packet.templateId) : null;
  const ctx = { amount: { amountMinor: claim.expectedCents, currency: claim.currency ?? "" }, boundFacts };
  const text = `${packet.body}\n${packet.requestedRemedy}`;
  return packetFindings(text, ctx, t ?? { textBlocks: [] }, packet.recipient.text || null);
}

async function findingsHashOf(packet: Packet, findings: readonly string[]): Promise<string> {
  return await canonicalHash({ v: 1, findings: [...findings].sort(), packetVersion: packet.version, body: packet.body, requestedRemedy: packet.requestedRemedy });
}

/** The evaluation a packet renders from: the live one, else (legacy, N3) the opportunity's last recorded one. */
async function renderSource(ctx: MutationCtx, claim: Claim, link: PacketLink): Promise<Doc<"evaluations"> | null> {
  if (link) return link.evaluation;
  if (!claim.opportunityId) return null;
  const opp = await ctx.db.get(claim.opportunityId);
  if (!opp || opp.userId !== claim.userId || !opp.currentEvaluationId) return null;
  const ev = await ctx.db.get(opp.currentEvaluationId);
  return ev && ev.userId === claim.userId ? ev : null;
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

const factKey = v.object({ subjectKey: v.string(), key: v.string() });

const prepareResult = v.union(
  v.object({ ok: v.literal(true), packetId: v.id("packets"), findings: v.array(v.string()) }),
  v.object({
    ok: v.literal(false),
    code: v.union(
      v.literal("example_claim"), v.literal("not_manual"), v.literal("closed"), v.literal("rate_limited"),
      v.literal("rule_withdrawn"), v.literal("outcome_not_approvable"), v.literal("no_template"), v.literal("confirm_facts"),
    ),
    message: v.string(),
    keys: v.optional(v.array(factKey)),
  }),
);
type PrepareResult = Infer<typeof prepareResult>;

/**
 * Writes a new packet version from the claim's pack template. Owner and example checks first (identical not-found for
 * a foreign or missing id; nothing written), then the per-user `evaluate` limit, then a COMMITTED re-evaluation.
 */
export const prepare = mutation({
  args: { claimId: v.id("claims"), templateId: v.optional(v.string()) },
  returns: prepareResult,
  handler: async (ctx, args): Promise<PrepareResult> => {
    const userId = await requireUserId(ctx);
    const claim = await ownedClaim(ctx, args.claimId, userId);
    if (claim.isExample) return { ok: false, code: "example_claim", message: EXAMPLE_MESSAGE };
    const channel = manualChannelOf(claim);
    if (!channel) return { ok: false, code: "not_manual", message: "This claim is sent by email, not as a packet." };
    if (isClosedForAsk(claim)) return { ok: false, code: "closed", message: "This claim is closed." };
    const limit = await rateLimiter.limit(ctx, "evaluate", { key: userId });
    if (!limit.ok) return { ok: false, code: "rate_limited", message: "Too many checks in a short time. Try again in a minute." };
    const now = Date.now();
    if ((await reevaluateForPacket(ctx, claim, now)) === "rule_withdrawn") {
      return { ok: false, code: "rule_withdrawn", message: RULE_WITHDRAWN_MESSAGE };
    }
    const fresh = (await ctx.db.get(claim._id))!;
    const link = await liveLink(ctx, fresh);
    if (link && !isApprovable(link.evaluation.outcome)) {
      return { ok: false, code: "outcome_not_approvable", message: `A packet cannot be prepared while the result is ${link.evaluation.outcome}.` };
    }
    const source = await renderSource(ctx, fresh, link);
    const template = source ? templateFor(source.ruleId, source.ruleVersion, args.templateId) : null;
    if (!source || !template || !template.channels.includes(channel)) {
      return { ok: false, code: "no_template", message: "Recoup has no letter for this claim yet; write it yourself." };
    }
    const pctx: PacketContext = {
      scenarioId: source.scenarioId,
      ruleId: source.ruleId,
      ruleVersion: source.ruleVersion,
      amount: { amountMinor: fresh.expectedCents, currency: fresh.currency ?? "" },
      boundFacts: source.boundFacts ?? [],
      deadlines: source.deadlines,
      claimToken: fresh.token,
      channel,
    };
    let draft;
    try {
      draft = template.compose(pctx, factReader(pctx.boundFacts));
    } catch (error) {
      if (error instanceof PacketRenderError) {
        return {
          ok: false,
          code: "confirm_facts",
          message: `Confirm ${error.key} before Recoup can write this packet.`,
          keys: [{ subjectKey: error.subjectKey, key: error.key }],
        };
      }
      throw error;
    }
    const version = (await supersedeLive(ctx, fresh._id, now)) + 1;
    const body = cleanBody(draft.body);
    const requestedRemedy = boundedText(draft.requestedRemedy, "The requested remedy", MAX_REQUESTED_REMEDY_CHARS);
    const recipient = draft.recipient
      ? { text: boundedText(draft.recipient.text, "The recipient", MAX_RECIPIENT_CHARS, { allowEmpty: true, multiline: true }), source: draft.recipient.source }
      : { text: "", source: "user_entered" as const };
    const packetId = await ctx.db.insert("packets", {
      userId,
      claimId: fresh._id,
      version,
      channel,
      recipient,
      body,
      requestedRemedy,
      evidenceIndex: [],
      binding: await packetBinding(fresh, link, []),
      status: "draft",
      templateId: template.templateId,
    });
    const packet = (await ctx.db.get(packetId))!;
    return { ok: true, packetId, findings: findingsFor(packet, fresh, pctx.boundFacts) };
  },
});

/**
 * The user's edits as a new version of the NEWEST packet: body, requested remedy, recipient (their own entry, or one
 * they read from a document they own) and the evidence index (≤ 25 of their own active evidence rows on this claim's
 * transaction, pinned by content hash). The binding is recomputed; nothing is approved.
 */
export const update = mutation({
  args: {
    packetId: v.id("packets"),
    body: v.optional(v.string()),
    requestedRemedy: v.optional(v.string()),
    recipient: v.optional(v.object({
      text: v.string(),
      source: v.union(v.literal("user_entered"), v.literal("user_entered_from_document")),
      evidenceId: v.optional(v.id("evidence")),
    })),
    evidence: v.optional(v.array(v.object({ evidenceId: v.id("evidence"), label: v.string() }))),
  },
  returns: v.id("packets"),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const packet = await ownedPacket(ctx, args.packetId, userId);
    const claim = await ownedClaim(ctx, packet.claimId, userId);
    if (isClosedForAsk(claim)) throw new ConvexError("This claim is closed");
    const newest = (await packetsOf(ctx, claim._id))[0];
    if (!newest || newest._id !== packet._id || packet.status === "superseded") throw new ConvexError("Edit the newest version of this packet");
    const body = args.body !== undefined ? cleanBody(args.body) : packet.body;
    const requestedRemedy = args.requestedRemedy !== undefined
      ? boundedText(args.requestedRemedy, "The requested remedy", MAX_REQUESTED_REMEDY_CHARS)
      : packet.requestedRemedy;
    let recipient = packet.recipient;
    if (args.recipient) {
      const text = boundedText(args.recipient.text, "The recipient", MAX_RECIPIENT_CHARS, { multiline: true });
      if (args.recipient.source === "user_entered_from_document") {
        if (!args.recipient.evidenceId) throw new ConvexError("Say which document the recipient comes from");
        const ev = await ownedEvidence(ctx, args.recipient.evidenceId, userId);
        if (claim.transactionId) assertSameTransaction(claim.transactionId, ev, { allowUnlinked: true, label: "That document" });
        recipient = { text, source: "user_entered_from_document", evidenceId: ev._id };
      } else {
        recipient = { text, source: "user_entered" };
      }
    }
    let evidenceIndex = packet.evidenceIndex;
    if (args.evidence) {
      if (args.evidence.length > MAX_PACKET_EVIDENCE) throw new ConvexError(`At most ${MAX_PACKET_EVIDENCE} documents per packet`);
      const seen = new Set<string>();
      evidenceIndex = [];
      for (const e of args.evidence) {
        if (seen.has(e.evidenceId)) continue;
        seen.add(e.evidenceId);
        const ev = await ownedEvidence(ctx, e.evidenceId, userId);
        if (ev.retention !== "active") throw new ConvexError("A document in the packet no longer has its content");
        if (claim.transactionId) assertSameTransaction(claim.transactionId, ev, { allowUnlinked: true, label: "That document" });
        evidenceIndex.push({ evidenceId: ev._id, contentHash: ev.contentHash, label: boundedText(e.label, "A document label", MAX_LABEL_CHARS) });
      }
    }
    const now = Date.now();
    const version = (await supersedeLive(ctx, claim._id, now)) + 1;
    return await ctx.db.insert("packets", {
      userId,
      claimId: claim._id,
      version,
      channel: packet.channel,
      recipient,
      body,
      requestedRemedy,
      evidenceIndex,
      binding: await packetBinding(claim, await liveLink(ctx, claim), evidenceIndex),
      status: "draft",
      // The text still comes from that template (edited or not): its verbatim blocks stay exempt from SEC-AI-4.
      ...(packet.templateId !== undefined ? { templateId: packet.templateId } : {}),
    });
  },
});

const approveResult = v.union(
  v.object({ ok: v.literal(true) }),
  v.object({
    ok: v.literal(false),
    code: v.union(
      v.literal("example_claim"), v.literal("closed"), v.literal("not_newest"), v.literal("hash_mismatch"),
      v.literal("rate_limited"), v.literal("rule_withdrawn"), v.literal("binding_changed"), v.literal("no_recipient"),
      v.literal("evidence_changed"), v.literal("outcome_not_approvable"), v.literal("unverified_content"),
    ),
    message: v.string(),
    findings: v.optional(v.array(v.string())),
    findingsHash: v.optional(v.string()),
  }),
);
type ApproveResult = Infer<typeof approveResult>;

/**
 * The user approves exactly the packet they were shown (§6 "Manual approval"). See the module header for the check
 * order. On success the version is `approved` with `approvedAt` and `approvedHash`; the claim's delivery becomes
 * `packet_prepared` (derived). Nothing is sent.
 */
export const approve = mutation({
  args: {
    packetId: v.id("packets"),
    approvedHash: v.string(),
    acknowledgeUnverifiedContent: v.optional(v.boolean()),
    acknowledgedFindingsHash: v.optional(v.string()),
  },
  returns: approveResult,
  handler: async (ctx, args): Promise<ApproveResult> => {
    const userId = await requireUserId(ctx);
    const packet = await ownedPacket(ctx, args.packetId, userId);
    const claim = await ownedClaim(ctx, packet.claimId, userId);
    if (claim.isExample) return { ok: false, code: "example_claim", message: EXAMPLE_MESSAGE };
    if (isClosedForAsk(claim)) return { ok: false, code: "closed", message: "This claim is closed." };
    const newest = (await packetsOf(ctx, claim._id))[0];
    if (!newest || newest._id !== packet._id || packet.status !== "draft") {
      return { ok: false, code: "not_newest", message: "Approve the newest version of this packet." };
    }
    if (args.approvedHash !== (await renderedHash(packet))) {
      return { ok: false, code: "hash_mismatch", message: "The packet changed since you reviewed it; review it again." };
    }
    const limit = await rateLimiter.limit(ctx, "evaluate", { key: userId });
    if (!limit.ok) return { ok: false, code: "rate_limited", message: "Too many checks in a short time. Try again in a minute." };
    const now = Date.now();
    if ((await reevaluateForPacket(ctx, claim, now)) === "rule_withdrawn") {
      return { ok: false, code: "rule_withdrawn", message: RULE_WITHDRAWN_MESSAGE };
    }
    const fresh = (await ctx.db.get(claim._id))!;
    const link = await liveLink(ctx, fresh);
    const current = await packetBinding(fresh, link, packet.evidenceIndex);
    if (current.contextHash !== packet.binding.contextHash) {
      return { ok: false, code: "binding_changed", message: "The claim changed since this packet was written; prepare it again." };
    }
    if (packet.recipient.text.trim().length === 0) {
      return { ok: false, code: "no_recipient", message: "Add who the packet goes to before approving it." };
    }
    for (const e of packet.evidenceIndex) {
      const ev = await ctx.db.get(e.evidenceId);
      if (!ev || ev.userId !== userId || ev.retention !== "active" || ev.contentHash !== e.contentHash) {
        return { ok: false, code: "evidence_changed", message: `"${e.label}" changed or is no longer available; update the packet.` };
      }
    }
    if (link && !isApprovable(link.evaluation.outcome)) {
      return { ok: false, code: "outcome_not_approvable", message: `A packet cannot be approved while the result is ${link.evaluation.outcome}.` };
    }
    const findings = findingsFor(packet, fresh, (await renderSource(ctx, fresh, link))?.boundFacts ?? []);
    if (findings.length > 0) {
      const findingsHash = await findingsHashOf(packet, findings);
      if (!(args.acknowledgeUnverifiedContent === true && args.acknowledgedFindingsHash === findingsHash)) {
        return {
          ok: false,
          code: "unverified_content",
          message: "The packet states details Recoup did not supply. Check them, then confirm.",
          findings,
          findingsHash,
        };
      }
    }
    await ctx.db.patch(packet._id, { status: "approved", approvedAt: now, approvedHash: args.approvedHash });
    await ctx.db.insert("claimNotes", {
      claimId: claim._id, userId, kind: "status", text: `Packet v${packet.version} approved (${packet.channel}); send it yourself, then record it.`,
    });
    return { ok: true };
  },
});

const packetView = v.object({
  packet: schema.doc("packets"),
  /** N6: the values the binding's evaluation was made on; null for a legacy (unbound) packet. */
  boundFacts: v.union(v.array(boundFactValue), v.null()),
  outcome: v.union(schema.tables.evaluations.validator.fields.outcome, v.null()),
  /** The bound evaluation's deadlines, so a recorded `submittedAt` shows against the user deadline. */
  deadlines: v.array(deadlineResult),
  renderedHash: v.string(),
  submissions: v.array(schema.doc("submissions")),
});

/** One packet with its bound evaluation's facts (N6) and its recorded submissions. Identical not-found for foreign ids. */
export const get = query({
  args: { packetId: v.id("packets") },
  returns: packetView,
  handler: async (ctx, { packetId }) => {
    const userId = await requireUserId(ctx);
    const packet = await ownedPacket(ctx, packetId, userId);
    const ev = packet.binding.evaluationId ? await ctx.db.get(packet.binding.evaluationId) : null;
    const evaluation = ev && ev.userId === userId ? ev : null;
    const submissions = (
      await ctx.db.query("submissions").withIndex("by_packet", (q) => q.eq("packetId", packet._id)).take(PACKETS_PER_CLAIM)
    ).filter((s) => s.userId === userId);
    return {
      packet,
      boundFacts: evaluation ? (evaluation.boundFacts ?? []) : null,
      outcome: evaluation?.outcome ?? null,
      deadlines: evaluation?.deadlines ?? [],
      renderedHash: await renderedHash(packet),
      submissions,
    };
  },
});

/** Every packet version of a claim, newest first, and its recorded submissions (bounded). */
export const listForClaim = query({
  args: { claimId: v.id("claims") },
  returns: v.object({ packets: v.array(schema.doc("packets")), submissions: v.array(schema.doc("submissions")) }),
  handler: async (ctx, { claimId }) => {
    const userId = await requireUserId(ctx);
    const claim = await ownedClaim(ctx, claimId, userId);
    const packets = (await packetsOf(ctx, claim._id)).filter((p) => p.userId === userId);
    const submissions = (
      await ctx.db.query("submissions").withIndex("by_claim", (q) => q.eq("claimId", claim._id)).order("desc").take(PACKETS_PER_CLAIM)
    ).filter((s) => s.userId === userId);
    return { packets, submissions };
  },
});
