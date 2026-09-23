import type { ReactNode } from "react";
import { AddPurchaseIcon, ClaimIcon, DashboardIcon, PurchaseIcon, SettingsIcon, WatchlistIcon } from "./icons";

export type NavItem = {
  to: string;
  /** Match the path exactly (the dashboard would otherwise be active everywhere). */
  end: boolean;
  label: string;
  icon: ReactNode;
};

/**
 * Every entry is a real route in App.tsx. M24: adding things moved to /add (paste, upload, manual entry); /settings
 * is the inbox and account settings, reached from the user card, so it is not repeated here.
 */
export const NAV: readonly NavItem[] = [
  { to: "/", end: true, label: "Dashboard", icon: <DashboardIcon /> },
  { to: "/opportunities", end: false, label: "Recovery paths", icon: <ClaimIcon /> },
  { to: "/watching", end: false, label: "Watchlist", icon: <WatchlistIcon /> },
  { to: "/add", end: false, label: "Add", icon: <AddPurchaseIcon /> },
];

/** The breadcrumb's page name and glyph for a pathname. */
export function pageFor(pathname: string): { label: string; icon: ReactNode } {
  if (pathname.startsWith("/purchases/")) return { label: "Purchase", icon: <PurchaseIcon className="size-4" /> };
  if (pathname.startsWith("/claims/")) return { label: "Claim", icon: <ClaimIcon className="size-4" /> };
  if (pathname.startsWith("/watching")) return { label: "Watchlist", icon: <WatchlistIcon className="size-4" /> };
  if (pathname.startsWith("/transactions/")) return { label: "Transaction", icon: <PurchaseIcon className="size-4" /> };
  if (pathname.startsWith("/opportunities")) return { label: "Recovery paths", icon: <ClaimIcon className="size-4" /> };
  if (pathname.startsWith("/add")) return { label: "Add", icon: <AddPurchaseIcon className="size-4" /> };
  if (pathname.startsWith("/settings")) return { label: "Inbox & settings", icon: <SettingsIcon className="size-4" /> };
  return { label: "Dashboard", icon: <DashboardIcon className="size-4" /> };
}

/** The square bordered 40px button used across the top bar (search, theme, bell, menu). */
export const frameButtonClass =
  "relative flex size-10 shrink-0 items-center justify-center rounded-xl border border-gray-200 bg-white text-gray-600 outline-none transition hover:bg-gray-50 hover:text-gray-900 focus-visible:ring-2 focus-visible:ring-violet-500";
