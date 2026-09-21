/**
 * Shared Playwright fixtures for the T20 browser suite (D104).
 *
 * Seeding/reset goes through `convex/testing.ts` (T20a, D83/D95/D102), which
 * only exists on the disposable dev deployment `adorable-lion-138` and only
 * runs when that deployment has `E2E_SEED_ENABLED=true`. Every export there
 * is `internal` (never a public Convex function), so a test process cannot
 * reach it through the browser client -- it is invoked the same way a human
 * operator would, out of band, via the Convex CLI's `run` command (works for
 * internal functions because the CLI authenticates as the deployment admin,
 * not as an end user). `runConvex()` below shells out to the locally
 * installed CLI binary directly (`node_modules/.bin/convex`, no `npx`
 * resolution overhead) and reads which deployment to target from
 * `CONVEX_DEPLOYMENT` -- the environment if it is already set (CI), else
 * `.env.local` (local dev, same file `npx convex dev` itself writes).
 *
 * `signInFresh()` never calls `testing:seedUser` -- it drives the REAL
 * sign-up UI end to end (name/email/password -> "Check your email" ->
 * `testing:lastCodeFor` -> code entry -> authenticated session), because
 * that is the one flow T08's whole auth screen exists to cover and no seed
 * shortcut can stand in for it. `signInSeeded()` signs in the one
 * pre-seeded fixture account (`e2e.lead@example.com`) that specs read
 * purchase/claim/watch data from without paying the sign-up+verify cost on
 * every test.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test as base, expect, type Page } from "@playwright/test";

export { expect };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "..");
const CONVEX_BIN = path.join(REPO_ROOT, "node_modules", ".bin", "convex");

/** D83 item 3 / D95: the only deployment this suite is meant to run against. */
const EXPECTED_DEPLOYMENT_MARKER = "adorable-lion-138";
/** D83 item 6 / D95 / D102: never run seeding against this one, whatever env points at it. */
const PRODUCTION_HOST_MARKER = "cool-oyster-399";

export const SEEDED_EMAIL = "e2e.lead@example.com";
export const SEEDED_PASSWORD = "E2ePassword123!";
export const CODE_LENGTH = 8;

// ---------------------------------------------------------------------------
// Deployment resolution + the `convex run` shell-out
// ---------------------------------------------------------------------------

let cachedDeployment: string | null = null;

/** `CONVEX_DEPLOYMENT`, from the environment if set, else parsed out of `.env.local` (same source `npx convex dev` writes). */
function resolveDeployment(): string {
  if (cachedDeployment) return cachedDeployment;
  if (process.env.CONVEX_DEPLOYMENT) {
    cachedDeployment = process.env.CONVEX_DEPLOYMENT;
    return cachedDeployment;
  }
  const envLocalPath = path.join(REPO_ROOT, ".env.local");
  let contents: string;
  try {
    contents = readFileSync(envLocalPath, "utf8");
  } catch {
    throw new Error(
      `e2e/fixtures.ts: CONVEX_DEPLOYMENT is not set and ${envLocalPath} does not exist. ` +
        `Run "npx convex dev" once to link a deployment, or set CONVEX_DEPLOYMENT / E2E_CONVEX_URL yourself.`,
    );
  }
  const match = contents.match(/^CONVEX_DEPLOYMENT=(\S+)/m);
  if (!match) {
    throw new Error(`e2e/fixtures.ts: no CONVEX_DEPLOYMENT= line found in ${envLocalPath}.`);
  }
  cachedDeployment = match[1];
  return cachedDeployment;
}

/**
 * Defense in depth on top of `testing.ts`'s own server-side guard (D95/D102):
 * fail fast, client-side, with a clear message, rather than relying only on
 * the deployment throwing back a ConvexError for every seed/reset call.
 */
function assertSafeDeployment(deployment: string): void {
  if (deployment.includes(PRODUCTION_HOST_MARKER)) {
    throw new Error(
      `e2e/fixtures.ts: refusing to run -- CONVEX_DEPLOYMENT ("${deployment}") looks like the production deployment.`,
    );
  }
  if (!deployment.includes(EXPECTED_DEPLOYMENT_MARKER) && process.env.E2E_ALLOW_UNKNOWN_DEPLOYMENT !== "true") {
    throw new Error(
      `e2e/fixtures.ts: CONVEX_DEPLOYMENT ("${deployment}") is not the documented disposable deployment ` +
        `("${EXPECTED_DEPLOYMENT_MARKER}", D83 item 3). Set E2E_ALLOW_UNKNOWN_DEPLOYMENT=true to override ` +
        `(e.g. a CI-provisioned preview deployment).`,
    );
  }
}

/**
 * Invokes one `convex/testing.ts` internal function via the CLI and parses
 * its result. The CLI prints the return value as `JSON.stringify(value, null,
 * 2)`; a `null`/`undefined` return prints nothing at all.
 */
function runConvex<T = unknown>(fn: string, args: Record<string, unknown> = {}): T {
  const deployment = resolveDeployment();
  assertSafeDeployment(deployment);
  let stdout: string;
  try {
    stdout = execFileSync(CONVEX_BIN, ["run", fn, JSON.stringify(args)], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { ...process.env, CONVEX_DEPLOYMENT: deployment },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const stderr = err && typeof err === "object" && "stderr" in err ? String((err as { stderr: unknown }).stderr) : "";
    throw new Error(`convex run ${fn} failed: ${stderr || (err instanceof Error ? err.message : String(err))}`);
  }
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return null as T;
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    return trimmed as unknown as T;
  }
}

