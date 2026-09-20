import { useAuthActions } from "@convex-dev/auth/react";
import { type FormEvent, useState } from "react";
import { inputClass, primaryButtonClass } from "../lib/ui";

type Flow = "signIn" | "signUp";

export default function SignIn() {
  const { signIn } = useAuthActions();
  const [flow, setFlow] = useState<Flow>("signIn");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    const formData = new FormData(event.currentTarget);
    formData.set("flow", flow);
    try {
      await signIn("password", formData);
    } catch {
      setError(
        flow === "signIn"
          ? "That email and password didn't match. Check them and try again."
          : "Couldn't create that account. The email may already be in use.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  const fieldLabel = "mb-1 block text-sm font-medium text-ink";

  return (
    <div className="flex min-h-screen items-center justify-center bg-paper px-4 py-12">
      <div className="w-full max-w-sm rounded-xl bg-white p-8 shadow-xs">
        <div className="mb-6 flex items-center gap-2">
          <svg viewBox="0 0 32 32" className="size-8" aria-hidden="true">
            <rect width="32" height="32" rx="8" className="fill-harbor" />
            <path
              d="M9 11l7 9 7-9M16 20v-9"
              fill="none"
              stroke="white"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span className="text-lg font-bold text-ink">Recoup</span>
        </div>

        <h1 className="text-3xl font-bold text-ink">
          {flow === "signIn" ? "Welcome back" : "Create your account"}
        </h1>
        <p className="mt-2 text-sm text-ink/60">
          Price dropped after you bought? Recoup gets the difference back.
        </p>

        <form onSubmit={(event) => void handleSubmit(event)} className="mt-6 space-y-4">
          {flow === "signUp" && (
            <div>
              <label htmlFor="name" className={fieldLabel}>
                Name
              </label>
              <input id="name" name="name" type="text" autoComplete="name" required className={inputClass} />
            </div>
          )}

          <div>
            <label htmlFor="email" className={fieldLabel}>
              Email
            </label>
            <input id="email" name="email" type="email" autoComplete="email" required className={inputClass} />
          </div>

          <div>
            <label htmlFor="password" className={fieldLabel}>
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete={flow === "signIn" ? "current-password" : "new-password"}
              required
              minLength={8}
              className={inputClass}
            />
          </div>

          {error && (
            <p role="alert" className="rounded-lg bg-rust/10 px-3 py-2 text-sm text-rust">
              {error}
            </p>
          )}

          <button type="submit" disabled={submitting} className={`w-full ${primaryButtonClass}`}>
            {submitting ? "Please wait…" : flow === "signIn" ? "Sign in" : "Create account"}
          </button>
        </form>

        <div className="mt-6 border-t border-line/60 pt-5 text-sm text-ink/60">
          {flow === "signIn" ? "New to Recoup? " : "Already have an account? "}
          <button
            type="button"
            onClick={() => {
              setError(null);
              setFlow(flow === "signIn" ? "signUp" : "signIn");
            }}
            className="font-medium text-harbor hover:underline"
          >
            {flow === "signIn" ? "Create an account" : "Sign in"}
          </button>
        </div>
      </div>
    </div>
  );
}
