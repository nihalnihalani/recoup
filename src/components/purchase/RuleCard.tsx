import { useAction, useMutation } from "convex/react";
import { useState } from "react";
import { api } from "../../../convex/_generated/api";
import type { Doc } from "../../../convex/_generated/dataModel";
import {
  day,
  errorText,
  inputClass,
  labelClass,
  primaryButtonClass,
  secondaryButtonClass,
} from "../../lib/ui";

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

/** Ten ticks; filled ones are the share of confidence. The number sits beside it in ink. */
function ConfidenceMeter({ value }: { value: number }) {
  const clamped = Math.min(1, Math.max(0, value));
  const filled = Math.round(clamped * 10);
  return (
    <div
      className="flex items-center gap-2"
      role="meter"
      aria-label="Confidence in this reading"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped * 100)}
    >
      <div className="flex gap-0.5" aria-hidden="true">
        {Array.from({ length: 10 }).map((_, index) => (
          <span key={index} className={`h-3 w-1.5 rounded-full ${index < filled ? "bg-harbor" : "bg-gray-200"}`} />
        ))}
      </div>
      <span className="text-xs font-medium tabular-nums text-gray-500">{Math.round(clamped * 100)}%</span>
    </div>
  );
}

const cardClass = "rounded-xl bg-white shadow-xs";
const eyebrowClass = "text-xs font-semibold uppercase text-gray-400";
const summaryClass =
  "cursor-pointer px-5 py-3 text-sm font-medium text-gray-600 hover:text-gray-800 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-harbor";

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
        <h2 className="text-lg font-semibold text-gray-800">Price-adjustment rule</h2>
        <p className="mt-1 text-sm text-gray-500">Not looked up yet for {merchantDomain}.</p>
        <div className="mt-4">{refreshButton("Look it up")}</div>
        {error && (
          <p role="alert" className="mt-3 text-sm text-rust">
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
      <header className="flex flex-wrap items-center justify-between gap-2 px-5 pt-5">
        <h2 className="text-lg font-semibold text-gray-800">Price-adjustment rule</h2>
        {policy.confirmedByUser && (
          <span className="inline-flex items-center gap-1 rounded-full bg-moss/15 px-2.5 py-1 text-xs font-medium text-moss">
            <svg viewBox="0 0 12 12" className="size-3" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
              <path d="m2.5 6.5 2.5 2.5 4.5-5.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Confirmed
          </span>
        )}
      </header>

      <div className="space-y-4 px-5 pb-5 pt-3">
        <div>
          <p className={eyebrowClass}>Window</p>
          <p className="mt-1 flex items-baseline gap-2">
            <span className={`text-3xl font-bold tabular-nums ${known ? "text-gray-800" : "text-gray-300"}`}>
              {known ? policy.windowDays : "?"}
            </span>
            <span className="text-sm text-gray-500">{known ? "days from purchase" : "not known"}</span>
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`rounded-full px-2.5 py-1 text-xs font-medium ${
              policy.channel === "unknown" ? "bg-gray-100 text-gray-600" : "bg-harbor/10 text-harbor"
            }`}
          >
            {CHANNEL_LABEL[policy.channel]}
          </span>
          {policy.contactEmail && (
            <a
              href={`mailto:${policy.contactEmail}`}
              className="truncate rounded-full bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-600 hover:text-gray-800"
            >
              {policy.contactEmail}
            </a>
          )}
        </div>

        <div>
          <p className={eyebrowClass}>Confidence</p>
          <div className="mt-1.5">
            {policy.userEdited ? (
              <p className="text-sm text-gray-500">Your wording, not verified against the site</p>
            ) : (
              <ConfidenceMeter value={policy.confidence} />
            )}
          </div>
        </div>

        {(!hasPassage || policy.note) && (
          <div className="space-y-2 rounded-lg bg-gold/10 px-3 py-2.5">
            <p className="text-sm text-gray-700">
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
              className="font-medium text-harbor hover:underline"
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
        <details className="border-t border-gray-100">
          <summary className={summaryClass}>Read the rule</summary>
          <blockquote className="mx-5 mb-4 border-l-2 border-gray-200 pl-3 text-sm leading-relaxed text-gray-600">
            {policy.passage}
          </blockquote>
        </details>
      )}

      <details className="border-t border-gray-100">
        <summary className={summaryClass}>Correct this</summary>
        <div className="space-y-3 px-5 pb-5">
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
        <p role="alert" className="border-t border-rust/20 bg-rust/10 px-5 py-2.5 text-sm text-rust">
          {error}
        </p>
      )}
    </section>
  );
}
