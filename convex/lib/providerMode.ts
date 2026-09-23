/**
 * P10-OW-12 (2026-09-23 re-audit): fail-closed provider-stub mode for the
 * Playwright e2e suite. The dev deployment now carries REAL Firecrawl /
 * OpenAI / ShopSavvy / AgentMail keys (unlike the placeholder keys D83 item
 * 3 documented), so every outbound call the browser suite's own flows can
 * reach -- creating a watch, "I bought it", a manual price check, an offer
 * search, policy research, a claim/drop email, inbox provisioning, an auth
 * verification/reset code -- must be prevented from reaching the real
 * provider while `RECOUP_PROVIDER_MODE=stub`. One flag, checked at every
 * call site listed in `docs/reviews/2026-09-23-P01-P12-reaudit.md`'s
 * P10-OW-12 row (grep `providerStubMode(` across `convex/` for the full
 * list; also named in this worker's own report).
 *
 * Fail-closed against production, by a POSITIVE signal (QA2-3, the adversarial re-review of this file's first
 * version): `providerStubMode()` throws -- and logs loudly to the deployment's own log stream, not only to
 * whatever catches the thrown error -- instead of ever returning `true` UNLESS there is a positive dev/E2E signal
 * (`isDevDeployment(CONVEX_SITE_URL)`, the same helper `convex/http.ts`'s DA-A-28c CORS check uses, OR
 * `E2E_SEED_ENABLED === "true"`, `convex/testing.ts`'s own per-deployment opt-in, D83/D95/D102 -- never set on
 * production). The FIRST version of this file instead refused only a documented-production-hostname denylist and
 * defaulted an unset/unknown `CONVEX_SITE_URL` to `true`: any deployment other than the two named ones (a renamed
 * or new prod, a staging prod, or simply a deployment whose env this flag was set on by mistake) silently entered
 * stub mode with no refusal and no log. Requiring a POSITIVE match closes that gap: an unknown deployment now
 * refuses by default, the same direction `convex/http.ts`'s `isDevDeployment` already takes. The documented
 * production-hostname check stays too, as defense in depth for the case where `E2E_SEED_ENABLED` is ever mis-set
 * together with the production host. This check runs on every call (not cached), so it cannot be bypassed by
 * importing this module, or setting the flag, before `CONVEX_SITE_URL`/`E2E_SEED_ENABLED` are known.
 */
import { ConvexError } from "convex/values";
import { isDevDeployment } from "./deploymentIdentity";

/** D83 item 6 / D95 / D102: the documented production host. Same substring-match convention as `convex/testing.ts`'s `PRODUCTION_HOST_MARKER` (not imported from there: that module's own guard is independent and E2E-seeding-specific; duplicating one literal keeps this module free of a dependency on the test-seeding harness). Checked unconditionally (QA2-3), even when a positive signal below holds. */
const PRODUCTION_HOST_MARKER = "cool-oyster-399";

/** Reserved by RFC 2606; matches `convex/testing.ts`'s own `E2E_INBOX_DOMAIN` convention for the same reason -- nothing can be sent from or routed to it. */
export const STUB_INBOX_DOMAIN = "inbox.e2e.example";

/**
 * True when the caller should skip its real provider call and use stub data instead. Throws (and logs loudly)
 * rather than returning `true` when `RECOUP_PROVIDER_MODE=stub` is set but either (a) there is no POSITIVE
 * dev/E2E signal for this deployment, or (b) it looks like the documented production deployment regardless --
 * stub mode must be impossible to enable in production, not merely undocumented there, and never enabled on an
 * unrecognized deployment by default (QA2-3). Returns `false` (the ordinary, real-call path) whenever the flag is
 * not exactly `"stub"`, on every deployment including production.
 */
export function providerStubMode(): boolean {
  if (process.env.RECOUP_PROVIDER_MODE !== "stub") return false;
  const siteUrl = process.env.CONVEX_SITE_URL;
  const e2eSeedEnabled = process.env.E2E_SEED_ENABLED === "true";
  const hasPositiveDevSignal = isDevDeployment(siteUrl) || e2eSeedEnabled;
  const looksProduction = (siteUrl ?? "").includes(PRODUCTION_HOST_MARKER);

  if (!hasPositiveDevSignal || looksProduction) {
    const reason = looksProduction
      ? `CONVEX_SITE_URL ("${siteUrl}") looks like the production deployment ("${PRODUCTION_HOST_MARKER}")`
      : `CONVEX_SITE_URL ("${siteUrl ?? "unset"}") is not the documented dev deployment and E2E_SEED_ENABLED is not "true" -- no positive signal that this is a safe deployment`;
    // Deliberately loud (P10-OW-12: "refuse, and log loudly"): this belongs in the deployment's own log
    // stream even if whatever catches the thrown ConvexError below only shows the user a generic message.
    // eslint-disable-next-line no-console
    console.error(
      `[RECOUP_PROVIDER_MODE] REFUSED: RECOUP_PROVIDER_MODE=stub is set, but ${reason}. Stub mode must never ` +
        `run there; every provider call on this deployment is being run for real, and this call will now fail ` +
        `loudly instead of silently faking a response.`,
    );
    throw new ConvexError(
      `RECOUP_PROVIDER_MODE=stub is refused on this deployment: ${reason}. Unset RECOUP_PROVIDER_MODE there, ` +
        `or set E2E_SEED_ENABLED=true if this genuinely is a disposable e2e deployment (P10-OW-12, QA2-3).`,
    );
  }
  return true;
}

/**
 * The uniform error every stubbed provider call site that has no better stand-in throws, in place of a real
 * network/component call. Every one of these call sites already has an established, separately-tested path for a
 * genuine provider failure (D16/D71/D74/D105/F11b, etc: a bad key, a dead page, a component POST failure) --
 * this reuses exactly that path rather than inventing a new one, so a stubbed run exercises the same "truthful
 * failure" UI/state the suite already asserts on instead of a fabricated success.
 */
export function stubbedProviderError(provider: string, detail?: string): ConvexError<string> {
  return new ConvexError(
    `RECOUP_PROVIDER_MODE=stub: ${provider} is stubbed for e2e${detail ? ` (${detail})` : ""}; no live call was made.`,
  );
}

/**
 * A deterministic, per-user synthetic inbox -- the one call site (AgentMail inbox creation,
 * `profiles.ts`'s `createInboxRemote`) where a fixed FAILURE would break every flow downstream of having an
 * inbox at all (drafts, claims), so this stands in with a fixed SUCCESS instead, on the same reserved `.example`
 * domain `convex/testing.ts`'s `seedInbox` already uses for the same reason.
 */
export function stubInboxFor(userId: string): { inboxId: string; inboxEmail: string } {
  const suffix = userId.slice(-8).toLowerCase();
  return {
    inboxId: `stub-inbox-${suffix}`,
    inboxEmail: `recoup-stub-${suffix}@${STUB_INBOX_DOMAIN}`,
  };
}
