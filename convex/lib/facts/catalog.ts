/**
 * The closed fact catalogue (contract §2.5). Every fact row's `key` must be listed here; `lib/facts/write.ts`
 * refuses anything else. One file per domain supplies the specs and this module merges them:
 *
 *   keys_retail.ts  (M11, wave 1)   retail orders + the R01 v1 parameters
 *   keys_order.ts   (M21, wave 2)   online-order (R05) keys, incl. `retail.order_total`
 *   keys_air.ts     (M22, wave 2)   air travel (R02/R04)
 *   keys_card.ts    (M21, wave 2)   card charges (R03)
 *
 * Keys are never renamed (stored rows and evaluations reference them). Pure: no ctx.
 */
import type { Infer } from "convex/values";
import type { evidenceDocType, factValue, transactionCategory } from "../../schema";
import type { CurrencyMode } from "../money";
import type { SubjectKind } from "./subject";
import { RETAIL_FACT_SPECS } from "./keys_retail";
import { ORDER_FACT_SPECS } from "./keys_order";
import { AIR_FACT_SPECS } from "./keys_air";
import { CARD_FACT_SPECS } from "./keys_card";

export type FactValue = Infer<typeof factValue>;
/** A value that states something. `user_unknown` ("I don't know") is never one (DA-A-1). */
export type KnownValue = Exclude<FactValue, { kind: "user_unknown" }>;
export type ValueKind = KnownValue["kind"];
export type TransactionCategory = Infer<typeof transactionCategory>;
export type EvidenceDocType = Infer<typeof evidenceDocType>;
export type FactDomain = "retail" | "order" | "air" | "card";

/**
 * Typed identifier schemes (D142). An `identifier` value is validated by its scheme's own format
 * (`lib/facts/values.ts`) and NEVER passes through the free-text card masker.
 */
export type IdentifierScheme =
  | "order_ref"
  | "imei"
  | "tracking"
  | "eticket"
  | "pnr"
  | "bag_tag"
  | "flight_number"
  | "serial";

export interface FactSpec {
  key: string;
  /** The domain file the spec lives in. Not necessarily the key prefix (`retail.order_total` is an order key). */
  domain: FactDomain;
  /** Transaction categories whose transactions may hold this key. */
  categories: readonly TransactionCategory[];
  /** Subject kinds this key may be recorded against (`lib/facts/subject.ts`). */
  subject: readonly SubjectKind[];
  /** The one value kind a row of this key carries (besides a user's `user_unknown`, see `userAssertable`). */
  value: ValueKind;
  /** `code` keys only: the closed code list, or `"iso4217"` for a currency code. */
  codes?: readonly string[] | "iso4217";
  /** `identifier` keys only. */
  identifierScheme?: IdentifierScheme;
  /** `money` keys only: which currencies the value may be in (`lib/money.currencyExponent`); default `new_scenario`. */
  currencyMode?: CurrencyMode;
  /** `count`/`minutes` keys: inclusive bounds (default 0 … 1,000,000 / 0 … 527,040). */
  min?: number;
  max?: number;
  /** The question shown when this fact is decisive and unknown (§9 Questions UI). */
  question: { prompt: string; why: string; sensitive?: boolean };
  /** Documents that usually carry this fact (for "add evidence" next actions). */
  evidenceHint?: readonly EvidenceDocType[];
  /**
   * Whether the user may state this fact (`user_confirmed`, incl. "I don't know"). False for values only a system
   * observation or the rule pack's parameter source supplies (e.g. an observed price, a policy's window).
   */
  userAssertable: boolean;
  /**
   * `purchase_record` (M11b): on a transaction that mirrors a purchase, the purchase/item row IS this fact's source of
   * truth — `lib/facts/legacyRetail.ts` reads it as the cell's base layer. The user changes it by editing the purchase
   * (`purchases.confirm`), never through `facts.answer`, so a user's own correction can never contradict their own
   * purchase record (confirmed_vs_confirmed → manual_review). Absent: the fact has no row behind it.
   */
  sourceOfTruth?: "purchase_record";
}

export const FACT_SPECS = [...RETAIL_FACT_SPECS, ...ORDER_FACT_SPECS, ...AIR_FACT_SPECS, ...CARD_FACT_SPECS] as const;

type AnySpec = (typeof FACT_SPECS)[number];
/** Every catalogued key, as a literal union. */
export type FactKey = AnySpec["key"];
/** The spec of one key (compile time). */
export type SpecOf<K extends FactKey> = Extract<AnySpec, { key: K }>;
/** The known value a key's rows carry (compile time), e.g. `ValueFor<"retail.quantity">` = `{ kind: "count"; n }`. */
export type ValueFor<K extends FactKey> = Extract<KnownValue, { kind: SpecOf<K>["value"] }>;

const BY_KEY: ReadonlyMap<string, FactSpec> = new Map(FACT_SPECS.map((s): [string, FactSpec] => [s.key, s]));

/** The spec for `key`, or null when the key is not catalogued (writers refuse it). */
export function getFactSpec(key: string): FactSpec | null {
  return BY_KEY.get(key) ?? null;
}

export function isFactKey(key: string): key is FactKey {
  return BY_KEY.has(key);
}
