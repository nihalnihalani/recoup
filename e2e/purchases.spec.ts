/**
 * T20 purchases.spec (D104): a seeded purchase page renders its
 * price-adjustment policy card (retrieved/confirmed, not a live re-fetch --
 * the AI/scrape providers are placeholders on this deployment), and the
 * tracked item's price table: paid vs current vs lowest, and a real plotted
 * price history rather than a "no price seen yet" placeholder.
 */
import { expect, seedLead, signInSeeded, test, type SeedFixturesResult } from "./fixtures";

test.describe("purchases", () => {
  let seeded: SeedFixturesResult;

  test.beforeAll(() => {
    seeded = seedLead();
  });

  test.beforeEach(async ({ page }) => {
    await signInSeeded(page);
  });

  test("the price-adjustment policy card shows the confirmed, retrieved rule", async ({ page }) => {
    await page.goto(`/purchases/${seeded.claimPurchaseId}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    const policy = page.getByRole("region", { name: "Price-adjustment rule" });
    await expect(policy).toBeVisible();
    await expect(policy.getByText("14", { exact: true })).toBeVisible();
    await expect(policy.getByText("days from purchase")).toBeVisible();
    await expect(policy.getByText("By email")).toBeVisible();
    await expect(policy.getByText("help@e2e-claim.example")).toBeVisible();
    await expect(policy.getByText("Confirmed", { exact: true })).toBeVisible();
    // Confidence 1 -> the meter reads 100%, not a live re-scrape spinner.
    await expect(policy.getByText("100%")).toBeVisible();
    // The retrieval date is shown (a snapshot that was actually read), not "not looked up yet".
    await expect(policy.getByText(/^Read /)).toBeVisible();
    await expect(policy.getByText("Not looked up yet")).toHaveCount(0);

    // The rule text itself, behind its own disclosure.
    await policy.getByText("Read the rule").click();
    await expect(policy.getByText(/price adjustments honored within 14 days/i)).toBeVisible();
  });

  test("the tracked item's table shows paid vs current vs lowest and a real plotted price history", async ({
    page,
  }) => {
    await page.goto(`/purchases/${seeded.boughtPurchaseId}`);

    const item = page.getByRole("region", { name: "E2E bought item" });
    await expect(item).toBeVisible();

    // Paid is fixed at purchase time ($100.00); the 12 seeded reads walk the
    // price down to $89.00, so "current"/"lowest" both land there -- neither
    // is ever confused with the paid price.
    await expect(item.getByText("Paid $100.00")).toBeVisible();
    await expect(item.getByText("$89.00").first()).toBeVisible();
    await expect(item.getByText("$100.00").first()).toBeVisible();

    // A real chart from the 12 seeded reads, not the empty-state placeholder.
    await expect(item.getByText("No price seen yet")).toHaveCount(0);
    await expect(item.locator("svg").first()).toBeVisible();
    await expect(item.getByText("Tracking since")).toBeVisible();

    // The re-check action is a clearly separate control from the read-only history.
    await expect(item.getByRole("button", { name: "Check price now" })).toBeVisible();
  });
});
