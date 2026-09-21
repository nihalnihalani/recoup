import { useAction, useMutation } from "convex/react";
import { useState } from "react";
import { api } from "../../../convex/_generated/api";
import type { Doc } from "../../../convex/_generated/dataModel";
import {
  bigNumberClass,
  cardClass,
  day,
  errorText,
  inputClass,
  labelClass,
  mutedLabelClass,
  primaryButtonClass,
  secondaryButtonClass,
} from "../../lib/ui";
import { CardHeading, DotChip, RuleIcon } from "./parts";

type Policy = Doc<"policies">;
type PolicyChannel = Policy["channel"];

const CHANNELS: readonly PolicyChannel[] = ["email", "form", "chat", "phone", "unknown"];

const CHANNEL_LABEL: Record<PolicyChannel, string> = {
  email: "By email",
  form: "Web form",
  chat: "Live chat",
  phone: "By phone",
  unknown: "Channel unknown",
};

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** A slim bar filled to the share of confidence. The number sits beside it in ink. */
function ConfidenceMeter({ value }: { value: number }) {
  const clamped = Math.min(1, Math.max(0, value));
  return (
    <div
      className="flex items-center gap-3"
      role="meter"
      aria-label="Confidence in this reading"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped * 100)}
    >
      <div className="h-1.5 w-32 max-w-full overflow-hidden rounded-full bg-gray-100" aria-hidden="true">
        <div className="h-full rounded-full bg-gray-900" style={{ width: `${clamped * 100}%` }} />
      </div>
      <span className="text-sm font-semibold tabular-nums text-gray-900">{Math.round(clamped * 100)}%</span>
    </div>
  );
}

const summaryClass =
  "cursor-pointer px-5 py-3.5 text-sm font-semibold text-gray-900 hover:bg-gray-50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-violet-500";

/**
 * The store's price-adjustment rule as a card of facts, not a paragraph.
 * Snapshots are immutable (D17): a refresh inserts a new row, so the parent
 * keys this component by policy id to reset the correction fields.
 */
