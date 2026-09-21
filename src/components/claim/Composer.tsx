import { useAction, useMutation, useQuery } from "convex/react";
import { useId, useState } from "react";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../../convex/_generated/api";
import type { Doc } from "../../../convex/_generated/dataModel";
import { ErrorBox } from "../States";
import { ClaimIcon } from "./icons";
import {
  errorText,
  inputClass,
  labelClass,
  primaryButtonClass,
  secondaryButtonClass,
  when,
} from "../../lib/ui";

type SendStatus = FunctionReturnType<typeof api.drafts.sendStatus>;

function domainOf(email: string): string {
  const at = email.lastIndexOf("@");
  return at === -1 ? "" : email.slice(at + 1).toLowerCase();
}

// ---------------------------------------------------------------------------
// Delivery progress: approved -> queued -> sent, as three nodes on a rail (D29)
// ---------------------------------------------------------------------------

type Delivery = { reached: 1 | 2 | 3; tone: "moving" | "done" | "failed" | "unknown"; note: string };

function deliveryOf(sendStatus: SendStatus | undefined, sendUnknown: boolean): Delivery {
  if (sendStatus === undefined) return { reached: 1, tone: "moving", note: "Checking" };
  if (sendStatus === null) return { reached: 2, tone: "moving", note: "Queued" };
  if (sendStatus.agentmailMessageId) return { reached: 3, tone: "done", note: "Sent" };
  if (sendStatus.errorMessage) return { reached: 2, tone: "failed", note: sendStatus.errorMessage };
  if (sendUnknown) return { reached: 2, tone: "unknown", note: "Delivery unknown" };
  return { reached: 2, tone: "moving", note: sendStatus.status };
}

const STEPS = ["Approved", "Queued", "Sent"] as const;

