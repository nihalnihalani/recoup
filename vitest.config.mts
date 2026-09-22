import { defineConfig } from "vitest/config";

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
  },
});
