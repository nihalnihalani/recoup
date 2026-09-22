/**
 * DA-B-14 (checkpoint B, D196): only a matching record in `verification.LIVE_VERIFICATIONS` promotes an active pack
 * from `implemented_live_unverified` to `implemented_verified`. Both lead-owned data files are mocked here (never
 * edited): R01 v1 active, and the live-verification list set per test.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LiveVerification } from "./verification";

const LIVE: LiveVerification[] = vi.hoisted(() => []);
vi.mock("./activation", () => ({ ACTIVATIONS: [{ ruleId: "R01.retail_price_adjustment", version: 1, status: "active", decision: "D186" }] }));
vi.mock("./verification", async (importOriginal) => ({ ...(await importOriginal<typeof import("./verification")>()), LIVE_VERIFICATIONS: LIVE }));

import { coverageRows } from "./coverage";

const R01_LIVE: LiveVerification = {
  ruleId: "R01.retail_price_adjustment", version: 1, deployment: "prod:recoup", verifiedOn: "2026-10-01", decision: "D999",
  evidence: "VERIFICATION.md#r01-v1-live",
};
function setLive(list: LiveVerification[]) {
  LIVE.length = 0;
  LIVE.push(...list);
}
afterEach(() => setLive([]));
const r01 = () => coverageRows().find((r) => r.scenarioId === "R01")!;

describe("DA-B-14: implemented_verified needs a live-verification record", () => {
  it("active, no record → implemented_live_unverified (verified locally, live pending)", () => {
    expect(r01()).toMatchObject({ status: "implemented_live_unverified", ruleId: "R01.retail_price_adjustment", version: 1 });
    expect(r01().reason).toMatch(/live verification pending/);
  });

  it("a matching record → implemented_verified", () => {
    setLive([R01_LIVE]);
    expect(r01()).toMatchObject({ status: "implemented_verified", ruleId: "R01.retail_price_adjustment", version: 1 });
  });

  it("a record for another version or rule, or a malformed one, promotes nothing", () => {
    for (const bad of [
      { ...R01_LIVE, version: 2 },
      { ...R01_LIVE, ruleId: "R01.other" },
      { ...R01_LIVE, verifiedOn: "Oct 1" },
      { ...R01_LIVE, decision: "lead said so" },
      { ...R01_LIVE, evidence: " " },
      { ...R01_LIVE, deployment: "" },
    ]) {
      setLive([bad]);
      expect(r01().status).toBe("implemented_live_unverified");
    }
  });

  it("scenarios with no active pack stay not_checked either way", () => {
    setLive([R01_LIVE]);
    expect(coverageRows().filter((r) => r.scenarioId !== "R01").every((r) => r.status === "not_checked")).toBe(true);
  });
});
