/**
 * The disposable dev deployment's identity (D62, DA-A-28c): a single positive-match helper both `convex/http.ts`
 * (the evidence-route CORS allowlist) and `convex/lib/providerMode.ts` (QA2-3, P10-OW-12) need.
 *
 * Deliberately its own leaf module, not defined in and re-exported from `convex/http.ts` (where it originally
 * lived): `http.ts` imports `./auth`, which imports `./lib/authMail`, which imports `./lib/providerMode` -- so
 * `providerMode.ts` importing `isDevDeployment` straight from `../http` would close a cycle
 * (`http.ts` -> `auth.ts` -> `lib/authMail.ts` -> `lib/providerMode.ts` -> `http.ts`). This module has no imports
 * of its own, so both `http.ts` and `lib/providerMode.ts` can depend on it with no edge back.
 */

/** A positive match, so an unset, unknown or production `CONVEX_SITE_URL` never allows it. */
export const DEV_DEPLOYMENT_MARKER = "adorable-lion-138";

export function isDevDeployment(convexSiteUrl: string | undefined): boolean {
  if (!convexSiteUrl) return false;
  try {
    return new URL(convexSiteUrl.trim()).hostname === `${DEV_DEPLOYMENT_MARKER}.convex.site`;
  } catch {
    return false;
  }
}
