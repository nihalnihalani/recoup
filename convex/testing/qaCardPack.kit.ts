/**
 * TEST-ONLY (M25, QA). Two dots in the name, so it is never bundled or deployed. QA's own harness pack for
 * `convex/slicesM2.test.ts` and `convex/concurrencyM2.test.ts`. It is written from the contract (§2.7 RulePack, D208
 * PackAdapter, §6 packets, DA-A-9/-18/-25, D204), independent of M20's `scenarioPack.kit.ts` and of every real pack:
 * a slice test must exercise M20's seams (adapter → opportunity → openCase → insertScenarioClaim → packets →
 * submissions → ledger → recovery.summary) without depending on R02–R05, which are not active (D228).
 *
 * `QA.R13.card_fix` v1 (scenario R13, category card_charge) reads REAL catalog keys from the live facts table, so its
 * transactions come from the public `transactions.createManual` and its answers from the public `facts.answer`:
 *   - card.charge_amount (money, required): the estimate, unless card.correct_amount is known;
 *   - card.correct_amount (money, optional): estimate = charge − correct (≤ 0 → not_eligible);
 *   - card.billing_error_address (text, optional): the packet recipient ("rule_pack"); absent → the user enters one;
 *   - card.first_statement_transmitted_on (local_date, optional): a USER deadline 60 days later, 23:59:59 UTC.
 * It binds the four facts it reads (N6) and asks by postal_mail (a manual channel, so the case goes by packet).
 * Its non-cash acceptance fact (D204) is `card.merchant_contacted = true`: a stand-in (no card key means "accepted a
 * non-cash remedy"); the slice only checks that the pack-declared fact is written through the real path.
 *
 * Swap it in with:
 *   vi.mock("./lib/rules/registry", async () => await import("./testing/qaCardPack.kit"));
 *   vi.mock("./lib/packets/index", async () => await import("./testing/qaCardPack.kit"));
 */
import type { Id } from "../_generated/dataModel";
import type { Cell } from "../lib/facts/resolve";
import { resolveRows } from "../lib/facts/snapshot_order";
import { boundFactValues } from "../lib/facts/snapshot_retail";
import { formatMoney, type PacketTemplate } from "../lib/packets/common";
import type {
  AnyRulePack,
  DeadlineResult,
  EvaluationResult,
  Outcome,
  RulePack,
  ScenarioId,
  TransactionCategory,
} from "../lib/rules/types";
import { emptyFlags } from "../lib/rules/types";

export const QA_RULE_ID = "QA.R13.card_fix";
export const QA_SCENARIO: ScenarioId = "R13";
export const QA_TEMPLATE_ID = "qa.card_fix.letter";
/** Verbatim pack text (exempt from SEC-AI-4). */
export const QA_TEXT_BLOCK = "Please correct this charge and confirm the correction in writing.";
const TXN = "txn";
const DAY = 86_400_000;
const BOUND = [
  { subjectKey: TXN, key: "card.charge_amount" },
  { subjectKey: TXN, key: "card.correct_amount" },
  { subjectKey: TXN, key: "card.billing_error_address" },
  { subjectKey: TXN, key: "card.first_statement_transmitted_on" },
];

type QaSnapshot = { transactionId: Id<"transactions">; lookup: ReturnType<typeof resolveRows> };

const knownValue = (c: Cell) => (c.known ? c.value : undefined);

