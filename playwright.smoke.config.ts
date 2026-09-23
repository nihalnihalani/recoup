import { defineConfig, devices } from "@playwright/test";

/**
 * M08 (QA-9): the Convex URL the dev server's app talks to. Same resolution as `playwright.config.ts` -- kept in
 * sync there rather than imported from it (that file's own default export is what THIS run must never load).
 */
// `||`, not `??`: an unset GitHub secret arrives as an empty string.
const appConvexUrl = process.env.VITE_CONVEX_URL || process.env.E2E_CONVEX_URL;

/**
 * QA2-1 (P10-OW-12b re-review): the live-provider smoke suite's OWN Playwright config, deliberately separate
 * from `playwright.config.ts`. `e2e/smoke/live-provider.spec.ts` needs the target deployment NOT to be in
 * `RECOUP_PROVIDER_MODE=stub` -- the exact opposite of what `playwright.config.ts`'s `globalSetup`
 * (`e2e/global-setup.ts`) requires for every OTHER spec. Running the smoke spec under the main config (the first
 * version of this fix did) made it unable to execute under either provider mode: `globalSetup` refused a "live"
 * target before the spec ever started, and the spec's own `beforeAll` refused a "stub" target if `globalSetup`
 * were ever bypassed. Two configs, `testIgnore`/`testDir` partitioned so neither ever covers the other's specs
 * (pinned by `convex/lib/e2eSmokeSeparation.static.test.ts`), is the fix: this file has NO `globalSetup` at all
 * -- the spec's own `beforeAll` (`providerMode()` must report "live", never "stub") is the sole gate, run
 * per-spec rather than once for a whole suite because this config only ever runs the one smoke spec.
 *
 * Deliberately narrower than the main config in ways that matter for a suite that sends REAL mail and makes REAL
 * provider calls with REAL keys (D83, D104, D136 -- never run in CI, only by an authorized human against a named
 * disposable deployment):
 *  - `retries: 0`, never the main config's `1`: a retry would re-run "seed a real account, approve, and send a
 *    real email" a second time against the same real recipient/deployment. A flaky real-network step should be
 *    investigated, not silently retried into a duplicate real send.
 *  - One project (`desktop-chromium` only, never also `mobile`): the main config's two-project fan-out exists so
 *    the MOCKED suite covers both viewports cheaply; running this spec under two projects would send two real
 *    claim emails and provision two real AgentMail inboxes for one invocation, for no smoke-testing benefit.
 *
 * Usage (a lead action -- see this worker's report): `npx playwright test --config=playwright.smoke.config.ts`,
 * with `RECOUP_LIVE_SMOKE=1`, `RECOUP_LIVE_SMOKE_DEPLOYMENT` and `RECOUP_LIVE_SMOKE_RECIPIENT` set, against a
 * disposable deployment that is NOT `adorable-lion-138` and is NOT in stub mode.
 */
export default defineConfig({
  testDir: "./e2e/smoke",
  testMatch: "**/*.spec.ts",
  // No globalSetup here on purpose -- see the module doc comment above.
  timeout: 300_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: [["list"], ["html", { open: "never" }]],

  use: {
    // `||`: CI passes `secrets.E2E_BASE_URL`, which is "" when not configured. CI never actually runs this
    // config (RECOUP_LIVE_SMOKE is never set there, D104/D136); this mirrors the main config's own resolution.
    baseURL: process.env.E2E_BASE_URL || "http://localhost:5173",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },

  projects: [
    {
      name: "desktop-chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } },
    },
  ],

  // Boots the real dev server unless E2E_BASE_URL already points somewhere running -- identical to the main
  // config's own webServer block; see its comment for the full rationale.
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: "npm run dev",
        url: "http://localhost:5173",
        reuseExistingServer: !process.env.CI,
        timeout: 60_000,
        ...(appConvexUrl ? { env: { VITE_CONVEX_URL: appConvexUrl } } : {}),
      },
});
