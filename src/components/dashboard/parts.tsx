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
