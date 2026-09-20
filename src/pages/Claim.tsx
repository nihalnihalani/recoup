import { useAction, useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { LedgerBar } from "../components/charts/LedgerBar";
import { PriceChart } from "../components/charts/PriceChart";
import { StatusSteps } from "../components/charts/StatusSteps";
import { WindowMeter } from "../components/charts/WindowMeter";
import { Card, StatLabel } from "../components/claim/Card";
import { Composer, PacketRow } from "../components/claim/Composer";
import { MoneyForm } from "../components/claim/MoneyForm";
import { LedgerTimeline, ReplyTimeline } from "../components/claim/Timelines";
import { DeltaBadge } from "../components/DeltaBadge";
import { fmt, Money } from "../components/Money";
import { Empty, ErrorBox, Loading } from "../components/States";
import { day, errorText, secondaryButtonClass, when } from "../lib/ui";

type ClaimData = FunctionReturnType<typeof api.claims.get>;
type Overview = FunctionReturnType<typeof api.tracking.overview>;
type TrackedItem = Overview["items"][number];

/** The headline figure changes meaning with the claim's state; the label says which. */
function headline(
  status: ClaimData["claim"]["status"],
  balance: ClaimData["balance"],
): { label: string; cents: number; tone: string } {
  if (status === "confirmed") {
    return { label: "Back on your card", cents: balance.confirmed - balance.debited, tone: "text-moss" };
  }
  if (status === "dismissed") {
    return { label: "Dismissed", cents: balance.unresolved, tone: "text-ink/40 line-through" };
  }
  return { label: "Owed to you", cents: balance.unresolved, tone: "text-ink" };
}

function Figure({ label, cents, currency }: { label: string; cents?: number; currency: string }) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase text-ink/40">{label}</dt>
      <dd className="mt-0.5 text-sm font-semibold tabular-nums text-ink">
        {cents === undefined ? <span className="text-ink/30">—</span> : fmt(cents, currency)}
      </dd>
    </div>
  );
}

function DateFigure({ label, at }: { label: string; at?: number }) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase text-ink/40">{label}</dt>
      <dd className="mt-0.5 text-sm font-semibold text-ink">{day(at)}</dd>
    </div>
  );
}

