import { Authenticated, AuthLoading, Unauthenticated } from "convex/react";
import { Suspense, useState, type ReactNode } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { ConnectionBanner } from "./components/ConnectionBanner";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Shell } from "./components/Shell";
import { Loading } from "./components/States";
import { lazyWithRetry, resetFailedChunks } from "./lib/lazyWithRetry";
import SignIn from "./pages/SignIn";

// Route-level code splitting (P10): each page becomes its own chunk instead
// of all riding in the main bundle, so a visit to /watching never pays for
// /settings. SignIn stays a static import — it's what unauthenticated users
// see immediately, so lazily fetching it buys nothing. P10-MW-1: `lazyWithRetry`, so a chunk that failed once
// (offline, or a release that removed old assets) loads again on "Try again" or on navigating back.
const Board = lazyWithRetry(() => import("./pages/Board"));
const Add = lazyWithRetry(() => import("./pages/Add"));
const Transaction = lazyWithRetry(() => import("./pages/Transaction"));
const Opportunities = lazyWithRetry(() => import("./pages/Opportunities"));
const Claim = lazyWithRetry(() => import("./pages/Claim"));
const Purchase = lazyWithRetry(() => import("./pages/Purchase"));
const Settings = lazyWithRetry(() => import("./pages/Settings"));
const Watching = lazyWithRetry(() => import("./pages/Watching"));
// T19: public, unauthenticated-reachable — deliberately outside the
// Authenticated/Unauthenticated gate below (its own top-level route, not
// nested under <Shell>), so it renders identically whether or not anyone is
// signed in.
const Privacy = lazyWithRetry(() => import("./pages/Privacy"));

/**
 * Wraps one route's page in its own error boundary and suspense fallback.
 * Keyed by the full pathname so navigating to a different id (e.g. one
 * `/purchases/:id` to another) remounts a fresh boundary instead of staying
 * stuck on a previous error.
 */
function RoutedPage({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  return (
    <ErrorBoundary key={pathname}>
      <FreshChunks />
      <Suspense fallback={<Loading rows={4} />}>{children}</Suspense>
    </ErrorBoundary>
  );
}

/**
 * P10-MW-1: arriving at a route (the boundary above is keyed by path, so this mounts once per visit) gives any chunk
 * that failed earlier a fresh import. Runs once per mount, never during a failing render.
 */
function FreshChunks() {
  useState(resetFailedChunks);
  return null;
}

export default function App() {
  return (
    <Routes>
      <Route
        path="/privacy"
        element={
          <RoutedPage>
            <Privacy />
          </RoutedPage>
        }
      />
      <Route path="/*" element={<AuthGate />} />
    </Routes>
  );
}

/**
 * Everything that depends on sign-in state, unchanged in behaviour from
 * before T19 — just extracted so `/privacy` (public) can sit beside it as a
 * sibling route instead of inside the auth gate. Do not revert the
 * `<AuthLoading>` splash's contrast fix (F-T20-1/T24a).
 */
function AuthGate() {
  return (
    <>
      <AuthLoading>
        {/* F-T20-1: text-ink/50 on bg-paper measured 3.4:1 (WCAG AA needs 4.5:1);
            text-ink/70 (#111827 at 70% over #ffffff, effectively #585d68)
            measures 6.60:1. */}
        <div className="flex min-h-screen items-center justify-center bg-paper text-sm text-ink/70">
          Loading…
        </div>
      </AuthLoading>

      <Unauthenticated>
        <SignIn />
      </Unauthenticated>

      <Authenticated>
        <ConnectionBanner />
        <Routes>
          <Route element={<Shell />}>
            <Route
              path="/"
              element={
                <RoutedPage>
                  <Board />
                </RoutedPage>
              }
            />
            <Route
              path="/purchases/:id"
              element={
                <RoutedPage>
                  <Purchase />
                </RoutedPage>
              }
            />
            <Route
              path="/claims/:id"
              element={
                <RoutedPage>
                  <Claim />
                </RoutedPage>
              }
            />
            <Route
              path="/add"
              element={
                <RoutedPage>
                  <Add />
                </RoutedPage>
              }
            />
            <Route
              path="/transactions/:id"
              element={
                <RoutedPage>
                  <Transaction />
                </RoutedPage>
              }
            />
            <Route
              path="/opportunities"
              element={
                <RoutedPage>
                  <Opportunities />
                </RoutedPage>
              }
            />
            <Route
              path="/watching"
              element={
                <RoutedPage>
                  <Watching />
                </RoutedPage>
              }
            />
            <Route
              path="/settings"
              element={
                <RoutedPage>
                  <Settings />
                </RoutedPage>
              }
            />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </Authenticated>
    </>
  );
}
