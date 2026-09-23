# Browser acceptance suite (T20, P10, D104)

Playwright drives a real Chromium against the real app (`npm run dev`, Vite
on `http://localhost:5173`) talking to the disposable Convex dev deployment
`adorable-lion-138` (D83 item 3). There is no mock backend and no test
build: every spec exercises the actual UI and the actual Convex functions.

## Provider stub mode (`RECOUP_PROVIDER_MODE`, P10-OW-12)

**`adorable-lion-138` now carries real Firecrawl/OpenAI/ShopSavvy/AgentMail
keys** (this changed after this suite was first written — see "Why
provider-dependent steps assert an error state" below for the history). A
run of this suite against that deployment MUST set `RECOUP_PROVIDER_MODE=stub`
in the deployment's own environment, or every provider-backed step (a fresh
watch's first price check, "I bought it", "Check price now", draft
generation, a claim/drop email, inbox provisioning) makes a real,
quota-spending, possibly-merchant-facing call.

- **`e2e/global-setup.ts` enforces this itself**, before any spec runs: it
  calls `convex/testing.ts`'s `providerMode` query (gated exactly like every
  other export there — `E2E_SEED_ENABLED=true`, never the production host)
  and fails the whole Playwright run if the target does not report
  `"stub"`. There is no way to accidentally run the mocked suite against a
  non-stub deployment; the run refuses to start.
