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
