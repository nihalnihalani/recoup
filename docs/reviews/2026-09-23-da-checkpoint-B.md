# DA checkpoint B — the integrated wave-1 backend (R01 v1 active)

Model (self-reported from my system prompt): Opus 5.5 / claude-opus-5-5

- **Role / task:** `opus-devils-advocate`, M17. This is mission §16 point 2: review after an integrated vertical slice. The review is read-only on production code.
- **Target:**
  - The backend at `origin/main` `71f1d2a`: R01 v1 is active (D186).
  - Backend production code is **identical at `a983a0b`**. The later commits are M16 tests and M15 frontend only.
  - The UI is reviewed separately when M15 completes.
- **Inputs:** my checkpoint A and M07 recheck (`docs/reviews/2026-09-23-da-checkpoint-A.md`), DECISIONS D145–D186, contract rev 5.x, and the wave-1 code.
- **Method:**
  - Worked in a detached worktree `/private/tmp/recoup-m17` at `71f1d2a`, with `node_modules` symlinked. It was removed afterwards; nothing was stashed.
  - Full suite: **121 files, 2,528 pass + 1 expected fail + 2 todo**. `tsc -p convex` exit 0. `check-rule-packs` OK.
  - For each high finding: located the named regression test, then applied a **throwaway rev-3 revert** of the production code to show the test fails. Each revert was restored immediately (Appendix A).
  - Adversarial repros: `convex/zz_m17_repro.test.ts`, **5/5 reproduce** (Appendix B). Each test asserts the current, defective behaviour.

## Verdict: **accept the wave-1 backend, with conditions**

- **Severity counts:** 0 critical, 0 high, **4 medium**, 3 low.
- **Named tests:** each of the nine wave-1 high findings from checkpoint A has a regression test that fails on the rev-3 design and passes on main. The one caveat is DA-A-11: its test has passed trivially since D186 (DA-B-4).
- **Not yet testable:** DA-A-6 and DA-A-10 are wave-2 items with no test yet. They are recorded as **open (not yet due)**.
- **Conditions, split by deadline:**
  - DA-B-1, DA-B-2 and DA-B-3 must be fixed, each with its regression test, **before wave 1 closes and before any production activation of R01**.
  - DA-B-4 must be fixed before any wave-2 pack is implemented.
  - The low findings are routed to the owners in the table.

## 1. Primary requirement: the high findings from checkpoint A

Method: a throwaway change put back the rev-3 behaviour. The named test was run, then the file was restored. Every test named below **passes on main**.

| Finding | Named test (file:line) | Rev-3 revert applied | Result on the revert | Status |
|---|---|---|---|---|
| DA-A-1 | `lib/facts/resolve.test.ts:45–88` | `resolve.ts:176`: any `user_confirmed` row resolves as confirmed, including "I don't know" | **7 fail** | ✅ |
| DA-A-2 | `priceWatch.parity.test.ts:105` ("qualifying drop on an unconfirmed policy → exactly one claim") | In the R01 pack, an unconfirmed policy sets `factsKnown: "unknown"` (the rev-3 "missing fact") | **8 parity scenarios fail** | ✅ |
| DA-A-3 | `opportunities.test.ts:109`; `priceWatch.parity.test.ts:209` | `opportunities.ts:396` `linking = false` (no mandatory link) | **2 fail** | ✅ |
| DA-A-4 | `recovery.test.ts:25,34,62,112` (+ property test); `opportunities.test.ts:329` | Components **sum** instead of max; an undeclared intersection → `coordinated` | **5 fail**; **1 fail** | ✅ |
| DA-A-5 | `lib/deadlines/engine.test.ts:208,236` | Counterparty deadlines become `passed`; every deadline gates `windowOpen` | **2 fail** | ✅ |
| DA-A-6 | — (wave 2, M23) | — | — | **open, not yet due.** Schema has a three-valued `quoteStatus`; live extraction is flagged off (D145). |
| DA-A-7 | `retention.test.ts:552` (+580, 620); `src/pages/Privacy.test.tsx` | Evidence is kept whenever its transaction is not archived | **1 fail** (the discriminating test) | ✅ |
| DA-A-8 | `evidence.test.ts:363,375,435` | A missing doc type → `queued` | **3 fail** | ✅ |
| DA-A-9 | `lib/claimState.test.ts:74,78,103` | Delivery ignores `requiredChannel` | **4 fail** | ✅ |
| DA-A-10 | — (wave 2, M20) | — | — | **open, not yet due** |
| DA-A-11 | `lib/rules/registry.test.ts:29,63` | The registry selects by the pack's own `lifecycle` (rev 3) | **1 fail** | ✅, **weakened: see DA-B-4** |

