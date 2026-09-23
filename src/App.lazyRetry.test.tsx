// @vitest-environment happy-dom
/**
 * P10-MW-1 regression: `React.lazy` caches a rejected import forever, so on origin/main a route chunk that fails
 * once (a moment offline, or a release that cleaned up the old assets) stays broken — the ErrorBoundary's
 * "Try again" re-renders the SAME lazy object and gets the SAME cached rejection back, with no new `import()` call.
 * `lazyWithRetry`/`resetFailedChunks` do not exist on origin/main at all, so this file fails to import there.
 *
 * This test drives the real `ErrorBoundary` (its `reset` calls `resetFailedChunks`) around a `lazyWithRetry`
 * component whose loader rejects once and then resolves, and checks "Try again" recovers it.
 */
import { Suspense, act, useEffect } from "react";
import { MemoryRouter, Outlet, useNavigate } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { lazyWithRetry } from "./lib/lazyWithRetry";
import { fireEvent, render, screen, waitFor } from "./test/dom";

describe("lazyWithRetry through ErrorBoundary (P10-MW-1)", () => {
  it("re-requests the chunk on \"Try again\" instead of replaying the cached rejection", async () => {
    let attempts = 0;
    const LoadedPage = () => <div>Loaded page content</div>;
    const RetryRoute = lazyWithRetry<Record<string, never>>(() => {
      attempts += 1;
      // A plain (non chunk-load-shaped) error so the automatic reload guard never fires in this test —
      // the failure still sets lazyWithRetry's internal `failed` flag and reaches the ErrorBoundary either way.
      if (attempts === 1) return Promise.reject(new Error("boom: import failed"));
      return Promise.resolve({ default: LoadedPage });
    });

    render(
      <MemoryRouter>
        <ErrorBoundary>
          <Suspense fallback={<div>Loading…</div>}>
            <RetryRoute />
          </Suspense>
        </ErrorBoundary>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText(/couldn't load/i)).toBeTruthy());
    expect(attempts).toBe(1);
    expect(screen.queryByText("Loaded page content")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /try again/i }));

    await waitFor(() => expect(screen.getByText("Loaded page content")).toBeTruthy());
    // A fresh import() was actually made on retry — not the same rejected promise replayed.
    expect(attempts).toBe(2);
  });

  it("recovers a failed chunk on a later mount (navigating away and back) without a click", async () => {
    let attempts = 0;
    const LoadedPage = () => <div>Second surface loaded</div>;
    const RetryRoute = lazyWithRetry<Record<string, never>>(() => {
      attempts += 1;
      if (attempts === 1) return Promise.reject(new Error("boom: import failed"));
      return Promise.resolve({ default: LoadedPage });
    });

    const { unmount } = render(
      <MemoryRouter>
        <ErrorBoundary>
          <Suspense fallback={<div>Loading…</div>}>
            <RetryRoute />
          </Suspense>
        </ErrorBoundary>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText(/couldn't load/i)).toBeTruthy());
    expect(attempts).toBe(1);
    unmount();

    // Simulates App.tsx's `FreshChunks` (`useState(resetFailedChunks)`), which fires once per route mount —
    // navigating back to the failed route should not replay the cached rejection either.
    const { resetFailedChunks } = await import("./lib/lazyWithRetry");
    resetFailedChunks();

    render(
      <MemoryRouter>
        <ErrorBoundary>
          <Suspense fallback={<div>Loading…</div>}>
            <RetryRoute />
          </Suspense>
        </ErrorBoundary>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText("Second surface loaded")).toBeTruthy());
    expect(attempts).toBe(2);
  });
});

// F5 regression (fe2 review): the two tests above drive `resetFailedChunks()` by hand, so removing `<FreshChunks />`
// from the real App.tsx (App.tsx:40) would leave the whole suite green while the "navigate away and back" recovery
// silently regressed. This drives the real App component and its real routes instead.
let settingsAttempts = 0;
vi.mock("convex/react", () => ({
  Authenticated: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  AuthLoading: () => null,
  Unauthenticated: () => null,
  useQuery: () => undefined,
  useMutation: () => vi.fn(),
  useAction: () => vi.fn(),
  useConvex: () => ({ query: vi.fn() }),
}));
vi.mock("./components/Shell", () => ({ Shell: () => <Outlet /> }));
vi.mock("./components/ConnectionBanner", () => ({ ConnectionBanner: () => null }));
vi.mock("./pages/Board", () => ({ default: () => <div>BOARD PAGE</div> }));
vi.mock("./pages/Settings", () => {
  settingsAttempts += 1;
  if (settingsAttempts === 1) throw new Error("boom: offline");
  return { default: () => <div>SETTINGS PAGE</div> };
});

const navRef: { current: ((to: string) => void) | null } = { current: null };
function Nav() {
  const n = useNavigate();
  useEffect(() => {
    navRef.current = n;
  }, [n]);
  return null;
}

describe("App.tsx: FreshChunks recovers a route chunk that failed once (F5 regression)", () => {
  it("navigating away and back re-requests the failed /settings chunk", async () => {
    const { default: App } = await import("./App");
    render(
      <MemoryRouter initialEntries={["/settings"]}>
        <Nav />
        <App />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: /try again/i })).toBeTruthy());
    await act(async () => navRef.current!("/"));
    await waitFor(() => expect(screen.getByText("BOARD PAGE")).toBeTruthy());
    await act(async () => navRef.current!("/settings"));
    await waitFor(() => expect(screen.getByText("SETTINGS PAGE")).toBeTruthy());
    expect(settingsAttempts).toBeGreaterThanOrEqual(2);
  });
});
