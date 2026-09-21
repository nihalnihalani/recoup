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
  "history. Every session is signed out immediately, and further sign-in is blocked. Recoup also purges " +
  "the mail system's own stored copies of inbound and outbound email for your Recoup inbox, and requests " +
  "deletion of your Recoup inbox from the mail provider right away, retried automatically.";

/**
 * D119/D121 (T18.4, T18.1, verified): the gap this constant used to
 * disclose — the mail component keeping its own copies of inbound/outbound
 * email after the inbox itself was deleted — is closed. `purge` now also
 * drains the mail component's own per-inbox rows (`convex/mailPurge.ts`),
 * and `deletionStatus` reports that truthfully via `mailDataPurged` (surfaced
 * in Settings' deletion-in-progress panel, not repeated here). This constant
 * states the two things that are STILL true no matter how a given deletion
 * goes: the tombstone itself is the only ongoing record, and a remote-inbox
 * delete that never succeeds (its retry budget exhausted) does not block the
 * rest of deletion or get hidden — nor can an email already sent to a store
 * before deletion ever be un-sent. Do not reintroduce "not yet purged" or
 * "known gap" language here; that was true once and is not anymore.
 */
export const DELETION_WHAT_REMAINS =
  "What remains: an anonymous account tombstone recording only that an account existed and was deleted " +
  "— nothing else. If deleting your Recoup inbox from the mail provider fails after every automatic retry, " +
  "your account is still marked deleted and that remote-inbox failure is shown rather than hidden. Either " +
  "way, emails already sent to stores before deletion cannot be recalled or unsent.";
