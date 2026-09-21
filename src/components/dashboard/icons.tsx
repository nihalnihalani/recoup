import type { ReactNode } from "react";

export type IconName =
  | "eye"
  | "bell"
  | "wallet"
  | "down"
  | "up"
  | "plus"
  | "mail"
  | "flag"
  | "send"
  | "reply"
  | "clock"
  | "card"
  | "alert"
  | "bag"
  | "tag"
  | "filter"
  | "chevron"
  | "dots"
  | "search"
  | "sort"
  | "sortUp"
  | "sortDown";

const PATHS: Record<IconName, ReactNode> = {
  eye: (
    <>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="2.75" />
    </>
  ),
  bell: (
    <>
      <path d="M6 9.5a6 6 0 0 1 12 0c0 5.5 2 7 2 7H4s2-1.5 2-7Z" />
      <path d="M10 19.5a2.2 2.2 0 0 0 4 0" />
    </>
  ),
  wallet: (
    <>
      <path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H17a1 1 0 0 1 1 1v2" />
      <path d="M4 7.5V17a2 2 0 0 0 2 2h12.5a1.5 1.5 0 0 0 1.5-1.5v-8A1.5 1.5 0 0 0 18.500 8H5a1 1 0 0 1-1-.5Z" />
      <path d="M16.25 13.5h.01" />
    </>
  ),
  down: (
    <>
      <path d="m3 7 6.5 6.5 4-4L21 17" />
      <path d="M15.5 17H21v-5.5" />
    </>
  ),
  up: (
    <>
      <path d="m3 17 6.5-6.500 4 4L21 7" />
      <path d="M15.5 7H21v5.5" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  mail: (
    <>
      <rect x="3" y="5.500" width="18" height="13" rx="2" />
      <path d="m3.500 7.500 8.500 6 8.500-6" />
    </>
  ),
  flag: (
    <>
      <path d="M5 21V4" />
      <path d="M5 4.500h12.500l-2.500 4 2.500 4H5" />
    </>
  ),
  send: (
    <>
      <path d="M20.500 3.500 10 14" />
      <path d="m20.500 3.500-6.500 17-4-6.500-6.500-4 17-6.500Z" />
    </>
  ),
  reply: (
    <>
      <path d="M9.500 7 4 12l5.500 5" />
      <path d="M4 12h10a6 6 0 0 1 6 6v.500" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.500" />
      <path d="M12 7.500V12l3 2" />
    </>
  ),
  card: (
    <>
      <rect x="3" y="5.500" width="18" height="13" rx="2" />
      <path d="M3 10h18M7 15h3" />
    </>
  ),
  alert: (
    <>
      <path d="M12 4 2.750 19.500h18.500L12 4Z" />
      <path d="M12 10v4.500M12 17h.01" />
    </>
  ),
  bag: (
    <>
      <path d="M5.500 8h13l1 12h-15l1-12Z" />
      <path d="M9 8V7a3 3 0 0 1 6 0v1" />
    </>
  ),
  tag: (
    <>
      <path d="M3.500 12.500V4.500a1 1 0 0 1 1-1h8l8 8a1.400 1.400 0 0 1 0 2l-7 7a1.400 1.400 0 0 1-2 0l-8-8Z" />
      <path d="M8 8h.01" />
    </>
  ),
  filter: <path d="M4 6h16M7 12h10M10 18h4" />,
  chevron: <path d="m6 9 6 6 6-6" />,
  dots: <path d="M5.500 12h.01M12 12h.01M18.500 12h.01" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6.500" />
      <path d="m16 16 4.500 4.500" />
    </>
  ),
  sort: <path d="m8 9.500 4-4 4 4M8 14.500l4 4 4-4" />,
  sortUp: <path d="m7 14 5-5 5 5" />,
  sortDown: <path d="m7 10 5 5 5-5" />,
};

/** A 1.5px line icon drawn in the current text colour. Always decorative: label the control, not the icon. */
export function Icon({ name, className = "size-4" }: { name: IconName; className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={name === "dots" ? 2.5 : 1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 ${className}`}
    >
      {PATHS[name]}
    </svg>
  );
}
