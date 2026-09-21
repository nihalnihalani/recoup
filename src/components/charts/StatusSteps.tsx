const STEPS = [
  { label: "Found", statuses: ["detected"] },
  { label: "Drafted", statuses: ["drafted"] },
  { label: "Asked", statuses: ["queued", "sent", "packet"] },
  { label: "Promised", statuses: ["promised"] },
  { label: "Back on card", statuses: ["confirmed"] },
] as const;

const TERMINAL: Record<string, { label: string; dot: string; text: string }> = {
  reopened: { label: "Charged again", dot: "bg-rust", text: "text-gray-900" },
  dismissed: { label: "Dismissed", dot: "bg-gray-300", text: "text-gray-400 line-through" },
};

/**
 * A claim's path as a horizontal stepper: Found, Drafted, Asked, Promised, Back on
 * card. Small ringed dots on a hairline: finished steps are green, the current one
 * is near-black with a halo, the ones ahead are gray. Reopened and dismissed sit
 * outside the path as a dot-and-label chip.
 */
export function StatusSteps({ status }: { status: string }) {
  const terminal = TERMINAL[status];
  const current = STEPS.findIndex((step) => (step.statuses as readonly string[]).includes(status));
  // A reopened claim had reached the end; a dismissed one shows no progress.
  const reached = status === "reopened" ? STEPS.length - 1 : current;
  const done = status === "confirmed";

  return (
    <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
      <ol className="flex min-w-64 flex-1" aria-label="Claim progress">
        {STEPS.map((step, i) => {
          const isReached = i <= reached;
          // The last step, once reached, is finished too: the money is back.
          const isCurrent = i === current && !terminal;
          const isComplete = isReached && (!isCurrent || done);
          const dot = isComplete
            ? "border-moss bg-moss"
            : isCurrent
              ? "border-gray-900 bg-gray-900 ring-4 ring-gray-900/10"
              : "border-gray-300 bg-white";
          const rail = isReached ? "bg-moss" : "bg-gray-200";
          return (
            <li
              key={step.label}
              className="relative flex flex-1 flex-col items-center gap-2"
              aria-current={isCurrent ? "step" : undefined}
            >
              {i > 0 && (
                <span aria-hidden="true" className={`absolute right-1/2 top-[5px] h-px w-full -translate-y-1/2 ${rail}`} />
              )}
              <span aria-hidden="true" className={`relative z-10 size-2.5 rounded-full border-2 ${dot}`} />
              <span
                className={`text-center text-xs leading-tight ${
                  isCurrent ? "font-semibold text-gray-900" : "text-gray-500"
                }`}
              >
                {step.label}
                <span className="sr-only">{isCurrent ? " (current)" : isReached ? " (done)" : " (not yet)"}</span>
              </span>
            </li>
          );
        })}
      </ol>
      {terminal && (
        <span
          className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-gray-200 bg-white px-2 py-0.5 text-xs font-medium ${terminal.text}`}
        >
          <span aria-hidden="true" className={`size-1.5 rounded-full ${terminal.dot}`} />
          {terminal.label}
        </span>
      )}
    </div>
  );
}
