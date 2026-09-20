const STEPS = [
  { label: "Found", statuses: ["detected"] },
  { label: "Drafted", statuses: ["drafted"] },
  { label: "Asked", statuses: ["queued", "sent", "packet"] },
  { label: "Promised", statuses: ["promised"] },
  { label: "Back on card", statuses: ["confirmed"] },
] as const;

const TERMINAL: Record<string, { label: string; className: string }> = {
  reopened: { label: "Charged again", className: "bg-red-500 text-white" },
  dismissed: { label: "Dismissed", className: "bg-gray-100 text-gray-400 line-through" },
};

/**
 * A claim's path as a horizontal stepper: Found, Drafted, Asked, Promised, Back on
 * card. Reached steps are filled, the current one is ringed; reopened and dismissed
 * sit outside the path as a terminal chip.
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
          const isCurrent = i === current && !terminal;
          const fill = !isReached ? "border-gray-300 bg-white" : done ? "border-green-500 bg-green-500" : "border-violet-500 bg-violet-500";
          const rail = i <= reached ? (done ? "bg-green-500" : "bg-violet-500") : "bg-gray-200";
          return (
            <li
              key={step.label}
              className="relative flex flex-1 flex-col items-center gap-1.5"
              aria-current={isCurrent ? "step" : undefined}
            >
              {i > 0 && (
                <span aria-hidden="true" className={`absolute right-1/2 top-[7px] h-0.5 w-full -translate-y-1/2 ${rail}`} />
              )}
              <span
                aria-hidden="true"
                className={`relative z-10 size-3.5 rounded-full border-2 ${fill} ${
                  isCurrent ? (done ? "ring-4 ring-green-500/20" : "ring-4 ring-violet-500/20") : ""
                }`}
              />
              <span
                className={`text-center text-xs leading-tight ${
                  isCurrent ? "font-semibold text-gray-800" : isReached ? "text-gray-600" : "text-gray-400"
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
        <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${terminal.className}`}>
          {terminal.label}
        </span>
      )}
    </div>
  );
}
