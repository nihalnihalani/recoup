# Environment variables

Owner: T22 (P12 operations and docs). Source contract: `docs/team/PLAN.md`
T22, `docs/team/DECISIONS.md` D62 (env var names by deployment),
`docs/reviews/2026-09-21-phase0-reproduction.md` P12 ("Missing docs for
SHOPSAVVY_API_KEY, ALERTS_INBOX_ID, and APP_URL").

This is every environment variable this app's own code reads (from
`process.env`, not a component's), grepped and verified against the source
listed for each one, not copied from memory. Component-internal env
(`FIRECRAWL_API_KEY`/`AGENTMAIL_API_KEY` bound into the `agentmail`/
`firecrawl` components via `convex/convex.config.ts`'s `app.use(x, { env })`)
is listed once, under the app-level name — you never set anything on the
component itself.

**How to set a server-side value:** `npx convex env set NAME value` against
the deployment you mean (check `npx convex env list` first). Never put a
secret in this repo, in `.env.example`, or in any doc, including this one.

**Client-side values** live in `.env.local` (see `.env.example`); they are
public (bundled into the built JS, readable by anyone), and `npx convex dev`
writes them for you when it links a deployment.

## Platform-provided — never set these by hand

| Name | Set by | Used for |
|---|---|---|
| `CONVEX_SITE_URL` | The Convex platform, automatically, on every deployment | `convex/auth.config.ts`'s JWT issuer `domain`; the production-host refusal check in `convex/testing.ts` and `convex/lib/authMail.ts`'s E2E code-capture hook (see "E2E-only" below); the unsubscribe link's origin in `convex/notify.ts` (`unsubscribeBase`, HTTPS-only, never localhost) |
| `CONVEX_DEPLOYMENT` | `npx convex dev`, written to `.env.local` | Which deployment the CLI (`convex dev`, `convex env`, `convex codegen`, …) targets locally. Not read by application code. |

`CONVEX_CLOUD_URL` is also platform-provided but this app's code does not
currently read it directly (only via the generated `VITE_CONVEX_URL` on the
client — see below).

## Client-side (build-time, public, `.env.local`)

| Name | Required | Used for |
|---|---|---|
| `VITE_CONVEX_URL` | **Yes.** Missing or non-`https://` → `src/main.tsx` renders a static `<ConfigMissing/>` page instead of constructing `ConvexReactClient` (no broken app, no thrown error) | The Convex client's own deployment URL (`*.convex.cloud`) |
| `VITE_CONVEX_SITE_URL` | No — written by `npx convex dev` for convenience but not currently read by any `src/` code (grepped; no hit) | Reserved for the same deployment's HTTP-actions origin (`*.convex.site`), if a future feature needs to build a link to it client-side |

`scripts/smoke.mjs`'s "bundle references exactly one `.convex.cloud` host"
check is really checking that exactly one `VITE_CONVEX_URL` value got baked
into the shipped build — see `docs/ops/RUNBOOK.md`.

## Server-side secrets required for the deployment to work at all

Without these, `npx convex deploy`/`convex dev` itself fails (the two marked
"deploy-blocking") or every sign-in/sign-up breaks outright (the auth trio).

| Name | Required by | Enables | If unset |
|---|---|---|---|
| `FIRECRAWL_API_KEY` | `convex/convex.config.ts`'s typed `env` (`app.use(firecrawl, { env: { FIRECRAWL_API_KEY: ... } })`) | Policy search/scrape (`convex/policies.ts`), product-page price reads for owned items and watches (`convex/priceWatch.ts`, `convex/watches.ts`) | **Deploy-blocking**: `npx convex deploy`/`dev` refuses to push until it is set (D62) |
| `AGENTMAIL_API_KEY` | `convex/convex.config.ts`'s typed `env` (`app.use(agentmail, { env: { AGENTMAIL_API_KEY: ... } })`) | Inbox creation (`convex/profiles.ts`), outbound claim-email send (`convex/drafts.ts` via the component), auth verification/reset mail (`convex/lib/authMail.ts`) | **Deploy-blocking**, same as above. The value only reaches the component's isolated runtime because `patches/@agentmail+convex+0.1.0.patch` adds an `env` declaration to it — see `docs/ops/INSTALL.md` |
| `JWT_PRIVATE_KEY`, `JWKS`, `SITE_URL` | Convex Auth (`@convex-dev/auth`) | Session tokens and the OpenID configuration/JWKS routes `auth.addHttpRoutes` registers (`GET /.well-known/openid-configuration`, `GET /.well-known/jwks.json` — what `scripts/smoke.mjs` checks). Set together by running `npx @convex-dev/auth` once against a deployment | Every sign-in/sign-up breaks (`ctx.auth.getUserIdentity()` never resolves without a working `auth.config.ts` domain + keys) |

## Server-side secrets required for one feature; the rest of the app stays healthy without them

Every one of these fails closed at call time — a missing key never crashes
an unrelated request, per the invariant tested throughout this codebase
(D12(c): "the AgentMail handle does not throw at import when
`AGENTMAIL_API_KEY` is absent; checks happen at call time").

| Name | Required by | Enables | If unset |
|---|---|---|---|
| `AGENTMAIL_WEBHOOK_SECRET` | `convex/http.ts`'s `POST /agentmail/webhook` route (the component's `agentmail.handleWebhook`) | Verifying and accepting inbound mail (order confirmations, replies) | The component's own `assertConfigured("webhook")` throws a plain `Error` (not a `ConvexError`, not caught anywhere in this app's `http.ts`) the moment a webhook POST arrives, which Convex turns into a bare **500**, not a clean 401/403 — confirmed live against the `adorable-lion-138` dev deployment (`AGENTMAIL_WEBHOOK_SECRET` unset there), not just read from the library source. `scripts/smoke.mjs`'s webhook check expects 401 (a real signing secret rejecting a wrong/missing signature) and will correctly report **FAIL** on a deployment where the secret was never set at all — that is a distinct condition from "secret is set but the signature is wrong", and the smoke table's detail column says which one happened. No inbound webhook event is ever applied either way (fails closed) — this is the accepted state, not a regression (D35) |
| `OPENAI_API_KEY` | `convex/lib/ai.ts` | Every model call: order/price/policy extraction, reply classification, draft generation | Throws `Error("OPENAI_API_KEY is not set on this deployment")` at the first call inside the action that needed it; the surrounding job/event is recorded as failed (e.g. `processedEvents.status = "failed"`), never left silently stuck |
| `ALERTS_INBOX_ID` | `convex/lib/authMail.ts` (verify/reset codes) directly; `convex/notify.ts` (price-drop alerts) with a fallback | Which AgentMail inbox sends auth verification/reset codes and price-drop alert mail | **Auth mail**: `sendViaProvider` throws `ConvexError("Could not send the email right now")` if either this or `AGENTMAIL_API_KEY` is missing — sign-up/reset codes cannot be delivered (the E2E harness works around this in its own gated path; see below). **Price-drop alerts**: `notify.ts` falls back to the recipient's own profile inbox id (`profile?.inboxId`) when this is unset, so alerts can still go out from the user's own Recoup inbox instead of a shared one |

## Optional, with a safe default or graceful no-op

| Name | Default when unset | Enables |
|---|---|---|
| `SHOPSAVVY_API_KEY` | `convex/market.ts`'s `fetchSnapshot` returns `null` immediately (no network call, no charge) and `market.requestLookup` patches the watch to `marketState: "not_configured"` | Third-party price-history lookups (`marketPrices`, the "other stores" market panel). A completely optional feature — the rest of the app (Recoup's own price reads, claims, alerts) works identically without it |
| `AGENTMAIL_BASE_URL` | `https://api.agentmail.to/v0` (`convex/lib/authMail.ts`, `convex/profiles.ts`) | Overriding the AgentMail API origin (staging/testing only; there is no reason to set this in a normal deployment) |
| `APP_URL` | Falls back to `SITE_URL`; if neither is a real non-localhost `https://` origin, `convex/notify.ts`'s `publicAppUrl()` returns `null` and the price-drop email simply omits the "open Recoup" link rather than ever printing a `localhost` URL (a dead link and a spam signal — found live, see `hackathon.md`'s build log) | Where a price-drop alert email links back to |

