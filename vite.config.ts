import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
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
