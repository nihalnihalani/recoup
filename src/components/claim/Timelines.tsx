import type { Doc } from "../../../convex/_generated/dataModel";
import { fmt } from "../../lib/money";
import { when } from "../../lib/ui";
import { ClaimIcon, type ClaimGlyph } from "./icons";

type ReplyClass = Doc<"replies">["classification"];
type EventKind = Doc<"ledgerEvents">["kind"];

/** Colour is semantic: good, waiting, bad, information, everything else. */
type Tone = "good" | "waiting" | "bad" | "info" | "plain";

const TILE: Record<Tone, string> = {
  good: "bg-green-500/10 text-green-700",
  waiting: "bg-yellow-500/15 text-yellow-700",
  bad: "bg-red-500/10 text-red-700",
  info: "bg-sky-500/10 text-sky-700",
  plain: "bg-gray-100 text-gray-500",
};

const REPLY: Record<ReplyClass, { title: string; tone: Tone; glyph: ClaimGlyph }> = {
  promise: { title: "Store promised a credit", tone: "waiting", glyph: "clock" },
  credit_issued: { title: "Store says credit issued", tone: "good", glyph: "check" },
  refusal: { title: "Store refused", tone: "bad", glyph: "cross" },
  question: { title: "Store asked a question", tone: "info", glyph: "question" },
  other: { title: "Reply received", tone: "plain", glyph: "mail" },
};

const EVENT: Record<EventKind, { title: string; tone: Tone; glyph: ClaimGlyph; sign: string }> = {
  promised_credit: { title: "Credit promised", tone: "waiting", glyph: "clock", sign: "" },
  confirmed_credit: { title: "Back on your card", tone: "good", glyph: "card", sign: "+" },
  later_debit: { title: "Charged again", tone: "bad", glyph: "repeat", sign: "−" },
  provisional_credit: { title: "Provisional credit (not final)", tone: "waiting", glyph: "clock", sign: "" },
  provisional_released: { title: "Provisional credit resolved", tone: "plain", glyph: "note", sign: "" },
};

type Entry = {
  key: string;
  at: number;
  tone: Tone;
  glyph: ClaimGlyph;
  title: string;
  /** A signed amount set against the title, right-aligned. */
  amount?: string;
  detail?: string;
  /** A second muted line: who it came from or went to. */
  party?: string;
  warning?: string;
};

function draftEntry(draft: Doc<"drafts">, at: number): Entry {
  const base = {
    key: draft._id,
    at,
    detail: draft.subject,
    party: draft.to.length > 0 ? `To ${draft.to}` : undefined,
  };
  if (draft.sendError !== undefined) {
    return { ...base, tone: "bad", glyph: "alert", title: "Message failed to send", detail: draft.sendError };
  }
  if (draft.agentmailMessageId !== undefined) {
    return { ...base, tone: "info", glyph: "send", title: "Message sent to the store" };
  }
  return { ...base, tone: "info", glyph: "send", title: "Message approved" };
}

function noteEntry(note: Doc<"claimNotes">, currency: string): Entry {
  const base = { key: note._id, at: note._creationTime };
  if (note.kind === "expected_change") {
    const change =
      note.oldCents !== undefined && note.newCents !== undefined
        ? `${fmt(note.oldCents, currency)} to ${fmt(note.newCents, currency)}`
        : undefined;
    return {
      ...base,
      tone: "plain",
      glyph: "pen",
      title: "Expected amount changed",
      amount: note.newCents !== undefined ? fmt(note.newCents, currency) : undefined,
      detail: change ? `${note.text} (${change})` : note.text,
    };
  }
  if (note.kind === "status") {
    // Status notes read "What happened: the user's words"; the first half is the title.
    const cut = note.text.indexOf(": ");
    const title = cut === -1 ? note.text : note.text.slice(0, cut);
    const detail = cut === -1 ? undefined : note.text.slice(cut + 2);
    const sent = title.startsWith("Sent");
    return { ...base, tone: sent ? "info" : "plain", glyph: sent ? "send" : "flag", title, detail };
  }
  return { ...base, tone: "plain", glyph: "note", title: "Note", detail: note.text };
}