## E2E-only — never set on a production deployment

| Name | Value | Enables |
|---|---|---|
| `E2E_SEED_ENABLED` | Must be the exact string `"true"` (anything else, including unset, is treated as off) | `convex/testing.ts`'s internal seed/reset functions (`seedUser`, `seedFixtures`, `lastCodeFor`, `resetUser`) and `convex/lib/authMail.ts`'s E2E code-capture hook (so the Playwright suite can read back a real verification/reset code without a live mail provider) |

**Production refusal, independent of the flag itself (D83/D95/D102):** every
gated entry point — `convex/testing.ts`'s `assertE2EEnabled()` and
`convex/lib/authMail.ts`'s `recordE2ECode` — checks `CONVEX_SITE_URL` for a
substring match against the documented production host (`cool-oyster-399`)
and throws `ConvexError` if it matches, **regardless of what
`E2E_SEED_ENABLED` is set to**. That check runs every time, not only when
the flag is on, so a stray or leaked `E2E_SEED_ENABLED=true` on the
production deployment still cannot seed or reset real data, and cannot
capture a real user's verification code into `opsState`. Never set
`E2E_SEED_ENABLED` on the production deployment regardless; treat the
host check as defense in depth, not as the only guard.

**D107 (Opus checkpoint-5 recheck): this is not just a quiet no-op on
production — it is loud, and it breaks real auth.** `recordE2ECode`'s guard
is called from `convex/lib/authMail.ts`'s `authMailTransport.send`
*unconditionally and outside any try/catch* whenever
`E2E_SEED_ENABLED === "true"` — and `authMailTransport.send` is the same
code path every real sign-up verification code and password-reset code goes
through, not a separate E2E-only sender. So if `E2E_SEED_ENABLED=true` is
ever set on the production deployment, the production-host guard trips on
every single one of those calls, and the `ConvexError("E2E seeding is
disabled")` it throws propagates straight out of the real sign-up/reset
flow: **every sign-up and every password reset fails loudly** (not merely
"E2E fixtures silently don't seed") until the variable is removed. This is
by design — fail loud and closed beats fail quiet and open here — but it
means setting this flag on production is not a low-stakes mistake to leave
unset "just in case"; treat it as one of the variables to explicitly confirm
absent (`npx convex env list --prod`) before/after any production
environment change, not just at initial setup.

