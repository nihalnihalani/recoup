/**
 * T20 auth.spec (D104): sign-up -> code -> verified session; wrong-password
 * copy is identical for an existing account and an unknown address (D91/D97:
 * `TOO_MANY_ATTEMPTS_MESSAGE === WRONG_CREDENTIALS_MESSAGE`, and a plain
 * wrong-password attempt never enumerates); reset flow reaches the code step
 * with the same neutral notice either way; sign-out; a direct route survives
 * a hard reload.
 */
import { expect, lastCodeFor, leadEmailFor, seedLead, signInFresh, signOut, test } from "./fixtures";

const WRONG_CREDENTIALS_MESSAGE = "Wrong email or password";
const RESET_NOTICE = "If that address has an account, a code is on its way.";

test.describe("auth", () => {
  // Only the "existing account, wrong password" and "direct-route reload"
  // cases below need the seeded lead account; seeding it once up front for
  // every test in this file is simpler than conditionally seeding per test.
  let leadEmail: string;
  // eslint-disable-next-line no-empty-pattern
  test.beforeAll(({}, workerInfo) => {
    leadEmail = leadEmailFor(workerInfo.project.name);
    seedLead(leadEmail);
  });

  test("sign-up through the real UI reaches a verified, authenticated session", async ({ page, newEmail }) => {
    const email = newEmail();
    await signInFresh(page, { email, name: "Fresh Signup" });

    // Authenticated shell (the top bar breadcrumb, not the sidebar -- the
    // sidebar is an off-canvas drawer on the `mobile` project and would not
    // be visible without an extra "Open menu" click), not the sign-in screen.
    await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText("Dashboard");
    await expect(page.getByRole("heading", { name: "Welcome back" })).toHaveCount(0);
  });

  test("wrong password gives identical copy for an existing account and an unknown address", async ({ page }) => {
    await page.goto("/");

    // Existing (seeded) account, wrong password.
    await page.getByLabel("Email").fill(leadEmail);
    await page.getByLabel("Password", { exact: true }).fill("DefinitelyWrongPassword123!");
    await page.getByRole("button", { name: "Sign in" }).click();
    const existingError = page.getByRole("alert");
    await expect(existingError).toHaveText(WRONG_CREDENTIALS_MESSAGE);

    // Unknown address, arbitrary password -- must read exactly the same (no enumeration).
    await page.getByLabel("Email").fill(`nobody.${Date.now()}@example.com`);
    await page.getByLabel("Password", { exact: true }).fill("AnyPasswordAtAll123!");
    await page.getByRole("button", { name: "Sign in" }).click();
    const unknownError = page.getByRole("alert");
    await expect(unknownError).toHaveText(WRONG_CREDENTIALS_MESSAGE);
  });

  test("password reset reaches the code step with the same neutral notice for a known and an unknown address", async ({
    page,
    newEmail,
  }) => {
    const known = newEmail();
    // Seed a real (verified) account so "known" is genuinely known.
    await signInFresh(page, { email: known, name: "Reset Known" });
    await signOut(page);

    // Known address.
    await page.getByRole("button", { name: "Forgot password?" }).click();
    await expect(page.getByRole("heading", { name: "Reset your password" })).toBeVisible();
    await page.getByLabel("Email").fill(known);
    await page.getByRole("button", { name: "Send reset code" }).click();
    await expect(page.getByRole("heading", { name: "Enter your new password" })).toBeVisible();
    await expect(page.getByRole("status")).toHaveText(RESET_NOTICE);

    // The code step is real: a code was actually captured for this address.
    await expect.poll(() => lastCodeFor(known), { timeout: 15_000, intervals: [250, 500, 1000] }).not.toBeNull();

    await page.getByRole("button", { name: "Back to sign in" }).click();

    // Unknown address reaches the exact same screen with the exact same notice.
    await page.getByRole("button", { name: "Forgot password?" }).click();
    await page.getByLabel("Email").fill(`nobody.reset.${Date.now()}@example.com`);
    await page.getByRole("button", { name: "Send reset code" }).click();
    await expect(page.getByRole("heading", { name: "Enter your new password" })).toBeVisible();
    await expect(page.getByRole("status")).toHaveText(RESET_NOTICE);
  });

  test("sign-out returns to the sign-in screen", async ({ page, newEmail }) => {
    const email = newEmail();
    await signInFresh(page, { email, name: "Sign Out Tester" });
    await signOut(page);
    await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  });

  test("a direct route survives a hard reload (session persists)", async ({ leadPage: page }) => {
    await page.goto("/watching");
    await expect(page.getByRole("heading", { name: "Watching" })).toBeVisible();

    await page.reload();

    // Still signed in: the Watching page renders again, not the sign-in screen.
    await expect(page.getByRole("heading", { name: "Watching" })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("heading", { name: "Welcome back" })).toHaveCount(0);
  });
});
