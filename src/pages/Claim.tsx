import { useAction, useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { ConvexError } from "convex/values";
import { useParams } from "react-router-dom";
import { useState, type FormEvent } from "react";
import { api } from "../../convex/_generated/api";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { Money } from "../components/Money";
import { StatusPill } from "../components/StatusPill";
import { Empty, Loading, QueryBoundary } from "../components/States";

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ConvexError && typeof err.data === "string" ? err.data : fallback;
}

function useIdempotencyKey(): [string, () => void] {
  const [key, setKey] = useState(() => crypto.randomUUID());
  return [key, () => setKey(crypto.randomUUID())];
}

type ClaimData = NonNullable<FunctionReturnType<typeof api.claims.get>>;

// ---------------------------------------------------------------------------
// Ledger strip
// ---------------------------------------------------------------------------

function Stat({ label, cents, currency }: { label: string; cents: number; currency: string }) {
  return (
    <div className="bg-paper px-4 py-3">
      <dt className="text-xs font-semibold uppercase tracking-wide text-ink/50">{label}</dt>
      <dd className="mt-1 font-mono text-lg tabular-nums text-ink">
        <Money cents={cents} currency={currency} />
      </dd>
    </div>
  );
}

function LedgerStrip({ balance, currency }: { balance: ClaimData["balance"]; currency: string }) {
  return (
    <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-4">
      <Stat label="Expected" cents={balance.expected} currency={currency} />
      <Stat label="Promised" cents={balance.promised} currency={currency} />
      <Stat label="Confirmed" cents={balance.confirmed} currency={currency} />
      {balance.unresolved < 0 ? (
        <div className="bg-paper px-4 py-3">
          <dt className="text-xs font-semibold uppercase tracking-wide text-rust/80">Unresolved</dt>
          <dd className="mt-1 font-mono text-lg tabular-nums text-rust">
            over-credited by <Money cents={-balance.unresolved} currency={currency} />
          </dd>
        </div>
      ) : (
        <Stat label="Unresolved" cents={balance.unresolved} currency={currency} />
      )}
    </dl>
  );
}

// ---------------------------------------------------------------------------
// Policy (read-only; refresh/confirm live on the Purchase page)
// ---------------------------------------------------------------------------

