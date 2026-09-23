import { useAction, useMutation, useQuery } from "convex/react";
import { useId, useState, type FormEvent, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../convex/_generated/api";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { LedgerBar } from "../components/charts/LedgerBar";
import { PriceChart } from "../components/charts/PriceChart";
import { StatusSteps } from "../components/charts/StatusSteps";
import { WindowMeter } from "../components/charts/WindowMeter";
import { Card, StatLabel } from "../components/claim/Card";
import { Composer, PacketRow } from "../components/claim/Composer";
import { CreditLandedForm } from "../components/claim/CreditLandedForm";
import { HeldPromise } from "../components/claim/HeldPromise";
import { MoneyForm } from "../components/claim/MoneyForm";
import { ClaimTimeline } from "../components/claim/Timelines";
import { DeltaBadge } from "../components/DeltaBadge";
import { PacketSection } from "../components/packet/PacketSection";
import { fmt, formatMinor } from "../lib/money";
import { priceAge, useCoarseNow } from "../lib/time";
import { SCENARIO_TITLES } from "../lib/scenarioTitles";
import { Empty, ErrorBox, Loading } from "../components/States";
import {
  bigNumberClass,
  day,
  errorText,
  inputClass,
  labelClass,
  pageTitleClass,
  secondaryButtonClass,
  when,
} from "../lib/ui";

type ClaimData = FunctionReturnType<typeof api.claims.get>;
type Overview = FunctionReturnType<typeof api.tracking.overview>;
type TrackedItem = Overview["items"][number];

type Hero =
  | { kind: "money"; label: string; cents: number; tone: string }
  | { kind: "state"; label: string; detail: string; dot: string };

/**
 * The headline changes meaning with the claim's state; the label says which. An open claim is what the user ASKED
 * for, never "owed" (DA-B-9, mission §20): whether anything is owed is the authority's question (a store's
 * price-adjustment policy is a promise the business made, not a law), and the recovery-path card carries that.
 * A recorded denial and a non-cash resolution are STATES, not money tiles: neither is money asked, owed or back.
 */
function headline(claim: ClaimData["claim"], balance: ClaimData["balance"], notes: ClaimData["notes"]): Hero {
  if (claim.nonCashResolvedAt !== undefined) {
    return {
      kind: "state",
      label: "Resolved with a non-cash remedy",
      detail: `You recorded accepting a non-cash remedy on ${day(claim.nonCashResolvedAt)}. This claim is closed. It counts under non-cash only, never as money asked for or back on your card.`,
      dot: "bg-gold",
    };
  }
  if (claim.status === "denied") {
    const reason = denialReason(notes);
    return {
      kind: "state",
      label: "Denied",
      detail: `You recorded that they said no${reason ? `: “${reason}”` : ""}. This claim is closed and leaves every total. If money arrives anyway, record it below and the claim reopens.`,
      dot: "bg-rust",
    };
  }
  if (claim.status === "confirmed") {
    return { kind: "money", label: "Back to your card or account", cents: balance.confirmed - balance.debited, tone: "text-green-700!" };
  }
  if (claim.status === "dismissed") {
    return { kind: "money", label: "Dismissed", cents: balance.unresolved, tone: "text-gray-500! line-through" };
  }
  return { kind: "money", label: "You asked for", cents: balance.unresolved, tone: "" };
}

/** The reason from the newest denial note (`claims.recordDenial` writes "Denied: <reason>"). */
function denialReason(notes: ClaimData["notes"]): string | null {
  const note = [...notes].reverse().find((n) => n.kind === "status" && n.text.startsWith("Denied: "));
  return note ? note.text.slice("Denied: ".length) : null;
}

/** Statuses a denial can be recorded from (§5; `claims.recordDenial`): the claim reached them and is still open. */
const DENIABLE: ReadonlySet<ClaimData["claim"]["status"]> = new Set(["sent", "packet", "promised", "reopened"]);
const MAX_DENIAL_REASON_CHARS = 500;

const NON_CASH_WORDS: Record<ClaimData["nonCashRemedies"][number]["kind"], string> = {
  voucher: "Store credit or gift card",
  points: "Points",
  repair: "Repair",
  replacement: "Replacement",
  service_credit: "Service credit",
  fee_waiver: "Fee waiver",
  other: "Non-cash remedy",
};

function Figure({ label, cents, currency }: { label: string; cents?: number; currency: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-gray-500">{label}</dt>
      <dd className="mt-0.5 text-sm font-semibold tabular-nums text-gray-900">
        {cents === undefined ? <span className="text-gray-600">—</span> : fmt(cents, currency)}
      </dd>
    </div>
  );
}

function DateFigure({ label, at }: { label: string; at?: number }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-gray-500">{label}</dt>
      <dd className="mt-0.5 text-sm font-semibold tabular-nums text-gray-900">{day(at)}</dd>
    </div>
  );
}

