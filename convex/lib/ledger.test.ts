import { describe, it, expect } from "vitest";
import { ConvexError } from "convex/values";
import {
  balance,
  isSettled,
  priceDropCents,
  windowEndsAt,
  statusAfterEvent,
  newToken,
  tokenFromSubject,
  deriveStatus,
  netRecovered,
} from "./ledger";

describe("balance", () => {
  it("promise 4000 on expected 4000 leaves unresolved 4000", () => {
    const b = balance(4000, [{ kind: "promised_credit", cents: 4000 }]);
    expect(b).toEqual({
      expected: 4000,
      promised: 4000,
      confirmed: 0,
      debited: 0,
      unresolved: 4000,
    });
  });

  it("confirm 1500 then 2500 settles", () => {
    const b = balance(4000, [
      { kind: "confirmed_credit", cents: 1500 },
      { kind: "confirmed_credit", cents: 2500 },
    ]);
    expect(b.confirmed).toBe(4000);
    expect(b.unresolved).toBe(0);
    expect(isSettled(b)).toBe(true);
  });

  it("later debit 1000 after settle reopens with unresolved 1000", () => {
    const b = balance(4000, [
      { kind: "confirmed_credit", cents: 4000 },
      { kind: "later_debit", cents: 1000 },
    ]);
    expect(b.unresolved).toBe(1000);
    expect(statusAfterEvent("confirmed", "later_debit", b)).toBe("reopened");
  });

  it("promised is the latest promise not a sum", () => {
    const b = balance(4000, [
      { kind: "promised_credit", cents: 1000 },
      { kind: "promised_credit", cents: 4000 },
    ]);
    expect(b.promised).toBe(4000);
  });

  it("over-credit is negative unresolved not clamped", () => {
    const b = balance(4000, [{ kind: "confirmed_credit", cents: 5000 }]);
    expect(b.unresolved).toBe(-1000);
  });

  it("rejects negative or non-integer cents", () => {
    expect(() =>
      balance(100, [{ kind: "confirmed_credit", cents: -1 }]),
    ).toThrow(ConvexError);
    expect(() =>
      balance(100, [{ kind: "confirmed_credit", cents: 1.5 }]),
    ).toThrow(ConvexError);
  });
});

describe("isSettled", () => {
  it("needs at least one confirmed credit and no unresolved", () => {
    expect(isSettled(balance(4000, []))).toBe(false);
    expect(
      isSettled(balance(4000, [{ kind: "confirmed_credit", cents: 4000 }])),
    ).toBe(true);
    expect(isSettled(balance(0, []))).toBe(false);
  });
});

describe("priceDropCents", () => {
  it("2 x 12000 observed 9500 gives 5000", () => {
    expect(priceDropCents(12000, 9500, 2)).toBe(5000);
  });

  it("drop under 100 cents or under 2 percent is null", () => {
    expect(priceDropCents(12000, 11950, 1)).toBeNull(); // drop 50 cents
    expect(priceDropCents(100000, 98500, 1)).toBeNull(); // drop 1500 < 2% of 100000 (2000)
  });

  it("price rise is null", () => {
    expect(priceDropCents(9500, 12000, 1)).toBeNull();
  });

  it("non-integer input throws", () => {
    expect(() => priceDropCents(120.5, 95, 1)).toThrow(ConvexError);
    expect(() => priceDropCents(12000, 95.5, 1)).toThrow(ConvexError);
    expect(() => priceDropCents(12000, 9500, 0)).toThrow(ConvexError);
    expect(() => priceDropCents(12000, 9500, 1.5)).toThrow(ConvexError);
  });
});

describe("windowEndsAt", () => {
  it("adds whole days", () => {
    expect(windowEndsAt(0, 14)).toBe(14 * 86_400_000);
  });
});

