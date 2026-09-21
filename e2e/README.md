# Browser acceptance suite (T20, P10, D104)

Playwright drives a real Chromium against the real app (`npm run dev`, Vite
on `http://localhost:5173`) talking to the disposable Convex dev deployment
`adorable-lion-138` (D83 item 3). There is no mock backend and no test
build: every spec exercises the actual UI and the actual Convex functions.

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
- Placeholder values for the mail/AI/scrape provider keys (AgentMail,
  OpenAI, Firecrawl/ShopSavvy) rather than real ones. See "Why provider
  steps assert error states" below — this is intentional, not a
  misconfiguration to fix.
- No production host anywhere in the chain: not as `CONVEX_DEPLOYMENT`, not
  as `VITE_CONVEX_URL`/`VITE_CONVEX_SITE_URL` in `.env.local`, not as
  `E2E_BASE_URL`.

The suite reads which deployment to target from `CONVEX_DEPLOYMENT` if it is
already set in the environment (CI), otherwise it parses the
`CONVEX_DEPLOYMENT=…` line out of `.env.local` (the same file `npx convex
dev` itself writes — see `resolveDeployment()` in `e2e/fixtures.ts`). Seeding
and reset calls shell out to the locally installed Convex CLI
(`node_modules/.bin/convex run testing:<fn> '<json>'`), the same mechanism a
human operator would use, because `convex/testing.ts`'s exports are
`internal` — deliberately unreachable from the browser client itself.

## Why provider-dependent steps assert an error state, not success

`adorable-lion-138`'s AgentMail/OpenAI/ShopSavvy keys are placeholders (D83
item 3), so any step that actually calls one of those providers — a fresh
watch's first price check, "Check price now", draft generation (`Write the
message`) — genuinely fails on this deployment. The suite treats that as the
**correct, expected outcome** and asserts the truthful failure state the UI
is supposed to show (a real note like "No price last time: …", a rendered
`ErrorBox`/`role=alert`), never a fabricated success. This mirrors D104: real
provider calls stay in a separate, untagged `smoke` suite (not part of this
one, and not yet written — nothing in this deployment's current scope needs
it) that would run with real keys and is never part of CI.

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
- CI (`.github/workflows/ci.yml`'s `e2e` job, T17): only runs when
  `E2E_CONVEX_URL`/`E2E_DEPLOY_KEY` secrets are configured, and uploads
  `playwright-report/` as a build artifact on every run.

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

## Test triage: `test.fixme` vs a truthful pass

- A test that fails because of a **real product defect** stays in the suite,
  written correctly, and is marked `test.fixme("...reason...", async (...) =>
  {...})` — Playwright reports it as skipped (not a false green, not a red
  CI run) and the reason string carries the finding. Six tests in
  `resilience.spec.ts`'s axe describe block are `test.fixme` right now (see
  "Known findings" below) — they are not weakened assertions, they are the
  real `expect(serious).toEqual([])` check, just not required to pass until
  the defect they found is fixed.
- A step that is **provider-dependent** (calls OpenAI/Firecrawl/AgentMail
  with this deployment's placeholder keys) is never skipped: the spec
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
  actually succeeds, which it does not on `adorable-lion-138` with a
  placeholder OpenAI key (see above). A future `smoke`-style run against a
  deployment with a real key would additionally exercise that branch for
  real every time.
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
