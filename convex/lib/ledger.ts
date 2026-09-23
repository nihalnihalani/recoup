import { ConvexError } from "convex/values";
import { assertCents, assertQty } from "./money";

/**
 * Every ledger event kind (contract rev 5 §3.2). The ledger is EXHAUSTIVE (HC-3/KM2): `balance()` and
 * `statusAfterEvent()` switch on every kind with a `never` check, and an unknown kind at runtime throws —
 * it is never silently counted as a debit.
 * - `promised_credit`: the merchant's latest promise (D21) — not money.
 * - `confirmed_credit`: money the USER confirmed posted — only `claims.ts` writes it (SEC-MF-5, D145).
 * - `later_debit`: a reversal / later debit (D40) — reduces net recovered, reopens the claim.
 * - `provisional_credit`: a user-recorded provisional credit (e.g. during an issuer investigation) —
 *   shown separately as "of which provisional", never in `unresolved`, never a status change.
 * - `provisional_released`: the provisional credit ended (finalized — paired with a `confirmed_credit` —
 *   or reversed); reduces `provisionalOutstanding`, never `unresolved`.
 */
export const EVENT_KINDS = [
  "promised_credit",
  "confirmed_credit",
  "later_debit",
  "provisional_credit",
  "provisional_released",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];
export type LedgerEvent = { kind: EventKind; cents: number };

function unknownKind(kind: never): never {
  throw new ConvexError(`unknown ledger event kind ${String(kind)}`);
}

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
  | "dismissed"
  /** M20 (wave 2, §5): the counterparty refused (`claims.recordDenial`); closed for ask until money arrives. */
  | "denied";

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
    switch (e.kind) {
      case "promised_credit":
        promised = e.cents;
        break;
      case "confirmed_credit":
        confirmed += e.cents;
        break;
      case "later_debit":
        debited += e.cents;
        break;
      case "provisional_credit":
      case "provisional_released":
        // §3.2: provisional money is reported separately (`provisionalOutstanding`); `unresolved` is unchanged.
        break;
      default:
        return unknownKind(e.kind);
    }
  }
  return {
    expected: expectedCents,
    promised,
    confirmed,
    debited,
    unresolved: expectedCents - confirmed + debited,
  };
}

/**
 * Provisional money still outstanding on a claim (§3.2): Σ provisional_credit − Σ provisional_released.
 * Throws when releases exceed credits (the ledger would be claiming a negative provisional balance).
 * Shown as "of which provisional"; never part of `unresolved`, Recovered or any confirmed total.
 */
export function provisionalOutstanding(events: LedgerEvent[]): number {
  let credited = 0;
  let released = 0;
  for (const e of events) {
    assertCents(e.cents, "ledger event cents");
    switch (e.kind) {
      case "provisional_credit":
        credited += e.cents;
        break;
      case "provisional_released":
        released += e.cents;
        break;
      case "promised_credit":
      case "confirmed_credit":
      case "later_debit":
        break;
      default:
        return unknownKind(e.kind);
    }
  }
  if (released > credited) throw new ConvexError("A provisional release cannot exceed the provisional credit");
  return credited - released;
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
 * Provisional kinds never change status (§3.2). Exhaustive: an unknown kind throws.
 * M20 (wave 2, §5, D206): money arriving on a `denied` claim reopens it — a promise → `promised`, a settling credit →
 * `confirmed`, a partial credit → `reopened` (open again, money still unresolved). `dismissed` stays terminal.
 */
export function statusAfterEvent(
  current: ClaimStatus,
  kind: EventKind,
  b: Balance,
): ClaimStatus {
  if (current === "dismissed") return current;
  switch (kind) {
    case "later_debit":
      return b.unresolved > 0 ? "reopened" : current;
    case "confirmed_credit":
      if (isSettled(b)) return "confirmed";
      return current === "confirmed" || current === "denied" ? "reopened" : current;
    case "promised_credit":
      return current === "confirmed" ? current : "promised";
    case "provisional_credit":
    case "provisional_released":
      return current;
    default:
      return unknownKind(kind);
  }
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
