import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { formatMinor } from "../../lib/money";
import { cardClass, errorText, primaryButtonClass, secondaryButtonClass } from "../../lib/ui";
import { DotChip } from "../purchase/parts";
import { AuthorityBadge } from "./AuthorityBadge";
import { DeadlineLine } from "./DeadlineLine";
import {
  amountHeading,
  CASH_COPY,
  docTypeWords,
  explanationLines,
  formatInstant,
  formatLocalDate,
  humanizeKeys,
  OUTCOME_COPY,
  relationCopy,
  SCENARIO_TITLES,
  sharedLossViews,
  waitCopy,
  type Evaluation,
  type FactCell,
  type OpenCaseResult,
  type Opportunity,
  type OpportunityView,
} from "./model";
import { Questions, type FactAnswer } from "./Questions";

/** The app's small uppercase label, in gray-600 (7.56:1 on white) rather than `mutedLabelClass`'s gray-400 (2.6:1). */
const labelClass = "text-xs font-medium uppercase tracking-wide text-gray-600";

/**
 * One recovery path for one transaction (mission §14 "Opportunity card", contract §9). It answers: what kind of
 * right is this (authority), might I recover something and how much (only when the rule computed an estimate;
 * a cap is a LIMIT, never the expectation), is it cash, why might I qualify, what is uncertain or excluded, what
 * is still needed, what are the deadlines and who owes them, which source says so, what else overlaps, and what
 * the one next step is. Nothing here promises recovery (§20). Actions are callbacks so the card stays testable;
 * the page wires them to `opportunities.openCase`, `opportunities.reevaluate` and `facts.answer`.
 */
export function OpportunityCard({
  view,
  related = [],
  cells,
  purchaseEditHref,
  counterparty,
  onOpenCase,
  onCheckAgain,
  onAnswer,
  now,
}: {
  view: OpportunityView;
  /** Every card on the same transaction (this one included is fine): shared loss keys make them alternatives. */
  related?: readonly OpportunityView[];
  /** `facts.list` for the transaction, for the questions' current values. */
  cells?: readonly FactCell[];
  /** Where purchase-record facts are corrected. */
  purchaseEditHref?: string;
  /** Who owes a counterparty deadline, e.g. the store. */
  counterparty?: string;
  onOpenCase?: () => Promise<OpenCaseResult>;
  onCheckAgain?: () => Promise<void>;
  onAnswer?: (answer: FactAnswer) => Promise<void>;
  /** Client clock override for tests; deadlines read the device clock for display only. */
  now?: number;
}) {
  const { opportunity, evaluation } = view;
  const title = SCENARIO_TITLES[opportunity.scenarioId];
  const outcome = evaluation?.outcome ?? opportunity.outcome;
  const cash = CASH_COPY[opportunity.cashClass];

  return (
    // An article, not a region: several items can each carry the same kind of path, and landmarks must be unique.
    <article aria-label={`${title}: recovery path`} className={`${cardClass} p-5`}>
      <header>
        <p className={labelClass}>Recovery path</p>
        <h3 className="mt-0.5 text-base font-semibold text-gray-900">{title}</h3>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <DotChip dot={OUTCOME_COPY[outcome].dot}>{OUTCOME_COPY[outcome].label}</DotChip>
          <AuthorityBadge authority={opportunity.authorityClass} />
          <span
            className="inline-flex items-center whitespace-nowrap rounded-lg border border-gray-200 bg-gray-50 px-2 py-0.5 text-xs font-medium text-gray-700"
            title={cash.description}
          >
            {cash.label}
          </span>
          {opportunity.status === "case_open" && <DotChip dot="bg-gray-900">Claim open</DotChip>}
        </div>
      </header>

      {evaluation === null ? (
        <p className="mt-4 text-sm text-gray-600">This path has not been checked yet.</p>
      ) : (
        <EvaluationBody
          opportunity={opportunity}
          evaluation={evaluation}
          view={view}
          related={related}
          cells={cells}
          purchaseEditHref={purchaseEditHref}
          counterparty={counterparty}
          onAnswer={onAnswer}
          now={now}
        />
      )}

      <NextStep view={view} onOpenCase={onOpenCase} onCheckAgain={onCheckAgain} counterparty={counterparty} />
    </article>
  );
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mt-4 border-t border-dashed border-gray-200 pt-4">
      <h4 className={labelClass}>{title}</h4>
      <div className="mt-1.5">{children}</div>
    </div>
  );
}