function SendProgress({
  sendStatus,
  sendUnknown,
  approvedAt,
}: {
  sendStatus: SendStatus | undefined;
  sendUnknown: boolean;
  approvedAt?: number;
}) {
  const delivery = deliveryOf(sendStatus, sendUnknown);
  const headDot =
    delivery.tone === "done"
      ? "border-green-600 bg-green-600"
      : delivery.tone === "failed"
        ? "border-red-500 bg-red-500"
        : delivery.tone === "unknown"
          ? "border-gray-400 bg-gray-400"
          : "border-yellow-500 bg-yellow-500 motion-safe:animate-pulse";
  const noteTone =
    delivery.tone === "done"
      ? "text-green-700"
      : delivery.tone === "failed"
        ? "text-red-700"
        : "text-gray-500";

  return (
    <div
      className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 rounded-xl border border-gray-200 px-3.5 py-3"
      role="status"
      aria-live="polite"
    >
      <ol className="flex min-w-0 flex-1 items-center" aria-label={`Delivery: ${delivery.note}`}>
        {STEPS.map((step, index) => {
          const position = index + 1;
          const isHead = position === delivery.reached;
          const isPast = position < delivery.reached;
          return (
            <li key={step} className={`flex items-center ${index > 0 ? "flex-1" : ""}`}>
              {index > 0 && (
                <span
                  className={`mx-2 h-px min-w-3 flex-1 ${isPast || isHead ? "bg-gray-900" : "bg-gray-200"}`}
                  aria-hidden="true"
                />
              )}
              <span className="flex items-center gap-1.5">
                <span
                  className={`size-2 rounded-full border ${
                    isHead ? headDot : isPast ? "border-gray-900 bg-gray-900" : "border-gray-300 bg-white"
                  }`}
                  aria-hidden="true"
                />
                <span
                  className={`text-xs font-medium ${isHead || isPast ? "text-gray-900" : "text-gray-400"}`}
                >
                  {step}
                </span>
              </span>
            </li>
          );
        })}
      </ol>
      <p className={`min-w-0 break-words text-xs ${noteTone}`}>
        {delivery.tone === "done" && approvedAt !== undefined ? when(approvedAt) : delivery.note}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Packet path: the merchant takes claims by form / chat / phone, not email
// ---------------------------------------------------------------------------

export function PacketRow({
  claim,
  channel,
  copyText,
}: {
  claim: Doc<"claims">;
  channel: string;
  copyText?: string;
}) {
  const markPacketSent = useMutation(api.drafts.markPacketSent);
  const noteId = useId();
  const [note, setNote] = useState("");
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function copy() {
    if (copyText === undefined) return;
    setError(null);
    try {
      await navigator.clipboard.writeText(copyText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch (caught) {
      setError(errorText(caught));
    }
  }

  async function record() {
    setError(null);
    setBusy(true);
    try {
      await markPacketSent({ claimId: claim._id, note: note.trim() });
      setNote("");
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 rounded-xl border border-gray-200 p-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-sm font-semibold text-gray-900">
            <span className="size-1.5 shrink-0 rounded-full bg-sky-500" aria-hidden="true" />
            This store takes claims by {channel}
          </p>
          <p className="mt-0.5 text-xs text-gray-500">
            Send the message there yourself, then record it here.
          </p>
        </div>
        {copyText !== undefined && (
          <button type="button" className={secondaryButtonClass} onClick={() => void copy()}>
            <ClaimIcon glyph={copied ? "check" : "copy"} className="size-4" />
            <span aria-live="polite">{copied ? "Copied" : "Copy message"}</span>
          </button>
        )}
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1 basis-56">
          <label htmlFor={noteId} className={labelClass}>
            What you sent and where
          </label>
          <input
            id={noteId}
            className={inputClass}
            placeholder="Chat with support, ticket 4821"
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </div>
        <button
          type="button"
          disabled={busy || note.trim().length === 0}
          className={`${primaryButtonClass} w-full sm:w-auto`}
          onClick={() => void record()}
        >
          {busy ? "Recording…" : "Record as sent"}
        </button>
      </div>
      {error && <ErrorBox error={error} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Composer (D11 version binding, D18 recipient gate, D29 send status)
// ---------------------------------------------------------------------------

export function Composer({
  draft,
  claim,
  merchantDomain,
  packetChannel,
  closed,
}: {
  draft: Doc<"drafts">;
  claim: Doc<"claims">;
  merchantDomain: string;
  /** Set when the policy says claims go through a non-email channel. */
  packetChannel?: string;
  closed: boolean;
}) {
  const update = useMutation(api.drafts.update);
  const approveAndSend = useMutation(api.drafts.approveAndSend);
  // The store's reply has to come back to this user, so a claim email goes out from their own Recoup
  // inbox. It is created on the first send rather than at sign-up (idempotent: returns the existing one).
  const ensureInbox = useAction(api.profiles.ensureInbox);
  const sendStatus = useQuery(api.drafts.sendStatus, { draftId: draft._id });

  const toId = useId();
  const subjectId = useId();
  const bodyId = useId();
  const mismatchId = useId();

  const [to, setTo] = useState(draft.to);
  const [subject, setSubject] = useState(draft.subject);
  const [body, setBody] = useState(draft.body);
  const [recipientConfirmed, setRecipientConfirmed] = useState(draft.recipientConfirmed === true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const sent = draft.outboundId !== undefined;
  const locked = sent || closed;
  const mismatch =
    to.trim().length > 0 &&
    merchantDomain.length > 0 &&
    !domainOf(to).endsWith(merchantDomain.toLowerCase());

  async function run(work: () => Promise<unknown>) {
    setError(null);
    setBusy(true);
    try {
      await work();
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  }

  // Label on the left at sm and up, stacked above the field on a phone.
  const row = "grid grid-cols-1 gap-1.5 sm:grid-cols-[5rem_minmax(0,1fr)] sm:gap-3";
  const rowLabel = "text-sm font-medium text-gray-500 sm:pt-2.5";
  const field = `${inputClass} disabled:bg-gray-50 disabled:text-gray-500 disabled:hover:border-gray-200`;

  return (
    <div className="space-y-4">
      <div className="space-y-3">
        <div className={row}>
          <label htmlFor={toId} className={rowLabel}>
            To
          </label>
          <div className="min-w-0">
            <input
              id={toId}
              inputMode="email"
              autoComplete="off"
              className={field}
              value={to}
              disabled={locked}
              placeholder="Store support address"
              aria-describedby={mismatch && !locked ? mismatchId : undefined}
              onChange={(event) => setTo(event.target.value)}
            />
            {mismatch && !locked && (
              <p
                id={mismatchId}
                className="mt-1.5 inline-flex items-center gap-1.5 rounded-lg border border-yellow-500/40 bg-yellow-500/10 px-2 py-1 text-xs font-medium text-yellow-700"
              >
                <ClaimIcon glyph="alert" className="size-3.5" />
                <span className="break-all">Not an address on {merchantDomain}</span>
              </p>
            )}
          </div>
        </div>
        <div className={row}>
          <label htmlFor={subjectId} className={rowLabel}>
            Subject
          </label>
          <input
            id={subjectId}
            className={`${field} font-medium`}
            value={subject}
            disabled={locked}
            onChange={(event) => setSubject(event.target.value)}
          />
        </div>
        <div className={row}>
          <label htmlFor={bodyId} className={rowLabel}>
            Message
          </label>
          <textarea
            id={bodyId}
            rows={11}
            className={`${field} block resize-y leading-relaxed`}
            value={body}
            disabled={locked}
            onChange={(event) => setBody(event.target.value)}
          />
        </div>
      </div>

      {error && <ErrorBox error={error} />}
      {draft.sendError && (
        <div
          role="alert"
          className="flex items-start gap-2.5 rounded-xl border border-red-500/30 bg-red-500/5 px-3.5 py-3 text-sm text-red-700"
        >
          <ClaimIcon glyph="alert" className="mt-0.5 size-4" />
          <p className="min-w-0 break-words">
            <span className="font-semibold">The message did not send.</span> {draft.sendError}
          </p>
        </div>
      )}

      {sent ? (
        <SendProgress
          sendStatus={sendStatus}
          sendUnknown={claim.sendUnknown === true}
          approvedAt={draft.approvedAt}
        />
      ) : (
        !closed && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-dashed border-gray-200 pt-4">
            <label className="flex items-center gap-2.5 text-sm font-medium text-gray-900">
              <input
                type="checkbox"
                checked={recipientConfirmed}
                onChange={(event) => setRecipientConfirmed(event.target.checked)}
                className="size-4 rounded accent-gray-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-500"
              />
              This is the right recipient
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={busy}
                className={secondaryButtonClass}
                onClick={() => void run(() => update({ draftId: draft._id, to, subject, body }))}
              >
                Save draft
              </button>
              <button
                type="button"
                disabled={busy}
                className={primaryButtonClass}
                onClick={() =>
                  void run(async () => {
                    await ensureInbox({});
                    return approveAndSend({
                      draftId: draft._id,
                      to,
                      subject,
                      body,
                      claimVersion: claim.version,
                      draftVersion: draft.version,
                      recipientConfirmed,
                    });
                  })
                }
              >
                {busy ? "Sending…" : "Approve & send"}
              </button>
            </div>
          </div>
        )
      )}

      {packetChannel !== undefined && !closed && (
        <PacketRow claim={claim} channel={packetChannel} copyText={`${subject}\n\n${body}`} />
      )}
    </div>
  );
}
