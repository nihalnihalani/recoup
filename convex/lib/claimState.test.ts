/**
 * lib/claimState (contract rev 5 §5): the ONE closed-for-ask helper and the channel-scoped delivery
 * projection (DA-A-9). Delivery, "submitted", Asked and "expired" are derived — never stored — and, when a
 * claim has a `requiredChannel`, only artifacts on that channel count.
 */
import { describe, expect, it } from "vitest";
import {
  ASKED_DELIVERIES,
  SENDING_DELIVERIES,
  delivery,
  isClosedForAsk,
  isExpired,
  isSubmitted,
  type ClaimStateInput,
  type DraftArtifact,
} from "./claimState";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 8, 1);

const sentDraft = (over: Partial<DraftArtifact> = {}): DraftArtifact => ({
  version: 1, approvedAt: T0, outboundId: "ob1", agentmailMessageId: "m1", ...over,
});

describe("isClosedForAsk (§3.4, §5)", () => {
  it("confirmed, dismissed and denied are closed; every other status is open", () => {
    for (const status of ["confirmed", "dismissed", "denied"]) expect(isClosedForAsk({ status }), status).toBe(true);
    for (const status of ["detected", "drafted", "queued", "sent", "packet", "promised", "reopened"]) {
      expect(isClosedForAsk({ status }), status).toBe(false);
    }
  });

  it("a non-cash resolution closes any status (DA-A-18, wave 2 field)", () => {
    expect(isClosedForAsk({ status: "sent", nonCashResolvedAt: T0 })).toBe(true);
    expect(isClosedForAsk({ status: "promised", nonCashResolvedAt: T0 })).toBe(true);
  });
});

describe("delivery projection — email (legacy claims keep today's projection)", () => {
  const legacy = (over: Partial<ClaimStateInput> = {}): ClaimStateInput => ({ status: "drafted", ...over });

  it("walks draft → approved → queued/unknown → sent from today's draft fields", () => {
    expect(delivery(legacy({ status: "detected" }), {})).toBe("none");
    expect(delivery(legacy(), { drafts: [{ version: 1 }] })).toBe("draft");
    expect(delivery(legacy(), { drafts: [{ version: 1, approvedAt: T0 }] })).toBe("approved");
    expect(delivery(legacy({ status: "queued" }), { drafts: [{ version: 1, approvedAt: T0, outboundId: "ob1" }] })).toBe("queued");
    expect(delivery(legacy({ status: "queued", sendUnknown: true }), { drafts: [{ version: 1, approvedAt: T0, outboundId: "ob1" }] })).toBe("unknown");
    expect(delivery(legacy({ status: "sent" }), { drafts: [sentDraft()] })).toBe("sent");
  });

  it("a bounce (sendError, outboundId cleared) is failed; a complaint note on a sent draft stays sent", () => {
    expect(delivery(legacy(), { drafts: [{ version: 1, sendError: "Delivery bounced" }] })).toBe("failed");
    expect(delivery(legacy({ status: "sent" }), { drafts: [sentDraft({ sendError: "marked as spam" })] })).toBe("sent");
  });

  it("once any draft was sent the claim stays sent, even with a newer unsent draft", () => {
    expect(delivery(legacy({ status: "sent" }), { drafts: [sentDraft(), { version: 2 }] })).toBe("sent");
  });

  it("legacy statuses with no draft evidence project as today: sent → sent, queued → queued, packet → user_reported", () => {
    expect(delivery(legacy({ status: "sent" }), {})).toBe("sent");
    expect(delivery(legacy({ status: "queued" }), {})).toBe("queued");
    expect(delivery(legacy({ status: "packet" }), {})).toBe("user_reported");
    expect(isSubmitted(legacy({ status: "packet" }), {})).toBe(true);
  });
});

