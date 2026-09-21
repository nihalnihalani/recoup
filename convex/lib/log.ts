/**
 * Structured, redacted operational logging (P12, T22).
 *
 * Every failure/backlog/progress signal worth an operator's attention should
 * go through `logEvent`, not a bare `console.error(...)` call: one JSON line
 * per event, tagged with a fixed `kind` from a closed union (so an operator
 * can grep/filter the Convex dashboard's function logs by kind) and a fresh
 * correlation id (so a single incident that spans a scheduled retry chain --
 * e.g. a `price_check_failed` line followed later by a `notification_failed`
 * line for the same watch -- can be tied together by hand across log lines,
 * even though this module does not persist or link them automatically: it
 * has no `ctx` and never touches the database).
 *
 * `fields` is redacted before it is ever serialized: this is the ONLY
 * sanctioned path for writing a caught provider error, a webhook rejection
 * reason, or any other operational detail to the log, because a raw caught
 * error routinely embeds exactly the secrets this deployment cannot afford
 * to leak into log aggregation (the same concern D99/F12a's AUTH_LOG_SECRETS
 * prohibition addresses for auth specifically) -- an OpenAI/Firecrawl API
 * key (`sk-`/`fc-`), a webhook signing secret (`whsec_`, the AgentMail and
 * app-webhook shape), a bearer token, or a user's full email address.
 *
 * Replacing the existing bare `console.error` call sites in notify.ts,
 * priceWatch.ts, watches.ts, offers.ts, policies.ts, market.ts and
 * inbound.ts with `logEvent` is a separate, later mechanical pass owned by
 * this same lane (PLAN.md T22) -- out of scope for this file's own change,
 * which only adds the primitive those call sites will switch to.
 *
 * Pure and synchronous (one `console.error` call): safe to call from a
 * query, mutation, or action. A query that gets retried under Convex's OCC
 * will emit the line again on each retry, the same as any other
 * `console.error` already does in this codebase -- this module does not
 * change that, only how the line is shaped.
 */

/** Closed set of operational signals worth a structured line (P12). Extend here, never with a bare `console.error`. */
export const LOG_KINDS = [
  "extraction_failed",
  "notification_failed",
  "notification_stalled",
  "price_check_failed",
  "budget_exhausted",
  "webhook_rejected",
  "scheduler_backlog",
  "market_failed",
  "migration_progress",
] as const;

export type LogKind = (typeof LOG_KINDS)[number];

/** Envelope keys `logEvent` always controls; a caller-supplied field of the same name is dropped rather than allowed to spoof the envelope. */
const RESERVED_KEYS = new Set(["kind", "correlationId", "at"]);

/** A single string value longer than this is truncated -- a defensive bound, not just a secret-shaped one: an unbounded provider error body (AgentMail's `errorMessage` alone can carry up to 4 KiB, `drafts.ts`) should never be logged whole either. */
const MAX_STRING_CHARS = 2000;
/** Recursion bound: also what keeps a circular-referencing `fields` object from looping forever (each recursive call increases `depth` regardless of object identity, so a cycle simply bottoms out here). */
const MAX_DEPTH = 6;
const MAX_ARRAY_ITEMS = 50;
const MAX_OBJECT_KEYS = 50;

/**
 * Applied in this order on purpose: `Bearer <token>` is matched and fully
 * masked FIRST, before the narrower `sk-`/`fc-`/`whsec_` patterns get a
 * chance to run -- a bearer token that happens to BE an `sk-...` key would
 * otherwise be only partially masked by the narrower pattern, leaving a
 * ` Bearer sk-***` fragment with the trailing token characters still
 * exposed after the first pass. Order for the rest does not matter; they
 * cannot overlap with each other's matches.
 */
const SECRET_PATTERNS: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [
  // `Authorization: Bearer <token>` or a bare "Bearer <token>" fragment.
  { pattern: /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi, replacement: "Bearer ***" },
  // OpenAI-style secret keys: `sk-...`.
  { pattern: /\bsk-[A-Za-z0-9_-]{10,}/g, replacement: "sk-***" },
  // Firecrawl API keys: `fc-...`.
  { pattern: /\bfc-[A-Za-z0-9_-]{10,}/g, replacement: "fc-***" },
  // Webhook signing secrets (svix/AgentMail shape): `whsec_...`.
  { pattern: /\bwhsec_[A-Za-z0-9_-]{6,}/g, replacement: "whsec_***" },
  // Email addresses: keep the domain only, drop the local part and the "@" entirely.
  {
    pattern:
      /\b[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+)\b/g,
    replacement: "$1",
  },
];

function redactString(value: string): string {
  let out = value;
  for (const { pattern, replacement } of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  if (out.length > MAX_STRING_CHARS) {
    out = `${out.slice(0, MAX_STRING_CHARS)}...[truncated ${out.length - MAX_STRING_CHARS} more chars]`;
  }
  return out;
}

function redactValue(value: unknown, depth: number): unknown {
  if (typeof value === "string") return redactString(value);
  // `JSON.stringify` throws on a bare bigint; Convex's `v.int64()` can surface one here.
  if (typeof value === "bigint") return `${value.toString()}n`;
  if (value === null || typeof value !== "object") return value; // number, boolean, undefined pass through unchanged
  if (depth >= MAX_DEPTH) return "[max depth exceeded]";
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return { name: value.name, message: redactString(value.message) };
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => redactValue(item, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) items.push(`...[${value.length - MAX_ARRAY_ITEMS} more item(s) omitted]`);
    return items;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  const out: Record<string, unknown> = {};
  for (const [key, val] of entries.slice(0, MAX_OBJECT_KEYS)) out[key] = redactValue(val, depth + 1);
  if (entries.length > MAX_OBJECT_KEYS) out["..."] = `${entries.length - MAX_OBJECT_KEYS} more field(s) omitted`;
  return out;
}

/**
 * Redacts every string reachable inside `value` (recursively, through plain
 * objects and arrays), bounded in depth/width so a hostile or merely huge
 * payload cannot blow up logging itself. Exported so it is independently
 * unit-testable and reusable outside `logEvent` (e.g. a caller that wants to
 * redact something before putting it somewhere other than the log).
 */
export function redact<T>(value: T): T {
  return redactValue(value, 0) as T;
}

export type LogEventResult = { correlationId: string };

/**
 * Writes one structured, redacted JSON line to `console.error` and returns
 * the correlation id it was tagged with. `fields` is redacted before
 * serialization (see module doc); a reserved envelope key inside `fields`
 * (`kind`, `correlationId`, `at`) is dropped rather than allowed to override
 * the real one.
 */
export function logEvent(kind: LogKind, fields: Record<string, unknown> = {}): LogEventResult {
  const correlationId = crypto.randomUUID();
  const at = new Date().toISOString();
  const safeFields = redactValue(fields, 0) as Record<string, unknown>;
  for (const key of RESERVED_KEYS) delete safeFields[key];
  console.error(JSON.stringify({ kind, correlationId, at, ...safeFields }));
  return { correlationId };
}