/** Status chip: a coloured dot and a word, in a bordered rounded-lg box. */
function Chip({ dot, children }: { dot: string; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-2 py-0.5 text-xs font-medium text-gray-900">
      <span className={`size-1.5 shrink-0 rounded-full ${dot}`} aria-hidden="true" />
      {children}
    </span>
  );
}

/** "They said no" (§5, D206): the user records the refusal in their own words; the claim closes for ask. */
function DenialForm({ claimId }: { claimId: Id<"claims"> }) {
  const recordDenial = useMutation(api.claims.recordDenial);
  const reasonId = useId();
  const hintId = useId();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (reason.trim().length === 0) return setError("Say briefly what they answered.");
    setBusy(true);
    try {
      await recordDenial({ claimId, reason: reason.trim() });
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="rounded-xl border border-gray-200">
      <summary className="cursor-pointer rounded-xl px-3.5 py-3 text-sm font-semibold text-gray-900 hover:bg-gray-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-500">
        They said no
      </summary>
      <form className="space-y-3 border-t border-dashed border-gray-200 p-3.5" onSubmit={(event) => void submit(event)}>
        <div>
          <label htmlFor={reasonId} className={labelClass}>
            What did they answer?
          </label>
          <textarea
            id={reasonId}
            rows={3}
            maxLength={MAX_DENIAL_REASON_CHARS}
            aria-describedby={hintId}
            className={`${inputClass} block resize-y`}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          <p id={hintId} className="mt-1 text-xs text-gray-600">
            Recording a refusal closes this claim. If money arrives later, record it and the claim reopens.
          </p>
        </div>
        {error && <ErrorBox error={error} />}
        <button type="submit" disabled={busy} className={secondaryButtonClass}>
          {busy ? "Recording…" : "Record the refusal"}
        </button>
      </form>
    </details>
  );
}

/** A manual-channel claim (M20: `requiredChannel` other than email) is filed as a packet the user files themselves. */
function manualChannel(claim: Doc<"claims">): boolean {
  return claim.requiredChannel !== undefined && claim.requiredChannel !== "email";
}

