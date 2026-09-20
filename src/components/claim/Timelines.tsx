import type { ReactNode } from "react";
import type { Doc } from "../../../convex/_generated/dataModel";
import { Money } from "../Money";
import { when } from "../../lib/ui";

type ReplyClass = Doc<"replies">["classification"];
type EventKind = Doc<"ledgerEvents">["kind"];

type Glyph = "check" | "clock" | "cross" | "question" | "dot" | "minus";

const PATHS: Record<Glyph, string> = {
  check: "M3.5 8.5l3 3 6-6.5",
  clock: "M8 4.5V8l2.5 1.5",
  cross: "M4.5 4.5l7 7m0-7l-7 7",
  question: "M6 6.2a2 2 0 113 1.7c-.7.4-1 .8-1 1.6M8 11.8v.2",
  dot: "M8 8h.01",
  minus: "M4 8h8",
};

const REPLY: Record<ReplyClass, { label: string; pill: string; bullet: string; glyph: Glyph }> = {
  promise: { label: "Promise", pill: "bg-gold/20 text-gold", bullet: "bg-gold", glyph: "clock" },
  credit_issued: { label: "Credit issued", pill: "bg-moss/20 text-moss", bullet: "bg-moss", glyph: "check" },
  refusal: { label: "Refusal", pill: "bg-rust/20 text-rust", bullet: "bg-rust", glyph: "cross" },
  question: { label: "Question", pill: "bg-harbor/20 text-harbor", bullet: "bg-harbor", glyph: "question" },
  other: { label: "Other", pill: "bg-ink/10 text-ink/60", bullet: "bg-ink/40", glyph: "dot" },
};

const EVENT: Record<EventKind, { label: string; bullet: string; glyph: Glyph; sign: string }> = {
  promised_credit: { label: "Promised", bullet: "bg-gold", glyph: "clock", sign: "" },
  confirmed_credit: { label: "Credit landed", bullet: "bg-moss", glyph: "check", sign: "+" },
  later_debit: { label: "Charged again", bullet: "bg-rust", glyph: "minus", sign: "−" },
};

/** An activity feed: round icon bullets threaded on a vertical rule. */
function Feed({ children }: { children: ReactNode }) {
  return <ul className="space-y-5">{children}</ul>;
}

function FeedItem({
  bullet,
  glyph,
  last,
  children,
}: {
  bullet: string;
  glyph: Glyph;
  last: boolean;
  children: ReactNode;
}) {
  return (
    <li className="relative flex gap-3">
      {!last && (
        <span className="absolute left-3.5 top-8 -bottom-5 w-px -translate-x-1/2 bg-line" aria-hidden="true" />
      )}
      <span
        className={`flex size-7 shrink-0 items-center justify-center rounded-full text-white ${bullet}`}
        aria-hidden="true"
      >
        <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d={PATHS[glyph]} />
        </svg>
      </span>
      <div className="min-w-0 grow pt-0.5">{children}</div>
    </li>
  );
}

export function ReplyTimeline({
  replies,
  currency,
}: {
  replies: Doc<"replies">[];
  currency: string;
}) {
  const ordered = [...replies].sort((a, b) => b.receivedAt - a.receivedAt);
  return (
    <Feed>
      {ordered.map((reply, index) => {
        const config = REPLY[reply.classification];
        return (
          <FeedItem
            key={reply._id}
            bullet={config.bullet}
            glyph={config.glyph}
            last={index === ordered.length - 1}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className={`rounded-full px-1.5 text-sm font-medium ${config.pill}`}>
                {config.label}
              </span>
              {reply.promisedCents !== undefined && (
                <Money cents={reply.promisedCents} currency={currency} className="text-sm font-semibold text-ink" />
              )}
              <time className="ml-auto text-xs text-ink/40">{when(reply.receivedAt)}</time>
            </div>
            <p className="mt-1.5 text-sm text-ink">{reply.summary}</p>
            <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-ink/50">
              <span className="break-all">{reply.from}</span>
              {reply.senderMismatch && (
                <span role="note" className="rounded-full bg-rust/20 px-1.5 font-medium text-rust">
                  Different sender domain
                </span>
              )}
            </p>
          </FeedItem>
        );
      })}
    </Feed>
  );
}

export function LedgerTimeline({
  events,
  currency,
}: {
  events: Doc<"ledgerEvents">[];
  currency: string;
}) {
  const ordered = [...events].sort((a, b) => b._creationTime - a._creationTime);
  return (
    <Feed>
      {ordered.map((event, index) => {
        const config = EVENT[event.kind];
        return (
          <FeedItem
            key={event._id}
            bullet={config.bullet}
            glyph={config.glyph}
            last={index === ordered.length - 1}
          >
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
              <span className="text-sm font-medium text-ink">{config.label}</span>
              <span className="text-sm font-semibold tabular-nums text-ink">
                {config.sign}
                <Money cents={event.cents} currency={currency} />
              </span>
              <time className="ml-auto text-xs text-ink/40">{when(event._creationTime)}</time>
            </div>
            {event.evidence && <p className="text-xs text-ink/50">{event.evidence}</p>}
          </FeedItem>
        );
      })}
    </Feed>
  );
}