// ---------------------------------------------------------------------------
// testing.ts wrappers
// ---------------------------------------------------------------------------

export function seedUser(email: string, password = SEEDED_PASSWORD): { userId: string } {
  return runConvex<{ userId: string }>("testing:seedUser", { email, password });
}

export type SeedFixturesResult = {
  activeWatchId: string;
  boughtWatchId: string;
  boughtPurchaseId: string;
  claimPurchaseId: string;
  claimId: string;
  offerIds: string[];
  mailLogIds: string[];
};

export function seedFixtures(userId: string): SeedFixturesResult {
  return runConvex<SeedFixturesResult>("testing:seedFixtures", { userId });
}

export function lastCodeFor(email: string): string | null {
  return runConvex<string | null>("testing:lastCodeFor", { email });
}

export function resetUser(email: string): { deleted: boolean } {
  return runConvex<{ deleted: boolean }>("testing:resetUser", { email });
}

/** Seeds (after a clean reset) a fresh copy of the shared, read-mostly `e2e.lead@example.com` fixture set. */
export function seedLead(): SeedFixturesResult & { userId: string } {
  resetUser(SEEDED_EMAIL);
  const { userId } = seedUser(SEEDED_EMAIL, SEEDED_PASSWORD);
  const fixtures = seedFixtures(userId);
  return { userId, ...fixtures };
}

// ---------------------------------------------------------------------------
// Unique per-test emails (e2e.<runId>.<n>@example.com)
// ---------------------------------------------------------------------------

/** Stable per-worker-process run id; combined with a per-call counter this can never collide within a run. */
const RUN_ID = `${Date.now().toString(36)}${process.pid.toString(36)}`;
let emailCounter = 0;

export function newE2EEmail(): string {
  emailCounter += 1;
  return `e2e.${RUN_ID}.${emailCounter}@example.com`;
}

// ---------------------------------------------------------------------------
// UI-driving helpers
// ---------------------------------------------------------------------------

/** Visible once `<Authenticated>` has swapped the sign-in screen out for the app shell. */
async function expectAuthenticated(page: Page): Promise<void> {
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible({ timeout: 20_000 });
}

/**
 * Signs up a brand-new account through the real UI: name/email/password ->
 * "Check your email" -> fetches the just-issued code via `testing:lastCodeFor`
 * (the capture hook in `convex/lib/authMail.ts`, D102) -> enters it -> the
 * app swaps the sign-in screen for the authenticated shell. Leaves `page` on
 * the board, signed in.
 */
export async function signInFresh(
  page: Page,
  opts: { email: string; password?: string; name?: string },
): Promise<void> {
  const password = opts.password ?? SEEDED_PASSWORD;
  const name = opts.name ?? "E2E Tester";

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  await page.getByRole("button", { name: "Create an account" }).click();
  await expect(page.getByRole("heading", { name: "Create your account" })).toBeVisible();

  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Email").fill(opts.email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Create account" }).click();

  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible({ timeout: 15_000 });

  const code = await expect
    .poll(() => lastCodeFor(opts.email), { timeout: 15_000, intervals: [250, 500, 1000] })
    .not.toBeNull()
    .then(() => lastCodeFor(opts.email));
  if (!code) throw new Error(`signInFresh: no code was ever captured for ${opts.email}`);

  await page.getByLabel("Verification code").fill(code);
  await page.getByRole("button", { name: "Verify code" }).click();

  await expectAuthenticated(page);
}

/** Signs in the pre-seeded, already-verified `e2e.lead@example.com` fixture account. */
export async function signInSeeded(page: Page, email = SEEDED_EMAIL, password = SEEDED_PASSWORD): Promise<void> {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expectAuthenticated(page);
}

export async function signOut(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible({ timeout: 15_000 });
}

// ---------------------------------------------------------------------------
// The extended `test`: `newEmail()` mints unique addresses and resets every
// one of them (best-effort) when the test ends, so fresh-account tests never
// leak users into the shared deployment across runs.
// ---------------------------------------------------------------------------

type Fixtures = {
  newEmail: () => string;
};

export const test = base.extend<Fixtures>({
  // Playwright requires the first parameter to be an object-destructuring
  // pattern (it statically parses the function source to infer fixture
  // dependencies), hence the empty `{}` despite depending on nothing. The
  // second parameter is renamed from the idiomatic `use` to `provide`:
  // oxlint's react-hooks rule otherwise flags any parameter literally named
  // `use` as if it were a React hook.
  // eslint-disable-next-line no-empty-pattern
  newEmail: async ({}, provide) => {
    const created: string[] = [];
    await provide(() => {
      const email = newE2EEmail();
      created.push(email);
      return email;
    });
    for (const email of created) {
      try {
        resetUser(email);
      } catch (err) {
        // Best-effort cleanup: never fail a passing test over teardown, but don't hide it either.
        // eslint-disable-next-line no-console
        console.warn(`[e2e] resetUser(${email}) cleanup failed:`, err);
      }
    }
  },
});
