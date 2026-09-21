import { useAuthActions } from "@convex-dev/auth/react";
import { useAction, useConvex, useMutation, useQuery } from "convex/react";
import { type ReactNode, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { DELETION_REMOVED_NOW, DELETION_WHAT_REMAINS } from "../lib/accountDeletion";
import {
  EXPORT_CLOSE,
  EXPORT_TABLES,
  exportFilename,
  exportPreamble,
  exportTableChunk,
  fetchAllRows,
} from "../lib/accountExport";
import { ErrorBox, Loading } from "../components/States";
import {
  errorText,
  inputClass,
  labelClass,
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

/** Exact phrase `api.account.requestDeletion` requires (T18 contract, verbatim). */
const DELETE_CONFIRMATION_PHRASE = "delete my account";

const destructiveButtonClass =
  "inline-flex items-center justify-center gap-2 rounded-xl bg-red-700 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-red-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-500 disabled:cursor-not-allowed disabled:opacity-50";

export default function Settings() {
  const deletionStatus = useQuery(api.account.deletionStatus);

  // A still-signed-in tab while deletion is underway (requested here, or in
  // another tab/device) gets a read-only status page instead of the normal
  // Settings screen — every mutation below would fail anyway once
  // `requireUserId` sees the tombstone (`lib/access.ts`), so this avoids
  // showing controls that cannot work.
  if (deletionStatus && (deletionStatus.status === "deleting" || deletionStatus.status === "deleted")) {
    return <DeletionInProgress status={deletionStatus} />;
  }

  return <SettingsContent />;
}

function SettingsContent() {
  const profile = useQuery(api.profiles.me);
  const attention = useQuery(api.intake.needsAttention);
  const alerts = useQuery(api.alerts.settings);
  const setAlerts = useMutation(api.alerts.setAlerts);
  const ensureInbox = useAction(api.profiles.ensureInbox);
  const paste = useAction(api.intake.paste);
  const retryEvent = useMutation(api.intake.retryEvent);
  const requestDeletion = useMutation(api.account.requestDeletion);
  const convex = useConvex();
  const { signOut } = useAuthActions();
  const navigate = useNavigate();

  const [pasted, setPasted] = useState("");
  const [busy, setBusy] = useState(false);
  const [inboxError, setInboxError] = useState<string | null>(null);
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [pasteResult, setPasteResult] = useState<string | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [alertsError, setAlertsError] = useState<string | null>(null);
  const [alertsBusy, setAlertsBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const [exportBusy, setExportBusy] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportProgress, setExportProgress] = useState<{ table: string; rows: number } | null>(null);
  const [exportDone, setExportDone] = useState(false);

  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

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

  /**
   * Walks every table `api.account.exportPage` serves, one table and one
   * page at a time (`useConvex().query(...)` called imperatively in this
   * click handler — not a hook in a loop, which React disallows), and
   * streams the result straight into `Blob` parts (`exportPreamble` /
   * `exportTableChunk` / `EXPORT_CLOSE` from `src/lib/accountExport.ts`) so
   * the browser never holds a second, fully-serialized copy of the export
   * in memory. The server pages at 200 rows; nothing here reads a whole
   * table at once either.
   *
   * D115 (checkpoint 6b-2): `fetchAllRows` itself caps pages per table and
   * throws rather than looping forever if the cursor never goes `null` (a
   * real server-side bug for tables with a large via-parent fan-out, being
   * fixed separately — this client guard does not depend on that fix
   * landing). Any throw from a table's fetch — that cap, or the query
   * itself rejecting — aborts the WHOLE export immediately (no later
   * tables are fetched, no partial file is downloaded) and the error names
   * the table it happened on, since a bare error otherwise doesn't say
   * which of nineteen tables failed.
   */
  async function handleExport() {
    setExportError(null);
    setExportDone(false);
    setExportProgress(null);
    setExportBusy(true);
    let failedTable: (typeof EXPORT_TABLES)[number] | null = null;
    try {
      const exportedAt = Date.now();
      const parts: string[] = [exportPreamble(exportedAt)];
      for (let i = 0; i < EXPORT_TABLES.length; i++) {
        const table = EXPORT_TABLES[i];
        failedTable = table; // Set before the fetch: if it throws, this IS the table that failed.
        setExportProgress({ table, rows: 0 });
        const rows = await fetchAllRows(
          (cursor) => convex.query(api.account.exportPage, { table, cursor }),
          (rowsSoFar) => setExportProgress({ table, rows: rowsSoFar }),
        );
        parts.push(exportTableChunk(table, rows, i === 0));
      }
      failedTable = null;
      parts.push(EXPORT_CLOSE);

      const blob = new Blob(parts, { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = exportFilename(new Date(exportedAt));
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);

      setExportDone(true);
      setExportProgress(null);
    } catch (error) {
      setExportError(failedTable ? `While exporting "${failedTable}": ${errorText(error)}` : errorText(error));
      setExportProgress(null);
    } finally {
      setExportBusy(false);
    }
  }

  /**
   * `api.account.requestDeletion` tombstones the account and revokes every
   * session in one transaction (T18); this client then signs its own tab out
   * (the still-connected socket would otherwise keep working until the token
   * naturally expires) and lands on `/signin` with a static, server-free
   * confirmation carried as route state — never a second server call.
   */
  async function handleDeleteAccount() {
    setDeleteError(null);
    setDeleteBusy(true);
    try {
      await requestDeletion({ confirmation: deleteConfirmation });
      await signOut();
      navigate("/signin", { replace: true, state: { accountDeleted: true } });
    } catch (error) {
      setDeleteError(errorText(error));
      setDeleteBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className={pageTitleClass}>Settings</h1>
          <p className="mt-1 text-sm text-gray-500">Forward an order confirmation, or paste one here.</p>
        </div>
        <div className="flex items-center gap-3">
          <Link to="/privacy" className="rounded text-sm font-semibold text-gray-500 underline decoration-gray-300 underline-offset-4 outline-none transition hover:text-gray-900 hover:decoration-gray-900 focus-visible:ring-2 focus-visible:ring-violet-500">
            Privacy
          </Link>
          <Link to="/" className={secondaryButtonClass}>
            Back to the board
          </Link>
        </div>
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
                        {/* F-T16-3: `lastError` is always undefined on the wire now (T16); `errorSummary` is the real sanitized projection. */}
                        {event.summary ?? event.errorSummary ?? "No detail recorded."}
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

        <SettingsCard title="Export your data" icon={<DownloadIcon />}>
          <div className="space-y-3">
            <p className="text-sm text-gray-500">
              Downloads everything Recoup has about your account — purchases, items, claims, the ledger, drafts,
              replies, watches, price history and the mail log — as one JSON file on your own device.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => void handleExport()}
                disabled={exportBusy}
                className={secondaryButtonClass}
              >
                {exportBusy ? "Exporting…" : "Export my data"}
              </button>
              {exportBusy && exportProgress && (
                <p role="status" aria-live="polite" className="text-sm text-gray-500 tabular-nums">
                  {exportProgress.table}: {exportProgress.rows} row{exportProgress.rows === 1 ? "" : "s"}…
                </p>
              )}
              {!exportBusy && exportDone && (
                <p role="status" className="flex items-center gap-2 text-sm font-medium text-green-700">
                  <span aria-hidden="true" className="size-2 rounded-full bg-green-500" />
                  Downloaded.
                </p>
              )}
            </div>
            {exportError && <ErrorBox error={exportError} className="mt-1" />}
          </div>
        </SettingsCard>

        <SettingsCard title="Delete account" icon={<TrashIcon />} className="lg:col-span-2">
          <div className="space-y-4">
            <div className="space-y-2 text-sm text-gray-500">
              <p>{DELETION_REMOVED_NOW}</p>
              <p>{DELETION_WHAT_REMAINS}</p>
            </div>

            <div>
              <label htmlFor="delete-confirmation" className={labelClass}>
                Type <span className="font-mono font-semibold text-gray-900">{DELETE_CONFIRMATION_PHRASE}</span> to
                confirm
              </label>
              <input
                id="delete-confirmation"
                type="text"
                value={deleteConfirmation}
                onChange={(event) => setDeleteConfirmation(event.target.value)}
                autoComplete="off"
                spellCheck={false}
                className={`${inputClass} max-w-sm`}
              />
            </div>

            <button
              type="button"
              onClick={() => void handleDeleteAccount()}
              disabled={deleteBusy || deleteConfirmation !== DELETE_CONFIRMATION_PHRASE}
              className={destructiveButtonClass}
            >
              {deleteBusy ? "Deleting…" : "Delete my account permanently"}
            </button>

            {deleteError && <ErrorBox error={deleteError} />}
          </div>
        </SettingsCard>
      </div>
    </div>
  );
}

/** Read-only status page shown to a still-signed-in tab while `api.account.deletionStatus` reports `deleting`/`deleted` — every mutation would fail once `requireUserId` sees the tombstone, so no controls are offered, only the current status and a way to sign out. */
function DeletionInProgress({
  status,
}: {
  status: { status: "deleting" | "deleted"; inboxDeleted?: boolean; attempts: number };
}) {
  const { signOut } = useAuthActions();
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <div className="w-full max-w-md rounded-2xl border border-gray-200 bg-white p-6 text-center">
        <h1 className="text-xl font-semibold tracking-tight text-gray-900">
          {status.status === "deleted" ? "Account deleted" : "Deletion in progress"}
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-gray-500">
          {status.status === "deleted"
            ? "This account and its data have been removed."
            : "Your data is being removed. This can take a little while and does not need this page open."}
        </p>
        {status.status === "deleting" && (
          <p className="mt-2 text-xs text-gray-500">
            {status.inboxDeleted === false
              ? "Removing your data is finished; deleting your Recoup inbox with the mail provider is still retrying."
              : "This page will not update further — reload to check status."}
          </p>
        )}
        <button type="button" onClick={() => void signOut()} className={`mt-5 ${primaryButtonClass}`}>
          Sign out
        </button>
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

function DownloadIcon() {
  return (
    <Line>
      <path d="M12 4v11" />
      <path d="M7.500 11 12 15.500 16.500 11" />
      <path d="M4.500 17.500v1.750a1.250 1.250 0 0 0 1.250 1.250h12.500a1.250 1.250 0 0 0 1.250-1.250V17.500" />
    </Line>
  );
}

function TrashIcon() {
  return (
    <Line>
      <path d="M5 7h14" />
      <path d="M9 7V5.500a1.500 1.500 0 0 1 1.500-1.500h3a1.500 1.500 0 0 1 1.500 1.500V7" />
      <path d="M7 7l1 12.500A1.500 1.500 0 0 0 9.500 21h5a1.500 1.500 0 0 0 1.500-1.500L17 7" />
      <path d="M10 11v6M14 11v6" />
    </Line>
  );
}
