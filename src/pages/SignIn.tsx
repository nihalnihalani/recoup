import { useAuthActions } from "@convex-dev/auth/react";
import { type FormEvent, useEffect, useState } from "react";
import { inputClass, labelClass, primaryButtonClass, secondaryButtonClass } from "../lib/ui";

type Flow = "signIn" | "signUp";

/**
 * idle: the form is editable. submitting: the request is in flight. entering: the server
 * accepted the credentials and the tokens are stored; App.tsx swaps this screen out as
 * soon as Convex confirms them, so the form stays locked instead of inviting a second
 * submit. stalled: that swap has not happened after STALL_MS.
 */
type Phase = "idle" | "submitting" | "entering" | "stalled";

const STALL_MS = 8000;

const PROMISES = [
  "No affiliate links and no sponsored ranking.",
  "You approve every message before it is sent. Recoup never files claims in bulk.",
  "Money only counts when you confirm it arrived.",
  "Every price shows where and when it was read. Every policy shows the exact sentence it came from.",
] as const;

export default function SignIn() {
  const { signIn } = useAuthActions();
  const [flow, setFlow] = useState<Flow>("signIn");
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");

  // This screen unmounts when the auth state flips, which clears the timer.
  useEffect(() => {
    if (phase !== "entering") return;
    const id = window.setTimeout(() => setPhase("stalled"), STALL_MS);
    return () => window.clearTimeout(id);
  }, [phase]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (phase !== "idle") return;
    setError(null);
    setPhase("submitting");
    const formData = new FormData(event.currentTarget);
    formData.set("flow", flow);
    try {
      const result = await signIn("password", formData);
      if (result.signingIn) {
        setPhase("entering");
        return;
      }
      setPhase("idle");
      setError(
        flow === "signUp"
          ? "Your account was created, but it did not sign you in. Sign in with the same email and password."
          : "That did not sign you in. Check your email and password and try again.",
      );
      if (flow === "signUp") setFlow("signIn");
    } catch {
      setPhase("idle");
      setError(
        flow === "signIn"
          ? "That email and password didn't match. Check them and try again."
          : "Couldn't create that account. The email may already be in use.",
      );
    }
  }

  const locked = phase !== "idle";
  const buttonText =
    phase === "submitting"
      ? flow === "signIn"
        ? "Checking…"
        : "Creating your account…"
      : phase === "entering" || phase === "stalled"
        ? "Signing you in…"
        : flow === "signIn"
          ? "Sign in"
          : "Create account";

  return (
    <div className="flex min-h-screen items-center justify-center bg-white px-4 py-10">
      <main className="w-full max-w-md">
        <div className="rounded-2xl border border-gray-200 bg-white p-6 sm:p-8">
          <div className="flex items-center gap-2.5">
            <span
              aria-hidden="true"
              className="flex size-9 items-center justify-center rounded-lg bg-gray-900 text-lg font-bold leading-none text-white"
            >
              R
            </span>
            <span className="text-xl font-semibold tracking-tight text-gray-900">Recoup</span>
          </div>

          <h1 className="mt-8 text-2xl font-semibold tracking-tight text-gray-900">
            {flow === "signIn" ? "Welcome back" : "Create your account"}
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-gray-500">
            Price dropped after you bought? Recoup gets the difference back. Haven't bought yet? It watches the
            price everywhere and tells you when to.
          </p>

          <form onSubmit={(event) => void handleSubmit(event)} className="mt-6 space-y-4" aria-busy={locked}>
            {flow === "signUp" && (
              <div>
                <label htmlFor="name" className={labelClass}>
                  Name
                </label>
                <input
                  id="name"
                  name="name"
                  type="text"
                  autoComplete="name"
                  required
                  readOnly={locked}
                  className={inputClass}
                />
              </div>
            )}

            <div>
              <label htmlFor="email" className={labelClass}>
                Email
              </label>
              <input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                required
                readOnly={locked}
                className={inputClass}
              />
            </div>

            <div>
              <label htmlFor="password" className={labelClass}>
                Password
              </label>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete={flow === "signIn" ? "current-password" : "new-password"}
                required
                minLength={8}
                readOnly={locked}
                aria-describedby={flow === "signUp" ? "password-hint" : undefined}
                className={inputClass}
              />
              {flow === "signUp" && (
                <p id="password-hint" className="mt-1.5 text-xs text-gray-400">
                  At least 8 characters.
                </p>
              )}
            </div>

            {error && (
              <p role="alert" className="rounded-xl border border-red-500/30 bg-red-500/10 px-3.5 py-2.5 text-sm text-red-700">
                {error}
              </p>
            )}

            <button type="submit" disabled={locked} className={`w-full ${primaryButtonClass}`}>
              {buttonText}
            </button>

            {phase === "stalled" && (
              <div role="status" className="rounded-xl border border-yellow-500/40 bg-yellow-500/10 px-3.5 py-3 text-sm text-yellow-700">
                <p>You are signed in, but the app has not opened yet. Reloading the page opens it.</p>
                <button
                  type="button"
                  onClick={() => window.location.reload()}
                  className={`mt-3 ${secondaryButtonClass} px-3 py-1.5`}
                >
                  Reload
                </button>
              </div>
            )}
          </form>

          <p className="mt-5 text-center text-sm text-gray-500">
            {flow === "signIn" ? "New to Recoup? " : "Already have an account? "}
            <button
              type="button"
              disabled={locked}
              onClick={() => {
                setError(null);
                setFlow(flow === "signIn" ? "signUp" : "signIn");
              }}
              className="rounded font-semibold text-gray-900 underline decoration-gray-300 underline-offset-4 outline-none transition hover:decoration-gray-900 focus-visible:ring-2 focus-visible:ring-violet-500 disabled:opacity-60"
            >
              {flow === "signIn" ? "Create an account" : "Sign in"}
            </button>
          </p>

          <ul className="mt-6 space-y-2 border-t border-dashed border-gray-200 pt-5 text-xs leading-relaxed text-gray-500">
            {PROMISES.map((line) => (
              <li key={line} className="flex gap-2">
                <svg
                  aria-hidden="true"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="mt-0.5 size-3.5 shrink-0 text-green-700"
                >
                  <path d="M5 12.5l4.5 4.5L19 7.5" />
                </svg>
                <span>{line}</span>
              </li>
            ))}
          </ul>
        </div>
      </main>
    </div>
  );
}
