import { createHash } from "node:crypto";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
// P12-W6 (F6, fe2 review): the env-override and no-git fallback logic lives in scripts/buildId.mjs, tested on its
// own in scripts/buildId.test.ts, without going through a real Vite build.
import { buildId } from "./scripts/buildId.mjs";

/**
 * P12-W6: stamps the build id into `index.html` (`<meta name="recoup-build">`) and writes the dist summary,
 * `build-info.json`: the id, when it was built, and every emitted file with its size and SHA-256, so a served page
 * and a deploy can be matched to one build.
 */
function recoupBuildInfo(id: string): Plugin {
  return {
    name: "recoup-build-info",
    // After Vite's own plugins, so `index.html` is already in the bundle the summary lists.
    enforce: "post",
    transformIndexHtml() {
      return [{ tag: "meta", attrs: { name: "recoup-build", content: id }, injectTo: "head" }];
    },
    generateBundle(_options, bundle) {
      const files = Object.values(bundle)
        .map((output) => {
          const body = output.type === "chunk" ? output.code : output.source;
          const bytes = typeof body === "string" ? Buffer.byteLength(body) : body.byteLength;
          return { file: output.fileName, bytes, sha256: createHash("sha256").update(body).digest("hex") };
        })
        .sort((a, b) => a.file.localeCompare(b.file));
      this.emitFile({
        type: "asset",
        fileName: "build-info.json",
        source: `${JSON.stringify({ buildId: id, builtAt: new Date().toISOString(), files }, null, 2)}\n`,
      });
    },
    closeBundle() {
      this.info?.(`recoup build ${id}`);
    },
  };
}

const BUILD_ID = buildId();

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), recoupBuildInfo(BUILD_ID)],
  define: { __RECOUP_BUILD__: JSON.stringify(BUILD_ID) },
  build: {
    rollupOptions: {
      output: {
        // React/react-dom/react-router change far less often than app code
        // and are shared by every page, so they get their own long-lived
        // vendor chunks; Convex's client is the same story. Route pages are
        // split separately via React.lazy() in src/App.tsx. Note: object-form
        // manualChunks isn't supported on this rolldown-powered vite (8.x) —
        // only the function form is (see node_modules/rolldown's
        // define-config d.ts: "unlike Rollup, object form is not supported").
        manualChunks(id) {
          if (!id.includes("node_modules")) return null;
          if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return "vendor-react";
          if (id.includes("node_modules/react-router")) return "vendor-router";
          if (id.includes("node_modules/convex")) return "vendor-convex";
          return null;
        },
      },
    },
  },
});
