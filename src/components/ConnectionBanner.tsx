import { useEffect, useState } from "react";
import { useConvexConnectionState } from "convex/react";

/** Convex's first handshake is expected to take a moment; only a drop *after*
 * that — or a longer stall than a normal blip — is worth interrupting for. */
const SHOW_AFTER_MS = 3000;

/**
 * A quiet, non-blocking strip for P10's "no offline/reconnect handling" gap.
 * Driven by the Convex client's own connection state (verified present as
 * `useConvexConnectionState` in the installed convex@1.46.0 — see
 * node_modules/convex/dist/esm-types/react/client.d.ts) plus the browser's
 * `navigator.onLine`, so a dropped websocket and a fully offline browser both
 * surface the same message.
 */
export function ConnectionBanner() {
  const { isWebSocketConnected, hasEverConnected } = useConvexConnectionState();
  const [browserOnline, setBrowserOnline] = useState(
    () => typeof navigator === "undefined" || navigator.onLine,
  );
  const [show, setShow] = useState(false);

  useEffect(() => {
    const goOnline = () => setBrowserOnline(true);
    const goOffline = () => setBrowserOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  // The very first connect is expected to take a moment; only a drop *after*
  // we've connected at least once counts as something worth showing.
  const disconnected = hasEverConnected && (!isWebSocketConnected || !browserOnline);

  const [tracked, setTracked] = useState(disconnected);
  if (tracked !== disconnected) {
    // Adjust state during render in response to the derived `disconnected`
    // value changing, rather than calling a setter synchronously from inside
    // a useEffect body (React's documented pattern for "adjusting state when
    // a value changes": https://react.dev/learn/you-might-not-need-an-effect).
    setTracked(disconnected);
    setShow(false);
  }

  useEffect(() => {
    if (!disconnected) return;
    const timer = window.setTimeout(() => setShow(true), SHOW_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [disconnected]);

  if (!show) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center justify-center gap-2 border-b border-yellow-500/30 bg-yellow-500/10 px-4 py-2 text-sm font-medium text-yellow-800"
    >
      <span
        className="size-2 rounded-full bg-yellow-500 motion-safe:animate-pulse"
        aria-hidden="true"
      />
      Reconnecting…
    </div>
  );
}
