/**
 * P10-OW-12b (2026-09-23 re-audit): a live-provider smoke spec, deliberately
 * separate from the "mocked" e2e suite (D104: "Mocked-provider E2E and
 * real-provider smoke stay separate suites"). Where every other file under
 * `e2e/` now REQUIRES `RECOUP_PROVIDER_MODE=stub` (P10-OW-12,
 * `e2e/global-setup.ts`), this file is the opposite: it exists to prove
 * real provider connectivity, so it must run against a deployment that is
 * NOT in stub mode.
 *
 * Run ONLY via the dedicated `playwright.smoke.config.ts` (QA2-1, e.g.
 * `npx playwright test --config=playwright.smoke.config.ts`), never via the
 * default `npx playwright test` -- that config's `testIgnore` excludes this
 * directory, and this spec's own `beforeAll` refuses (see below) if it is
 * somehow reached under a run whose provider mode is "stub" anyway. The
 * main config's `globalSetup` (`e2e/global-setup.ts`) REQUIRES stub mode,
 * the opposite of what this file needs, which is why the two can never
 * share one Playwright run (QA2-1: the adversarial re-review of the first
 * version of this fix, which ran this spec under the main config and found
 * it could never execute under either mode).
 *
 * Skipped unless ALL of:
 *  - `RECOUP_LIVE_SMOKE=1` (explicit opt-in; never set in CI, D104/D136), AND
 *  - `RECOUP_LIVE_SMOKE_DEPLOYMENT` names the disposable deployment this run
 *    is authorized against, AND the deployment this run actually resolves
 *    to (`deploymentUrls()`, the same resolution `e2e/fixtures.ts` uses for
 *    every other spec) contains that name -- so a misconfigured env can
 *    only ever narrow which real deployment this can hit, never widen it.
 *    Refuses outright (does not merely skip) if the resolved target looks
 *    like the shared mocked-suite deployment (`adorable-lion-138`) or the
 *    documented production host (`cool-oyster-399`), whatever
 *    `RECOUP_LIVE_SMOKE_DEPLOYMENT` claims: this spec sends real mail and
 *    must never run against either.
 *  - `RECOUP_LIVE_SMOKE_RECIPIENT` names an address this run owns (a
 *    reserved test inbox). It is the ONLY address anything in this file
 *    ever sends to: it is `testing:seedUser`'s account address (verified
 *    directly through the seeding harness, D83/D95/D102 -- never through a
 *    real sign-up, see QA2-2 below) and the claim email's confirmed "To"
 *    (after ticking "This is the right recipient", D18 -- never by relying
 *    on it matching any seeded policy contact). Nothing here ever sends to
 *    a merchant: the "merchant" domain this file seeds is synthetic
 *    (`testing:seedFixtures`'s own e2e fixtures), and its policy contact
 *    (`help@e2e-claim.example`) is never used as a send target.
 *
 * Covers, all against real providers: approve, enqueue, the delivery status
 * that is reached (AgentMail send + component reconcile, all the way to a
 * genuine "Sent" when the provider round-trip finishes inside this test's
 * own budget -- QA2-2, docs/reviews/2026-09-23-P01-P12-reaudit.md's
 * P10-OW-12b row: "the smoke spec's delivery status reaches 'sent'"), and
 * one real price check (Firecrawl scrape + OpenAI extraction) via "Check
 * price now" on a seeded purchase item.
 *
 * QA2-2 (adversarial re-review): the first version of this file called
 * `testing:seedUser(recipient)` (creating a real, VERIFIED account) and
 * THEN drove the real sign-up UI (`signInFresh`) for the SAME address --
 * `convex/auth.ts`'s F2 `ACCOUNT_EXISTS` refusal made that combination
 * unreachable. Real sign-up is covered elsewhere by `e2e/auth.spec.ts`
 * (mocked suite) and is not this spec's job (its Done-when, above, is
 * approve/enqueue/delivery/price-check); this file now signs in to the
 * seeded account with the real sign-IN UI (`signInSeeded`) instead.
 *
 * Written to type-check under `npm run typecheck:e2e`. NEVER run in this
 * worker's environment (no provider keys here) -- the exact UI copy this
 * file waits on (the `Delivery:` rail's aria-name, the price-check button's
 * two names) was read from source, not observed live; re-verify both
 * against the target deployment's real UI on the first actual run and
 * adjust if the frontend has since changed (P10-OW-12b: a lead action, see
 * this worker's report).
 */
