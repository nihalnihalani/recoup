/**
 * T20 isolation.spec (D104): two fresh users. User B opening user A's
 * purchase/claim/watch data by URL sees the error boundary and none of A's
 * strings; A's own board/watchlist never surfaces anything B created.
 *
 * User A is the shared `leadPage` fixture (one real sign-in per worker, see
 * `e2e/fixtures.ts`); user B is always a genuinely separate, freshly
 * signed-up browser context (`signInFresh` on the per-test `page` fixture)
 * -- two independent sessions, the most realistic model of "two users".
 */
import { expect, leadEmailFor, seedLead, signInFresh, test, type SeedFixturesResult } from "./fixtures";

test.describe("isolation", () => {
  let userA: SeedFixturesResult;

  // eslint-disable-next-line no-empty-pattern
  test.beforeAll(({}, workerInfo) => {
    userA = seedLead(leadEmailFor(workerInfo.project.name));
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
    await expect(page.getByText("Nothing watched yet")).toBeVisible();
    await expect(page.getByText("E2E active watch")).toHaveCount(0);
  });

  test("user A's board and watchlist never show something user B created", async ({ page, newEmail, leadPage }) => {
    const bToken = `isob${Date.now()}`;
    await signInFresh(page, { email: newEmail(), name: "User B Creator" });
    await page.goto("/watching");
    await page.getByLabel("Product link").fill(`https://${bToken}.example/p/private-to-b`);
    await page.getByRole("button", { name: "Watch", exact: true }).click();
    await expect(page.getByRole("heading", { name: new RegExp(bToken) })).toBeVisible();

    // A genuinely separate session (leadPage), never touched by user B's page above.
    await leadPage.goto("/watching");
    await expect(leadPage.getByText(new RegExp(bToken))).toHaveCount(0);
    // Sanity: this really is A's own populated watchlist, not an empty account.
    await expect(leadPage.getByText("E2E active watch").first()).toBeVisible();

    await leadPage.goto("/");
    await expect(leadPage.getByText(new RegExp(bToken))).toHaveCount(0);
  });
});
