import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { DELETION_REMOVED_NOW, DELETION_WHAT_REMAINS } from "../lib/accountDeletion";

/**
 * T19: public Privacy & services page, reachable signed in or signed out
 * (`src/App.tsx` mounts it as a sibling of the auth gate, not inside it).
 * Every number in "Retention" is copied from `convex/limits.ts` by hand
 * (this file cannot import server code) — if a constant there changes,
 * this page goes stale until someone updates it too; each figure says so
 * inline rather than presenting itself as an independent policy.
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
              Recoup is built on a handful of outside services. Each one sees only what it needs to do its one job —
              none of them sees your password, and none of them is handed your data for any purpose beyond the one
              described here.
            </p>
            <dl className="mt-4 space-y-4">
              <Provider name="Convex">
                Hosts the database and runs Recoup's server-side code, including sign-in. It stores your account
                (email address, a salted password hash) and every row the app creates on your behalf — purchases,
                items, claims, the ledger, drafts, replies, watches, price history and the mail log.
              </Provider>
              <Provider name="OpenAI">
                Reads the text of order confirmations and merchant replies you paste or forward, and extracts
                structured details from it — item names, prices, order numbers — so Recoup can log them. It receives
                only that one message's text for that one extraction; the content is treated as untrusted data, never
                as instructions to follow.
              </Provider>
              <Provider name="Firecrawl">
                Fetches the public product and store-policy pages Recoup checks on your behalf, so price and policy
                information stays current. It receives the store URL being checked — nothing about your account.
              </Provider>
              <Provider name="AgentMail">
                Gives you a dedicated Recoup inbox address to forward order confirmations and merchant replies to,
                and sends the price-alert emails and the merchant/claim messages you review and approve. It handles
                the email content you forward and the messages Recoup sends for you.
              </Provider>
              <Provider name="ShopSavvy">
                A paid market-data API Recoup queries for a product's price history and the other stores selling it,
                so a newly watched item has something to compare today's price against. It receives only the product
                being looked up — Recoup's own price reads are always labelled separately from ShopSavvy's, and
                ShopSavvy data never opens a claim or sends an alert by itself.
              </Provider>
            </dl>
          </Section>

          <Section id="retention" title="Retention">
            <p className={bodyClass}>
              These figures are mirrored from <code className={codeClass}>limits.ts</code>, the code's own
              configuration, not a separate document that can drift from what actually runs.
            </p>
            <ul className="mt-4 space-y-3">
              <RetentionItem constant="RETENTION_PAYLOAD_DAYS = 30">
                The raw content of a processed inbound email (an order confirmation or merchant reply) is cleared 30
                days after Recoup finishes handling it — what was extracted from it stays; the original message body
                does not.
              </RetentionItem>
              <RetentionItem constant="RETENTION_OBSERVATION_DAYS = 180, RETENTION_KEEP_NEWEST = 30">
                Individual price-check and offer-check observations older than 180 days are pruned, always keeping
                at least the newest 30 per item regardless of age, so a chart never loses its most recent shape.
              </RetentionItem>
              <RetentionItem constant="RETENTION_MAILLOG_DAYS = 90">
                Finished mail-log rows (sent, failed or suppressed) are pruned after 90 days.
              </RetentionItem>
              <RetentionItem constant="RETENTION_STASH_DAYS = 7">
                Small internal bookkeeping rows (pending-event markers, sign-up code capture used only in testing)
                are pruned after 7 days.
              </RetentionItem>
              <RetentionItem constant="RETENTION_UNVERIFIED_DAYS = 7">
                An account that never verifies its email is pruned after 7 days — it owns no purchases, claims or
                watches yet, since those require a verified sign-in.
              </RetentionItem>
              <RetentionItem constant="kept until you delete your account">
                Purchases, claims, the ledger, drafts and replies are <strong>never</strong> pruned automatically —
                they are your money history, and only account deletion (below) removes them.
              </RetentionItem>
            </ul>
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
