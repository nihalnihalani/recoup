/**
 * Line icons for the claim page: 24 grid, 1.7 stroke, the same hand as the shell set.
 * All decorative; the text beside each one carries the meaning.
 */
export type ClaimGlyph =
  | "check"
  | "clock"
  | "cross"
  | "question"
  | "mail"
  | "send"
  | "flag"
  | "note"
  | "card"
  | "repeat"
  | "pen"
  | "window"
  | "ledger"
  | "story"
  | "chart"
  | "copy"
  | "alert"
  | "plus";

const PATHS: Record<ClaimGlyph, string[]> = {
  check: ["M5 12.5l4.5 4.5L19 7.5"],
  clock: ["M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z", "M12 7.5V12l3 2"],
  cross: ["M6.5 6.5l11 11M17.5 6.5l-11 11"],
  question: [
    "M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z",
    "M9.75 9.5a2.25 2.25 0 1 1 3.4 1.95c-.75.45-1.15.95-1.15 1.8",
    "M12 16.4v.1",
  ],
  mail: ["M4 6.5h16v11H4z", "M4.5 7l7.5 6 7.5-6"],
  send: ["M20.5 3.5L10 14", "M20.5 3.5l-6.5 17-4-6.500-6.500-4z"],
  flag: ["M6 20.500v-16", "M6 5h11l-2.500 4 2.500 4H6"],
  note: ["M6 3.500h12v17H6z", "M9.500 8.500h5M9.500 12h5M9.500 15.500h3"],
  card: ["M3.500 6.500h17v11h-17z", "M3.500 10.500h17M7 14.500h3"],
  repeat: ["M4.500 11a7.500 7.500 0 0 1 13-4.500L19.500 8.500", "M19.500 4v4.500H15", "M19.500 13a7.500 7.500 0 0 1-13 4.500L4.500 15.500", "M4.500 20v-4.500H9"],
  pen: ["M4.500 19.500l1-4L16 5l3 3L8.500 18.500z", "M14 7l3 3"],
  window: ["M4 6.500h16v14H4z", "M4 10.500h16M8.500 3.500v5M15.500 3.500v5"],
  ledger: ["M5 20V10M10 20V4.500M15 20v-7M20 20V8"],
  story: ["M7 5.500h13M7 12h13M7 18.500h13", "M3.500 5.500h.01M3.500 12h.01M3.500 18.500h.01"],
  chart: ["M3.500 17l5-5.500 4 3.500 8-9", "M15.500 6h5v5"],
  copy: ["M9 9h10.500v11.500H9z", "M15 9V3.500H4.500V15H9"],
  alert: ["M12 4l9 15.500H3z", "M12 10v4.500M12 17v.1"],
  plus: ["M12 5.500v13M5.500 12h13"],
};

export function ClaimIcon({ glyph, className = "size-5" }: { glyph: ClaimGlyph; className?: string }) {
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
      {PATHS[glyph].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
