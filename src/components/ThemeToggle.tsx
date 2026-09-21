import type { ReactNode } from "react";
import { useTheme } from "../lib/theme";
import type { Theme } from "../lib/theme";

const NEXT: Record<Theme, Theme> = { light: "dark", dark: "system", system: "light" };

const NAMES: Record<Theme, string> = { light: "Light", dark: "Dark", system: "Match device" };

const GLYPHS: Record<Theme, ReactNode> = {
  light: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4" />
    </>
  ),
  dark: <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />,
  system: (
    <>
      <rect x="3" y="5" width="18" height="12" rx="2" />
      <path d="M9 20h6M12 17v3" />
    </>
  ),
};

/** The header's round icon button; NotificationBell uses the same classes. */
const headerIconButtonClass =
  "relative flex size-8 items-center justify-center rounded-full text-gray-500 outline-none transition hover:bg-white hover:text-gray-700 focus-visible:ring-2 focus-visible:ring-violet-500";

/** Cycles light, dark, match device. The glyph shows the current setting. */
export function ThemeToggle() {
  const [theme, setTheme] = useTheme();
  const label = `Theme: ${NAMES[theme]}. Switch to ${NAMES[NEXT[theme]].toLowerCase()}`;

  return (
    <button type="button" onClick={() => setTheme(NEXT[theme])} aria-label={label} title={label} className={headerIconButtonClass}>
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
        {GLYPHS[theme]}
      </svg>
    </button>
  );
}
