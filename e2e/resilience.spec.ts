/**
 * T20 resilience.spec (D104): route-level error boundaries never leave a
 * blank screen (malformed id, or a foreign/unknown id -- see
 * `src/components/ErrorBoundary.tsx`), the fallback heading takes focus and
 * "Go to board" works; keyboard-only completion of sign-in and of
 * confirm-credit; an axe scan finds no serious/critical violations on
 * Board, Watching, Settings, a Purchase and a Claim.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, seedLead, signInFresh, signInSeeded, test, type SeedFixturesResult } from "./fixtures";

const GENERIC_CRASH_TEXT = "Something went wrong loading this page.";
const NOT_FOUND_TEXT = "This item does not exist or belongs to another account.";

async function expectErrorBoundary(page: import("@playwright/test").Page, bodyText: string) {
  const heading = page.getByRole("heading", { name: "This page couldn't load" });
  await expect(heading).toBeVisible();
  await expect(heading).toBeFocused();
  await expect(page.getByText(bodyText)).toBeVisible();
  const back = page.getByRole("link", { name: "Go to board" });
  await expect(back).toBeVisible();
  await back.click();
  await expect(page).toHaveURL(/\/$/);
}

test.describe("resilience", () => {
  let seeded: SeedFixturesResult;

  test.beforeAll(() => {
    seeded = seedLead();
  });

  test.describe("error boundary", () => {
    test.beforeEach(async ({ page }) => {
      await signInSeeded(page);
    });

    test("a malformed claim id crashes to the generic fallback, focused, with a way back", async ({ page }) => {
      await page.goto("/claims/not-a-real-id");
      await expectErrorBoundary(page, GENERIC_CRASH_TEXT);
    });

    test("a malformed purchase id crashes to the generic fallback, focused, with a way back", async ({ page }) => {
      await page.goto("/purchases/not-a-real-id");
      await expectErrorBoundary(page, GENERIC_CRASH_TEXT);
    });
  });

  test.describe("foreign id", () => {
    test("a valid but foreign claim id shows the friendly not-found message, focused, with a way back", async ({
      page,
      newEmail,
    }) => {
      await signInFresh(page, { email: newEmail(), name: "Boundary Tester" });
      await page.goto(`/claims/${seeded.claimId}`);
      await expectErrorBoundary(page, NOT_FOUND_TEXT);
    });

    test("a valid but foreign purchase id shows the friendly not-found message, focused, with a way back", async ({
      page,
      newEmail,
    }) => {
      await signInFresh(page, { email: newEmail(), name: "Boundary Tester" });
      await page.goto(`/purchases/${seeded.claimPurchaseId}`);
      await expectErrorBoundary(page, NOT_FOUND_TEXT);
    });
  });

  test.describe("keyboard only", () => {
    test("sign-in completes with no pointer interaction", async ({ page }) => {
      await page.goto("/");
      await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();

      await page.getByLabel("Email").focus();
      await page.keyboard.type("e2e.lead@example.com");
      await page.keyboard.press("Tab"); // -> "Forgot password?" (signIn flow only)
      await page.keyboard.press("Tab"); // -> password field
      await page.keyboard.type("E2ePassword123!");
      await page.keyboard.press("Enter");

      await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible({ timeout: 20_000 });
    });

    test("confirming a credit completes with no pointer interaction", async ({ page }) => {
      await signInSeeded(page);
      await page.goto(`/claims/${seeded.claimId}`);
      const moneyCard = page.locator("section").filter({ has: page.getByRole("heading", { name: "Record money", level: 2 }) });
      // Scope to the "Credit landed" <details> specifically: both MoneyForms
      // share the same "Amount (…)" label text, and a closed <details>'s
      // fields are still present in the DOM, so an unscoped getByLabel would
      // match two elements.
      const creditForm = moneyCard.locator("details").filter({ has: page.getByText("Credit landed") });

      await creditForm.locator("summary").focus();
      await page.keyboard.press("Enter"); // opens the <details> disclosure

      await creditForm.getByLabel(/^Amount/).focus();
      await page.keyboard.type("9.00");
      await page.keyboard.press("Tab"); // -> "Where you saw it"
      await page.keyboard.type("Keyboard-only e2e run");
      await page.keyboard.press("Tab"); // -> "Confirm credit" submit button
      await page.keyboard.press("Enter");

      const ledgerCard = page.locator("section").filter({ has: page.getByRole("heading", { name: "Ledger", level: 2 }) });
      await expect(ledgerCard.locator("dl").nth(1).locator("dd").nth(1)).toHaveText("$9.00");
    });
  });

  test.describe("axe: no serious/critical violations", () => {
    test.beforeEach(async ({ page }) => {
      await signInSeeded(page);
    });

    for (const [label, path] of [
      ["Board", "/"],
      ["Watching", "/watching"],
      ["Settings", "/settings"],
    ] as const) {
      test(`${label} has no serious/critical accessibility violations`, async ({ page }) => {
        await page.goto(path);
        await page.waitForLoadState("networkidle");
        const results = await new AxeBuilder({ page }).analyze();
        const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
        expect(serious, JSON.stringify(serious, null, 2)).toEqual([]);
      });
    }

    test("a Purchase page has no serious/critical accessibility violations", async ({ page }) => {
      await page.goto(`/purchases/${seeded.claimPurchaseId}`);
      await page.waitForLoadState("networkidle");
      const results = await new AxeBuilder({ page }).analyze();
      const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
      expect(serious, JSON.stringify(serious, null, 2)).toEqual([]);
    });

    test("a Claim page has no serious/critical accessibility violations", async ({ page }) => {
      await page.goto(`/claims/${seeded.claimId}`);
      await page.waitForLoadState("networkidle");
      const results = await new AxeBuilder({ page }).analyze();
      const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
      expect(serious, JSON.stringify(serious, null, 2)).toEqual([]);
    });
  });
});
