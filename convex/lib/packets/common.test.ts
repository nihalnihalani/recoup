/**
 * M20: the packet-template surface (`lib/packets/common.ts`) — DA-A-15 by construction (every read recorded; an
 * unbound or unconfirmed key refused), locale-independent formatting (D205), `fill`, and the SEC-AI-4 check for
 * packets (verbatim pack text exempt; bound money/emails/links and the recipient allowed; everything else listed).
 */
import { describe, expect, it } from "vitest";
import { factReader, fill, formatLocalDate, formatMoney, packetFindings, PacketRenderError } from "./common";
import type { BoundFactValue } from "../rules/types";
import { PACKET_TEMPLATES, selectTemplate, templateById, templateFor } from "./index";
import { R04_REMEDY_KEYS } from "../rules/r04_baggage_v1";
import type { PacketTemplate } from "./common";
import { IMPLEMENTED_PACKS } from "../rules/applicable";

const bound: BoundFactValue[] = [
  { subjectKey: "txn", key: "order.total", status: "confirmed", value: { kind: "money", amountMinor: 64_950, currency: "USD" } },
  { subjectKey: "txn", key: "order.seller", status: "observed", value: { kind: "text", text: "Summit Outdoor Co." } },
  { subjectKey: "txn", key: "order.ref", status: "confirmed", value: { kind: "identifier", scheme: "order", value: "112-3456789-1234562" } },
  { subjectKey: "txn", key: "order.placed", status: "confirmed", value: { kind: "local_date", date: "2026-09-02" } },
  { subjectKey: "txn", key: "order.promised", status: "candidate", value: { kind: "local_date", date: "2026-09-12" } },
  { subjectKey: "txn", key: "order.gone", status: "missing" },
];

describe("factReader (DA-A-15 by construction)", () => {
  it("reads bound, known values by kind and records each read once", () => {
    const r = factReader(bound);
    expect(r.money("txn", "order.total")).toEqual({ amountMinor: 64_950, currency: "USD" });
    expect(r.text("txn", "order.seller")).toBe("Summit Outdoor Co.");
    expect(r.text("txn", "order.ref")).toBe("112-3456789-1234562");
    expect(r.localDate("txn", "order.placed")).toBe("2026-09-02");
    r.money("txn", "order.total");
    expect(r.used).toEqual([
      { subjectKey: "txn", key: "order.total" }, { subjectKey: "txn", key: "order.seller" },
      { subjectKey: "txn", key: "order.ref" }, { subjectKey: "txn", key: "order.placed" },
    ]);
  });

  it("an unbound, unconfirmed (candidate/missing) or wrong-kind read throws PacketRenderError; has() never records", () => {
    const r = factReader(bound);
    const reason = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return e instanceof PacketRenderError ? e.reason : "other";
      }
      return "none";
    };
    expect(reason(() => r.value("txn", "order.nope"))).toBe("not_bound");
    expect(reason(() => r.localDate("txn", "order.promised"))).toBe("not_known");
    expect(reason(() => r.value("txn", "order.gone"))).toBe("not_known");
    expect(reason(() => r.money("txn", "order.seller"))).toBe("wrong_kind");
    expect([r.has("txn", "order.total"), r.has("txn", "order.promised"), r.has("txn", "order.nope")]).toEqual([true, false, false]);
    expect(r.used).toEqual([]);
  });
});

describe("formatting (locale-independent, D205) and fill", () => {
  it("formatMoney / formatLocalDate", () => {
    expect(formatMoney({ amountMinor: 64_950, currency: "USD" })).toBe("USD 649.50");
    expect(formatMoney({ amountMinor: 123_456_789, currency: "USD" })).toBe("USD 1,234,567.89");
    expect(formatLocalDate("2026-09-02")).toBe("September 2, 2026");
    expect(() => formatLocalDate("2026-13-02")).toThrow();
  });

  it("fill replaces {{name}} once (never re-expands a value); an unknown or unused name throws", () => {
    expect(fill("Dear {{who}}, re {{ref}}.", { who: "Sir {{ref}}", ref: "A1" })).toBe("Dear Sir {{ref}}, re A1.");
    expect(() => fill("{{missing}}", {})).toThrow(/no value/);
    expect(() => fill("x", { extra: "y" })).toThrow(/never used/);
  });
});