describe("DA-A-9: requiredChannel scopes delivery, submitted, Asked and expired", () => {
  // R03-shaped: the formal notice must go by post; the merchant email is informal outreach.
  const postal: ClaimStateInput = { status: "sent", requiredChannel: "postal_mail" };
  const informalEmail = sentDraft({ purpose: "informal" });
  const userDeadline = [{ obligor: "user" as const, dueAt: T0 + 60 * DAY }];

  it("the SAME claim without requiredChannel (rev-3 projection) would count the merchant email as submitted", () => {
    expect(isSubmitted({ status: "sent" }, { drafts: [informalEmail] })).toBe(true);
  });

  it("requiredChannel postal + informal email sent → not submitted; day 59 not expired; day 61 → expired", () => {
    expect(delivery(postal, { drafts: [informalEmail] })).toBe("none");
    expect(isSubmitted(postal, { drafts: [informalEmail] })).toBe(false);
    expect(isExpired(postal, { drafts: [informalEmail] }, userDeadline, T0 + 59 * DAY)).toBe(false);
    expect(isExpired(postal, { drafts: [informalEmail] }, userDeadline, T0 + 61 * DAY)).toBe(true);
  });

  it("a recorded postal submission is submitted (and never expired); a submission on another channel is not", () => {
    const onPost = { submissions: [{ channel: "postal_mail" as const, submittedAt: T0 + 10 * DAY }] };
    expect(delivery(postal, onPost)).toBe("submission_recorded");
    expect(isSubmitted(postal, onPost)).toBe(true);
    expect(isExpired(postal, onPost, userDeadline, T0 + 61 * DAY)).toBe(false);
    const onPortal = { submissions: [{ channel: "portal" as const, submittedAt: T0 + 10 * DAY }] };
    expect(isSubmitted(postal, onPortal)).toBe(false);
    const delivered = { submissions: [{ channel: "postal_mail" as const, submittedAt: T0, deliveryRecordedAt: T0 + 3 * DAY }] };
    expect(delivery(postal, delivered)).toBe("delivered");
  });

  it("an approved packet on the channel is prepared, not submitted; the legacy packet status does not count", () => {
    const packets = [{ version: 1, channel: "postal_mail" as const, status: "approved" as const }];
    expect(delivery(postal, { packets })).toBe("packet_prepared");
    expect(isSubmitted(postal, { packets })).toBe(false);
    expect(isSubmitted({ status: "packet", requiredChannel: "postal_mail" }, {})).toBe(false);
  });

  it("requiredChannel email: only non-informal drafts count", () => {
    const email: ClaimStateInput = { status: "sent", requiredChannel: "email" };
    expect(isSubmitted(email, { drafts: [informalEmail] })).toBe(false);
    expect(isSubmitted(email, { drafts: [informalEmail, sentDraft({ version: 2, purpose: "formal" })] })).toBe(true);
    expect(isSubmitted(email, { drafts: [sentDraft()] })).toBe(true); // no purpose = formal
  });

  it("only USER-obligor deadlines expire a claim; closed claims and unknown due dates never do", () => {
    const counterparty = [{ obligor: "counterparty" as const, dueAt: T0 }];
    expect(isExpired(postal, {}, counterparty, T0 + 90 * DAY)).toBe(false);
    expect(isExpired(postal, {}, [{ obligor: "user" as const }], T0 + 90 * DAY)).toBe(false);
    expect(isExpired({ ...postal, status: "dismissed" }, {}, userDeadline, T0 + 90 * DAY)).toBe(false);
    expect(isExpired(postal, {}, userDeadline, T0 + 60 * DAY)).toBe(false); // the due instant itself is still in time
  });
});

describe("tile classes (§3.4) are disjoint", () => {
  it("asked and sending sets never overlap", () => {
    for (const d of ASKED_DELIVERIES) expect(SENDING_DELIVERIES.has(d)).toBe(false);
    expect([...ASKED_DELIVERIES].sort()).toEqual(["delivered", "sent", "submission_recorded", "user_reported"]);
    expect([...SENDING_DELIVERIES].sort()).toEqual(["accepted", "queued", "stalled", "unknown"]);
  });
});

describe("M10 call sites use the one helper (§5: claims.ts and followUps.ts switch in M10)", () => {
  it("claims.ts and followUps.ts import isClosedForAsk and carry no closed-status list of their own", async () => {
    const { readFileSync } = await import("node:fs");
    for (const file of ["../claims.ts", "../followUps.ts"]) {
      const src = readFileSync(new globalThis.URL(file, import.meta.url), "utf8");
      expect(src, file).toMatch(/import \{[^}]*\bisClosedForAsk\b[^}]*\} from "\.\/lib\/claimState"/);
      expect(src, file).not.toMatch(/\["confirmed",\s*"dismissed"\]/);
      expect(src, file).not.toMatch(/status === "confirmed" \|\|\s*\S*status === "dismissed"/);
    }
  });
});
