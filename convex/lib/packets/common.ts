/**
 * Manual-channel packet templates — the shared surface (M20; contract §6, DA-A-15, SEC-AI-4). A template is a pure,
 * deterministic renderer owned by its pack's lane (M21: R05/R03, M22: R02/R04) and registered in `./index.ts`. It
 * reads ONLY the bound evaluation's values (`boundFacts`, N6) plus server fields, through a `FactReader` that records
 * every read and refuses a key that is not bound or not known — so "every interpolated key is bound" (DA-A-15) holds
 * by construction. `packetFindings` is the SEC-AI-4 check for a rendered or user-edited packet: the pack's verbatim
 * text blocks are removed, then `lib/contentCheck.unverifiedContent` runs with the bound money, emails and links and
 * the recipient allowed. No ctx, no clock, no randomness, no `lib/ai`.
 */
import type { Infer } from "convex/values";
import type { manualChannel, recipientSource } from "../../schema";
import { normalizeUrl, unverifiedContent, type Allowances } from "../contentCheck";
import { formatMinor } from "../money";
import type { BoundFactValue, DeadlineResult, FactValue, Money, ScenarioId } from "../rules/types";

export type ManualChannel = Infer<typeof manualChannel>;
export type RecipientSource = Infer<typeof recipientSource>;

/** Bounds on stored packet text (`packets.ts` enforces them on every write). */
export const MAX_PACKET_BODY_CHARS = 8_000;
export const MAX_REQUESTED_REMEDY_CHARS = 300;
export const MAX_RECIPIENT_CHARS = 500;
export const MAX_PACKET_EVIDENCE = 25;

/** Everything a template may read: the bound evaluation's values (N6) plus server fields. */
export interface PacketContext {
  scenarioId: ScenarioId;
  ruleId: string;
  ruleVersion: number;
  /** The claim's ask (server field). */
  amount: Money;
  /** The ONLY facts a template may state (`evaluation.boundFacts`). */
  boundFacts: readonly BoundFactValue[];
  /** The evaluation's deadlines (e.g. R03's "received by"). */
  deadlines: readonly DeadlineResult[];
  /** The claim's reference token. */
  claimToken: string;
  /** The claim's required channel (never "email" for a packet). */
  channel: ManualChannel;
}

export interface PacketDraft {
  /** Null → the user must enter a recipient before approval. */
  recipient: { text: string; source: RecipientSource } | null;
  /** Plain text, ≤ MAX_PACKET_BODY_CHARS. */
  body: string;
  /** One line, ≤ MAX_REQUESTED_REMEDY_CHARS. */
  requestedRemedy: string;
}

export interface PacketTemplate {
  /** Must equal the pack's ruleId/version. */
  ruleId: string;
  version: number;
  /** e.g. "r05_v1.letter"; a pack may register several (an escalation packet is its own template). */
  templateId: string;
  channels: readonly ManualChannel[];
  /** Verbatim fixed pack text; anything inside is exempt from SEC-AI-4. */
  textBlocks: readonly string[];
  compose(context: PacketContext, facts: FactReader): PacketDraft;
}

export type PacketRenderReason = "not_bound" | "not_known" | "wrong_kind";

/** A template read a fact it may not state. `packets.prepare` turns it into "confirm <key> first". */
export class PacketRenderError extends Error {
  readonly subjectKey: string;
  readonly key: string;
  readonly reason: PacketRenderReason;
  constructor(subjectKey: string, key: string, reason: PacketRenderReason) {
    super(`${subjectKey}/${key}: ${reason === "not_bound" ? "not a bound fact" : reason === "not_known" ? "not confirmed" : "unexpected value kind"}`);
    this.name = "PacketRenderError";
    this.subjectKey = subjectKey;
    this.key = key;
    this.reason = reason;
  }
}

export interface FactReader {
  value(subjectKey: string, key: string): FactValue;
  money(subjectKey: string, key: string): Money;
  /** A `text`, `identifier` (its value) or `code` fact. */
  text(subjectKey: string, key: string): string;
  /** "YYYY-MM-DD" from a `local_date`, `local_datetime` or `instant` (UTC date) fact. */
  localDate(subjectKey: string, key: string): string;
  /** Bound and known; records nothing. */
  has(subjectKey: string, key: string): boolean;
  readonly used: readonly { subjectKey: string; key: string }[];
}

const KNOWN: ReadonlySet<string> = new Set(["confirmed", "observed", "derived"]);
const cellId = (subjectKey: string, key: string) => `${subjectKey}\u0000${key}`;

