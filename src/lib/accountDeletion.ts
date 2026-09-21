/**
 * Truthful, shared copy for account deletion (T19, P09, D115).
 *
 * Both `Settings.tsx`'s "Delete account" explainer and `Privacy.tsx`'s
 * "Export & deletion" section render these SAME two strings rather than
 * writing their own — one place to keep the claim accurate, and one place
 * to edit the day the gap below actually closes.
 */

/** What `api.account.requestDeletion`/`purge` actually remove, today. */
export const DELETION_REMOVED_NOW =
  "Deletes your account now, not just hides it: your purchases, items, claims, the ledger, drafts, " +
  "replies, watches, the mail log, alert settings and your profile are removed, including your money " +
  "history. Every session is signed out immediately, and deleting your Recoup inbox with the mail " +
  "provider is requested right away and retried automatically until it succeeds.";

/**
 * D115 (checkpoint 6b-5, Opus review of T18 at e265bb9): a real, disclosed
 * gap, not a hypothetical one. `purge` deletes every row in every table it
 * walks (see `DELETION_REMOVED_NOW`) and asks the AgentMail component to
 * delete the user's inbox — but the AgentMail component is a separate
 * Convex component with its own storage, not one of the tables `purge`
 * walks, and it keeps its own copies of inbound/outbound email content
 * (the messages themselves) after that inbox is gone. Nothing in the
 * deletion flow purges those copies yet (tracked as T18.4: a paginated
 * purge call into the component, plus a patch if the component needs one).
 *
 * Until T18.4 lands, never shorten this to "an anonymous tombstone" as
 * though that were the only thing left behind — it is not. Update this
 * constant (and nothing else) when the gap closes.
 */
export const DELETION_WHAT_REMAINS =
  "What remains: an anonymous account tombstone recording only that an account existed and was deleted " +
  "— plus, for now, copies of the email content itself (messages received or sent through your Recoup " +
  "inbox) that continue to live inside the mail system Recoup runs on top of. Deleting your account does " +
  "not yet purge those copies; this is a known gap that is being fixed, and this notice will be updated " +
  "the moment it closes. Either way, emails already sent to stores before deletion cannot be recalled or " +
  "unsent.";
