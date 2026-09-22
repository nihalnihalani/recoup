/**
 * Fact subjects (contract §2.5). A fact cell is (transactionId, subjectKey, key); the subject says WHAT inside the
 * transaction the fact is about. The grammar is closed:
 *
 *   txn                 the transaction itself
 *   item:<itemId>       a retail line item (`items` row of the transaction's purchase)
 *   incident:<id>       an `incidents` row of the transaction
 *   segment:<n>         the n-th flight segment of an itinerary (1-based, wave 2)
 *   line:<n>            the n-th expense / statement line (1-based, wave 2)
 *
 * Ids are Convex document ids (lowercase alphanumeric). The parser only checks the shape; `lib/facts/write.ts`
 * resolves item/incident ids against the database and the transaction (DA-A-29). Pure: no ctx.
 */

export type SubjectKind = "transaction" | "item" | "incident" | "segment" | "line";

export type Subject =
  | { kind: "transaction" }
  | { kind: "item"; id: string }
  | { kind: "incident"; id: string }
  | { kind: "segment"; ordinal: number }
  | { kind: "line"; ordinal: number };

/** Largest ordinal a `segment:`/`line:` subject may carry: an itinerary or statement longer than this needs a human. */
export const MAX_SUBJECT_ORDINAL = 99;

const ID = /^[a-z0-9]{1,64}$/;
const ORDINAL = /^[1-9][0-9]*$/;

function ordinal(raw: string): number | null {
  if (!ORDINAL.test(raw)) return null;
  const n = Number(raw);
  return n <= MAX_SUBJECT_ORDINAL ? n : null;
}

/** Parses a subject key, or null when it is outside the grammar above. */
export function parseSubjectKey(key: string): Subject | null {
  if (key === "txn") return { kind: "transaction" };
  const colon = key.indexOf(":");
  if (colon < 0) return null;
  const head = key.slice(0, colon);
  const rest = key.slice(colon + 1);
  switch (head) {
    case "item":
    case "incident":
      return ID.test(rest) ? { kind: head, id: rest } : null;
    case "segment":
    case "line": {
      const n = ordinal(rest);
      return n === null ? null : { kind: head, ordinal: n };
    }
    default:
      return null;
  }
}

function built(key: string): string {
  if (parseSubjectKey(key) === null) throw new Error(`invalid fact subject ${JSON.stringify(key)}`);
  return key;
}

/** Builders; each throws on a value the parser would refuse, so a malformed key is never produced. */
export const subjectKey = {
  txn: (): string => "txn",
  item: (itemId: string): string => built(`item:${itemId}`),
  incident: (incidentId: string): string => built(`incident:${incidentId}`),
  segment: (n: number): string => built(`segment:${n}`),
  line: (n: number): string => built(`line:${n}`),
};

/** The kind of a parsed subject key, or null when the key is malformed. */
export function subjectKindOf(key: string): SubjectKind | null {
  return parseSubjectKey(key)?.kind ?? null;
}

/**
 * `FactRequirement.subjectPattern` / `DeadlineSpec.anchor.subjectPattern` matching (§4): an exact key, `<head>:*`
 * for every subject of that head, or `*` for any subject.
 */
export function subjectMatches(pattern: string, key: string): boolean {
  if (pattern === "*") return parseSubjectKey(key) !== null;
  if (pattern.endsWith(":*")) {
    const head = pattern.slice(0, -1);
    return key.startsWith(head) && parseSubjectKey(key) !== null;
  }
  return pattern === key;
}
