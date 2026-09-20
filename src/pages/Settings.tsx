import { useAction, useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { Empty, ErrorBox, Loading } from "../components/States";
import {
  errorText,
  inputClass,
  primaryButtonClass,
  secondaryButtonClass,
  sectionClass,
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
      <div>
        <h1 className="font-serif text-2xl font-semibold tracking-tight text-ink">Settings</h1>
        <p className="mt-1 text-sm text-ink/60">Your Recoup inbox and how to feed it purchases.</p>
      </div>

      <section className="space-y-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-ink/50">Your inbox</h2>
        {profile === undefined ? (
          <Loading rows={1} />
        ) : profile?.inboxEmail ? (
          <div className={sectionClass}>
            <p className="font-mono text-sm text-ink">{profile.inboxEmail}</p>
            <p className="mt-2 text-sm text-ink/60">
              Forward order confirmations and merchant replies here. Recoup turns them into cases
              automatically.
            </p>
          </div>
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
      </section>

      <section className="space-y-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-ink/50">
          Paste an order confirmation
        </h2>
        <textarea
          value={pasted}
          onChange={(event) => setPasted(event.target.value)}
          rows={8}
          placeholder="Paste the order confirmation email text here…"
          className={inputClass}
        />
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => void handlePaste()}
            disabled={busy || pasted.trim().length === 0}
            className={primaryButtonClass}
          >
            {busy ? "Reading…" : "Add purchase"}
          </button>
          <Link to="/" className="text-sm text-ink/60 underline-offset-2 hover:text-ink hover:underline">
            Back to the board
          </Link>
        </div>
        {pasteResult && <p className="text-sm text-moss">{pasteResult}</p>}
        {pasteError && <ErrorBox error={pasteError} />}
      </section>

      <section className="space-y-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-ink/50">Needs attention</h2>
        {attention === undefined ? (
          <Loading rows={2} />
        ) : attention.length === 0 ? (
          <p className="text-sm text-ink/60">Nothing stuck. Every message Recoup received went through.</p>
        ) : (
          <ul className="space-y-2">
            {attention.map((event) => (
              <li key={event._id} className={sectionClass}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-xs font-semibold uppercase tracking-wide text-rust">
                    {event.status === "failed" ? "Failed" : "Needs review"}
                  </span>
                  <span className="text-xs text-ink/50">{when(event._creationTime)}</span>
                </div>
                <p className="mt-1 text-sm text-ink">
                  {event.summary ?? event.lastError ?? "No detail recorded."}
                </p>
                <p className="mt-1 text-xs text-ink/50">
                  {event.kind} · attempts {event.attempts}
                  {event.route ? ` · ${event.route}` : ""}
                </p>
                {event.status === "failed" && (
                  <button
                    type="button"
                    onClick={() => void handleRetry(event._id)}
                    className={`mt-3 ${secondaryButtonClass}`}
                  >
                    Try again
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {retryError && <ErrorBox error={retryError} />}
      </section>
    </div>
  );
}
