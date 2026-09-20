import { Empty } from "../components/States";

// T11b: wire api.purchases.board for the row list and the three account totals below.
// T11b: the "load an example purchase" action calls api.examples.load (D27: example rows
// carry an "example" pill and are excluded from these totals).
export default function Board() {
  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-serif text-2xl font-semibold tracking-tight text-ink">Board</h1>
        <p className="mt-1 text-sm text-ink/60">Every purchase with money still on the table.</p>
      </div>

      <dl
        className="grid grid-cols-3 divide-x divide-line overflow-hidden rounded-lg border border-line"
        style={{
          backgroundImage:
            "repeating-linear-gradient(180deg, rgba(30,111,82,0.035) 0px, rgba(30,111,82,0.035) 18px, transparent 18px, transparent 36px)",
        }}
      >
        <div className="px-4 py-4 sm:px-6">
          <dt className="text-xs font-semibold uppercase tracking-wide text-rust/80">Owed</dt>
          <dd className="mt-1 font-mono text-xl tabular-nums text-ink sm:text-2xl">—</dd>
        </div>
        <div className="px-4 py-4 sm:px-6">
          <dt className="text-xs font-semibold uppercase tracking-wide text-harbor/80">Asked</dt>
          <dd className="mt-1 font-mono text-xl tabular-nums text-ink sm:text-2xl">—</dd>
        </div>
        <div className="px-4 py-4 sm:px-6">
          <dt className="text-xs font-semibold uppercase tracking-wide text-moss/80">Confirmed</dt>
          <dd className="mt-1 font-mono text-xl tabular-nums text-ink sm:text-2xl">—</dd>
        </div>
      </dl>

      <Empty
        title="No purchases yet"
        hint="Forward an order confirmation to your Recoup inbox, or paste the text in from Settings, and it will show up here as a case."
      />
    </div>
  );
}