**The host guard itself is two independent, hand-maintained string
constants** — `PRODUCTION_HOST_MARKER` in `convex/testing.ts` and the
literal `"cool-oyster-399"` substring check in
`convex/lib/authMail.ts`'s `recordE2ECode` — not a single shared constant
and not derived from any deployment metadata. **If production ever moves to
a different deployment name, both of these must be updated together**. A
missed update would silently turn this guard into a no-op check against a
host that no longer exists, which would only be caught by the fact that
`E2E_SEED_ENABLED` should never be set on the real production deployment in
the first place — defense in depth, not the only guard, as above.

## CI-only — not read by the running application at all

| Name | Used by | Purpose |
|---|---|---|
| `CONVEX_URL`, `CONVEX_ADMIN_KEY` | `scripts/check-codegen.mjs` (`npm run codegen:check`) | Point the codegen-drift CI check at a dedicated Convex deployment. Not currently provisioned in CI — the check prints a skip notice and exits 0 until they are (see `docs/ops/INSTALL.md`) |

## Auth logging — explicitly forbidden, not a variable this app defines

`AUTH_LOG_LEVEL=DEBUG` and `AUTH_LOG_SECRETS=true` are `@convex-dev/auth`'s
own env vars (library-defined, not declared anywhere in this repo). **Never
set either one on any deployment reachable by real users** (D99/F12a): debug
auth logging at that level can print verification codes, session tokens, and
password-reset material to the function log. See `docs/ops/RUNBOOK.md` for
the full prohibition and what to do instead if you need to debug an auth
issue.
