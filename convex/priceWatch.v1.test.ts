/**
 * C3 (D148): the ENTIRE unmodified legacy price-watch suite, re-run with R01 v1 forced active through the
 * test-registry seam. `priceWatch.test.ts` also runs on its own (legacy fallback: no pack active in production until
 * the lead's activation commit), so every R01 behaviour test there runs in both modes.
 */
import { vi } from "vitest";

vi.mock("./lib/rules/registry", async () => await import("./lib/rules/testRegistry"));

import "./priceWatch.test";
