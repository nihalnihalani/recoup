/**
 * T20 watches.spec (D104). The dev deployment's scrape/AI/mail provider keys
 * are placeholders (adorable-lion-138, D83 item 3) so every provider-backed
 * step here genuinely fails -- the assertions below are written against that
 * truthful failure, never a faked success. `pause`/`resume` and `checkNow`
 * are pure Convex mutations with no provider dependency and are asserted
 * for real. "I bought it" is exercised on a fresh watch created in-test
 * (never the shared seeded fixture) so this file cannot destructively
 * convert a row another spec file's own beforeAll re-seeds independently.
 *
 * Uses the shared `leadPage` fixture (one real sign-in per worker, see
 * `e2e/fixtures.ts`) rather than a fresh `signInSeeded` per test.
 */
import { expect, leadEmailFor, seedLead, test } from "./fixtures";

test.describe("watches", () => {
  // eslint-disable-next-line no-empty-pattern
  test.beforeAll(({}, workerInfo) => {
    seedLead(leadEmailFor(workerInfo.project.name));
  });

  test.beforeEach(async ({ leadPage }) => {
    await leadPage.goto("/watching");
    await expect(leadPage.getByRole("heading", { name: "Watching", exact: true })).toBeVisible();
  });

  test("creating a watch from a URL shows the truthful check-failed state, never a fabricated price", async ({
    leadPage: page,
  }) => {
    const token = `wt${Date.now()}`;
    const url = `https://${token}.example/p/truthful-check-item`;

    await page.getByLabel("Product link").fill(url);
    await page.getByRole("button", { name: "Watch", exact: true }).click();

    const card = page.locator("li").filter({ has: page.getByRole("heading", { name: new RegExp(token) }) });
    await expect(card).toBeVisible();

    // The check genuinely ran and genuinely failed (placeholder scrape key) --
    // never silently skipped, never a made-up number.
    await expect(card.getByText(/No price last time/i)).toBeVisible({ timeout: 45_000 });
    await expect(card.getByText("Watching", { exact: true })).toBeVisible();
    // Scoped to a <p>: the chart's own empty-state placeholder ("No price
    // read yet. The chart starts with the first one.") is a <div> and would
    // otherwise also match this same substring.
    await expect(card.locator("p").filter({ hasText: "No price read yet" })).toBeVisible();
    await expect(card.getByText(/^\$/)).toHaveCount(0);
  });

  test("pause and resume toggle the watch's status", async ({ leadPage: page }) => {
    const card = page.locator("li").filter({ has: page.getByRole("heading", { name: "E2E active watch" }) });
    await expect(card).toBeVisible();

    await card.getByRole("button", { name: "Pause" }).click();
    await expect(card.getByText("Paused", { exact: true })).toBeVisible();
    await expect(card.getByRole("button", { name: "Resume" })).toBeVisible();

    await card.getByRole("button", { name: "Resume" }).click();
    await expect(card.getByText("Watching", { exact: true })).toBeVisible();
    await expect(card.getByRole("button", { name: "Pause" })).toBeVisible();
  });

  test("\"I bought it\" converts a fresh watch to a purchase with a claim window", async ({ leadPage: page }) => {
    const token = `bought${Date.now()}`;
    const url = `https://${token}.example/p/buy-me`;
    await page.getByLabel("Product link").fill(url);
    await page.getByRole("button", { name: "Watch", exact: true }).click();

    const card = page.locator("li").filter({ has: page.getByRole("heading", { name: new RegExp(token) }) });
    await expect(card).toBeVisible();

    await card.getByRole("button", { name: "I bought it" }).click();
    await card.getByLabel("Price you paid").fill("42.50");
    // Bought-on date input keeps its "today" default.
    await card.getByRole("button", { name: "Start the window" }).click();

    await expect(page).toHaveURL(/\/purchases\/[^/]+$/, { timeout: 15_000 });
    // `purchases.get`'s merchant name capitalises the domain's first label
    // ("bought123…" -> "Bought123…"), so match case-insensitively.
    await expect(page.getByRole("heading", { level: 1 })).toContainText(new RegExp(token, "i"));
    // The claim window is rendered (open or "no window known" -- there is no
    // returns/price-adjustment policy for this brand-new domain yet), never blank.
    await expect(page.getByRole("img", { name: /window/i })).toBeVisible();
    await expect(page.getByText("Paid").first()).toBeVisible();
  });
});
