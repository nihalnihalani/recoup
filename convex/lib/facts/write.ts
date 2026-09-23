/**
 * The single writer of `facts` (contract §2.5, O2): `putFact` is the only code that inserts into the table
 * (`facts.test.ts` greps for any other `insert("facts"`). It also owns the two bounded readers of live rows,
 * both on `facts.by_transaction_and_state_and_subject_key_and_key`, so superseded history is never scanned.
 *
 * putFact, in order — every check runs before the first write:
 *   1. tombstone gate; `ownedTransaction` (identical not-found); archived transactions take no new facts;
 *   2. the key is catalogued for the transaction's category; the subject parses, is of a kind the key allows, and
 *      an item/incident subject belongs to THIS transaction (item.purchaseId === txn.purchaseId; incident via
 *      `assertSameTransaction`) — a foreign or cross-transaction id gets the same not-found as a missing one;
 *   3. state ↔ source: user_confirmed ← user | evidence (only for a user-assertable key; the only state that may
 *      say "I don't know"); extracted_candidate ← evidence; observed ← price_check | evidence; derived ← derived;
 *   4. the source: cited evidence is owned and belongs to this transaction or is unlinked (linked on cite) —
 *      evidence from another of the user's transactions is refused (DA-A-29); `unverified_sender` evidence yields
 *      candidates only (SEC-AI-6); a price check is the user's, on this transaction's item, for this subject;
 *      derived inputs are ≤ 8 facts of this transaction;
 *   5. the value (`lib/facts/values.ts`): kind, domain, codes; user money capped (`assertUserAmount`); text masked
 *      (D142 — never refused); identifiers validated by their own scheme, never masked;
 *   6. supersede rules — a new user_confirmed supersedes the cell's live confirmed rows and candidates, and its
 *      observed rows only with `overridesObserved`; a CHANGED observation supersedes older observations, an
 *      UNCHANGED one patches `lastObservedAt` and inserts nothing (DA-A-36); a new derived supersedes older derived
 *      rows; a candidate supersedes nothing. Re-stating an identical value that would supersede nothing new is a
 *      no-op, so re-submitting a form does not grow the table;
 *   7. the live cap (`MAX_LIVE_FACTS_PER_TRANSACTION`) counts non-superseded rows only (`transactions.liveFactCount`,
 *      maintained here), so a correction — which supersedes as much as it adds — is always accepted (DA-A-36).
 */
import { ConvexError, type Infer } from "convex/values";
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import type { factSource } from "../../schema";
import { MAX_LIVE_FACTS_PER_TRANSACTION, MAX_LOCATOR_QUOTE_CHARS } from "../../limits";
import { assertSameTransaction, ownedEvidence, ownedFact, ownedIncident, ownedTransaction } from "../access";
import { isTombstoned } from "../accountState";
import { maskPans } from "../pan";
import { countsTowardEvidence } from "../quote";
import { getFactSpec, type FactSpec, type FactValue } from "./catalog";
import { parseSubjectKey } from "./subject";
import { sameFactValue, validateFactValue } from "./values";
import type { CellSource, FactRowState, ResolveRow } from "./resolve";

export type FactSource = Infer<typeof factSource>;
/** The states a caller may write. `superseded` is set only here; `rejected` has no writer in wave 1. */
export type WritableState = "observed" | "extracted_candidate" | "user_confirmed" | "derived";
export const LIVE_STATES = ["observed", "extracted_candidate", "user_confirmed", "derived"] as const satisfies readonly WritableState[];

export interface PutFactInput {
  transactionId: Id<"transactions">;
  subjectKey: string;
  key: string;
  state: WritableState;
  value: FactValue;
  source: FactSource;
  /** user_confirmed only: this answer deliberately replaces what the system observed. */
  overridesObserved?: boolean;
}

export type PutFactResult = {
  factId: Id<"facts">;
  /** inserted: a new row; patched: an unchanged observation refreshed `lastObservedAt`; unchanged: nothing written. */
  outcome: "inserted" | "patched" | "unchanged";
};

/** Derived facts cite at most this many inputs (schema `factSource.derived.fromFactIds` ≤ 8). */
export const MAX_DERIVED_INPUTS = 8;
const MAX_TAG_CHARS = 64;

