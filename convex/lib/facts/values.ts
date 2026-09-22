/**
 * Fact value validation and comparison (contract §2.5). Pure: no ctx.
 *
 * `validateFactValue(spec, value, …)` is what `lib/facts/write.ts` runs before any insert: the value must be the
 * spec's kind and inside its domain. Two rules come from D142:
 *   - `text` values are MASKED with `lib/pan.maskPans` and never refused for holding a card number;
 *   - `identifier` values are validated by their scheme's own format and NEVER pass through the free-text masker
 *     (an IMEI, a 13-digit e-ticket or an order ref can be Luhn-valid by construction).
 */
import { ConvexError } from "convex/values";
import { MAX_FACT_TEXT_CHARS, MAX_ORDER_REF_CHARS } from "../../limits";
import { assertMoney, assertUserAmount, formatMinor, isTwoDecimalCurrency } from "../money";
import { luhnValid, maskPans } from "../pan";
import type { FactSpec, FactValue, IdentifierScheme, KnownValue } from "./catalog";

/** A value's canonical comparison key: its fields in sorted order, absent/undefined fields dropped. */
function comparable(v: FactValue): string {
  const entries = Object.entries(v)
    .filter(([, x]) => x !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(entries);
}

/** Value equality (DA-A-15: values are compared and hashed, never row ids). */
export function sameFactValue(a: FactValue, b: FactValue): boolean {
  return comparable(a) === comparable(b);
}

/** One line for an explanation or a conflict question ("USD 120.50", "2026-09-10T19:00:00.000Z", "I don't know"). */
export function formatFactValue(v: FactValue): string {
  switch (v.kind) {
    case "money":
      return formatMinor(v.amountMinor, v.currency);
    case "instant":
      return new Date(v.epochMs).toISOString();
    case "local_date":
      return v.timeZone ? `${v.date} (${v.timeZone})` : v.date;
    case "local_datetime":
      return v.timeZone ? `${v.dateTime} (${v.timeZone})` : v.dateTime;
    case "code":
      return v.code;
    case "text":
      return v.text;
    case "identifier":
      return v.value;
    case "bool":
      return v.value ? "yes" : "no";
    case "count":
      return String(v.n);
    case "minutes":
      return `${v.minutes} min`;
    case "user_unknown":
      return "I don't know";
  }
}

const MAX_INSTANT_MS = Date.UTC(2200, 0, 1) - 1;
const DEFAULT_COUNT_MAX = 1_000_000;
/** 366 days: a delay longer than a year is not a delay. */
const DEFAULT_MINUTES_MAX = 366 * 24 * 60;

function wholeInRange(n: number, min: number, max: number, label: string): number {
  if (!Number.isSafeInteger(n)) throw new ConvexError(`${label} must be a whole number`);
  if (n < min) throw new ConvexError(`${label} must be at least ${min}`);
  if (n > max) throw new ConvexError(`${label} must be at most ${max}`);
  return n;
}

function validTimeZone(tz: string | undefined, label: string): void {
  if (tz === undefined) return;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    throw new ConvexError(`${label} has an unknown time zone`);
  }
}

/** YYYY-MM-DD that is a real calendar date (no 2026-02-30). */
function validDate(date: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d && y >= 1900 && y < 2200;
}

function validDateTime(dateTime: string): boolean {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(dateTime);
  if (!m || !validDate(m[1])) return false;
  return Number(m[2]) < 24 && Number(m[3]) < 60 && (m[4] === undefined || Number(m[4]) < 60);
}

const CONTROL = /\p{Cc}/u;

/**
 * An identifier normalized by its scheme's own format, or a ConvexError. Never calls the card masker (D142):
 * identifier fields are typed, and the Luhn-valid IMEI / e-ticket / order-ref keep-samples must survive.
 */
export function validateIdentifier(scheme: IdentifierScheme, raw: string): string {
  if (CONTROL.test(raw)) throw new ConvexError(`${scheme} must be one line`);
  const trimmed = raw.trim();
  const compact = trimmed.replace(/[\s-]/g, "").toUpperCase();
  const fail = (what: string): never => {
    throw new ConvexError(`${what} is not in a recognised format`);
  };
  switch (scheme) {
    case "order_ref":
      // Merchants' formats vary ("#W123 456", "112-3456789-1234562"): one clean line with a letter or digit.
      if (trimmed.length === 0 || trimmed.length > MAX_ORDER_REF_CHARS || !/[\p{L}\p{N}]/u.test(trimmed)) {
        return fail("Order number");
      }
      return trimmed;
    case "imei":
      // 15 digits, Luhn check digit (3GPP TS 23.003).
      return /^\d{15}$/.test(compact) && luhnValid(compact) ? compact : fail("IMEI");
    case "eticket":
      // 13-digit ticket number: 3-digit airline prefix + 10-digit serial; separators dropped.
      return /^\d{13}$/.test(compact) ? compact : fail("Ticket number");
    case "pnr":
      // Booking reference / record locator: 6 letters or digits.
      return /^[A-Z0-9]{6}$/.test(compact) ? compact : fail("Booking reference");
    case "flight_number":
      // IATA airline designator (2 characters, at least one letter) + 1–4 digits + optional suffix letter.
      return /^(?=[A-Z0-9]{2}\d)(?:[A-Z]{2}|[A-Z]\d|\d[A-Z])\d{1,4}[A-Z]?$/.test(compact) ? compact : fail("Flight number");
    case "bag_tag":
      // 10-digit license plate, or the 2-letter airline + 6-digit fallback tag.
      return /^(?:\d{10}|[A-Z0-9]{2}\d{6})$/.test(compact) ? compact : fail("Bag tag");
    case "tracking":
      // Carrier tracking numbers: 8–40 letters/digits, no spaces inside.
      return /^[A-Z0-9]{8,40}$/.test(trimmed.toUpperCase()) ? trimmed.toUpperCase() : fail("Tracking number");
    case "serial":
      return /^[A-Z0-9][A-Z0-9./-]{2,39}$/.test(trimmed.toUpperCase()) ? trimmed.toUpperCase() : fail("Serial number");
  }
}