Notes on the table:

- **DA-A-2:** `outcome.test.ts:48` (the assumption-only row) is **identical under rev 3**, so it cannot tell the two designs apart. Only the parity scenario does. Reverting the `conditions.ts` assumption branch changes nothing either, because R01 v1 computes its policy assumption inside the pack. Neither observation is a defect; they just mean the parity test is the real guard.
- **DA-A-4:** the per-transaction cap test (`recovery.test.ts:40`) cannot pass without the cap, which did not exist in rev 3.
- **Also re-confirmed:** DA-A-21/C1 is closed only for a prepare done **after** the window ends; DA-B-1 shows the case the test misses. DA-A-13, DA-A-14, DA-A-15/C2, DA-A-16/N5, DA-A-17/C4 and D142/C5 all have their tests on main (D165, D182).

## 2. Findings

| ID | Sev | Requirement | Reproduction | Expected vs observed | Impact | Smallest fix | Regression test | Owner |
|---|---|---|---|---|---|---|---|---|
| **DA-B-1** | medium | Mission §6 "re-read approval … immediately before the side effect"; §16 "send after stale approval", "rule update after approval"; D145 O14 / C1 "identical for linked and unlinked"; D148 N3 | `approveAndSend` recomputes the approval **read-only from the stored evaluation** (`drafts.ts` `approvalState`). For a **linked** claim, the window check comes only from `evaluation.outcome`, never from the clock. Pack activation is never re-checked either. **B1:** prepare at window end − 1 min, send at + 1 min → **sent with no acknowledgment**. On an **unlinked** claim the same sequence is refused (B1 control). **B3:** prepare, then the pack is withdrawn (test registry), then send with the old `preparedHash` → **sent under the withdrawn rule**. Once an item's window closes, `eligibleItems` stops checking it, so no evaluation refreshes the stored one. A Composer page left open across the window end therefore sends without the acknowledgment. | **Expected:** past the window, a linked claim needs the same acknowledgment an unlinked one does; after a withdrawal, the send is refused (`rule_withdrawn`) or falls back to legacy checks. **Observed:** the send goes out. | A late ask goes out without the D145 acknowledgment; a withdrawn rule still backs a send. | In `approvalState`: for linked R01 claims, also set `needsWindowAck` when `now > claim.windowEndsAt` (the same clock rule as unlinked claims), and return `rule_withdrawn` when `!isPackActive(evaluation.ruleId, evaluation.ruleVersion)`. Both are pure reads, so `approveAndSend` still never evaluates. | B1 and B3 inverted: "prepare before the window end, send after → `window_may_have_passed` unless acknowledged, identical for linked and unlinked"; "withdraw between prepare and send → no send" | M13 (`drafts.ts`) |
| **DA-B-2** | medium | Mission §6 (claim amount vs rule estimate; no unsupported assertions); §14 "calculation when supported"; SEC-AI-4 | **B4:** an open claim for 2 units asks 5,000. The user corrects the quantity to 1 through `purchases.confirm`. The re-evaluation marks it material (claim version 1 → 2, so the old draft is invalidated — correct), and the opportunity estimate becomes 2,500. But the claim still asks **5,000**, `nextAction` is `continue_case`, and a new draft asking "$50.00" passes `prepareSend` with **no findings**, because the SEC-AI-4 allowlist always includes `claim.expectedCents` (`drafts.ts` `draftAllowances`). | **Expected:** when the claim amount exceeds the re-evaluated estimate (basis `exact_formula`), the user is prompted to adjust (`adjustExpected`) or acknowledge before sending. **Observed:** the stale amount is sent without comment. | The merchant is asked for twice what the rule now computes, right after the user corrected the facts. | Outside the frozen pack: in `approvalState`, when a linked evaluation's estimate is below `claim.expectedCents`, return a new acknowledgeable code `amount_exceeds_estimate` (message offers "adjust to X"). Add `review_amount` to the opportunity projection. No R01 pack change is needed. | "qty 2→1 on an open 5,000 claim → prepareSend returns `amount_exceeds_estimate`; after `adjustExpected(2,500)` → ok" | M13, M12 |
| **DA-B-3** | medium | SEC-AI-6; mission §13 (untrusted email); D174/D178 ("a spoofed promise must not appear in the Promised tile") | Provenance is `user_forwarded` whenever the **From header string** equals the account email (`intake.ts:831–837, 868`). From is attacker-chosen. The Recoup inbox address is known to every merchant the user has emailed through Recoup, and the account email is often the address the purchase was made with. A message with a spoofed From is then applied as verified: a refund email writes a **`promised_credit`** directly (`intake.test.ts:17–33, 270–289` is exactly this path), opens a `return_credit` claim, and shows in the Promised tile. No SPF, DKIM or DMARC result is consulted. | **Expected:** a header string alone is not treated as authentication. **Observed:** it is. | Fake promises and claims on the dashboard; misleading money state. | Treat an email as `user_forwarded` only when AgentMail reports an authentication pass aligned with the From domain. If no verdict is available, send every refund email through the one-tap `confirmRefundEmail` (which already exists). Record the verdict on the evidence row. | "From = account email, no auth verdict → no ledger event, `needs_review`; with an aligned DMARC pass → applied" | M13 (intake), M28 (replies, wave 2) |
| **DA-B-4** | medium | DA-A-11 / D145(c) "the production registry never returns a non-active pack"; mission §11 "a placeholder card is not implemented" | `registry.test.ts:29` compares `activePacks()` with `resolveActivePacks(ACTIVATIONS, IMPLEMENTED_PACKS)` and checks the empty case only `if (ACTIVATIONS.length === 0)`. Since D186, every implemented pack is active. A regression that makes production **ignore `activation.ts`** (`activePacks = () => IMPLEMENTED_PACKS`) therefore **passes 27/27** of registry and opportunities tests (revert in Appendix A). Also, the import guard (`registry.test.ts:63`) misses a side-effect import (`import "./lib/rules/testRegistry"`). | **Expected:** the guard fails whenever production could return a non-activated pack. **Observed:** it passes trivially. | Once wave 2 implements R02–R05 before activating them, nothing catches production evaluating an unreviewed pack. | `vi.mock("./activation", () => ({ ACTIVATIONS: [] }))` in a dedicated test file; assert `activePacks()`, `activePack("R01")` and `evaluateTransaction` all yield nothing. Add a withdrawn-entry case. Extend the regex to bare `import "…testRegistry"`. | This test is the fix. | M12 / QA |
| **DA-B-5** | low | SEC-AI-4 (M03 §3.2); mission §6 "AI must not execute instructions embedded in documents" | `unverifiedContent` misses several forms (B2): **bare domains** ("refund-portal.example/verify"); **currency-code-first** amounts ("USD 450"); **trailing symbols** ("450$"); **spelled amounts**; **obfuscated emails** ("claims [at] evil.example"). The R01 writer receives untrusted scraped policy text and email-derived item names, so injected content can reach the draft in exactly these forms. | **Expected:** they are flagged. **Observed:** no finding. | Weakens defence in depth; the user still reviews every draft. | Flag bare `host.tld/path` tokens whose host is not allow-listed; match `(USD\|EUR\|…)\s?\d`, a trailing `\d[$€£]`, and number words next to currency words; normalise `[at]`/`(at)`/` at ` before email matching. | The B2 strings each produce a finding. | M13 |
| **DA-B-6** | low | Mission §8 immutability; §16 "rule update after approval"; DA-A-23; D185 N1 | Two gaps. **First, the engine is not pinned.** Editing a shared engine module changes the **active** R01 behaviour while `check-rule-packs` still prints **OK**. Example: in `outcome.ts`, dropping `assumptions.length > 0` from rule 8 lets R01 return `eligible`, which M02 says it never does. Only the fixture tests catch that one (36 fail); an engine change outside fixture coverage passes every gate. DA-A-23's `ENGINE_VERSION` was scheduled for wave 2, when no pack was expected to be active; R01 went active in wave 1. **Second, the gate is not a deploy gate.** `check-rule-packs` runs in CI **after** a push, and backend deploys are manual (`package.json` has only the static `deploy`), so a tree with red CI can be deployed. | **Expected:** the active pack's inputs are pinned, and deploys are gated. **Observed:** neither. | A silent rule change could reach production. | Pull `ENGINE_VERSION` forward: `check-rule-packs` hashes the engine import closure and records it on the active manifest entry. Add a `deploy:backend` script: `check-rule-packs && typecheck && vitest run && npx convex deploy`, and have the RUNBOOK name it as the only deploy path. | "edit `outcome.ts` without bumping `ENGINE_VERSION` → `check-rule-packs` fails" | M19/M20, lead |
| **DA-B-7** | low | D179 (known lag); mission §14 truthful case state | When a claim is dismissed or confirmed, its opportunity keeps `activeClaimId` until the next evaluation (no hook in `claims.ts`). An item whose window has closed is never re-checked, so its card can show "case open" for a dismissed claim indefinitely. For a dismissed claim, Potential drops the loss (an undercount, not an overcount). | **Expected:** the closure is reflected immediately. **Observed:** it waits for an evaluation that may never come. | A stale card state. | Run the closure step that `evaluateTransaction` already performs (`opportunities.ts:393`) from `claims.dismiss` and `writeConfirmedCredit`, in the same mutation. | "dismiss → the opportunity is `open` with no `activeClaimId` at once" | M10/M12 |

