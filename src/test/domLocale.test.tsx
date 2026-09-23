// @vitest-environment happy-dom
/**
 * D205: a DOM test file is pinned to en-US by `domLocale.setup.ts` with no call of its own, so UI assertions such as
 * "$50.00" hold on any machine locale (the `localeshift` CI job runs this suite under de_DE).
 */
import { expect, it } from "vitest";

it("DOM test files format in en-US without pinning themselves", () => {
  expect(typeof document).toBe("object");
  expect(new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(50)).toBe("$50.00");
  expect((1234.5).toLocaleString()).toBe("1,234.5");
});