function PolicyReadCard({ policy }: { policy: Doc<"policies"> }) {
  return (
    <div className="space-y-1 rounded-lg border border-line bg-white/70 p-4">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-ink/50">
        {policy.kind === "returns" ? "Returns policy" : "Price-adjustment policy"}
      </h2>
      <blockquote className="font-serif text-sm italic text-ink">
        {policy.passage ? `“${policy.passage}”` : "No passage found"}
      </blockquote>
      <p className="text-xs text-ink/50">
        Current policy · retrieved {new Date(policy.retrievedAt).toLocaleString()}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Money section: confirm a credit / record a later charge (D24)
// ---------------------------------------------------------------------------

function MoneySection({ claim, currency }: { claim: Doc<"claims">; currency: string }) {
  const confirmCredit = useMutation(api.claims.confirmCredit);
  const recordLaterDebit = useMutation(api.claims.recordLaterDebit);
  const disabled = claim.status === "dismissed";

  const [confirmKey, resetConfirmKey] = useIdempotencyKey();
  const [confirmAmount, setConfirmAmount] = useState("");
  const [confirmEvidence, setConfirmEvidence] = useState("");
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [confirmSubmitting, setConfirmSubmitting] = useState(false);

  const [debitKey, resetDebitKey] = useIdempotencyKey();
  const [debitAmount, setDebitAmount] = useState("");
  const [debitEvidence, setDebitEvidence] = useState("");
  const [debitError, setDebitError] = useState<string | null>(null);
  const [debitSubmitting, setDebitSubmitting] = useState(false);

  async function handleConfirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setConfirmError(null);
    const cents = Math.round(parseFloat(confirmAmount) * 100);
    if (!Number.isInteger(cents) || cents < 0) {
      setConfirmError("Enter a valid, non-negative amount.");
      return;
    }
    setConfirmSubmitting(true);
    try {
      await confirmCredit({ claimId: claim._id, cents, evidence: confirmEvidence, idempotencyKey: confirmKey });
      setConfirmAmount("");
      setConfirmEvidence("");
      resetConfirmKey();
    } catch (err) {
      setConfirmError(errorMessage(err, "Couldn't record that credit."));
    } finally {
      setConfirmSubmitting(false);
    }
  }

  async function handleDebit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setDebitError(null);
    const cents = Math.round(parseFloat(debitAmount) * 100);
    if (!Number.isInteger(cents) || cents < 0) {
      setDebitError("Enter a valid, non-negative amount.");
      return;
    }
    setDebitSubmitting(true);
    try {
      await recordLaterDebit({ claimId: claim._id, cents, evidence: debitEvidence, idempotencyKey: debitKey });
      setDebitAmount("");
      setDebitEvidence("");
      resetDebitKey();
    } catch (err) {
      setDebitError(errorMessage(err, "Couldn't record that charge."));
    } finally {
      setDebitSubmitting(false);
    }
  }

  return (
    <section className="grid gap-4 sm:grid-cols-2">
      <form onSubmit={(e) => void handleConfirm(e)} className="space-y-2 rounded-lg border border-line bg-white/70 p-4">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-ink/50">Confirm a credit posted</h2>
        <div>
          <label htmlFor="confirm-amount" className="mb-1 block text-sm font-medium text-ink">
            Amount ({currency})
          </label>
          <input
            id="confirm-amount"
            type="number"
            min="0"
            step="0.01"
            required
            disabled={disabled}
            value={confirmAmount}
            onChange={(e) => setConfirmAmount(e.target.value)}
            className="w-full rounded-md border border-line bg-white px-3 py-2 text-sm text-ink outline-none focus:border-harbor focus:ring-2 focus:ring-harbor/20"
          />
        </div>
        <div>
          <label htmlFor="confirm-evidence" className="mb-1 block text-sm font-medium text-ink">
            Evidence
          </label>
          <input
            id="confirm-evidence"
            type="text"
            required
            disabled={disabled}
            placeholder="e.g. statement line, refund email"
            value={confirmEvidence}
            onChange={(e) => setConfirmEvidence(e.target.value)}
            className="w-full rounded-md border border-line bg-white px-3 py-2 text-sm text-ink outline-none focus:border-harbor focus:ring-2 focus:ring-harbor/20"
          />
        </div>
        {confirmError && (
          <p role="alert" className="text-sm text-rust">
            {confirmError}
          </p>
        )}
        <button
          type="submit"
          disabled={disabled || confirmSubmitting}
          className="rounded-md bg-moss px-4 py-2 text-sm font-semibold text-paper disabled:opacity-60"
        >
          {confirmSubmitting ? "Saving…" : "Confirm credit"}
        </button>
      </form>

      <form onSubmit={(e) => void handleDebit(e)} className="space-y-2 rounded-lg border border-line bg-white/70 p-4">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-ink/50">Record a later charge</h2>
        <div>
          <label htmlFor="debit-amount" className="mb-1 block text-sm font-medium text-ink">
            Amount ({currency})
          </label>
          <input
            id="debit-amount"
            type="number"
            min="0"
            step="0.01"
            required
            disabled={disabled}
            value={debitAmount}
            onChange={(e) => setDebitAmount(e.target.value)}
            className="w-full rounded-md border border-line bg-white px-3 py-2 text-sm text-ink outline-none focus:border-harbor focus:ring-2 focus:ring-harbor/20"
          />
        </div>
        <div>
          <label htmlFor="debit-evidence" className="mb-1 block text-sm font-medium text-ink">
            Evidence
          </label>
          <input
            id="debit-evidence"
            type="text"
            required
            disabled={disabled}
            placeholder="e.g. a new charge appeared on the statement"
            value={debitEvidence}
            onChange={(e) => setDebitEvidence(e.target.value)}
            className="w-full rounded-md border border-line bg-white px-3 py-2 text-sm text-ink outline-none focus:border-harbor focus:ring-2 focus:ring-harbor/20"
          />
        </div>
        {debitError && (
          <p role="alert" className="text-sm text-rust">
            {debitError}
          </p>
        )}
        <button
          type="submit"
          disabled={disabled || debitSubmitting}
          className="rounded-md bg-rust px-4 py-2 text-sm font-semibold text-paper disabled:opacity-60"
        >
          {debitSubmitting ? "Saving…" : "Record charge"}
        </button>
      </form>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Adjust expected (D24: note only, no ledger event)
// ---------------------------------------------------------------------------

function AdjustExpectedForm({ claim }: { claim: Doc<"claims"> }) {
  const adjustExpected = useMutation(api.claims.adjustExpected);
  const [amount, setAmount] = useState((claim.expectedCents / 100).toFixed(2));
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const cents = Math.round(parseFloat(amount) * 100);
    if (!Number.isInteger(cents) || cents <= 0) {
      setError("Enter a positive amount.");
      return;
    }
    if (!reason.trim()) {
      setError("Say why you're adjusting this.");
      return;
    }
    setSubmitting(true);
    try {
      await adjustExpected({ claimId: claim._id, expectedCents: cents, reason });
      setReason("");
    } catch (err) {
      setError(errorMessage(err, "Couldn't adjust the expected amount."));
    } finally {
      setSubmitting(false);
    }
  }

  if (claim.status === "dismissed") return null;

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="space-y-2 rounded-lg border border-line bg-white/50 p-4">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-ink/50">Adjust expected amount</h2>
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="adjust-amount" className="mb-1 block text-sm font-medium text-ink">
            New expected amount
          </label>
          <input
            id="adjust-amount"
            type="number"
            min="0.01"
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="w-32 rounded-md border border-line bg-white px-3 py-2 text-sm text-ink outline-none focus:border-harbor focus:ring-2 focus:ring-harbor/20"
          />
        </div>
        <div className="min-w-[12rem] flex-1">
          <label htmlFor="adjust-reason" className="mb-1 block text-sm font-medium text-ink">
            Reason
          </label>
          <input
            id="adjust-reason"
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="w-full rounded-md border border-line bg-white px-3 py-2 text-sm text-ink outline-none focus:border-harbor focus:ring-2 focus:ring-harbor/20"
          />
        </div>
        <button
          type="submit"
          disabled={submitting}
          className="rounded-md border border-line px-4 py-2 text-sm font-semibold text-ink/70 disabled:opacity-60"
        >
          {submitting ? "Saving…" : "Adjust"}
        </button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-rust">
          {error}
        </p>
      )}
    </form>
  );
}

