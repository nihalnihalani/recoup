/**
 * M16 (contract §11.1 row M16): the Mission 2 retail path in a real browser against the dev deployment, with R01 v1
 * ACTIVE there (D186): watch → buy → drop → R01 card → claim → prepare → acknowledge → confirm credit → dashboard.
 * The card path is asserted unconditionally: a deployment that shows no R01 card fails this spec (that is a finding,
 * never a fallback). The legacy path stays covered by the unit dual-mode tests (C3, `convex/r01Parity.test.ts`).
 *
 * Every step the USER takes happens in the browser: pasting the link, "I bought it", confirming the store's rule,
 * following the card to its claim, editing the message, reading the refusal, acknowledging it, recording the credit.
 * Only the provider calls the dev deployment cannot make (placeholder keys, D83) are seeded, each through the real
 * write path (D202):
 * - the policy research → `testing:seedRetrievedPolicy` (`policies.insertSnapshot`), seeded before the purchase;
 * - the scraper's price read → `testing:recordObservation` (`priceWatch.recordCheck`, the cron's own mutation);
 * - the model's draft → `testing:seedDraft` (`drafts.insert`, bound to the claim's evaluation like `generate`);
 * - the inbox provider → `testing:seedInbox` (a reserved `.example` address on the profile).
 *
 * Nothing is sent, and that is CHECKED (D202), not assumed. The draft's recipient is `help@<store>`, not the contact
 * of the rule the user confirmed (`care@<store>`), so D18 requires the "right recipient" tick, which this spec never
 * gives: `approveAndSend` refuses before anything is queued. (D18 lets an unticked recipient through only when it is
 * exactly the confirmed contact; `convex/testing.seeders.test.ts` shows that control case enqueues.) `testing:sendTrace`
 * is read before the attempt and after the refusal and must not change: no alert-mail row, no draft with an
 * `outboundId` (written in the same transaction as the provider enqueue), no approval, no claim queued or later.
 *
 * "Acknowledge" is the SEC-AI-4 content check: the user adds a phone number Recoup did not supply, `prepareSend`
 * refuses with `unverified_content`, and the user acknowledges exactly that finding (DA-B-11). The D18 refusal that
 * follows comes from `approveAndSend`, which the Composer calls only after `prepareSend` returned ok, so it proves the
 * acknowledged prepare passed. The other acknowledgeable refusals cannot arise here: the claim is inside its window,
 * and it asks exactly Recoup's estimate.
 *
 * A fresh account per project (`newEmail`, reset after the test), so the dashboard's totals are this flow's only.
 */
import {
  expect,
  purchaseItems,
  recordObservation,
  seedDraft,
  seedInbox,
  seedRetrievedPolicy,
  seedUser,
  sendTrace,
  signInSeeded,
  test,
} from "./fixtures";

const PAID = "120.00";
const OBSERVED_CENTS = 9_500;
const ESTIMATE = "$25.00"; // (12,000 − 9,500) × 1
const PHONE = "555-010-4477";

