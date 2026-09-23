/**
 * TEST-ONLY kit for M20's scenario-case tests (not a Convex module: the name has two dots). A fake wave-2 pack with a
 * facts adapter and a packet template, and registry-shaped / template-index-shaped exports so a test file can swap
 * them in through `vi.mock`:
 *
 *   vi.mock("./lib/rules/registry", async () => await import("./testing/scenarioPack.kit"));
 *   vi.mock("./lib/packets/index", async () => await import("./testing/scenarioPack.kit"));
 *
 * The fake pack (`TEST.R13.fake_billing` v1, scenario R13, category card_charge) reads the transaction-level cells
 * `test.amount` (money), `test.outcome` (code; default eligible), `test.due` (instant; a user "notice" deadline),
 * `test.recipient` and `test.ref` (text), and binds amount/recipient/ref (N6). Its claims go by `postal_mail`.
 */
import type { Id } from "../_generated/dataModel";
import { cellLookup, resolveCell, type Cell } from "../lib/facts/resolve";
import { boundFactValues, type CellRow } from "../lib/facts/snapshot_retail";
import type { PacketTemplate } from "../lib/packets/common";
import { fill, formatMoney } from "../lib/packets/common";
import type { AnyRulePack, DeadlineResult, EvaluationResult, Outcome, RulePack, ScenarioId, TransactionCategory } from "../lib/rules/types";
import { emptyFlags } from "../lib/rules/types";

export const FAKE_RULE_ID = "TEST.R13.fake_billing";
export const FAKE_SCENARIO: ScenarioId = "R13";
export const FAKE_TEXT_BLOCK = "Under the Fake Billing Act, section 12, you must answer within 30 days.";
export const TXN = "txn";

type FakeSnapshot = { transactionId: Id<"transactions">; lookup: ReturnType<typeof cellLookup> };

function lookupOf(rows: readonly CellRow[]) {
  const grouped = new Map<string, { subjectKey: string; key: string; rows: CellRow["row"][] }>();
  for (const r of rows) {
    const id = `${r.subjectKey}\u0000${r.key}`;
    const g = grouped.get(id) ?? { subjectKey: r.subjectKey, key: r.key, rows: [] };
    g.rows.push(r.row);
    grouped.set(id, g);
  }
  const cells: Cell[] = [...grouped.values()].map((g) => resolveCell(g.subjectKey, g.key, g.rows));
  return cellLookup(cells.filter((c) => c.status !== "missing"));
}

const known = (c: Cell) => (c.status === "candidate" || c.known ? c.value : undefined);

function evaluateFake(input: Parameters<RulePack<FakeSnapshot, Record<string, never>>["evaluate"]>[0]): EvaluationResult {
  const { lookup, transactionId } = input.snapshot;
  const amount = known(lookup.get(TXN, "test.amount"));
  const outcomeCell = known(lookup.get(TXN, "test.outcome"));
  const due = known(lookup.get(TXN, "test.due"));
  const deadlines: DeadlineResult[] = [];
  if (due?.kind === "instant") {
    deadlines.push({
      id: "fake.notice", label: "Notice received by", obligor: "user", status: input.now > due.epochMs ? "passed" : "open",
      dueAt: due.epochMs, mustBe: "received", basis: "Fake Billing Act s. 12",
    });
  }
  let outcome: Outcome = amount?.kind === "money" ? "eligible" : "needs_facts";
  if (outcomeCell?.kind === "code" && amount?.kind === "money") outcome = outcomeCell.code as Outcome;
  if (outcome === "eligible" && deadlines.some((d) => d.status === "passed")) outcome = "deadline_passed";
  const notYetDue = outcome === "not_yet_due";
  const approvable = outcome === "eligible" || outcome === "likely_eligible";
  return {
    scenarioId: FAKE_SCENARIO,
    ruleId: FAKE_RULE_ID,
    ruleVersion: 1,
    engineVersion: input.engineVersion,
    remedyKey: "billing_correction",
    subjectKey: input.subjectKey,
    snapshotHash: input.snapshotHash,
    outcome,
    dimensions: {
      applies: "pass", factsKnown: amount ? "pass" : "unknown", evidenceSupports: "pass",
      windowOpen: deadlines.some((d) => d.status === "passed") ? "fail" : "pass", amountCalculable: amount ? "pass" : "unknown",
      readyForApproval: approvable ? "pass" : "fail",
    },
    conditions: [],
    missingFacts: amount ? [] : [{ subjectKey: TXN, key: "test.amount", reason: "missing", class: "required", neededFor: ["amount"] }],
    assumptions: [],
    disqualifierIds: [],
    amount: amount?.kind === "money"
      ? { estimate: { amountMinor: amount.amountMinor, currency: amount.currency }, basis: "exact_formula", formula: "the disputed amount", inputs: [] }
      : null,
    deadlines,
    sourceRefs: [],
    lossKeys: [`txn:${transactionId}:paid`],
    overlap: [],
    nextAction: notYetDue
      ? { kind: "wait", reevaluate: { at: "2026-10-11" } }
      : input.caseContext.activeClaimId
        ? { kind: "continue_case", claimId: input.caseContext.activeClaimId }
        : approvable ? { kind: "open_case" } : { kind: "none", reason: "not approvable" },
    explanation: ["fake"],
    flags: emptyFlags(),
    boundFacts: boundFactValues({ lookup }, [
      { subjectKey: TXN, key: "test.amount" }, { subjectKey: TXN, key: "test.recipient" }, { subjectKey: TXN, key: "test.ref" },
    ]),
    ...(notYetDue ? { reevaluate: { at: "2026-10-11" } } : {}),
  };
}

