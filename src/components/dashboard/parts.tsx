import { Link } from "react-router-dom";
import { StatusPill } from "../StatusPill";
import type { VerdictTone } from "../../lib/priceStats";
import { itemVerdict, type Item } from "./model";

/** The dashboard's card: white, hairline border, generous radius, no shadow. */
export const panelClass = "rounded-2xl border border-gray-200 bg-white";
export const panelTitleClass = "text-base font-semibold text-gray-900";
export const focusRing = "outline-none focus-visible:ring-2 focus-visible:ring-gray-900/30 focus-visible:ring-offset-2 focus-visible:ring-offset-white";

/** A bordered, quiet control: the "View all", "Filter" and select-like buttons. */
export const controlClass = `inline-flex items-center gap-2 rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 motion-reduce:transition-none ${focusRing}`;

export function Bone({ className }: { className: string }) {
  return <div className={`animate-pulse rounded-md bg-gray-100 motion-reduce:animate-none ${className}`} />;
}

export function ExampleChip() {
  return <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500">Example</span>;
}

/**
 * Marks a section as a sampled window rather than the account's full history
 * (D72: a truncated page is labelled, never presented as a total). `windowNote`
 * is the server's description of exactly what was sampled, shown as a tooltip.
 *
 * F-T19-1: was `text-gray-500` on `bg-gray-100`, 4.39:1 (fails the 4.5:1 AA
 * minimum for normal text). `text-gray-600` on the same `bg-gray-100`
 * measures 6.87:1 (ratios from the Tailwind v4 oklch theme tokens: gray-100
 * oklch(96.7% 0.003 264.542) -> #f3f4f6, gray-600 oklch(44.6% 0.03 256.802)
 * -> #4a5565, converted to linear sRGB then WCAG relative luminance, same
 * method as T24a's D114 fixes).
 */
export function RecentNote({ windowNote }: { windowNote: string }) {
  return (
    <span className="shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600" title={windowNote}>
      Recent
    </span>
  );
}

/**
 * A muted, text-based flag for a price that may not be current (F-T24b-2):
 * `insights.trackedTable`'s `priceStale` is true when the row's primary-store
 * price is missing or older than `STALE_PRICE_MS`, in which case it is
 * excluded from `lowestCents`/`lowestDomain` -- this badge is what lets a
 * viewer know a fresher number was preferred (or none was available) instead
 * of silently disagreeing with what the store itself currently shows. The
 * word "Stale" carries the meaning without colour; `aria-label` gives screen
 * readers the fuller sentence in place of the terse visible text.
 * bg-gray-100/text-gray-600 reuses `RecentNote`'s pill (6.87:1, see above)
 * rather than the app's `yellow-500/20` + `yellow-700` chip tone, which
 * measures only 4.32:1 against its own tinted background and would fail AA.
 */
export function StaleBadge() {
  return (
    <span
      className="inline-flex shrink-0 items-center rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600"
      aria-label="Primary store price may be missing or out of date"
      title="Primary store price may be missing or out of date"
    >
      Stale
    </span>
  );
}

/**
 * A price's move in percent: "▼ 4.2%" green when it fell, "▲" red when it rose, a
 * muted dash when unknown or flat. The arrow carries direction, not the colour.
 */
export function PctChange({ pct, versus = "the first price read" }: { pct: number | null | undefined; versus?: string }) {
  if (pct === null || pct === undefined || !Number.isFinite(pct) || Math.abs(pct) < 0.05) {
    return (
      <span className="text-xs font-medium text-gray-400" aria-label={pct === null || pct === undefined ? "No change known yet" : `Same as ${versus}`}>
        —
      </span>
    );
  }
  const lower = pct < 0;
  const size = Math.abs(pct);
  const text = `${size >= 10 ? Math.round(size) : size.toFixed(1)}%`;
  return (
    <span
      className={`inline-flex items-center gap-0.5 whitespace-nowrap text-xs font-semibold tabular-nums ${lower ? "text-green-700" : "text-red-700"}`}
      aria-label={`${text} ${lower ? "lower" : "higher"} than ${versus}`}
      title={`vs ${versus}`}
    >
      <span aria-hidden="true" className="text-[0.7em]">
        {lower ? "▼" : "▲"}
      </span>
      <span aria-hidden="true">{text}</span>
    </span>
  );
}

const chipBase = "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium";

const TONES: Record<VerdictTone, string> = {
  green: "bg-green-500/15 text-green-700",
  violet: "bg-violet-500/15 text-violet-700",
  yellow: "bg-yellow-500/20 text-yellow-700",
  gray: "bg-gray-100 text-gray-600",
  red: "bg-red-500/15 text-red-700",
};

/** The claim statuses the claim's own pill already says best: the store has been asked, or money moved. */
const CLAIM_SPEAKS = new Set(["queued", "sent", "packet", "promised", "confirmed", "reopened"]);

/**
 * A bought item shows its claim's status once the store has been asked, and otherwise
 * what its price means: claim now, holding, went up, window closed. A chip with a
 * claim behind it leads straight to that claim.
 */
export function VerdictChip({ item, now }: { item: Item; now: number }) {
  const verdict = itemVerdict(item, now);
  const toClaim = item.claim ? `/claims/${item.claim.claimId}` : undefined;
  const linkClass = `inline-flex rounded-full ${focusRing}`;

  if (item.claim && CLAIM_SPEAKS.has(item.claim.status) && toClaim) {
    return (
      <Link to={toClaim} aria-label={`Claim for ${item.name}`} className={linkClass}>
        <StatusPill status={item.claim.status} />
      </Link>
    );
  }
  if (verdict.kind === "no_price" && !item.productUrl) {
    return <span className={`${chipBase} bg-gray-100 text-gray-600`}>No product link</span>;
  }
  const chip = (
    <span className={`${chipBase} ${TONES[verdict.tone]}`} title={verdict.reason}>
      {verdict.kind === "claim_now" && (
        <span className="relative flex size-1.5" aria-hidden="true">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-green-500 opacity-60 motion-reduce:animate-none" />
          <span className="relative inline-flex size-1.5 rounded-full bg-green-500" />
        </span>
      )}
      {verdict.shortLabel}
    </span>
  );
  return toClaim ? (
    <Link to={toClaim} aria-label={`${verdict.label}: claim for ${item.name}`} className={linkClass}>
      {chip}
    </Link>
  ) : (
    chip
  );
}
