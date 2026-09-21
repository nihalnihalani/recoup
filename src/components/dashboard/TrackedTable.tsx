import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { fmt } from "../../lib/money";
import { ProductThumb } from "../ProductThumb";
import { StoreAvatar } from "../StoreAvatar";
import { cardClass, cardTitleClass } from "../../lib/ui";
import { normalizeDomain, storeInfo } from "../../lib/stores";
import { Icon } from "./icons";
import type { TrackedRow } from "./model";
import { Bone, PctChange, StaleBadge, controlClass, focusRing } from "./parts";

type StatusFilter = "all" | "active" | "paused" | "bought";
type SortKey = "name" | "lowest";
type Sort = { key: SortKey; dir: "asc" | "desc" } | null;

const FILTERS: { id: StatusFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "active", label: "Watching" },
  { id: "paused", label: "Paused" },
  { id: "bought", label: "Bought" },
];

const STATUS: Record<TrackedRow["status"], { label: string; dot: string }> = {
  active: { label: "Watching", dot: "bg-green-500" },
  paused: { label: "Paused", dot: "bg-gray-300" },
  bought: { label: "Bought", dot: "bg-sky-500" },
  archived: { label: "Archived", dot: "bg-gray-300" },
};

const MAX_STORE_COLUMNS = 3;

/** The stores most rows list, most common first; ties go to the store seen first. */
function commonStores(rows: TrackedRow[]): string[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const domain of new Set(row.stores.map((store) => normalizeDomain(store.domain)))) {
      counts.set(domain, (counts.get(domain) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_STORE_COLUMNS)
    .map(([domain]) => domain);
}

/** This row's listing at a store; the cheapest one when the store lists it twice. */
function listingAt(row: TrackedRow, domain: string) {
  const at = row.stores.filter((store) => normalizeDomain(store.domain) === domain);
  return at.sort((a, b) => (a.lastCents ?? Number.POSITIVE_INFINITY) - (b.lastCents ?? Number.POSITIVE_INFINITY))[0];
}

function StatusChip({ status }: { status: TrackedRow["status"] }) {
  const config = STATUS[status];
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-gray-200 px-2 py-1 text-xs font-medium text-gray-700">
      <span aria-hidden="true" className={`size-1.5 rounded-full ${config.dot}`} />
      {config.label}
    </span>
  );
}

