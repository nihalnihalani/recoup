import { Link } from "react-router-dom";
import { formatMinor } from "../../lib/money";
import { useNow } from "../../lib/ui";
import { DotChip } from "../purchase/parts";
import { AuthorityBadge } from "./AuthorityBadge";
import {
  amountHeading,
  deadlineAttentionActive,
  formatInstant,
  OUTCOME_COPY,
  passedUserDeadline,
  SCENARIO_TITLES,
  type OpportunityView,
} from "./model";

/**
 * One recovery path as a compact row for the /opportunities list: what it is, the authority behind it, where it
 * stands, an estimate only when the card would show one (never for not-yet-due, needs-facts or ineligible paths),
 * and the next user deadline. Rows are never added up: alternatives for one loss must not look like more money.
 */
export function OpportunityRow({
  view,
  href,
  now,
}: {
  view: Pick<OpportunityView, "opportunity" | "evaluation">;
  href: string;
  /** Client clock override for tests; display only (D73). */
  now?: number;
}) {
  const { opportunity, evaluation } = view;
  const clock = useNow();
  const at = now ?? clock;
  const outcome = evaluation?.outcome ?? opportunity.outcome;
  // P06-OW-1 (display only): past its running user deadline, the row shows no outcome chip and no estimate.
  const passed = passedUserDeadline(evaluation, at, opportunity);
  const attention = passed === null && deadlineAttentionActive(opportunity, at);
  const amount = evaluation && passed === null ? evaluation.amount : null;
  const heading = amountHeading(outcome, amount);
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3">
      <div className="min-w-0">
        <Link to={href} className="font-medium text-gray-900 underline decoration-gray-300 underline-offset-4 hover:decoration-gray-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-500">
          {SCENARIO_TITLES[opportunity.scenarioId]}
        </Link>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          {passed ? (
            <DotChip dot="bg-gray-400">Window may have passed</DotChip>
          ) : (
            <DotChip dot={OUTCOME_COPY[outcome].dot}>{OUTCOME_COPY[outcome].label}</DotChip>
          )}
          {attention && <DotChip dot="bg-gold">Deadline soon</DotChip>}
          <AuthorityBadge authority={opportunity.authorityClass} />
          {opportunity.status === "case_open" && <DotChip dot="bg-gray-900">Claim open</DotChip>}
          {opportunity.isExample && <DotChip dot="bg-gray-300">Example</DotChip>}
        </div>
      </div>
      <div className="text-right text-sm">
        {heading && amount ? (
          <p className="tabular-nums text-gray-900">
            <span className="font-semibold">{formatMinor(amount.estimate.amountMinor, amount.estimate.currency)}</span>{" "}
            <span className="text-gray-600">estimated</span>
          </p>
        ) : (
          <p className="text-gray-600">{passed ? "Check again to confirm" : "No amount yet"}</p>
        )}
        {passed ? (
          <p className="text-xs text-gray-600">Your deadline passed: {formatInstant(passed.dueAt!)}</p>
        ) : (
          opportunity.nextDeadlineAt !== undefined && (
            <p className={`text-xs ${attention ? "font-semibold text-gray-900" : "text-gray-600"}`}>
              Your deadline: {formatInstant(opportunity.nextDeadlineAt)}
            </p>
          )
        )}
      </div>
    </li>
  );
}
