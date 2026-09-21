/**
 * T20 isolation.spec (D104): two fresh users. User B opening user A's
 * purchase/claim/watch data by URL sees the error boundary and none of A's
 * strings; A's own board/watchlist never surfaces anything B created.
 */
import { expect, seedLead, signInFresh, signInSeeded, signOut, test, type SeedFixturesResult } from "./fixtures";

test.describe("isolation", () => {
  let userA: SeedFixturesResult;

  test.beforeAll(() => {
    userA = seedLead();
  });

  test("user B cannot open user A's purchase or claim by URL, and none of A's data appears", async ({
    page,
    newEmail,
  }) => {
    await signInFresh(page, { email: newEmail(), name: "User B" });

    await page.goto(`/purchases/${userA.claimPurchaseId}`);
    await expect(page.getByRole("heading", { name: "This page couldn't load" })).toBeVisible();
    await expect(page.getByText("This item does not exist or belongs to another account.")).toBeVisible();
    await expect(page.getByText("E2E claim item")).toHaveCount(0);
    await expect(page.getByText("E2e Claim Store")).toHaveCount(0);
    await expect(page.getByText("help@e2e-claim.example")).toHaveCount(0);

    await page.goto(`/claims/${userA.claimId}`);
    await expect(page.getByRole("heading", { name: "This page couldn't load" })).toBeVisible();
    await expect(page.getByText("This item does not exist or belongs to another account.")).toBeVisible();
    await expect(page.getByText("E2E claim item")).toHaveCount(0);
    await expect(page.getByText("$25.00")).toHaveCount(0);

    // Watches have no per-id route; the equivalent check is that B's own
    // (empty) watchlist never surfaces A's watch.
    await page.goto("/watching");
    await expect(page.getByRole("heading", { name: "Nothing watched yet" })).toBeVisible();
    await expect(page.getByText("E2E active watch")).toHaveCount(0);
  });

  test("user A's board and watchlist never show something user B created", async ({ page, newEmail }) => {
    const bToken = `isob${Date.now()}`;
    await signInFresh(page, { email: newEmail(), name: "User B Creator" });
    await page.getByLabel("Product link").fill(`https://${bToken}.example/p/private-to-b`);
    await page.getByRole("button", { name: "Watch" }).click();
    await expect(page.getByRole("heading", { name: new RegExp(bToken) })).toBeVisible();
    await signOut(page);

    await signInSeeded(page); // back to user A (the lead fixture)
    await page.goto("/watching");
    await expect(page.getByText(new RegExp(bToken))).toHaveCount(0);
    // Sanity: this really is A's own populated watchlist, not an empty account.
    await expect(page.getByText("E2E active watch")).toBeVisible();

    await page.goto("/");
    await expect(page.getByText(new RegExp(bToken))).toHaveCount(0);
  });
});
