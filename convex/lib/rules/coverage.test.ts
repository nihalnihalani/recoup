/**
 * DA-A-11 / D145 (c)/(d): a coverage row can reach `implemented_verified` only from a pack `activation.ts` activated —
 * never from a test pack, even while a test forces packs active through the registry seam (C3).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("./registry", async () => await import("./testRegistry"));

import { ACTIVATIONS } from "./activation";
import { IMPLEMENTED_PACKS, resolveActivePacks, SCENARIOS_BY_CATEGORY } from "./applicable";
import { coverageRows, pathsNotChecked, SCENARIO_TITLES } from "./coverage";
import * as registry from "./registry";
import { resetTestRegistry, setTestActivations } from "./testRegistry";
import { LIVE_VERIFICATIONS } from "./verification";

describe("coverage (production activation only)", () => {
  it("the mocked registry reports R01 v1 active (the C3 seam works)…", () => {
    resetTestRegistry();
    expect(registry.REGISTRY_KIND).toBe("test");
    expect(registry.activePack("R01")?.ruleId).toBe("R01.retail_price_adjustment");
  });

  it("…but coverage.ts still reports R01 as not checked: it reads activation.ts, never a registry", () => {
    const r01 = coverageRows().find((r) => r.scenarioId === "R01")!;
    if (ACTIVATIONS.length === 0) {
      expect(r01.status).toBe("not_checked");
      expect(coverageRows().some((r) => r.status === "implemented_verified")).toBe(false);
    }
  });

  it("DA-B-14 (D196): an active pack without a live-verification record is implemented_live_unverified, never implemented_verified", () => {
    expect(LIVE_VERIFICATIONS).toEqual([]); // stays empty this mission
    const active = resolveActivePacks(ACTIVATIONS, IMPLEMENTED_PACKS);
    expect(active.length).toBeGreaterThan(0); // R01 v1 is active (D186): the check below is not vacuous
    for (const pack of active) {
      expect(coverageRows().find((r) => r.scenarioId === pack.scenarioId)).toMatchObject({ status: "implemented_live_unverified", ruleId: pack.ruleId });
    }
    expect(coverageRows().some((r) => r.status === "implemented_verified")).toBe(false);
  });

  it("the test registry can be narrowed and reset", () => {
    setTestActivations([{ ruleId: "R01.retail_price_adjustment", version: 1, status: "withdrawn", decision: "TEST" }]);
    expect(registry.activePack("R01")).toBeNull();
    resetTestRegistry();
    expect(registry.activePack("R01")).not.toBeNull();
  });

  it("covers R01–R25 with no amounts, and lists paths not checked per category", () => {
    const rows = coverageRows();
    expect(rows.map((r) => r.scenarioId)).toEqual(Object.keys(SCENARIO_TITLES));
    expect(rows).toHaveLength(25);
    for (const r of rows) expect(JSON.stringify(r)).not.toMatch(/amount|\$\d/i);
    // iPhone case (mission §12): the retail list names R06–R08 (exact guide), R10, R11 without a serial, R23.
    const retail = pathsNotChecked("retail_order").map((r) => r.scenarioId);
    expect(retail).toEqual(expect.arrayContaining(["R06", "R07", "R08", "R10", "R11", "R23"]));
    expect(pathsNotChecked("retail_order").find((r) => r.scenarioId === "R06")?.reason).toContain("exact benefit guide");
    expect(pathsNotChecked("retail_order").find((r) => r.scenarioId === "R11")?.reason).toContain("serial");
    for (const cat of Object.keys(SCENARIOS_BY_CATEGORY) as (keyof typeof SCENARIOS_BY_CATEGORY)[]) {
      for (const r of pathsNotChecked(cat)) expect(SCENARIOS_BY_CATEGORY[cat]).toContain(r.scenarioId);
    }
  });
});
