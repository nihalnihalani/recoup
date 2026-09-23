/**
 * Pins the DEFAULT locale for tests (M16; the locale twin of D138's clock time-bomb).
 *
 * The app formats money and dates in the viewer's own locale (`Intl.NumberFormat(undefined, …)`,
 * `toLocaleString()`), which is right for users and wrong for tests that assert a literal like "$50.00": on a
 * machine whose locale is not en-US (a teammate's laptop, a CI image with `LANG=de_DE.UTF-8`) those tests fail
 * although nothing changed. While pinned, every formatter created with no explicit locale uses the pinned one; an
 * explicit locale is left alone.
 *
 * - `pinDefaultLocale("en-US")` at the top of a test file pins it for that file (installed in `beforeAll`).
 * - `domLocale.setup.ts` (D205) pins en-US for every DOM test file (`// @vitest-environment happy-dom`): UI formatting
 *   is locale-aware by design. Server tests stay unpinned, so the `localeshift` CI job still catches server code
 *   (draft and email amounts) that depends on the machine locale.
 *
 * The pin is reference-counted on `globalThis`: a file pinned by both the setup file and its own `pinDefaultLocale`
 * gets the real formatters back only when the LAST pin is released, whatever order the two `afterAll` hooks run in,
 * so a pin can never leak into the next file a worker runs.
 */
import { afterAll, beforeAll } from "vitest";

type Locales = string | readonly string[] | undefined;

type Originals = {
  NumberFormat: typeof Intl.NumberFormat;
  DateTimeFormat: typeof Intl.DateTimeFormat;
  numberToLocale: typeof Number.prototype.toLocaleString;
  dateToLocale: typeof Date.prototype.toLocaleString;
  dateToLocaleDate: typeof Date.prototype.toLocaleDateString;
  dateToLocaleTime: typeof Date.prototype.toLocaleTimeString;
};

type PinState = { locale: string; count: number; originals: Originals };

const STATE_KEY = Symbol.for("recoup.test.defaultLocalePin");

function state(): PinState | undefined {
  return (globalThis as Record<symbol, PinState | undefined>)[STATE_KEY];
}

function setState(next: PinState | undefined): void {
  (globalThis as Record<symbol, PinState | undefined>)[STATE_KEY] = next;
}

/** Pins the default locale NOW and returns the release function (call it exactly once). */
export function installDefaultLocale(locale: string): () => void {
  const current = state();
  if (current) {
    if (current.locale !== locale) throw new Error(`default locale already pinned to ${current.locale}, not ${locale}`);
    current.count += 1;
  } else {
    const originals: Originals = {
      NumberFormat: Intl.NumberFormat,
      DateTimeFormat: Intl.DateTimeFormat,
      numberToLocale: Number.prototype.toLocaleString,
      dateToLocale: Date.prototype.toLocaleString,
      dateToLocaleDate: Date.prototype.toLocaleDateString,
      dateToLocaleTime: Date.prototype.toLocaleTimeString,
    };
    const pick = (locales: Locales) => (locales === undefined ? locale : (locales as string | string[]));
    class PinnedNumberFormat extends originals.NumberFormat {
      constructor(locales?: Locales, options?: Intl.NumberFormatOptions) {
        super(pick(locales), options);
      }
    }
    class PinnedDateTimeFormat extends originals.DateTimeFormat {
      constructor(locales?: Locales, options?: Intl.DateTimeFormatOptions) {
        super(pick(locales), options);
      }
    }
    Intl.NumberFormat = PinnedNumberFormat as typeof Intl.NumberFormat;
    Intl.DateTimeFormat = PinnedDateTimeFormat as typeof Intl.DateTimeFormat;
    Number.prototype.toLocaleString = function (this: number, locales?: Locales, options?: Intl.NumberFormatOptions) {
      return originals.numberToLocale.call(this, pick(locales), options);
    };
    Date.prototype.toLocaleString = function (this: Date, locales?: Locales, options?: Intl.DateTimeFormatOptions) {
      return originals.dateToLocale.call(this, pick(locales), options);
    };
    Date.prototype.toLocaleDateString = function (this: Date, locales?: Locales, options?: Intl.DateTimeFormatOptions) {
      return originals.dateToLocaleDate.call(this, pick(locales), options);
    };
    Date.prototype.toLocaleTimeString = function (this: Date, locales?: Locales, options?: Intl.DateTimeFormatOptions) {
      return originals.dateToLocaleTime.call(this, pick(locales), options);
    };
    setState({ locale, count: 1, originals });
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const pin = state();
    if (!pin) return;
    pin.count -= 1;
    if (pin.count > 0) return;
    const o = pin.originals;
    Intl.NumberFormat = o.NumberFormat;
    Intl.DateTimeFormat = o.DateTimeFormat;
    Number.prototype.toLocaleString = o.numberToLocale;
    Date.prototype.toLocaleString = o.dateToLocale;
    Date.prototype.toLocaleDateString = o.dateToLocaleDate;
    Date.prototype.toLocaleTimeString = o.dateToLocaleTime;
    setState(undefined);
  };
}

/** Pins the default locale for the calling test file: installed before its tests, released after them. */
export function pinDefaultLocale(locale: string): void {
  let release: (() => void) | undefined;
  beforeAll(() => {
    release = installDefaultLocale(locale);
  });
  afterAll(() => {
    release?.();
  });
}
