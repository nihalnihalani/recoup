import { assertCents, assertQty } from "./money";

export type EventKind = "promised_credit" | "confirmed_credit" | "later_debit";
export type LedgerEvent = { kind: EventKind; cents: number };

/**
 * The full claim lifecycle (D13, D21, D24). `queued` sits between `drafted`
 * and `sent`: `drafts.approveAndSend` enqueues via the AgentMail component
 * and only the reconcile job moves a claim to `sent`.
 */
export type ClaimStatus =
  | "detected"
  | "drafted"
  | "queued"
  | "sent"
  | "packet"
  | "promised"
  | "confirmed"
  | "reopened"
  | "dismissed";

export type Balance = {
  expected: number;
  promised: number;
  confirmed: number;
  debited: number;
  unresolved: number;
};

/**
 * Derives the money state of a claim from its append-only ledger events.
 * `promised` is the latest `promised_credit` event's cents, not a sum
 * (D21/F9: a merchant restating an amount replaces the earlier promise, it
 * doesn't add to it). `confirmed` and `debited` are sums. `unresolved` is
 * never clamped (D24/F12): an over-credit shows as a negative unresolved
 * balance ("over-credited by X"), never floored at zero.
 */
export function balance(expectedCents: number, events: LedgerEvent[]): Balance {
  let promised = 0;
  let confirmed = 0;
  let debited = 0;
  for (const e of events) {
    assertCents(e.cents, "ledger event cents");
    if (e.kind === "promised_credit") promised = e.cents;
    else if (e.kind === "confirmed_credit") confirmed += e.cents;
    else debited += e.cents;
  }
  return {
    expected: expectedCents,
    promised,
    confirmed,
    debited,
    unresolved: expectedCents - confirmed + debited,
  };
}

export function isSettled(b: Balance): boolean {
  return b.confirmed > 0 && b.unresolved <= 0;
}

/**
 * Minimum drop worth a claim: the larger of $1.00 or 2% of the paid price.
 * Returns null for a rise or a drop under threshold. Inputs must be
 * non-negative safe-integer cents (qty a safe integer of at least 1);
 * otherwise throws ConvexError (D20/F8).
 */
export function priceDropCents(
  unitCents: number,
  observedCents: number,
  qty: number,
): number | null {
  assertCents(unitCents, "unitCents");
  assertCents(observedCents, "observedCents");
  assertQty(qty);
  const drop = unitCents - observedCents;
  const threshold = Math.max(100, Math.round(unitCents * 0.02));
  if (drop < threshold) return null;
  return drop * qty;
}

export function windowEndsAt(purchasedAt: number, windowDays: number): number {
  return purchasedAt + windowDays * 86_400_000;
}

/**
 * The claim status transition triggered by a new ledger event (D21, D24).
 * `dismissed` is terminal. `later_debit` reopens only when it leaves money
 * unresolved. `confirmed_credit` settles the claim, or reopens a
 * previously-confirmed claim that a later debit had already pushed back
 * into the red. `promised_credit` never moves a confirmed claim backwards.
 */
export function statusAfterEvent(
  current: ClaimStatus,
  kind: EventKind,
  b: Balance,
): ClaimStatus {
  if (current === "dismissed") return current;
  if (kind === "later_debit") return b.unresolved > 0 ? "reopened" : current;
  if (kind === "confirmed_credit") {
    if (isSettled(b)) return "confirmed";
    return current === "confirmed" ? "reopened" : current;
  }
  // promised_credit
  return current === "confirmed" ? current : "promised";
}

/**
 * Re-derives a claim's status from its balance when no ledger event was
 * appended, e.g. after `adjustExpected` (D41): settled -> `confirmed`;
 * `confirmed` but no longer settled -> `reopened`; otherwise unchanged.
 * `dismissed` is terminal and callers refuse it before getting here.
 */
export function deriveStatus(current: ClaimStatus, b: Balance): ClaimStatus {
  if (current === "dismissed") return current;
  if (isSettled(b)) return "confirmed";
  return current === "confirmed" ? "reopened" : current;
}

/** Net money actually recovered on a claim, for board totals (D39). */
export function netRecovered(b: Balance): number {
  return Math.min(Math.max(b.confirmed - b.debited, 0), b.expected);
}

const TOKEN_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** A short, human-readable, collision-resistant claim token for email subjects. */
export function newToken(): string {
  let out = "";
  for (let i = 0; i < 6; i++) {
    out += TOKEN_ALPHABET[Math.floor(Math.random() * TOKEN_ALPHABET.length)];
  }
  return out;
}

/** Extracts the claim token from a subject like "Re: Order 123 [RC-AB12CD]". */
export function tokenFromSubject(subject: string | undefined): string | null {
  const m = /\[RC-([A-Z0-9]{6})\]/.exec(subject ?? "");
  return m ? m[1] : null;
}
