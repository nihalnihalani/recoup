/**
 * The deadline engine (contract rev 5.5 §4). Pure: no ctx, no wall clock (`now` is injected), no randomness.
 *
 * `computeDeadline(spec, cells, now)` turns one `DeadlineSpec` and the fact cells into a `DeadlineResult`.
 *
 * Anchor (the LEGAL trigger, never a fallback date):
 *   known                → a firm `dueAt`; user obligor "open" | "passed", counterparty "open" | "overdue"
 *   missing | user_unknown → "unknown_anchor", no dueAt; user obligor: `advisoryActBy` from
 *                           `spec.advisoryWhenAnchorUnknown` when that fact is known (D143.3)
 *   candidate            → "unknown_anchor", no dueAt (D154); user obligor: `advisoryActBy` = the due date the
 *                           candidate would give, labelled; counterparty: nothing
 *   conflicting          → "disputed_anchor", no dueAt (D154); basis lists each candidate and its source; user
 *                           obligor: `advisoryActBy` = the EARLIEST candidate's due date, labelled; counterparty: no
 *                           `overdueSince` until the anchor is resolved, even if every candidate date has passed
 *
 * Arithmetic (all boundaries are documented here and asserted in engine.test.ts):
 *   elapsed_24h_days  dueAt = anchor instant + n × 86,400,000 ms (R01 v1 legacy window; DST-blind by design)
 *   hours             dueAt = anchor instant + n × 3,600,000 ms
 *   calendar_days     the n-th counted local day D: the anchor day is day 1 when `anchorDayCounts`, else day 1 is
 *                     the next day. The last permissible day L = D (`endInclusive`) or the day before D.
 *   business_days     as calendar_days but counting only business days (weekends and, with `us_federal`, the
 *                     committed observed federal holidays skipped). Past the holiday table → "beyond_calendar".
 *   local_end_of_day  dueAt = the last millisecond of L in the zone (DST-correct: from the committed zone table)
 *   exact_instant     (local-day units) dueAt = L at the anchor's local wall-clock time
 *   Calendar days never extend over weekends or holidays: an extension is applied only when a pack supports it.
 *
 * Status is decided by `now > dueAt` (the due instant itself is still in time). Only USER deadlines feed
 * `windowOpen`, `nextDeadlineAt` and "expired" (DA-A-5); a counterparty deadline is never "passed" — it becomes
 * "overdue" (overdueSince = dueAt) and the pack's next action is `escalate`.
 *
 * Time zone: `spec.timeZone` (fixed, or from a fact), else the anchor value's own zone. When a local-day computation
 * has no known zone, the deadline is computed in every US zone and the EARLIEST due instant is used, with an
 * assumption naming that zone (conservative for the user).
 */
import { evaluateConditions } from "../rules/conditions";
import {
  isKnown,
  isUsable,
  type Assumption,
  type CellLookup,
  type DeadlineResult,
  type DeadlineSpec,
  type EngineCell,
  type FactValue,
  type Tri,
} from "../rules/types";
import { addCalendarDays, BeyondCalendarError, nthBusinessDay, nthCalendarDay } from "./calendar";
import { localParts, localToUtc, startOfLocalDay, US_ZONES, zoneRule, type ZoneRule } from "./usZones";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

export interface DeadlineComputation {
  result: DeadlineResult;
  /** e.g. the time-zone fallback assumption. */
  assumptions: Assumption[];
}

type AnchorPoint = { instant: number; localDate?: undefined; minutes?: undefined; zone?: undefined }
  | { instant?: undefined; localDate: string; minutes: number; zone?: string };

type Due = { dueAt: number; dueLocalDate?: string; zoneId?: string };

/** Resolves a subject pattern (`txn`, an exact key, `<head>:*` or `*`) against the evaluation's subject. */
export function resolveSubject(pattern: string, subjectKey?: string): string {
  if (pattern === "*" || pattern.endsWith(":*")) {
    if (subjectKey === undefined) throw new Error(`subject pattern ${pattern} needs an evaluation subject`);
    if (pattern !== "*" && !subjectKey.startsWith(pattern.slice(0, -1))) {
      throw new Error(`subject ${subjectKey} does not match ${pattern}`);
    }
    return subjectKey;
  }
  return pattern;
}