export default function Claim() {
  const { id } = useParams();
  const claimId = id as Id<"claims"> | undefined;
  const data = useQuery(api.claims.get, claimId ? { claimId } : "skip");
  // P06-OW-2: a coarse `now` lets the server judge the price's age (`priceStale`).
  const coarseNow = useCoarseNow();
  const overview = useQuery(api.tracking.overview, claimId ? { now: coarseNow } : "skip");

  const generate = useAction(api.drafts.generate);
  const confirmCredit = useMutation(api.claims.confirmCredit);
  const recordNonCashResolution = useMutation(api.claims.recordNonCashResolution);
  const recordLaterDebit = useMutation(api.claims.recordLaterDebit);
  const dismiss = useMutation(api.claims.dismiss);
  const confirmHeldPromise = useMutation(api.replies.confirmHeldPromise);

  const [actionError, setActionError] = useState<string | null>(null);
  const [dismissError, setDismissError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Held replies confirmed on this page stay listed with their result, so the confirmation is not lost on re-render.
  const [confirmedHere, setConfirmedHere] = useState<ReadonlySet<string>>(new Set());

  if (!claimId) return <Empty title="No claim selected" />;
  if (data === undefined) return <Loading rows={4} />;

  const { claim, item, purchase, transaction, balance, drafts, replies, followUps, notes, policy, events, nonCashRemedies } = data;
  // The claim's own currency first (lib/money.claimCurrency), then its purchase's or transaction's.
  const currency = claim.currency ?? purchase?.currency ?? transaction?.currency ?? "USD";
  const latestDraft = drafts[0];
  const pendingFollowUp = followUps.find((followUp) => followUp.status === "pending");
  const isEmailChannel = policy === null || policy.channel === "email";
  const packetChannel = !isEmailChannel && policy ? policy.channel : undefined;
  // Closed for ask (lib/claimState.isClosedForAsk): settled, dismissed, denied, or resolved with a non-cash remedy.
  // The backend refuses dismiss on confirmed (D48).
  const isClosed =
    claim.status === "confirmed" ||
    claim.status === "dismissed" ||
    claim.status === "denied" ||
    claim.nonCashResolvedAt !== undefined;
  const isPacketClaim = manualChannel(claim);
  const heldReplies = replies.filter((reply) => reply.heldForConfirmation === true || confirmedHere.has(reply._id));
  // Price history, the price-adjustment window and Paid/Now/Lowest belong to a purchased item; an item-less
  // scenario claim (M20, e.g. a delayed flight) has none of them.
  const isRetail = item !== null || purchase !== null;
  const canDeny = DENIABLE.has(claim.status) && claim.nonCashResolvedAt === undefined;

  // Price history lives on the dashboard read; the claim page borrows this item's series.
  const tracked: TrackedItem | undefined = overview?.items.find(
    (entry) => entry.itemId === claim.itemId,
  );
  const paidCents = tracked?.paidCents ?? item?.unitCents;
  const qty = tracked?.qty ?? item?.qty ?? 1;
  const purchasedAt = tracked?.purchasedAt ?? purchase?.purchasedAt;
  const hero = headline(claim, balance, notes);

  async function run(
    work: () => Promise<unknown>,
    setError: (message: string | null) => void = setActionError,
  ) {
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
    <div className="space-y-6">
      <div className="lg:flex lg:items-start lg:justify-between lg:gap-8">
        <div className="mb-5 min-w-0 lg:mb-0">
          <h1 className={`${pageTitleClass} break-words`}>
            {item?.name ?? (claim.scenarioId ? SCENARIO_TITLES[claim.scenarioId] : transaction?.counterpartyName) ?? "Claim"}
          </h1>
          <p className="mt-2 flex flex-wrap items-center gap-2 text-sm text-gray-500">
            {purchase ? (
              <Link
                to={`/purchases/${purchase._id}`}
                className="rounded font-medium text-gray-900 underline decoration-gray-300 underline-offset-4 hover:decoration-gray-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-500"
              >
                {purchase.merchant || purchase.merchantDomain}
              </Link>
            ) : transaction ? (
              <Link
                to={`/transactions/${transaction._id}`}
                className="rounded font-medium text-gray-900 underline decoration-gray-300 underline-offset-4 hover:decoration-gray-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-500"
              >
                {transaction.counterpartyName}
              </Link>
            ) : (
              "Purchase missing"
            )}
            {qty > 1 && <span className="tabular-nums text-gray-600">×{qty}</span>}
            {claim.attentionAt !== undefined && (
              <Chip dot="bg-yellow-500">Needs you since {when(claim.attentionAt)}</Chip>
            )}
            {pendingFollowUp && <Chip dot="bg-sky-500">Reminder {when(pendingFollowUp.fireAt)}</Chip>}
          </p>
        </div>
        <div className="w-full min-w-0 shrink-0 lg:w-96">
          <StatusSteps status={claim.status} sendUnknown={claim.sendUnknown === true} />
        </div>
      </div>

      {/* D21/D178: promises from a sender Recoup can't verify, held until the owner confirms each one once. */}
      {heldReplies.length > 0 && (
        <div className="space-y-3">
          {heldReplies.map((reply) => (
            <HeldPromise
              key={reply._id}
              reply={reply}
              currency={currency}
              claimStatus={claim.status}
              onConfirm={async (replyId) => {
                const result = await confirmHeldPromise({ replyId });
                setConfirmedHere((ids) => new Set(ids).add(replyId));
                return result;
              }}
            />
          ))}
        </div>
      )}

      <div className="grid grid-cols-12 gap-5">
        {/* Row 1: the evidence. What is owed, how far the price fell, and the history. */}
        <Card className="col-span-full xl:col-span-8" bodyClassName="">
          <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4 px-5 pt-5">
            {hero.kind === "state" ? (
              <div className="min-w-0 max-w-xl">
                <StatLabel>Where this claim stands</StatLabel>
                <p className="mt-1 flex items-center gap-2 text-2xl font-semibold tracking-tight text-gray-900">
                  <span aria-hidden="true" className={`size-2.5 shrink-0 rounded-full ${hero.dot}`} />
                  {hero.label}
                </p>
                <p className="mt-1.5 text-sm text-gray-700">{hero.detail}</p>
              </div>
            ) : (
              <div className="min-w-0">
                <StatLabel>{hero.label}</StatLabel>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className={`${bigNumberClass} text-4xl! ${hero.tone}`}>{fmt(hero.cents, currency)}</span>
                  {paidCents !== undefined && !tracked?.priceStale && (
                    <DeltaBadge paidCents={paidCents} latestCents={tracked?.latestCents} currency={currency} />
                  )}
                </div>
              </div>
            )}
            {isRetail && (
              <div>
                <dl className="flex flex-wrap gap-x-6 gap-y-2">
                  <Figure label="Paid" cents={paidCents} currency={currency} />
                  {/* P06-OW-2: an out-of-date price is never labelled "Now". */}
                  <Figure
                    label={tracked?.priceStale && tracked.latestCents !== undefined ? "Last price read" : "Now"}
                    cents={tracked?.latestCents}
                    currency={currency}
                  />
                  <Figure label="Lowest" cents={tracked?.lowestCents} currency={currency} />
                </dl>
                {tracked?.latestCents !== undefined && (
                  <p className="mt-1.5 text-xs text-gray-600">
                    {tracked.priceStale ? "Out of date: price " : "Price "}
                    {priceAge(tracked.lastObservedAt, coarseNow)}
                  </p>
                )}
              </div>
            )}
          </div>
          {isRetail ? (
            <>
              <div className="mx-5 mt-5 border-t border-dashed border-gray-200" aria-hidden="true" />
              <div className="min-w-0 px-2 pb-3 pt-4">
                {overview === undefined ? (
                  <div
                    className="mx-3 h-[300px] animate-pulse rounded-xl bg-gray-100 motion-reduce:animate-none"
                    role="status"
                    aria-label="Loading price history"
                  />
                ) : tracked && paidCents !== undefined && tracked.points.length > 0 ? (
                  <PriceChart
                    points={tracked.points}
                    paidCents={paidCents}
                    currency={currency}
                    purchasedAt={purchasedAt}
                    windowEndsAt={claim.windowEndsAt}
                    height={300}
                  />
                ) : (
                  <div className="mx-3 flex h-40 items-center justify-center rounded-xl border border-dashed border-gray-200 text-sm text-gray-600">
                    No price history yet
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="pb-5" />
          )}
        </Card>

        <div className="col-span-full grid grid-cols-1 gap-5 sm:grid-cols-2 xl:col-span-4 xl:grid-cols-1">
          {isRetail && (
            <Card title="Claim window" icon="window">
              <WindowMeter purchasedAt={purchasedAt} endsAt={claim.windowEndsAt} />
              <dl className="mt-4 grid grid-cols-2 gap-4 border-t border-dashed border-gray-200 pt-4">
                <DateFigure label="Bought" at={purchasedAt} />
                <DateFigure label="Closes" at={claim.windowEndsAt} />
              </dl>
            </Card>
          )}
          <Card title="Ledger" icon="ledger">
            {hero.kind === "state" ? (
              // Closed for ask: nothing is open, so there is no open amount to draw (a state, not a money tile).
              <p className="text-sm text-gray-700">Nothing is open on this claim ({hero.label.toLowerCase()}).</p>
            ) : (
              <LedgerBar
                expected={balance.expected}
                promised={balance.promised}
                confirmed={balance.confirmed}
                currency={currency}
              />
            )}
            <dl
              className={`mt-4 grid ${hero.kind === "state" ? "grid-cols-2" : "grid-cols-3"} gap-3 border-t border-dashed border-gray-200 pt-4`}
            >
              {hero.kind !== "state" && <Figure label="Unresolved" cents={balance.unresolved} currency={currency} />}
              <Figure label="Confirmed" cents={balance.confirmed} currency={currency} />
              <Figure label="Charged again" cents={balance.debited} currency={currency} />
            </dl>
            {nonCashRemedies.length > 0 && (
              <div className="mt-4 border-t border-dashed border-gray-200 pt-4">
                <p className="text-xs text-gray-600">Non-cash, not counted as money back</p>
                <ul className="mt-1.5 space-y-1 text-sm text-gray-900">
                  {nonCashRemedies.map((remedy) => (
                    <li key={remedy._id} className="flex flex-wrap justify-between gap-x-3">
                      <span>
                        {NON_CASH_WORDS[remedy.kind]} · {remedy.state === "received" ? "received" : "promised"}
                      </span>
                      {remedy.faceValue && (
                        <span className="tabular-nums text-gray-700">
                          {formatMinor(remedy.faceValue.amountMinor, remedy.faceValue.currency)} face value
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Card>
        </div>

        {/* Row 2: the ask and the money on the left, the claim's whole story on the right. */}
        <div className="col-span-full flex min-w-0 flex-col gap-5 xl:col-span-7">
          {isPacketClaim ? (
            <Card title="Packet you file yourself" icon="mail">
              <PacketSection claim={claim} closed={isClosed} />
            </Card>
          ) : (
            <Card
              title="Message to the store"
              icon="mail"
              actions={
                !isClosed && (
                  <button
                    type="button"
                    disabled={busy}
                    className={secondaryButtonClass}
                    onClick={() => void run(() => generate({ claimId: claim._id }))}
                  >
                    {busy ? "Writing…" : latestDraft ? "Write a new draft" : "Write the message"}
                  </button>
                )
              }
            >
              <div className="space-y-4">
                {latestDraft ? (
                  <Composer
                    key={latestDraft._id}
                    draft={latestDraft}
                    claim={claim}
                    merchantDomain={purchase?.merchantDomain ?? ""}
                    packetChannel={packetChannel}
                    closed={isClosed}
                  />
                ) : (
                  <>
                    <div className="rounded-xl border border-dashed border-gray-200 px-4 py-10 text-center text-sm text-gray-600">
                      {isClosed ? "No message was written for this claim" : "No draft yet. Write the message to start."}
                    </div>
                    {packetChannel !== undefined && !isClosed && (
                      <PacketRow claim={claim} channel={packetChannel} />
                    )}
                  </>
                )}
                {actionError && <ErrorBox error={actionError} />}
              </div>
            </Card>
          )}

          <Card title="Record money" icon="card">
            <div className="space-y-3">
              <CreditLandedForm
                currency={currency}
                onCash={(cents, evidence, idempotencyKey) =>
                  confirmCredit({
                    claimId: claim._id,
                    cents,
                    evidence: evidence || "Confirmed by the customer",
                    idempotencyKey,
                  })
                }
                onNonCash={({ kind, description, faceValueMinor, idempotencyKey }) =>
                  // DA-B-16: store credit, a gift card or points RESOLVE the claim (closed for ask), never cash.
                  recordNonCashResolution({
                    claimId: claim._id,
                    kind,
                    description,
                    ...(faceValueMinor !== undefined ? { faceValue: { amountMinor: faceValueMinor, currency } } : {}),
                    idempotencyKey,
                  })
                }
              />
              <MoneyForm
                title="Charged again"
                submitLabel="Record charge"
                tone="debit"
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
              {canDeny && <DenialForm claimId={claim._id} />}
              {!isClosed && (
                <div className="space-y-3 border-t border-dashed border-gray-200 pt-3">
                  {dismissError && <ErrorBox error={dismissError} />}
                  <button
                    type="button"
                    disabled={busy}
                    className="rounded-lg px-1 py-1 text-sm font-medium text-red-700 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-500 disabled:opacity-60"
                    onClick={() => void run(() => dismiss({ claimId: claim._id }), setDismissError)}
                  >
                    Dismiss this claim
                  </button>
                </div>
              )}
            </div>
          </Card>
        </div>

        <Card title="Claim timeline" icon="story" ruled className="col-span-full self-start xl:col-span-5">
          <ClaimTimeline
            claim={claim}
            drafts={drafts}
            replies={replies}
            events={events}
            notes={notes}
            currency={currency}
          />
        </Card>
      </div>
    </div>
  );
}
