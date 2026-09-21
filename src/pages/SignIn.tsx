import { useAuthActions } from "@convex-dev/auth/react";
import { isRateLimitError } from "@convex-dev/rate-limiter";
import { ConvexError } from "convex/values";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { inputClass, labelClass, primaryButtonClass, secondaryButtonClass } from "../lib/ui";

/**
 * The client contract this screen implements (D91, T08): `signIn("password", { flow, email,
 * password?, code?, newPassword? })` with flows `signUp | signIn | reset | reset-verification |
 * email-verification`. A "no session yet" success (a code was sent) resolves with
 * `{ signingIn: false }` — the same shape whether this is a fresh sign-up, an existing but
 * unverified account signing in (D66's migration path), or a password-reset request. Errors are
 * the exact `ConvexError` strings `convex/auth.ts` exports; a rate limit surfaces as
 * `ConvexError({ kind: "RateLimited", name, retryAfter })`, detected with `isRateLimitError()`.
 */
type Flow = "signIn" | "signUp" | "verify" | "reset" | "resetVerify";

/**
 * idle: the form is editable. submitting: the request is in flight. entering: the server
 * accepted the credentials and the tokens are stored; App.tsx swaps this screen out as
 * soon as Convex confirms them, so the form stays locked instead of inviting a second
 * submit. stalled: that swap has not happened after STALL_MS.
 */
type Phase = "idle" | "submitting" | "entering" | "stalled";

const STALL_MS = 8000;
const CODE_LENGTH = 8;

/** Generic fallback for anything that is not one of our own fixed server strings. */
const GENERIC_ERROR = "Could not sign in. Try again in a minute.";

/**
 * D94: a rate limit during `signUp` can fire from the per-email/global auth-mail limiter, which
 * only runs AFTER the account is created (it guards the verification code's send, not the sign-up
 * itself) — so this error can mean the account now exists even though no code went out. Honest
 * about the uncertainty rather than claiming either outcome.
 */
const SIGNUP_RATE_LIMITED_MESSAGE =
  "We couldn't send a code right now. If you already signed up, sign in with the same password to get a new code.";

const PROMISES = [
  "No affiliate links and no sponsored ranking.",
  "Recoup never emails a store without you approving that message. Price alerts to your own verified address are automatic once you turn them on.",
  "Money only counts when you confirm it arrived.",
  "Every price shows where and when it was read. Every policy shows the exact sentence it came from.",
] as const;

/**
 * Server errors are rendered verbatim (they are our own fixed, non-enumerating copy — never a
 * client-invented "no such account" message). A rate limit's `.data` is a structured object, not
 * text, so it gets one client-authored sentence built from `retryAfter`; anything else collapses
 * to the generic fallback rather than leaking a raw Error.
 *
 * D94: `TOO_MANY_ATTEMPTS_MESSAGE` (the provider's own failed-attempts lockout) is now textually
 * identical to `WRONG_CREDENTIALS_MESSAGE` — both are plain-string `ConvexError`s with no
 * `retryAfter`, so they already render as the same verbatim string below. `isRateLimitError` (our
 * own rate limiter's structured `{ kind: "RateLimited", retryAfter }` shape) stays the ONLY signal
 * this function uses to pick the countdown copy — never branch on message text to distinguish a
 * known address from an unknown one.
 */
function describeError(err: unknown): { message: string; retryAfterMs?: number } {
  if (isRateLimitError(err)) {
    const retryAfterMs = err.data.retryAfter;
    return { message: `Too many attempts. Try again in ${formatCountdown(retryAfterMs)}.`, retryAfterMs };
  }
  if (err instanceof ConvexError && typeof err.data === "string") {
    return { message: err.data };
  }
  return { message: GENERIC_ERROR };
}

