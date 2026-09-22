import { describe, it, expect } from "vitest";
import {
  alternatives,
  cellLookup,
  knownCell,
  resolveCell,
  withOverride,
  type Cell,
  type CellSource,
  type ResolveRow,
} from "./resolve";
import type { FactValue, KnownValue } from "./catalog";

// Hand-written resolution matrix (DA-A-1, D147(2), D152). Every expected value below is written by hand from
// contract §2.5 / §4 rule 5, never produced by the code under test.

const S = "item:abc";
const K = "retail.unit_price";
const usd = (n: number): KnownValue => ({ kind: "money", amountMinor: n, currency: "USD" });
const UNKNOWN: FactValue = { kind: "user_unknown" };
const src = {
  user: { kind: "user" } as CellSource,
  email: { kind: "evidence", ref: "ev1" } as CellSource,
  email2: { kind: "evidence", ref: "ev2" } as CellSource,
  check: { kind: "price_check", ref: "pc1" } as CellSource,
  rule: { kind: "derived", ref: "R01" } as CellSource,
  legacy: { kind: "legacy_purchase" } as CellSource,
};

let clock = 0;
function row(state: ResolveRow["state"], value: FactValue, extra: Partial<ResolveRow> = {}): ResolveRow {
  const source =
    state === "user_confirmed" ? src.user
    : state === "observed" ? src.check
    : state === "derived" ? src.rule
    : src.email;
  return { state, value, at: ++clock, source, ...extra };
}
const confirmed = (v: FactValue, extra?: Partial<ResolveRow>) => row("user_confirmed", v, extra);
const observed = (v: KnownValue, extra?: Partial<ResolveRow>) => row("observed", v, extra);
const derived = (v: KnownValue, extra?: Partial<ResolveRow>) => row("derived", v, extra);
const candidate = (v: KnownValue, extra?: Partial<ResolveRow>) => row("extracted_candidate", v, extra);
const resolve = (...rows: ResolveRow[]) => resolveCell(S, K, rows);

describe("resolveCell — DA-A-1 (user_unknown is never known)", () => {
  it("confirmed user_unknown → user_unknown", () => {
    const c = resolve(confirmed(UNKNOWN));
    expect(c).toMatchObject({ status: "user_unknown", known: false, capsOutcomeAt: null });
    expect(c.status === "user_unknown" && c.hint).toBeFalsy();
  });

  it("candidate then user_unknown → user_unknown (the older candidate is not a hint)", () => {
    const c = resolve(candidate(usd(9000)), confirmed(UNKNOWN));
    expect(c.status).toBe("user_unknown");
    expect(c.status === "user_unknown" && c.hint).toBeFalsy();
  });

  it("user_unknown then candidate → user_unknown carrying the later candidate as a hint", () => {
    const c = resolve(confirmed(UNKNOWN), candidate(usd(9000)));
    expect(c).toMatchObject({ status: "user_unknown", known: false, hint: { value: usd(9000), source: src.email } });
  });

  it("user_unknown then observed → observed", () => {
    expect(resolve(confirmed(UNKNOWN), observed(usd(8000)))).toMatchObject({
      status: "observed", known: true, value: usd(8000), source: src.check,
    });
  });

  it("user_unknown then derived → derived", () => {
    expect(resolve(confirmed(UNKNOWN), derived(usd(7000)))).toMatchObject({ status: "derived", known: true, value: usd(7000) });
  });

  it("confirmed value then user_unknown → user_unknown", () => {
    expect(resolve(confirmed(usd(12000)), confirmed(UNKNOWN)).status).toBe("user_unknown");
  });

  it("user_unknown then a confirmed value → confirmed", () => {
    expect(resolve(confirmed(UNKNOWN), confirmed(usd(12000)))).toMatchObject({
      status: "confirmed", known: true, value: usd(12000),
    });
  });

  it("a known cell never carries user_unknown (knownCell throws; unreachable through resolveCell)", () => {
    expect(() => knownCell(S, K, "confirmed", UNKNOWN, src.user)).toThrow(/user_unknown/);
    expect(() => knownCell(S, K, "observed", UNKNOWN, src.check)).toThrow(/user_unknown/);
    expect(knownCell(S, K, "derived", usd(1), src.rule)).toMatchObject({ status: "derived", known: true, value: usd(1) });
  });
});

