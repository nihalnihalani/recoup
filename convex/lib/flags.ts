/**
 * Typed server feature flags (M1B; contract rev 5 §2.6 "Live extraction
 * (D145)", §11.1 row M1B; mission §15 P12, §18 C58).
 *
 * **Reads are here; there is exactly one writer.** Every other lane gates on
 * `isFlagOn(ctx, name)` (queries and mutations) or on the internal query
 * `internal.ops.getFlag` (actions, which have no `ctx.db`). The only way to
 * change a flag is the internal mutation `ops.setFlag`, run by an operator
 * with an admin key (`npx convex run ops:setFlag …`). No public function
 * writes a flag, and `lib/flags.test.ts` fails if any module other than this
 * file and `convex/ops.ts` builds a flag key.
 *
 * **Default OFF.** A flag with no stored row is off. A row that cannot be
 * parsed is off. A flag with `requiresApproval` that is stored ON without a
 * valid `approvalRef` (for example a row hand-edited in the dashboard) is
 * also off and reported `invalid` by `readFlag` and `ops.backlog`, so a
 * bypass of `ops.setFlag` cannot switch it on.
 *
 * **Storage.** There is no flags table (M10 owns `schema.ts`). Flags use
 * `opsState` rows: key `flag:<name>`, `cursor` = JSON
 * `{ "on": boolean, "approvalRef": string | null }`, and `updatedAt`.
 * `ops.setFlag` also appends one audit row per accepted call, keyed
 * `flagAudit:<name>:<10-digit seq>`. `retention.ts` prunes only the
 * `mailEvent:` and `e2e:code:` prefixes, so these rows are durable.
 */
import { ConvexError, v, type Infer } from "convex/values";
import type { QueryCtx } from "../_generated/server";

type FlagDefinition = {
  /** Enabling requires an `approvalRef` naming the DECISIONS entry that records the user's approval. */
  readonly requiresApproval: boolean;
  readonly summary: string;
};

/**
 * The closed flag registry. Add a flag here AND to `flagNameValidator` below
 * (a test asserts the two match). Every flag defaults OFF.
 */
export const FLAGS = {
  /**
   * D145 (DA-A-6/O5): model extraction of real users' uploaded documents.
   * Stays OFF on every deployment until the user explicitly approves the data
   * flow. Third-party processing of personal documents is the user's call,
   * not the team's. Synthetic fixtures on the dev deployment do not need it.
   */
  live_document_extraction: {
    requiresApproval: true,
    summary: "Model extraction of real users' uploaded documents (D145). OFF until the user approves the data flow.",
  },
  /**
   * SEC-SD-4: live card-statement intake. Required IN ADDITION to
   * `live_document_extraction`; `card_statement` also needs SEC-SD-1/2/4 and
   * SEC-AI-5 (contract §2.6 "Statement gate").
   */
  live_statement_extraction: {
    requiresApproval: true,
    summary: "Live card-statement extraction (SEC-SD-4); needs live_document_extraction as well.",
  },
  /**
   * Security baseline §3.5 R17 gate: medical-billing document intake. OFF
   * until all eight gate items are recorded in DECISIONS. With it off,
   * finalize/extract for a medical category is refused server-side.
   */
  medical_document_intake: {
    requiresApproval: true,
    summary: "Medical-billing document intake (R17 gate, security baseline §3.5).",
  },
} as const satisfies Record<string, FlagDefinition>;

export type FlagName = keyof typeof FLAGS;

export const FLAG_NAMES = Object.keys(FLAGS) as FlagName[];

/** Argument validator for a flag name, for `ops.setFlag`/`ops.getFlag`/`ops.flagAudit`. */
export const flagNameValidator = v.union(
  v.literal("live_document_extraction"),
  v.literal("live_statement_extraction"),
  v.literal("medical_document_intake"),
);

/** What `readFlag`, `ops.getFlag` and `ops.backlog` report for one flag. */
export const flagStateValidator = v.object({
  name: flagNameValidator,
  /** The effective value, the one every gate uses. */
  on: v.boolean(),
  /** The DECISIONS reference the flag was enabled under; `null` while off. */
  approvalRef: v.union(v.string(), v.null()),
  /** When the row was last written; `null` when the flag has never been set. */
  updatedAt: v.union(v.number(), v.null()),
  /** A stored row exists but is unparsable, or is ON without a valid approvalRef. Reads as OFF. */
  invalid: v.boolean(),
});

export type FlagState = Infer<typeof flagStateValidator>;

// Guard the validator/registry pairing at compile time too.
type ValidatorNames = Infer<typeof flagNameValidator>;
const _namesMatch: [ValidatorNames] extends [FlagName] ? ([FlagName] extends [ValidatorNames] ? true : never) : never = true;
void _namesMatch;

// ---------------------------------------------------------------------------
// Keys (used only here and in ops.ts)
// ---------------------------------------------------------------------------

const FLAG_KEY_PREFIX = "flag:";
const FLAG_AUDIT_KEY_PREFIX = "flagAudit:";
const AUDIT_SEQ_DIGITS = 10;