function anchorPoint(value: FactValue): AnchorPoint | null {
  switch (value.kind) {
    case "instant":
      return Number.isFinite(value.epochMs) ? { instant: value.epochMs } : null;
    case "local_date":
      return /^\d{4}-\d{2}-\d{2}$/.test(value.date) ? { localDate: value.date, minutes: 0, zone: value.timeZone } : null;
    case "local_datetime": {
      const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(value.dateTime);
      return m ? { localDate: m[1], minutes: Number(m[2]) * 60 + Number(m[3]), zone: value.timeZone } : null;
    }
    default:
      return null;
  }
}

function usesLocalCalendar(spec: DeadlineSpec, point: AnchorPoint): boolean {
  return spec.offset.unit === "calendar_days" || spec.offset.unit === "business_days" || point.instant === undefined;
}

/** The zone the spec names (fixed, or from a fact), else the anchor value's own; null when unknown. */
function specZone(spec: DeadlineSpec, cells: CellLookup, subject: string, point: AnchorPoint | null): ZoneRule | null {
  if ("fixed" in spec.timeZone) return zoneRule(spec.timeZone.fixed);
  const cell = cells(subject, spec.timeZone.factKey);
  if (isKnown(cell) && cell.value?.kind === "code") {
    const z = zoneRule(cell.value.code);
    if (z) return z;
  }
  if (point?.zone) return zoneRule(point.zone);
  return null;
}

function dueInZone(spec: DeadlineSpec, point: AnchorPoint, zone: ZoneRule | null): Due {
  const n = spec.offset.amount;
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`deadline offset must be a whole number ≥ 0 (${spec.id})`);
  const instantOf = (): number => {
    if (point.instant !== undefined) return point.instant;
    if (!zone) throw new Error("a local anchor needs a zone");
    return localToUtc(zone, point.localDate, point.minutes);
  };
  if (spec.offset.unit === "elapsed_24h_days" || spec.offset.unit === "hours") {
    const dueAt = instantOf() + n * (spec.offset.unit === "hours" ? HOUR_MS : DAY_MS);
    return zone ? { dueAt, dueLocalDate: localParts(zone, dueAt).date, zoneId: zone.id } : { dueAt };
  }
  if (!zone) throw new Error("a local-day deadline needs a zone");
  const local = point.instant !== undefined ? localParts(zone, point.instant) : { date: point.localDate, minutes: point.minutes };
  const counted =
    n === 0
      ? local.date
      : spec.offset.unit === "calendar_days"
        ? nthCalendarDay(local.date, n, spec.boundary.anchorDayCounts)
        : nthBusinessDay(local.date, n, spec.holidays, spec.boundary.anchorDayCounts);
  const last = spec.boundary.endInclusive ? counted : addCalendarDays(counted, -1);
  const dueAt =
    spec.endOfDay === "local_end_of_day"
      ? startOfLocalDay(zone, addCalendarDays(last, 1)) - 1
      : localToUtc(zone, last, local.minutes);
  return { dueAt, dueLocalDate: last, zoneId: zone.id };
}

/**
 * The due instant for one anchor value. With no known zone for a local computation, every US zone is tried and the
 * earliest due instant wins (reported through `fallbackZone`).
 */
function computeDue(
  spec: DeadlineSpec,
  point: AnchorPoint,
  zone: ZoneRule | null,
): Due & { fallbackZone?: ZoneRule } {
  if (zone || !usesLocalCalendar(spec, point)) return dueInZone(spec, point, zone);
  let best: (Due & { fallbackZone: ZoneRule }) | null = null;
  for (const z of US_ZONES) {
    const d = dueInZone(spec, point, z);
    if (best === null || d.dueAt < best.dueAt) best = { ...d, fallbackZone: z };
  }
  return best!;
}

function isLocalDaySpec(spec: DeadlineSpec): boolean {
  return (spec.offset.unit === "calendar_days" || spec.offset.unit === "business_days") && spec.endOfDay === "local_end_of_day";
}

