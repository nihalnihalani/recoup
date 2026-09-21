import type { ReactNode } from "react";

/** 20px line icon on a 24 grid. All shell glyphs share this stroke so the chrome reads as one set. */
function Glyph({ children, className = "size-5" }: { children: ReactNode; className?: string }) {
  return (
    <svg
      className={`shrink-0 ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

type IconProps = { className?: string };

export function DashboardIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <rect x="3.5" y="3.5" width="7" height="9" rx="2" />
      <rect x="13.5" y="3.5" width="7" height="5" rx="2" />
      <rect x="13.5" y="11.5" width="7" height="9" rx="2" />
      <rect x="3.5" y="15.5" width="7" height="5" rx="2" />
    </Glyph>
  );
}

export function WatchlistIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M2.5 12s3.5-6.5 9.5-6.5S21.500 12 21.500 12s-3.5 6.500-9.500 6.500S2.500 12 2.500 12z" />
      <circle cx="12" cy="12" r="2.75" />
    </Glyph>
  );
}

export function AddPurchaseIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M6 3.500h12v17l-3-1.750-3 1.750-3-1.750-3 1.750z" />
      <path d="M12 8v6M9 11h6" />
    </Glyph>
  );
}

export function PurchaseIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M5 8h14l-1 12H6z" />
      <path d="M9 8V7a3 3 0 0 1 6 0v1" />
    </Glyph>
  );
}

export function ClaimIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M7 3.500h7l4 4V20.500H7z" />
      <path d="M14 3.500v4h4M10 12.500h5M10 16h5" />
    </Glyph>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <circle cx="11" cy="11" r="6.500" />
      <path d="M16 16l4.500 4.500" />
    </Glyph>
  );
}

export function MenuIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </Glyph>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M6 6l12 12M18 6L6 18" />
    </Glyph>
  );
}

/** A panel with its left rail marked: the collapse / expand control. */
export function PanelIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <rect x="3.500" y="4.500" width="17" height="15" rx="3" />
      <path d="M9.500 4.500v15" />
    </Glyph>
  );
}

export function SignOutIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M14 4.500h3a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-3" />
      <path d="M10 8l-4 4 4 4M6 12h9" />
    </Glyph>
  );
}

export function ReturnIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M19 6v5a3 3 0 0 1-3 3H6" />
      <path d="M9.500 10.500L6 14l3.500 3.500" />
    </Glyph>
  );
}
