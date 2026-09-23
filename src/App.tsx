import { Authenticated, AuthLoading, Unauthenticated } from "convex/react";
import { lazy, Suspense, type ReactNode } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { ConnectionBanner } from "./components/ConnectionBanner";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Shell } from "./components/Shell";
import { Loading } from "./components/States";
import SignIn from "./pages/SignIn";

// Route-level code splitting (P10): each page becomes its own chunk instead
// of all riding in the main bundle, so a visit to /watching never pays for
// /settings. SignIn stays a static import — it's what unauthenticated users
// see immediately, so lazily fetching it buys nothing.
const Board = lazy(() => import("./pages/Board"));
const Add = lazy(() => import("./pages/Add"));
const Transaction = lazy(() => import("./pages/Transaction"));
const Opportunities = lazy(() => import("./pages/Opportunities"));
const Claim = lazy(() => import("./pages/Claim"));
const Purchase = lazy(() => import("./pages/Purchase"));
const Settings = lazy(() => import("./pages/Settings"));
const Watching = lazy(() => import("./pages/Watching"));
// T19: public, unauthenticated-reachable — deliberately outside the
// Authenticated/Unauthenticated gate below (its own top-level route, not
// nested under <Shell>), so it renders identically whether or not anyone is
// signed in.
const Privacy = lazy(() => import("./pages/Privacy"));

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
      <Suspense fallback={<Loading rows={4} />}>{children}</Suspense>
    </ErrorBoundary>
  );
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
