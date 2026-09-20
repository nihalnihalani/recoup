import { useAuthActions } from "@convex-dev/auth/react";
import { type FormEvent, useState } from "react";

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

  return (
    <div className="flex min-h-screen items-center justify-center bg-paper px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="font-serif text-3xl font-semibold tracking-tight text-ink">Recoup</h1>
          <p className="mx-auto mt-3 max-w-xs text-sm leading-relaxed text-ink/60">
            Refund didn&rsquo;t add up? Price dropped after you bought? Recoup gets the difference
            back.
          </p>
        </div>

        <form
          onSubmit={(event) => void handleSubmit(event)}
          className="space-y-4 rounded-lg border border-line bg-white/70 p-6 shadow-sm"
        >
          <h2 className="text-xs font-semibold uppercase tracking-wide text-ink/50">
            {flow === "signIn" ? "Sign in" : "Create your account"}
          </h2>

          {flow === "signUp" && (
            <div>
              <label htmlFor="name" className="mb-1 block text-sm font-medium text-ink">
                Name
              </label>
              <input
                id="name"
                name="name"
                type="text"
                autoComplete="name"
                required
                className="w-full rounded-md border border-line bg-white px-3 py-2 text-sm text-ink outline-none focus:border-harbor focus:ring-2 focus:ring-harbor/20"
              />
            </div>
          )}

          <div>
            <label htmlFor="email" className="mb-1 block text-sm font-medium text-ink">
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              className="w-full rounded-md border border-line bg-white px-3 py-2 text-sm text-ink outline-none focus:border-harbor focus:ring-2 focus:ring-harbor/20"
            />
          </div>

          <div>
            <label htmlFor="password" className="mb-1 block text-sm font-medium text-ink">
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete={flow === "signIn" ? "current-password" : "new-password"}
              required
              minLength={8}
              className="w-full rounded-md border border-line bg-white px-3 py-2 text-sm text-ink outline-none focus:border-harbor focus:ring-2 focus:ring-harbor/20"
            />
          </div>

          {error && (
            <p role="alert" className="text-sm text-rust">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-md bg-harbor px-4 py-2 text-sm font-semibold text-paper transition hover:bg-harbor/90 disabled:opacity-60"
          >
            {submitting ? "Please wait…" : flow === "signIn" ? "Sign in" : "Create account"}
          </button>

          <button
            type="button"
            onClick={() => {
              setError(null);
              setFlow(flow === "signIn" ? "signUp" : "signIn");
            }}
            className="w-full text-center text-sm text-ink/60 underline-offset-2 hover:text-ink hover:underline"
          >
            {flow === "signIn" ? "New to Recoup? Create an account" : "Already have an account? Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}
