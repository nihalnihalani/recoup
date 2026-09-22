import { useAction, useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { api } from "../../../convex/_generated/api";
import type { Doc } from "../../../convex/_generated/dataModel";
import { deliveryOf, type SendStatus } from "../../lib/delivery";
import { formatMinor } from "../../lib/money";
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

function domainOf(email: string): string {
  const at = email.lastIndexOf("@");
  return at === -1 ? "" : email.slice(at + 1).toLowerCase();
}

// ---------------------------------------------------------------------------
// Delivery progress: approved -> queued -> sent, as three nodes on a rail
// (D29). The state -> label/tone mapping (`deliveryOf`, D13/D68) lives in
// ../../lib/delivery so it stays a plain, unit-testable function and this
// file only exports components (oxlint react/only-export-components).
// ---------------------------------------------------------------------------

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
        {delivery.tone === "done" && delivery.note === "Sent" && approvedAt !== undefined
          ? when(approvedAt)
          : delivery.note}
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
// Composer (D11 version binding, D18 recipient gate, D29 send status; M15:
// prepareSend first, acknowledgeable refusals, resend after an unknown outcome)
// ---------------------------------------------------------------------------

type PrepareCode = Extract<FunctionReturnType<typeof api.drafts.prepareSend>, { ok: false }>["code"];

/**
 * What the send area is waiting on after `prepareSend` (or a resend) refused. Acknowledgeable refusals are never a
 * hard block (C1, DA-A-21; SEC-AI-4): the user reads the reason and chooses to send anyway. The others explain why
 * nothing was sent and what to do.
 */
type Pending =
  | { kind: "ack_window"; message: string }
  | { kind: "ack_amount"; message: string; estimate: { amountMinor: number; currency: string } | undefined }
  | { kind: "ack_content"; message: string; findings: string[] }
  | { kind: "blocked"; message: string }
  | { kind: "review"; message: string }
  | { kind: "retry_later"; message: string };

function pendingFor(
  code: PrepareCode | "outcome_known",
  message: string,
  findings: string[] | undefined,
  estimate?: { amountMinor: number; currency: string },
): Pending {
  switch (code) {
    case "window_may_have_passed":
      return { kind: "ack_window", message };
    case "amount_exceeds_estimate":
      return { kind: "ack_amount", message, estimate };
    case "unverified_content":
      return { kind: "ack_content", message, findings: findings ?? [] };
    case "outcome_not_approvable":
    case "example_claim":
      return { kind: "blocked", message };
    case "rate_limited":
      return { kind: "retry_later", message };
    case "binding_changed":
    case "rule_withdrawn":
    case "outcome_known":
      return { kind: "review", message };
  }
}

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
  const prepareSend = useMutation(api.drafts.prepareSend);
  const approveAndSend = useMutation(api.drafts.approveAndSend);
  const resendAfterUnknown = useMutation(api.drafts.resendAfterUnknown);
  const adjustExpected = useMutation(api.claims.adjustExpected);
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
  const [pending, setPending] = useState<Pending | null>(null);
  // What the user has acknowledged for THIS text. Editing the text clears the content acknowledgment (the findings
  // belong to the old text); the window acknowledgment is about the claim, not the words, so it stays.
  const [ackWindow, setAckWindow] = useState(false);
  const [ackContent, setAckContent] = useState(false);
  const [ackAmount, setAckAmount] = useState(false);
  const [resendAcknowledged, setResendAcknowledged] = useState(false);

  const sent = draft.outboundId !== undefined;
  const locked = sent || closed;
  const unknownOutcome = sent && claim.sendUnknown === true && !closed;
  const mismatch =
    to.trim().length > 0 &&
    merchantDomain.length > 0 &&
    !domainOf(to).endsWith(merchantDomain.toLowerCase());

  function edit(setter: (value: string) => void, value: string) {
    setter(value);
    setAckContent(false);
    if (pending?.kind === "ack_content") setPending(null);
  }

  /**
   * A refusal replaces whatever was pending. DA-B-11: a content acknowledgment covers only the findings the user
   * was shown, so any new refusal clears it; the next "send anyway" is for what is on screen now.
   */
  function refuse(next: Pending) {
    setAckContent(false);
    setPending(next);
  }

  // DA-B-12: a refusal moves focus to its panel's heading, so keyboard and screen-reader users land on the decision.
  const pendingHeadingRef = useRef<HTMLHeadingElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const sendButtonRef = useRef<HTMLButtonElement>(null);
  const pendingMessageId = useId();
  useEffect(() => {
    if (pending) pendingHeadingRef.current?.focus();
  }, [pending]);

  /** The safe way out of a refusal: close it and put the user back where they can change what they send. */
  function backToEditing() {
    setPending(null);
    if (!locked) bodyRef.current?.focus();
    else sendButtonRef.current?.focus();
  }

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

  type Acks = { window: boolean; content: boolean; amount?: boolean };

  const approval = (acks: Acks) => ({
    draftId: draft._id,
    to,
    subject,
    body,
    ...(acks.window ? { acknowledgeWindowRisk: true } : {}),
    ...(acks.content ? { acknowledgeUnverifiedContent: true } : {}),
    ...(acks.amount ? { acknowledgeAmountAboveEstimate: true } : {}),
  });

  /** §6: prepareSend ALWAYS runs first; only its `preparedHash` (with the user's acknowledgments) is sent. */
  async function send(acks: Acks) {
    setPending(null);
    await ensureInbox({});
    const prepared = await prepareSend(approval(acks));
    if (!prepared.ok) {
      refuse(pendingFor(prepared.code, prepared.message, prepared.findings, prepared.estimate));
      return;
    }
    await approveAndSend({
      ...approval(acks),
      claimVersion: claim.version,
      draftVersion: draft.version,
      recipientConfirmed,
      preparedHash: prepared.preparedHash,
    });
  }

  /** S-M03-1 / DA-A-31: a new attempt after an unknown outcome, acknowledged, with the full checks on the server. */
  async function resend(acks: Acks) {
    if (!draft.outboundId) return;
    setPending(null);
    const result = await resendAfterUnknown({
      ...approval(acks),
      claimVersion: claim.version,
      draftVersion: draft.version,
      recipientConfirmed,
      acknowledgedOutboundId: draft.outboundId,
    });
    if (!result.ok) {
      refuse(
        pendingFor(result.code, result.message, "findings" in result ? result.findings : undefined, "estimate" in result ? result.estimate : undefined),
      );
    }
  }

  const act = (acks: Acks) => (unknownOutcome ? resend(acks) : send(acks));

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
              onChange={(event) => edit(setTo, event.target.value)}
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
            onChange={(event) => edit(setSubject, event.target.value)}
          />
        </div>
        <div className={row}>
          <label htmlFor={bodyId} className={rowLabel}>
            Message
          </label>
          <textarea
            ref={bodyRef}
            id={bodyId}
            rows={11}
            className={`${field} block resize-y leading-relaxed`}
            value={body}
            disabled={locked}
            onChange={(event) => edit(setBody, event.target.value)}
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

      {sent && (
        <SendProgress
          sendStatus={sendStatus}
          sendUnknown={claim.sendUnknown === true}
          approvedAt={draft.approvedAt}
        />
      )}

      {pending && (
        <PendingPanel
          pending={pending}
          busy={busy}
          headingRef={pendingHeadingRef}
          messageId={pendingMessageId}
          canEdit={!locked}
          onBack={backToEditing}
          onAckWindow={() =>
            void run(async () => {
              setAckWindow(true);
              await act({ window: true, content: ackContent, amount: ackAmount });
            })
          }
          onAckContent={() =>
            void run(async () => {
              setAckContent(true);
              await act({ window: ackWindow, content: true, amount: ackAmount });
            })
          }
          claimedMinor={claim.expectedCents}
          onAckAmount={() =>
            void run(async () => {
              setAckAmount(true);
              await act({ window: ackWindow, content: ackContent, amount: true });
            })
          }
          onAdjustAmount={(estimateMinor) =>
            void run(async () => {
              await adjustExpected({ claimId: claim._id, expectedCents: estimateMinor, reason: "Adjusted to Recoup's current estimate" });
              await act({ window: ackWindow, content: ackContent });
            })
          }
        />
      )}

      {unknownOutcome && (
        <div className="space-y-3 rounded-xl border border-gray-200 px-3.5 py-3">
          <p className="text-sm text-gray-900">
            <span className="font-semibold">We couldn't confirm the earlier message was sent.</span> It was approved{" "}
            {draft.approvedAt !== undefined ? when(draft.approvedAt) : "earlier"} and may already have reached the store.
            Sending again can mean the store gets it twice.
          </p>
          <label className="flex items-start gap-2.5 text-sm font-medium text-gray-900">
            <input
              type="checkbox"
              checked={resendAcknowledged}
              onChange={(event) => setResendAcknowledged(event.target.checked)}
              className="mt-0.5 size-4 rounded accent-gray-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-500"
            />
            I understand the earlier message may already have arrived
          </label>
          <button
            ref={sendButtonRef}
            type="button"
            disabled={busy || !resendAcknowledged}
            aria-describedby={pending ? pendingMessageId : undefined}
            className={primaryButtonClass}
            onClick={() => void run(() => act({ window: ackWindow, content: ackContent, amount: ackAmount }))}
          >
            {busy ? "Sending…" : "Send again"}
          </button>
        </div>
      )}

      {!sent && !closed && (
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
              ref={sendButtonRef}
              type="button"
              disabled={busy || pending?.kind === "blocked"}
              aria-describedby={pending ? pendingMessageId : undefined}
              className={primaryButtonClass}
              onClick={() => void run(() => send({ window: ackWindow, content: ackContent, amount: ackAmount }))}
            >
              {busy ? "Sending…" : "Approve & send"}
            </button>
          </div>
        </div>
      )}

      {packetChannel !== undefined && !closed && (
        <PacketRow claim={claim} channel={packetChannel} copyText={`${subject}\n\n${body}`} />
      )}
    </div>
  );
}