/**
 * The claim's whole story on one thread, oldest first: opened, messages out, replies
 * in, money promised and landed. Each entry is a tinted icon tile joined to the next
 * by a hairline. Only timestamps the data carries are used.
 */
export function ClaimTimeline({
  claim,
  drafts,
  replies,
  events,
  notes,
  currency,
}: {
  claim: Doc<"claims">;
  drafts: Doc<"drafts">[];
  replies: Doc<"replies">[];
  events: Doc<"ledgerEvents">[];
  notes: Doc<"claimNotes">[];
  currency: string;
}) {
  const entries: Entry[] = [
    {
      key: claim._id,
      at: claim._creationTime,
      tone: "plain",
      glyph: "flag",
      title: "Claim opened",
      detail: `Expecting ${fmt(claim.expectedCents, currency)} back`,
    },
  ];

  for (const draft of drafts) {
    // A draft only joins the story once it was approved; unsent drafts live in the composer.
    if (draft.approvedAt !== undefined) entries.push(draftEntry(draft, draft.approvedAt));
  }
  for (const reply of replies) {
    const config = REPLY[reply.classification];
    entries.push({
      key: reply._id,
      at: reply.receivedAt,
      tone: config.tone,
      glyph: config.glyph,
      title: config.title,
      amount: reply.promisedCents !== undefined ? fmt(reply.promisedCents, currency) : undefined,
      detail: reply.summary,
      party: `From ${reply.from}`,
      warning: reply.senderMismatch ? "Different sender domain" : undefined,
    });
  }
  for (const event of events) {
    const config = EVENT[event.kind];
    entries.push({
      key: event._id,
      at: event._creationTime,
      tone: config.tone,
      glyph: config.glyph,
      title: config.title,
      amount: `${config.sign}${fmt(event.cents, currency)}`,
      detail: event.evidence.length > 0 ? event.evidence : undefined,
    });
  }
  for (const note of notes) entries.push(noteEntry(note, currency));

  entries.sort((a, b) => a.at - b.at);

  return (
    <ol>
      {entries.map((entry, index) => {
        const last = index === entries.length - 1;
        return (
          <li key={entry.key} className={`relative flex gap-3.5 ${last ? "" : "pb-6"}`}>
            {!last && (
              <span
                className="absolute bottom-1 left-[1.125rem] top-10 w-px -translate-x-1/2 bg-gray-200"
                aria-hidden="true"
              />
            )}
            <span
              className={`flex size-9 shrink-0 items-center justify-center rounded-full ${TILE[entry.tone]}`}
            >
              <ClaimIcon glyph={entry.glyph} className="size-[1.125rem]" />
            </span>
            <div className="min-w-0 grow">
              <div className="flex items-baseline justify-between gap-3">
                <p className="text-sm font-semibold text-gray-900">{entry.title}</p>
                {entry.amount !== undefined && (
                  <span className="shrink-0 text-sm font-semibold tabular-nums text-gray-900">
                    {entry.amount}
                  </span>
                )}
              </div>
              <time
                dateTime={new Date(entry.at).toISOString()}
                className="mt-0.5 block text-xs text-gray-400"
              >
                {when(entry.at)}
              </time>
              {entry.detail !== undefined && (
                <p className="mt-1.5 break-words text-sm text-gray-500">{entry.detail}</p>
              )}
              {(entry.party !== undefined || entry.warning !== undefined) && (
                <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-gray-400">
                  {entry.party !== undefined && <span className="break-all">{entry.party}</span>}
                  {entry.warning !== undefined && (
                    <span
                      role="note"
                      className="inline-flex items-center gap-1 rounded-lg border border-yellow-500/40 bg-yellow-500/10 px-1.5 py-0.5 font-medium text-yellow-700"
                    >
                      <ClaimIcon glyph="alert" className="size-3.5" />
                      {entry.warning}
                    </span>
                  )}
                </p>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