## 3. Attacks that hold (one line each)

- **Money.**
  - Alternatives count once across all tiles, including components that contain cases (DA-A-4 tests).
  - Tiles are disjoint and exhaustive, with `ready` as the catch-all (C4).
  - The over-credit line keeps the excess visible.
  - Provisional credit is shown as "of which". `confirmCredit` refuses while a provisional credit is outstanding unless `separateFromProvisional` is set (N5). There is one confirmed-credit writer (D162).
  - Non-two-decimal currencies are excluded from every figure and listed as `unsupportedCurrencies`; legacy hundredths are never read as ISO minor units (D177/D179, `recovery.test.ts:289`).
  - The summary's ledger reads are capped at 200 events per claim, with `complete: false` on a cut.
- **Side effects.**
  - `resendAfterUnknown` runs the full prepare pass (D182).
  - `prepareSend` refuses examples before any evaluation.
  - Deleting an account while evaluation runs: `evaluateTransaction` writes nothing for a tombstoned account (D180).
  - Deleting while an upload runs: `finalizeUpload` re-checks the tombstone and deletes only its own blob.
  - A withdrawal **seen by a re-evaluation** supersedes the opportunity and refuses the send. Only the prepare → send gap in DA-B-1 lets it through.
- **Evidence routes.**
  - Identical 401/404 bodies; Content-Length is checked before the body is read, plus a streamed cap and a length-mismatch check.
  - Magic-byte sniffing, HEIC never sent to the model, owner-scoped dedupe, and revival of cleared rows.
  - Filename: percent-decoding, then control characters, quotes and `;` are stripped, and both the ASCII fallback and the RFC 5987 form are built (`evidence.ts:86–100`, `http.ts:196–200`). Header injection is not possible.
  - `attachment`, `nosniff`, `private, no-store` and a sandbox CSP on downloads.
