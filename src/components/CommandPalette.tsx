import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { useQuery } from "convex/react";
import { useNavigate } from "react-router-dom";
import { api } from "../../convex/_generated/api";
import { PurchaseIcon, ReturnIcon, SearchIcon, WatchlistIcon } from "./shell/icons";
import { NAV } from "./shell/nav";

type Group = "Pages" | "Watching" | "Bought";
const GROUPS: readonly Group[] = ["Pages", "Watching", "Bought"];
/** Rows shown per data group, so a long history cannot bury the pages. */
const GROUP_LIMIT = 8;

type Entry = {
  key: string;
  group: Group;
  title: string;
  detail?: string;
  to: string;
  icon: ReactNode;
};

type DialogProps = {
  onClose: () => void;
  /** `undefined` while the query loads. */
  watches: readonly { _id: string; name: string; merchantDomain: string }[] | undefined;
  bought: readonly { itemId: string; purchaseId: string; name: string; merchant: string }[] | undefined;
};

function matches(entry: Entry, needle: string): boolean {
  if (needle.length === 0) return true;
  return `${entry.title} ${entry.detail ?? ""}`.toLowerCase().includes(needle);
}

function PaletteDialog({ onClose, watches, bought }: DialogProps) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement | null>(null);
  const list = useRef<HTMLDivElement | null>(null);
  const baseId = useId();

  // Take focus on open and hand it back to whatever had it on close.
  useEffect(() => {
    const previous = document.activeElement;
    input.current?.focus();
    return () => {
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);

  // The page behind must not scroll under the backdrop.
  useEffect(() => {
    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = overflow;
    };
  }, []);

  const entries = useMemo<Entry[]>(() => {
    const needle = query.trim().toLowerCase();
    const pages: Entry[] = NAV.map((item) => ({
      key: `page:${item.to}`,
      group: "Pages",
      title: item.label,
      to: item.to,
      icon: item.icon,
    }));
    const watching: Entry[] = (watches ?? []).map((watch) => ({
      key: `watch:${watch._id}`,
      group: "Watching",
      title: watch.name,
      detail: watch.merchantDomain,
      to: "/watching",
      icon: <WatchlistIcon />,
    }));
    const purchases: Entry[] = (bought ?? []).map((item) => ({
      key: `item:${item.itemId}`,
      group: "Bought",
      title: item.name,
      detail: item.merchant,
      to: `/purchases/${item.purchaseId}`,
      icon: <PurchaseIcon />,
    }));
    return [
      ...pages.filter((entry) => matches(entry, needle)),
      ...watching.filter((entry) => matches(entry, needle)).slice(0, GROUP_LIMIT),
      ...purchases.filter((entry) => matches(entry, needle)).slice(0, GROUP_LIMIT),
    ];
  }, [query, watches, bought]);

  // Results can shrink under the cursor (typing, live data); never point past the end.
  const current = Math.min(active, Math.max(0, entries.length - 1));
  const optionId = (index: number) => `${baseId}-option-${index}`;

  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [current, entries]);

  function go(entry: Entry) {
    onClose();
    navigate(entry.to);
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        if (entries.length > 0) setActive((current + 1) % entries.length);
        break;
      case "ArrowUp":
        event.preventDefault();
        if (entries.length > 0) setActive((current - 1 + entries.length) % entries.length);
        break;
      case "Home":
        if (entries.length > 0) {
          event.preventDefault();
          setActive(0);
        }
        break;
      case "End":
        if (entries.length > 0) {
          event.preventDefault();
          setActive(entries.length - 1);
        }
        break;
      case "Enter": {
        event.preventDefault();
        const entry = entries[current];
        if (entry) go(entry);
        break;
      }
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        onClose();
        break;
      case "Tab":
        // Focus trap: the input is the dialog's only tab stop; options are reached with the arrows.
        event.preventDefault();
        input.current?.focus();
        break;
    }
  }

  const loading = watches === undefined || bought === undefined;

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center px-4 pt-[12vh]" onKeyDown={onKeyDown}>
      <div className="absolute inset-0 bg-black/40" aria-hidden="true" onPointerDown={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search Recoup"
        className="palette-in relative flex max-h-[min(30rem,70vh)] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-xl"
      >
        <div className="flex items-center gap-3 border-b border-gray-200 px-4">
          <SearchIcon className="size-5 text-gray-400" />
          <input
            ref={input}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={`${baseId}-list`}
            aria-activedescendant={entries.length > 0 ? optionId(current) : undefined}
            aria-autocomplete="list"
            aria-label="Search pages, watched products and purchases"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            placeholder="Search anything…"
            className="h-14 min-w-0 flex-1 bg-transparent text-[15px] text-gray-900 placeholder-gray-400 outline-none"
          />
          <kbd className="rounded-md border border-gray-200 bg-gray-50 px-1.5 py-0.5 font-sans text-[11px] font-semibold text-gray-500">
            Esc
          </kbd>
        </div>

        <div ref={list} id={`${baseId}-list`} role="listbox" aria-label="Results" className="min-h-0 flex-1 overflow-y-auto p-2">
          {entries.length === 0 ? (
            <p className="px-3 py-10 text-center text-sm text-gray-500">
              {loading ? "Loading your products…" : `Nothing matches “${query.trim()}”. Try a product or store name.`}
            </p>
          ) : (
            GROUPS.map((group) => {
              const rows = entries.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.group === group);
              if (rows.length === 0) return null;
              const headingId = `${baseId}-${group}`;
              return (
                <div key={group} role="group" aria-labelledby={headingId} className="mb-1 last:mb-0">
                  <p id={headingId} className="px-3 pb-1 pt-2 text-xs font-medium uppercase tracking-wide text-gray-400">
                    {group}
                  </p>
                  {rows.map(({ entry, index }) => {
                    const selected = index === current;
                    return (
                      <div
                        key={entry.key}
                        id={optionId(index)}
                        role="option"
                        aria-selected={selected}
                        onPointerMove={() => {
                          if (!selected) setActive(index);
                        }}
                        onClick={() => go(entry)}
                        className={`flex h-11 cursor-pointer items-center gap-3 rounded-xl border px-3 text-sm ${
                          selected ? "border-gray-200 bg-gray-50 text-gray-900" : "border-transparent text-gray-700"
                        }`}
                      >
                        <span className={selected ? "text-gray-900" : "text-gray-400"}>{entry.icon}</span>
                        <span className="min-w-0 flex-1 truncate font-medium">{entry.title}</span>
                        {entry.detail && <span className="max-w-[40%] shrink-0 truncate text-xs text-gray-400">{entry.detail}</span>}
                        {selected && <ReturnIcon className="size-4 text-gray-400" />}
                      </div>
                    );
                  })}
                </div>
              );
            })
          )}
        </div>

        <p className="flex items-center gap-4 border-t border-gray-200 px-4 py-2.5 text-xs text-gray-400" aria-hidden="true">
          <span>↑↓ to move</span>
          <span>Enter to open</span>
          <span className="ml-auto">Esc to close</span>
        </p>
      </div>
    </div>
  );
}

/**
 * Global search. Opened by the top bar's search field or ⌘K / Ctrl+K (wired in Shell).
 * The two data queries are skipped while closed, so the palette costs nothing at rest.
 */
export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const watches = useQuery(api.watches.list, open ? {} : "skip");
  const overview = useQuery(api.tracking.overview, open ? {} : "skip");
  if (!open) return null;
  return <PaletteDialog onClose={onClose} watches={watches} bought={overview?.items} />;
}
