import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  EVALUATION_RETENTION_DAYS,
  EVIDENCE_RETENTION_DAYS,
  OPENAI_PURPOSES,
  ORPHAN_BLOB_MIN_AGE_HOURS,
  PRIVACY_STATEMENTS,
  PROVIDER_DISCLOSURES,
} from "../../convex/lib/privacyFacts";
import {
  RETENTION_KEEP_NEWEST,
  RETENTION_MAILLOG_DAYS,
  RETENTION_OBSERVATION_DAYS,
  RETENTION_PAYLOAD_DAYS,
  RETENTION_STASH_DAYS,
  RETENTION_UNVERIFIED_DAYS,
} from "../../convex/limits";
import { DELETION_REMOVED_NOW, DELETION_WHAT_REMAINS } from "../lib/accountDeletion";

/**
 * T19: public Privacy & services page, reachable signed in or signed out
 * (`src/App.tsx` mounts it as a sibling of the auth gate, not inside it).
 *
 * M15 (DA-A-7, D146, D142, D163): every retention sentence below is
 * `PRIVACY_STATEMENTS` from `convex/lib/privacyFacts.ts`, rendered verbatim,
 * and every figure in the code chips is imported from the same backend
 * constants `convex/retention.ts` enforces. Nothing here is copied by hand:
 * `privacyFacts.ts` is frontend-importable on purpose (its only import is
 * the import-free `convex/limits.ts`), so a changed window changes this page
 * in the same commit. `Privacy.test.tsx` fails if a statement is added to
 * `PRIVACY_STATEMENTS` without being rendered here, and `RETENTION_ROWS` is
 * typed so the compiler refuses a missing key too.
 *
 * This is a plain-language description of what the code actually does
 * today, not a legal document — see "Limitations" below, which this file
 * is written to be consistent with (no certification claims, no promises
 * this page cannot verify).
 */
export default function Privacy() {
  return (
    <div className="min-h-screen bg-white">
      <header className="border-b border-gray-200">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-4 sm:px-6">
          <Link to="/" className="flex items-center gap-2.5 rounded outline-none focus-visible:ring-2 focus-visible:ring-violet-500">
            <span
              aria-hidden="true"
              className="flex size-8 items-center justify-center rounded-lg bg-gray-900 text-base font-bold leading-none text-white"
            >
              R
            </span>
            <span className="text-base font-semibold tracking-tight text-gray-900">Recoup</span>
          </Link>
          <Link
            to="/"
            className="rounded text-sm font-semibold text-gray-700 underline decoration-gray-300 underline-offset-4 outline-none transition hover:text-gray-900 hover:decoration-gray-900 focus-visible:ring-2 focus-visible:ring-violet-500"
          >
            Back to Recoup
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
        <h1 className="text-2xl font-semibold tracking-tight text-gray-900 md:text-[1.75rem]">Privacy &amp; services</h1>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-gray-700">
          Plain-language notes on what Recoup stores, which outside services it uses and why, how long anything is
          kept, and how to leave — with your data, or without it.
        </p>

        <div className="mt-10 space-y-8">
          <Section id="providers" title="Providers">
            <p className={bodyClass}>
              Recoup is built on a handful of outside services. Each is listed with what it receives from Recoup and
              what Recoup can say about what it keeps. Your password goes only to Convex, which runs sign-in and stores a
              salted hash of it, never the password itself.
            </p>
            {/* P09-F2 (D244e): each provider's sentences are `PROVIDER_DISCLOSURES`, rendered verbatim. */}
            <dl className="mt-4 space-y-5">
              {PROVIDER_DISCLOSURES.map((provider) => (
                <Provider key={provider.name} name={provider.name}>
                  <p>{provider.role}</p>
                  <p className="mt-1.5">
                    <span className="font-semibold text-gray-900">What it receives: </span>
                    {provider.receives}
                  </p>
                  {provider.name === "OpenAI" && (
                    <ul className="mt-1.5 list-disc space-y-1 pl-5">
                      {OPENAI_PURPOSES.map((purpose) => (
                        <li key={purpose.calls[0]}>{purpose.text}</li>
                      ))}
                    </ul>
                  )}
                  <p className="mt-1.5">
                    <span className="font-semibold text-gray-900">What it keeps: </span>
                    {provider.retention}
                  </p>
                </Provider>
              ))}
            </dl>
          </Section>

          <Section id="retention" title="Retention">
            <p className={bodyClass}>
              Every sentence and figure here is read from the code's own configuration (
              <code className={codeClass}>privacyFacts.ts</code> and <code className={codeClass}>limits.ts</code>), the
              same values the clean-up jobs use — not a separate document that can drift from what actually runs.
            </p>
            {RETENTION_GROUPS.map((group) => (
              <div key={group.title} className="mt-5">
                <h3 className="text-sm font-semibold text-gray-900">{group.title}</h3>
                <ul className="mt-2 space-y-3">
                  {group.keys.map((key) => (
                    <RetentionItem key={key} constant={RETENTION_ROWS[key]}>
                      {PRIVACY_STATEMENTS[key]}
                    </RetentionItem>
                  ))}
                </ul>
              </div>
            ))}
          </Section>

          <Section id="alerts" title="Alerts &amp; consent">
            <p className={bodyClass}>
              Price-drop alerts are on by default once your email is verified, and go only to that verified address
              — never anywhere else. You can turn them off anytime in{" "}
              <Link to="/settings" className={linkClass}>
                Settings
              </Link>
              , and every alert email carries a one-click "Unsubscribe" link (and the matching
              List-Unsubscribe/List-Unsubscribe-Post headers, so mail clients that support one-click unsubscribe can
              act on it directly).
            </p>
            <p className={bodyClass}>
              Merchant emails are different: Recoup never sends a store a message without you first reviewing and
              approving that exact text.
            </p>
          </Section>

          <Section id="export-deletion" title="Export &amp; deletion">
            <p className={bodyClass}>
              From{" "}
              <Link to="/settings" className={linkClass}>
                Settings
              </Link>
              , "Export my data" downloads everything the account owns — every table listed under Providers above —
              as one JSON file on your own device.
            </p>
            <p className={bodyClass}>{DELETION_REMOVED_NOW}</p>
            <p className={bodyClass}>{DELETION_WHAT_REMAINS}</p>
          </Section>

          <Section id="contact" title="Contact">
            <p className={bodyClass}>
              Recoup does not run a support inbox. The way to reach the person who maintains it is the repository's
              issue tracker:
            </p>
            <a
              href="https://github.com/nihalnihalani/recoup/issues"
              target="_blank"
              rel="noreferrer noopener"
              className={`mt-2 inline-block ${linkClass}`}
            >
              github.com/nihalnihalani/recoup/issues
            </a>
          </Section>

          <Section id="limitations" title="Limitations">
            <p className={bodyClass}>
              This page describes what Recoup's code actually does, in plain language, as of the date it was last
              updated with the code. It is not a legally binding privacy policy and nothing on it is legal advice.
              Recoup makes no claim of certification or compliance with any specific law or framework (GDPR, CCPA,
              or any other) — if you need a legally binding privacy notice or an assessment against a specific law,
              consult a lawyer.
            </p>
          </Section>
        </div>
      </main>
    </div>
  );
}