// ---------------------------------------------------------------------------
// Notes + ledger events
// ---------------------------------------------------------------------------

function NotesList({ notes, currency }: { notes: ClaimData["notes"]; currency: string }) {
  return (
    <section className="space-y-2">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-ink/50">Notes</h2>
      {notes.length === 0 ? (
        <p className="text-sm text-ink/40">No notes yet.</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {notes.map((n) => (
            <li key={n._id} className="rounded-md border border-line bg-white/60 px-3 py-2">
              <span className="font-medium text-ink/70">{n.kind.replace("_", " ")}</span>{" "}
              <span className="text-ink/80">{n.text}</span>
              {n.oldCents !== undefined && n.newCents !== undefined && (
                <span className="ml-2 font-mono text-xs tabular-nums text-ink/50">
                  <Money cents={n.oldCents} currency={currency} /> →{" "}
                  <Money cents={n.newCents} currency={currency} />
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function LedgerEventsList({ events, currency }: { events: ClaimData["events"]; currency: string }) {
  return (
    <section className="space-y-2">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-ink/50">Ledger</h2>
      {events.length === 0 ? (
        <p className="text-sm text-ink/40">No ledger events yet.</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {events.map((e) => (
            <li
              key={e._id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line bg-white/60 px-3 py-2"
            >
              <span className="text-ink/70">{e.kind.replace("_", " ")}</span>
              <Money cents={e.cents} currency={currency} />
              <span className="truncate text-xs text-ink/40">{e.evidence}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Draft / thread section (D13, D18): write, send, and follow the reply thread.
// ---------------------------------------------------------------------------

const DRAFT_ELIGIBLE_STATUSES = new Set(["detected", "drafted", "reopened", "promised"]);

function domainOf(email: string): string {
  return email.split("@")[1]?.toLowerCase() ?? "";
}

function WriteDraftButton({ claimId, label = "Write draft" }: { claimId: Id<"claims">; label?: string }) {
  const generate = useAction(api.drafts.generate);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    setError(null);
    setSubmitting(true);
    try {
      await generate({ claimId });
    } catch (err) {
      setError(errorMessage(err, "Couldn't write a draft."));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-1">
      <button
        type="button"
        onClick={() => void handleClick()}
        disabled={submitting}
        className="rounded-md bg-harbor px-4 py-2 text-sm font-semibold text-paper disabled:opacity-60"
      >
        {submitting ? "Writing…" : label}
      </button>
      {error && (
        <p role="alert" className="text-sm text-rust">
          {error}
        </p>
      )}
    </div>
  );
}

function SendStatusLine({ claim, draft }: { claim: Doc<"claims">; draft: Doc<"drafts"> }) {
  const status = useQuery(api.drafts.sendStatus, { draftId: draft._id });

  if (draft.sendError) {
    return (
      <div className="mt-2 space-y-1">
        <p role="alert" className="text-xs text-rust">
          Send failed: {draft.sendError}
        </p>
        <WriteDraftButton claimId={claim._id} label="Write a new draft" />
      </div>
    );
  }

  if (claim.sendUnknown) {
    return <p className="mt-2 text-xs font-semibold uppercase tracking-wide text-gold">Delivery unknown — check your inbox</p>;
  }

  const sent = status?.agentmailMessageId != null;
  return (
    <p className="mt-2 text-xs font-semibold uppercase tracking-wide text-ink/40">{sent ? "sent" : "queued"}</p>
  );
}

function DraftForm({
  claim,
  purchase,
  policy,
  draft,
}: {
  claim: Doc<"claims">;
  purchase: Doc<"purchases">;
  policy: Doc<"policies"> | null;
  draft: Doc<"drafts">;
}) {
  const approveAndSend = useMutation(api.drafts.approveAndSend);
  const markPacketSent = useMutation(api.drafts.markPacketSent);

  const [to, setTo] = useState(draft.to);
  const [subject, setSubject] = useState(draft.subject);
  const [body, setBody] = useState(draft.body);
  const [recipientConfirmed, setRecipientConfirmed] = useState(draft.recipientConfirmed ?? false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copyNotice, setCopyNotice] = useState<string | null>(null);

  const domainMismatch = to.trim() !== "" && domainOf(to) !== purchase.merchantDomain.toLowerCase();
  const nonEmailChannel = !policy || policy.channel !== "email";

  async function handleApproveAndSend(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await approveAndSend({ draftId: draft._id, to, subject, body, recipientConfirmed });
    } catch (err) {
      setError(errorMessage(err, "Couldn't send this message."));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCopyAndMarkSent() {
    setError(null);
    setCopyNotice(null);
    setSubmitting(true);
    try {
      try {
        await navigator.clipboard.writeText(`${subject}\n\n${body}`);
        setCopyNotice("Copied to clipboard.");
      } catch {
        setCopyNotice("Couldn't copy automatically — copy the subject and body above by hand.");
      }
      await markPacketSent({ claimId: claim._id, note: policy?.channel ?? "unknown" });
    } catch (err) {
      setError(errorMessage(err, "Couldn't mark this packet sent."));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={(e) => void handleApproveAndSend(e)}
      className="space-y-3 rounded-lg border border-line bg-white/70 p-4"
    >
      <div>
        <label htmlFor="draft-to" className="mb-1 block text-sm font-medium text-ink">
          To
        </label>
        <input
          id="draft-to"
          type="email"
          required
          value={to}
          onChange={(e) => setTo(e.target.value)}
          className="w-full rounded-md border border-line bg-white px-3 py-2 text-sm text-ink outline-none focus:border-harbor focus:ring-2 focus:ring-harbor/20"
        />
        {domainMismatch && (
          <p role="alert" className="mt-1 text-xs text-rust">
            This address doesn't match the merchant's domain ({purchase.merchantDomain}).
          </p>
        )}
      </div>
      <div>
        <label htmlFor="draft-subject" className="mb-1 block text-sm font-medium text-ink">
          Subject
        </label>
        <input
          id="draft-subject"
          type="text"
          required
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          className="w-full rounded-md border border-line bg-white px-3 py-2 text-sm text-ink outline-none focus:border-harbor focus:ring-2 focus:ring-harbor/20"
        />
      </div>
      <div>
        <label htmlFor="draft-body" className="mb-1 block text-sm font-medium text-ink">
          Body
        </label>
        <textarea
          id="draft-body"
          rows={8}
          required
          value={body}
          onChange={(e) => setBody(e.target.value)}
          className="w-full rounded-md border border-line bg-white px-3 py-2 text-sm text-ink outline-none focus:border-harbor focus:ring-2 focus:ring-harbor/20"
        />
      </div>
      <label className="flex items-center gap-2 text-sm text-ink">
        <input type="checkbox" checked={recipientConfirmed} onChange={(e) => setRecipientConfirmed(e.target.checked)} />
        I confirm this recipient
      </label>
      {error && (
        <p role="alert" className="text-sm text-rust">
          {error}
        </p>
      )}
      {copyNotice && <p className="text-sm text-ink/60">{copyNotice}</p>}
      {nonEmailChannel ? (
        <button
          type="button"
          onClick={() => void handleCopyAndMarkSent()}
          disabled={submitting}
          className="rounded-md bg-harbor px-4 py-2 text-sm font-semibold text-paper disabled:opacity-60"
        >
          {submitting ? "Marking sent…" : `Copy packet and mark sent via ${policy?.channel ?? "unknown"}`}
        </button>
      ) : (
        <button
          type="submit"
          disabled={submitting}
          className="rounded-md bg-harbor px-4 py-2 text-sm font-semibold text-paper disabled:opacity-60"
        >
          {submitting ? "Sending…" : "Approve and send"}
        </button>
      )}
    </form>
  );
}

function ReminderLine({ followUps }: { followUps: ClaimData["followUps"] }) {
  const pending = followUps.find((f) => f.status === "pending");
  if (!pending) return null;
  return (
    <p className="text-xs text-ink/40">We'll check back on {new Date(pending.fireAt).toLocaleDateString()}.</p>
  );
}

function Thread({
  claim,
  drafts,
  messages,
  replies,
}: {
  claim: Doc<"claims">;
  drafts: ClaimData["drafts"];
  messages: ClaimData["messages"];
  replies: ClaimData["replies"];
}) {
  const sent = drafts.filter((d) => d.outboundId);

  type Item =
    | { kind: "sent"; ts: number; draft: (typeof sent)[number] }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    | { kind: "inbound"; ts: number; message: any };

  const items: Item[] = [
    ...sent.map((d) => ({ kind: "sent" as const, ts: d.approvedAt ?? d._creationTime, draft: d })),
    ...messages.map((m) => ({ kind: "inbound" as const, ts: m.timestamp, message: m })),
  ].sort((a, b) => a.ts - b.ts);

  if (items.length === 0) {
    return <p className="text-sm text-ink/40">No messages yet.</p>;
  }

  return (
    <ul className="space-y-2">
      {items.map((it, i) =>
        it.kind === "sent" ? (
          <li key={`sent-${it.draft._id}`} className="rounded-md border border-line bg-white/60 px-3 py-2 text-sm">
            <p className="text-xs font-semibold uppercase tracking-wide text-ink/40">You → {it.draft.to}</p>
            <p className="mt-1 font-medium text-ink">{it.draft.subject}</p>
            <p className="mt-1 whitespace-pre-wrap text-ink/70">{it.draft.body}</p>
            <SendStatusLine claim={claim} draft={it.draft} />
          </li>
        ) : (
          <li
            key={`msg-${it.message.messageId ?? i}`}
            className="rounded-md border border-line bg-white/60 px-3 py-2 text-sm"
          >
            <p className="text-xs font-semibold uppercase tracking-wide text-ink/40">
              {it.message.from ?? "Merchant"}
            </p>
            {it.message.subject && <p className="mt-1 font-medium text-ink">{it.message.subject}</p>}
            <p className="mt-1 whitespace-pre-wrap text-ink/70">
              {it.message.text ?? it.message.extractedText ?? ""}
            </p>
            {(() => {
              const reply = replies.find((r) => r.messageId === it.message.messageId);
              if (!reply) return null;
              return (
                <>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <span className="inline-flex items-center rounded-full border border-line bg-ink/5 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink/60">
                      {reply.classification.replace("_", " ")}
                    </span>
                    <span className="text-xs text-ink/60">{reply.summary}</span>
                  </div>
                  {reply.senderMismatch && (
                    <p role="alert" className="mt-1 text-xs text-rust">
                      This reply came from a different address than we sent to.
                    </p>
                  )}
                </>
              );
            })()}
          </li>
        ),
      )}
    </ul>
  );
}

function AskTheStoreSection({ data }: { data: ClaimData }) {
  const { claim, purchase, policy, drafts, replies, messages, followUps, balance } = data;
  const eligible = DRAFT_ELIGIBLE_STATUSES.has(claim.status) && balance.unresolved > 0;
  const currentDraft = drafts.find((d) => !d.outboundId);

  return (
    <section className="space-y-3 rounded-lg border border-line bg-ink/[0.02] p-4">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-ink/50">Ask the store</h2>

      {eligible && <WriteDraftButton claimId={claim._id} />}
      {!eligible && drafts.length === 0 && <p className="text-sm text-ink/50">Nothing to ask yet.</p>}

      {currentDraft && purchase && (
        <DraftForm key={currentDraft._id} claim={claim} purchase={purchase} policy={policy} draft={currentDraft} />
      )}

      <ReminderLine followUps={followUps} />

      <div className="space-y-2 border-t border-line pt-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-ink/50">Thread</h3>
        <Thread claim={claim} drafts={drafts} messages={messages} replies={replies} />
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Dismiss
// ---------------------------------------------------------------------------

function DismissButton({ claim }: { claim: Doc<"claims"> }) {
  const dismiss = useMutation(api.claims.dismiss);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (claim.status === "dismissed") return null;

  async function handleDismiss() {
    if (!window.confirm("Dismiss this claim? This can't be undone.")) return;
    setError(null);
    setSubmitting(true);
    try {
      await dismiss({ claimId: claim._id });
    } catch (err) {
      setError(errorMessage(err, "Couldn't dismiss this claim."));
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-1">
      <button
        type="button"
        onClick={() => void handleDismiss()}
        disabled={submitting}
        className="rounded-md border border-line px-4 py-2 text-sm font-semibold text-ink/60 transition hover:border-rust/40 hover:text-rust disabled:opacity-60"
      >
        {submitting ? "Dismissing…" : "Dismiss claim"}
      </button>
      {error && (
        <p role="alert" className="text-sm text-rust">
          {error}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function ClaimContent({ claimId }: { claimId: Id<"claims"> }) {
  const data = useQuery(api.claims.get, { claimId });

  if (data === undefined) {
    return (
      <div className="space-y-6">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-ink/40">Claim</p>
          <h1 className="font-serif text-2xl font-semibold tracking-tight text-ink">Loading…</h1>
        </div>
        <Loading rows={5} />
      </div>
    );
  }

  const { claim, item, purchase, events, notes, policy, balance } = data;
  const currency = purchase?.currency ?? "USD";

  return (
    <div className="space-y-8">
      <header className="space-y-1">
        <p className="text-xs font-semibold uppercase tracking-wide text-ink/40">Claim</p>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-serif text-2xl font-semibold tracking-tight text-ink">{item?.name ?? "Item"}</h1>
          <StatusPill status={claim.status} />
        </div>
        <p className="text-sm text-ink/60">
          {purchase?.merchant ?? "Unknown merchant"} ·{" "}
          {claim.type === "return_credit" ? "Return credit" : "Price adjustment"} · RC-{claim.token}
        </p>
      </header>

      <LedgerStrip balance={balance} currency={currency} />

      {policy && <PolicyReadCard policy={policy} />}

      <MoneySection claim={claim} currency={currency} />

      <AdjustExpectedForm claim={claim} />

      <NotesList notes={notes} currency={currency} />

      <LedgerEventsList events={events} currency={currency} />

      <AskTheStoreSection data={data} />

      <DismissButton claim={claim} />
    </div>
  );
}

export default function Claim() {
  const { id } = useParams();

  if (!id) {
    return (
      <Empty
        title="This claim isn't loaded yet"
        hint="The ledger, the draft, and the message thread for this claim will appear here."
      />
    );
  }

  return (
    <QueryBoundary>
      <ClaimContent claimId={id as Id<"claims">} />
    </QueryBoundary>
  );
}