function EvaluationBody({
  opportunity,
  evaluation,
  view,
  related,
  cells,
  purchaseEditHref,
  counterparty,
  onAnswer,
  now,
}: {
  opportunity: Opportunity;
  evaluation: Evaluation;
  view: OpportunityView;
  related: readonly OpportunityView[];
  cells?: readonly FactCell[];
  purchaseEditHref?: string;
  counterparty?: string;
  onAnswer?: (answer: FactAnswer) => Promise<void>;
  now?: number;
}) {
  const heading = amountHeading(evaluation.outcome, evaluation.amount);
  const amount = heading !== null ? evaluation.amount : null;
  const why = explanationLines(evaluation);
  const exclusions = evaluation.conditions.filter((c) => c.kind === "exclusion");
  const deadlines = evaluation.deadlines.filter((d) => d.status !== "not_applicable");
  const alternatives = sharedLossViews(view, related);

  return (
    <>
      {amount && (
        <div className="mt-4 border-t border-dashed border-gray-200 pt-4">
          <p className={labelClass}>{heading}</p>
          <p className="mt-1 text-3xl font-semibold tabular-nums tracking-tight text-gray-900">
            {formatMinor(amount.estimate.amountMinor, amount.estimate.currency)}
          </p>
          <p className="mt-1 text-xs text-gray-600">An estimate, not a guarantee: the business decides.</p>
          {amount.formula && (
            <p className="mt-1 text-xs text-gray-600">
              How it is worked out: {amount.formula} (in the smallest unit of {amount.estimate.currency}, e.g. cents)
            </p>
          )}
          {amount.cap && (
            <p className="mt-2 text-sm text-gray-700">
              <span className="font-semibold">Limit: {formatMinor(amount.cap.amount.amountMinor, amount.cap.amount.currency)}</span>{" "}
              — the most this path can pay, not what to expect. {amount.cap.note}
            </p>
          )}
        </div>
      )}

      {evaluation.outcome === "not_yet_due" && (
        <div className="mt-4 rounded-xl border border-gray-200 bg-gray-50 px-3.5 py-3 text-sm text-gray-700">
          Not yet due, so nothing is owed yet.{" "}
          {evaluation.reevaluate ? waitCopy(evaluation.reevaluate) : "Recoup checks again when the facts change."}
        </div>
      )}

      {why.length > 0 && (
        <Block title="Why">
          <ul className="list-disc space-y-1 pl-5 text-sm text-gray-700">
            {why.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </Block>
      )}

      {evaluation.assumptions.length > 0 && (
        <Block title="Assumptions">
          <ul className="space-y-1.5 text-sm text-gray-700">
            {evaluation.assumptions.map((a) => (
              <li key={a.id}>
                {a.text} <span className="text-gray-600">Changes the answer if {a.changesOutcomeIf}.</span>
              </li>
            ))}
          </ul>
        </Block>
      )}

      {exclusions.length > 0 && (
        <Block title="Exclusions checked">
          <ul className="space-y-1 text-sm text-gray-700">
            {exclusions.map((c) => (
              <li key={c.id}>
                {c.result === "fail" ? "Excluded: " : c.result === "pass" ? "Does not apply: " : "Not known yet: "}
                {humanizeKeys(c.label)}
              </li>
            ))}
          </ul>
        </Block>
      )}

      {evaluation.missingFacts.length > 0 && (
        <Block title="What is still needed">
          <Questions
            missing={evaluation.missingFacts}
            cells={cells}
            purchaseEditHref={purchaseEditHref}
            onAnswer={onAnswer}
            defaultCurrency={opportunity.estimate?.currency}
          />
        </Block>
      )}

      {deadlines.length > 0 && (
        <Block title={deadlines.length === 1 ? "Deadline" : "Deadlines"}>
          <div className="space-y-3">
            {deadlines.map((d) => (
              <DeadlineLine key={d.id} deadline={d} counterparty={counterparty} now={now} />
            ))}
          </div>
        </Block>
      )}

      <Block title="Source">
        <ul className="space-y-1 text-sm text-gray-700">
          {evaluation.sourceRefs.map((ref) => (
            <li key={`${ref.sourceId}:${ref.passageId}`}>
              <a
                href={ref.url}
                target="_blank"
                rel="noreferrer noopener"
                className="font-medium text-gray-900 underline decoration-gray-300 underline-offset-4 hover:decoration-gray-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-500"
              >
                {hostOf(ref.url)}
                <span className="sr-only"> (opens in a new tab)</span>
              </a>{" "}
              · {ref.effective === "unknown" ? "effective date unknown" : `effective ${formatLocalDate(ref.effective)}`}
            </li>
          ))}
          {evaluation.sourceRefs.length === 0 && <li>No source on file for this path yet.</li>}
          <li className="text-xs text-gray-600">
            Rule {evaluation.ruleId} version {evaluation.ruleVersion} · checked {formatInstant(evaluation.evaluatedAt)}
            {evaluation.outcome === "source_unverified" && " · the source has not been re-verified recently"}
          </li>
        </ul>
      </Block>

      {(evaluation.overlap.length > 0 || alternatives.length > 0) && (
        <Block title="Related paths">
          <ul className="space-y-1 text-sm text-gray-700">
            {evaluation.overlap.map((o) => (
              <li key={`${o.withScenario}:${o.withRemedyKey}`}>
                {relationCopy(o.relation)} {SCENARIO_TITLES[o.withScenario]}.
              </li>
            ))}
            {alternatives
              .filter((alt) => !evaluation.overlap.some((o) => o.withScenario === alt.opportunity.scenarioId))
              .map((alt) => (
                <li key={alt.opportunity._id}>
                  {relationCopy("alternative")} {SCENARIO_TITLES[alt.opportunity.scenarioId]}.
                </li>
              ))}
          </ul>
        </Block>
      )}
    </>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** The ONE next step (mission §14), plus an explicit "check again". */
function NextStep({
  view,
  onOpenCase,
  onCheckAgain,
  counterparty = "The business",
}: {
  view: OpportunityView;
  onOpenCase?: () => Promise<OpenCaseResult>;
  onCheckAgain?: () => Promise<void>;
  counterparty?: string;
}) {
  const { opportunity, evaluation } = view;
  const [busy, setBusy] = useState<"open" | "check" | null>(null);
  const [message, setMessage] = useState<{ tone: "error" | "info"; text: string } | null>(null);

  async function run(kind: "open" | "check", work: () => Promise<void>) {
    setMessage(null);
    setBusy(kind);
    try {
      await work();
    } catch (caught) {
      setMessage({ tone: "error", text: errorText(caught) });
    } finally {
      setBusy(null);
    }
  }

  const action = evaluation?.nextAction;
  const claimId = opportunity.activeClaimId ?? (action?.kind === "continue_case" ? action.claimId : undefined);
  const hasQuestions = (evaluation?.missingFacts.length ?? 0) > 0;

  let primary: ReactNode = null;
  let text: string | null = null;
  if (claimId !== undefined) {
    primary = (
      <Link to={`/claims/${claimId}`} className={primaryButtonClass}>
        Open the claim
      </Link>
    );
  } else if (action) {
    switch (action.kind) {
      case "open_case":
        primary = onOpenCase ? (
          <button
            type="button"
            disabled={busy !== null}
            className={primaryButtonClass}
            onClick={() =>
              void run("open", async () => {
                const result = await onOpenCase();
                if (!result.ok) setMessage({ tone: "error", text: result.message });
                else if (result.notice) setMessage({ tone: "info", text: result.notice });
              })
            }
          >
            {busy === "open" ? "Starting…" : "Start a claim"}
          </button>
        ) : null;
        text = "Recoup prepares the message; nothing is sent until you approve it.";
        break;
      case "answer_questions":
        text = "Next: answer the questions above.";
        break;
      case "add_evidence":
        text = action.docTypes.includes("policy_page")
          ? "Next: refresh the store's policy on this page, so the terms from your purchase date can be checked."
          : `Next: add ${action.docTypes.map(docTypeWords).join(" or ")}.`;
        break;
      case "track":
        text = `Nothing to send: ${counterparty} should pay this on its own. Recoup keeps an eye on the deadline.`;
        break;
      case "escalate":
        text = `Next: escalate. ${humanizeKeys(action.reason)}`;
        break;
      case "request_refund":
        text = "Next: ask for the refund.";
        break;
      case "ask_anyway":
      case "manual_review":
        text = humanizeKeys(action.reason);
        break;
      case "wait":
        text = waitCopy(action.reevaluate);
        break;
      case "none":
        text = hasQuestions ? "Next: answer the questions above." : humanizeKeys(action.reason);
        break;
      case "continue_case":
        break;
    }
  }

  return (
    <footer className="mt-5 border-t border-gray-200 pt-4">
      {text && <p className="text-sm text-gray-700">{text}</p>}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {primary}
        {onCheckAgain && (
          <button
            type="button"
            disabled={busy !== null}
            className={secondaryButtonClass}
            onClick={() => void run("check", onCheckAgain)}
          >
            {busy === "check" ? "Checking…" : "Check again"}
          </button>
        )}
      </div>
      {message && (
        <p role={message.tone === "error" ? "alert" : "status"} className={`mt-2 text-sm ${message.tone === "error" ? "text-red-700" : "text-gray-700"}`}>
          {message.text}
        </p>
      )}
    </footer>
  );
}