describe("packetFindings (SEC-AI-4 for packets)", () => {
  const ctx = { amount: { amountMinor: 64_950, currency: "USD" }, boundFacts: bound };
  const block = "Under 16 CFR 435.2, if the seller cannot ship by the promised date, you may cancel for a prompt refund; see https://www.ftc.gov/mitor.";

  it("the ask, bound money, bound identifiers, the recipient and verbatim text blocks are never findings", () => {
    const body = `Order 112-3456789-1234562 from Summit Outdoor Co. totalling USD 649.50 was not shipped.\n${block}\nPlease refund $649.50.`;
    expect(packetFindings(body, ctx, { textBlocks: [block] }, "Summit Outdoor Co., 1 Main St, Denver CO")).toEqual([]);
  });

  it("an amount, email, link or phone number Recoup did not supply is listed — including inside an edited copy of a block", () => {
    const edited = block.replace("https://www.ftc.gov/mitor", "https://evil.example/mitor");
    const body = `Refund $999.00 to pay@evil.example or call 555-123-4567.\n${edited}`;
    const f = packetFindings(body, ctx, { textBlocks: [block] }, null);
    expect(f).toEqual(expect.arrayContaining(["amount $999.00", "email pay@evil.example", "phone 555-123-4567", "link https://evil.example/mitor."]));
  });

  it("a short bound code is never stripped (it could hide a stated amount next to it)", () => {
    const withCode: BoundFactValue[] = [...bound, { subjectKey: "txn", key: "x.code", status: "confirmed", value: { kind: "text", text: "USD" } }];
    expect(packetFindings("Pay USD 999", { ...ctx, boundFacts: withCode }, { textBlocks: [] }, null)).toContain("amount USD 999");
  });
});

describe("the template registry", () => {
  it("each registered template belongs to an implemented pack version and has a unique id; unknown lookups return null", () => {
    // Each pack lane registers its own templates (M21: R05/R03 — the first registrations replaced "starts empty").
    const ids = PACKET_TEMPLATES.map((t) => t.templateId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of PACKET_TEMPLATES) {
      expect(IMPLEMENTED_PACKS.some((p) => p.ruleId === t.ruleId && p.version === t.version), t.templateId).toBe(true);
      expect(templateById(t.templateId)).toBe(t);
      expect(t.channels.length, t.templateId).toBeGreaterThan(0);
    }
    expect(templateFor("R05.mitor_shipment.us_ftc", 1)?.templateId).toBe("r05_v1.letter");
    expect(templateFor("R05.mitor_shipment.us_ftc", 2)).toBeNull();
    expect(templateById("no_such.letter")).toBeNull();
  });
});

describe("D249: templates are selected by (ruleId, version, remedyKey), deterministically", () => {
  const R04 = "R04.baggage.us_dot";
  const tpl = (templateId: string, remedyKey?: string): PacketTemplate => ({
    ruleId: R04, version: 1, templateId, channels: ["web_form"], textBlocks: [], ...(remedyKey !== undefined ? { remedyKey } : {}),
    compose: () => ({ recipient: null, body: templateId, requestedRemedy: templateId }),
  });
  const three = [tpl("r04.a", R04_REMEDY_KEYS.a), tpl("r04.b", R04_REMEDY_KEYS.b), tpl("r04.c", R04_REMEDY_KEYS.c)];

  it("three R04 remedy keys → three distinct templates, the same one every time", () => {
    const picked = (["a", "b", "c"] as const).map((p) => selectTemplate(three, R04, 1, { remedyKey: R04_REMEDY_KEYS[p] })?.templateId);
    expect(picked).toEqual(["r04.a", "r04.b", "r04.c"]);
    expect(selectTemplate([...three].reverse(), R04, 1, { remedyKey: R04_REMEDY_KEYS.b })?.templateId).toBe("r04.b");
  });

  it("a pack with ONE template falls back to it for any remedy; several and no match → null (never a guess)", () => {
    expect(selectTemplate([tpl("r04.letter")], R04, 1, { remedyKey: R04_REMEDY_KEYS.c })?.templateId).toBe("r04.letter");
    expect(selectTemplate(three, R04, 1, { remedyKey: "unknown_remedy" })).toBeNull();
    expect(selectTemplate(three, R04, 1)).toBeNull();
    expect(selectTemplate(three, R04, 1, { templateId: "r04.c" })?.templateId).toBe("r04.c");
    expect(selectTemplate(three, R04, 2, { remedyKey: R04_REMEDY_KEYS.a })).toBeNull();
  });

  it("the shipped registry resolves every registered template for its own remedy (or the pack's only template)", () => {
    for (const t of PACKET_TEMPLATES) {
      const got = templateFor(t.ruleId, t.version, t.remedyKey !== undefined ? { remedyKey: t.remedyKey } : {});
      const siblings = PACKET_TEMPLATES.filter((x) => x.ruleId === t.ruleId && x.version === t.version);
      if (t.remedyKey !== undefined || siblings.length === 1) expect(got?.templateId, t.templateId).toBe(t.templateId);
    }
  });
});
