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
  /**
   * `signUp` attempts (T05.1 F5), consumed *before* any `users`/`authAccounts`
   * row is created. Per-address only (keyed by the normalized email): a
   * coarse floor stopping a targeted burst of signUps against one address
   * from creating rows before the tighter `authMailPerEmail` cap is ever
   * reached (that one only fires once verification mail actually sends).
   * The deployment-wide counterpart is the separate `authSignUpGlobal`
   * config below (N4, D99) — they used to share this one name and rate,
   * which meant a 20/hour *global* cap on signUps across every address,
   * i.e. a self-inflicted registration lockout, not an abuse control.
   */
  authSignUp: { kind: "fixed window", rate: 20, period: HOUR },
  /**
   * N4 (D99): deployment-wide `signUp` ceiling, independent of the
   * per-address `authSignUp` bucket above. Token bucket (not fixed window)
   * so a legitimate burst right after a marketing push isn't punished by
   * landing on a hard window edge; 200/hour, default capacity 200 (== rate,
   * per the component's `configWithDefaults`) so it also starts full.
   */
  authSignUpGlobal: { kind: "token bucket", rate: 200, period: HOUR },
  /** AgentMail inbox provisioning per user (T18 reprovision / signUp race guard). */
  inboxProvision: { kind: "fixed window", rate: 1, period: 5 * MINUTE },
  /** Manual "recheck now" on one stalled mailLog row (T06). */
  dropRecheck: { kind: "fixed window", rate: 1, period: MINUTE },
});