- **Masking.** Inbound masks subject, From and text before insert and before truncation. Only masked fields are stored in the payload (`inbound.ts:118–134`). KS2 (numbers split across lines, and PDF text layers) remains the accepted residual (D155/D165).
- **Eligibility (R01 v1 through `recordCheck`).** 22-scenario dual-mode parity plus 36 fixtures (D179/D184) cover:
  - the window boundary across DST;
  - quantity, and the threshold boundary;
  - a paid claim followed by a deeper drop;
  - a stale snapshot (A-T2), and a later confirmed snapshot (N7);
  - GBP (a claim opens) and JPY (`unsupported`, D160);
  - an unvetted observation → `needs_facts` (D184).

  Conflict rules 5a/5b/5c cannot be reached for R01 in wave 1, because every R01 fact is purchase-backed (M11b), and `not_yet_due` is not an R01 outcome. So that part holds by construction.
- **Reads.** A 50-item purchase evaluation reads 213 ranges; a one-subject re-evaluation 17; the summary at 200 × 200, 1,004 ranges (D175, D179, asserted under `transactionLimits`).
- **Activation chain.**
  - Production selects packs only through `registry.ts`, which is gated by `activation.ts` (`priceWatch.ts:401`, `opportunities.ts:299,358,790`, `coverage.ts:84`).
  - No production module imports `testRegistry`.
  - The pack file is hash-pinned: editing it fails `check-rule-packs`.
  - The gaps are the ones in DA-B-4 and DA-B-6.