export function flagKey(name: FlagName): string {
  return `${FLAG_KEY_PREFIX}${name}`;
}

/** Every audit key of `name` sorts between `flagAuditPrefix(name)` and `flagAuditPrefixEnd(name)`. */
export function flagAuditPrefix(name: FlagName): string {
  return `${FLAG_AUDIT_KEY_PREFIX}${name}:`;
}

/** Exclusive upper bound of `name`'s audit keys (";" is the character after ":"). */
export function flagAuditPrefixEnd(name: FlagName): string {
  return `${FLAG_AUDIT_KEY_PREFIX}${name};`;
}

/** Zero-padded so lexicographic key order equals numeric sequence order. */
export function flagAuditKey(name: FlagName, seq: number): string {
  return `${flagAuditPrefix(name)}${String(seq).padStart(AUDIT_SEQ_DIGITS, "0")}`;
}

/** Parses the sequence number back out of an audit key; `null` for a foreign key. */
export function flagAuditSeq(name: FlagName, key: string): number | null {
  const prefix = flagAuditPrefix(name);
  if (!key.startsWith(prefix)) return null;
  const digits = key.slice(prefix.length);
  return /^\d+$/.test(digits) ? Number(digits) : null;
}

// ---------------------------------------------------------------------------
// approvalRef
// ---------------------------------------------------------------------------

export const MAX_APPROVAL_REF_CHARS = 200;

/**
 * `approvalRef` must name the DECISIONS entry where the lead recorded the
 * user's approval: a DECISIONS id (`D` + digits), optionally followed by a
 * note: `"D<n>"` or `"D<n>: user approved document processing"`.
 * Returns the trimmed value, or `null` when it is missing, empty, not led by
 * a DECISIONS id, longer than `MAX_APPROVAL_REF_CHARS`, or contains control
 * characters (which would let a caller forge extra log lines).
 */
export function normalizeApprovalRef(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_APPROVAL_REF_CHARS) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  if (!/^D\d+(?![A-Za-z0-9_])/.test(trimmed)) return null;
  return trimmed;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

type ReadCtx = Pick<QueryCtx, "db">;

function assertFlagName(name: string): asserts name is FlagName {
  if (!Object.prototype.hasOwnProperty.call(FLAGS, name)) {
    throw new ConvexError(`Unknown flag: ${name}. Valid flags: ${FLAG_NAMES.join(", ")}`);
  }
}

type StoredFlag = { on: boolean; approvalRef: string | null };

/** `null` when the stored value is not the `{ on, approvalRef }` shape `ops.setFlag` writes. */
export function parseStoredFlag(cursor: string | undefined): StoredFlag | null {
  if (cursor === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(cursor);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const { on, approvalRef } = parsed as { on?: unknown; approvalRef?: unknown };
  if (typeof on !== "boolean") return null;
  if (approvalRef !== undefined && approvalRef !== null && typeof approvalRef !== "string") return null;
  return { on, approvalRef: typeof approvalRef === "string" ? approvalRef : null };
}

/** The flag's stored row, if any (one indexed read). */
export async function flagRow(ctx: ReadCtx, name: FlagName) {
  return await ctx.db
    .query("opsState")
    .withIndex("by_key", (q) => q.eq("key", flagKey(name)))
    .first();
}

/**
 * The full state of one flag (one indexed read), for diagnostics.
 * `on` is the effective value; see `flagStateValidator`.
 */
export async function readFlag(ctx: ReadCtx, name: FlagName): Promise<FlagState> {
  assertFlagName(name);
  const row = await flagRow(ctx, name);
  if (!row) return { name, on: false, approvalRef: null, updatedAt: null, invalid: false };
  const stored = parseStoredFlag(row.cursor);
  if (!stored) return { name, on: false, approvalRef: null, updatedAt: row.updatedAt, invalid: true };
  const approvalRef = normalizeApprovalRef(stored.approvalRef);
  if (stored.on && FLAGS[name].requiresApproval && approvalRef === null) {
    return { name, on: false, approvalRef: null, updatedAt: row.updatedAt, invalid: true };
  }
  return { name, on: stored.on, approvalRef: stored.on ? approvalRef : null, updatedAt: row.updatedAt, invalid: false };
}

/**
 * THE gate other lanes call (queries and mutations; actions use
 * `internal.ops.getFlag`). It is `true` only when the flag was switched on
 * through `ops.setFlag` and, for an approval-gated flag, still carries a
 * valid `approvalRef`. Anything else, including a missing, malformed or
 * hand-edited row, is `false`. An unknown name throws, because it is a
 * programming error and throwing still refuses the gated work.
 *
 * Check it inside the mutation that claims the gated work, so the decision is
 * transactional. For example, M23 checks it before moving evidence to
 * `queued`, and records
 * `logEvent("extraction_refused", { evidenceId, flag: "live_document_extraction" })`
 * plus `extractionStatus: "store_only"` when it is off.
 */
export async function isFlagOn(ctx: ReadCtx, name: FlagName): Promise<boolean> {
  return (await readFlag(ctx, name)).on;
}