export function RuleCard({
  policy,
  merchantDomain,
}: {
  policy: Policy | undefined;
  merchantDomain: string;
}) {
  const confirmPolicy = useMutation(api.policies.confirm);
  const refresh = useAction(api.policies.refresh);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"refresh" | "confirm" | null>(null);
  const [channel, setChannel] = useState<PolicyChannel>(policy?.channel ?? "unknown");
  const [contactEmail, setContactEmail] = useState(policy?.contactEmail ?? "");
  const [windowDays, setWindowDays] = useState(
    policy?.windowDays === undefined ? "" : String(policy.windowDays),
  );
  const [passage, setPassage] = useState(policy?.passage ?? "");
  const [sourceUrl, setSourceUrl] = useState(policy?.sourceUrl ?? "");

  async function handleRefresh() {
    setError(null);
    setBusy("refresh");
    try {
      await refresh({ merchantDomain, kind: "price_adjustment" });
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(null);
    }
  }

  async function handleConfirm(current: Policy) {
    setError(null);
    const trimmedDays = windowDays.trim();
    const days = trimmedDays === "" ? undefined : Number(trimmedDays);
    if (days !== undefined && (!Number.isSafeInteger(days) || days < 0)) {
      setError("Enter the window as a whole number of days.");
      return;
    }
    setBusy("confirm");
    try {
      await confirmPolicy({
        policyId: current._id,
        channel,
        contactEmail: contactEmail.trim() === "" ? undefined : contactEmail.trim(),
        windowDays: days,
        // Only send wording the user actually changed: an edited passage or
        // source clears the verified-scrape markers on the server (D45).
        passage: passage.trim() !== current.passage.trim() ? passage.trim() : undefined,
        sourceUrl: sourceUrl.trim() !== current.sourceUrl.trim() ? sourceUrl.trim() : undefined,
      });
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(null);
    }
  }

  const refreshButton = (label: string) => (
    <button type="button" disabled={busy !== null} onClick={() => void handleRefresh()} className={secondaryButtonClass}>
      {busy === "refresh" ? "Reading the site…" : label}
    </button>
  );

  if (!policy) {
    return (
      <section aria-label="Price-adjustment rule" className={`${cardClass} p-5`}>
        <CardHeading icon={<RuleIcon />} title="Price-adjustment rule" />
        <p className="mt-4 border-t border-dashed border-gray-200 pt-4 text-sm text-gray-500">
          Not looked up yet for {merchantDomain}.
        </p>
        <div className="mt-4">{refreshButton("Look it up")}</div>
        {error && (
          <p role="alert" className="mt-3 text-sm text-red-700">
            {error}
          </p>
        )}
      </section>
    );
  }

  const hasPassage = policy.passage.trim() !== "";
  const known = policy.windowDays !== undefined;

  return (
    <section aria-label="Price-adjustment rule" className={`${cardClass} overflow-hidden`}>
      <div className="px-5 pt-5">
        <CardHeading
          icon={<RuleIcon />}
          title="Price-adjustment rule"
          action={policy.confirmedByUser ? <DotChip dot="bg-moss">Confirmed</DotChip> : undefined}
        />
      </div>

      <div className="mx-5 mt-4 space-y-5 border-t border-dashed border-gray-200 pb-5 pt-4">
        <div>
          <p className={mutedLabelClass}>Window</p>
          <p className="mt-1 flex items-baseline gap-2">
            <span className={known ? bigNumberClass : "text-3xl font-semibold tracking-tight tabular-nums text-gray-300"}>
              {known ? policy.windowDays : "?"}
            </span>
            <span className="text-sm text-gray-500">{known ? "days from purchase" : "not known"}</span>
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <DotChip dot={policy.channel === "unknown" ? "bg-gray-300" : "bg-teal"}>{CHANNEL_LABEL[policy.channel]}</DotChip>
          {policy.contactEmail && (
            <a
              href={`mailto:${policy.contactEmail}`}
              className="min-w-0 truncate rounded-lg border border-gray-200 px-2 py-0.5 text-xs font-medium text-gray-500 transition hover:text-gray-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-500"
            >
              {policy.contactEmail}
            </a>
          )}
        </div>

        <div>
          <p className={mutedLabelClass}>Confidence</p>
          <div className="mt-1.5">
            {policy.userEdited ? (
              <p className="text-sm text-gray-500">Your wording, not verified against the site</p>
            ) : (
              <ConfidenceMeter value={policy.confidence} />
            )}
          </div>
        </div>

        {(!hasPassage || policy.note) && (
          <div className="space-y-2.5 rounded-xl border border-gold/40 bg-gold/5 px-3.5 py-3">
            <p className="text-sm text-gray-900">
              {policy.note ?? "No rule text was found. Treat this store's rule as unknown."}
            </p>
            {!hasPassage && refreshButton("Read the site again")}
          </div>
        )}

        <p className="flex flex-wrap items-center justify-between gap-2 text-xs text-gray-400">
          {policy.sourceUrl ? (
            <a
              href={policy.sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="rounded font-semibold text-gray-900 underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-500"
            >
              {hostOf(policy.sourceUrl)}
            </a>
          ) : (
            <span>No source page</span>
          )}
          <span>Read {day(policy.retrievedAt)}</span>
        </p>
      </div>

      {hasPassage && (
        <details className="border-t border-gray-200">
          <summary className={summaryClass}>Read the rule</summary>
          <blockquote className="mx-5 mb-5 border-l-2 border-gray-200 pl-3 text-sm leading-relaxed text-gray-500">
            {policy.passage}
          </blockquote>
        </details>
      )}

      <details className="border-t border-gray-200">
        <summary className={summaryClass}>Correct this</summary>
        <div className="space-y-4 px-5 pb-5 pt-1">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelClass} htmlFor={`window-${policy._id}`}>
                Window (days)
              </label>
              <input
                id={`window-${policy._id}`}
                inputMode="numeric"
                className={inputClass}
                placeholder="unknown"
                value={windowDays}
                onChange={(event) => setWindowDays(event.target.value)}
              />
            </div>
            <div>
              <label className={labelClass} htmlFor={`channel-${policy._id}`}>
                Channel
              </label>
              <select
                id={`channel-${policy._id}`}
                className={inputClass}
                value={channel}
                onChange={(event) => {
                  const next = CHANNELS.find((option) => option === event.target.value);
                  if (next) setChannel(next);
                }}
              >
                {CHANNELS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className={labelClass} htmlFor={`contact-${policy._id}`}>
              Contact email
            </label>
            <input
              id={`contact-${policy._id}`}
              type="email"
              className={inputClass}
              placeholder="unknown"
              value={contactEmail}
              onChange={(event) => setContactEmail(event.target.value)}
            />
          </div>
          <div>
            <label className={labelClass} htmlFor={`passage-${policy._id}`}>
              Rule wording
            </label>
            <textarea
              id={`passage-${policy._id}`}
              rows={3}
              className={inputClass}
              value={passage}
              onChange={(event) => setPassage(event.target.value)}
            />
          </div>
          <div>
            <label className={labelClass} htmlFor={`source-${policy._id}`}>
              Source page
            </label>
            <input
              id={`source-${policy._id}`}
              className={inputClass}
              placeholder="https://…"
              value={sourceUrl}
              onChange={(event) => setSourceUrl(event.target.value)}
            />
            <p className="mt-1 text-xs text-gray-400">Changing the wording or source marks the rule as yours, unverified.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void handleConfirm(policy)}
              className={primaryButtonClass}
            >
              {busy === "confirm" ? "Saving…" : policy.confirmedByUser ? "Save corrections" : "Confirm this rule"}
            </button>
            {refreshButton("Read the site again")}
          </div>
        </div>
      </details>

      {error && (
        <p role="alert" className="border-t border-rust/20 bg-rust/5 px-5 py-2.5 text-sm text-red-700">
          {error}
        </p>
      )}
    </section>
  );
}