describe("resolveCell — order of precedence (contract §2.5)", () => {
  it("no rows → missing", () => {
    expect(resolve()).toEqual({ subjectKey: S, key: K, status: "missing", known: false, capsOutcomeAt: null });
  });

  it("only superseded and rejected rows → missing", () => {
    expect(resolve(row("superseded", usd(1)), row("rejected", usd(2))).status).toBe("missing");
  });

  it("a single confirmed value → confirmed", () => {
    expect(resolve(confirmed(usd(12000)))).toEqual({
      subjectKey: S, key: K, status: "confirmed", known: true, value: usd(12000), source: src.user, capsOutcomeAt: null,
    });
  });

  it("observed alone → observed; derived alone → derived; observed beats derived", () => {
    expect(resolve(observed(usd(1))).status).toBe("observed");
    expect(resolve(derived(usd(1))).status).toBe("derived");
    expect(resolve(derived(usd(2)), observed(usd(1)))).toMatchObject({ status: "observed", value: usd(1) });
  });

  it("the newest current observation wins", () => {
    expect(resolve(observed(usd(5)), observed(usd(4)))).toMatchObject({ status: "observed", value: usd(4) });
  });

  it("observed beats a disagreeing candidate", () => {
    expect(resolve(candidate(usd(3)), observed(usd(4)))).toMatchObject({ status: "observed", value: usd(4) });
  });

  it("confirmed beats disagreeing candidates (a candidate never contests a confirmation)", () => {
    expect(resolve(confirmed(usd(12000)), candidate(usd(9000)), candidate(usd(8000)))).toMatchObject({
      status: "confirmed", value: usd(12000),
    });
  });

  it("confirmed beats derived", () => {
    expect(resolve(derived(usd(1)), confirmed(usd(2)))).toMatchObject({ status: "confirmed", value: usd(2) });
  });

  it("a superseded confirmation is ignored; the current candidate stands", () => {
    expect(resolve(row("superseded", usd(12000), { source: src.user }), candidate(usd(9000))).status).toBe("candidate");
  });

  it("ties on `at` break by input order (later row is newer)", () => {
    expect(resolve(observed(usd(5), { at: 100 }), observed(usd(6), { at: 100 }))).toMatchObject({ value: usd(6) });
    expect(resolve(observed(usd(6), { at: 101 }), observed(usd(5), { at: 100 }))).toMatchObject({ value: usd(6) });
  });
});

describe("resolveCell — candidates (D147(2): never known, cap at likely_eligible)", () => {
  it("agreeing candidates → candidate, not known, capsOutcomeAt likely_eligible, every source kept", () => {
    const c = resolve(candidate(usd(9000), { source: src.email }), candidate(usd(9000), { source: src.email2 }));
    expect(c).toEqual({
      subjectKey: S, key: K, status: "candidate", known: false, value: usd(9000),
      sources: [src.email2, src.email], capsOutcomeAt: "likely_eligible",
    });
  });

  it("a rejected candidate does not count", () => {
    expect(resolve(row("rejected", usd(1)), candidate(usd(9000)))).toMatchObject({ status: "candidate", value: usd(9000) });
  });
});

describe("resolveCell — conflict kinds (D152)", () => {
  it("candidates disagree, nothing confirmed → conflicting / candidates, both values with their sources", () => {
    const c = resolve(candidate(usd(9000), { source: src.email }), candidate(usd(8000), { source: src.email2 }));
    expect(c).toEqual({
      subjectKey: S, key: K, status: "conflicting", known: false, capsOutcomeAt: null,
      conflict: {
        kind: "candidates",
        values: [
          { value: usd(8000), source: src.email2, sources: [src.email2] },
          { value: usd(9000), source: src.email, sources: [src.email] },
        ],
      },
    });
  });

  it("confirmed value vs a disagreeing observation → conflicting / confirmed_vs_observed", () => {
    const c = resolve(confirmed(usd(12000)), observed(usd(11000)));
    expect(c).toMatchObject({
      status: "conflicting", known: false,
      conflict: {
        kind: "confirmed_vs_observed",
        values: [
          { value: usd(12000), source: src.user },
          { value: usd(11000), source: src.check },
        ],
      },
    });
  });

  it("the observation is older than the confirmation → still conflicting (order does not matter)", () => {
    expect(resolve(observed(usd(11000)), confirmed(usd(12000))).status).toBe("conflicting");
  });

  it("confirmed with overridesObserved vs a disagreeing observation → confirmed", () => {
    expect(resolve(observed(usd(11000)), confirmed(usd(12000), { overridesObserved: true }))).toMatchObject({
      status: "confirmed", value: usd(12000),
    });
  });

  it("confirmed vs an agreeing observation → confirmed", () => {
    expect(resolve(confirmed(usd(12000)), observed(usd(12000))).status).toBe("confirmed");
  });

  it("only the newest current observation is compared", () => {
    expect(resolve(observed(usd(1)), confirmed(usd(12000)), observed(usd(12000))).status).toBe("confirmed");
  });

  it("two current confirmed values contradict → conflicting / confirmed_vs_confirmed", () => {
    const c = resolve(confirmed(usd(12000), { source: src.legacy }), confirmed(usd(11000)));
    expect(c).toMatchObject({
      status: "conflicting",
      conflict: {
        kind: "confirmed_vs_confirmed",
        values: [
          { value: usd(11000), source: src.user },
          { value: usd(12000), source: src.legacy },
        ],
      },
    });
  });

  it("two current confirmed values agree → confirmed (the newest source)", () => {
    expect(resolve(confirmed(usd(12000), { source: src.legacy }), confirmed(usd(12000)))).toMatchObject({
      status: "confirmed", value: usd(12000), source: src.user,
    });
  });

  it("confirmed_vs_confirmed wins over confirmed_vs_observed when both apply", () => {
    const c = resolve(confirmed(usd(1), { source: src.legacy }), observed(usd(2)), confirmed(usd(3)));
    expect(c.status === "conflicting" && c.conflict.kind).toBe("confirmed_vs_confirmed");
  });
});

