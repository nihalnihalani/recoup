// @vitest-environment node
/**
 * The gated PDF deployment check (M23, D203): refuses unless E2E seeding is enabled and the host is not production;
 * otherwise reads the synthetic PDF through storage and leaves nothing behind.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { internal } from "./_generated/api";
import { setup } from "./test.setup";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("testingPdf:extractSyntheticPdf", () => {
  it("refuses when E2E seeding is not enabled on the deployment", async () => {
    vi.stubEnv("E2E_SEED_ENABLED", "");
    const t = setup();
    await expect(t.action(internal.testingPdf.extractSyntheticPdf, {})).rejects.toThrow(/disabled on this deployment/);
  });

  it("refuses on the production host even when enabled", async () => {
    vi.stubEnv("E2E_SEED_ENABLED", "true");
    vi.stubEnv("CONVEX_SITE_URL", "https://cool-oyster-399.convex.site");
    const t = setup();
    await expect(t.action(internal.testingPdf.extractSyntheticPdf, {})).rejects.toThrow(/production deployment/);
  });

  it("reads the synthetic receipt through storage, reports the card-number verdict, and deletes the blob", async () => {
    vi.stubEnv("E2E_SEED_ENABLED", "true");
    vi.stubEnv("CONVEX_SITE_URL", "https://adorable-lion-138.convex.site");
    const t = setup();
    const receipt = await t.action(internal.testingPdf.extractSyntheticPdf, {});
    expect(receipt).toMatchObject({ status: "ok", pageCount: 1, panDetected: false });
    expect(receipt.textLength).toBeGreaterThan(100);
    expect(receipt.byteLength).toBeGreaterThan(0);
    const withCard = await t.action(internal.testingPdf.extractSyntheticPdf, { variant: "card_number" });
    expect(withCard).toMatchObject({ status: "ok", panDetected: true });
    const blobs = await t.run(async (ctx) => ctx.db.system.query("_storage").collect());
    expect(blobs).toHaveLength(0);
  });
});