- **Stub mode is fail-closed by default, not just against production**
  (`convex/lib/providerMode.ts`, QA2-3): every call site checks
  `providerStubMode()` on every call, and that function throws (and logs
  loudly) rather than ever returning `true` UNLESS there is a *positive*
  dev/E2E signal — `CONVEX_SITE_URL` is `adorable-lion-138` (the same
  `isDevDeployment` check `convex/http.ts`'s CORS allowlist uses) **or**
  `E2E_SEED_ENABLED=true` (never set on production) — and, even then, still
  refuses outright if `CONVEX_SITE_URL` matches the documented production
  host (`cool-oyster-399`), defense in depth. An unset, unknown or
  mis-configured deployment refuses by default; it does not silently enter
  stub mode.
- **Setting the flag is a lead/ops action**, not something a test run or
  this file can do: set the environment variable `RECOUP_PROVIDER_MODE` to
  the exact string `stub` on `adorable-lion-138`. See the "Provider call
  sites" list below for exactly what that flag changes.
- **The live-provider smoke spec is the opposite case**: `e2e/smoke/live-provider.spec.ts`
  (P10-OW-12b) exists specifically to run against a deployment that is
  **NOT** in stub mode, and refuses to run against `adorable-lion-138` or
  the production host. It is opt-in only (`RECOUP_LIVE_SMOKE=1` plus two
  more env vars — see that file's own header) and never runs in CI.
  It runs under its **own** Playwright config, `playwright.smoke.config.ts`
  — `npx playwright test --config=playwright.smoke.config.ts` — never under
  the plain `npx playwright test` above (QA2-1): the main config's
  `globalSetup` *requires* stub mode, the opposite of what this spec needs,
  so the two configs partition `e2e/` (`testIgnore: "smoke/**"` on the main
  one, `testDir: "./e2e/smoke"` on the smoke one) rather than ever both
  applying to one run. `convex/lib/e2eSmokeSeparation.static.test.ts` pins
  that split staying true.

### Provider call sites this covers

Every outbound Firecrawl/OpenAI/ShopSavvy/AgentMail-**send** call in `convex/`
checks `providerStubMode()` (`convex/lib/providerMode.ts`) before it fires:

| Provider call | File | What stub mode does instead |
| --- | --- | --- |
| OpenAI extract/draft | `convex/lib/ai.ts` `extract()` (single choke point: `policies.ts`, `priceWatch.ts`, `offers.ts`-adjacent price reads, `replies.ts`, `drafts.ts generate` all call this) | Throws a stub error; each caller's own already-tested failure path records it (never a fabricated extraction) |
| Firecrawl scrape | `convex/priceWatch.ts` `observePrice()` (shared by `priceWatch.checkItem` and `watches.checkWatch`) | Throws; recorded as a truthful "Price check failed" note, same as any real scrape failure |
| Firecrawl search | `convex/offers.ts` `searchDep()`, `convex/policies.ts` `searchDep()` | Throws; each caller's own catch records a "search failed" / confidence-0 outcome |
| ShopSavvy | `convex/market.ts` `fetchSnapshot()` | Returns `{ kind: "not_configured" }` — the same calm no-op a genuinely unset key already produces |
| AgentMail inbox creation | `convex/profiles.ts` `createInboxRemote()` | Returns a **fixed success**: a deterministic, per-user synthetic inbox on the reserved `inbox.e2e.example` domain (every flow downstream of having an inbox needs one to work with) |
| AgentMail send (claim email) | `convex/drafts.ts` `enqueueClaimEmail()` | Throws before the component call; no e2e spec today reaches a confirmed-recipient send, so this changes no currently-tested behavior |
| AgentMail send (price-drop alert) | `convex/notify.ts` `sendDrop()` | Throws inside the existing try/catch; recorded as `status: "failed", reason: "send_failed"`, same as a real send failure |
| AgentMail send (auth verify/reset code) | `convex/lib/authMail.ts` `sendViaProvider()` | Throws; `authMailTransport.send`'s existing `E2E_SEED_ENABLED` catch swallows it exactly as it already does for a keyless deployment |

**Known gap, not yet fully closed (QA2-4):** `convex/account.ts`'s
`inboxTransport.deleteInbox` (a raw AgentMail `DELETE`) does **not** check
`providerStubMode()`. `convex/profiles.ts`'s `ensureInbox` race-loser path
(the one call site this lane owns) now skips it in stub mode — the inbox it
would delete there is always one THIS call itself just created, so in stub
mode it is always a synthetic `stub-inbox-*` id, never a real one. The
account-deletion purge call site (`convex/account.ts`, owned by a different
lane) is **still unguarded**: an account purge that races stub mode being on
would issue a real `DELETE` for a `stub-inbox-*` id. No current spec reaches
that path, so the risk is latent, not exercised by this suite today — see
this lane's report for the requested follow-up.

Unit tests for every one of these live next to the real call: `convex/lib/providerMode.test.ts` (the
core switch) plus a `describe("P10-OW-12: RECOUP_PROVIDER_MODE=stub", ...)`
block in `convex/lib/ai.test.ts`, `convex/priceWatch.test.ts`,
`convex/market.test.ts`, `convex/offers.test.ts`, `convex/policies.test.ts`,
`convex/profiles.test.ts`, `convex/lib/authMail.test.ts`,
`convex/notify.test.ts`, `convex/drafts.test.ts` and `convex/testing.test.ts`.

## Running locally

```sh
npm ci
npx playwright install chromium   # once, or after a Playwright version bump
npx playwright test               # full suite, both projects
npm run e2e                       # same thing (added script)

# One file, one project, headed, whatever you need while iterating:
npx playwright test e2e/watches.spec.ts --project=desktop-chromium
npx playwright test --headed --debug
npx playwright show-report        # after a run, opens the HTML report
```

`playwright.config.ts` starts `npm run dev` for you (`webServer`) unless
`E2E_BASE_URL` is already set, in which case it assumes something is already
serving the app there and does not spawn a server. `workers: 1` and
`fullyParallel: false` are deliberate: every spec seeds, reads or mutates
rows on the one shared deployment (see "Why one worker" below), so tests run
strictly sequentially, one file at a time, in declaration order within a
file.

## What the deployment must have

- `E2E_SEED_ENABLED=true` in that deployment's environment. This is what
  gates every export of `convex/testing.ts` (T20a, D95/D102) — without it,
  every seed/reset call throws, on purpose. **Never set this on a production
  deployment.**
- `CONVEX_SITE_URL` that does not contain the documented production host
  (`cool-oyster-399`) — `testing.ts` refuses to run if it does, even with
  `E2E_SEED_ENABLED=true`, and `e2e/fixtures.ts` adds its own client-side
  check on top (`assertSafeDeployment`, fails fast with a clear message
  instead of relying only on the server-side guard).
- `RECOUP_PROVIDER_MODE=stub` (P10-OW-12, see above). The deployment now
  carries **real** mail/AI/scrape provider keys (AgentMail, OpenAI,
  Firecrawl/ShopSavvy), so this flag — not a placeholder key — is what keeps
  the mocked suite from making live provider calls. `e2e/global-setup.ts`
  refuses to run the suite at all if this is not set to `"stub"`.
- No production host anywhere in the chain: not as `CONVEX_DEPLOYMENT`, not
  as `VITE_CONVEX_URL`/`VITE_CONVEX_SITE_URL` in `.env.local`, not as
  `E2E_BASE_URL`.

### Which deployment the suite seeds (`resolveTarget()` in `e2e/fixtures.ts`)

- **Locally (unchanged):** `CONVEX_DEPLOYMENT` from the environment if set,
  otherwise the `CONVEX_DEPLOYMENT=…` line of `.env.local` (the file
  `npx convex dev` writes). The browser side gets `VITE_CONVEX_URL` from
  `.env.local` through Vite as usual.
- **With `E2E_DEPLOY_KEY` set (CI, M08/QA-9):** seeding uses that deploy
  key as the CLI's `CONVEX_DEPLOY_KEY` (and drops `CONVEX_DEPLOYMENT`).
  - Only the key's non-secret `<kind>:<deployment>` prefix is ever checked
    or printed, and only `dev:`/`prod:` keys are accepted.
  - `playwright.config.ts` starts the dev server with
    `VITE_CONVEX_URL = VITE_CONVEX_URL || E2E_CONVEX_URL` (unless
    `E2E_BASE_URL` points at an already running app). An empty value, as an
    unset GitHub secret arrives, counts as unset.
  - The deployment named in the key must match the host of `E2E_CONVEX_URL`
    and `VITE_CONVEX_URL` when they are set, so seeding and the browser can
    never talk to two different deployments.
  - A deployment other than `adorable-lion-138` needs
    `E2E_ALLOW_UNKNOWN_DEPLOYMENT=true` (the CI job sets it). Under `CI` the
    shared `adorable-lion-138` is refused outright: CI uses a dedicated E2E
    deployment (`docs/ops/RELEASE.md` §4).
- **Always:** the production deployment `cool-oyster-399` is refused
  wherever it appears: the target deployment, the key, `E2E_CONVEX_URL`,
  `VITE_CONVEX_URL` or `E2E_BASE_URL`.

Seeding and reset calls shell out to the locally installed Convex CLI
(`node_modules/.bin/convex run testing:<fn> '<json>'`), the same mechanism a
human operator would use, because `convex/testing.ts`'s exports are
`internal` — deliberately unreachable from the browser client itself.

## Why provider-dependent steps assert an error state, not success

Originally (D83 item 3) `adorable-lion-138`'s AgentMail/OpenAI/ShopSavvy
keys were placeholders, so any step that actually called one of those
providers genuinely failed on this deployment, for real. **That is no
longer true of the keys** — the deployment now carries real ones — **but it
is still true of the suite's behavior**, now via `RECOUP_PROVIDER_MODE=stub`
(P10-OW-12, see above) rather than an absent key: every provider call site
still throws (or, for inbox creation, returns a fixed stand-in) instead of
reaching the real provider, so a fresh watch's first price check, "Check
price now" and draft generation (`Write the message`) still, deliberately,
fail. The suite treats that as the **correct, expected outcome** and asserts
the truthful failure state the UI is supposed to show (a real note like "No
price last time: …", a rendered `ErrorBox`/`role=alert`), never a fabricated
success. This mirrors D104: real provider calls stay in a separate suite,
`e2e/smoke/live-provider.spec.ts` (P10-OW-12b) — opt-in only
(`RECOUP_LIVE_SMOKE=1` plus two more env vars, see that file's header),
never part of CI, and refuses to run against `adorable-lion-138` or
production.

Two consequences worth knowing before you touch these specs:

- `claims.spec.ts`'s draft-generation test is written to handle **either**
  outcome: if generation fails (the expected case here), it asserts the
  error is shown; if it happens to succeed (e.g. run against a deployment
  with a real OpenAI key), it falls through to actually exercising the
  recipient-confirm checkbox and the "approve without confirming" gate. It
  never assumes success and never fakes it.
- `watches.spec.ts`'s "create a watch" test asserts the specific truthful
  failure shape the UI renders (`watches.ts`'s `recordWatchCheck`: price
  stays `null`, a note like "No price last time: Price check failed: …"),
  not just "no crash".

## Why one worker (`workers: 1`, `fullyParallel: false`)

All specs share one Convex deployment that also carries **global** state:
auth rate limits (`AUTH_ATTEMPTS_PER_EMAIL`, `AUTH_MAIL_PER_EMAIL`,
`AUTH_MAIL_GLOBAL`) and daily spend budgets other lanes' backend tests
reason about independently. Two workers seeding/signing-up concurrently
could trip a limiter meant for one test and turn an unrelated test flaky.
Each spec file also calls `seedLead()` in its own `beforeAll` — a
`resetUser` + `seedUser` + `seedFixtures` round-trip against the single
shared `e2e.lead@example.com` fixture account — so files must not run
concurrently or they would stomp on each other's seed. Per-test **fresh**
accounts (`e2e.<runId>.<n>@example.com`, from the `newEmail` fixture) don't
have this problem and are used wherever a spec needs an account of its own
rather than the shared read-mostly fixture set.

**Do not override `--workers` above 1 for this suite — this is a confirmed
finding, not a style preference (F-T23-2, `docs/team/DECISIONS.md` D125;
re-confirmed as F-AUD-11 in `docs/team/CONNECTIONS.md`).** T23's Phase 4
verification ran this suite with `npx playwright test --reporter=line
--workers=2` (an explicit instruction, not this config's default) and
reproduced exactly the race this section predicts: two spec files under the
same project concurrently called `testing:resetUser`/`seedUser`/
`seedFixtures` against the same shared `e2e.lead@example.com` address,
producing `ConvexError: seedFixtures: user not found`. The same run at the
config's own `workers: 1` passed clean. **Neither this config nor
`.github/workflows/ci.yml`'s `e2e` job currently enforces `workers: 1`
programmatically** — `playwright.config.ts`'s `workers: 1` is the default,
but any `--workers` CLI flag on top of `npx playwright test`/`npm run e2e`
silently overrides it, and CI does not pass `--workers=1` explicitly (it
relies on the config default only). If either changes, add an explicit
`--workers=1` at the call site rather than trusting the default alone. Until
`e2e/fixtures.ts` gives every spec file (not just every project) a fully
unique lead account — the same fix `leadEmailFor()`'s own doc comment
describes for the desktop-vs-mobile case, generalized to per-file — treat
any `--workers` override above 1 as producing false-negative failures that
look like real regressions, not evidence of a new defect.

## Artifact locations

- HTML report: `playwright-report/index.html` (open with `npx playwright
  show-report`).
- Traces (`trace: "on-first-retry"`), screenshots (`only-on-failure`) and
  videos (`retain-on-failure`): under `test-results/<test-name>/` per
  failed/retried test. Open a trace with `npx playwright show-trace
  test-results/.../trace.zip`.
- None of the above are committed (`.gitignore`: `/test-results/`,
  `/playwright-report/`, `/blob-report/`, `/playwright/.cache/`).
- CI (`.github/workflows/ci.yml`'s `e2e` job): runs only when the
  `E2E_CONVEX_URL`/`E2E_DEPLOY_KEY` repo secrets are configured (not yet
  provisioned). Without them the `e2e: secrets configured?` job raises a
  `::warning title=e2e skipped: secrets not configured::` annotation and a
  step-summary line, and the `e2e` job itself shows as **skipped**, never as a
  green job that ran nothing (KC1; kept by
  `convex/testing/ciWorkflow.static.test.ts`). When it runs, it uploads `playwright-report/` as a build
  artifact. The dedicated deployment needs `E2E_SEED_ENABLED=true`,
  `RECOUP_PROVIDER_MODE=stub` (P10-OW-12, see above — `e2e/global-setup.ts`
  now refuses the whole run without it, on any deployment), placeholder or
  real provider keys (stub mode makes the distinction irrelevant for this
  job) and the commit's functions already deployed; the job does not
  deploy.

## File map

- `playwright.config.ts` — projects (`desktop-chromium` 1280x800,
  `mobile` Pixel 5 emulation), retries, trace/screenshot/video policy,
  `webServer`.
- `e2e/fixtures.ts` — the `convex/testing.ts` CLI wrapper, unique per-test
  email generation, `signInFresh`/`signInSeeded`/`signOut`, and the
  extended `test` (auto-cleanup of fresh accounts via the `newEmail`
  fixture).
- `e2e/auth.spec.ts` — sign-up → code → verified session; identical
  wrong-password copy for a known vs. unknown address; reset reaches the
  code step with the same neutral notice either way; sign-out; a direct
  route survives a hard reload.
- `e2e/watches.spec.ts` — creating a watch shows the truthful check-failed
  state; pause/resume; "I bought it" converts a fresh watch to a purchase
  with a claim-window meter.
- `e2e/purchases.spec.ts` — the price-adjustment policy card (retrieved,
  confirmed) and the tracked item's paid/current/lowest price table.
- `e2e/claims.spec.ts` — draft generation (provider-dependent, see above);
  ledger: confirming a credit updates the unresolved balance, a later
  charge shows as "Charged again".
- `e2e/resilience.spec.ts` — malformed/foreign ids never blank the screen
  (focused heading, "Go to board"); keyboard-only sign-in and
  confirm-credit; axe scan (no serious/critical violations) on Board,
  Watching, Settings, a Purchase and a Claim.
- `e2e/isolation.spec.ts` — user B cannot reach user A's purchase/claim by
  URL and sees none of A's data; A's board/watchlist never surfaces
  something B created.
- `e2e/global-setup.ts` — fails the whole run before any spec starts unless
  the target deployment reports `RECOUP_PROVIDER_MODE=stub` (P10-OW-12).
- `e2e/smoke/live-provider.spec.ts` — the separate, opt-in, never-in-CI
  live-provider smoke spec (P10-OW-12b); see its own header. Run only via
  `npx playwright test --config=playwright.smoke.config.ts` (QA2-1) — the
  plain `npx playwright test` above never reaches it (`testIgnore`).

## Test triage: `test.fixme` vs a truthful pass

- A test that fails because of a **real product defect** stays in the suite,
  written correctly, and is marked `test.fixme("...reason...", async (...) =>
  {...})` — Playwright reports it as skipped (not a false green, not a red
  CI run) and the reason string carries the finding. Six tests in
  `resilience.spec.ts`'s axe describe block are `test.fixme` right now (see
  "Known findings" below) — they are not weakened assertions, they are the
  real `expect(serious).toEqual([])` check, just not required to pass until
  the defect they found is fixed.
- A step that is **provider-dependent** (calls OpenAI/Firecrawl/AgentMail,
  stubbed via `RECOUP_PROVIDER_MODE=stub`, P10-OW-12) is never skipped: the spec
  asserts the truthful failure state instead (see "Why provider-dependent
  steps..." above). `claims.spec.ts`'s draft-generation test is the
  clearest example — it is written to pass either way (truthful failure, or
  the real recipient-confirm gate if a live key is ever configured), never
  `test.skip`.

## Known findings (real product defects the suite found)

- **Color contrast, WCAG 2 AA (axe `color-contrast`, impact "serious").**
  Every authenticated page shares `Shell`/`Sidebar.tsx`/`TopBar.tsx`/
  `UserCard.tsx`, and several of their fixed `text-gray-400`-on-white labels
  measure 2.6:1 contrast against the 4.5:1 WCAG AA minimum for normal-size
  text: Sidebar's "Main menu" heading, TopBar's breadcrumb "Main Menu" item
  and command-palette "Search anything…" placeholder, and UserCard's "Inbox
  not set up yet" placeholder subtitle. `NotificationBell`'s unread-count
  badge (white on `bg-red-500`) measures 3.76:1, also below 4.5:1.
  Reproduced identically on Board, Watching, Settings, a Purchase page and a
  Claim page, on both the `desktop-chromium` and `mobile` projects. Five
  `test.fixme` tests in `resilience.spec.ts` (the `Board`/`Watching`/
  `Settings` loop plus the Purchase and Claim axe tests) carry this finding
  and the exact selectors/colors.
- **Color contrast, `src/App.tsx`'s `<AuthLoading>` splash.** The plain
  "Loading…" screen shown while Convex is still resolving the session
  (`<div className="flex min-h-screen items-center justify-center bg-paper
  text-sm text-ink/50">Loading…</div>`) measures 3.4:1 (`text-ink/50` on
  `bg-paper`), also below 4.5:1. Reachable any time a signed-in tab does a
  full navigation (not just first load), so it is real, hit-able markup, not
  a cold-start-only artifact. Its own dedicated `test.fixme` in
  `resilience.spec.ts`.
- None of the four files above (`Shell.tsx`, `Sidebar.tsx`, `TopBar.tsx`,
  `UserCard.tsx`, `NotificationBell.tsx`, `App.tsx`) are `e2e/**`'s to fix;
  these are flagged for the frontend owner rather than patched here.

## Known gaps

- No lifecycle (export/delete) specs yet — D104: those land once T18/T19
  (account export/deletion UI) ship.
- The recipient-confirm-checkbox and approve-without-confirming flow in
  `claims.spec.ts` is only exercised end-to-end when draft generation
  actually succeeds, which it does not under `RECOUP_PROVIDER_MODE=stub`
  (see above — `adorable-lion-138` now has a real OpenAI key, but the mocked
  suite must never spend it). `e2e/smoke/live-provider.spec.ts` (P10-OW-12b)
  exercises approve/enqueue for real, opt-in only, against a deployment with
  a real key and NOT in stub mode.
- `resilience.spec.ts` covers Board/Watching/Settings/a Purchase/a Claim for
  axe; it does not scan the sign-in screen itself (unauthenticated) or the
  error-boundary fallback screens — both are small enough surfaces that a
  manual pass covered them, but they are not automated here.
- Running the **full** suite (all six files, both projects) back-to-back
  during active development shares one deployment-wide, per-email
  `authAttempt` rate limit (10 per 10 minutes, `convex/auth.ts`) across
  every file's own real sign-ins; in a clean run (CI, or any run not
  preceded by many manual iterations against the same seeded addresses in a
  short window) this is not an issue — `leadPage` signs in at most once per
  worker for the whole run (see `e2e/fixtures.ts`) — but be aware of it if
  you are iterating locally file-by-file in a tight loop.