/** `advisoryActBy` text: a local date for end-of-day specs, else the ISO instant. */
function actByText(spec: DeadlineSpec, due: Due): string {
  return isLocalDaySpec(spec) && due.dueLocalDate !== undefined ? due.dueLocalDate : new Date(due.dueAt).toISOString();
}

const UNIT_LABEL: Record<DeadlineSpec["offset"]["unit"], string> = {
  calendar_days: "calendar days",
  business_days: "business days",
  hours: "hours",
  elapsed_24h_days: "× 24 hours",
};

function ruleText(spec: DeadlineSpec): string {
  const n = spec.offset.amount;
  const unit = spec.offset.unit === "elapsed_24h_days" ? `${n} ${UNIT_LABEL.elapsed_24h_days}` : `${n} ${UNIT_LABEL[spec.offset.unit]}`;
  const parts = [`${unit} from ${spec.anchor.factKey}`];
  if (spec.offset.unit === "calendar_days" || spec.offset.unit === "business_days") {
    parts.push(spec.boundary.anchorDayCounts ? "anchor day counts as day 1" : "counting starts the day after the anchor");
    parts.push(spec.boundary.endInclusive ? "last day included" : "last day excluded");
    if (spec.offset.unit === "business_days") parts.push(spec.holidays === "us_federal" ? "weekends and US federal holidays skipped" : "weekends skipped");
  }
  return parts.join("; ");
}

function describeValue(v: FactValue): string {
  switch (v.kind) {
    case "instant":
      return new Date(v.epochMs).toISOString();
    case "local_date":
      return v.date;
    case "local_datetime":
      return v.dateTime;
    default:
      return v.kind;
  }
}

function base(spec: DeadlineSpec, subject: string): Pick<DeadlineResult, "id" | "label" | "obligor" | "mustBe" | "anchor" | "sourcePassageId"> {
  return {
    id: spec.id,
    label: spec.label,
    obligor: spec.obligor,
    mustBe: spec.mustBe,
    anchor: { subjectKey: subject, key: spec.anchor.factKey },
    sourcePassageId: spec.sourcePassageId,
  };
}

function tzAssumption(spec: DeadlineSpec, zone: ZoneRule): Assumption {
  return {
    id: `${spec.id}.time_zone`,
    text: `Your time zone is not known, so this deadline uses the earliest-ending US time zone (${zone.label}, ${zone.id}).`,
    changesOutcomeIf: "your local time zone ends the day later, which gives you more time",
  };
}

/** Earliest local date of an instant across US zones (conservative date-only advisory). */
function earliestLocalDate(instant: number): string {
  return US_ZONES.map((z) => localParts(z, instant).date).sort()[0];
}

function advisoryFromFallbackFact(spec: DeadlineSpec, cells: CellLookup, subject: string, zone: ZoneRule | null): string | undefined {
  const a = spec.advisoryWhenAnchorUnknown;
  if (!a || spec.obligor !== "user") return undefined;
  const cell = cells(subject, a.fromFactKey);
  if (!isKnown(cell) || cell.value === undefined) return undefined;
  const v = cell.value;
  let date: string | null = null;
  if (v.kind === "local_date") date = v.date;
  else if (v.kind === "local_datetime") date = v.dateTime.slice(0, 10);
  else if (v.kind === "instant") date = zone ? localParts(zone, v.epochMs).date : earliestLocalDate(v.epochMs);
  return date === null ? undefined : addCalendarDays(date, a.offsetDays);
}

function statusFor(spec: DeadlineSpec, dueAt: number, now: number): Pick<DeadlineResult, "status" | "overdueSince"> {
  if (now <= dueAt) return { status: "open" };
  return spec.obligor === "user" ? { status: "passed" } : { status: "overdue", overdueSince: dueAt };
}

function outsideCalendar(err: unknown): boolean {
  return err instanceof BeyondCalendarError || err instanceof RangeError;
}

