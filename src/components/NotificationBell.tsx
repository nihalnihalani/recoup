import { useEffect, useRef, useState } from "react";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { Link } from "react-router-dom";
import { api } from "../../convex/_generated/api";
import { useNow, when } from "../lib/ui";
import { fmt } from "./Money";

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

/** Ring colour by what happened. A filled ring means money actually moved. */
const RINGS: Record<NewsKind, string> = {
  price_drop: "border-green-500 text-green-700",
  alert_sent: "border-sky-500 text-sky-700",
  claim_opened: "border-sky-500 text-sky-700",
  reply_received: "border-yellow-500 text-yellow-700",
  credit_promised: "border-yellow-500 text-yellow-700",
  credit_confirmed: "border-green-500 bg-green-500 text-on-accent",
  charged_again: "border-red-500 bg-red-500 text-on-accent",
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

function told(event: NewsEvent): string {
  const currency = event.currency ?? "USD";
  const money = event.cents === undefined ? undefined : fmt(event.cents, currency);
  const delta = event.deltaCents === undefined ? undefined : fmt(Math.abs(event.deltaCents), currency);
  switch (event.kind) {
    case "price_drop":
      return `${event.subject} dropped${delta ? ` ${delta}` : ""}${money ? ` to ${money}` : ""}`;
    case "alert_sent":
      return `Alert emailed: ${event.subject}`;
    case "claim_opened":
      return `Claim opened for ${event.subject}${money ? `, ${money}` : ""}`;
    case "reply_received":
      return `The store replied about ${event.subject}`;
    case "credit_promised":
      return `${money ?? "Credit"} promised for ${event.subject}`;
    case "credit_confirmed":
      return `${money ?? "Credit"} back on card for ${event.subject}`;
    case "charged_again":
      return `Charged again${money ? ` ${money}` : ""} for ${event.subject}`;
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
        className={`relative flex size-8 items-center justify-center rounded-full outline-none transition hover:bg-white hover:text-gray-700 focus-visible:ring-2 focus-visible:ring-violet-500 ${
          open ? "bg-white text-gray-700" : "text-gray-500"
        }`}
      >
        <svg
          className="size-5"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.6}
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
            className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full border-2 border-gray-100 bg-red-500 px-0.5 text-[10px] font-bold leading-none text-on-accent tabular-nums"
          >
            {unseen > 9 ? "9+" : unseen}
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
          className="absolute right-0 top-full z-20 mt-2 flex max-h-96 w-80 max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-xl border border-gray-200 bg-white shadow-lg outline-none"
        >
          <p className="border-b border-gray-100 px-4 py-3 text-xs font-semibold uppercase text-gray-400">Notifications</p>

          {events === undefined ? null : news.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-gray-500">No news yet</p>
          ) : (
            <ul className="min-h-0 flex-1 divide-y divide-gray-100 overflow-auto">
              {news.map((event) => {
                const fresh = event.at > freshAfter;
                return (
                  <li key={event.id}>
                    <Link
                      to={target(event)}
                      onClick={closePanel}
                      className="flex items-start gap-3 px-4 py-3 outline-none transition hover:bg-gray-50 focus-visible:bg-gray-50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-violet-500"
                    >
                      <span
                        aria-hidden="true"
                        className={`mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border-2 ${RINGS[event.kind]}`}
                      >
                        <svg
                          className="size-3.5"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth={2.2}
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d={GLYPHS[event.kind]} />
                        </svg>
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className={`block truncate text-sm ${fresh ? "font-semibold text-gray-800" : "font-medium text-gray-600"}`} title={told(event)}>
                          {told(event)}
                        </span>
                        <time dateTime={new Date(event.at).toISOString()} title={when(event.at)} className="block text-xs text-gray-400">
                          {ago(event.at, now)}
                        </time>
                      </span>
                      {fresh && (
                        <span className="mt-1.5 size-2 shrink-0 rounded-full bg-violet-500">
                          <span className="sr-only">New</span>
                        </span>
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}

          <Link
            to="/"
            onClick={closePanel}
            className="border-t border-gray-100 px-4 py-2.5 text-center text-sm font-medium text-violet-500 outline-none hover:text-violet-600 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-violet-500"
          >
            View all activity
          </Link>
        </div>
      )}
    </div>
  );
}
