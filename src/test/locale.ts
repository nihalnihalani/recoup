/**
 * Pins the DEFAULT locale for one test file (M16; the locale twin of D138's clock time-bomb).
 *
 * The app formats money and dates in the viewer's own locale (`Intl.NumberFormat(undefined, …)`,
 * `toLocaleString()`), which is right for users and wrong for tests that assert a literal like "$50.00": on a
 * machine whose locale is not en-US (a teammate's laptop, a CI image with `LANG=de_DE.UTF-8`) those tests fail
 * although nothing changed. Call `pinDefaultLocale("en-US")` at the top of such a file: every formatter created with
 * no explicit locale uses the pinned one for the duration of the file; an explicit locale is left alone. Restored
 * after the file.
 */
import { afterAll, beforeAll } from "vitest";

type Locales = string | readonly string[] | undefined;

export function pinDefaultLocale(locale: string): void {
  const RealNumberFormat = Intl.NumberFormat;
  const RealDateTimeFormat = Intl.DateTimeFormat;
  const realNumberToLocale = Number.prototype.toLocaleString;
  const realDateToLocale = Date.prototype.toLocaleString;
  const realDateToLocaleDate = Date.prototype.toLocaleDateString;
  const realDateToLocaleTime = Date.prototype.toLocaleTimeString;
  const pick = (locales: Locales) => (locales === undefined ? locale : (locales as string | string[]));

  beforeAll(() => {
    class PinnedNumberFormat extends RealNumberFormat {
      constructor(locales?: Locales, options?: Intl.NumberFormatOptions) {
        super(pick(locales), options);
      }
    }
    class PinnedDateTimeFormat extends RealDateTimeFormat {
      constructor(locales?: Locales, options?: Intl.DateTimeFormatOptions) {
        super(pick(locales), options);
      }
    }
    Intl.NumberFormat = PinnedNumberFormat as typeof Intl.NumberFormat;
    Intl.DateTimeFormat = PinnedDateTimeFormat as typeof Intl.DateTimeFormat;
    Number.prototype.toLocaleString = function (this: number, locales?: Locales, options?: Intl.NumberFormatOptions) {
      return realNumberToLocale.call(this, pick(locales), options);
    };
    Date.prototype.toLocaleString = function (this: Date, locales?: Locales, options?: Intl.DateTimeFormatOptions) {
      return realDateToLocale.call(this, pick(locales), options);
    };
    Date.prototype.toLocaleDateString = function (this: Date, locales?: Locales, options?: Intl.DateTimeFormatOptions) {
      return realDateToLocaleDate.call(this, pick(locales), options);
    };
    Date.prototype.toLocaleTimeString = function (this: Date, locales?: Locales, options?: Intl.DateTimeFormatOptions) {
      return realDateToLocaleTime.call(this, pick(locales), options);
    };
  });

  afterAll(() => {
    Intl.NumberFormat = RealNumberFormat;
    Intl.DateTimeFormat = RealDateTimeFormat;
    Number.prototype.toLocaleString = realNumberToLocale;
    Date.prototype.toLocaleString = realDateToLocale;
    Date.prototype.toLocaleDateString = realDateToLocaleDate;
    Date.prototype.toLocaleTimeString = realDateToLocaleTime;
  });
}