export function computeDeadlineDetailed(
  spec: DeadlineSpec,
  cells: CellLookup,
  now: number,
  opts: { subjectKey?: string } = {},
): DeadlineComputation {
  const subject = resolveSubject(spec.anchor.subjectPattern, opts.subjectKey);
  const b = base(spec, subject);
  const rule = ruleText(spec);

  if (spec.appliesWhen) {
    const w = evaluateConditions(spec.appliesWhen, cells);
    if (w.result === "fail") {
      return { result: { ...b, status: "not_applicable", basis: `Does not apply to this case. (${rule})` }, assumptions: [] };
    }
    if (w.result === "unknown") {
      // DA-A-5 (R02): which timer applies is not an eligibility question — no timer, no missing fact.
      return {
        result: { ...b, status: "unknown_anchor", basis: `Which timer applies depends on facts not yet known. (${rule})` },
        assumptions: [],
      };
    }
  }

  const cell: EngineCell = cells(subject, spec.anchor.factKey);

  // Unconfirmed or disputed anchors: never a firm due date (D154).
  if (cell.status === "candidate" || cell.status === "conflicting") {
    const values =
      cell.status === "candidate"
        ? cell.value !== undefined ? [{ value: cell.value, source: "an unconfirmed document" }] : []
        : (cell.conflict?.values ?? []).map((c) => ({ value: c.value, source: c.source.ref ? `${c.source.kind} ${c.source.ref}` : c.source.kind }));
    const dues: { due: Due; value: FactValue; source: string }[] = [];
    for (const v of values) {
      const point = anchorPoint(v.value);
      if (!point) continue;
      try {
        dues.push({ due: computeDue(spec, point, specZone(spec, cells, subject, point)), value: v.value, source: v.source });
      } catch (err) {
        if (!outsideCalendar(err)) throw err;
      }
    }
    dues.sort((x, y) => x.due.dueAt - y.due.dueAt);
    const status = cell.status === "candidate" ? "unknown_anchor" : "disputed_anchor";
    const listed = dues.map((d) => `${describeValue(d.value)} (${d.source})`).join("; ");
    const earliest = dues[0];
    const advisory = spec.obligor === "user" && earliest ? actByText(spec, earliest.due) : undefined;
    const basis =
      status === "unknown_anchor"
        ? `The start date is not confirmed${listed ? `: ${listed}` : ""}. ${advisory ? `Conservative act-by based on an unconfirmed date — confirm it. ` : ""}(${rule})`
        : `The start date is disputed: ${listed || "no usable candidate"}. ${advisory ? "Conservative act-by from the earliest candidate — confirm the right date. " : ""}(${rule})`;
    return {
      result: {
        ...b, status, basis,
        ...(advisory !== undefined ? { advisoryActBy: advisory } : {}),
        ...(earliest?.due.zoneId !== undefined ? { timeZone: earliest.due.zoneId } : {}),
      },
      assumptions: [],
    };
  }

  if (!isUsable(cell)) {
    const zone = specZone(spec, cells, subject, null);
    const advisory = advisoryFromFallbackFact(spec, cells, subject, zone);
    const label = spec.advisoryWhenAnchorUnknown?.label ?? "conservative act-by (not the legal deadline)";
    return {
      result: {
        ...b,
        status: "unknown_anchor",
        basis: `The start date is not known yet. ${advisory ? `${label}. ` : ""}(${rule})`,
        ...(advisory !== undefined ? { advisoryActBy: advisory } : {}),
      },
      assumptions: [],
    };
  }

  const point = anchorPoint(cell.value!);
  if (!point) {
    return { result: { ...b, status: "unknown_anchor", basis: `The start date has an unusable value. (${rule})` }, assumptions: [] };
  }
  const zone = specZone(spec, cells, subject, point);
  let due: Due & { fallbackZone?: ZoneRule };
  try {
    due = computeDue(spec, point, zone);
  } catch (err) {
    if (!outsideCalendar(err)) throw err;
    return {
      result: { ...b, status: "beyond_calendar", basis: `This date falls outside the calendar Recoup has verified (through 2030). (${rule})` },
      assumptions: [],
    };
  }
  const st = statusFor(spec, due.dueAt, now);
  return {
    result: {
      ...b,
      ...st,
      dueAt: due.dueAt,
      // A UTC reference zone (exact-instant specs) has no user-facing local date.
      ...(due.dueLocalDate !== undefined && due.zoneId !== "UTC" ? { dueLocalDate: due.dueLocalDate } : {}),
      ...(due.zoneId !== undefined && due.zoneId !== "UTC" ? { timeZone: due.zoneId } : {}),
      basis: rule,
    },
    assumptions: due.fallbackZone ? [tzAssumption(spec, due.fallbackZone)] : [],
  };
}

