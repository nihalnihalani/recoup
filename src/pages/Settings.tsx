import { useAction, useMutation, useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import { useState } from "react";
import { api } from "../../convex/_generated/api";
import { Loading, QueryBoundary } from "../components/States";

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ConvexError && typeof err.data === "string" ? err.data : fallback;
}

// ---------------------------------------------------------------------------
// Inbox: profiles.me for the address, profiles.ensureInbox to provision one.
// ---------------------------------------------------------------------------

function InboxSection() {
  const me = useQuery(api.profiles.me);
  const ensureInbox = useAction(api.profiles.ensureInbox);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdEmail, setCreatedEmail] = useState<string | null>(null);

  async function handleCreate() {
    setError(null);
    setCreating(true);
    try {
      const email = await ensureInbox({});
      setCreatedEmail(email);
    } catch (err) {
      setError(errorMessage(err, "Couldn't create your inbox."));
    } finally {
      setCreating(false);
    }
  }

  if (me === undefined) {
    return (
      <section className="space-y-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-ink/50">Your inbox</h2>
        <Loading rows={1} />
      </section>
    );
  }

  const inboxEmail = me.profile?.inboxEmail ?? createdEmail;

  return (
    <section className="space-y-2">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-ink/50">Your inbox</h2>
      {inboxEmail ? (
        <div className="rounded-lg border border-line bg-white/70 p-4">
          <p className="font-mono text-sm text-ink">{inboxEmail}</p>
          <p className="mt-2 text-sm text-ink/60">
            Forward order confirmations and refund emails here.
          </p>
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-line bg-ink/[0.02] p-4">
          <p className="text-sm text-ink/60">
            Forward order confirmations and refund emails here. Create an inbox to get started.
          </p>
          <button
            type="button"
            onClick={() => void handleCreate()}
            disabled={creating}
            className="mt-3 rounded-md bg-harbor px-4 py-2 text-sm font-semibold text-paper disabled:opacity-60"
          >
            {creating ? "Creating…" : "Create my inbox"}
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-rust">
          {error}
        </p>
      )}
    </section>
  );
}

function SignedInAsSection() {
  const me = useQuery(api.profiles.me);

  if (me === undefined) {
    return (
      <section className="space-y-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-ink/50">Signed in as</h2>
        <Loading rows={1} />
      </section>
    );
  }

  return (
    <section className="space-y-2">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-ink/50">Signed in as</h2>
      <p className="text-sm text-ink">{me.user?.email ?? "Unknown"}</p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Examples
// ---------------------------------------------------------------------------

function ExamplesSection() {
  const remove = useMutation(api.examples.remove);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  async function handleRemove() {
    if (!window.confirm("Remove your example purchases? This can't be undone.")) return;
    setError(null);
    setResult(null);
    setRemoving(true);
    try {
      const { removed } = await remove({});
      setResult(
        removed > 0
          ? `Removed ${removed} example purchase${removed === 1 ? "" : "s"}.`
          : "No example purchases to remove.",
      );
    } catch (err) {
      setError(errorMessage(err, "Couldn't remove example purchases."));
    } finally {
      setRemoving(false);
    }
  }

  return (
    <section className="space-y-2">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-ink/50">Examples</h2>
      <div className="rounded-lg border border-line bg-white/50 p-4">
        <p className="text-sm text-ink/60">
          Clear the example purchases loaded from the Board, if any.
        </p>
        <button
          type="button"
          onClick={() => void handleRemove()}
          disabled={removing}
          className="mt-3 rounded-md border border-line px-4 py-2 text-sm font-semibold text-ink/70 transition hover:border-rust/40 hover:text-rust disabled:opacity-60"
        >
          {removing ? "Removing…" : "Remove example purchases"}
        </button>
        {result && <p className="mt-2 text-sm text-ink/60">{result}</p>}
        {error && (
          <p role="alert" className="mt-2 text-sm text-rust">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}

function SettingsContent() {
  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-serif text-2xl font-semibold tracking-tight text-ink">Settings</h1>
        <p className="mt-1 text-sm text-ink/60">Your Recoup inbox and how to feed it purchases.</p>
      </div>

      <InboxSection />
      <SignedInAsSection />
      <ExamplesSection />
    </div>
  );
}

export default function Settings() {
  return (
    <QueryBoundary>
      <SettingsContent />
    </QueryBoundary>
  );
}
