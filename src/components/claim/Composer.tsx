import { useMutation, useQuery } from "convex/react";
import { useId, useState } from "react";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../../convex/_generated/api";
import type { Doc } from "../../../convex/_generated/dataModel";
import { ErrorBox } from "../States";
import {
  errorText,
  inputClass,
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
  const headTone =
    delivery.tone === "done"
      ? "bg-moss border-moss"
      : delivery.tone === "failed"
        ? "bg-rust border-rust"
        : delivery.tone === "unknown"
          ? "bg-ink/40 border-ink/40"
          : "bg-gold border-gold motion-safe:animate-pulse";

  return (
    <div className="space-y-1.5" role="status" aria-live="polite">
      <ol className="flex items-center" aria-label={`Delivery: ${delivery.note}`}>
        {STEPS.map((step, index) => {
          const position = index + 1;
          const isHead = position === delivery.reached;
          const isPast = position < delivery.reached;
          return (
            <li key={step} className={`flex items-center ${index > 0 ? "flex-1" : ""}`}>
              {index > 0 && (
                <span
                  className={`h-0.5 flex-1 ${isPast || isHead ? "bg-harbor/60" : "bg-line"}`}
                  aria-hidden="true"
                />
              )}
              <span className="flex items-center gap-1.5 px-1.5">
                <span
                  className={`size-2.5 rounded-full border-2 ${
                    isHead ? headTone : isPast ? "border-harbor bg-harbor" : "border-line bg-paper"
                  }`}
                  aria-hidden="true"
                />
                <span className={`text-xs ${isHead || isPast ? "text-ink" : "text-ink/40"}`}>
                  {step}
                </span>
              </span>
            </li>
          );
        })}
      </ol>
      <p
        className={`text-xs ${delivery.tone === "failed" ? "text-rust" : "text-ink/50"}`}
      >
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
    <div className="space-y-3 rounded-lg bg-teal/10 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-teal/20 px-1.5 text-sm font-medium text-teal">
          Merchant channel: {channel}
        </span>
        {copyText !== undefined && (
          <button type="button" className={secondaryButtonClass} onClick={() => void copy()}>
            {copied ? "Copied" : "Copy message"}
          </button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={noteId} className="sr-only">
          What you sent and where
        </label>
        <input
          id={noteId}
          className={`${inputClass} min-w-0 flex-1`}
          placeholder="What you sent and where"
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
        <button
          type="button"
          disabled={busy || note.trim().length === 0}
          className={primaryButtonClass}
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
  const sendStatus = useQuery(api.drafts.sendStatus, { draftId: draft._id });

  const toId = useId();
  const subjectId = useId();
  const bodyId = useId();

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

  const fieldRow = "flex items-baseline gap-3 border-b border-line px-4 py-2";
  const fieldLabel = "w-16 shrink-0 text-xs font-semibold uppercase text-ink/40";
  const bareInput =
    "min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink/30 disabled:text-ink/60";

  return (
    <div className="space-y-3">
      <div className="overflow-hidden rounded-lg border border-line bg-white focus-within:border-harbor/60">
        <div className={fieldRow}>
          <label htmlFor={toId} className={fieldLabel}>
            To
          </label>
          <input
            id={toId}
            className={bareInput}
            value={to}
            disabled={locked}
            placeholder="merchant contact address"
            onChange={(event) => setTo(event.target.value)}
          />
          {mismatch && !locked && (
            <span className="shrink-0 rounded-full bg-rust/20 px-1.5 text-sm font-medium text-rust">
              not on {merchantDomain}
            </span>
          )}
        </div>
        <div className={fieldRow}>
          <label htmlFor={subjectId} className={fieldLabel}>
            Subject
          </label>
          <input
            id={subjectId}
            className={`${bareInput} font-medium`}
            value={subject}
            disabled={locked}
            onChange={(event) => setSubject(event.target.value)}
          />
        </div>
        <label htmlFor={bodyId} className="sr-only">
          Message
        </label>
        <textarea
          id={bodyId}
          rows={11}
          className="block w-full resize-y bg-transparent px-4 py-3 text-sm leading-relaxed text-ink outline-none disabled:text-ink/60"
          value={body}
          disabled={locked}
          onChange={(event) => setBody(event.target.value)}
        />
      </div>

      {error && <ErrorBox error={error} />}
      {draft.sendError && <ErrorBox error={`Send failed: ${draft.sendError}`} />}

      {sent ? (
        <SendProgress
          sendStatus={sendStatus}
          sendUnknown={claim.sendUnknown === true}
          approvedAt={draft.approvedAt}
        />
      ) : (
        !closed && (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <label className="flex items-center gap-2 text-sm font-medium text-ink">
              <input
                type="checkbox"
                checked={recipientConfirmed}
                onChange={(event) => setRecipientConfirmed(event.target.checked)}
                className="size-4 rounded accent-harbor"
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
                  void run(() =>
                    approveAndSend({
                      draftId: draft._id,
                      to,
                      subject,
                      body,
                      claimVersion: claim.version,
                      draftVersion: draft.version,
                      recipientConfirmed,
                    }),
                  )
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
