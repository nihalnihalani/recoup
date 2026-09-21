import { useAction, useMutation, useQuery } from "convex/react";
import { type ReactNode, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { ErrorBox, Loading } from "../components/States";
import {
  errorText,
  inputClass,
  pageTitleClass,
  primaryButtonClass,
  secondaryButtonClass,
  tableHeadClass,
  when,
} from "../lib/ui";

/** `alertSettings.suppressedReason` rendered in the user's own words (never provider jargon). */
const SUPPRESSION_COPY: Record<string, string> = {
  bounced: "Alerts paused: a message to this address bounced. Turn alerts back on to resume.",
  complained: "Alerts paused: a message to this address was marked as spam. Turn alerts back on to resume.",
  user_unsubscribed: "Alerts paused: you unsubscribed from price alerts. Turn alerts back on to resume.",
};

export default function Settings() {
  const profile = useQuery(api.profiles.me);
  const attention = useQuery(api.intake.needsAttention);
  const alerts = useQuery(api.alerts.settings);
  const setAlerts = useMutation(api.alerts.setAlerts);
  const ensureInbox = useAction(api.profiles.ensureInbox);
  const paste = useAction(api.intake.paste);
  const retryEvent = useMutation(api.intake.retryEvent);

  const [pasted, setPasted] = useState("");
  const [busy, setBusy] = useState(false);
  const [inboxError, setInboxError] = useState<string | null>(null);
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [pasteResult, setPasteResult] = useState<string | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [alertsError, setAlertsError] = useState<string | null>(null);
  const [alertsBusy, setAlertsBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  async function handleToggleAlerts(enabled: boolean) {
    setAlertsError(null);
    setAlertsBusy(true);
    try {
      await setAlerts({ enabled });
    } catch (error) {
      setAlertsError(errorText(error));
    } finally {
      setAlertsBusy(false);
    }
  }

  async function handleCopy(address: string) {
    setInboxError(null);
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      setInboxError(errorText(error));
    }
  }

  async function handleEnsureInbox() {
    setInboxError(null);
    setBusy(true);
    try {
      await ensureInbox({});
    } catch (error) {
      setInboxError(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  async function handlePaste() {
    setPasteError(null);
    setPasteResult(null);
    setBusy(true);
    try {
      await paste({ text: pasted });
      setPasted("");
      setPasteResult("Added. Recoup is reading it now — it will appear on the board for review.");
    } catch (error) {
      setPasteError(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleRetry(processedEventId: Id<"processedEvents">) {
    setRetryError(null);
    try {
      await retryEvent({ processedEventId });
    } catch (error) {
      setRetryError(errorText(error));
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className={pageTitleClass}>Settings</h1>
          <p className="mt-1 text-sm text-gray-500">Forward an order confirmation, or paste one here.</p>
        </div>
        <Link to="/" className={secondaryButtonClass}>
          Back to the board
        </Link>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <SettingsCard title="Your Recoup inbox" icon={<InboxIcon />}>
          {profile === undefined ? (
            <Loading rows={1} />
          ) : profile?.inboxEmail ? (
            <div className="space-y-3">
              <div className="flex items-stretch gap-2">
                <code
                  aria-label="Your Recoup inbox address"
                  className="flex min-w-0 flex-1 items-center break-all rounded-xl border border-gray-200 bg-gray-50 px-3.5 py-2.5 font-mono text-sm text-gray-900"
                >
                  {profile.inboxEmail}
                </code>
                <button
                  type="button"
                  className={`${secondaryButtonClass} min-w-24 shrink-0 ${copied ? "text-green-700" : ""}`}
                  onClick={() => void handleCopy(profile.inboxEmail ?? "")}
                >
                  {copied ? <CheckIcon /> : <CopyIcon />}
                  <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
                </button>
              </div>
              <p className="text-sm text-gray-500">Forward order confirmations and merchant replies here.</p>
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-gray-300 px-5 py-8 text-center">
              <p className="text-base font-semibold text-gray-900">No inbox yet</p>
              <p className="mx-auto mt-1.5 max-w-sm text-sm text-gray-500">
                Recoup needs its own address so merchants can reply somewhere it can read.
              </p>
              <button
                type="button"
                onClick={() => void handleEnsureInbox()}
                disabled={busy}
                className={`mt-4 ${primaryButtonClass}`}
              >
                {busy ? "Creating…" : "Create my inbox"}
              </button>
            </div>
          )}
          {inboxError && <ErrorBox error={inboxError} className="mt-3" />}
        </SettingsCard>

        <SettingsCard title="Price alerts" icon={<BellIcon />}>
          {alerts === undefined ? (
            <Loading rows={1} />
          ) : (
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-gray-900" title={alerts.email ?? undefined}>
                    {alerts.email ?? "No email on file"}
                  </p>
                  <p
                    className={`mt-0.5 text-xs font-semibold ${alerts.emailVerified ? "text-green-700" : "text-yellow-700"}`}
                  >
                    {alerts.emailVerified ? "Verified" : "Verify your email to receive alerts"}
                  </p>
                </div>
                <AlertsToggle
                  id="alerts-toggle"
                  checked={alerts.alertsEnabled}
                  disabled={alertsBusy}
                  onChange={(enabled) => void handleToggleAlerts(enabled)}
                />
              </div>

              {alerts.suppressedReason && (
                <p role="status" className="rounded-xl border border-yellow-500/40 bg-yellow-500/10 px-3.5 py-2.5 text-sm text-yellow-700">
                  {SUPPRESSION_COPY[alerts.suppressedReason] ?? "Alerts paused. Turn alerts back on to resume."}
                </p>
              )}

              {alertsError && <ErrorBox error={alertsError} />}

              <p className="border-t border-dashed border-gray-200 pt-3 text-xs leading-relaxed text-gray-500">
                Merchant requests: you approve every message before it is sent. Price alerts: automatic once you opt
                in and verify your email.
              </p>
            </div>
          )}
        </SettingsCard>

        <SettingsCard title="Add a purchase" icon={<ReceiptIcon />}>
          <div className="space-y-3">
            <label htmlFor="paste-order" className="sr-only">
              Order confirmation text
            </label>
            <textarea
              id="paste-order"
              value={pasted}
              onChange={(event) => setPasted(event.target.value)}
              rows={8}
              placeholder="Paste the order confirmation email text here…"
              className={`${inputClass} block resize-y`}
            />
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => void handlePaste()}
                disabled={busy || pasted.trim().length === 0}
                className={primaryButtonClass}
              >
                {busy ? "Reading…" : "Add purchase"}
              </button>
              {pasteResult && (
                <p role="status" className="flex min-w-0 flex-1 items-start gap-2 text-sm font-medium text-green-700">
                  <span aria-hidden="true" className="mt-1.5 size-2 shrink-0 rounded-full bg-green-500" />
                  {pasteResult}
                </p>
              )}
            </div>
            {pasteError && <ErrorBox error={pasteError} />}
          </div>
        </SettingsCard>

        <SettingsCard
          title="Needs attention"
          icon={<AlertIcon />}
          className="lg:col-span-2"
          aside={
            attention !== undefined && attention.length > 0 ? (
              <span className="rounded-lg border border-gray-200 px-2 py-0.5 text-xs font-semibold text-gray-500 tabular-nums">
                {attention.length}
              </span>
            ) : undefined
          }
        >
          {attention === undefined ? (
            <Loading rows={2} />
          ) : attention.length === 0 ? (
            <p className="flex items-center justify-center gap-2 py-6 text-sm text-gray-500">
              <span aria-hidden="true" className="size-2 rounded-full bg-green-500" />
              Nothing stuck
            </p>
          ) : (
            <div className="relative -mx-1 overflow-x-auto px-1">
              {/* relative: keeps the sr-only header inside the scroller instead of widening the page. */}
              <table className="w-full table-auto text-sm">
                <thead className={tableHeadClass}>
                  <tr>
                    <th scope="col" className="rounded-l-lg px-3 py-2.5 text-left font-medium">Status</th>
                    <th scope="col" className="px-3 py-2.5 text-left font-medium">Detail</th>
                    <th scope="col" className="px-3 py-2.5 text-left font-medium">Kind</th>
                    <th scope="col" className="px-3 py-2.5 text-right font-medium">Attempts</th>
                    <th scope="col" className="px-3 py-2.5 text-left font-medium">Received</th>
                    <th scope="col" className="rounded-r-lg px-3 py-2.5">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {attention.map((event) => (
                    <tr key={event._id}>
                      <td className="whitespace-nowrap px-3 py-3">
                        <span className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2 py-1 text-xs font-semibold text-gray-900">
                          <span
                            aria-hidden="true"
                            className={`size-2 rounded-full ${event.status === "failed" ? "bg-red-500" : "bg-yellow-500"}`}
                          />
                          {event.status === "failed" ? "Failed" : "Needs review"}
                        </span>
                      </td>
                      <td className="min-w-64 px-3 py-3 text-gray-900">
                        {event.summary ?? event.lastError ?? "No detail recorded."}
                      </td>
                      <td className="whitespace-nowrap px-3 py-3 text-gray-500">
                        {event.kind}
                        {event.route ? ` / ${event.route}` : ""}
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums text-gray-500">{event.attempts}</td>
                      <td className="whitespace-nowrap px-3 py-3 text-gray-500">{when(event._creationTime)}</td>
                      <td className="px-3 py-3 text-right">
                        {event.status === "failed" && (
                          <button
                            type="button"
                            onClick={() => void handleRetry(event._id)}
                            className={`${secondaryButtonClass} whitespace-nowrap px-3 py-1.5 text-xs`}
                          >
                            Try again
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {retryError && <ErrorBox error={retryError} className="mt-3" />}
        </SettingsCard>
      </div>
    </div>
  );
}

/** The bordered card: icon tile and title over a dashed hairline, then the body. */
function SettingsCard({
  title,
  icon,
  aside,
  className = "",
  children,
}: {
  title: string;
  icon: ReactNode;
  aside?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={`min-w-0 rounded-2xl border border-gray-200 bg-white ${className}`}>
      <header className="mx-5 flex items-center gap-3 border-b border-dashed border-gray-200 py-4">
        <span
          aria-hidden="true"
          className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-gray-200 text-gray-900"
        >
          {icon}
        </span>
        <h2 className="min-w-0 flex-1 truncate text-base font-semibold text-gray-900">{title}</h2>
        {aside}
      </header>
      <div className="p-5">{children}</div>
    </section>
  );
}

function Line({ children, className = "size-5" }: { children: ReactNode; className?: string }) {
  return (
    <svg
      className={`shrink-0 ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/** Accessible on/off switch: a real checkbox (native checked/unchecked semantics for screen readers), visually styled as a track + thumb via sibling `peer-checked` selectors. */
function AlertsToggle({
  id,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <span className="relative inline-flex h-6 w-11 shrink-0 items-center">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        aria-label="Price alerts"
        className="peer absolute inset-0 z-10 size-full cursor-pointer appearance-none outline-none disabled:cursor-not-allowed"
      />
      <span
        aria-hidden="true"
        className="absolute inset-0 rounded-full bg-gray-200 transition-colors peer-checked:bg-gray-900 peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-violet-500 peer-disabled:opacity-60"
      />
      <span
        aria-hidden="true"
        className="relative inline-block size-5 translate-x-0.5 rounded-full bg-white shadow transition-transform peer-checked:translate-x-5"
      />
    </span>
  );
}

function InboxIcon() {
  return (
    <Line>
      <path d="M4 13.5 6.5 5h11L20 13.5V19H4z" />
      <path d="M4 13.5h4.5a3.5 3.5 0 0 0 7 0H20" />
    </Line>
  );
}

function ReceiptIcon() {
  return (
    <Line>
      <path d="M6 3.5h12v17l-3-1.750-3 1.750-3-1.750-3 1.750z" />
      <path d="M9.500 8.500h5M9.500 12h5" />
    </Line>
  );
}

function AlertIcon() {
  return (
    <Line>
      <path d="M12 4 3.500 19h17z" />
      <path d="M12 10v4M12 16.750v.010" />
    </Line>
  );
}

function BellIcon() {
  return (
    <Line>
      <path d="M6 10.5a6 6 0 0 1 12 0c0 4 1.500 5.500 1.500 5.500H4.500S6 14.5 6 10.5z" />
      <path d="M10 19a2 2 0 0 0 4 0" />
    </Line>
  );
}

function CopyIcon() {
  return (
    <Line className="size-4">
      <rect x="8.500" y="8.500" width="11" height="11" rx="2.500" />
      <path d="M15.500 8.500V6.500a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2" />
    </Line>
  );
}

function CheckIcon() {
  return (
    <Line className="size-4">
      <path d="M5 12.500l4.500 4.500L19 7.500" />
    </Line>
  );
}
