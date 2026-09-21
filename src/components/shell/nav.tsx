import type { ReactNode } from "react";
import { AddPurchaseIcon, ClaimIcon, DashboardIcon, PurchaseIcon, WatchlistIcon } from "./icons";

export type NavItem = {
  to: string;
  /** Match the path exactly (the dashboard would otherwise be active everywhere). */
  end: boolean;
  label: string;
  icon: ReactNode;
};

/**
 * Every entry is a real route in App.tsx. "Inbox & settings" lives on the same page as
 * "Add purchase" (/settings), so it is one item rather than two links to one place.
 */
export const NAV: readonly NavItem[] = [
  { to: "/", end: true, label: "Dashboard", icon: <DashboardIcon /> },
  { to: "/watching", end: false, label: "Watchlist", icon: <WatchlistIcon /> },
  { to: "/settings", end: false, label: "Add purchase", icon: <AddPurchaseIcon /> },
];

/** The breadcrumb's page name and glyph for a pathname. */
export function pageFor(pathname: string): { label: string; icon: ReactNode } {
  if (pathname.startsWith("/purchases/")) return { label: "Purchase", icon: <PurchaseIcon className="size-4" /> };
  if (pathname.startsWith("/claims/")) return { label: "Claim", icon: <ClaimIcon className="size-4" /> };
  if (pathname.startsWith("/watching")) return { label: "Watchlist", icon: <WatchlistIcon className="size-4" /> };
  if (pathname.startsWith("/settings")) return { label: "Add purchase", icon: <AddPurchaseIcon className="size-4" /> };
  return { label: "Dashboard", icon: <DashboardIcon className="size-4" /> };
}

/** The square bordered 40px button used across the top bar (search, theme, bell, menu). */
export const frameButtonClass =
  "relative flex size-10 shrink-0 items-center justify-center rounded-xl border border-gray-200 bg-white text-gray-600 outline-none transition hover:bg-gray-50 hover:text-gray-900 focus-visible:ring-2 focus-visible:ring-violet-500";
