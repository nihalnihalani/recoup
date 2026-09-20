import { useState } from "react";
import { Empty } from "../components/States";

// T11b: wire api.profiles.me for the signed-in inbox address; api.profiles.ensureInbox
// provisions one on first load if it doesn't exist yet.
// T11b: the paste box below submits to api.intake.paste; a failed/needs_review intake
// event's "Try again" calls api.intake.retryEvent.
export default function Settings() {
  const [pasted, setPasted] = useState("");

  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-serif text-2xl font-semibold tracking-tight text-ink">Settings</h1>
        <p className="mt-1 text-sm text-ink/60">Your Recoup inbox and how to feed it purchases.</p>
      </div>

      <section className="space-y-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-ink/50">Your inbox</h2>
        <Empty
          title="Inbox address not loaded yet"
          hint="Forward order confirmations here and Recoup will turn them into cases automatically."
        />
      </section>

      <section className="space-y-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-ink/50">
          Paste an order confirmation
        </h2>
        <textarea
          value={pasted}
          onChange={(event) => setPasted(event.target.value)}
          rows={6}
          placeholder="Paste the order confirmation email text here…"
          className="w-full rounded-md border border-line bg-white px-3 py-2 text-sm text-ink outline-none focus:border-harbor focus:ring-2 focus:ring-harbor/20"
        />
        <button
          type="button"
          disabled
          title="Wiring up next: T11b"
          className="rounded-md bg-harbor px-4 py-2 text-sm font-semibold text-paper opacity-60"
        >
          Add purchase
        </button>
      </section>
    </div>
  );
}