test.describe("R01 retail price adjustment, end to end", () => {
  test("watch → buy → drop → R01 card → claim → prepare → acknowledge → confirm credit → dashboard", async ({ page, newEmail }) => {
    test.setTimeout(240_000);
    const email = newEmail();
    const { userId } = seedUser(email);
    const store = `r01${Date.now().toString(36)}.example`;
    const productUrl = `https://${store}/p/trail-runner`;
    // The policy research's stand-in, BEFORE the purchase: the purchase's own scheduled research then finds a fresh
    // snapshot and skips this kind (and the placeholder-key research could not have read one anyway).
    seedRetrievedPolicy(userId, store);
    await signInSeeded(page, email);

    const name = `${store}: trail runner`; // the watch's default name (host + readable last path segment)
    let purchaseId = "";
    let claimId = "";

    await test.step("watch: paste the product link", async () => {
      await page.goto("/watching");
      await expect(page.getByRole("heading", { name: "Watching", exact: true })).toBeVisible();
      await page.getByLabel("Product link").fill(productUrl);
      await page.getByRole("button", { name: "Watch", exact: true }).click();
      await expect(page.locator("li").filter({ has: page.getByRole("heading", { name }) })).toBeVisible();
    });

    await test.step("buy: \"I bought it\" at $120.00, today", async () => {
      const card = page.locator("li").filter({ has: page.getByRole("heading", { name }) });
      await card.getByRole("button", { name: "I bought it" }).click();
      await card.getByLabel("Price you paid").fill(PAID);
      await card.getByRole("button", { name: "Start the window" }).click();
      await expect(page).toHaveURL(/\/purchases\/[^/?]+$/, { timeout: 15_000 });
      purchaseId = new URL(page.url()).pathname.split("/").pop()!;
      await expect(page.getByRole("heading", { level: 1 })).toContainText(new RegExp(store.split(".")[0], "i"));
    });

    await test.step("confirm the store's price-adjustment rule", async () => {
      const rule = page.getByRole("region", { name: "Price-adjustment rule" });
      await expect(rule.locator("p", { hasText: "days from purchase" })).toHaveText(/^14\s*days from purchase$/);
      await expect(rule.getByRole("link", { name: `care@${store}` })).toBeVisible();
      await rule.getByText("Read the rule").click();
      await expect(rule.getByText(/E2E fixture policy/).first()).toBeVisible();
      await expect(rule.getByText("Confirmed", { exact: true })).toHaveCount(0);
      await rule.getByText("Correct this").click();
      await rule.getByRole("button", { name: "Confirm this rule" }).click();
      await expect(rule.getByText("Confirmed", { exact: true })).toBeVisible();
    });

    await test.step("drop: the price read falls to $95.00 (the cron's write path)", async () => {
      const items = purchaseItems(purchaseId);
      expect(items, "the purchase made through the UI has its one watched item").toHaveLength(1);
      expect(items[0].productUrl).toBe(productUrl);
      const result = recordObservation({ itemId: items[0].itemId, observedCents: OBSERVED_CENTS, sourceUrl: productUrl });
      expect(result.accepted, `the observation was accepted (note: ${result.note ?? "none"})`).toBe(true);
      expect(result.claimId, `R01 v1 auto-opened the case (note: ${result.note ?? "none"})`).not.toBeNull();
      claimId = result.claimId!;
    });

    await test.step("the R01 card: estimate, rule, source, and the open claim", async () => {
      // Unconditional (the lead's ruling): R01 v1 is active on the deployment, so the card must be here.
      const card = page.getByRole("article", { name: "Retail price adjustment: recovery path" });
      await expect(card, "an R01 opportunity card on the purchase page").toBeVisible({ timeout: 20_000 });
      await expect(card.getByText("Claim open", { exact: true })).toBeVisible();
      await expect(card.getByText(/^Estimated recovery/).first()).toBeVisible();
      await expect(card.getByText(ESTIMATE, { exact: true }).first()).toBeVisible();
      await expect(card.getByText("An estimate, not a guarantee: the business decides.")).toBeVisible();
      await expect(card.getByText(/Rule R01\.retail_price_adjustment version 1/)).toBeVisible();
      await card.getByRole("link", { name: "Open the claim" }).click();
      await expect(page).toHaveURL(new RegExp(`/claims/${claimId}$`));
    });

    const messageCard = page.locator("section").filter({ has: page.getByRole("heading", { name: "Message to the store", level: 2 }) });

    await test.step("claim: what was asked for, and the draft (the model's stand-in)", async () => {
      await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();
      await expect(page.getByText("You asked for")).toBeVisible();
      await expect(page.getByText(ESTIMATE).first()).toBeVisible();
      seedInbox(userId);
      seedDraft({
        claimId,
        userId,
        to: `help@${store}`,
        subject: "Price adjustment request",
        body: `Hello, I paid $120.00 for these trail runners and your price has since dropped. Under your price promise, please refund the difference of ${ESTIMATE}. Thank you.`,
      });
      await expect(messageCard.getByLabel("To", { exact: true })).toHaveValue(`help@${store}`, { timeout: 15_000 });
      await expect(messageCard.getByRole("checkbox", { name: "This is the right recipient" })).not.toBeChecked();
      await expect(messageCard.getByText(/^Not an address on/)).toHaveCount(0);
    });

    await test.step("prepare → acknowledge: the unverified phone number, then the D18 recipient refusal; nothing sent", async () => {
      const body = messageCard.getByLabel("Message", { exact: true });
      await body.fill(`${await body.inputValue()} If it is easier, call me on ${PHONE}.`);
      const before = sendTrace(userId);
      expect(before).toEqual({ mailLogRows: 0, drafts: 1, draftsWithOutbound: 0, draftsApproved: 0, claimsQueuedOrLater: 0 });

      await messageCard.getByRole("button", { name: "Approve & send" }).click();
      const panel = messageCard.getByRole("region", { name: "Check these details before sending" });
      await expect(panel).toBeVisible({ timeout: 20_000 });
      await expect(panel.getByRole("listitem")).toHaveText([`phone ${PHONE}`]);
      await expect(panel.getByRole("heading", { name: "Check these details before sending" })).toBeFocused();

      await panel.getByRole("button", { name: "I checked these details — send anyway" }).click();
      await expect(messageCard.getByRole("alert").filter({ hasText: "Confirm this recipient before sending" })).toBeVisible({ timeout: 20_000 });
      await expect(messageCard.getByRole("list", { name: /^Delivery:/ })).toHaveCount(0);
      await expect(messageCard.getByRole("button", { name: "Approve & send" })).toBeEnabled();
      const after = sendTrace(userId);
      // eslint-disable-next-line no-console
      console.log(`[e2e] sendTrace before ${JSON.stringify(before)} after ${JSON.stringify(after)}`);
      expect(after, "no mail row, outbound, approval or queued claim after the refusal").toEqual(before);
    });

    const usd = page.getByRole("group", { name: "USD recovery" });
    const tileAmount = (label: string) =>
      usd.locator("dl > div").filter({ has: page.locator("dt", { hasText: new RegExp(`^${label}$`) }) }).locator("dd").first();

    await test.step("dashboard before the credit: the claim is Ready to ask, nothing recovered", async () => {
      await page.goto("/");
      await expect(usd).toBeVisible({ timeout: 20_000 });
      await expect(tileAmount("Ready to ask")).toHaveText(ESTIMATE);
      // Disjoint tiles: the opportunity and its claim share one loss, counted once, in the furthest step.
      await expect(tileAmount("Potential")).toHaveText("—");
      const recovered = page.getByRole("region", { name: "Recovered", exact: true });
      await expect(recovered.getByText("nothing confirmed back yet")).toBeVisible();
    });

    await test.step("confirm credit: $25.00 back to the card", async () => {
      await page.goto(`/claims/${claimId}`);
      await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();
      const moneyCard = page.locator("section").filter({ has: page.getByRole("heading", { name: "Record money", level: 2 }) });
      const creditForm = moneyCard.locator("details").filter({ has: page.getByText("Credit landed") });
      await creditForm.locator("summary").click();
      // DA-B-10: how it came back; only this answer is a cash credit.
      await creditForm.getByRole("radio", { name: /To my card or original payment/ }).check();
      await creditForm.getByLabel(/^Amount/).fill("25.00");
      await creditForm.getByLabel("Where you saw it").fill("Card statement, E2E R01 flow");
      await creditForm.getByRole("button", { name: "Confirm credit" }).click();

      const ledger = page.locator("section").filter({ has: page.getByRole("heading", { name: "Ledger", level: 2 }) });
      const figures = ledger.locator("dl").nth(1).locator("dd"); // Unresolved, Confirmed, Charged again
      await expect(figures.nth(0)).toHaveText("$0.00");
      await expect(figures.nth(1)).toHaveText(ESTIMATE);
      // The hero's label (the claim is settled), and the same words where the credit's route is shown.
      await expect(page.getByText("Back to your card or account").first()).toBeVisible();
      const afterCredit = sendTrace(userId);
      // eslint-disable-next-line no-console
      console.log(`[e2e] sendTrace after the credit ${JSON.stringify(afterCredit)}`);
      expect(afterCredit, "recording a credit sends nothing").toMatchObject({ mailLogRows: 0, draftsWithOutbound: 0, draftsApproved: 0 });
    });

    await test.step("dashboard after the credit: Recovered $25.00, and it is in no pipeline tile", async () => {
      await page.goto("/");
      const recovered = page.getByRole("region", { name: "Recovered", exact: true });
      await expect(recovered.getByText(ESTIMATE, { exact: true })).toBeVisible({ timeout: 20_000 });
      await expect(recovered.getByText(/as you confirmed it$/)).toBeVisible();
      // Each tile's own amount (M15c: the group's first line sums the tiles, so never scan the group's text).
      const tiles = usd.locator("dl > div");
      const count = await tiles.count();
      expect(count, "the USD tiles").toBeGreaterThanOrEqual(5);
      for (let i = 0; i < count; i++) {
        const label = await tiles.nth(i).locator("dt").innerText();
        await expect(tiles.nth(i).locator("dd").first(), `${label}: the recovered money is not also counted here`).toHaveText(/^(—|\$0\.00)$/);
      }
    });
  });
});