describe("the same-answer hook for M12 (D152 rule 5c)", () => {
  it("alternatives() turns each competing value into a cell of its own row state", () => {
    const cand = resolve(candidate(usd(9000)), candidate(usd(8000)));
    expect(alternatives(cand).map((c) => [c.status, c.status === "candidate" ? c.value : null])).toEqual([
      ["candidate", usd(8000)],
      ["candidate", usd(9000)],
    ]);
    const cvo = resolve(confirmed(usd(12000)), observed(usd(11000)));
    expect(alternatives(cvo).map((c) => c.status)).toEqual(["confirmed", "observed"]);
    expect(alternatives(resolve(confirmed(usd(1))))).toEqual([]);
  });

  it("withOverride substitutes one cell in a lookup without touching the others", () => {
    const a = resolve(candidate(usd(9000)), candidate(usd(8000)));
    const other = resolveCell("txn", "retail.currency", [confirmed({ kind: "code", code: "USD" })]);
    const lookup = cellLookup([a, other]);
    const [first] = alternatives(a);
    const swapped = withOverride(lookup, first);
    expect(swapped.get(S, K)).toBe(first);
    expect(swapped.get("txn", "retail.currency")).toBe(other);
    expect(lookup.get(S, K)).toBe(a);
    expect(lookup.get("txn", "retail.nope")).toEqual({
      subjectKey: "txn", key: "retail.nope", status: "missing", known: false, capsOutcomeAt: null,
    });
  });
});

describe("resolution property over every short row sequence", () => {
  const options: Array<() => ResolveRow> = [
    () => confirmed(UNKNOWN),
    () => confirmed(usd(1)),
    () => confirmed(usd(2)),
    () => confirmed(usd(2), { overridesObserved: true }),
    () => observed(usd(1)),
    () => observed(usd(3)),
    () => derived(usd(4)),
    () => candidate(usd(1)),
    () => candidate(usd(5)),
    () => row("superseded", usd(6), { source: src.user }),
    () => row("rejected", usd(7)),
  ];

  function* sequences(n: number): Generator<number[]> {
    if (n === 0) {
      yield [];
      return;
    }
    for (const rest of sequences(n - 1)) for (let i = 0; i < options.length; i++) yield [...rest, i];
  }

  it("known ⇔ confirmed|observed|derived, never with user_unknown; candidates always cap; status is closed", () => {
    let checked = 0;
    for (let n = 0; n <= 3; n++) {
      for (const seq of sequences(n)) {
        clock = 0;
        const rows = seq.map((i) => options[i]());
        const c: Cell = resolveCell(S, K, rows);
        checked++;
        expect(["confirmed", "observed", "derived", "candidate", "conflicting", "user_unknown", "missing"]).toContain(c.status);
        expect(c.known).toBe(c.status === "confirmed" || c.status === "observed" || c.status === "derived");
        if (c.known) expect(c.value.kind).not.toBe("user_unknown");
        expect(c.capsOutcomeAt).toBe(c.status === "candidate" ? "likely_eligible" : null);
        // DA-A-1: the newest current confirmation is "I don't know" and nothing observed/derived → user_unknown.
        const live = rows.filter((r) => r.state !== "superseded" && r.state !== "rejected");
        const newestConfirmed = live.filter((r) => r.state === "user_confirmed").at(-1);
        const systemKnown = live.some((r) => r.state === "observed" || r.state === "derived");
        if (newestConfirmed?.value.kind === "user_unknown" && !systemKnown) expect(c.status).toBe("user_unknown");
      }
    }
    expect(checked).toBe(1 + 11 + 121 + 1331);
  });
});
