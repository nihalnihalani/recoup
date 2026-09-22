import type { ReactNode } from "react";
import { useNow } from "../../lib/ui";
import { formatActBy, formatDue, formatInstant, humanizeKeys, mustBeCopy, remainingCopy, type DeadlineResult } from "./model";

/**
 * One deadline, worded by WHO owes it (DA-A-5) and how sure the date is (D154):
 *  - the user's own deadline: "must be sent by <date>" with a countdown on this device's clock (display only;
 *    the server decides with its own clock, and a query never flips state by the client's);
 *  - a counterparty's deadline: "<who> owes by <date>" / "overdue since <date>", never "passed";
 *  - an unknown or disputed start date: no firm date at all, only a labelled conservative act-by;
 *  - beyond the verified holiday calendar: said plainly.
 * `now` is injectable for tests; the component otherwise reads the client clock once a minute.
 */
export function DeadlineLine({
  deadline,
  counterparty = "The business",
  now: nowOverride,
}: {
  deadline: DeadlineResult;
  /** Who owes a counterparty deadline, e.g. the store's name. */
  counterparty?: string;
  now?: number;
}) {
  const clock = useNow(60_000);
  const now = nowOverride ?? clock;
  if (deadline.status === "not_applicable") return null;

  const due = formatDue(deadline);
  const basis = humanizeKeys(deadline.basis);
  const actBy = deadline.advisoryActBy !== undefined && (
    <p className="mt-0.5 text-sm text-gray-700">
      <span className="font-medium">Conservative act-by (not the legal deadline):</span> {formatActBy(deadline.advisoryActBy)}
    </p>
  );

  let headline: ReactNode;
  let tone = "text-gray-900";
  if (deadline.obligor === "counterparty") {
    if (deadline.status === "overdue" && deadline.overdueSince !== undefined) {
      tone = "text-red-700";
      headline = `${counterparty} is overdue since ${formatInstant(deadline.overdueSince)}`;
    } else if (deadline.status === "open" && due !== null) {
      headline = `${counterparty} owes this by ${due}`;
    } else if (deadline.status === "disputed_anchor") {
      headline = `${counterparty}'s deadline is unclear: the start date is disputed`;
    } else if (deadline.status === "beyond_calendar") {
      headline = `${counterparty}'s deadline is past the calendar Recoup has verified`;
    } else {
      headline = `${counterparty}'s deadline is not known yet`;
    }
  } else if (deadline.status === "open" && deadline.dueAt !== undefined && due !== null) {
    headline = (
      <>
        {mustBeCopy(deadline.mustBe) === "ends" ? "Ends" : capitalize(mustBeCopy(deadline.mustBe))} {due}{" "}
        <span className="font-normal text-gray-600">· {remainingCopy(deadline.dueAt - now)}</span>
      </>
    );
  } else if (deadline.status === "passed") {
    tone = "text-red-700";
    headline = due !== null ? `Passed on ${due}` : "Passed";
  } else if (deadline.status === "disputed_anchor") {
    headline = "Deadline unclear: the start date is disputed";
  } else if (deadline.status === "beyond_calendar") {
    headline = "Deadline past the calendar Recoup has verified; check it yourself";
  } else {
    headline = "Deadline not known yet";
  }

  return (
    <div className="min-w-0">
      <p className="text-xs font-medium text-gray-600">{deadline.label}</p>
      <p className={`mt-0.5 text-sm font-semibold ${tone}`}>{headline}</p>
      {deadline.obligor === "user" && actBy}
      <p className="mt-0.5 text-xs text-gray-500">{basis}</p>
    </div>
  );
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
