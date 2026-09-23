import { Component, createRef, type ErrorInfo, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ConvexError } from "convex/values";
import { ErrorBox } from "./States";
import { isChunkLoadError, resetFailedChunks } from "../lib/lazyWithRetry";
import { BUILD_ID } from "../buildInfo";

type Props = {
  children: ReactNode;
  /** Overrides the default full-page fallback (e.g. for a smaller inline surface). */
  fallback?: (error: Error, reset: () => void) => ReactNode;
};

type State = { error: Error | null };

/**
 * A `ConvexError`'s `.data` is one of our own fixed strings (ARCHITECTURE_PATTERNS
 * §Errors) — safe to show verbatim, with a friendlier phrasing for the common
 * "not found" case (an unknown, foreign, or malformed id — `convex/lib/access.ts`
 * throws `"<Thing> not found"` for the first two; a malformed id fails argument
 * validation before that and surfaces as a plain Error instead). Anything that
 * isn't a ConvexError is a genuine crash: never echo `err.message`, which can
 * carry a stack trace or provider response text.
 */
function fallbackMessage(error: Error): string {
  // P10-MW-1: a page's code that did not download is not a crash of the page itself.
  if (isChunkLoadError(error)) {
    return "Part of Recoup didn't download. You may be offline, or Recoup was just updated. Try again, or reload the page.";
  }
  if (error instanceof ConvexError) {
    const text = typeof error.data === "string" ? error.data : JSON.stringify(error.data);
    if (/not found/i.test(text)) {
      return "This item does not exist or belongs to another account.";
    }
    return text;
  }
  return "Something went wrong loading this page.";
}

const backLinkClass =
  "rounded text-sm font-medium text-gray-500 transition hover:text-gray-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-500";

/**
 * Route-level crash guard (P10). Without this, an unknown/foreign/malformed id
 * (a ConvexError from `convex/lib/access.ts`, or a raw validation error for a
 * malformed id) unmounts the whole app to a blank screen. With it, the user
 * gets an actionable message and a way back to the board.
 *
 * App.tsx keys one of these per route by `location.pathname`, so navigating to
 * a different id remounts a fresh instance instead of staying stuck on the
 * previous error.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };
  private headingRef = createRef<HTMLHeadingElement>();

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    if (import.meta.env.DEV) console.error(error, info.componentStack);
  }

  componentDidUpdate(_prevProps: Props, prevState: State) {
    // Move focus to the fallback heading so assistive tech announces the
    // error immediately, the way a fresh page's <h1> would be announced.
    if (prevState.error === null && this.state.error !== null) {
      this.headingRef.current?.focus();
    }
  }

  // P10-MW-1: a failed route chunk gets a fresh import on retry, instead of React.lazy's cached rejection.
  reset = () => {
    resetFailedChunks();
    this.setState({ error: null });
  };

  render() {
    const { error } = this.state;
    if (error === null) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error, this.reset);

    return (
      <div className="mx-auto max-w-md py-16 text-center">
        <h1
          ref={this.headingRef}
          tabIndex={-1}
          className="rounded text-base font-semibold text-gray-900 focus:outline-2 focus:outline-offset-2 focus:outline-violet-500"
        >
          This page couldn&apos;t load
        </h1>
        <div className="mt-3 text-left">
          <ErrorBox error={fallbackMessage(error)} retry={this.reset} />
        </div>
        {isChunkLoadError(error) && (
          <button
            type="button"
            onClick={() => window.location.reload()}
            className={`mt-3 inline-block ${backLinkClass}`}
          >
            Reload the page
          </button>
        )}
        <Link to="/" className={`mt-4 inline-block ${backLinkClass}`}>
          Go to board
        </Link>
        {/* P12-W6/F6: the running build, for support -- never blocks or slows the fallback down. */}
        <p className="mt-6 text-xs text-gray-300">Build {BUILD_ID}</p>
      </div>
    );
  }
}