## 4. Conditions for accepting the wave-1 backend

1. DA-B-1, DA-B-2 and DA-B-3 fixed, with their regression tests. Each test must fail on the current code: the B1/B3/B4 repros in Appendix B, and the intake spoof case. Deadline: before wave 1 closes and before R01 is activated on any deployment beyond dev.
2. DA-B-4's mocked-activation test lands before any wave-2 pack is added to `IMPLEMENTED_PACKS`.
3. DA-B-5, DA-B-6 and DA-B-7 are routed as low findings. For DA-B-6, the lead records the deploy path in the RUNBOOK now; the `ENGINE_VERSION` part lands with the next engine change or before production activation, whichever comes first.
4. The UI (M15) is reviewed when the lead pings.

---

## Appendix A — rev-3 reverts (throwaway; each restored immediately)

A script applied one text substitution, ran the named test files, then restored the file.

| Finding | Substitution (production file) | Tests run | Result |
|---|---|---|---|
| DA-A-1 | `resolve.ts`: `if (U !== undefined && U.value.kind !== "user_unknown")` → `if (U !== undefined)` | `lib/facts/resolve.test.ts` | 7 failed |
| DA-A-2 | `r01_price_adjustment_v1.ts`: `factsKnown: requiredUsable ? …` → `requiredUsable && !(policy && !policy.confirmedByUser) ? …` | `priceWatch.parity.test.ts` | 8 failed |
| DA-A-2 (non-discriminating) | `conditions.ts`: assumption branch disabled | `priceWatch.parity.test.ts` | 28 passed |
| DA-A-3 | `opportunities.ts`: `const linking = … ` → `const linking = false;` | `opportunities.test.ts`, `priceWatch.parity.test.ts` | 2 failed |
| DA-A-4 | `recovery.ts`: `lossAll`/`lossOpen` max → sum | `recovery.test.ts` | 5 failed |
| DA-A-4 | `opportunities.ts` `overlapCheck`: undeclared → `continue` (coordinated) | `opportunities.test.ts` | 1 failed |
| DA-A-5 | `engine.ts`: `statusFor` → always `passed`; `userWindowOpen` filters every deadline | `lib/deadlines/engine.test.ts` | 2 failed |
| DA-A-7 | `retention.ts`: `if (view.hasCase)` → `if (view.hasCase \|\| !view.archived)` | `retention.test.ts` | 1 failed |
| DA-A-8 | `evidence.ts`: `awaiting_doc_type` → `queued` | `evidence.test.ts` | 3 failed |
| DA-A-9 | `claimState.ts`: `if (claim.requiredChannel === undefined)` → `if (true)` | `lib/claimState.test.ts` | 4 failed |
| DA-A-11 (rev 3) | `registry.ts`: select by pack `lifecycle === "active"` | `lib/rules/registry.test.ts` | 1 failed |
| DA-A-11 (ignore activation) → DA-B-4 | `registry.ts`: `activePacks = () => [...IMPLEMENTED_PACKS]` | `registry.test.ts`, `opportunities.test.ts` | **27 passed** |
| DA-B-6 | `outcome.ts`: drop `assumptions.length > 0` from rule 8 | `node scripts/check-rule-packs.mjs`; R01 tests | **`check-rule-packs` OK**; 36 tests failed |
| DA-B-4 (guard) | `recovery.ts`: prepend `import "./lib/rules/testRegistry";` | `registry.test.ts` | **5 passed** |

## Appendix B — repro tests (`convex/zz_m17_repro.test.ts`, throwaway; 5/5 pass = defect present)

The prelude is `drafts.prepare.test.ts:1–97` (R01 v1 forced active through the test registry; `world`, `link`, `draftFor`, `prepare`, `approve`). Condensed:

