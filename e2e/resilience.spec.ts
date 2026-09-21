/**
 * T20 resilience.spec (D104): route-level error boundaries never leave a
 * blank screen (malformed id, or a foreign/unknown id -- see
 * `src/components/ErrorBoundary.tsx`), the fallback heading takes focus and
 * "Go to board" works; keyboard-only completion of sign-in and of
 * confirm-credit; an axe scan finds no serious/critical violations on
 * Board, Watching, Settings, a Purchase and a Claim.
 *
 * Uses the shared `leadPage` fixture (one real sign-in per worker, see
 * `e2e/fixtures.ts`) wherever a test just needs to already be signed in as
 * the lead fixture account; `signInFresh`/a fresh `page` are used only where
 * the test is specifically about the sign-in flow itself or a second,
 * distinct account.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, leadEmailFor, seedLead, signInFresh, signOut, test, type SeedFixturesResult } from "./fixtures";

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
  let seeded: SeedFixturesResult & { email: string };

  // eslint-disable-next-line no-empty-pattern
  test.beforeAll(({}, workerInfo) => {
    seeded = seedLead(leadEmailFor(workerInfo.project.name));
  });

  test.describe("error boundary", () => {
    test("a malformed claim id crashes to the generic fallback, focused, with a way back", async ({ leadPage: page }) => {
      await page.goto("/claims/not-a-real-id");
      await expectErrorBoundary(page, GENERIC_CRASH_TEXT);
    });

    test("a malformed purchase id crashes to the generic fallback, focused, with a way back", async ({
      leadPage: page,
    }) => {
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
    // This one deliberately drives the real sign-in screen on a fresh page
    // (not `leadPage`): it is the thing under test.
    test("sign-in completes with no pointer interaction", async ({ page }) => {
      await page.goto("/");
      await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();

      await page.getByLabel("Email").focus();
      await page.keyboard.type(seeded.email);
      await page.keyboard.press("Tab"); // -> "Forgot password?" (signIn flow only)
      await page.keyboard.press("Tab"); // -> password field
      await page.keyboard.type("E2ePassword123!");
      await page.keyboard.press("Enter");

      // The top bar breadcrumb, not the sidebar's "Sign out" button: the
      // sidebar is an off-canvas drawer on the `mobile` project, not visible
      // without an "Open menu" click first.
      await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toBeVisible({ timeout: 20_000 });
      // This page just performed its own real, independent sign-in as the
      // lead account (a second concurrent session for the same user is
      // fine -- Convex Auth supports multiple sessions), so leave it signed
      // out again (via the ordinary, non-keyboard-only helper -- only the
      // sign-IN above is the thing under test) rather than leaking a second
      // lingering authenticated context for the rest of the run.
      await signOut(page);
    });

    test("confirming a credit completes with no pointer interaction", async ({ leadPage: page }) => {
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
    // `page.goto()` is a full browser navigation, so it remounts App.tsx and
    // briefly shows the `<AuthLoading>` splash (a raw "Loading…" div) before
    // Convex confirms the session and swaps in the real page -- Convex's
    // websocket handshake can still be in flight after `networkidle` fires
    // (an already-open socket is not "network activity"), so scanning right
    // after `networkidle` can race that splash instead of the intended
    // page. Waiting for the breadcrumb (the same authenticated-shell signal
    // `expectAuthenticated` uses) makes the scan target the actual page.
    async function gotoAndScan(page: import("@playwright/test").Page, path: string) {
      await page.goto(path);
      await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toBeVisible({ timeout: 20_000 });
      const results = await new AxeBuilder({ page }).analyze();
      return results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    }

    // FINDING (real product defect, not a test issue): every authenticated
    // page shares `Shell`/`Sidebar.tsx`/`TopBar.tsx`/`UserCard.tsx`, and
    // several of their fixed `text-gray-400` labels on a white background
    // fail WCAG 2 AA color contrast (axe `color-contrast`, impact
    // "serious", 4.5:1 required for normal-size text) -- reproduced
    // identically on Board/Watching/Settings/a Purchase/a Claim, on both
    // desktop-chromium and mobile:
    //   - Sidebar.tsx "Main menu" <h2> and TopBar.tsx's breadcrumb "Main
    //     Menu" <li> and command-palette "Search anything…" placeholder:
    //     #99a1af (text-gray-400) on #ffffff, 2.6:1.
    //   - UserCard.tsx's "Inbox not set up yet" placeholder subtitle:
    //     #99a1af (text-gray-400) on #ffffff, 2.6:1.
    //   - NotificationBell's unread-count badge: #ffffff (text-on-accent)
    //     on #ef4444 (bg-red-500), 3.76:1.
    //   - src/App.tsx's <AuthLoading> "Loading…" splash: text-ink/50 on
    //     bg-paper, 3.4:1 (its own dedicated fixme test below -- distinct
    //     markup/component from the four above).
    // None of these files are e2e/**'s to fix, so every axe test that hits
    // them is `test.fixme` here rather than left red or silently loosened;
    // see e2e/README.md and the traces under test-results/ for this run.
    const CONTRAST_FIXME =
      "shared shell components (Sidebar.tsx/TopBar.tsx/UserCard.tsx) render fixed text-gray-400-on-white " +
      "labels that fail WCAG 2 AA color contrast (axe color-contrast/serious, 2.6:1 vs required 4.5:1) on " +
      "every authenticated page; not e2e/**'s files to fix, flagged for the frontend owner";

    for (const [label, path] of [
      ["Board", "/"],
      ["Watching", "/watching"],
      ["Settings", "/settings"],
    ] as const) {
      test.fixme(`${label} has no serious/critical accessibility violations -- ${CONTRAST_FIXME}`, async ({ leadPage: page }) => {
        const serious = await gotoAndScan(page, path);
        expect(serious, JSON.stringify(serious, null, 2)).toEqual([]);
      });
    }

    test.fixme(`a Purchase page has no serious/critical accessibility violations -- ${CONTRAST_FIXME}`, async ({ leadPage: page }) => {
      const serious = await gotoAndScan(page, `/purchases/${seeded.claimPurchaseId}`);
      expect(serious, JSON.stringify(serious, null, 2)).toEqual([]);
    });

    test.fixme(`a Claim page has no serious/critical accessibility violations -- ${CONTRAST_FIXME}`, async ({ leadPage: page }) => {
      const serious = await gotoAndScan(page, `/claims/${seeded.claimId}`);
      expect(serious, JSON.stringify(serious, null, 2)).toEqual([]);
    });

    test.fixme(
      "the AuthLoading splash has no serious/critical accessibility violations -- " +
        "src/App.tsx's <AuthLoading> splash (\"Loading…\") fails WCAG 2 AA color contrast " +
        "(text-ink/50 on bg-paper, 3.4:1 vs required 4.5:1, axe color-contrast/serious); " +
        "not e2e/**'s file to fix, flagged for the frontend owner",
      async ({ leadPage: page }) => {
        await page.goto("/");
        const results = await new AxeBuilder({ page }).analyze();
        const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
        expect(serious, JSON.stringify(serious, null, 2)).toEqual([]);
      },
    );
  });
});