const SOURCES_FOR_STATE: Record<WritableState, ReadonlyArray<FactSource["kind"]>> = {
  user_confirmed: ["user", "evidence"],
  extracted_candidate: ["evidence"],
  observed: ["price_check", "evidence"],
  derived: ["derived"],
};

type Ctx = QueryCtx | MutationCtx;

/** A cell's live rows of one state (bounded: live rows are capped per transaction). */
function liveRowsOf(ctx: Ctx, transactionId: Id<"transactions">, state: WritableState, subjectKey: string, key: string) {
  return ctx.db
    .query("facts")
    .withIndex("by_transaction_and_state_and_subject_key_and_key", (q) =>
      q.eq("transactionId", transactionId).eq("state", state).eq("subjectKey", subjectKey).eq("key", key),
    )
    .take(MAX_LIVE_FACTS_PER_TRANSACTION);
}

/** The live (non-superseded, non-rejected) rows of one cell, oldest first. Four index ranges, never history. */
export async function readCellRows(
  ctx: Ctx,
  transactionId: Id<"transactions">,
  subjectKey: string,
  key: string,
): Promise<Doc<"facts">[]> {
  const parts = await Promise.all(LIVE_STATES.map((s) => liveRowsOf(ctx, transactionId, s, subjectKey, key)));
  return parts.flat().sort((a, b) => a._creationTime - b._creationTime);
}

/** Every live fact row of a transaction, oldest first. Four index ranges, bounded by the live cap. */
export async function readLiveFacts(ctx: Ctx, transactionId: Id<"transactions">): Promise<Doc<"facts">[]> {
  const parts = await Promise.all(
    LIVE_STATES.map((state) =>
      ctx.db
        .query("facts")
        .withIndex("by_transaction_and_state_and_subject_key_and_key", (q) =>
          q.eq("transactionId", transactionId).eq("state", state),
        )
        .take(MAX_LIVE_FACTS_PER_TRANSACTION),
    ),
  );
  return parts.flat().sort((a, b) => a._creationTime - b._creationTime);
}

/** A stored row as resolution sees it. Sources become display refs; ids never reach a hash (DA-A-15). */
export function toResolveRow(row: Doc<"facts">): ResolveRow {
  const s = row.source;
  const source: CellSource =
    s.kind === "user" ? { kind: "user" }
    : s.kind === "evidence" ? { kind: "evidence", ref: s.evidenceId }
    : s.kind === "price_check" ? { kind: "price_check", ref: s.priceCheckId }
    : { kind: "derived", ref: s.ruleId };
  return {
    state: row.state as FactRowState,
    value: row.value,
    at: row.state === "observed" ? (row.lastObservedAt ?? row.recordedAt) : row.recordedAt,
    source,
    ...(row.overridesObserved ? { overridesObserved: true } : {}),
  };
}

function refuse(message: string): never {
  throw new ConvexError(message);
}

async function checkSubject(
  ctx: MutationCtx,
  txn: Doc<"transactions">,
  spec: FactSpec,
  subjectKey: string,
  userId: Id<"users">,
): Promise<void> {
  const subject = parseSubjectKey(subjectKey);
  if (subject === null) refuse("Unknown fact subject");
  if (!spec.subject.includes(subject.kind)) refuse(`${spec.key} is not recorded against a ${subject.kind}`);
  if (subject.kind === "item") {
    const itemId = ctx.db.normalizeId("items", subject.id);
    const item = itemId === null ? null : await ctx.db.get(itemId);
    // Identical not-found for a missing item, another user's item and another purchase's item (DA-A-29).
    if (!item || item.userId !== userId || txn.purchaseId === undefined || item.purchaseId !== txn.purchaseId) {
      refuse("Item not found");
    }
  } else if (subject.kind === "incident") {
    const incidentId = ctx.db.normalizeId("incidents", subject.id);
    if (incidentId === null) refuse("Incident not found");
    const incident = await ownedIncident(ctx, incidentId, userId);
    assertSameTransaction(txn._id, incident, { label: "Incident" });
  }
}