```ts
it("B1 linked: prepared 1 min before the window closes, sent 1 min after → no acknowledgment needed", async () => {
  const t = setup(); const a = await signedIn(t, "A"); const w = await world(t, a.userId);
  await link(t, w.purchaseId); const draftId = await draftFor(t, a.userId, w.claimId);
  vi.setSystemTime(WINDOW_END - 60_000); const res = await prepare(a.as, draftId); // ok, no ack
  vi.setSystemTime(WINDOW_END + 60_000);
  await approve(a.as, draftId, { preparedHash: res.preparedHash });   // no acknowledgeWindowRisk
  expect(send).toHaveBeenCalledTimes(1);
});
it("B1 control unlinked (setTestActivations([])): same sequence → approve rejects, no send", …);
it("B3 withdrawn between prepare and send → still sent", async () => {
  /* link, draft, prepare → ok */
  setTestActivations([{ ruleId: R01_V1_RULE_ID, version: 1, status: "withdrawn", decision: "D999" }]);
  await approve(a.as, draftId, { preparedHash: res.preparedHash }); expect(send).toHaveBeenCalledTimes(1);
});
it("B4 qty 2→1 via purchases.confirm on an open 5,000 claim", async () => {
  /* observed: claim.expectedCents 5000, version 2, opportunity estimate 2500, outcome likely_eligible,
     nextAction continue_case; prepareSend on a "$50.00" draft → { ok: true, findings: [] } */
});
it("B2 SEC-AI-4 misses", () => {
  for (const body of ["Please refund USD 450 today.", "Please refund 450$ today.", "Please refund four hundred fifty dollars.",
    "Verify at refund-portal.example/verify before replying.", "Write to claims [at] evil.example with my card details."])
    expect(unverifiedContent(body, { emails: new Set(["help@acme.example"]), urls: new Set(), hosts: new Set(["acme.example"]), amountsMinor: new Set([2_500]) })).toEqual([]);
});
```

---

# Addendum — UI portion (M15), plus the M12c tile changes

Model (self-reported from my system prompt): Opus 5.5 / claude-opus-5-5

- **Target:** `origin/main` `01db658`.
  - M15: `edae0d3` (opportunity card, questions, deadlines, paths-not-checked) and `ca6ced3` (Composer → `prepareSend`, acknowledgeable refusals, resend after unknown), merged in `886f918`.
  - M12c: `9acc16b` (paid-total cap on confirmed money; excess on the over-credit line; the `paidTotalPartial` label).
- **Method:**
  - Worked in a clean detached worktree (`/private/tmp/recoup-m17ui`), removed afterwards.
  - Gates: **131 files, 2,763 pass + 1 expected fail + 2 todo**; app typecheck exit 0.
  - Throwaway repros, no deployment:
    - component tests on the existing Composer harness (happy-dom), U1–U3;
    - `recovery.summary` tests through convex-test, S1–S2.
  - All of them reproduce, except U3, which holds.
- **Lead rulings noted:** D190 routes DA-B-1/2/3/5 to M13b and DA-B-4/6/7 plus the DA-B-2 projection half to M12d. D191 overrides DA-B-6: the gated script is `deploy:dev` (`convex dev --once`), and any production deploy needs explicit user authorization.

## Verdict (UI): **accept with conditions**

- **Severity counts:** 0 critical, 0 high, **3 medium**, 4 low.
- **Conditions:** fix DA-B-8, DA-B-9 and DA-B-10 before wave 1 closes. They are money semantics and copy.
- **DA-B-1 on the client side is mitigated:** the Composer runs `prepareSend` and `approveAndSend` back to back in one click and never keeps a `preparedHash` between clicks. Exploiting the stale-evaluation gap therefore needs a hand-crafted client, but the M13b server fix is still required.

## Findings

