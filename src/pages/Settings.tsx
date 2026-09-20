import { useAction, useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { Card } from "../components/claim/Card";
import { Empty, ErrorBox, Loading } from "../components/States";
import {
  errorText,
  inputClass,
  primaryButtonClass,
  secondaryButtonClass,
  when,
} from "../lib/ui";

export default function Settings() {
  const profile = useQuery(api.profiles.me);
  const attention = useQuery(api.intake.needsAttention);
  const ensureInbox = useAction(api.profiles.ensureInbox);
  const paste = useAction(api.intake.paste);
  const retryEvent = useMutation(api.intake.retryEvent);

  const [pasted, setPasted] = useState("");
  const [busy, setBusy] = useState(false);
  const [inboxError, setInboxError] = useState<string | null>(null);
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [pasteResult, setPasteResult] = useState<string | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

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
    <div className="space-y-8">
      <div className="sm:flex sm:items-center sm:justify-between">
        <h1 className="mb-4 text-2xl font-bold text-ink sm:mb-0 md:text-3xl">Settings</h1>
        <Link to="/" className={secondaryButtonClass}>
          Back to the board
        </Link>
      </div>

      <div className="grid grid-cols-12 gap-6">
        <Card title="Your inbox" className="col-span-full xl:col-span-5">
          <div className="space-y-3">
            {profile === undefined ? (
              <Loading rows={1} />
            ) : profile?.inboxEmail ? (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <code className="min-w-0 break-all rounded-full bg-ink/5 px-3 py-1.5 font-mono text-sm text-ink">
                    {profile.inboxEmail}
                  </code>
                  <button
                    type="button"
                    className={secondaryButtonClass}
                    onClick={() => void handleCopy(profile.inboxEmail ?? "")}
                  >
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>
                <p className="text-sm text-ink/60">
                  Forward order confirmations and merchant replies here.
                </p>
              </>
            ) : (
              <Empty
                title="No inbox yet"
                hint="Recoup needs its own address so merchants can reply somewhere it can read."
                action={
                  <button
                    type="button"
                    onClick={() => void handleEnsureInbox()}
                    disabled={busy}
                    className={primaryButtonClass}
                  >
                    {busy ? "Creating…" : "Create my inbox"}
                  </button>
                }
              />
            )}
            {inboxError && <ErrorBox error={inboxError} />}
          </div>
        </Card>

        <Card title="Add a purchase" className="col-span-full xl:col-span-7">
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
              className={inputClass}
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
                <p role="status" className="text-sm font-medium text-moss">
                  {pasteResult}
                </p>
              )}
            </div>
            {pasteError && <ErrorBox error={pasteError} />}
          </div>
        </Card>

        <Card title="Needs attention" ruled className="col-span-full" bodyClassName="p-3">
          {attention === undefined ? (
            <Loading rows={2} className="p-2" />
          ) : attention.length === 0 ? (
            <p className="py-6 text-center text-sm text-ink/40">Nothing stuck</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full table-auto text-sm">
                <thead className="rounded-xs bg-ink/5 text-xs font-semibold uppercase text-ink/40">
                  <tr>
                    <th className="p-2 text-left">Status</th>
                    <th className="p-2 text-left">Detail</th>
                    <th className="p-2 text-left">Kind</th>
                    <th className="p-2 text-right">Attempts</th>
                    <th className="p-2 text-left">Received</th>
                    <th className="p-2">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line/60">
                  {attention.map((event) => (
                    <tr key={event._id}>
                      <td className="whitespace-nowrap p-2">
                        <span
                          className={`rounded-full px-1.5 text-sm font-medium ${
                            event.status === "failed" ? "bg-rust/20 text-rust" : "bg-gold/20 text-gold"
                          }`}
                        >
                          {event.status === "failed" ? "Failed" : "Needs review"}
                        </span>
                      </td>
                      <td className="min-w-64 p-2 text-ink">
                        {event.summary ?? event.lastError ?? "No detail recorded."}
                      </td>
                      <td className="whitespace-nowrap p-2 text-ink/60">
                        {event.kind}
                        {event.route ? ` / ${event.route}` : ""}
                      </td>
                      <td className="p-2 text-right tabular-nums text-ink/60">{event.attempts}</td>
                      <td className="whitespace-nowrap p-2 text-ink/60">{when(event._creationTime)}</td>
                      <td className="p-2 text-right">
                        {event.status === "failed" && (
                          <button
                            type="button"
                            onClick={() => void handleRetry(event._id)}
                            className={secondaryButtonClass}
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
          {retryError && <ErrorBox error={retryError} className="m-2" />}
        </Card>
      </div>
    </div>
  );
}