function StoreCell({ row, domain }: { row: TrackedRow; domain: string }) {
  const listing = listingAt(row, domain);
  if (!listing || listing.lastCents === null) {
    return (
      <span className="text-gray-400" aria-label={listing ? "No price read yet" : "Not listed at this store"}>
        —
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap">
      <span className="font-medium tabular-nums text-gray-900">{fmt(listing.lastCents, row.currency ?? "USD")}</span>
      <PctChange pct={listing.changePct} />
    </span>
  );
}

function SortHeader({ label, sortKey, sort, onSort, align = "left" }: { label: string; sortKey: SortKey; sort: Sort; onSort: (key: SortKey) => void; align?: "left" | "right" }) {
  const dir = sort?.key === sortKey ? sort.dir : undefined;
  return (
    <th
      scope="col"
      aria-sort={dir === "asc" ? "ascending" : dir === "desc" ? "descending" : "none"}
      className={`px-4 py-2.5 font-medium ${align === "right" ? "text-right" : "text-left"}`}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={`-mx-1 inline-flex items-center gap-1 rounded px-1 transition-colors hover:text-gray-900 motion-reduce:transition-none ${focusRing} ${
          dir ? "text-gray-900" : ""
        }`}
      >
        {label}
        <Icon name={dir === "asc" ? "sortUp" : dir === "desc" ? "sortDown" : "sort"} className="size-3.5" />
      </button>
    </th>
  );
}

function FilterPopover({
  status,
  text,
  onStatus,
  onText,
}: {
  status: StatusFilter;
  text: string;
  onStatus: (status: StatusFilter) => void;
  onText: (text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement | null>(null);
  const panelId = useId();
  const activeCount = (status === "all" ? 0 : 1) + (text.trim() === "" ? 0 : 1);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (wrap.current && event.target instanceof Node && !wrap.current.contains(event.target)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={wrap} className="relative">
      <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} aria-controls={panelId} className={controlClass}>
        <Icon name="filter" />
        Filter
        {activeCount > 0 && (
          <span className="rounded-md bg-gray-900 px-1.5 text-xs font-semibold tabular-nums text-gray-100" aria-label={`${activeCount} active`}>
            {activeCount}
          </span>
        )}
      </button>
      {open && (
        <div id={panelId} role="group" aria-label="Filter tracked items" className="absolute right-0 z-30 mt-2 w-64 rounded-xl border border-gray-200 bg-white p-3 shadow-lg">
          <label className="relative block">
            <span className="sr-only">Search by name or store</span>
            <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-gray-400" />
            <input
              type="search"
              value={text}
              onChange={(event) => onText(event.target.value)}
              placeholder="Name or store"
              autoFocus
              className="w-full rounded-lg border border-gray-200 bg-white py-2 pl-9 pr-3 text-sm text-gray-900 placeholder-gray-400 outline-none focus:border-gray-300 focus:ring-2 focus:ring-gray-900/10"
            />
          </label>
          <fieldset className="mt-3">
            <legend className="px-1 text-xs font-medium text-gray-500">Status</legend>
            <div className="mt-1.5 grid grid-cols-2 gap-1.5">
              {FILTERS.map((option) => (
                <label
                  key={option.id}
                  className={`cursor-pointer rounded-lg border px-2.5 py-1.5 text-center text-sm font-medium transition-colors motion-reduce:transition-none has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-gray-900/30 ${
                    status === option.id ? "border-gray-900 bg-gray-900 text-gray-100" : "border-gray-200 text-gray-700 hover:bg-gray-50"
                  }`}
                >
                  <input
                    type="radio"
                    name={`${panelId}-status`}
                    value={option.id}
                    checked={status === option.id}
                    onChange={() => onStatus(option.id)}
                    className="sr-only"
                  />
                  {option.label}
                </label>
              ))}
            </div>
          </fieldset>
          {activeCount > 0 && (
            <button
              type="button"
              onClick={() => {
                onStatus("all");
                onText("");
              }}
              className={`mt-3 w-full rounded-lg py-1.5 text-sm font-medium text-gray-500 hover:text-gray-900 ${focusRing}`}
            >
              Clear filters
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function TrackedTable({ rows }: { rows: TrackedRow[] }) {
  const [status, setStatus] = useState<StatusFilter>("all");
  const [text, setText] = useState("");
  const [sort, setSort] = useState<Sort>(null);

  // Columns come from every row, so filtering never reshuffles the table's shape.
  const columns = commonStores(rows);
  const needle = text.trim().toLowerCase();
  const filtered = rows.filter((row) => {
    if (status !== "all" && row.status !== status) return false;
    if (needle === "") return true;
    return (
      row.name.toLowerCase().includes(needle) ||
      row.stores.some((store) => storeInfo(store.domain).name.toLowerCase().includes(needle) || store.domain.toLowerCase().includes(needle))
    );
  });
  const sorted =
    sort === null
      ? filtered
      : [...filtered].sort((a, b) => {
          const flip = sort.dir === "asc" ? 1 : -1;
          if (sort.key === "name") return flip * a.name.localeCompare(b.name);
          // Rows with no price sink to the bottom in either direction.
          if (a.lowestCents === null || b.lowestCents === null) return a.lowestCents === b.lowestCents ? 0 : a.lowestCents === null ? 1 : -1;
          return flip * (a.lowestCents - b.lowestCents);
        });

  const onSort = (key: SortKey) =>
    setSort((current) => (current?.key !== key ? { key, dir: "asc" } : current.dir === "asc" ? { key, dir: "desc" } : null));

  // F-T24b-2: `priceStale` (true when the primary store's own price is missing or
  // older than STALE_PRICE_MS) excludes that price from `lowestCents`/`lowestDomain`
  // server-side; the em-dash below already covered "nothing priced at all", but gave
  // no signal when staleness was the reason, or that a fresher price was preferred
  // over the primary store's. `StaleBadge` makes that visible as text, not colour.
  const lowest = (row: TrackedRow) =>
    row.lowestCents === null ? (
      <span className="inline-flex items-center gap-1.5">
        <span className="text-gray-400" aria-label={row.priceStale ? "No current price: the primary store's price is missing or out of date" : "No price read yet"}>
          —
        </span>
        {row.priceStale && <StaleBadge />}
      </span>
    ) : (
      <>
        <span className="inline-flex items-center gap-1.5">
          <span className="font-semibold tabular-nums text-gray-900">{fmt(row.lowestCents, row.currency ?? "USD")}</span>
          {row.priceStale && <StaleBadge />}
        </span>
        {row.lowestDomain && <span className="block text-xs text-gray-400">{storeInfo(row.lowestDomain).name}</span>}
      </>
    );

  return (
    <section className={`${cardClass} p-5`} aria-labelledby="tracked-title">
      <header className="flex items-center justify-between gap-3">
        <h2 id="tracked-title" className={cardTitleClass}>
          Tracked Items
          {rows.length > 0 && <span className="ml-2 font-medium tabular-nums text-gray-400">{filtered.length === rows.length ? rows.length : `${filtered.length} of ${rows.length}`}</span>}
        </h2>
        {rows.length > 0 && <FilterPopover status={status} text={text} onStatus={setStatus} onText={setText} />}
      </header>

      {rows.length === 0 ? (
        <p className="py-10 text-center text-sm text-gray-500">
          Nothing watched yet.{" "}
          <Link to="/watching" className={`rounded font-semibold text-gray-900 underline underline-offset-2 ${focusRing}`}>
            Watch a product
          </Link>{" "}
          to compare its price across stores.
        </p>
      ) : sorted.length === 0 ? (
        <p className="py-10 text-center text-sm text-gray-500">No tracked item matches these filters.</p>
      ) : (
        <>
          <table className="mt-4 hidden w-full border-separate border-spacing-0 text-sm md:table">
            <thead className="text-xs text-gray-500">
              <tr className="[&>th]:bg-gray-50 [&>th:first-child]:rounded-l-lg [&>th:last-child]:rounded-r-lg">
                <SortHeader label="Item" sortKey="name" sort={sort} onSort={onSort} />
                {columns.map((domain) => (
                  <th key={domain} scope="col" className="px-4 py-2.5 text-left font-medium">
                    <span className="inline-flex items-center gap-1.5">
                      <StoreAvatar domain={domain} size={16} />
                      {storeInfo(domain).name}
                    </span>
                  </th>
                ))}
                <SortHeader label="Lowest Price" sortKey="lowest" sort={sort} onSort={onSort} />
                <th scope="col" className="px-4 py-2.5 text-left font-medium">
                  Status
                </th>
                <th scope="col" className="px-4 py-2.5">
                  <span className="sr-only">Open</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((row, i) => {
                // Separate borders keep the head band's rounded ends, so each cell draws its own rule.
                const rule = i === sorted.length - 1 ? "" : "border-b border-gray-100";
                return (
                <tr key={row.watchId} className="transition-colors hover:bg-gray-50 motion-reduce:transition-none">
                  <th scope="row" className={`w-[34%] max-w-0 px-4 py-3 text-left font-normal ${rule}`}>
                    <span className="flex items-center gap-3">
                      <ProductThumb imageUrl={row.imageUrl} name={row.name} size={36} domain={row.stores.find((store) => store.isPrimary)?.domain} />
                      <span className="truncate font-medium text-gray-900" title={row.name}>
                        {row.name}
                      </span>
                    </span>
                  </th>
                  {columns.map((domain) => (
                    <td key={domain} className={`px-4 py-3 ${rule}`}>
                      <StoreCell row={row} domain={domain} />
                    </td>
                  ))}
                  <td className={`px-4 py-3 ${rule}`}>{lowest(row)}</td>
                  <td className={`px-4 py-3 ${rule}`}>
                    <StatusChip status={row.status} />
                  </td>
                  <td className={`px-2 py-3 text-right ${rule}`}>
                    <Link
                      to="/watching"
                      aria-label={`Open ${row.name} in Watching`}
                      className={`inline-flex size-8 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-900 motion-reduce:transition-none ${focusRing}`}
                    >
                      <Icon name="dots" className="size-5" />
                    </Link>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>

          <ul className="mt-4 space-y-3 md:hidden">
            {sorted.map((row) => (
              <li key={row.watchId} className="rounded-xl border border-gray-200 p-3">
                <div className="flex items-center gap-3">
                  <ProductThumb imageUrl={row.imageUrl} name={row.name} size={36} domain={row.stores.find((store) => store.isPrimary)?.domain} />
                  <Link to="/watching" className={`min-w-0 grow truncate rounded font-medium text-gray-900 ${focusRing}`}>
                    {row.name}
                  </Link>
                  <StatusChip status={row.status} />
                </div>
                <dl className="mt-3 space-y-1.5 text-sm">
                  {columns
                    .filter((domain) => listingAt(row, domain) !== undefined)
                    .map((domain) => (
                      <div key={domain} className="flex items-center justify-between gap-3">
                        <dt className="flex min-w-0 items-center gap-1.5 text-gray-500">
                          <StoreAvatar domain={domain} size={16} />
                          <span className="truncate">{storeInfo(domain).name}</span>
                        </dt>
                        <dd>
                          <StoreCell row={row} domain={domain} />
                        </dd>
                      </div>
                    ))}
                  <div className="flex items-start justify-between gap-3 border-t border-dashed border-gray-200 pt-2">
                    <dt className="text-gray-500">Lowest price</dt>
                    <dd className="text-right">{lowest(row)}</dd>
                  </div>
                </dl>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

export function TrackedTableSkeleton() {
  return (
    <div className={`${cardClass} p-5`} aria-hidden="true">
      <div className="flex items-center justify-between">
        <Bone className="h-5 w-32" />
        <Bone className="h-9 w-24 rounded-xl" />
      </div>
      <Bone className="mt-4 h-10 w-full rounded-lg" />
      <div className="divide-y divide-gray-100">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex items-center gap-4 px-4 py-3">
            <Bone className="size-9 rounded-lg" />
            <Bone className="h-4 w-1/4" />
            <Bone className="ml-auto h-4 w-16" />
            <Bone className="hidden h-4 w-16 md:block" />
            <Bone className="hidden h-4 w-16 md:block" />
            <Bone className="h-6 w-20 rounded-lg" />
          </div>
        ))}
      </div>
    </div>
  );
}
