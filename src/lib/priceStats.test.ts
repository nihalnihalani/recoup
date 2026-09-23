/**
 * P02-OW-4 and P06-OW-2 for the bought-item verdict: a queued message is not "Asked" (and an unconfirmed send reads
 * "Delivery unknown"), and an out-of-date price is never judged as today's.
 */
import { describe, expect, it } from "vitest";
import { boughtVerdict } from "./priceStats";

const NOW = Date.UTC(2026, 8, 23, 12);
const DAY = 86_400_000;
const base = { paidCents: 10_000, latestCents: 8_000, windowEndsAt: NOW + 10 * DAY, now: NOW, currency: "USD" };

describe("boughtVerdict", () => {
  it("a queued claim is 'Sending', never 'Asked'", () => {
    const v = boughtVerdict({ ...base, claimStatus: "queued" });
    expect(v.kind).toBe("sending");
    expect(v.label).not.toMatch(/asked/i);
    expect(v.reason).not.toMatch(/has been asked/i);
  });

  it("a queued claim whose send is unknown reads 'Delivery unknown'", () => {
    const v = boughtVerdict({ ...base, claimStatus: "queued", sendUnknown: true });
    expect(v.label).toBe("Delivery unknown");
    expect(v.shortLabel).toBe("Delivery unknown");
  });

  it("sent and packet are still 'Asked'", () => {
    expect(boughtVerdict({ ...base, claimStatus: "sent" }).kind).toBe("asked");
    expect(boughtVerdict({ ...base, claimStatus: "packet" }).kind).toBe("asked");
  });

  it("P06-OW-2: a 20-day-old drop is 'Price out of date', not 'Claim now'", () => {
    const fresh = boughtVerdict(base);
    expect(fresh.kind).toBe("claim_now");
    const stale = boughtVerdict({ ...base, priceStale: true, priceObservedAt: NOW - 20 * DAY });
    expect(stale.kind).toBe("stale");
    expect(stale.label).toBe("Price out of date");
    expect(stale.reason).toContain("20 days ago");
    expect(stale.reason).not.toMatch(/below what you paid/);
  });

  it("a live claim still outranks a stale price", () => {
    expect(boughtVerdict({ ...base, claimStatus: "promised", priceStale: true }).kind).toBe("promised");
  });
});