type StatementKey = keyof typeof PRIVACY_STATEMENTS;

/**
 * The code chip beside each statement: the constant(s) its number comes from,
 * with the value imported, never typed. A `Record` over every statement key,
 * so a statement M14 adds without a row here is a compile error.
 */
const RETENTION_ROWS: Record<StatementKey, string> = {
  evidenceText: `EVIDENCE_RETENTION_DAYS = ${EVIDENCE_RETENTION_DAYS}`,
  evidenceAfterClearing: "kept after clearing: headers, fingerprint, fact quotes",
  uploads: `EVIDENCE_RETENTION_DAYS = ${EVIDENCE_RETENTION_DAYS}`,
  unfinishedUploads: `ORPHAN_BLOB_MIN_AGE_HOURS = ${ORPHAN_BLOB_MIN_AGE_HOURS}`,
  mailComponentCopy: "kept until you delete your account",
  evaluations: `EVALUATION_RETENTION_DAYS = ${EVALUATION_RETENTION_DAYS}`,
  inboundPayload: `RETENTION_PAYLOAD_DAYS = ${RETENTION_PAYLOAD_DAYS}`,
  observations: `RETENTION_OBSERVATION_DAYS = ${RETENTION_OBSERVATION_DAYS}, RETENTION_KEEP_NEWEST = ${RETENTION_KEEP_NEWEST}`,
  mailLog: `RETENTION_MAILLOG_DAYS = ${RETENTION_MAILLOG_DAYS}`,
  stash: `RETENTION_STASH_DAYS = ${RETENTION_STASH_DAYS}`,
  unverifiedAccounts: `RETENTION_UNVERIFIED_DAYS = ${RETENTION_UNVERIFIED_DAYS}`,
  moneyHistory: "kept until you delete your account",
};

/** Reading order. `Privacy.test.tsx` checks that the page renders every statement exactly once. */
const RETENTION_GROUPS: readonly { title: string; keys: readonly StatementKey[] }[] = [
  {
    title: "Email, pasted text and uploads",
    keys: ["evidenceText", "evidenceAfterClearing", "uploads", "unfinishedUploads", "inboundPayload", "mailComponentCopy"],
  },
  { title: "Rule checks", keys: ["evaluations"] },
  { title: "Prices and mail", keys: ["observations", "mailLog"] },
  { title: "Accounts and bookkeeping", keys: ["stash", "unverifiedAccounts"] },
  { title: "Your money history", keys: ["moneyHistory"] },
];

const bodyClass = "mt-3 text-sm leading-relaxed text-gray-700 first:mt-0";
const codeClass = "rounded bg-gray-100 px-1.5 py-0.5 font-mono text-xs text-gray-900";
const linkClass =
  "rounded font-semibold text-gray-900 underline decoration-gray-300 underline-offset-4 outline-none transition hover:decoration-gray-900 focus-visible:ring-2 focus-visible:ring-violet-500";

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  const headingId = `privacy-${id}`;
  return (
    <section aria-labelledby={headingId} className="rounded-2xl border border-gray-200 bg-white p-5 sm:p-6">
      <h2 id={headingId} className="text-lg font-semibold tracking-tight text-gray-900">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Provider({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-sm font-semibold text-gray-900">{name}</dt>
      <dd className="mt-1 text-sm leading-relaxed text-gray-700">{children}</dd>
    </div>
  );
}

function RetentionItem({ constant, children }: { constant: string; children: ReactNode }) {
  return (
    <li className="text-sm leading-relaxed text-gray-700">
      <code className={codeClass}>{constant}</code>
      <span className="mt-1 block">{children}</span>
    </li>
  );
}