import { deploymentUrls, expect, providerMode, seedFixtures, seedUser, signInSeeded, test } from "../fixtures";

/** Same convention as `e2e/fixtures.ts`'s own `EXPECTED_DEPLOYMENT_MARKER`/`PRODUCTION_HOST_MARKER`. */
const SHARED_MOCKED_SUITE_DEPLOYMENT = "adorable-lion-138";
const PRODUCTION_HOST_MARKER = "cool-oyster-399";

const LIVE_SMOKE_ENABLED = process.env.RECOUP_LIVE_SMOKE === "1";
const NAMED_DEPLOYMENT = process.env.RECOUP_LIVE_SMOKE_DEPLOYMENT?.trim() || null;
const RECIPIENT = process.env.RECOUP_LIVE_SMOKE_RECIPIENT?.trim() || null;

/**
 * Resolves and validates the live-smoke target. Throws (refuses, not skips) if the resolved deployment looks
 * like the shared mocked-suite deployment or the documented production host, or if it does not contain the
 * name `RECOUP_LIVE_SMOKE_DEPLOYMENT` claims. Only called once every opt-in env is already confirmed present.
 */
function assertDisposableSmokeTarget(namedDeployment: string): void {
  const { cloudUrl, siteUrl } = deploymentUrls();
  for (const url of [cloudUrl, siteUrl]) {
    if (url.includes(SHARED_MOCKED_SUITE_DEPLOYMENT)) {
      throw new Error(
        `e2e/smoke/live-provider.spec.ts: refusing to run -- the target deployment ("${url}") is the shared ` +
          `mocked-suite deployment ("${SHARED_MOCKED_SUITE_DEPLOYMENT}"). This spec sends real mail and must ` +
          `run only against a dedicated, disposable deployment (P10-OW-12b).`,
      );
    }
    if (url.includes(PRODUCTION_HOST_MARKER)) {
      throw new Error(
        `e2e/smoke/live-provider.spec.ts: refusing to run -- the target deployment ("${url}") looks like the ` +
          `production deployment ("${PRODUCTION_HOST_MARKER}").`,
      );
    }
    if (!url.includes(namedDeployment)) {
      throw new Error(
        `e2e/smoke/live-provider.spec.ts: RECOUP_LIVE_SMOKE_DEPLOYMENT is "${namedDeployment}", but the ` +
          `resolved target ("${url}") does not name it. Refusing to guess which deployment this run means.`,
      );
    }
  }
}

