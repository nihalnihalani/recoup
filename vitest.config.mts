import { defineConfig } from "vitest/config";

// `npm run test:clockshift` sets this (400) to run the whole suite with the
// process clock moved N days ahead (convex/testing/clockShift.setup.ts), so
// a test that only passes on today's date fails now instead of later (D138).
const clockShiftDays = process.env.RECOUP_CLOCK_SHIFT_DAYS;

export default defineConfig({
  test: {
    // Default for every file: the Convex runtime (convex-test needs it).
    // Component tests opt into a DOM per file with a first-line docblock
    // `// @vitest-environment happy-dom` (M08 / QA-13). vitest 4 has no
    // `environmentMatchGlobs`, and a per-file docblock keeps every existing
    // edge-runtime test exactly where it was. A `*.test.tsx` without the
    // docblock fails loudly (`document is not defined`), and
    // `convex/testing/testCollection.test.ts` names the offending file (it
    // also fails on any test-like file these globs would not collect).
    environment: "edge-runtime",
    server: { deps: { inline: ["convex-test"] } },
    include: ["convex/**/*.test.ts", "src/**/*.test.ts", "src/**/*.test.tsx"],
    // D205: DOM test files run with the default locale pinned to en-US (src/test/domLocale.setup.ts, a no-op in
    // the edge-runtime server tests, which stay unpinned for the `localeshift` CI job).
    setupFiles: [...(clockShiftDays ? ["./convex/testing/clockShift.setup.ts"] : []), "./src/test/domLocale.setup.ts", "./convex/testing/kx3Guard.setup.ts"],
  },
});
