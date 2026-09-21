import { useCallback, useSyncExternalStore } from "react";

export type Theme = "light" | "dark" | "system";

const STORAGE_KEY = "recoup-theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

function isTheme(value: unknown): value is Theme {
  return value === "light" || value === "dark" || value === "system";
}

/** The saved preference, or "system" when nothing usable is stored. */
export function getStoredTheme(): Theme {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return isTheme(stored) ? stored : "system";
  } catch {
    return "system";
  }
}

function systemPrefersDark(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(DARK_QUERY).matches;
}

/** What a preference resolves to on this device right now. */
export function resolveTheme(theme: Theme): "light" | "dark" {
  if (theme === "system") return systemPrefersDark() ? "dark" : "light";
  return theme;
}

let current: Theme = typeof window === "undefined" ? "system" : getStoredTheme();
const listeners = new Set<() => void>();
let watching = false;

/** Follow the OS while the preference is "system", and other tabs' changes always. */
function watchEnvironment() {
  if (watching || typeof window === "undefined") return;
  watching = true;
  if (typeof window.matchMedia === "function") {
    window.matchMedia(DARK_QUERY).addEventListener("change", () => {
      if (current === "system") applyTheme("system");
    });
  }
  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEY) return;
    applyTheme(isTheme(event.newValue) ? event.newValue : "system");
  });
}

/** Puts the theme on <html> (the `.dark` class drives every colour variable). Does not persist. */
export function applyTheme(theme: Theme): void {
  current = theme;
  document.documentElement.classList.toggle("dark", resolveTheme(theme) === "dark");
  watchEnvironment();
  for (const notify of listeners) notify();
}

function persist(theme: Theme) {
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Storage blocked: the choice still holds for this page view.
  }
}

function subscribe(notify: () => void) {
  listeners.add(notify);
  watchEnvironment();
  return () => {
    listeners.delete(notify);
  };
}

/** `[theme, setTheme]`, shared by every caller and saved under "recoup-theme". */
export function useTheme(): [Theme, (theme: Theme) => void] {
  const theme = useSyncExternalStore(
    subscribe,
    () => current,
    () => "system" as Theme,
  );
  const setTheme = useCallback((next: Theme) => {
    persist(next);
    applyTheme(next);
  }, []);
  return [theme, setTheme];
}