export function computeDeadline(spec: DeadlineSpec, cells: CellLookup, now: number, opts: { subjectKey?: string } = {}): DeadlineResult {
  return computeDeadlineDetailed(spec, cells, now, opts).result;
}

// ---------------------------------------------------------------------------
// Projections used by evaluators and the opportunity writer
// ---------------------------------------------------------------------------

/**
 * The `windowOpen` dimension: USER deadlines only (DA-A-5). No user deadline → pass. A `met` deadline (D212: the
 * user's act was done in time) counts as satisfied, like an open one.
 */
export function userWindowOpen(deadlines: readonly Pick<DeadlineResult, "obligor" | "status">[]): Tri {
  const user = deadlines.filter((d) => d.obligor === "user" && d.status !== "not_applicable");
  if (user.some((d) => d.status === "passed")) return "fail";
  if (user.some((d) => d.status !== "open" && d.status !== "met")) return "unknown";
  return "pass";
}

/**
 * M20 (D212): marks a computed USER-obligor deadline as satisfied (`met`) — e.g. the notice was received before its
 * due instant. Keeps `dueAt` for display ("received in time"); only the status changes. A counterparty deadline can
 * never be `met` (throws): the user's act never extends or pauses the counterparty's clock, which the pack computes
 * independently. A `met` deadline is not open, so it is never the next user deadline and never needs attention.
 */
export function markMet(d: DeadlineResult, note: string): DeadlineResult {
  if (d.obligor !== "user") throw new Error(`deadline ${d.id}: only a user-obligor deadline can be met`);
  return { ...d, status: "met", basis: `${d.basis} ${note}`.trim() };
}

/** `opportunities.nextDeadlineAt`: the earliest OPEN user deadline (DA-A-5). */
export function nextUserDeadlineAt(deadlines: readonly DeadlineResult[]): number | undefined {
  const due = deadlines.filter((d) => d.obligor === "user" && d.status === "open" && d.dueAt !== undefined).map((d) => d.dueAt!);
  return due.length === 0 ? undefined : Math.min(...due);
}

/** `opportunities.nextCounterpartyDueAt`: the earliest firm counterparty due date (open or overdue). */
export function nextCounterpartyDueAt(deadlines: readonly DeadlineResult[]): number | undefined {
  const due = deadlines
    .filter((d) => d.obligor === "counterparty" && (d.status === "open" || d.status === "overdue") && d.dueAt !== undefined)
    .map((d) => d.dueAt!);
  return due.length === 0 ? undefined : Math.min(...due);
}

/** Counterparty deadlines that are overdue → the pack's next action is `escalate` (DA-A-5). */
export function overdueCounterpartyDeadlines(deadlines: readonly DeadlineResult[]): DeadlineResult[] {
  return deadlines.filter((d) => d.obligor === "counterparty" && d.status === "overdue" && d.overdueSince !== undefined);
}

/**
 * rev 5 (C1): a `deadline_passed` evaluation whose ONLY failing items are user deadlines marked
 * `lateAskAcknowledgeable` (and their timing conditions). `drafts.prepareSend` answers such a claim with the
 * acknowledgeable `window_may_have_passed`; the window closing is also not material.
 */
export function isLateAskAcknowledgeable(
  evaluation: {
    outcome: string;
    deadlines: readonly Pick<DeadlineResult, "id" | "obligor" | "status">[];
    conditions: readonly { id: string; result: Tri; kind: string }[];
  },
  acknowledgeableDeadlineIds: ReadonlySet<string>,
): boolean {
  if (evaluation.outcome !== "deadline_passed") return false;
  const passed = evaluation.deadlines.filter((d) => d.obligor === "user" && d.status === "passed");
  if (passed.length === 0 || passed.some((d) => !acknowledgeableDeadlineIds.has(d.id))) return false;
  return evaluation.conditions.every((c) => c.result !== "fail" || (c.kind === "timing" && acknowledgeableDeadlineIds.has(c.id)));
}