test.describe("live-provider smoke (P10-OW-12b)", () => {
  const ready = LIVE_SMOKE_ENABLED && NAMED_DEPLOYMENT !== null && RECIPIENT !== null;
  test.skip(
    !ready,
    "opt-in only: set RECOUP_LIVE_SMOKE=1, RECOUP_LIVE_SMOKE_DEPLOYMENT and RECOUP_LIVE_SMOKE_RECIPIENT " +
      "(P10-OW-12b) -- never in CI (D104/D136).",
  );

  test.beforeAll(() => {
    if (!ready) return; // test.skip above already skips every test; this only guards the assertion below.
    assertDisposableSmokeTarget(NAMED_DEPLOYMENT!);
    // Belt-and-suspenders: this spec is meaningless (and unsafe to reason about) on a deployment that is
    // itself honouring RECOUP_PROVIDER_MODE=stub -- that would make every "real" call below a stub instead.
    const { mode } = providerMode();
    if (mode === "stub") {
      throw new Error(
        'e2e/smoke/live-provider.spec.ts: the target deployment reports provider mode "stub". This spec exists ' +
          "to prove real provider connectivity and must run against a deployment that is NOT in stub mode.",
      );
    }
  });

  test("approve, enqueue, the delivery status is reached, and one real price check", async ({ page }) => {
    // Generous: `reconcileSend`'s first two backoff hops alone (convex/drafts.ts BACKOFF_MS = [30s, 60s, …])
    // total 90s, on top of the price-check step's own real-provider wait -- see the "Sent" step below for why.
    test.setTimeout(300_000);
    const recipient = RECIPIENT!;

    // QA2-2: seeded (never signed up for real -- see the module doc comment for why) as the one allowed
    // recipient, so the real verification-code send this account's later flows might trigger
    // (`convex/lib/authMail.ts`) can only ever land on `recipient`, never a second, unlisted address.
    const { userId } = seedUser(recipient);
    const seeded = seedFixtures(userId);
    await signInSeeded(page, recipient);

    await test.step("one real price check: Check price now on a seeded purchase item", async () => {
      await page.goto(`/purchases/${seeded.boughtPurchaseId}`);
      const item = page.getByRole("region", { name: "E2E bought item" });
      await expect(item).toBeVisible();
      // QA2-2: `ItemTracker.tsx` renames this button to "Checking…" for the duration of the check (and disables
      // it) -- a locator scoped to the STATIC name "Check price now" stops matching anything the instant the
      // click lands, so `toBeDisabled()` right after would find zero elements and time out. One locator that
      // matches either name covers both the "before" and "during" state.
      const checkButton = item.getByRole("button", { name: /^(Check price now|Checking…)$/ });
      await expect(checkButton).toBeEnabled();
      await expect(checkButton).toHaveText("Check price now");
      await checkButton.click();
      // A real Firecrawl scrape + OpenAI extraction against the fixture's `.example` product URL, which never
      // resolves: this is a genuine attempt (never a fabricated price), truthfully expected to fail closed. The
      // button re-enabling (its own cooldown lapsing) is the generic, copy-independent signal that the check
      // actually ran to completion rather than hanging.
      await expect(checkButton).toBeDisabled();
      await expect(checkButton).toHaveText("Checking…");
      await expect(checkButton).toBeEnabled({ timeout: 45_000 });
    });

    await test.step("approve & send for real, to the one allowed recipient", async () => {
      await page.goto(`/claims/${seeded.claimId}`);
      const messageCard = page.locator("section").filter({ has: page.getByRole("heading", { name: "Message to the store", level: 2 }) });
      await messageCard.getByRole("button", { name: "Write the message" }).click();
      const toField = messageCard.getByLabel("To");
      const errorAlert = messageCard.getByRole("alert").first();
      await Promise.race([
        toField.waitFor({ state: "visible", timeout: 45_000 }).catch(() => undefined),
        errorAlert.waitFor({ state: "visible", timeout: 45_000 }).catch(() => undefined),
      ]);
      if (!(await toField.isVisible().catch(() => false))) {
        throw new Error(
          "e2e/smoke/live-provider.spec.ts: draft generation failed (see the claim page's own error alert for " +
            "the real OpenAI failure detail) -- cannot exercise approve/enqueue without a draft.",
        );
      }

      await toField.fill(recipient);
      const checkbox = messageCard.getByRole("checkbox", { name: "This is the right recipient" });
      await checkbox.check();
      await messageCard.getByRole("button", { name: "Approve & send" }).click();

      // "Enqueue": the draft carries a real outboundId the instant `approveAndSend` reaches the component --
      // the Delivery rail (`Composer.tsx`'s `<ol aria-label={"Delivery: " + delivery.note}>`) appears right
      // away, in the queued ("Sending…") state (`src/lib/delivery.ts`'s `SENDING`), before any reconcile hop.
      const delivery = messageCard.getByRole("list", { name: /^Delivery:/ });
      await expect(delivery).toBeVisible({ timeout: 30_000 });
      await expect(delivery).toHaveAccessibleName("Delivery: Sending…");
      // QA2-2: "the delivery status that is reached" is this spec's actual Done-when (re-audit P10-OW-12b:
      // "the smoke spec's delivery status reaches 'sent'"), not merely "queued" -- `reconcileSend` polls
      // AgentMail on a backoff (BACKOFF_MS[0]=30s, [1]=60s, …); wait through the first two hops for a genuine
      // "Sent" (never fabricated) before this test's own budget (`test.setTimeout` above) runs out.
      await expect(delivery).toHaveAccessibleName("Delivery: Sent", { timeout: 100_000 });
    });
  });
});
