/**
 * C3 (D148): the unmodified freshness suite (which drives `priceWatch.recordCheck`) re-run with R01 v1 forced active
 * through the test-registry seam; `freshness.test.ts` runs on its own in the legacy mode.
 */
import { vi } from "vitest";

vi.mock("./lib/rules/registry", async () => await import("./lib/rules/testRegistry"));

import "./freshness.test";