describe("statusAfterEvent", () => {
  it("dismissed stays dismissed", () => {
    const b = balance(1, [{ kind: "confirmed_credit", cents: 1 }]);
    expect(statusAfterEvent("dismissed", "confirmed_credit", b)).toBe(
      "dismissed",
    );
    expect(statusAfterEvent("dismissed", "later_debit", b)).toBe("dismissed");
    expect(statusAfterEvent("dismissed", "promised_credit", b)).toBe(
      "dismissed",
    );
  });

  it("later_debit reopens the claim when unresolved is positive", () => {
    const b = balance(4000, [
      { kind: "confirmed_credit", cents: 4000 },
      { kind: "later_debit", cents: 1000 },
    ]);
    expect(statusAfterEvent("confirmed", "later_debit", b)).toBe("reopened");
  });

  it("later_debit leaves status unchanged when unresolved is not positive", () => {
    const b = balance(4000, [{ kind: "confirmed_credit", cents: 5000 }]); // unresolved -1000
    expect(statusAfterEvent("confirmed", "later_debit", b)).toBe("confirmed");
  });

  it("confirmed_credit that settles moves to confirmed", () => {
    const b = balance(4000, [{ kind: "confirmed_credit", cents: 4000 }]);
    expect(statusAfterEvent("promised", "confirmed_credit", b)).toBe(
      "confirmed",
    );
  });

  it("confirmed_credit reopens when current is confirmed but the claim is not settled", () => {
    const b = balance(4000, [
      { kind: "confirmed_credit", cents: 4000 },
      { kind: "later_debit", cents: 1000 },
    ]);
    expect(statusAfterEvent("confirmed", "confirmed_credit", b)).toBe(
      "reopened",
    );
  });

  it("partial confirmed_credit leaves other statuses unchanged", () => {
    const b = balance(12000, [{ kind: "confirmed_credit", cents: 8000 }]);
    expect(statusAfterEvent("sent", "confirmed_credit", b)).toBe("sent");
  });

  it("promised_credit leaves confirmed unchanged", () => {
    const b = balance(4000, [{ kind: "promised_credit", cents: 4000 }]);
    expect(statusAfterEvent("confirmed", "promised_credit", b)).toBe(
      "confirmed",
    );
  });

  it("promised_credit moves other statuses to promised", () => {
    const b = balance(4000, [{ kind: "promised_credit", cents: 4000 }]);
    expect(statusAfterEvent("sent", "promised_credit", b)).toBe("promised");
    expect(statusAfterEvent("queued", "promised_credit", b)).toBe("promised");
    expect(statusAfterEvent("detected", "promised_credit", b)).toBe(
      "promised",
    );
  });
});

describe("newToken", () => {
  it("returns 6 chars from the collision-safe alphabet", () => {
    const t = newToken();
    expect(t).toHaveLength(6);
    expect(t).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
  });
});

describe("tokenFromSubject", () => {
  it("extracts the token when present", () => {
    expect(tokenFromSubject("Re: Order 123 [RC-AB12CD]")).toBe("AB12CD");
  });

  it("returns null when absent", () => {
    expect(tokenFromSubject("Re: Order 123")).toBeNull();
    expect(tokenFromSubject(undefined)).toBeNull();
  });
});

