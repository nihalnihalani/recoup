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

    // F-T20-1 (was FIXME, now fixed by T24a): every authenticated page
    // shares `Shell`/`Sidebar.tsx`/`TopBar.tsx`/`UserCard.tsx`, and several
    // of their `text-gray-400` labels on a white background failed WCAG 2 AA
    // color contrast (axe `color-contrast`, impact "serious", 4.5:1 required
    // for normal-size text) -- reproduced identically on Board/Watching/
    // Settings/a Purchase/a Claim, on both desktop-chromium and mobile:
    //   - Sidebar.tsx "Main menu" <h2>, TopBar.tsx's breadcrumb "Main Menu"
    //     <li> and command-palette "Search anything…" placeholder, and
    //     UserCard.tsx's "Inbox not set up yet" placeholder subtitle: were
    //     #99a1af (text-gray-400) on #ffffff, 2.6:1 -- now text-gray-600
    //     (#4a5565), 7.56:1.
    //   - NotificationBell's unread-count badge: was #ffffff (text-on-accent)
    //     on #ef4444 (bg-red-500), 3.76:1 -- now on #b91c1c (bg-red-700),
    //     6.47:1.
    //   - src/App.tsx's <AuthLoading> "Loading…" splash: was text-ink/50 on
    //     bg-paper, 3.4:1 -- now text-ink/70, 6.60:1 (its own test below --
    //     distinct markup/component from the four above).
    // Settings/a Purchase/a Claim/AuthLoading had no other color-contrast
    // violation once F-T20-1's own markup was fixed, so those four were real
    // passing tests below already. Board and Watching had turned up NEW
    // findings once F-T20-1's violations stopped masking them (axe only
    // reports what it can currently see) -- outside T24a's own ownership
    // (Sidebar.tsx/TopBar.tsx/UserCard.tsx/NotificationBell.tsx/App.tsx's
    // AuthLoading splash only) -- and were flagged `test.fixme` for the
    // frontend owner. F-T24-1/D114 (T19), both re-verified (desktop-chromium
    // AND mobile) against the live adorable-lion-138 deployment:
    //   - `src/pages/Watching.tsx`'s "Watch a product" form helper text
    //     (`<p class="text-xs text-gray-400">Works with retailers and
    //     marketplaces alike...</p>`): was #99a1af on #ffffff, 2.6:1 -- now
    //     text-gray-600 (#4a5565), 7.56:1. Passes cleanly, both projects --
    //     flipped to a real test below.
    //   - `src/components/dashboard/ActivityTimeline.tsx`'s per-event
    //     timestamp (`<p class="mt-0.5 text-xs tabular-nums text-gray-400">`,
    //     rendered on Board's "Recent activity" card): was #99a1af on
    //     #ffffff, 2.6:1 -- now text-gray-600 (#4a5565), 7.56:1, and no
    //     longer the reported violation -- BUT fixing it unmasked a THIRD,
    //     different one on the same page (same masking pattern as F-T20-1's
    //     own fix did for these two), so Board stays `test.fixme`:
    //     `RecentNote` in `src/components/dashboard/parts.tsx:29` (the
    //     "Recent" pill next to "Recent activity", title="recent activity
    //     (up to 40 watches, 40 purchases, last 12 checks per item)"):
    //     `text-gray-500` on `bg-gray-100`, #6a7282 on #f3f4f6, 4.39:1 vs
    //     4.5:1 required -- reproduces on both desktop-chromium and mobile.
    //     Not ActivityTimeline.tsx/Watching.tsx (T19's own contrast-line
    //     scope) and not parts.tsx (outside T19's file ownership), so left
    //     for the next frontend owner rather than fixed here.
    const BOARD_CONTRAST_FIXME =
      "NEW finding once ActivityTimeline.tsx's own timestamp was fixed (F-T24-1/D114/T19) unmasked a THIRD " +
      "violation on the same page (axe only reports what it can see): src/components/dashboard/parts.tsx:29's " +
      "RecentNote pill, #6a7282 (text-gray-500) on #f3f4f6 (bg-gray-100), 4.39:1 vs required 4.5:1 (axe " +
      "color-contrast/serious, reproduces on desktop-chromium and mobile); not T19's files to fix " +
      "(ActivityTimeline.tsx/Watching.tsx contrast lines only), flagged for the next frontend owner";

    test.fixme(
      `Board has no serious/critical accessibility violations -- ${BOARD_CONTRAST_FIXME}`,
      async ({ leadPage: page }) => {
        const serious = await gotoAndScan(page, "/");
        expect(serious, JSON.stringify(serious, null, 2)).toEqual([]);
      },
    );

    test("Watching has no serious/critical accessibility violations", async ({ leadPage: page }) => {
      const serious = await gotoAndScan(page, "/watching");
      expect(serious, JSON.stringify(serious, null, 2)).toEqual([]);
    });

    test("Settings has no serious/critical accessibility violations", async ({ leadPage: page }) => {
      const serious = await gotoAndScan(page, "/settings");
      expect(serious, JSON.stringify(serious, null, 2)).toEqual([]);
    });

    test("a Purchase page has no serious/critical accessibility violations", async ({ leadPage: page }) => {
      const serious = await gotoAndScan(page, `/purchases/${seeded.claimPurchaseId}`);
      expect(serious, JSON.stringify(serious, null, 2)).toEqual([]);
    });

    test("a Claim page has no serious/critical accessibility violations", async ({ leadPage: page }) => {
      const serious = await gotoAndScan(page, `/claims/${seeded.claimId}`);
      expect(serious, JSON.stringify(serious, null, 2)).toEqual([]);
    });

    test("the AuthLoading splash has no serious/critical accessibility violations", async ({ leadPage: page }) => {
      await page.goto("/");
      const results = await new AxeBuilder({ page }).analyze();
      const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
      expect(serious, JSON.stringify(serious, null, 2)).toEqual([]);
    });
  });
});
