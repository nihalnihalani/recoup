/**
 * M25 (contract §9 "Resilience (§14; M24 implements, M25 tests)", §11.2 row M25): the §14 states on the Mission 2
 * pages /add, /transactions/:id and /opportunities, in a real browser against the dev deployment (provider keys are
 * placeholders there, D83, so "provider outage" is the genuine state, never simulated):
 *   - offline → reconnect on /add and /transactions/:id (nothing is sent while offline; the same action works after);
 *   - session expiry mid-upload: the first POST /evidence/upload answers 401 → the client re-reads its token and
 *     retries ONCE → stored; a second 401 → "session expired", nothing stored, never a third try;
 *   - provider outage: a pasted email whose extraction fails shows as Failed with "Try again" (Settings), truthfully;
 *   - source-unverified copy: the coverage sentence says live verification is still pending, and an upload says it
 *     is stored, not read (live extraction off, D145);
 *   - direct-route refresh of /transactions/:id;
 *   - unknown and foreign ids: another user's transaction id, the same id once deleted, and a malformed id;
 *   - empty states: /opportunities and a fresh transaction's sections.
 * Fresh accounts per test (`newEmail`, reset after), so no state is shared with the lead fixture specs.
 */
import type { Page } from "@playwright/test";
import { expect, resetUser, seedUser, signInSeeded, signOut, test } from "./fixtures";

const NOT_FOUND_TEXT = "This item does not exist or belongs to another account.";
const GENERIC_CRASH_TEXT = "Something went wrong loading this page.";
const PENDING_VERIFICATION = /live verification is still pending/;

async function signedInFresh(page: Page, email: string) {
  seedUser(email);
  await signInSeeded(page, email);
}

/** A card charge entered by hand on /add; returns its transaction id (the page navigates to it). */
async function addCardCharge(page: Page, merchant: string, amount = "42.10"): Promise<string> {
  await page.goto("/add");
  await expect(page.getByRole("heading", { name: "Add a purchase or transaction", level: 1 })).toBeVisible({ timeout: 20_000 });
  const manual = page.getByRole("region", { name: "Enter it yourself" });
  await manual.getByRole("radio", { name: "Card charge" }).check();
  await manual.getByLabel("Merchant, as it appears on your statement").fill(merchant);
  await manual.getByLabel("Amount charged").fill(amount);
  await manual.getByRole("button", { name: "Add card charge" }).click();
  await expect(page).toHaveURL(/\/transactions\/[^/?]+$/, { timeout: 20_000 });
  await expect(page.getByRole("heading", { name: merchant, level: 1 })).toBeVisible();
  return new URL(page.url()).pathname.split("/").pop()!;
}

async function expectNotFound(page: Page, text: string) {
  const heading = page.getByRole("heading", { name: "This page couldn't load" });
  await expect(heading).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(text)).toBeVisible();
  await expect(page.getByRole("link", { name: "Go to board" })).toBeVisible();
}

const syntheticPdf = (tag: string) => ({
  name: `receipt-${tag}.pdf`,
  mimeType: "application/pdf",
  buffer: Buffer.from(`%PDF-1.4\n% Recoup e2e synthetic receipt ${tag}\nBT (Synthetic receipt, not a real document) Tj ET\n%%EOF\n`),
});

