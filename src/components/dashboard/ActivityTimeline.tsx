import { useState } from "react";
import { Link } from "react-router-dom";
import { fmt } from "../Money";
import { cardClass, cardTitleClass, when } from "../../lib/ui";
import { storeInfo } from "../../lib/stores";
import { Icon, type IconName } from "./icons";
import type { ActivityEvent } from "./model";
import { Bone, controlClass, focusRing } from "./parts";

const FIRST = 5;

type Kind = ActivityEvent["kind"];
type Tone = "good" | "bad" | "info" | "promised" | "quiet";

const TONES: Record<Tone, string> = {
  good: "bg-green-500/15 text-green-700",
  bad: "bg-red-500/15 text-red-700",
  info: "bg-sky-500/15 text-sky-700",
  promised: "bg-yellow-500/20 text-yellow-700",
  quiet: "bg-gray-100 text-gray-500",
};

const KINDS: Record<Kind, { title: string; icon: IconName; tone: Tone }> = {
  price_drop: { title: "Price dropped", icon: "down", tone: "good" },
  price_rise: { title: "Price rose", icon: "up", tone: "bad" },
  price_seen: { title: "First price read", icon: "tag", tone: "info" },
  price_unreadable: { title: "Couldn't read the page", icon: "alert", tone: "quiet" },
  watch_added: { title: "Added to watchlist", icon: "eye", tone: "info" },
  purchase_added: { title: "Purchase added", icon: "bag", tone: "info" },
  alert_sent: { title: "Alert emailed", icon: "mail", tone: "info" },
  claim_opened: { title: "Claim opened", icon: "flag", tone: "info" },
  ask_sent: { title: "Asked the store", icon: "send", tone: "info" },
  reply_received: { title: "Store replied", icon: "reply", tone: "info" },
  credit_promised: { title: "Credit promised", icon: "clock", tone: "promised" },
  credit_confirmed: { title: "Back on card", icon: "card", tone: "good" },
  charged_again: { title: "Charged again", icon: "alert", tone: "bad" },
};

/** The product, the amounts that moved, and the store: one muted line. */
function detail(event: ActivityEvent): string {
  const currency = event.currency ?? "USD";
  const money = event.cents === undefined ? undefined : fmt(event.cents, currency);
  const delta = event.deltaCents === undefined ? undefined : fmt(Math.abs(event.deltaCents), currency);
  let amounts: string | undefined;
  switch (event.kind) {
    case "price_drop":
      amounts = [delta ? `down ${delta}` : undefined, money ? `to ${money}` : undefined].filter(Boolean).join(" ");
      break;
    case "price_rise":
      amounts = [delta ? `up ${delta}` : undefined, money ? `to ${money}` : undefined].filter(Boolean).join(" ");
      break;
    case "price_seen":
      amounts = money ? `at ${money}` : undefined;
      break;
    case "claim_opened":
      amounts = money ? `for ${money}` : undefined;
      break;
    case "credit_promised":
    case "credit_confirmed":
    case "charged_again":
      amounts = money;
      break;
    default:
      amounts = undefined;
  }
  const store = event.storeDomain ? storeInfo(event.storeDomain).name : undefined;
  // A purchase is named after its store, so the store is not said twice.
  return [[event.subject, amounts].filter(Boolean).join(" "), store === event.subject ? undefined : store, event.note].filter(Boolean).join(", ");
}

function target(event: ActivityEvent): string | undefined {
  if (event.claimId) return `/claims/${event.claimId}`;
  if (event.purchaseId) return `/purchases/${event.purchaseId}`;
  if (event.watchId) return "/watching";
  return undefined;
}

export function ActivityTimeline({ events }: { events: ActivityEvent[] }) {
  const [all, setAll] = useState(false);
  // Rows present at first paint stay still; only what arrives afterwards slides in.
  const [initial] = useState(() => new Set(events.map((event) => event.id)));
  const shown = all ? events : events.slice(0, FIRST);

  return (
    <section className={`${cardClass} flex flex-col p-5`} aria-labelledby="activity-title">
      <header className="flex items-center justify-between gap-3">
        <h2 id="activity-title" className={cardTitleClass}>
          Recent Activity
        </h2>
        {events.length > FIRST && (
          <button type="button" onClick={() => setAll((value) => !value)} aria-expanded={all} aria-controls="activity-list" className={controlClass}>
            {all ? "Show fewer" : "View all"}
          </button>
        )}
      </header>

      {events.length === 0 ? (
        <p className="my-auto py-10 text-center text-sm text-gray-500">Price checks, drops and store replies show up here as they happen.</p>
      ) : (
        <ol
          id="activity-list"
          className={`mt-5 ${all ? "-mr-2 max-h-[34rem] overflow-y-auto pr-2" : ""}`}
          aria-live="polite"
          aria-relevant="additions"
        >
          {shown.map((event, i) => {
            const kind = KINDS[event.kind];
            const to = target(event);
            const lastRow = i === shown.length - 1;
            const body = (
              <>
                <p className="text-sm font-semibold text-gray-900">{kind.title}</p>
                <p className="mt-0.5 text-xs tabular-nums text-gray-400">
                  <time dateTime={new Date(event.at).toISOString()}>{when(event.at)}</time>
                </p>
                <p className="mt-1 line-clamp-2 text-sm text-gray-500">{detail(event)}</p>
              </>
            );
            return (
              <li key={event.id} className={`relative flex gap-3 ${initial.has(event.id) ? "" : "feed-in"}`}>
                {!lastRow && <span aria-hidden="true" className="absolute bottom-0 left-[17.5px] top-10 w-px bg-gray-200" />}
                <span className={`flex size-9 shrink-0 items-center justify-center rounded-full ${TONES[kind.tone]}`}>
                  <Icon name={kind.icon} className="size-[18px]" />
                </span>
                {to ? (
                  <Link
                    to={to}
                    className={`-mx-1.5 -mt-1 min-w-0 grow rounded-lg px-1.5 pt-1 transition-colors hover:bg-gray-50 motion-reduce:transition-none ${focusRing} ${
                      lastRow ? "pb-1" : "mb-3 pb-2"
                    }`}
                  >
                    {body}
                  </Link>
                ) : (
                  <div className={`min-w-0 grow ${lastRow ? "" : "pb-5"}`}>{body}</div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

export function ActivitySkeleton() {
  return (
    <div className={`${cardClass} p-5`} aria-hidden="true">
      <div className="flex items-center justify-between">
        <Bone className="h-5 w-32" />
        <Bone className="h-9 w-20 rounded-xl" />
      </div>
      <div className="mt-5 space-y-5">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="flex gap-3">
            <Bone className="size-9 rounded-full" />
            <div className="grow space-y-2">
              <Bone className="h-4 w-1/2" />
              <Bone className="h-3 w-2/5" />
              <Bone className="h-3.5 w-4/5" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
