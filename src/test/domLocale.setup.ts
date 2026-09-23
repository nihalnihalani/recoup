/**
 * D205: every DOM test file (`// @vitest-environment happy-dom`) runs with the default locale pinned to en-US. UI
 * formatting is locale-aware by design (the viewer's own locale), so a DOM test asserting "$50.00" is asserting the
 * en-US rendering. Installed here, before the test file's own imports, and released after the file, so the pin never
 * reaches a server (edge-runtime) test: those stay unpinned and the `localeshift` CI job keeps catching server code
 * whose output depends on the machine locale.
 */
import { afterAll } from "vitest";
import { installDefaultLocale } from "./locale";

if (typeof document !== "undefined") {
  const release = installDefaultLocale("en-US");
  afterAll(release);
}
