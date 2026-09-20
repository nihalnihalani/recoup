import { useAction, useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../convex/_generated/api";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { Countdown } from "../components/Countdown";
import { Money } from "../components/Money";
import { StatusPill } from "../components/StatusPill";
import { Empty, ErrorBox, Loading } from "../components/States";
import {
  dollarsToCents,
  errorText,
  inputClass,
  labelClass,
  primaryButtonClass,
  secondaryButtonClass,
  sectionClass,
  when,
} from "../lib/ui";

type ClaimData = FunctionReturnType<typeof api.claims.get>;

const CLAIM_TYPE_LABEL = {
  price_adjustment: "Price drop",
  return_credit: "Return credit",
} as const;

const REPLY_LABEL = {
  promise: "Promise",
  credit_issued: "Credit issued",
  refusal: "Refusal",
  question: "Question",
  other: "Other",
} as const;

function domainOf(email: string): string {
  const at = email.lastIndexOf("@");
  return at === -1 ? "" : email.slice(at + 1).toLowerCase();
}

// ---------------------------------------------------------------------------
// Draft editor (D11 version binding, D18 recipient gate, D29 send status)
// ---------------------------------------------------------------------------

function DraftEditor({
  draft,
  claim,
  merchantDomain,
}: {
  draft: Doc<"drafts">;
  claim: Doc<"claims">;
  merchantDomain: string;
}) {
  const update = useMutation(api.drafts.update);
  const approveAndSend = useMutation(api.drafts.approveAndSend);
  const sendStatus = useQuery(api.drafts.sendStatus, { draftId: draft._id });

  const [to, setTo] = useState(draft.to);
  const [subject, setSubject] = useState(draft.subject);
  const [body, setBody] = useState(draft.body);
  const [recipientConfirmed, setRecipientConfirmed] = useState(draft.recipientConfirmed === true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const sent = draft.outboundId !== undefined;
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

  return (
    <div className="space-y-3">
      <div>
        <label className={labelClass} htmlFor="draft-to">
          To
        </label>
        <input
          id="draft-to"
          className={inputClass}
          value={to}
          disabled={sent}
          placeholder="Confirm the merchant's contact address"
          onChange={(event) => setTo(event.target.value)}
        />
        {mismatch && !sent && (
          <p className="mt-1 text-xs text-rust">
            This address is not on {merchantDomain}. Make sure it really is the merchant.
          </p>
        )}
      </div>

      <div>
        <label className={labelClass} htmlFor="draft-subject">
          Subject
        </label>
        <input
          id="draft-subject"
          className={inputClass}
          value={subject}
          disabled={sent}
          onChange={(event) => setSubject(event.target.value)}
        />
      </div>

      <div>
        <label className={labelClass} htmlFor="draft-body">
          Message
        </label>
        <textarea
          id="draft-body"
          rows={12}
          className={inputClass}
          value={body}
          disabled={sent}
          onChange={(event) => setBody(event.target.value)}
        />
      </div>

      {!sent && (
        <label className="flex items-start gap-2 text-sm text-ink">
          <input
            type="checkbox"
            checked={recipientConfirmed}
            onChange={(event) => setRecipientConfirmed(event.target.checked)}
            className="mt-0.5"
          />
          I confirm this recipient is the right place to send this claim.
        </label>
      )}

      {error && <ErrorBox error={error} />}
      {draft.sendError && <ErrorBox error={`Send failed: ${draft.sendError}`} />}

      {sent ? (
        <div className="rounded-md border border-line bg-ink/[0.02] px-3 py-2 text-sm text-ink/70">
          {sendStatus === undefined ? (
            "Checking delivery…"
          ) : sendStatus === null ? (
            "Queued — no delivery record yet."
          ) : sendStatus.agentmailMessageId ? (
            <>Sent {draft.approvedAt ? when(draft.approvedAt) : ""}.</>
          ) : sendStatus.errorMessage ? (
            <>Delivery problem: {sendStatus.errorMessage}</>
          ) : claim.sendUnknown ? (
            "Delivery unknown. Recoup stopped checking."
          ) : (
            `Sending… (${sendStatus.status})`
          )}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
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
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Money actions (D24: client-generated idempotency key per submission)
// ---------------------------------------------------------------------------

function AmountForm({
  title,
  submitLabel,
  currency,
  onSubmit,
}: {
  title: string;
  submitLabel: string;
  currency: string;
  onSubmit: (cents: number, evidence: string, idempotencyKey: string) => Promise<unknown>;
}) {
  const [amount, setAmount] = useState("");
  const [evidence, setEvidence] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit() {
    setError(null);
    const cents = dollarsToCents(amount);
    if (cents === null || cents === 0) {
      setError("Enter an amount greater than zero.");
      return;
    }
    setBusy(true);
    try {
      await onSubmit(cents, evidence.trim(), crypto.randomUUID());
      setAmount("");
      setEvidence("");
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`${sectionClass} space-y-2`}>
      <h3 className="font-serif text-base text-ink">{title}</h3>
      <div>
        <label className={labelClass} htmlFor={`${title}-amount`}>
          Amount ({currency})
        </label>
        <input
          id={`${title}-amount`}
          inputMode="decimal"
          placeholder="0.00"
          className={inputClass}
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
        />
      </div>
      <div>
        <label className={labelClass} htmlFor={`${title}-evidence`}>
          Note
        </label>
        <input
          id={`${title}-evidence`}
          className={inputClass}
          placeholder="Where you saw it"
          value={evidence}
          onChange={(event) => setEvidence(event.target.value)}
        />
      </div>
      {error && <ErrorBox error={error} />}
      <button
        type="button"
        disabled={busy}
        onClick={() => void handleSubmit()}
        className={primaryButtonClass}
      >
        {busy ? "Saving…" : submitLabel}
      </button>
    </div>
  );
}

function LedgerStrip({ balance, currency }: { balance: ClaimData["balance"]; currency: string }) {
  const cells = [
    { label: "Expected", cents: balance.expected, tone: "text-ink/60" },
    { label: "Promised", cents: balance.promised, tone: "text-gold/80" },
    { label: "Confirmed", cents: balance.confirmed, tone: "text-moss/80" },
    { label: "Unresolved", cents: balance.unresolved, tone: "text-rust/80" },
  ];
  return (
    <dl className="grid grid-cols-2 divide-line overflow-hidden rounded-lg border border-line sm:grid-cols-4 sm:divide-x">
      {cells.map((cell) => (
        <div key={cell.label} className="px-4 py-3">
          <dt className={`text-xs font-semibold uppercase tracking-wide ${cell.tone}`}>
            {cell.label}
          </dt>
          <dd className="mt-1 text-lg text-ink">
            <Money cents={cell.cents} currency={currency} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

// ---------------------------------------------------------------------------

export default function Claim() {
  const { id } = useParams();
  const claimId = id as Id<"claims"> | undefined;
  const data = useQuery(api.claims.get, claimId ? { claimId } : "skip");

  const generate = useAction(api.drafts.generate);
  const markPacketSent = useMutation(api.drafts.markPacketSent);
  const confirmCredit = useMutation(api.claims.confirmCredit);
  const recordLaterDebit = useMutation(api.claims.recordLaterDebit);
  const dismiss = useMutation(api.claims.dismiss);

  const [packetNote, setPacketNote] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!claimId) return <Empty title="No claim selected" />;
  if (data === undefined) return <Loading rows={4} />;

  const { claim, item, purchase, balance, drafts, replies, followUps, policy, events } = data;
  const currency = purchase?.currency ?? "USD";
  const latestDraft = drafts[0];
  const pendingFollowUp = followUps.find((followUp) => followUp.status === "pending");
  const isEmailChannel = policy === null || policy.channel === "email";

  async function run(work: () => Promise<unknown>) {
    setActionError(null);
    setBusy(true);
    try {
      await work();
    } catch (caught) {
      setActionError(errorText(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-ink/40">Claim</p>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-serif text-2xl font-semibold tracking-tight text-ink">
            {CLAIM_TYPE_LABEL[claim.type]} · {item?.name ?? "item"}
          </h1>
          <StatusPill status={claim.status} />
        </div>
        <p className="mt-1 text-sm text-ink/60">
          {purchase ? (
            <Link
              to={`/purchases/${purchase._id}`}
              className="underline-offset-2 hover:text-ink hover:underline"
            >
              {purchase.merchant || purchase.merchantDomain}
            </Link>
          ) : (
            "Purchase missing"
          )}
          {claim.windowEndsAt !== undefined && (
            <>
              {" · window closes in "}
              <Countdown endsAt={claim.windowEndsAt} className="inline" />
            </>
          )}
        </p>
        {claim.attentionAt !== undefined && (
          <p className="mt-2 rounded-md border border-gold/40 bg-gold/5 px-3 py-2 text-sm text-gold">
            Needs your attention since {when(claim.attentionAt)}.
          </p>
        )}
        {pendingFollowUp && (
          <p className="mt-1 text-xs text-ink/50">Next reminder {when(pendingFollowUp.fireAt)}.</p>
        )}
      </div>

      <LedgerStrip balance={balance} currency={currency} />

      <section className={`${sectionClass} space-y-3`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-serif text-lg text-ink">The ask</h2>
          <button
            type="button"
            disabled={busy}
            className={secondaryButtonClass}
            onClick={() => void run(() => generate({ claimId: claim._id }))}
          >
            {latestDraft ? "Write a new draft" : "Write the message"}
          </button>
        </div>

        {latestDraft ? (
          <DraftEditor
            key={latestDraft._id}
            draft={latestDraft}
            claim={claim}
            merchantDomain={purchase?.merchantDomain ?? ""}
          />
        ) : (
          <p className="text-sm text-ink/60">No draft yet. Recoup will write one from the facts.</p>
        )}

        {!isEmailChannel && (
          <div className="space-y-2 border-t border-line pt-3">
            <p className="text-sm text-ink/70">
              This merchant handles claims by {policy?.channel}. Send it yourself, then record it
              here.
            </p>
            <input
              className={inputClass}
              placeholder="What you sent and where"
              value={packetNote}
              onChange={(event) => setPacketNote(event.target.value)}
            />
            <button
              type="button"
              disabled={busy || packetNote.trim().length === 0}
              className={primaryButtonClass}
              onClick={() =>
                void run(async () => {
                  await markPacketSent({ claimId: claim._id, note: packetNote.trim() });
                  setPacketNote("");
                })
              }
            >
              Record as sent
            </button>
          </div>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-ink/50">Replies</h2>
        {replies.length === 0 ? (
          <p className="text-sm text-ink/60">Nothing back from the merchant yet.</p>
        ) : (
          <ul className="space-y-2">
            {[...replies]
              .sort((a, b) => b.receivedAt - a.receivedAt)
              .map((reply) => (
                <li key={reply._id} className={sectionClass}>
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-xs font-semibold uppercase tracking-wide text-harbor">
                      {REPLY_LABEL[reply.classification]}
                    </span>
                    <span className="text-xs text-ink/50">{when(reply.receivedAt)}</span>
                  </div>
                  <p className="mt-1 text-sm text-ink">{reply.summary}</p>
                  <p className="mt-1 text-xs text-ink/50">
                    From {reply.from}
                    {reply.promisedCents !== undefined && (
                      <>
                        {" · promised "}
                        <Money cents={reply.promisedCents} currency={currency} />
                      </>
                    )}
                  </p>
                  {reply.senderMismatch && (
                    <p className="mt-1 text-xs text-rust">
                      This came from a different domain than the one you wrote to.
                    </p>
                  )}
                </li>
              ))}
          </ul>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-ink/50">Record money</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <AmountForm
            title="Confirm credit"
            submitLabel="Credit landed"
            currency={currency}
            onSubmit={(cents, evidence, idempotencyKey) =>
              confirmCredit({
                claimId: claim._id,
                cents,
                evidence: evidence || "Confirmed by the customer",
                idempotencyKey,
              })
            }
          />
          <AmountForm
            title="Record later charge"
            submitLabel="Charged again"
            currency={currency}
            onSubmit={(cents, evidence, idempotencyKey) =>
              recordLaterDebit({
                claimId: claim._id,
                cents,
                evidence: evidence || "Recorded by the customer",
                idempotencyKey,
              })
            }
          />
        </div>
        {actionError && <ErrorBox error={actionError} />}
        {claim.status !== "dismissed" && (
          <button
            type="button"
            disabled={busy}
            className={secondaryButtonClass}
            onClick={() => void run(() => dismiss({ claimId: claim._id }))}
          >
            Dismiss this claim
          </button>
        )}
      </section>

      {events.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-ink/50">Ledger</h2>
          <ul className="divide-y divide-line rounded-lg border border-line bg-white/70">
            {events.map((event) => (
              <li key={event._id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2">
                <span className="text-sm text-ink">{event.kind.replace(/_/g, " ")}</span>
                <span className="text-xs text-ink/50">{event.evidence}</span>
                <Money cents={event.cents} currency={currency} className="text-sm text-ink" />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
