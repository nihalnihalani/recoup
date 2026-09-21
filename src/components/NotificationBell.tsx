import { useEffect, useRef, useState } from "react";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { Link } from "react-router-dom";
import { api } from "../../convex/_generated/api";
import { useNow, when } from "../lib/ui";
import { fmt } from "./Money";
import { frameButtonClass } from "./shell/nav";

type ActivityEvent = FunctionReturnType<typeof api.insights.activity>[number];

const NEWS_KINDS = [
  "price_drop",
  "alert_sent",
  "claim_opened",
  "reply_received",
  "credit_promised",
  "credit_confirmed",
  "charged_again",
] as const;
type NewsKind = (typeof NEWS_KINDS)[number];
type NewsEvent = ActivityEvent & { kind: NewsKind };

const SEEN_KEY = "recoup-bell-seen";
const MAX_ROWS = 20;

function isNews(event: ActivityEvent): event is NewsEvent {
  return (NEWS_KINDS as readonly string[]).includes(event.kind);
}

function readSeen(): number {
  try {
    const value = Number(window.localStorage.getItem(SEEN_KEY));
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

function writeSeen(at: number) {
  try {
    window.localStorage.setItem(SEEN_KEY, String(at));
  } catch {
    // Storage blocked: seen state lasts for this page view only.
  }
}

/** Soft tint by what happened: green good, red bad, amber waiting, blue info. */
const TINTS: Record<NewsKind, string> = {
  price_drop: "bg-green-500/15 text-green-700",
  alert_sent: "bg-sky-500/15 text-sky-700",
  claim_opened: "bg-sky-500/15 text-sky-700",
  reply_received: "bg-yellow-500/20 text-yellow-700",
  credit_promised: "bg-yellow-500/20 text-yellow-700",
  credit_confirmed: "bg-green-500/15 text-green-700",
  charged_again: "bg-red-500/15 text-red-700",
};

/** The bold line names what happened; the muted line under it says to what, and for how much. */
const TITLES: Record<NewsKind, string> = {
  price_drop: "Price dropped",
  alert_sent: "Alert emailed",
  claim_opened: "Claim opened",
  reply_received: "The store replied",
  credit_promised: "Credit promised",
  credit_confirmed: "Money back on card",
  charged_again: "Charged again",
};

const GLYPHS: Record<NewsKind, string> = {
  price_drop: "M12 6v12M7 13l5 5 5-5",
  alert_sent: "M4 7h16v10H4zM4 8l8 6 8-6",
  claim_opened: "M7 4h10v16H7zM10 9h4M10 13h4",
  reply_received: "M10 8L5 12l5 4M5 12h9a5 5 0 0 1 5 5",
  credit_promised: "M12 7v5l3 2M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16z",
  credit_confirmed: "M6 12.5l4 4 8-9",
  charged_again: "M12 18V6M7 11l5-5 5 5",
};

function detail(event: NewsEvent): string {
  const currency = event.currency ?? "USD";
  const money = event.cents === undefined ? undefined : fmt(event.cents, currency);
  const delta = event.deltaCents === undefined ? undefined : fmt(Math.abs(event.deltaCents), currency);
  switch (event.kind) {
    case "price_drop":
      return `${event.subject}${delta ? `, down ${delta}` : ""}${money ? ` to ${money}` : ""}`;
    case "alert_sent":
    case "reply_received":
      return event.subject;
    case "claim_opened":
    case "credit_promised":
    case "credit_confirmed":
    case "charged_again":
      return `${event.subject}${money ? `, ${money}` : ""}`;
  }
}

function target(event: NewsEvent): string {
  if (event.claimId) return `/claims/${event.claimId}`;
  if (event.purchaseId) return `/purchases/${event.purchaseId}`;
  if (event.watchId) return "/watching";
  return "/";
}

function ago(at: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Header bell: price drops, alerts and claim news, with a dot for what arrived since it was last opened. */
export function NotificationBell() {
  const events = useQuery(api.insights.activity);
  const now = useNow(60_000);
  const [open, setOpen] = useState(false);
  const [seenAt, setSeenAt] = useState(readSeen);
  // Rows that were new when the panel opened keep their marker until it closes.
  const [freshAfter, setFreshAfter] = useState(seenAt);
  const root = useRef<HTMLDivElement | null>(null);
  const button = useRef<HTMLButtonElement | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);

  const news = (events ?? []).filter(isNews).slice(0, MAX_ROWS);
  const newestAt = news.reduce((max, event) => Math.max(max, event.at), 0);
  // An open panel shows everything, so nothing counts as unseen while it is up.
  const unseen = open ? 0 : news.filter((event) => event.at > seenAt).length;

  useEffect(() => {
    if (open) panel.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    // Closing records the newest event on screen, including any that arrived meanwhile.
    const close = () => {
      setOpen(false);
      if (newestAt > 0) {
        setSeenAt((seen) => Math.max(seen, newestAt));
        writeSeen(newestAt);
      }
    };
    const onPointer = (event: PointerEvent) => {
      if (root.current && event.target instanceof Node && !root.current.contains(event.target)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      close();
      button.current?.focus();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, newestAt]);

  function markSeen() {
    if (newestAt <= seenAt) return;
    setSeenAt(newestAt);
    writeSeen(newestAt);
  }

  function closePanel() {
    markSeen();
    setOpen(false);
  }

  function toggle() {
    if (open) {
      closePanel();
      return;
    }
    setFreshAfter(seenAt);
    markSeen();
    setOpen(true);
  }

  const freshCount = news.filter((event) => event.at > freshAfter).length;
  const label = unseen > 0 ? `Notifications, ${unseen} new` : "Notifications";

  return (
    <div ref={root} className="relative">
      <button
        ref={button}
        type="button"
        onClick={toggle}
        aria-label={label}
        title="Notifications"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? "notification-panel" : undefined}
        className={`${frameButtonClass} ${open ? "bg-gray-50 text-gray-900" : ""}`}
      >
        <svg
          className="size-5"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.7}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z" />
          <path d="M10 20a2 2 0 0 0 4 0" />
        </svg>
        {unseen > 0 && (
          <span
            aria-hidden="true"
            className="absolute -right-2 -top-2 flex h-5 min-w-5 items-center justify-center rounded-full border-2 border-white bg-red-500 px-1 text-[10px] font-bold leading-none text-on-accent tabular-nums"
          >
            {unseen > 99 ? "99+" : unseen}
          </span>
        )}
      </button>

      {open && (
        <div
          ref={panel}
          id="notification-panel"
          role="dialog"
          aria-label="Notifications"
          tabIndex={-1}
          className="absolute right-0 top-full z-20 mt-2 flex max-h-[28rem] w-[22rem] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-lg outline-none"
        >
          <div className="mx-4 flex items-center justify-between gap-3 border-b border-dashed border-gray-200 py-3.5">
            <p className="text-base font-semibold text-gray-900">Notifications</p>
            {freshCount > 0 && (
              <span className="rounded-lg border border-gray-200 px-2 py-0.5 text-xs font-semibold text-gray-500 tabular-nums">
                {freshCount} new
              </span>
            )}
          </div>

          {events === undefined ? (
            <p role="status" className="px-4 py-8 text-center text-sm text-gray-400">
              Loading…
            </p>
          ) : news.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-gray-500">
              No news yet. Price drops and claim updates show up here.
            </p>
          ) : (
            <ul className="min-h-0 flex-1 overflow-auto p-2">
              {news.map((event) => {
                const fresh = event.at > freshAfter;
                return (
                  <li key={event.id}>
                    <Link
                      to={target(event)}
                      onClick={closePanel}
                      className="flex items-start gap-3 rounded-xl px-2 py-2.5 outline-none transition hover:bg-gray-50 focus-visible:bg-gray-50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-violet-500"
                    >
                      <span
                        aria-hidden="true"
                        className={`flex size-8 shrink-0 items-center justify-center rounded-full ${TINTS[event.kind]}`}
                      >
                        <svg
                          className="size-4"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth={2}
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d={GLYPHS[event.kind]} />
                        </svg>
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-baseline justify-between gap-2">
                          <span className="flex min-w-0 items-center gap-1.5 text-sm font-semibold text-gray-900">
                            <span className="truncate">{TITLES[event.kind]}</span>
                            {fresh && (
                              <span className="size-1.5 shrink-0 rounded-full bg-red-500">
                                <span className="sr-only">New</span>
                              </span>
                            )}
                          </span>
                          <time
                            dateTime={new Date(event.at).toISOString()}
                            title={when(event.at)}
                            className="shrink-0 text-xs text-gray-400"
                          >
                            {ago(event.at, now)}
                          </time>
                        </span>
                        <span className="mt-0.5 line-clamp-2 block text-sm text-gray-500" title={detail(event)}>
                          {detail(event)}
                        </span>
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}

          <Link
            to="/"
            onClick={closePanel}
            className="border-t border-gray-200 px-4 py-3 text-center text-sm font-semibold text-gray-900 outline-none transition hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-violet-500"
          >
            View all activity
          </Link>
        </div>
      )}
    </div>
  );
}
