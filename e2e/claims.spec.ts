/**
 * T20 claims.spec (D104). Ledger actions (`confirmCredit`/`recordLaterDebit`)
 * are plain Convex mutations with no external provider and are exercised
 * for real. Draft generation calls OpenAI (`convex/drafts.ts generate` ->
 * `convex/lib/ai.ts extract`), whose key is a placeholder on this deployment
 * (D83 item 3) -- that step is asserted as a truthful failure, and the
 * recipient-confirm-checkbox / approve-without-confirming flow is only
 * exercised for real if generation happens to succeed (never faked).
 *
 * Uses the shared `leadPage` fixture (one real sign-in per worker, see
 * `e2e/fixtures.ts`) rather than a fresh `signInSeeded` per test; the three
 * tests below run in this declared order deliberately (the ledger test
 * mutates the claim, and must run after the two read-only ones).
 */
import { expect, leadEmailFor, seedLead, test, type SeedFixturesResult } from "./fixtures";

test.describe("claims", () => {
  let seeded: SeedFixturesResult;

  // eslint-disable-next-line no-empty-pattern
  test.beforeAll(({}, workerInfo) => {
    seeded = seedLead(leadEmailFor(workerInfo.project.name));
  });

  test.beforeEach(async ({ leadPage }) => {
    await leadPage.goto(`/claims/${seeded.claimId}`);
    await expect(leadPage.getByRole("heading", { name: "E2E claim item", level: 1 })).toBeVisible();
  });

  test("the claim page shows what is owed and no draft has been written yet", async ({ leadPage: page }) => {
    await expect(page.getByText("Owed to you")).toBeVisible();
    await expect(page.getByText("$25.00").first()).toBeVisible();

    const messageCard = page.locator("section").filter({ has: page.getByRole("heading", { name: "Message to the store", level: 2 }) });
    await expect(messageCard.getByText("No draft yet. Write the message to start.")).toBeVisible();
    await expect(messageCard.getByRole("button", { name: "Write the message" })).toBeVisible();
  });

  test("writing the message: a truthful provider failure, or (if it succeeds) a real recipient-confirm gate", async ({
    leadPage: page,
  }) => {
    const messageCard = page.locator("section").filter({ has: page.getByRole("heading", { name: "Message to the store", level: 2 }) });
    await messageCard.getByRole("button", { name: "Write the message" }).click();

    const errorAlert = messageCard.getByRole("alert");
    const toField = messageCard.getByLabel("To");
    await Promise.race([
      errorAlert.waitFor({ state: "visible", timeout: 30_000 }).catch(() => undefined),
      toField.waitFor({ state: "visible", timeout: 30_000 }).catch(() => undefined),
    ]);

    if (await toField.isVisible().catch(() => false)) {
      // A real AI provider key is configured on this deployment: exercise the
      // actual recipient-confirm gate (D18) rather than skip it.
      const checkbox = messageCard.getByRole("checkbox", { name: "This is the right recipient" });
      await expect(checkbox).toBeVisible();
      await expect(checkbox).not.toBeChecked();

      await toField.fill("someone-else@not-e2e-claim.example");
      await messageCard.getByRole("button", { name: "Approve & send" }).click();
      await expect(messageCard.getByRole("alert")).toContainText("Confirm this recipient before sending");
    } else {
      // FINDING: none -- expected, truthful outcome. The deployment's OpenAI
      // key is a placeholder (D83 item 3), so draft generation genuinely
      // fails; the UI must show that failure, never a fabricated draft.
      await expect(errorAlert).toBeVisible({ timeout: 30_000 });
      await expect(errorAlert).not.toHaveText("");
    }
  });

  test("ledger: confirming a credit updates the unresolved balance, and a later charge shows as \"Charged again\"", async ({
    leadPage: page,
  }) => {
    const ledgerCard = page.locator("section").filter({ has: page.getByRole("heading", { name: "Ledger", level: 2 }) });
    // The Figure row is the ledger card's second <dl> (the first is LedgerBar's
    // own legend); dd order is fixed: Unresolved, Confirmed, Charged again.
    const figures = ledgerCard.locator("dl").nth(1).locator("dd");
    await expect(figures.nth(0)).toHaveText("$25.00"); // Unresolved
    await expect(figures.nth(1)).toHaveText("$0.00"); // Confirmed (no ledger events yet)

    const moneyCard = page.locator("section").filter({ has: page.getByRole("heading", { name: "Record money", level: 2 }) });
    const creditForm = moneyCard.locator("details").filter({ has: page.getByText("Credit landed") });
    await creditForm.locator("summary").click();
    await creditForm.getByLabel(/^Amount/).fill("15.00");
    await creditForm.getByLabel("Where you saw it").fill("Card statement, E2E test");
    await creditForm.getByRole("button", { name: "Confirm credit" }).click();

    await expect(figures.nth(0)).toHaveText("$10.00"); // Unresolved: 25 - 15
    await expect(figures.nth(1)).toHaveText("$15.00"); // Confirmed

    const debitForm = moneyCard.locator("details").filter({ has: page.getByText("Charged again") });
    await debitForm.locator("summary").click();
    await debitForm.getByLabel(/^Amount/).fill("5.00");
    await debitForm.getByLabel("Where you saw it").fill("Card statement, second charge");
    await debitForm.getByRole("button", { name: "Record charge" }).click();

    await expect(figures.nth(2)).toHaveText("$5.00"); // Charged again
    await expect(figures.nth(0)).toHaveText("$15.00"); // Unresolved: 25 - 15 + 5
  });
});