export default function Claim() {
  const { id } = useParams();
  const claimId = id as Id<"claims"> | undefined;
  const data = useQuery(api.claims.get, claimId ? { claimId } : "skip");
  const overview = useQuery(api.tracking.overview, claimId ? {} : "skip");

  const generate = useAction(api.drafts.generate);
  const confirmCredit = useMutation(api.claims.confirmCredit);
  const recordLaterDebit = useMutation(api.claims.recordLaterDebit);
  const dismiss = useMutation(api.claims.dismiss);

  const [actionError, setActionError] = useState<string | null>(null);
  const [dismissError, setDismissError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!claimId) return <Empty title="No claim selected" />;
  if (data === undefined) return <Loading rows={4} />;

  const { claim, item, purchase, balance, drafts, replies, followUps, policy, events } = data;
  const currency = purchase?.currency ?? "USD";
  const latestDraft = drafts[0];
  const pendingFollowUp = followUps.find((followUp) => followUp.status === "pending");
  const isEmailChannel = policy === null || policy.channel === "email";
  const packetChannel = !isEmailChannel && policy ? policy.channel : undefined;
  // A settled or dismissed claim takes no new ask; the backend refuses dismiss on confirmed (D48).
  const isClosed = claim.status === "confirmed" || claim.status === "dismissed";

  // Price history lives on the dashboard read; the claim page borrows this item's series.
  const tracked: TrackedItem | undefined = overview?.items.find(
    (entry) => entry.itemId === claim.itemId,
  );
  const paidCents = tracked?.paidCents ?? item?.unitCents;
  const qty = tracked?.qty ?? item?.qty ?? 1;
  const purchasedAt = tracked?.purchasedAt ?? purchase?.purchasedAt;
  const hero = headline(claim.status, balance);

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
    <div className="space-y-8">
      <div className="sm:flex sm:items-start sm:justify-between sm:gap-6">
        <div className="mb-4 min-w-0 sm:mb-0">
          <h1 className="text-2xl font-bold text-ink md:text-3xl">{item?.name ?? "Item"}</h1>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-ink/60">
            {purchase ? (
              <Link to={`/purchases/${purchase._id}`} className="font-medium text-harbor hover:underline">
                {purchase.merchant || purchase.merchantDomain}
              </Link>
            ) : (
              "Purchase missing"
            )}
            {qty > 1 && <span className="tabular-nums text-ink/40">×{qty}</span>}
            {claim.attentionAt !== undefined && (
              <span className="rounded-full bg-gold/20 px-1.5 font-medium text-gold">
                Needs you since {when(claim.attentionAt)}
              </span>
            )}
            {pendingFollowUp && (
              <span className="rounded-full bg-ink/10 px-1.5 font-medium text-ink/60">
                Reminder {when(pendingFollowUp.fireAt)}
              </span>
            )}
          </p>
        </div>
        <div className="w-full shrink-0 sm:w-96">
          <StatusSteps status={claim.status} />
        </div>
      </div>

      <div className="grid grid-cols-12 gap-6">
        {/* Row 1: the evidence. What is owed, how far the price fell, and the history. */}
        <Card className="col-span-full xl:col-span-8" bodyClassName="">
          <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4 px-5 pt-5">
            <div>
              <StatLabel>{hero.label}</StatLabel>
              <div className="mt-1 flex items-center gap-2">
                <Money
                  cents={hero.cents}
                  currency={currency}
                  className={`font-sans! text-3xl font-bold ${hero.tone}`}
                />
                {paidCents !== undefined && (
                  <DeltaBadge
                    paidCents={paidCents}
                    latestCents={tracked?.latestCents}
                    currency={currency}
                  />
                )}
              </div>
            </div>
            <dl className="flex gap-6">
              <Figure label="Paid" cents={paidCents} currency={currency} />
              <Figure label="Now" cents={tracked?.latestCents} currency={currency} />
              <Figure label="Lowest" cents={tracked?.lowestCents} currency={currency} />
            </dl>
          </div>
          <div className="min-w-0 px-2 pb-3 pt-4">
            {overview === undefined ? (
              <div
                className="mx-3 h-[300px] animate-pulse rounded-lg bg-ink/5"
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
              <div className="mx-3 flex h-40 items-center justify-center rounded-lg border border-dashed border-line text-sm text-ink/40">
                No price history yet
              </div>
            )}
          </div>
        </Card>

        <div className="col-span-full grid grid-cols-1 gap-6 sm:grid-cols-2 xl:col-span-4 xl:grid-cols-1">
          <Card title="Window">
            <WindowMeter purchasedAt={purchasedAt} endsAt={claim.windowEndsAt} />
            <dl className="mt-4 flex gap-6">
              <DateFigure label="Bought" at={purchasedAt} />
              <DateFigure label="Closes" at={claim.windowEndsAt} />
            </dl>
          </Card>
          <Card title="Ledger">
            <LedgerBar
              expected={balance.expected}
              promised={balance.promised}
              confirmed={balance.confirmed}
              currency={currency}
            />
            <dl className="mt-4 flex gap-6 border-t border-line/60 pt-4">
              <Figure label="Unresolved" cents={balance.unresolved} currency={currency} />
              <Figure label="Confirmed" cents={balance.confirmed} currency={currency} />
              <Figure label="Charged again" cents={balance.debited} currency={currency} />
            </dl>
          </Card>
        </div>

        {/* Row 2: the ask and what came back. */}
        <Card
          title="The ask"
          className="col-span-full xl:col-span-7"
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
                <div className="rounded-lg border border-dashed border-line px-4 py-10 text-center text-sm text-ink/40">
                  No draft yet
                </div>
                {packetChannel !== undefined && !isClosed && (
                  <PacketRow claim={claim} channel={packetChannel} />
                )}
              </>
            )}
            {actionError && <ErrorBox error={actionError} />}
          </div>
        </Card>

        <Card title="Replies" ruled className="col-span-full xl:col-span-5">
          {replies.length === 0 ? (
            <p className="py-6 text-center text-sm text-ink/40">None yet</p>
          ) : (
            <ReplyTimeline replies={replies} currency={currency} />
          )}
        </Card>

        {/* Row 3: money in and out. */}
        <Card title="Record money" className="col-span-full xl:col-span-5">
          <div className="space-y-3">
            <MoneyForm
              title="Credit landed"
              submitLabel="Confirm credit"
              tone="credit"
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
            {!isClosed && (
              <div className="space-y-3 border-t border-line/60 pt-3">
                {dismissError && <ErrorBox error={dismissError} />}
                <button
                  type="button"
                  disabled={busy}
                  className="text-sm font-medium text-rust hover:underline disabled:opacity-60"
                  onClick={() => void run(() => dismiss({ claimId: claim._id }), setDismissError)}
                >
                  Dismiss this claim
                </button>
              </div>
            )}
          </div>
        </Card>

        <Card title="Ledger events" ruled className="col-span-full xl:col-span-7">
          {events.length === 0 ? (
            <p className="py-6 text-center text-sm text-ink/40">No money recorded yet</p>
          ) : (
            <LedgerTimeline events={events} currency={currency} />
          )}
        </Card>
      </div>
    </div>
  );
}
