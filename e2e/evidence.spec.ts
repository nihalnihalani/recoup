/**
 * M16 (D182 item c): ONE real authenticated upload through `POST /evidence/upload` on the dev deployment, to check
 * M13's content-hash normalizer against real Convex `_storage.sha256` (convex-test cannot: its storage computes
 * the hash its own way). The file is a tiny synthetic PDF made here; nothing real is ever uploaded.
 *
 * The upload uses the signed-in page's own Convex Auth token as the Bearer, exactly as the UI's upload does. The
 * stored hash is read back through the public `evidence.get` query with the same token (no seed function).
 */
import { createHash } from "node:crypto";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { authTokenOf, deploymentUrls, expect, signInFresh, test } from "./fixtures";

const evidenceGet = makeFunctionReference<"query", { evidenceId: string }, { contentHash: string; sizeBytes: number | null; mimeType: string | null; docType: string }>("evidence:get");

test.describe("evidence upload on the real deployment", () => {
  test("a synthetic PDF uploads with the page's own token and its stored contentHash is the lowercase hex SHA-256 of the bytes", async ({ page, newEmail }) => {
    await signInFresh(page, { email: newEmail() });
    const token = await authTokenOf(page);
    expect(token, "the signed-in page holds a Convex Auth token").not.toBeNull();

    const { cloudUrl, siteUrl } = deploymentUrls();
    const bytes = Buffer.from(`%PDF-1.4\n% Recoup e2e synthetic receipt ${Date.now()}\nBT (Synthetic receipt, not a real document) Tj ET\n%%EOF\n`);
    const res = await fetch(`${siteUrl}/evidence/upload`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "X-Doc-Type": "receipt", "Content-Type": "application/pdf", "Content-Length": String(bytes.byteLength) },
      body: bytes,
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as { evidenceId: string; duplicate: boolean; extractionStatus: string };
    expect(body.duplicate).toBe(false);

    const client = new ConvexHttpClient(cloudUrl);
    client.setAuth(token!);
    const row = await client.query(evidenceGet, { evidenceId: body.evidenceId });
    expect(row.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.contentHash).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(row.sizeBytes).toBe(bytes.byteLength);
    expect(row.mimeType).toBe("application/pdf");

    // The same bytes again are this user's duplicate, never a second stored copy.
    const again = await fetch(`${siteUrl}/evidence/upload`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "X-Doc-Type": "receipt", "Content-Type": "application/pdf", "Content-Length": String(bytes.byteLength) },
      body: bytes,
    });
    expect(await again.json()).toMatchObject({ evidenceId: body.evidenceId, duplicate: true });
  });
});
