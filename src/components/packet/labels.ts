import type { Doc } from "../../../convex/_generated/dataModel";

export type ManualChannel = Doc<"packets">["channel"];

/** Where the user files a packet, in words. */
export const CHANNEL_LABELS: Readonly<Record<ManualChannel, { name: string; how: string }>> = {
  postal_mail: { name: "Postal mail", how: "Print it, sign it, and mail it yourself (a tracked service gives you proof)." },
  web_form: { name: "Web form", how: "Paste it into the company's online form yourself, and keep the confirmation." },
  portal: { name: "Online portal", how: "Submit it in the company's portal yourself, and keep the confirmation number." },
  phone: { name: "Phone", how: "Use it as your script when you call, and note who you spoke to and when." },
  chat: { name: "Chat", how: "Paste it into the company's chat yourself, and save the transcript." },
  in_person: { name: "In person", how: "Bring it with you, and ask for a receipt or a reference number." },
};

export const RECIPIENT_SOURCE_LABELS: Readonly<Record<Doc<"packets">["recipient"]["source"], string>> = {
  confirmed_policy_snapshot: "from the store policy you confirmed",
  rule_pack: "from the published rule",
  user_entered_from_document: "entered by you from one of your documents",
  user_entered: "entered by you",
};

/**
 * What a packet version is, in the words mission §14 insists on: prepared is not submitted, and submitted is not
 * delivered. Recoup never sends a packet and never claims it arrived.
 */
export const PACKET_STATUS_COPY: Readonly<Record<Doc<"packets">["status"], string>> = {
  draft: "Prepared by Recoup. Not approved and not sent.",
  approved: "Approved by you. Recoup does not send it: you file it yourself, then record that you did.",
  submission_recorded: "You recorded submitting it. That is not proof it arrived.",
  superseded: "Replaced by a newer version.",
};
