import { defineConfig, devices } from "@playwright/test";

/**
 * M08 (QA-9): the Convex URL the dev server's app talks to. Locally neither
 * variable is usually set, and Vite reads VITE_CONVEX_URL from `.env.local`
 * exactly as before. In CI there is no `.env.local`, so the app gets the
 * dedicated E2E deployment's URL (`E2E_CONVEX_URL`). `e2e/fixtures.ts`
 * refuses to seed if this and the deploy key name different deployments,
 * or if either is production.
 */
// `||`, not `??`: an unset GitHub secret arrives as an empty string.
const appConvexUrl = process.env.VITE_CONVEX_URL || process.env.E2E_CONVEX_URL;

/**
 * T20 (P10 browser acceptance suite, D104). Runs against the app's own dev
 * server (`npm run dev`, Vite on 5173) talking to the disposable Convex dev
 * deployment `adorable-lion-138` (D83 item 3) -- the one deployment where
 * `E2E_SEED_ENABLED=true` (see `convex/testing.ts`, D95/D102) and where
 * `.env.local` already points `VITE_CONVEX_URL`/`VITE_CONVEX_SITE_URL`.
 * There is no separate "test build": the suite drives the real UI against
 * real (if disposable and seed-gated) backend data, per `e2e/README.md`.
 *
 * `workers: 1` and `fullyParallel: false`: every spec seeds/reads/mutates
 * rows on ONE shared deployment (a single `e2e.lead@example.com` fixture
 * account, plus per-test fresh accounts) and that deployment also carries
 * process-wide auth rate limits and daily budget counters (D01-ish global
 * counters) other lanes' backend tests reason about -- concurrent workers
 * would race each other's seeds/resets and could trip a global limiter for
 * everyone. One worker, tests within a file in declaration order.
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 1,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"], ["html", { open: "never" }]],

  use: {
    // `||`: CI passes `secrets.E2E_BASE_URL`, which is "" when not configured.
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
    {
      name: "mobile",
      use: { ...devices["Pixel 5"] },
    },
  ],

  // Boots the real dev server unless E2E_BASE_URL already points somewhere
  // running. CI's `e2e` job (.github/workflows/ci.yml) runs only when the
  // E2E_CONVEX_URL/E2E_DEPLOY_KEY secrets exist; without E2E_BASE_URL it
  // starts Vite here with VITE_CONVEX_URL = E2E_CONVEX_URL. Locally this
  // starts Vite (reading `.env.local`) and waits for it before any test runs.
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