test.describe("resilience on the Mission 2 pages (§14)", () => {
  test("offline → reconnect on /add: nothing can be sent while offline, and the same entry saves after reconnecting", async ({ page, newEmail }) => {
    await signedInFresh(page, newEmail());
    await page.goto("/add");
    await expect(page.getByRole("heading", { name: "Add a purchase or transaction", level: 1 })).toBeVisible({ timeout: 20_000 });
    const manual = page.getByRole("region", { name: "Enter it yourself" });
    await manual.getByRole("radio", { name: "Card charge" }).check();
    await manual.getByLabel("Merchant, as it appears on your statement").fill("E2E OFFLINE SHOP");
    await manual.getByLabel("Amount charged").fill("19.99");

    await page.context().setOffline(true);
    await expect(manual.getByText("You're offline. Save when you're back online.")).toBeVisible();
    await expect(manual.getByRole("button", { name: "Add card charge" })).toBeDisabled();
    const upload = page.getByRole("region", { name: "Upload a document" });
    await expect(upload.getByText("You're offline. Upload when you're back online.")).toBeVisible();
    await expect(upload.getByRole("button", { name: "Upload and store" })).toBeDisabled();
    await expect(page.getByRole("region", { name: "Paste an email" }).getByText("You're offline. Paste again when you're back online.")).toBeVisible();
    // The connection strip appears after its short grace period, and never blanks the page.
    await expect(page.getByRole("status").filter({ hasText: "Reconnecting…" })).toBeVisible({ timeout: 15_000 });
    await expect(manual.getByLabel("Merchant, as it appears on your statement")).toHaveValue("E2E OFFLINE SHOP"); // the entry is kept

    await page.context().setOffline(false);
    await expect(page.getByRole("status").filter({ hasText: "Reconnecting…" })).toHaveCount(0, { timeout: 20_000 });
    await expect(manual.getByText("You're offline. Save when you're back online.")).toHaveCount(0);
    await manual.getByRole("button", { name: "Add card charge" }).click();
    await expect(page).toHaveURL(/\/transactions\/[^/?]+$/, { timeout: 20_000 });
    await expect(page.getByRole("heading", { name: "E2E OFFLINE SHOP", level: 1 })).toBeVisible();
  });

  test("offline → reconnect on /transactions/:id: the page stays, the strip shows, and live data resumes", async ({ page, newEmail }) => {
    await signedInFresh(page, newEmail());
    await addCardCharge(page, "E2E RECONNECT SHOP");
    const facts = page.getByRole("region", { name: "What Recoup knows" });
    await expect(facts).toBeVisible();
    await page.context().setOffline(true);
    await expect(page.getByRole("status").filter({ hasText: "Reconnecting…" })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("heading", { name: "E2E RECONNECT SHOP", level: 1 })).toBeVisible(); // never a blank page
    await expect(facts).toBeVisible();
    await page.context().setOffline(false);
    await expect(page.getByRole("status").filter({ hasText: "Reconnecting…" })).toHaveCount(0, { timeout: 20_000 });
    // Live again: a direct-route refresh renders the same transaction.
    await page.reload();
    await expect(page.getByRole("heading", { name: "E2E RECONNECT SHOP", level: 1 })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("region", { name: "Recovery paths" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Documents" })).toBeVisible();
  });

  test("session expiry mid-upload: a 401 on the first attempt → the token is re-read and the upload retried once → stored", async ({ page, newEmail }) => {
    await signedInFresh(page, newEmail());
    await page.goto("/add");
    const upload = page.getByRole("region", { name: "Upload a document" });
    await expect(upload).toBeVisible({ timeout: 20_000 });
    let attempts = 0;
    await page.route("**/evidence/upload", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      attempts += 1;
      if (attempts === 1) return route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "unauthorized" }) });
      return route.continue();
    });
    await upload.getByLabel("File").setInputFiles(syntheticPdf(`retry-${Date.now()}`));
    await upload.getByLabel(/What is this document\?/).selectOption({ label: "Receipt" });
    await upload.getByRole("button", { name: "Upload and store" }).click();
    await expect(upload.getByText(/^Stored: receipt-retry-/)).toBeVisible({ timeout: 20_000 });
    expect(attempts, "exactly one retry after the 401").toBe(2);
    // Live extraction is off (D145): the stored file says it was not read.
    await expect(upload.getByText(/Not read automatically|stored|not read/i).first()).toBeVisible();
  });

  test("session expiry that persists: 401 twice → 'session expired', nothing stored, and no third attempt", async ({ page, newEmail }) => {
    await signedInFresh(page, newEmail());
    await page.goto("/add");
    const upload = page.getByRole("region", { name: "Upload a document" });
    await expect(upload).toBeVisible({ timeout: 20_000 });
    let attempts = 0;
    await page.route("**/evidence/upload", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      attempts += 1;
      return route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "unauthorized" }) });
    });
    await upload.getByLabel("File").setInputFiles(syntheticPdf(`expired-${Date.now()}`));
    await upload.getByLabel(/What is this document\?/).selectOption({ label: "Receipt" });
    await upload.getByRole("button", { name: "Upload and store" }).click();
    await expect(upload.getByText("Your session expired. Sign in again, then upload the file again. Nothing was stored.")).toBeVisible({ timeout: 20_000 });
    expect(attempts).toBe(2);
    await expect(upload.getByText(/^Stored:/)).toHaveCount(0);
  });

  test("provider outage: a pasted email whose extraction fails is shown as Failed with 'Try again', never as read", async ({ page, newEmail }) => {
    await signedInFresh(page, newEmail());
    await page.goto("/add");
    const pastePanel = page.getByRole("region", { name: "Paste an email" });
    await expect(pastePanel).toBeVisible({ timeout: 20_000 });
    await pastePanel.getByLabel("Email text").fill(`Order E2E-${Date.now()} confirmed. Rain jacket, 1 x $89.00. Northwind Outfitters (e2e fixture text).`);
    await pastePanel.getByRole("button", { name: "Add from this email" }).click();
    await expect(pastePanel.getByRole("status").filter({ hasText: "Added. Recoup is reading it now" })).toBeVisible({ timeout: 20_000 });

    // The reader cannot run on this deployment (placeholder model key): the event ends Failed, with a retry.
    await page.goto("/settings");
    const row = page.getByRole("row").filter({ hasText: "paste" });
    await expect(row.getByText("Failed", { exact: true })).toBeVisible({ timeout: 45_000 });
    await expect(row.getByRole("button", { name: "Try again" })).toBeVisible();
    await expect(page.getByText(/Nothing stuck/)).toHaveCount(0);
  });

  test("unknown and foreign ids: another user's transaction, the same id once deleted, and a malformed id", async ({ page, newEmail }) => {
    const owner = newEmail();
    await signedInFresh(page, owner);
    const ownersId = await addCardCharge(page, "E2E OWNER'S SHOP");
    await signOut(page);

    const other = newEmail();
    await signedInFresh(page, other);
    await page.goto(`/transactions/${ownersId}`);
    await expectNotFound(page, NOT_FOUND_TEXT);
    await expect(page.getByText("E2E OWNER'S SHOP")).toHaveCount(0);

    // The same id once it no longer exists: the identical message (a foreign id reveals nothing more than a missing one).
    resetUser(owner);
    await page.goto(`/transactions/${ownersId}`);
    await expectNotFound(page, NOT_FOUND_TEXT);

    await page.goto("/transactions/not-a-real-id");
    await expectNotFound(page, GENERIC_CRASH_TEXT);
  });

  test("empty states and the source-unverified copy on /opportunities, /add and a new transaction", async ({ page, newEmail }) => {
    await signedInFresh(page, newEmail());
    await page.goto("/opportunities");
    await expect(page.getByRole("heading", { name: "Recovery paths", level: 1 })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("heading", { name: "No recovery paths yet" })).toBeVisible();
    await expect(page.getByText(PENDING_VERIFICATION).first()).toBeVisible();
    await page.getByRole("link", { name: "Add something" }).click();
    await expect(page).toHaveURL(/\/add$/);
    await expect(page.getByText(PENDING_VERIFICATION).first()).toBeVisible();

    await addCardCharge(page, "E2E EMPTY SHOP");
    await expect(page.getByText("No recovery path applies to this transaction on what Recoup knows now.", { exact: false })).toBeVisible();
    const docs = page.getByRole("region", { name: "Documents" });
    await expect(docs).toBeVisible();
    // A direct-route refresh keeps the transaction (not a redirect to the board).
    const url = page.url();
    await page.reload();
    await expect(page).toHaveURL(url);
    await expect(page.getByRole("heading", { name: "E2E EMPTY SHOP", level: 1 })).toBeVisible({ timeout: 20_000 });
  });
});
