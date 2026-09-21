/** Shown instead of the app when the deployment is missing its Convex URL.
 * No secrets, no env values — just enough to tell an operator what to fix. */
export function ConfigMissing() {
  return (
    <div
      role="alert"
      className="flex min-h-screen items-center justify-center bg-paper px-6 text-center text-ink"
    >
      <div className="max-w-sm">
        <h1 className="text-base font-semibold text-gray-900">Recoup isn&apos;t configured</h1>
        <p className="mt-2 text-sm text-gray-500">
          This deployment is missing a valid Convex URL. Set{" "}
          <code className="rounded bg-gray-100 px-1 py-0.5 text-xs">VITE_CONVEX_URL</code> to an{" "}
          <code className="rounded bg-gray-100 px-1 py-0.5 text-xs">https://</code> address and
          rebuild.
        </p>
      </div>
    </div>
  );
}