| ID | Sev | Requirement | Reproduction | Expected vs observed | Impact | Smallest fix | Regression test | Owner |
|---|---|---|---|---|---|---|---|---|
| **DA-B-8** | medium | Mission §6 "preserve over-credit" and user-confirmed posted credit; §16 "uncertainty explained without misleading urgency"; D145/D188 | `recovery.ts` puts **every** confirmed amount above `lossAll` on `excess` (`recovered = min(Σnet, lossAll)`). M12c also caps Recovered at the paid total P, and for retail P is **items only** (pre-tax) unless the order total was confirmed. StatCards shows that excess in red: "Over-credit / possible double credit … check whether a credit was posted twice". **S1:** a price adjustment refunded with its sales tax (asked 25.00, received 27.00) → Recovered **25.00** and a red **2.00** "possible double credit". **S2:** a return refunded with tax (120.00 + 9.60) → Recovered **120.00** and a red **9.60**. | **Expected:** a single refund that includes tax or shipping is recovered money, not a suspected double credit. **Observed:** routine refunds understate the headline and trigger a double-credit alarm. | Most US retail refunds include tax, so the alarm fires on normal refunds; the headline understates what the user actually received. | (1) Split `excess` into `aboveAskMinor` (one credited claim in the component, within a *confirmed* order total or where P is partial), with neutral copy "More came back than you asked — often tax or shipping refunded too", and `possibleDoubleCreditMinor` (≥ 2 claims in the component with net > 0, or Σnet above a **confirmed** order total), which keeps the current warning. (2) Skip cap step 1 (moving confirmed money to excess) when `P.partial`, since P is known to be low. (3) Optional, for the lead: D145's `min(Σ, loss)` for a single-claim component. That is conservative, not unsafe. | S1/S2 inverted: "25 + 2 tax on one claim → no double-credit warning"; "two confirmed credits on one loss → warning". | M12 (`recovery.ts`), M15 (StatCards copy) |
| **DA-B-9** | medium | Mission §14 authority and source presentation; §20 "never promise guaranteed recovery"; contract §9 authority copy | The claim page headline for any open claim is **"Owed to you"** (`src/pages/Claim.tsx:35`). For an R01 claim, the same amount's card says "An estimate, not a guarantee: the business decides", and its authority badge says the policy is "a promise the business made, not a law" (`model.ts`). This copy predates Mission 2 but now contradicts the authority model on the main money screen. | **Expected:** wording that matches the authority class and the outcome. **Observed:** "owed" asserts an entitlement that R01 (`likely_eligible`, merchant decides) does not claim. | Users are led to believe the merchant owes them; this is what §20 forbids. | Choose the headline label by authority and outcome: "You asked for" / "Still outstanding" for merchant promises and goodwill; keep "Owed to you" for an `eligible` `legal_entitlement` only (and legacy return claims if the lead wants). | "R01 claim headline never says 'owed'" (copy test) | M15 now; M24 owns Claim.tsx in wave 2 |
| **DA-B-10** | medium | Mission §6 "vouchers, points, repairs, replacements, and cash are not interchangeable"; D184 R01 limitation "credit rather than cash" | The only way to record money is the "Credit landed / Confirm credit" form (`Claim.tsx:262–276`), which calls `confirmCredit`. The ledger timeline shows it as **"Back on your card"** (`Timelines.tsx:30`, `Claim.tsx:30`), and it counts in cash Recovered ("back on your card, as you confirmed it", StatCards). Many R01 merchants pay the difference as store credit or a gift card (D184), and `claims.recordNonCashRemedy` exists (M10), but the form never asks. | **Expected:** the user states how it came back; non-cash goes to `nonCashRemedies`. **Observed:** a gift card is counted as cash on the card. | Cash totals inflated by non-cash value; untrue "Back on your card" copy. | Add a required "How did it come back?" choice to the form: to my card or account → `confirmCredit`; store credit, gift card or points → `recordNonCashRemedy` (received, face value). Change the neutral copy to "Confirmed received". | "a store-credit answer writes a nonCashRemedies row, Recovered unchanged, Non-cash count 1" | M15 (form/copy), M10 (unchanged API) |
| **DA-B-11** | low | SEC-AI-4: an acknowledgment covers the findings the user saw | **U2:** findings A are acknowledged; the next attempt is `rate_limited`; the user clicks "Approve & send" again. The Composer re-sends `acknowledgeUnverifiedContent: true`, and when the server now returns a **different** finding B it sends with B never displayed. `ackContent` resets only when the text is edited (`Composer.tsx:279–283`), and `preparedHash` binds the flag, not the findings. | **Expected:** an acknowledgment is tied to a specific set of findings. **Observed:** it is a boolean that carries over. | A content warning goes unseen (rare: it needs the server allowances to change between attempts). | Client: clear `ackContent` whenever a new refusal or `pending` is set. Server: `preparedHash` includes a hash of the findings, and `approveAndSend` compares it. | U2 inverted | M15, M13 |
| **DA-B-12** | low | Mission §14 keyboard completion, labels and focus | **U1:** after a refusal, focus stays on "Approve & send". The refusal panel with "Send anyway" is rendered **before** that button in DOM order, so a keyboard user must Shift+Tab back to reach it; `role="alert"` announces the text but not the action. | **Expected:** focus moves to the panel's action (or the panel follows the button and is focused). **Observed:** focus does not move. | Friction for keyboard and screen-reader users at the decision point. | Focus the panel's primary button when `pending` is set; add `aria-describedby` from the send button to the panel message. | U1 inverted: "after window_may_have_passed, `document.activeElement` is 'Send anyway'" | M15 |
| **DA-B-13** | low | Mission §14 "has anything actually been sent / arrived" | The Asked tile hint says "sent or submitted, **no answer yet**". In wave 1 a merchant's refusal reply is classified (`replies`), but the claim stays `sent` because `denied` arrives in wave 2, so a refused claim sits under "no answer yet". | **Expected:** "no money yet". **Observed:** "no answer yet". | Mildly misleading state. | Change the hint to "sent or submitted; no money yet". | Copy test | M15 |
| **DA-B-14** | low | Mission §11 status vocabulary (`implemented_verified` vs `implemented_live_unverified`); §20 copy matches coverage | `coverage.ts` sets `status: "implemented_verified"` for any activated pack. Activation is local and dev-only (D186; live providers are externally blocked; production is not deployed). The UI does not show this row, since CoverageList lists only `not_checked`, but it is the source M2A's §20 copy test and RULES-COVERAGE read. | **Expected:** `implemented_live_unverified` (or `active`) until live evidence is recorded. **Observed:** `implemented_verified`. | Coverage and copy could overclaim. | Rename the status for activation-only rows; switch to `implemented_verified` only with a recorded live-verification reference. | "an active pack without a live-verification record is not implemented_verified" | M12, lead |