export const FAKE_PACK: RulePack<FakeSnapshot, Record<string, never>> = {
  ruleId: FAKE_RULE_ID,
  scenarioId: FAKE_SCENARIO,
  version: 1,
  lifecycle: "researched",
  authority: { class: "legal_entitlement", subtype: "test" },
  jurisdiction: "test",
  categories: ["card_charge"],
  remedyKey: "billing_correction",
  remedyType: "billing_correction",
  cashClass: "cash",
  params: {},
  sources: [],
  requirements: [],
  fixturesPath: "",
  knownLimitations: [],
  lateAskDeadlineIds: [],
  overlap: [],
  evaluate: evaluateFake,
  adapter: {
    runs: ({ transactionId, rows }) => {
      const lookup = lookupOf(rows);
      return [{ subjectKey: TXN, snapshot: { transactionId, lookup }, lookup }];
    },
  },
  requiredChannel: () => "postal_mail",
  caseMode: () => "request",
};

// ---------------------------------------------------------------------------
// Registry-shaped exports (the `vi.mock("./lib/rules/registry", …)` target)
// ---------------------------------------------------------------------------

let fakeActive = true;
/** Activate or withdraw the fake pack (N3 tests). */
export function setFakeActive(active: boolean): void {
  fakeActive = active;
}

export const REGISTRY_KIND: "production" | "test" = "test";
export const IMPLEMENTED_PACKS: readonly AnyRulePack[] = [FAKE_PACK];
export function effectiveActivations() {
  return [];
}
export function resolveActivePacks() {
  return activePacks();
}
export function activePacks(): AnyRulePack[] {
  return fakeActive ? [FAKE_PACK] : [];
}
export function isPackActive(ruleId: string, version: number): boolean {
  return activePacks().some((p) => p.ruleId === ruleId && p.version === version);
}
export function activePack(scenarioId: ScenarioId): AnyRulePack | null {
  return activePacks().find((p) => p.scenarioId === scenarioId) ?? null;
}
export function activePacksForCategory(category: TransactionCategory): AnyRulePack[] {
  return activePacks().filter((p) => p.categories.includes(category));
}
export function activationDecision(ruleId: string, version: number): string | null {
  return isPackActive(ruleId, version) ? "TEST" : null;
}

// ---------------------------------------------------------------------------
// Packet-template-index-shaped exports (the `vi.mock("./lib/packets/index", …)` target)
// ---------------------------------------------------------------------------

export const FAKE_TEMPLATE: PacketTemplate = {
  ruleId: FAKE_RULE_ID,
  version: 1,
  templateId: "fake.letter",
  channels: ["postal_mail"],
  textBlocks: [FAKE_TEXT_BLOCK],
  compose(context, facts) {
    const amount = facts.money(TXN, "test.amount");
    const hasRecipient = facts.has(TXN, "test.recipient");
    return {
      recipient: hasRecipient ? { text: facts.text(TXN, "test.recipient"), source: "rule_pack" } : null,
      body: fill("Re: {{ref}} (claim {{token}})\n\nI dispute {{amount}}.\n\n{{block}}", {
        ref: facts.text(TXN, "test.ref"),
        token: context.claimToken,
        amount: formatMoney(amount),
        block: FAKE_TEXT_BLOCK,
      }),
      requestedRemedy: `Correct the charge by ${formatMoney(amount)}`,
    };
  },
};

export const PACKET_TEMPLATES: readonly PacketTemplate[] = [FAKE_TEMPLATE];
export function templateFor(ruleId: string, version: number, opts: { remedyKey?: string; templateId?: string } = {}): PacketTemplate | null {
  const mine = PACKET_TEMPLATES.filter((t) => t.ruleId === ruleId && t.version === version);
  return (opts.templateId !== undefined ? mine.find((t) => t.templateId === opts.templateId) : mine[0]) ?? null;
}
export function templateById(templateId: string): PacketTemplate | null {
  return PACKET_TEMPLATES.find((t) => t.templateId === templateId) ?? null;
}