/** Free text: card numbers masked (D142, never refused), control characters other than line breaks removed, trimmed. */
export function normalizeFactText(raw: string): string {
  const masked = maskPans(raw).replace(/[^\P{Cc}\n\t]/gu, "").trim();
  if (masked.length === 0) throw new ConvexError("Text must not be empty");
  if (masked.length > MAX_FACT_TEXT_CHARS) throw new ConvexError(`Text must be at most ${MAX_FACT_TEXT_CHARS} characters`);
  return masked;
}

/**
 * The normalized value, or a ConvexError naming what is wrong. `userSource` applies the typed-amount cap
 * (`assertUserAmount`, SEC-MF-4) to money the user entered. `user_unknown` is refused here: whether "I don't know" may
 * be recorded is the writer's decision (only a `user_confirmed` row of a user-assertable key), not a value rule.
 */
export function validateFactValue(spec: FactSpec, value: FactValue, opts: { userSource: boolean }): KnownValue {
  if (value.kind === "user_unknown") throw new ConvexError(`"I don't know" is not a value for ${spec.key}`);
  if (value.kind !== spec.value) throw new ConvexError(`${spec.key} takes a ${spec.value} value, not ${value.kind}`);
  const label = spec.key;
  switch (value.kind) {
    case "money": {
      assertMoney({ amountMinor: value.amountMinor, currency: value.currency }, spec.currencyMode ?? "new_scenario", label);
      if (opts.userSource) assertUserAmount(value.amountMinor, label);
      return { kind: "money", amountMinor: value.amountMinor, currency: value.currency };
    }
    case "instant":
      return { kind: "instant", epochMs: wholeInRange(value.epochMs, 0, MAX_INSTANT_MS, label) };
    case "local_date":
      if (!validDate(value.date)) throw new ConvexError(`${label} must be a calendar date (YYYY-MM-DD)`);
      validTimeZone(value.timeZone, label);
      return value.timeZone === undefined
        ? { kind: "local_date", date: value.date }
        : { kind: "local_date", date: value.date, timeZone: value.timeZone };
    case "local_datetime":
      if (!validDateTime(value.dateTime)) throw new ConvexError(`${label} must be a local date and time (YYYY-MM-DDTHH:MM)`);
      validTimeZone(value.timeZone, label);
      return value.timeZone === undefined
        ? { kind: "local_datetime", dateTime: value.dateTime }
        : { kind: "local_datetime", dateTime: value.dateTime, timeZone: value.timeZone };
    case "code": {
      const codes = spec.codes;
      if (codes === "iso4217") {
        if (!isTwoDecimalCurrency(value.code) && !isIsoCurrency(value.code)) {
          throw new ConvexError(`${label} must be an ISO 4217 currency code`);
        }
      } else if (!codes?.includes(value.code)) {
        throw new ConvexError(`${label} "${value.code}" is not one of ${codes?.join(", ")}`);
      }
      return { kind: "code", code: value.code };
    }
    case "text":
      return { kind: "text", text: normalizeFactText(value.text) };
    case "identifier":
      if (value.scheme !== spec.identifierScheme) {
        throw new ConvexError(`${label} takes a ${spec.identifierScheme} identifier`);
      }
      return { kind: "identifier", scheme: value.scheme, value: validateIdentifier(spec.identifierScheme, value.value) };
    case "bool":
      return { kind: "bool", value: value.value };
    case "count":
      return { kind: "count", n: wholeInRange(value.n, spec.min ?? 0, spec.max ?? DEFAULT_COUNT_MAX, label) };
    case "minutes":
      return { kind: "minutes", minutes: wholeInRange(value.minutes, spec.min ?? 0, spec.max ?? DEFAULT_MINUTES_MAX, label) };
  }
}

type IntlWithSupported = typeof Intl & { supportedValuesOf?: (key: "currency") => string[] };
/** Any real ISO 4217 code (incl. 0- and 3-decimal ones), for currency CODE facts; money paths use their own mode. */
function isIsoCurrency(code: string): boolean {
  if (!/^[A-Z]{3}$/.test(code)) return false;
  const list = (Intl as IntlWithSupported).supportedValuesOf?.("currency");
  return list ? list.includes(code) : false;
}