## UI attacks that hold (one line each)

- **Acknowledgment flow.** An acknowledgeable refusal (window, content) needs its explicit "send anyway" button. Clicking "Approve & send" again re-prepares without the acknowledgment and is refused again. `outcome_not_approvable` and `example_claim` disable sending. The server enforces all of this regardless (`prepareSend`/`approveAndSend`).
- **Resend after unknown.**
  - The acknowledgment checkbox is required.
  - The server re-reads the earlier attempt, returning `outcome_known` without sending when it resolved.
  - It creates a new draft version and refuses a second concurrent resend (the enqueue clears `sendUnknown`; the second transaction fails the `queued && sendUnknown` check under OCC).
  - A double-click on "Approve & send" fires once (**U3 holds**).
- **Stale page and new drafts.** Composer is keyed by `draft._id` (`Claim.tsx:241`), so a new or resent draft resets its text and acknowledgments. A claim-version bump returns `binding_changed` → "Nothing was sent. Review the claim again".
- **Money copy against the summary invariants.**
  - Every money figure comes only from `recovery.summary`; `tracking.overview` is not a prop.
  - "Each amount counts once, in the furthest step it has reached"; Potential is "estimated, not guaranteed".
  - "of which provisional" sits inside a tile; unsupported currencies are shown as counts, never amounts.
  - A "Partial" badge appears when `complete` is false; "Capped at what you paid" carries the item-prices-only note.
  - DA-B-8 is the one semantic defect here.
- **Provisional wording:** "Provisional credit (not final)" / "Provisional credit resolved", never "Back on your card" (D156).
- **Card.**
  - An amount appears only with an estimate, as "An estimate, not a guarantee: the business decides". A cap shows as "Limit … the most this path can pay, not what to expect".
  - The authority copy says a promise is not a law; there are no probability scores.
  - `not_yet_due` never shows an amount.
  - One known wart: after a dismissal, "Open the claim" can still link to the dismissed claim (DA-B-7, M12d).
- **Placeholder support.** The server creates no card without an active pack (registry). "Paths not checked" shows reasons only, never amounts, and no digital-content path appears for a physical item.
- **Isolation through URLs.** `forPurchase`, `forTransaction` and `get` use owned* helpers with an identical not-found; M16's reflective two-user guard covers every new public function. External source links use `rel="noreferrer noopener"`, so no internal ids leak through Referer.
