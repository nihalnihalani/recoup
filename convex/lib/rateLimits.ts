/**
 * Named per-key rate limits backed by `@convex-dev/rate-limiter` (D64, T01).
 *
 * One `RateLimiter` instance for the whole app so every named limit shares the
 * same mounted `components.rateLimiter`. Callers pass a `key` to scope a limit
 * to one identity (e.g. a normalized email); a limit called with no `key` is a
 * single deployment-wide bucket.
 */
import { RateLimiter, MINUTE, HOUR } from "@convex-dev/rate-limiter";
import { components } from "../_generated/api";

export const rateLimiter = new RateLimiter(components.rateLimiter, {
  /** Sign-in/verify/reset attempts, keyed by the normalized email (T05). Token bucket so a burst of legitimate retries (typo, resend) is not immediately refused. */
  authAttempt: { kind: "token bucket", rate: 10, period: 10 * MINUTE, capacity: 10 },
  /** Verification/reset codes sent to one address (T05). */
  authMailPerEmail: { kind: "fixed window", rate: 3, period: HOUR },
  /** Verification/reset codes sent across all addresses, deployment-wide (T05). */
  authMailGlobal: { kind: "fixed window", rate: 200, period: HOUR },
  /** AgentMail inbox provisioning per user (T18 reprovision / signUp race guard). */
  inboxProvision: { kind: "fixed window", rate: 1, period: 5 * MINUTE },
  /** Manual "recheck now" on one stalled mailLog row (T06). */
  dropRecheck: { kind: "fixed window", rate: 1, period: MINUTE },
});