function evaluateQa(input: Parameters<RulePack<QaSnapshot, Record<string, never>>["evaluate"]>[0]): EvaluationResult {
  const { lookup, transactionId } = input.snapshot;
  const charge = knownValue(lookup.get(TXN, "card.charge_amount"));
  const correct = knownValue(lookup.get(TXN, "card.correct_amount"));
  const statement = knownValue(lookup.get(TXN, "card.first_statement_transmitted_on"));
  const deadlines: DeadlineResult[] = [];
  if (statement?.kind === "local_date") {
    const dueAt = Date.parse(`${statement.date}T23:59:59Z`) + 60 * DAY;
    deadlines.push({
      id: "qa.notice", label: "Notice received by", obligor: "user", status: input.now > dueAt ? "passed" : "open",
      dueAt, mustBe: "received", basis: "QA harness: 60 days after the first statement",
    });
  }
  const amountMinor = charge?.kind === "money"
    ? charge.amountMinor - (correct?.kind === "money" && correct.currency === charge.currency ? correct.amountMinor : 0)
    : null;
  let outcome: Outcome = amountMinor === null ? "needs_facts" : amountMinor > 0 ? "eligible" : "not_eligible";
  if (outcome === "eligible" && deadlines.some((d) => d.status === "passed")) outcome = "deadline_passed";
  const approvable = outcome === "eligible";
  const currency = charge?.kind === "money" ? charge.currency : "USD";
  return {
    scenarioId: QA_SCENARIO,
    ruleId: QA_RULE_ID,
    ruleVersion: 1,
    engineVersion: input.engineVersion,
    remedyKey: "billing_correction",
    subjectKey: input.subjectKey,
    snapshotHash: input.snapshotHash,
    outcome,
    dimensions: {
      applies: "pass",
      factsKnown: amountMinor === null ? "unknown" : "pass",
      evidenceSupports: "pass",
      windowOpen: deadlines.some((d) => d.status === "passed") ? "fail" : "pass",
      amountCalculable: amountMinor === null ? "unknown" : "pass",
      readyForApproval: approvable ? "pass" : "fail",
    },
    conditions: [],
    missingFacts: amountMinor === null
      ? [{ subjectKey: TXN, key: "card.charge_amount", reason: "missing", class: "required", neededFor: ["amount"] }]
      : [],
    assumptions: [],
    disqualifierIds: [],
    amount: amountMinor !== null && amountMinor > 0
      ? { estimate: { amountMinor, currency }, basis: "exact_formula", formula: "charge − correct amount", inputs: [] }
      : null,
    deadlines,
    sourceRefs: [],
    lossKeys: [`txn:${transactionId}:paid`],
    overlap: [],
    nextAction: input.caseContext.activeClaimId
      ? { kind: "continue_case", claimId: input.caseContext.activeClaimId }
      : approvable ? { kind: "open_case" } : { kind: "none", reason: `QA harness outcome ${outcome}` },
    explanation: ["QA harness pack"],
    flags: emptyFlags(),
    boundFacts: boundFactValues({ lookup }, BOUND),
  };
}

export const QA_PACK: RulePack<QaSnapshot, Record<string, never>> = {
  ruleId: QA_RULE_ID,
  scenarioId: QA_SCENARIO,
  version: 1,
  lifecycle: "researched",
  authority: { class: "legal_entitlement", subtype: "qa_harness" },
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
  evaluate: evaluateQa,
  adapter: {
    runs: ({ transactionId, rows }) => {
      const lookup = resolveRows(rows);
      return [{ subjectKey: TXN, snapshot: { transactionId, lookup }, lookup }];
    },
  },
  requiredChannel: () => "postal_mail",
  caseMode: () => "request",
  nonCashAcceptance: { subjectKey: TXN, key: "card.merchant_contacted", value: { kind: "bool", value: true } },
};

// ---------------------------------------------------------------------------
// Registry-shaped exports (`vi.mock("./lib/rules/registry", …)`)
// ---------------------------------------------------------------------------

let qaActive = true;
/** Withdraw (false) or restore (true) the harness pack, as an activation change would (N3). */
export function setQaPackActive(active: boolean): void {
  qaActive = active;
}

export const REGISTRY_KIND: "production" | "test" = "test";
export const IMPLEMENTED_PACKS: readonly AnyRulePack[] = [QA_PACK];
export function effectiveActivations() {
  return [];
}
export function resolveActivePacks() {
  return activePacks();
}
export function activePacks(): AnyRulePack[] {
  return qaActive ? [QA_PACK] : [];
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
  return isPackActive(ruleId, version) ? "QA" : null;
}

// ---------------------------------------------------------------------------
// Template-index-shaped exports (`vi.mock("./lib/packets/index", …)`)
// ---------------------------------------------------------------------------

export const QA_TEMPLATE: PacketTemplate = {
  ruleId: QA_RULE_ID,
  version: 1,
  templateId: QA_TEMPLATE_ID,
  remedyKey: "billing_correction",
  channels: ["postal_mail"],
  textBlocks: [QA_TEXT_BLOCK],
  compose(context, facts) {
    const charge = facts.money(TXN, "card.charge_amount");
    return {
      recipient: facts.has(TXN, "card.billing_error_address")
        ? { text: facts.text(TXN, "card.billing_error_address"), source: "rule_pack" }
        : null,
      body: [
        `Reference ${context.claimToken}`,
        "",
        `I dispute a charge of ${formatMoney(charge)} on my statement and ask for ${formatMoney(context.amount)} back.`,
        "",
        QA_TEXT_BLOCK,
      ].join("\n"),
      requestedRemedy: `Correct the charge by ${formatMoney(context.amount)}`,
    };
  },
};

export const PACKET_TEMPLATES: readonly PacketTemplate[] = [QA_TEMPLATE];
/** D249's contract: the named template, else the one for the claim's remedy, else the pack's only one; else null. */
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
export function templateById(templateId: string): PacketTemplate | null {
  return PACKET_TEMPLATES.find((t) => t.templateId === templateId) ?? null;
}
