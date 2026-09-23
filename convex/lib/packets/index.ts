/**
 * The packet template registry (M20). Each pack lane adds its templates here in its own commit (M21: R05/R03,
 * M22: R02/R04), the same way packs join `IMPLEMENTED_PACKS`. A template renders only for its exact pack version.
 */
import type { PacketTemplate } from "./common";

export const PACKET_TEMPLATES: readonly PacketTemplate[] = Object.freeze([]);

/** The template for a pack version: the named one, else the pack's first registered template; null when none. */
export function templateFor(ruleId: string, version: number, templateId?: string): PacketTemplate | null {
  const mine = PACKET_TEMPLATES.filter((t) => t.ruleId === ruleId && t.version === version);
  if (templateId !== undefined) return mine.find((t) => t.templateId === templateId) ?? null;
  return mine[0] ?? null;
}

/** A template by id (a packet keeps the id of the template its text came from). */
export function templateById(templateId: string): PacketTemplate | null {
  return PACKET_TEMPLATES.find((t) => t.templateId === templateId) ?? null;
}