const PANEL_HEADINGS: Record<Pending["kind"], string> = {
  ack_window: "The store's window may have passed",
  ack_amount: "This claim asks more than Recoup's estimate",
  ack_content: "Check these details before sending",
  blocked: "Not sent",
  review: "Nothing was sent: review the claim again",
  retry_later: "Not sent yet",
};

/**
 * The reason nothing was sent (DA-B-12): a labelled region whose heading takes focus, the reason as the send
 * button's description, and, for an acknowledgeable refusal, the SAFE action first in DOM and tab order, then the
 * explicit "send anyway". Nothing is sent without one of those actions.
 */
function PendingPanel({
  pending,
  busy,
  headingRef,
  messageId,
  canEdit,
  onBack,
  onAckWindow,
  onAckContent,
  claimedMinor,
  onAckAmount,
  onAdjustAmount,
}: {
  pending: Pending;
  busy: boolean;
  headingRef: RefObject<HTMLHeadingElement | null>;
  messageId: string;
  canEdit: boolean;
  onBack: () => void;
  onAckWindow: () => void;
  onAckContent: () => void;
  /** The claim's asked amount, in the estimate's currency (the server compares only same-currency amounts). */
  claimedMinor: number;
  onAckAmount: () => void;
  onAdjustAmount: (estimateMinor: number) => void;
}) {
  const headingId = useId();
  const tone =
    pending.kind === "blocked"
      ? "border-red-500/30 bg-red-500/5 text-red-700"
      : pending.kind === "ack_window" || pending.kind === "ack_content" || pending.kind === "ack_amount"
        ? "border-yellow-500/40 bg-yellow-500/10 text-gray-900"
        : "border-gray-200 text-gray-900";
  const safe = (
    <button type="button" disabled={busy} className={primaryButtonClass} onClick={onBack}>
      {canEdit ? "Keep editing" : "Don't send"}
    </button>
  );
  // DA-B-2: the claim asks more than Recoup's exact estimate. Adjusting is the safe action; asking for the full
  // amount is the explicit acknowledgment. Without an estimate to adjust to, the safe action is to go back.
  const estimate = pending.kind === "ack_amount" ? pending.estimate : undefined;
  const claimed = estimate ? formatMinor(claimedMinor, estimate.currency) : null;
  const estimated = estimate ? formatMinor(estimate.amountMinor, estimate.currency) : null;
  return (
    <section aria-labelledby={headingId} className={`space-y-2.5 rounded-xl border px-3.5 py-3 text-sm ${tone}`}>
      <h3 id={headingId} ref={headingRef} tabIndex={-1} className="font-semibold outline-none focus-visible:underline">
        {PANEL_HEADINGS[pending.kind]}
      </h3>
      <p id={messageId}>
        {pending.kind === "ack_amount" && estimate
          ? `This claim asks ${claimed}; Recoup's current estimate is ${estimated}. Adjusting changes the claim, so you then write a new draft that asks for ${estimated}.`
          : pending.message}
      </p>
      {pending.kind === "ack_content" && pending.findings.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-5">
          {pending.findings.map((finding) => (
            <li key={finding} className="break-all font-mono text-xs">
              {finding}
            </li>
          ))}
        </ul>
      )}
      {pending.kind === "ack_amount" && (
        <div className="flex flex-wrap gap-2">
          {estimate ? (
            <button type="button" disabled={busy} className={primaryButtonClass} onClick={() => onAdjustAmount(estimate.amountMinor)}>
              Adjust to {estimated}
            </button>
          ) : (
            safe
          )}
          <button type="button" disabled={busy} className={secondaryButtonClass} onClick={onAckAmount}>
            {claimed ? `Send ${claimed} anyway` : "Send the full amount anyway"}
          </button>
        </div>
      )}
      {pending.kind === "ack_window" && (
        <div className="flex flex-wrap gap-2">
          {safe}
          <button type="button" disabled={busy} className={secondaryButtonClass} onClick={onAckWindow}>
            Send anyway — the store's price-adjustment window may have passed
          </button>
        </div>
      )}
      {pending.kind === "ack_content" && (
        <div className="flex flex-wrap gap-2">
          {safe}
          <button type="button" disabled={busy} className={secondaryButtonClass} onClick={onAckContent}>
            I checked these details — send anyway
          </button>
        </div>
      )}
    </section>
  );
}
