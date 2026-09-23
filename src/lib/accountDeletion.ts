/**
 * Truthful, shared copy for account deletion (T19, P09, D77; updated T24d
 * per D119/D121 once the mail-component purge actually landed).
 *
 * Both `Settings.tsx`'s "Delete account" explainer and `Privacy.tsx`'s
 * "Export & deletion" section render these SAME two strings rather than
 * writing their own — one place to keep the claim accurate, and one place
 * to edit the day the behaviour changes again.
 */

/** What `api.account.requestDeletion`/`purge` actually remove, today. */
export const DELETION_REMOVED_NOW =
  "Deletes your account now, not just hides it: your purchases, items, claims, the ledger, drafts, " +
  "replies, watches, the mail log, alert settings and your profile are removed, including your money " +
  "history, along with your transactions, recorded facts, the evidence you forwarded, pasted or uploaded " +
  "(uploaded files included), recovery opportunities and rule-check history. Every session is signed out immediately, and further sign-in is blocked. Recoup also purges " +
  "the mail system's own stored copies of inbound and outbound email for your Recoup inbox, and requests " +
  "deletion of your Recoup inbox from the mail provider right away, retried automatically.";

/**
 * D119/D121 (T18.4, T18.1, verified): the gap this constant used to
 * disclose — the mail component keeping its own copies of inbound/outbound
 * email after the inbox itself was deleted — is closed FOR YOUR OWN RECOUP
 * INBOX. `purge` drains the mail component's own per-inbox rows
 * (`convex/mailPurge.ts`), and `deletionStatus` reports that truthfully via
 * `mailDataPurged` (surfaced in Settings' deletion-in-progress panel, not
 * repeated here).
 *
 * P09-F1 (S-M03-2) / P07-SK-6 (re-audit, D244): this constant used to say
 * "nothing else" remains besides the tombstone. That was never true of the
 * SEPARATE, shared mailbox Recoup itself sends from, never the user
 * (`ALERTS_INBOX_ID`: sign-in/reset codes, `convex/lib/authMail.ts`, and
 * price-drop alerts, `convex/notify.ts`) — nothing purges that shared
 * mailbox's copy of a code's delivery record, or of a reply you sent to
 * one of its alerts, on account deletion or ever (`convex/lib/
 * privacyFacts.ts`'s `SENDER_MAILBOX_COPY`, `purgedOnAccountDeletion:
 * false`, is the backend fact this sentence renders). Provider-side thread
 * copies there are P09-X1: reaching the live provider to verify or change
 * that retention is not authorized in this mission (D83, D136), so this
 * says what remains rather than promising a purge Recoup cannot yet
 * perform. "remote-inbox failure" and "cannot be recalled" below are
 * unchanged and still true. Do not reintroduce "not yet purged" or "known
 * gap" language for your OWN Recoup inbox specifically — that gap is
 * closed; this is a DIFFERENT, still-open one.
 *
 * ING2-R1 (re-audit re-review, adversarial pass on this lane's first fix):
 * the sentence above used to also claim the tombstone records "only that
 * an account existed and was deleted" — false, the tombstone row
 * (`accountState`) keeps the account id, the Recoup inbox id and the last
 * error too (both read back verbatim below; `zz_ing2review_privacy.test.ts`
 * proved it). It also attributed the shared mailbox's surviving copies
 * entirely to "Recoup's mail provider ... outside Recoup's control" —
 * false for the SAME two items `SENDER_MAILBOX_COPY` names: those live in
 * Recoup's OWN mail system (the AgentMail component's tables inside
 * Recoup's own Convex deployment), not only with the provider. It also
 * used to say deletion "does not remove that mailbox's copy of those
 * SENDS" — false of the alert's own outbound send specifically, which IS
 * purged by `deleteMailLogPage` (D129, checkpoint 6d) as part of this same
 * deletion; only the delivery RECORD and a REPLY survive. Fixed to name
 * what Recoup's own backend still holds (and that it holds no expiry on
 * it) before naming the provider's separate, uncontrolled copy on top.
 */
export const DELETION_WHAT_REMAINS =
  "What remains: an account tombstone that keeps the account id, your Recoup inbox id, the deletion status " +
  "and, if the deletion ran into trouble, the last error — never only a record that an account existed. If " +
  "deleting your Recoup inbox from the mail provider fails after every automatic retry, your account is " +
  "still marked deleted and that remote-inbox failure is recorded on the tombstone and reported to Recoup's " +
  "operator; a page you still have signed in shows it, but once you are signed out Recoup cannot show it to you. " +
  "Sign-in and password-reset " +
  "codes, and price-drop alerts, are sent from a shared mailbox Recoup itself owns rather than your own " +
  "Recoup inbox. Deleting your account does not purge Recoup's own mail system's copy of two things from " +
  "that shared mailbox: the delivery record of every sign-in/reset code it has sent you, and any reply you " +
  "sent to one of its price-drop alerts — both are kept indefinitely, with no expiry. (The alert's own " +
  "outbound send is different: its copy in that same mail system is purged when your account is.) Beyond " +
  "what Recoup's own backend keeps, the mail provider separately keeps its own copies of all of this on its " +
  "own retention schedule, outside Recoup's control. Either way, emails already sent to stores before " +
  "deletion cannot be recalled or unsent.";
