/**
 * The packet template registry (M20). Each pack lane adds its templates here in its own commit (M21: R05/R03,
 * M22: R02/R04), the same way packs join `IMPLEMENTED_PACKS`. A template renders only for its exact pack version.
 */
import type { PacketTemplate } from "./common";
import { r02V1Letter } from "./r02_v1";
import { r03V1Letter } from "./r03_v1";
import { r04V1Letter } from "./r04_v1";
import { r05V1Letter } from "./r05_v1";

export const PACKET_TEMPLATES: readonly PacketTemplate[] = Object.freeze([r05V1Letter, r03V1Letter, r02V1Letter, r04V1Letter]);

/**
 * D249: the template for a pack version, deterministically — the named one (`templateId`); else the one registered
 * for the claim's `remedyKey`; else, when the pack version registers exactly ONE template, that one. Anything else
 * (several templates and no match) is null: a letter is never guessed from the facts.
 */
export function selectTemplate(
  templates: readonly PacketTemplate[],
  ruleId: string,
  version: number,
  opts: { remedyKey?: string; templateId?: string } = {},
): PacketTemplate | null {
  const mine = templates.filter((t) => t.ruleId === ruleId && t.version === version);
  if (opts.templateId !== undefined) return mine.find((t) => t.templateId === opts.templateId) ?? null;
  if (opts.remedyKey !== undefined) {
    const forRemedy = mine.filter((t) => t.remedyKey === opts.remedyKey);
    if (forRemedy.length === 1) return forRemedy[0];
    if (forRemedy.length > 1) return null;
  }
  return mine.length === 1 ? mine[0] : null;
}

export function templateFor(ruleId: string, version: number, opts: { remedyKey?: string; templateId?: string } = {}): PacketTemplate | null {
  return selectTemplate(PACKET_TEMPLATES, ruleId, version, opts);
}

/** A template by id (a packet keeps the id of the template its text came from). */
export function templateById(templateId: string): PacketTemplate | null {
  return PACKET_TEMPLATES.find((t) => t.templateId === templateId) ?? null;
}