/** Checks the cited source; returns the evidence row to link on cite, if any. Writes nothing. */
async function checkSource(
  ctx: MutationCtx,
  txn: Doc<"transactions">,
  input: PutFactInput,
  userId: Id<"users">,
): Promise<{ source: FactSource; linkEvidence: Id<"evidence"> | null }> {
  const { source, state } = input;
  if (!SOURCES_FOR_STATE[state].includes(source.kind)) refuse(`A ${state} fact cannot come from a ${source.kind} source`);
  switch (source.kind) {
    case "user":
      return { source: { kind: "user" }, linkEvidence: null };
    case "evidence": {
      const ev = await ownedEvidence(ctx, source.evidenceId, userId);
      // DA-A-29: evidence from another of this user's transactions is refused; unlinked evidence is linked on cite.
      const link = assertSameTransaction(txn._id, ev, { allowUnlinked: true, label: "Evidence" });
      // SEC-AI-6: content from an unverified sender never becomes more than a candidate.
      if (ev.provenance === "unverified_sender" && state !== "extracted_candidate") {
        refuse("A fact from an unverified sender can only be a candidate");
      }
      // DA-A-6 (M23): an `observed` fact satisfies rule conditions (SEC-AI-3), so a document may back one only through
      // a VERIFIED quote. An unverified or unverifiable citation (an image, an image-only PDF, a quote not found at its
      // locator) stays a candidate and never counts toward a rule's evidenceSupports.
      if (state === "observed" && !countsTowardEvidence(source.quoteStatus)) {
        refuse("A document can back an observed fact only through a verified quote");
      }
      const extractorVersion = source.extractorVersion.trim();
      if (extractorVersion.length === 0 || extractorVersion.length > MAX_TAG_CHARS) refuse("Invalid extractor version");
      return {
        source: { ...source, extractorVersion, locator: checkLocator(source.locator) },
        linkEvidence: link === "unlinked" ? ev._id : null,
      };
    }
    case "price_check": {
      const pc = await ctx.db.get(source.priceCheckId);
      const item = pc && pc.userId === userId ? await ctx.db.get(pc.itemId) : null;
      if (!pc || !item || txn.purchaseId === undefined || item.purchaseId !== txn.purchaseId) {
        refuse("Price check not found");
      }
      if (input.subjectKey !== `item:${pc.itemId}`) refuse("A price check can only state a fact about its own item");
      return { source: { kind: "price_check", priceCheckId: pc._id }, linkEvidence: null };
    }
    case "derived": {
      const ruleId = source.ruleId.trim();
      if (ruleId.length === 0 || ruleId.length > MAX_TAG_CHARS) refuse("Invalid rule id");
      if (source.fromFactIds.length === 0 || source.fromFactIds.length > MAX_DERIVED_INPUTS) {
        refuse(`A derived fact cites 1 to ${MAX_DERIVED_INPUTS} facts`);
      }
      for (const id of source.fromFactIds) {
        const f = await ownedFact(ctx, id, userId);
        assertSameTransaction(txn._id, f, { label: "Fact" });
      }
      return { source: { kind: "derived", ruleId, fromFactIds: source.fromFactIds }, linkEvidence: null };
    }
  }
}

type Locator = Extract<FactSource, { kind: "evidence" }>["locator"];

/** Locator bounds; quotes are masked like any free text (D142) and capped at 300 characters. */
function checkLocator(locator: Locator): Locator {
  const quote = (q: string) => {
    const masked = maskPans(q);
    if (masked.length > MAX_LOCATOR_QUOTE_CHARS) refuse(`A quote must be at most ${MAX_LOCATOR_QUOTE_CHARS} characters`);
    return masked;
  };
  switch (locator.kind) {
    case "text_span":
      if (!Number.isSafeInteger(locator.start) || !Number.isSafeInteger(locator.end) || locator.start < 0 || locator.end < locator.start) {
        refuse("Invalid text span");
      }
      return { kind: "text_span", start: locator.start, end: locator.end, quote: quote(locator.quote) };
    case "pdf_page":
      if (!Number.isSafeInteger(locator.page) || locator.page < 1) refuse("Invalid page number");
      return locator.quote === undefined
        ? { kind: "pdf_page", page: locator.page }
        : { kind: "pdf_page", page: locator.page, quote: quote(locator.quote) };
    case "email_header":
    case "whole_document":
      return locator;
  }
}

