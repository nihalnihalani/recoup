/**
 * Canonical JSON and SHA-256 for binding and snapshot hashes (contract rev 5 §2.4 `approvalBinding.contextHash`,
 * §2.5 `snapshotHash` / `boundFactsHash`, §4 `resultHash`; DA-A-15).
 *
 * Canonical form: object keys sorted (UTF-16 code-unit order) at every depth; `undefined` object fields
 * dropped (an absent optional field and an explicit `undefined` hash the same); arrays kept in order (callers
 * sort sets, or use `sortCanonical`); numbers must be safe integers (money is integer minor units — a float,
 * NaN, ±Infinity or an unsafe integer throws); strings JSON-escaped; only plain objects, arrays, strings,
 * safe integers, booleans and null are accepted. Hash inputs are VALUES, never row ids.
 *
 * Hashing uses the platform Web Crypto API (`crypto.subtle`), as `lib/idempotency.ts` does; it is async.
 */
import { MAX_BOUND_FACTS } from "../limits";

function isPlainObject(v: object): v is Record<string, unknown> {
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function encode(v: unknown, path: string, stack: Set<object>): string {
  if (v === null) return "null";
  switch (typeof v) {
    case "boolean":
      return v ? "true" : "false";
    case "string":
      return JSON.stringify(v);
    case "number":
      if (!Number.isSafeInteger(v)) throw new Error(`canonicalJson: ${path} is not a safe integer (${String(v)})`);
      return String(v === 0 ? 0 : v);
    case "object": {
      if (stack.has(v)) throw new Error(`canonicalJson: cycle at ${path}`);
      stack.add(v);
      try {
        if (Array.isArray(v)) {
          return `[${v.map((item, i) => {
            if (item === undefined) throw new Error(`canonicalJson: ${path}[${i}] is undefined`);
            return encode(item, `${path}[${i}]`, stack);
          }).join(",")}]`;
        }
        if (!isPlainObject(v)) throw new Error(`canonicalJson: ${path} is not a plain object`);
        const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
        return `{${keys.map((k) => `${JSON.stringify(k)}:${encode(v[k], `${path}.${k}`, stack)}`).join(",")}}`;
      } finally {
        stack.delete(v);
      }
    }
    default:
      throw new Error(`canonicalJson: ${path} has unsupported type ${typeof v}`);
  }
}

/** The canonical JSON text of `value`. Throws on anything outside the canonical domain (see module doc). */
export function canonicalJson(value: unknown): string {
  return encode(value, "$", new Set());
}

/** A copy of `items` in canonical order (by each item's canonical JSON), for hashing sets. */
export function sortCanonical<T>(items: readonly T[]): T[] {
  return items
    .map((item) => ({ item, key: canonicalJson(item) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((x) => x.item);
}

/** Lowercase hex SHA-256 of the UTF-8 bytes of `s` (64 characters). */
export async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** `sha256Hex(canonicalJson(value))`. */
export async function canonicalHash(value: unknown): Promise<string> {
  return await sha256Hex(canonicalJson(value));
}

/**
 * The `boundFactsHash` of an approval / evaluation (§2.5, DA-A-15): SHA-256 over the canonical, sorted set of
 * `(subjectKey, key, status, value)` projections. Any other field a caller passes — fact ids, evidence ids,
 * timestamps — is DROPPED, so re-confirming an unchanged value on a new row never changes the hash, while a
 * changed value, status, key or subject always does. At most 32 entries.
 */
export async function boundFactsHash(
  facts: readonly { subjectKey: string; key: string; status: string; value?: unknown }[],
): Promise<string> {
  if (facts.length > MAX_BOUND_FACTS) throw new Error(`boundFactsHash: at most ${MAX_BOUND_FACTS} bound facts`);
  const projected = facts.map(({ subjectKey, key, status, value }) => ({ subjectKey, key, status, value }));
  return await canonicalHash(sortCanonical(projected));
}
