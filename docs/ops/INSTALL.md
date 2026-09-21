# Install & CI gates

Owner: T17 (P11 reproducible installation and CI). Source contract:
`docs/team/PLAN.md` T17, `docs/team/DECISIONS.md` D78/D80,
`docs/reviews/2026-09-21-phase0-reproduction.md` (P11 rows).

## Node version

Pinned in `.nvmrc` and `package.json`'s `engines.node`: **Node 22.x**
(`>=22 <23`, currently verified against 22.23.2, the latest Jod LTS).
`npm ci` warns (`EBADENGINE`) but does not hard-fail on a different major —
CI uses `actions/setup-node` with `node-version-file: .nvmrc` so it always
runs the pinned version regardless. Locally:

```sh
nvm install   # reads .nvmrc
nvm use
```

## Supported install mode: full `npm ci`, with scripts

```sh
npm ci
```

This is the **only** supported install mode. Do not use `--omit=dev` and do
not use `--ignore-scripts`.

**Why `--omit=dev` is not supported.** `postinstall` runs
`patch-package --error-on-fail`, which applies
`patches/@agentmail+convex+0.1.0.patch`. That patch adds an `env` block
declaring `AGENTMAIL_API_KEY` to the `@agentmail/convex` Convex component
definition — without it, the component's isolated runtime cannot see the API
key at all and `performSend` throws `AGENTMAIL_API_KEY is not set` in
production (this is a real bug that was hit and fixed on commit `59a9df4`,
not a hypothetical one). `patch-package` itself is a `devDependency` (as is
all of this project's build tooling: `typescript`, `vite`, `vitest`). A
`--omit=dev` install:

- Skips installing `patch-package`, so `postinstall` fails outright
  (`sh: patch-package: command not found`, exit 127) — this is a loud,
  immediate failure, not the silent one the P11 finding originally worried
  about, but it still means the AgentMail crash-fix patch never gets applied
  if someone works around the failure (e.g. with `--ignore-scripts`).
- Skips `typescript`/`vite`, so `npm run build`/`npm run typecheck` cannot
  run at all.

This app has no server-side npm install step of its own — the Convex
backend's code is bundled from the developer's machine by `npx convex
deploy` (there is no `convex.json` `node.externalPackages` / server-side
`npm install`) — so there is no deployment context that would need a
"production-only" install profile in the first place. Every environment that
runs this repo's tooling (local dev, CI, `npx convex deploy`) needs the full
dependency set. `--ignore-scripts` is unsupported for the same reason:
skipping `postinstall` skips the patch.

If `node_modules/@agentmail/convex` is ever reinstalled without the patch
being reapplied (e.g. `npm install <some-other-package>` touching the tree),
`npm run verify:patch` (see below) will catch it — this is exactly the
failure mode recorded in `docs/team/VERIFICATION.md`: "found: patch-package
had not been applied in this tree (`npx patch-package` reran) → P11/T17 must
gate on it."

## Running every gate locally

```sh
npm ci                          # install (full, with scripts)
npm run verify:patch            # confirm the AgentMail patch actually applied
npm run typecheck               # tsc, app + convex
npm run lint -- --max-warnings=1   # oxlint; see "Known lint gap" below
npm run test:ci                 # vitest with a minimum-count + zero-test-file gate
npm run build                   # tsc -b && vite build
npm run codegen:check           # convex/_generated drift check; needs a deployment, see below
```

`npm test` (no `:ci` suffix) still exists for fast local iteration
(`vitest run`, no count gate) — it no longer has `--passWithNoTests`, so an
empty/misconfigured include glob fails loudly instead of exiting 0. `npm run
test:ci` is what CI actually gates on: it runs vitest itself with
`--reporter=json` (to a throwaway file, so console output from tests can
never corrupt the report) and fails if any test failed, fewer than 600 tests
ran in total, or any collected test file has zero tests in it. See
`scripts/check-test-count.mjs`.

### Known lint gap (do not suppress; do not widen)

`npm run lint -- --max-warnings=1` — the `1` is the **current** warning
count, not a permanent ceiling. It is
`convex/lib/passage.ts:25:28: warning eslint(no-useless-escape)`, in a file
owned by another lane (`docs/team/DECISIONS.md` D88 assigns
`convex/lib/passage.ts` lint fixes to T16). T17's scope excludes
`convex/**`, so this was left in place with the gate held at the current
count rather than either suppressed (`--max-warnings=0` would make every PR
fail for an unrelated pre-existing warning) or quietly raised further. Once
T16 fixes it, tighten this to `--max-warnings=0` in both this doc and
`.github/workflows/ci.yml`.

### `codegen:check` requires a live Convex deployment — this is a real limitation, not a bug

`npx convex codegen`, **with or without `--dry-run`**, always calls into the
Convex CLI's deployment-selection/credential-loading path
(`node_modules/convex/dist/esm/cli/codegen.js`), because it needs to read
component schemas (this repo mounts `agentmail`, `workpool`, `rate-limiter`,
`static-hosting`) from an existing deployment. It explicitly **refuses** a
preview `CONVEX_DEPLOY_KEY`:

> Codegen requires an existing deployment so doesn't support
> CONVEX_DEPLOY_KEY. Generate code in dev and commit it to the repo instead.

So there is no deployment-free mode for this check, in either form the T17
contract anticipated (`--dry-run`, or "run codegen into a temp copy and `git
diff --exit-code`"). `scripts/check-codegen.mjs` implements the temp-copy
form (an isolated `git worktree` at `HEAD`, `node_modules` symlinked in, real
`convex codegen` run there, then `git diff --exit-code -- convex/_generated`
inside the worktree — nothing is ever written back to your working tree),
and:

- **Locally**: if `.env.local` already has `CONVEX_DEPLOYMENT` set (i.e. you
  have run `npx convex dev` at least once), `npm run codegen:check` runs for
  real against that deployment.
- **In CI**: the `checks` job passes `CONVEX_URL` /
  `CONVEX_ADMIN_KEY` from repo secrets (`CODEGEN_CHECK_CONVEX_URL` /
  `CODEGEN_CHECK_CONVEX_ADMIN_KEY`). **Those secrets are not currently
  provisioned** — T17 does not have the access to create a dedicated
  CI/codegen Convex deployment or its admin key, and giving an ephemeral
  GitHub-hosted runner write-capable admin credentials to the team's shared
  dev deployment (`adorable-lion-138`) on every PR is not an acceptable
  substitute. Until a dedicated deployment + secret pair exists, the step
  prints a clear skip notice and exits 0 — it does not fail the required
  gate. **This is the "document if it does" case the T17 contract's risk
  note anticipated** ("`npx convex codegen` may require a linked deployment;
  document the fallback precisely rather than skipping the check" — it does
  require one, unconditionally, for a components-using project like this
  one; the precise fallback is above).
- Whoever provisions the dedicated deployment: run `npx convex deploy` once
  against it to establish a baseline, capture an admin key
  (`npx convex dashboard` → deployment settings, or `npx convex env`), and
  add it as `CODEGEN_CHECK_CONVEX_URL` / `CODEGEN_CHECK_CONVEX_ADMIN_KEY`
  repo secrets. No code change is needed after that — the workflow already
  wires them through.

Run `npm run codegen:check` locally before pushing if you've touched
`convex/**` — it currently finds a real, pre-existing drift unrelated to
T17: `convex/_generated/api.d.ts` on `main` is missing entries for
`convex/lib/authMail.ts`, `convex/lib/email.ts` and `convex/mailEvents.ts`
(added by other in-flight lanes without a `codegen` re-run). That's a bug
for those lanes' owners to fix by running `npx convex dev` (or `npx convex
codegen`) and committing the result — not something T17 can fix, since
`convex/**` is out of scope here.

## Dependency-audit triage

`npm audit --json`, run against the current lockfile:

| Package | Severity | Advisory | Reachable in this app? | Decision |
|---|---|---|---|---|
| `@auth/core` `<=0.41.2` (resolved `0.41.1`) | critical (bundles 1 critical + 1 high + 1 moderate GHSA) | [GHSA-7rqj-j65f-68wh](https://github.com/advisories/GHSA-7rqj-j65f-68wh) (Email normalizer homoglyph `@` bypass, critical); [GHSA-xmf8-cvqr-rfgj](https://github.com/advisories/GHSA-xmf8-cvqr-rfgj) (`getToken()` throws on malformed Bearer header, high); [GHSA-x445-f3h2-j279](https://github.com/advisories/GHSA-x445-f3h2-j279) (OAuth state/nonce/PKCE cookie binding, moderate) | **No**, for all three, verified directly against this codebase, not assumed: (1) `convex/auth.ts` configures exactly one provider, `Password` via `ConvexCredentials` (`grep -n "providers:" convex/auth.ts` → `providers: [guardedPassword]`); it never imports or exercises `@auth/core`'s built-in `Email()` magic-link provider, whose normalizer the homoglyph bypass is in — email normalization here goes through this repo's own `convex/lib/email.ts:normalizeEmail`. (2) `getToken()` only exists in `@convex-dev/auth`'s **Next.js**-specific integration (`node_modules/@convex-dev/auth/dist/nextjs/server/index.js`); this is a Vite SPA, and `grep -rn "@convex-dev/auth/nextjs" convex/ src/` returns nothing. (3) No OAuth provider is configured at all, so there is no state/nonce/PKCE cookie to bind. | **Do not blind-upgrade.** A fix is published and trivial (`0.41.3`, which already satisfies the existing `^0.41.1` range in `package.json` — no `package.json` edit needed, only a lockfile resolution bump), matching D78's own triage ("`@auth/core` moved to 0.41.3 (triaged unreachable via Password-only config)"). **T17 did not apply this bump**: T17's assigned scope explicitly restricts dependency changes to patch-package placement and the exact `@agentmail/convex` pin, and the sandbox's own permission layer independently refused an `npm install @auth/core@0.41.3 --save` in this session ("Modify Shared Resources"). Recommendation for whoever owns `package.json` dependency bumps (D78 assigns this outcome; T01 is the dependency owner per `docs/team/PLAN.md`): run `npm update @auth/core` (or `npm install @auth/core@0.41.3 --save-exact --package-lock-only` if the range should also be tightened) and re-run `npm audit` to confirm 0 critical. Low risk (patch-level bump within the declared range, all three CVE code paths already confirmed unreachable), so this is safe to apply without further reachability work. |

`npm audit --json` metadata at the time of this triage: `{"critical":1,"high":0,"moderate":0,"low":0,"info":0,"total":1}` across 257 resolved packages (62 prod, 107 dev, 95 optional, 15 peer).

No other advisories were reported. No major-version "blind upgrades" were made or are recommended here.

## `verify:patch`

`npm run verify:patch` (`scripts/check-patch.mjs`) does not trust that
`postinstall` ran — it reads
`node_modules/@agentmail/convex/dist/component/convex.config.js` directly
and fails unless it contains the `env: { AGENTMAIL_API_KEY` declaration from
`patches/@agentmail+convex+0.1.0.patch`. Wired as `postinstall` (via
`patch-package --error-on-fail`, so a failed patch application now fails the
install itself) and as its own CI step immediately after `npm ci`.

## Reproduction

The exact CI steps were re-run end to end against a **fresh clone** under
`/private/tmp` (not this working copy) on Node 22.23.2, to prove the gates
work from a clean checkout rather than this machine's possibly-stale
`node_modules`. See the T17 task report for the pasted summary lines.