function sameSource(a: FactSource, b: FactSource): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export async function putFact(ctx: MutationCtx, userId: Id<"users">, input: PutFactInput): Promise<PutFactResult> {
  // 1. Who and which transaction.
  if (await isTombstoned(ctx, userId)) refuse("This account has been deleted");
  const txn = await ownedTransaction(ctx, input.transactionId, userId);
  if (txn.status === "archived") refuse("This transaction is archived");

  // 2. Key and subject.
  const spec = getFactSpec(input.key);
  if (spec === null) refuse(`Unknown fact key ${input.key.slice(0, MAX_TAG_CHARS)}`);
  if (!spec.categories.includes(txn.category)) refuse(`${spec.key} does not apply to a ${txn.category} transaction`);
  await checkSubject(ctx, txn, spec, input.subjectKey, userId);

  // 3. State rules.
  const { state } = input;
  if (!(LIVE_STATES as readonly string[]).includes(state)) refuse(`A fact cannot be written as ${state}`);
  if (state === "user_confirmed" && !spec.userAssertable) refuse(`${spec.key} is not something you can confirm`);
  if (input.overridesObserved && state !== "user_confirmed") refuse("Only your own answer can override an observation");

  // 4. Source.
  const { source, linkEvidence } = await checkSource(ctx, txn, input, userId);

  // 5. Value.
  const value: FactValue =
    input.value.kind === "user_unknown"
      ? state === "user_confirmed"
        ? { kind: "user_unknown" }
        : refuse(`Only your own answer can be "I don't know"`)
      : validateFactValue(spec, input.value, { userSource: source.kind === "user" });

  // 6. Supersede rules over the cell's live rows (four bounded index ranges).
  const now = Date.now();
  const live = await readCellRows(ctx, txn._id, input.subjectKey, spec.key);
  const liveOf = (s: WritableState) => live.filter((r) => r.state === s);
  const overrides = state === "user_confirmed" && input.overridesObserved === true;
  let toSupersede: Doc<"facts">[] = [];
  switch (state) {
    case "user_confirmed": {
      toSupersede = [...liveOf("user_confirmed"), ...liveOf("extracted_candidate"), ...(overrides ? liveOf("observed") : [])];
      const current = liveOf("user_confirmed").at(-1);
      const nothingNew = toSupersede.every((r) => r._id === current?._id);
      if (
        current !== undefined && nothingNew && sameFactValue(current.value, value) &&
        sameSource(current.source, source) && (current.overridesObserved === true) === overrides
      ) {
        return { factId: current._id, outcome: "unchanged" };
      }
      break;
    }
    case "observed": {
      const same = liveOf("observed").find((r) => sameFactValue(r.value, value));
      if (same !== undefined) {
        // DA-A-36: an unchanged observation refreshes its row instead of growing the table.
        await ctx.db.patch(same._id, { lastObservedAt: now });
        return { factId: same._id, outcome: "patched" };
      }
      toSupersede = liveOf("observed");
      break;
    }
    case "derived": {
      const current = liveOf("derived").at(-1);
      if (current !== undefined && liveOf("derived").length === 1 && sameFactValue(current.value, value) && sameSource(current.source, source)) {
        return { factId: current._id, outcome: "unchanged" };
      }
      toSupersede = liveOf("derived");
      break;
    }
    case "extracted_candidate": {
      const dup = liveOf("extracted_candidate").find((r) => sameFactValue(r.value, value) && sameSource(r.source, source));
      if (dup !== undefined) return { factId: dup._id, outcome: "unchanged" };
      break;
    }
  }

  // 7. Live cap: this write adds one live row and retires `toSupersede` (DA-A-36).
  const liveAfter = txn.liveFactCount + 1 - toSupersede.length;
  if (liveAfter > MAX_LIVE_FACTS_PER_TRANSACTION) {
    refuse(`A transaction can hold at most ${MAX_LIVE_FACTS_PER_TRANSACTION} current facts`);
  }

  const factId = await ctx.db.insert("facts", {
    userId,
    transactionId: txn._id,
    subjectKey: input.subjectKey,
    key: spec.key,
    state,
    value,
    source,
    ...(overrides ? { overridesObserved: true } : {}),
    recordedAt: now,
    ...(state === "observed" ? { lastObservedAt: now } : {}),
    ...(txn.isExample === true ? { isExample: true } : {}),
  });
  for (const r of toSupersede) await ctx.db.patch(r._id, { state: "superseded", supersededBy: factId });
  await ctx.db.patch(txn._id, { liveFactCount: Math.max(0, liveAfter) });
  if (linkEvidence !== null) await ctx.db.patch(linkEvidence, { transactionId: txn._id });
  return { factId, outcome: "inserted" };
}