/** A reader over the bound facts: every read is recorded; unbound or not-known reads throw `PacketRenderError`. */
export function factReader(boundFacts: readonly BoundFactValue[]): FactReader {
  const byId = new Map<string, BoundFactValue>();
  for (const f of boundFacts) byId.set(cellId(f.subjectKey, f.key), f);
  const used: { subjectKey: string; key: string }[] = [];
  /** Reads a bound, known value, converts it (null = wrong kind), and records the read only when it succeeds. */
  const read = <R>(subjectKey: string, key: string, convert: (v: FactValue) => R | null): R => {
    const f = byId.get(cellId(subjectKey, key));
    if (!f) throw new PacketRenderError(subjectKey, key, "not_bound");
    if (!KNOWN.has(f.status) || f.value === undefined) throw new PacketRenderError(subjectKey, key, "not_known");
    const out = convert(f.value);
    if (out === null) throw new PacketRenderError(subjectKey, key, "wrong_kind");
    if (!used.some((u) => u.subjectKey === subjectKey && u.key === key)) used.push({ subjectKey, key });
    return out;
  };
  return {
    value: (subjectKey, key) => read(subjectKey, key, (v) => v),
    money: (subjectKey, key) => read(subjectKey, key, (v) => (v.kind === "money" ? { amountMinor: v.amountMinor, currency: v.currency } : null)),
    text: (subjectKey, key) =>
      read(subjectKey, key, (v) => (v.kind === "text" ? v.text : v.kind === "identifier" ? v.value : v.kind === "code" ? v.code : null)),
    localDate: (subjectKey, key) =>
      read(subjectKey, key, (v) =>
        v.kind === "local_date" ? v.date
        : v.kind === "local_datetime" ? v.dateTime.slice(0, 10)
        : v.kind === "instant" ? new Date(v.epochMs).toISOString().slice(0, 10)
        : null),
    has(subjectKey, key) {
      const f = byId.get(cellId(subjectKey, key));
      return f !== undefined && KNOWN.has(f.status) && f.value !== undefined;
    },
    get used() {
      return used;
    },
  };
}

/** "USD 1,234.50" (`lib/money.formatMinor`; locale-independent). */
export function formatMoney(m: Money): string {
  return formatMinor(m.amountMinor, m.currency);
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "2026-09-20" → "September 20, 2026". Locale-independent by construction (D205: server text never depends on Intl). */
export function formatLocalDate(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) throw new Error(`not a local date: ${date}`);
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
}

/** `{{name}}` placeholders, one pass (a value is never re-expanded). An unknown or unused name throws. */
export function fill(template: string, values: Readonly<Record<string, string>>): string {
  const seen = new Set<string>();
  const out = template.replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (_whole, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(values, name)) throw new Error(`template placeholder {{${name}}} has no value`);
    seen.add(name);
    return values[name];
  });
  const unused = Object.keys(values).filter((k) => !seen.has(k));
  if (unused.length > 0) throw new Error(`template values never used: ${unused.join(", ")}`);
  return out;
}

const EMAILISH = /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/;
const URLISH = /^(?:https?:\/\/|www\.)\S+$/i;
/** Bound text shorter than this is never stripped before the scan (a short code could hide a stated amount). */
const MIN_STRIP_CHARS = 6;

/**
 * SEC-AI-4 for a packet body (and its requested-remedy line). Before the scan: the pack's verbatim text blocks, the
 * recipient text and every bound `text`/`identifier` value of at least 6 characters are removed (they are server- or
 * rule-supplied, e.g. a mailing address or an order reference that looks like a phone number). Then
 * `unverifiedContent` lists every email, link, phone number or amount that is not allowed: the allowed amounts are
 * the claim's ask and every bound money value; the allowed emails/links are the bound ones and the recipient's.
 */
export function packetFindings(
  body: string,
  context: Pick<PacketContext, "amount" | "boundFacts">,
  template: Pick<PacketTemplate, "textBlocks">,
  recipient: string | null,
): string[] {
  const emails = new Set<string>();
  const urls = new Set<string>();
  const amountsMinor = new Set<number>([context.amount.amountMinor]);
  const strip: string[] = [...template.textBlocks];
  const allowText = (t: string) => {
    const s = t.trim();
    if (EMAILISH.test(s)) emails.add(s.toLowerCase());
    else if (URLISH.test(s)) urls.add(normalizeUrl(s));
    if (s.length >= MIN_STRIP_CHARS) strip.push(s);
  };
  if (recipient) allowText(recipient);
  for (const f of context.boundFacts) {
    const v = f.value;
    if (!v) continue;
    if (v.kind === "money") amountsMinor.add(v.amountMinor);
    else if (v.kind === "text") allowText(v.text);
    else if (v.kind === "identifier") allowText(v.value);
  }
  let scanned = body;
  for (const block of strip.filter((b) => b.length > 0).sort((a, b) => b.length - a.length)) {
    scanned = scanned.split(block).join(" ");
  }
  const allowances: Allowances = { emails, urls, hosts: new Set<string>(), amountsMinor };
  return unverifiedContent(scanned, allowances);
}