describe("deriveStatus / netRecovered (D39, D41)", () => {
  it("settled becomes confirmed; confirmed but unsettled reopens; else unchanged", () => {
    expect(deriveStatus("sent", balance(3000, [{ kind: "confirmed_credit", cents: 3000 }]))).toBe("confirmed");
    expect(deriveStatus("confirmed", balance(4000, [{ kind: "confirmed_credit", cents: 3000 }]))).toBe("reopened");
    expect(deriveStatus("sent", balance(4000, [{ kind: "confirmed_credit", cents: 3000 }]))).toBe("sent");
    expect(deriveStatus("dismissed", balance(3000, [{ kind: "confirmed_credit", cents: 3000 }]))).toBe("dismissed");
  });

  it("netRecovered clamps confirmed minus debited into 0..expected", () => {
    const ev = (kind: "confirmed_credit" | "later_debit", cents: number) => ({ kind, cents });
    expect(netRecovered(balance(4000, [ev("confirmed_credit", 4000), ev("later_debit", 1500)]))).toBe(2500);
    expect(netRecovered(balance(4000, [ev("confirmed_credit", 6000)]))).toBe(4000);
    expect(netRecovered(balance(4000, [ev("confirmed_credit", 1000), ev("later_debit", 2000)]))).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// M10 (contract rev 5 §3.2, HC-3 / KM2): provisional kinds and an EXHAUSTIVE
// ledger. Before this rewrite `balance()` counted every kind it did not know
// as a later debit (ledger.ts `else debited += …`), so a provisional credit
// would have INCREASED "unresolved" as if money had been taken back.
// ---------------------------------------------------------------------------
import { eventKind as schemaEventKind } from "../schema";
import { EVENT_KINDS, provisionalOutstanding, type ClaimStatus, type EventKind, type LedgerEvent } from "./ledger";

const ALL_STATUSES: ClaimStatus[] = [
  "detected", "drafted", "queued", "sent", "packet", "promised", "confirmed", "reopened", "dismissed",
];

describe("HC-3: an exhaustive ledger (every kind handled explicitly)", () => {
  it("a provisional credit never counts as a debit: unresolved stays at expected", () => {
    const b = balance(4000, [{ kind: "provisional_credit", cents: 2000 }]);
    expect(b).toMatchObject({ expected: 4000, promised: 0, confirmed: 0, debited: 0, unresolved: 4000 });
  });

  it("an unknown kind throws instead of silently counting as a debit", () => {
    const bogus = [{ kind: "bogus_kind", cents: 500 }] as unknown as LedgerEvent[];
    expect(() => balance(4000, bogus)).toThrow(ConvexError);
    expect(() => statusAfterEvent("sent", "bogus_kind" as unknown as EventKind, balance(4000, []))).toThrow(ConvexError);
  });

  it("the schema's eventKind and the ledger's EVENT_KINDS are the same set", () => {
    expect(schemaEventKind.members.map((m) => m.value).sort()).toEqual([...EVENT_KINDS].sort());
  });

  it("each kind's exact effect on balance and status (every kind × every status)", () => {
    const effect: Record<EventKind, (b: ReturnType<typeof balance>) => void> = {
      promised_credit: (b) => expect([b.promised, b.unresolved]).toEqual([1000, 4000]),
      confirmed_credit: (b) => expect([b.confirmed, b.unresolved]).toEqual([1000, 3000]),
      later_debit: (b) => expect([b.debited, b.unresolved]).toEqual([1000, 5000]),
      provisional_credit: (b) => expect([b.promised, b.confirmed, b.debited, b.unresolved]).toEqual([0, 0, 0, 4000]),
      provisional_released: (b) => expect([b.promised, b.confirmed, b.debited, b.unresolved]).toEqual([0, 0, 0, 4000]),
    };
    for (const kind of EVENT_KINDS) {
      const b = balance(4000, [{ kind, cents: 1000 }]);
      effect[kind](b);
      for (const status of ALL_STATUSES) {
        const next = statusAfterEvent(status, kind, b);
        if (kind === "provisional_credit" || kind === "provisional_released" || status === "dismissed") {
          expect(next, `${kind} on ${status}`).toBe(status); // provisional kinds never change status (§3.2)
        } else {
          expect(ALL_STATUSES, `${kind} on ${status}`).toContain(next);
        }
      }
    }
  });
});

describe("provisionalOutstanding (§3.2: provisional = Σ provisional_credit − Σ provisional_released ≥ 0)", () => {
  it("sums credits minus releases and ignores every other kind", () => {
    const events: LedgerEvent[] = [
      { kind: "provisional_credit", cents: 2000 },
      { kind: "confirmed_credit", cents: 700 },
      { kind: "provisional_credit", cents: 500 },
      { kind: "provisional_released", cents: 2000 },
      { kind: "later_debit", cents: 100 },
    ];
    expect(provisionalOutstanding(events)).toBe(500);
    expect(provisionalOutstanding([])).toBe(0);
  });

  it("a release larger than the provisional credit is refused", () => {
    expect(() =>
      provisionalOutstanding([
        { kind: "provisional_credit", cents: 1000 },
        { kind: "provisional_released", cents: 1001 },
      ]),
    ).toThrow(/provisional/);
  });

  it("rejects negative or fractional provisional amounts like every other event", () => {
    expect(() => provisionalOutstanding([{ kind: "provisional_credit", cents: -1 }])).toThrow(ConvexError);
    expect(() => provisionalOutstanding([{ kind: "provisional_credit", cents: 1.5 }])).toThrow(ConvexError);
  });
});

describe("mission §17 core financial fixtures (lib level, two claims walked event by event)", () => {
  /** Applies one event to a claim's running ledger the way claims.applyEvent does: append, re-derive, transition. */
  function step(state: { status: ClaimStatus; events: LedgerEvent[] }, e: LedgerEvent, expected = 4000) {
    const events = [...state.events, e];
    const b = balance(expected, events);
    return { status: statusAfterEvent(state.status, e.kind, b), events, b, provisional: provisionalOutstanding(events) };
  }

  it("4,000 expected; promise → 4,000 unresolved; confirm 1,500 → 2,500; 2,500 → 0; later debit 1,000 reopens only that claim", () => {
    let a = { status: "sent" as ClaimStatus, events: [] as LedgerEvent[] };
    let other = { status: "sent" as ClaimStatus, events: [] as LedgerEvent[] };

    let r = step(a, { kind: "promised_credit", cents: 4000 });
    expect([r.status, r.b.unresolved, r.b.promised]).toEqual(["promised", 4000, 4000]); // a promise is not money
    a = r;
    r = step(a, { kind: "confirmed_credit", cents: 1500 });
    expect([r.status, r.b.unresolved]).toEqual(["promised", 2500]);
    a = r;
    r = step(a, { kind: "confirmed_credit", cents: 2500 });
    expect([r.status, r.b.unresolved]).toEqual(["confirmed", 0]);
    a = r;

    const o = step(other, { kind: "confirmed_credit", cents: 4000 });
    expect([o.status, o.b.unresolved]).toEqual(["confirmed", 0]);
    other = o;

    r = step(a, { kind: "later_debit", cents: 1000 });
    expect([r.status, r.b.unresolved]).toEqual(["reopened", 1000]);
    // The other claim's own ledger is untouched: it stays confirmed at 0.
    expect([other.status, balance(4000, other.events).unresolved]).toEqual(["confirmed", 0]);
  });

  it("over-credit is preserved as a negative unresolved, never clamped", () => {
    const r = step({ status: "sent", events: [] }, { kind: "confirmed_credit", cents: 5000 });
    expect([r.status, r.b.unresolved]).toEqual(["confirmed", -1000]);
  });

  it("a provisional credit is labelled separately: provisional 2,000, unresolved and status unchanged; release → 0", () => {
    let s = { status: "sent" as ClaimStatus, events: [] as LedgerEvent[] };
    let r = step(s, { kind: "provisional_credit", cents: 2000 });
    expect([r.status, r.b.unresolved, r.b.confirmed, r.provisional]).toEqual(["sent", 4000, 0, 2000]);
    s = r;
    // Finalized: the release and the confirmed credit are two events (claims.finalizeProvisionalCredit).
    r = step(s, { kind: "provisional_released", cents: 2000 });
    expect([r.status, r.b.unresolved, r.provisional]).toEqual(["sent", 4000, 0]);
    s = r;
    r = step(s, { kind: "confirmed_credit", cents: 2000 });
    expect([r.status, r.b.unresolved, r.b.confirmed, r.provisional]).toEqual(["sent", 2000, 2000, 0]);
  });
});