function formatCountdown(ms: number): string {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes}m`;
}

export default function SignIn() {
  const { signIn } = useAuthActions();
  const [flow, setFlow] = useState<Flow>("signIn");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [emailDraft, setEmailDraft] = useState("");
  const [pendingEmail, setPendingEmail] = useState("");
  const [pendingPassword, setPendingPassword] = useState("");
  // The cooldown's target time and its live countdown are two different pieces of state
  // (rather than deriving one via an effect that reads `Date.now()`, which is impure during
  // render and, primed from an effect, fights React's synchronous-render model): whichever
  // event starts a cooldown sets both, right there, from the `retryAfter` it already has in
  // hand — see `startCooldown` — and only the ticking itself (an async interval callback) ever
  // updates `resendSeconds` after that.
  const [resendUntil, setResendUntil] = useState<number | null>(null);
  const [resendSeconds, setResendSeconds] = useState(0);
  const [resendBusy, setResendBusy] = useState(false);
  const codeInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (resendUntil === null) return;
    const id = window.setInterval(() => {
      const remaining = Math.max(0, Math.ceil((resendUntil - Date.now()) / 1000));
      setResendSeconds(remaining);
      if (remaining <= 0) window.clearInterval(id);
    }, 1000);
    return () => window.clearInterval(id);
  }, [resendUntil]);

  function startCooldown(retryAfterMs: number) {
    setResendUntil(Date.now() + retryAfterMs);
    setResendSeconds(Math.max(1, Math.ceil(retryAfterMs / 1000)));
  }

  function clearCooldown() {
    setResendUntil(null);
    setResendSeconds(0);
  }

  // This screen unmounts when the auth state flips, which clears the timer.
  useEffect(() => {
    if (phase !== "entering") return;
    const id = window.setTimeout(() => setPhase("stalled"), STALL_MS);
    return () => window.clearTimeout(id);
  }, [phase]);

  // Focus the code input the moment either verification step opens.
  useEffect(() => {
    if (flow === "verify" || flow === "resetVerify") {
      codeInputRef.current?.focus();
    }
  }, [flow]);

  const locked = phase !== "idle";

  function clearMessages() {
    setError(null);
    setNotice(null);
  }

  function fail(err: unknown) {
    setPhase("idle");
    const described = describeError(err);
    setError(described.message);
    if (described.retryAfterMs !== undefined) startCooldown(described.retryAfterMs);
  }

  async function handlePasswordSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (phase !== "idle") return;
    clearMessages();
    setPhase("submitting");
    const formData = new FormData(event.currentTarget);
    const email = String(formData.get("email") ?? "");
    const password = String(formData.get("password") ?? "");
    formData.set("flow", flow);
    try {
      const result = await signIn("password", formData);
      if (result.signingIn) {
        setPhase("entering");
        return;
      }
      // { tokens: null }: no session yet — a verification code was just emailed, whether this
      // was a brand-new sign-up or an existing account that still needs to verify (D66).
      setPendingEmail(email);
      setPendingPassword(password);
      clearCooldown();
      setPhase("idle");
      setFlow("verify");
      setNotice(`Enter the code we emailed to ${email}. It expires in 15 minutes.`);
    } catch (err) {
      // D94: on signUp specifically, a rate limit can mean the account now exists (see
      // SIGNUP_RATE_LIMITED_MESSAGE) — that case gets its own copy instead of the generic
      // "too many attempts" countdown message `fail` would otherwise render.
      if (flow === "signUp" && isRateLimitError(err)) {
        setPhase("idle");
        setError(SIGNUP_RATE_LIMITED_MESSAGE);
        startCooldown(err.data.retryAfter);
        return;
      }
      fail(err);
    }
  }

  async function handleVerifySubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (phase !== "idle") return;
    clearMessages();
    setPhase("submitting");
    const formData = new FormData(event.currentTarget);
    const code = String(formData.get("code") ?? "").trim();
    try {
      const result = await signIn("password", { flow: "email-verification", email: pendingEmail, code });
      if (result.signingIn) {
        setPhase("entering");
        return;
      }
      setPhase("idle");
      setError(GENERIC_ERROR);
    } catch (err) {
      fail(err);
    }
  }

  async function handleResendVerify() {
    if (resendBusy || resendSeconds > 0) return;
    clearMessages();
    setResendBusy(true);
    try {
      // Re-running "signIn" (not "signUp": the account already exists at this point) hits the
      // same "account exists but is not verified yet" branch that sent the first code.
      const result = await signIn("password", { flow: "signIn", email: pendingEmail, password: pendingPassword });
      if (result.signingIn) {
        setPhase("entering");
        return;
      }
      setNotice("We sent a new code.");
    } catch (err) {
      const described = describeError(err);
      setError(described.message);
      if (described.retryAfterMs !== undefined) startCooldown(described.retryAfterMs);
    } finally {
      setResendBusy(false);
    }
  }

  function handleForgotPassword() {
    clearMessages();
    setPendingEmail(emailDraft);
    setFlow("reset");
  }

  async function handleResetRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (phase !== "idle") return;
    clearMessages();
    setPhase("submitting");
    const formData = new FormData(event.currentTarget);
    const email = String(formData.get("email") ?? "");
    try {
      await signIn("password", { flow: "reset", email });
      setPendingEmail(email);
      clearCooldown();
      setPhase("idle");
      setFlow("resetVerify");
      setNotice("If that address has an account, a code is on its way.");
    } catch (err) {
      fail(err);
    }
  }

  async function handleResendReset() {
    if (resendBusy || resendSeconds > 0) return;
    clearMessages();
    setResendBusy(true);
    try {
      await signIn("password", { flow: "reset", email: pendingEmail });
      setNotice("If that address has an account, a code is on its way.");
    } catch (err) {
      const described = describeError(err);
      setError(described.message);
      if (described.retryAfterMs !== undefined) startCooldown(described.retryAfterMs);
    } finally {
      setResendBusy(false);
    }
  }

  async function handleResetVerifySubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (phase !== "idle") return;
    clearMessages();
    setPhase("submitting");
    const formData = new FormData(event.currentTarget);
    const code = String(formData.get("code") ?? "").trim();
    const newPassword = String(formData.get("newPassword") ?? "");
    try {
      const result = await signIn("password", {
        flow: "reset-verification",
        email: pendingEmail,
        code,
        newPassword,
      });
      if (result.signingIn) {
        setPhase("entering");
        return;
      }
      setPhase("idle");
      setError(GENERIC_ERROR);
    } catch (err) {
      fail(err);
    }
  }

  function backToSignIn() {
    clearMessages();
    clearCooldown();
    setPendingPassword("");
    setFlow("signIn");
  }

  const buttonText =
    flow === "signIn" || flow === "signUp"
      ? phase === "submitting"
        ? flow === "signIn"
          ? "Checking…"
          : "Creating your account…"
        : phase === "entering" || phase === "stalled"
          ? "Signing you in…"
          : flow === "signIn"
            ? "Sign in"
            : "Create account"
      : flow === "verify"
        ? phase === "submitting"
          ? "Verifying…"
          : phase === "entering" || phase === "stalled"
            ? "Signing you in…"
            : "Verify code"
        : flow === "reset"
          ? phase === "submitting"
            ? "Sending…"
            : "Send reset code"
          : phase === "submitting"
            ? "Resetting…"
            : phase === "entering" || phase === "stalled"
              ? "Signing you in…"
              : "Reset password";

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
            {flow === "signIn" && "Welcome back"}
            {flow === "signUp" && "Create your account"}
            {flow === "verify" && "Check your email"}
            {flow === "reset" && "Reset your password"}
            {flow === "resetVerify" && "Enter your new password"}
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-gray-500">
            {(flow === "signIn" || flow === "signUp") &&
              "Price dropped after you bought? Recoup gets the difference back. Haven't bought yet? It watches the price everywhere and tells you when to."}
            {flow === "verify" && "Enter the 8-digit code we emailed you to finish signing in."}
            {flow === "reset" && "Enter your email and, if it has an account, we'll send a code to reset your password."}
            {flow === "resetVerify" && "Enter the code we sent and choose a new password."}
          </p>

          {(flow === "signIn" || flow === "signUp") && (
            <form onSubmit={(event) => void handlePasswordSubmit(event)} className="mt-6 space-y-4" aria-busy={locked}>
              {flow === "signUp" && (
                <div>
                  <label htmlFor="name" className={labelClass}>
                    Name
                  </label>
                  <input id="name" name="name" type="text" autoComplete="name" required readOnly={locked} className={inputClass} />
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
                  onChange={(event) => setEmailDraft(event.target.value)}
                  className={inputClass}
                />
              </div>

              <div>
                <div className="flex items-center justify-between">
                  <label htmlFor="password" className={labelClass}>
                    Password
                  </label>
                  {flow === "signIn" && (
                    <button
                      type="button"
                      disabled={locked}
                      onClick={handleForgotPassword}
                      className="mb-1.5 rounded text-xs font-semibold text-gray-500 underline decoration-gray-300 underline-offset-4 outline-none transition hover:text-gray-900 hover:decoration-gray-900 focus-visible:ring-2 focus-visible:ring-violet-500 disabled:opacity-60"
                    >
                      Forgot password?
                    </button>
                  )}
                </div>
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

              {phase === "stalled" && <StalledPanel />}
            </form>
          )}

          {flow === "verify" && (
            <form onSubmit={(event) => void handleVerifySubmit(event)} className="mt-6 space-y-4" aria-busy={locked}>
              {notice && (
                <p role="status" className="rounded-xl border border-gray-200 bg-gray-50 px-3.5 py-2.5 text-sm text-gray-700">
                  {notice}
                </p>
              )}

              <div>
                <label htmlFor="verify-code" className={labelClass}>
                  Verification code
                </label>
                <input
                  id="verify-code"
                  name="code"
                  ref={codeInputRef}
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]*"
                  maxLength={CODE_LENGTH}
                  required
                  readOnly={locked}
                  className={`${inputClass} tracking-[0.3em]`}
                />
              </div>

              {error && (
                <p role="alert" className="rounded-xl border border-red-500/30 bg-red-500/10 px-3.5 py-2.5 text-sm text-red-700">
                  {error}
                </p>
              )}

              <button type="submit" disabled={locked} className={`w-full ${primaryButtonClass}`}>
                {buttonText}
              </button>

              <div className="flex items-center justify-between gap-3 text-sm">
                <button
                  type="button"
                  disabled={locked || resendBusy || resendSeconds > 0}
                  onClick={() => void handleResendVerify()}
                  className={`${secondaryButtonClass} px-3 py-1.5`}
                >
                  {resendBusy ? "Sending…" : resendSeconds > 0 ? `Resend code (${resendSeconds}s)` : "Resend code"}
                </button>
                <button
                  type="button"
                  disabled={locked}
                  onClick={backToSignIn}
                  className="rounded font-semibold text-gray-500 underline decoration-gray-300 underline-offset-4 outline-none transition hover:text-gray-900 hover:decoration-gray-900 focus-visible:ring-2 focus-visible:ring-violet-500 disabled:opacity-60"
                >
                  Back to sign in
                </button>
              </div>

              {phase === "stalled" && <StalledPanel />}
            </form>
          )}

          {flow === "reset" && (
            <form onSubmit={(event) => void handleResetRequest(event)} className="mt-6 space-y-4" aria-busy={locked}>
              <div>
                <label htmlFor="reset-email" className={labelClass}>
                  Email
                </label>
                <input
                  id="reset-email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  required
                  readOnly={locked}
                  defaultValue={pendingEmail}
                  className={inputClass}
                />
              </div>

              {error && (
                <p role="alert" className="rounded-xl border border-red-500/30 bg-red-500/10 px-3.5 py-2.5 text-sm text-red-700">
                  {error}
                </p>
              )}

              <button type="submit" disabled={locked} className={`w-full ${primaryButtonClass}`}>
                {buttonText}
              </button>

              <button
                type="button"
                disabled={locked}
                onClick={backToSignIn}
                className="block w-full rounded text-center text-sm font-semibold text-gray-500 underline decoration-gray-300 underline-offset-4 outline-none transition hover:text-gray-900 hover:decoration-gray-900 focus-visible:ring-2 focus-visible:ring-violet-500 disabled:opacity-60"
              >
                Back to sign in
              </button>
            </form>
          )}

          {flow === "resetVerify" && (
            <form onSubmit={(event) => void handleResetVerifySubmit(event)} className="mt-6 space-y-4" aria-busy={locked}>
              {notice && (
                <p role="status" className="rounded-xl border border-gray-200 bg-gray-50 px-3.5 py-2.5 text-sm text-gray-700">
                  {notice}
                </p>
              )}

              <div>
                <label htmlFor="reset-code" className={labelClass}>
                  Verification code
                </label>
                <input
                  id="reset-code"
                  name="code"
                  ref={codeInputRef}
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]*"
                  maxLength={CODE_LENGTH}
                  required
                  readOnly={locked}
                  className={`${inputClass} tracking-[0.3em]`}
                />
              </div>

              <div>
                <label htmlFor="new-password" className={labelClass}>
                  New password
                </label>
                <input
                  id="new-password"
                  name="newPassword"
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={8}
                  readOnly={locked}
                  aria-describedby="new-password-hint"
                  className={inputClass}
                />
                <p id="new-password-hint" className="mt-1.5 text-xs text-gray-400">
                  At least 8 characters.
                </p>
              </div>

              {error && (
                <p role="alert" className="rounded-xl border border-red-500/30 bg-red-500/10 px-3.5 py-2.5 text-sm text-red-700">
                  {error}
                </p>
              )}

              <button type="submit" disabled={locked} className={`w-full ${primaryButtonClass}`}>
                {buttonText}
              </button>

              <div className="flex items-center justify-between gap-3 text-sm">
                <button
                  type="button"
                  disabled={locked || resendBusy || resendSeconds > 0}
                  onClick={() => void handleResendReset()}
                  className={`${secondaryButtonClass} px-3 py-1.5`}
                >
                  {resendBusy ? "Sending…" : resendSeconds > 0 ? `Resend code (${resendSeconds}s)` : "Resend code"}
                </button>
                <button
                  type="button"
                  disabled={locked}
                  onClick={backToSignIn}
                  className="rounded font-semibold text-gray-500 underline decoration-gray-300 underline-offset-4 outline-none transition hover:text-gray-900 hover:decoration-gray-900 focus-visible:ring-2 focus-visible:ring-violet-500 disabled:opacity-60"
                >
                  Back to sign in
                </button>
              </div>

              {phase === "stalled" && <StalledPanel />}
            </form>
          )}

          {(flow === "signIn" || flow === "signUp") && (
            <>
              <p className="mt-5 text-center text-sm text-gray-500">
                {flow === "signIn" ? "New to Recoup? " : "Already have an account? "}
                <button
                  type="button"
                  disabled={locked}
                  onClick={() => {
                    clearMessages();
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
            </>
          )}
        </div>
      </main>
    </div>
  );
}

/** Shown once a submit reports success but App.tsx hasn't swapped this screen out after STALL_MS. */
function StalledPanel() {
  return (
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
  );
}
