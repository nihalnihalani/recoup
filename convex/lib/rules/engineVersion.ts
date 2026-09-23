/**
 * The runtime engine version of a pack (DA-A-23 as refined by D197/D206(3)): `${ruleId}@v${version}/e${engineEpoch}`
 * from the lead-controlled `ENGINE_EPOCHS` (checked against the manifest by check-rule-packs). A pack with no epoch
 * entry — a test pack, or one never activated — keeps the wave-1 constant `ENGINE_VERSION`. Pure.
 */
import { ENGINE_EPOCHS } from "./engineEpochs";
import { ENGINE_VERSION } from "./types";

export function engineVersionFor(ruleId: string, version: number): string {
  const entry = ENGINE_EPOCHS.find((e) => e.ruleId === ruleId && e.version === version);
  return entry ? `${ruleId}@v${version}/e${entry.engineEpoch}` : ENGINE_VERSION;
}
