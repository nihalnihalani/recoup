/**
 * D205 / M16: the default-locale pin. This file is a SERVER-environment (edge-runtime) test, so it must start
 * unpinned (the DOM setup pin never reaches it), and `installDefaultLocale` must release cleanly whatever order two
 * pins are released in, so no pin leaks into the next file a worker runs.
 */
import { describe, expect, it } from "vitest";
import { installDefaultLocale } from "./locale";

const usd = (locales?: string) => new Intl.NumberFormat(locales, { style: "currency", currency: "USD" }).format(50);

describe("default-locale pin", () => {
  it("a server test file is not pinned (domLocale.setup.ts pins DOM files only)", () => {
    expect(typeof document).toBe("undefined");
    expect(Intl.NumberFormat.name).not.toBe("PinnedNumberFormat");
  });

  it("pins every formatter with no explicit locale, leaves an explicit one alone, and releases reference-counted", () => {
    const real = Intl.NumberFormat;
    const releaseSetup = installDefaultLocale("en-US");
    const releaseFile = installDefaultLocale("en-US");
    expect(usd()).toBe("$50.00");
    expect((50).toLocaleString(undefined, { style: "currency", currency: "USD" })).toBe("$50.00");
    expect(new Date(Date.UTC(2026, 8, 23, 12)).toLocaleDateString(undefined, { timeZone: "UTC" })).toBe("9/23/2026");
    expect(usd("de-DE")).toBe("50,00 $");
    // First-in released first (the order two afterAll hooks may run in): still pinned until the last release.
    releaseSetup();
    expect(usd()).toBe("$50.00");
    releaseSetup(); // idempotent: a double release does not drop the other pin
    expect(Intl.NumberFormat).not.toBe(real);
    releaseFile();
    expect(Intl.NumberFormat).toBe(real);
  });

  it("refuses a second pin to a different locale", () => {
    const release = installDefaultLocale("en-US");
    try {
      expect(() => installDefaultLocale("de-DE")).toThrow(/already pinned to en-US/);
    } finally {
      release();
    }
  });
});
