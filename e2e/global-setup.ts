/**
 * P10-OW-12 (2026-09-23 re-audit): Playwright global setup. Fails the whole
 * run, before any spec starts, unless the target deployment reports that it
 * is honouring `RECOUP_PROVIDER_MODE=stub` (`convex/testing.ts`'s
 * `providerMode` query, gated exactly like every other `convex/testing.ts`
 * export: `E2E_SEED_ENABLED=true` and never the documented production
 * host -- see `e2e/fixtures.ts`'s `runConvex`/`assertSafeTarget`).
 *
 * This is what turns "the suite is supposed to be isolated from live
 * providers" from a comment and a runbook instruction into a fact the suite
 * checks for itself on every run: if the flag was never set on the target
 * deployment (a lead action -- this file cannot set it), the run refuses to
 * start rather than quietly making real Firecrawl/OpenAI/ShopSavvy/AgentMail
 * calls with real keys.
 */
import { providerMode } from "./fixtures";

export default function globalSetup(): void {
  const { mode } = providerMode();
  if (mode !== "stub") {
    throw new Error(
      `e2e/global-setup.ts: the target deployment reports provider mode "${mode}", not "stub" (P10-OW-12). ` +
        `Set RECOUP_PROVIDER_MODE=stub on that deployment before running the e2e suite -- see e2e/README.md. ` +
        `Refusing to start: this deployment now carries real provider keys, and a non-stub run would make ` +
        `live Firecrawl/OpenAI/ShopSavvy/AgentMail calls.`,
    );
  }
}
