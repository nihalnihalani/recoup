import React from "react";
import ReactDOM from "react-dom/client";
import { ConvexReactClient } from "convex/react";
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { ConfigMissing } from "./components/ConfigMissing";
import "./index.css";
import { reloadOnceForChunkError } from "./lib/lazyWithRetry";

// P10-MW-1: a module preload that fails (usually a release removed the old assets) gets one guarded full reload,
// which fetches the new build; `preventDefault` stops Vite rethrowing it. Offline, or after one reload, the route's
// error boundary shows "Try again" and "Reload the page" instead.
window.addEventListener("vite:preloadError", (event) => {
  if (reloadOnceForChunkError()) event.preventDefault();
});

const convexUrl = import.meta.env.VITE_CONVEX_URL;

function isValidConvexUrl(url: unknown): url is string {
  return typeof url === "string" && /^https:\/\//.test(url);
}

const root = ReactDOM.createRoot(document.getElementById("root")!);

if (!isValidConvexUrl(convexUrl)) {
  root.render(
    <React.StrictMode>
      <ConfigMissing />
    </React.StrictMode>,
  );
} else {
  const convex = new ConvexReactClient(convexUrl);

  root.render(
    <React.StrictMode>
      <ConvexAuthProvider client={convex}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </ConvexAuthProvider>
    </React.StrictMode>,
  );
}
