import { useState } from "react";
import { Link } from "react-router-dom";
import { fmt } from "../Money";
import { cardClass, when } from "../../lib/ui";
import { storeInfo } from "../../lib/stores";
import { ago } from "./model";
import type { ActivityEvent } from "./model";
import { CardHeader } from "./parts";

const FIRST = 12;

type Kind = ActivityEvent["kind"];

/** Ring colour by what happened. A filled bullet means money actually moved. */
const RINGS: Record<Kind, string> = {
  price_drop: "border-green-500 bg-white",
  price_rise: "border-red-500 bg-white",
  price_seen: "border-violet-500 bg-white",
  watch_added: "border-violet-500 bg-white",
  purchase_added: "border-violet-500 bg-white",
  price_unreadable: "border-gray-300 bg-white",
  alert_sent: "border-sky-500 bg-white",
  claim_opened: "border-sky-500 bg-white",
  ask_sent: "border-sky-500 bg-white",
  reply_received: "border-yellow-500 bg-white",
  credit_promised: "border-yellow-500 bg-white",
  credit_confirmed: "border-green-500 bg-green-500",
  charged_again: "border-red-500 bg-red-500",
};

/** What happened to the subject, as the words that follow its name. */
function told(event: ActivityEvent): string {
  const currency = event.currency ?? "USD";
  const money = event.cents === undefined ? undefined : fmt(event.cents, currency);
  const delta = event.deltaCents === undefined ? undefined : fmt(Math.abs(event.deltaCents), currency);
  switch (event.kind) {
    case "price_drop":
      return `dropped ${delta ?? ""}${money ? ` to ${money}` : ""}`;
    case "price_rise":
      return `rose ${delta ?? ""}${money ? ` to ${money}` : ""}`;
    case "price_seen":
      return money ? `first seen at ${money}` : "first seen";
    case "price_unreadable":
      return "page could not be read";
    case "watch_added":
      return "added to watching";
    case "purchase_added":
      return "purchase added";
    case "alert_sent":
      return "alert emailed";
    case "claim_opened":
      return money ? `claim opened for ${money}` : "claim opened";
    case "ask_sent":
      return "price adjustment asked";
    case "reply_received":
      return "store replied";
    case "credit_promised":
      return money ? `${money} promised` : "credit promised";
    case "credit_confirmed":
      return money ? `${money} back on card` : "back on card";
    case "charged_again":
      return money ? `charged again, ${money}` : "charged again";
  }
}

function target(event: ActivityEvent): string | undefined {
  if (event.claimId) return `/claims/${event.claimId}`;
  if (event.purchaseId) return `/purchases/${event.purchaseId}`;
  if (event.watchId) return "/watching";
  return undefined;
}

export function ActivityFeed({ events, now }: { events: ActivityEvent[]; now: number }) {
  const [all, setAll] = useState(false);
  // Rows present at first paint stay still; only what arrives afterwards slides in.
  const [initial] = useState(() => new Set(events.map((event) => event.id)));
  const shown = all ? events : events.slice(0, FIRST);

  return (
    <section className={`col-span-full flex flex-col xl:col-span-5 ${cardClass}`} aria-labelledby="activity-title">
      <CardHeader id="activity-title" title="Activity" />
      {events.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-gray-400">Price checks, drops and replies show up here as they happen.</p>
      ) : (
        <ol className="grow px-5 py-4" aria-live="polite" aria-relevant="additions">
          {shown.map((event, i) => {
            const to = target(event);
            const lastRow = i === shown.length - 1;
            return (
              <li key={event.id} className={`flex gap-3 ${initial.has(event.id) ? "" : "feed-in"}`}>
                <time
                  dateTime={new Date(event.at).toISOString()}
                  title={when(event.at)}
                  className="w-12 shrink-0 pt-0.5 text-right text-xs tabular-nums text-gray-400"
                >
                  {ago(event.at, now)}
                </time>
                <div className="relative flex w-3 shrink-0 justify-center" aria-hidden="true">
                  {!lastRow && <span className="absolute bottom-0 top-3 w-px bg-gray-200" />}
                  <span className={`relative mt-1 size-3 rounded-full border-2 ${RINGS[event.kind]}`} />
                </div>
                <div className={`min-w-0 grow text-sm ${lastRow ? "" : "pb-4"}`}>
                  <p className="flex min-w-0 gap-1 text-gray-600">
                    {to ? (
                      <Link to={to} title={event.subject} className="truncate font-medium text-violet-500 hover:text-violet-600">
                        {event.subject}
                      </Link>
                    ) : (
                      <span title={event.subject} className="truncate font-medium text-gray-800">
                        {event.subject}
                      </span>
                    )}
                    <span className="shrink-0 whitespace-nowrap">{told(event)}</span>
                  </p>
                  <p className="truncate text-xs text-gray-400">
                    {[event.storeDomain ? storeInfo(event.storeDomain).name : "", event.note ?? ""].filter((part) => part !== "").join(", ")}
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      )}
      {events.length > FIRST && (
        <footer className="border-t border-gray-100 px-5 py-3 text-right">
          <button
            type="button"
            onClick={() => setAll((value) => !value)}
            aria-expanded={all}
            className="rounded text-sm font-medium text-violet-500 outline-none hover:text-violet-600 focus-visible:ring-2 focus-visible:ring-violet-500"
          >
            {all ? "Show fewer" : `Show more (${events.length - FIRST})`}
          </button>
        </footer>
      )}
    </section>
  );
}

export function ActivitySkeleton() {
  return (
    <div className={`col-span-full xl:col-span-5 ${cardClass}`} aria-hidden="true">
      <div className="border-b border-gray-100 px-5 py-4">
        <div className="h-6 w-24 animate-pulse rounded bg-gray-100" />
      </div>
      <div className="space-y-5 p-5">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="flex animate-pulse gap-3" style={{ animationDelay: `${i * 80}ms` }}>
            <div className="h-3 w-10 rounded bg-gray-100" />
            <div className="size-3 rounded-full bg-gray-100" />
            <div className="grow space-y-2">
              <div className="h-3.5 w-4/5 rounded bg-gray-100" />
              <div className="h-3 w-1/3 rounded bg-gray-100" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
