import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOG_KINDS, logEvent, redact } from "./log";

function lastLoggedLine(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
  const call = spy.mock.calls.at(-1);
  if (!call) throw new Error("console.error was not called");
  return JSON.parse(call[0] as string) as Record<string, unknown>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("LOG_KINDS", () => {
  it("is exactly the closed P12 set", () => {
    expect(LOG_KINDS).toEqual([
      "extraction_failed",
      "notification_failed",
      "notification_stalled",
      "price_check_failed",
      "budget_exhausted",
      "webhook_rejected",
      "scheduler_backlog",
      "market_failed",
      "migration_progress",
      "rule_evaluation_failed",
      "source_verification_failed",
      "flag_changed",
      "extraction_refused",
    ]);
  });

  it("M1B (P12/C58): adds the rule-evaluation, source-verification, flag-change and extraction-refused kinds", () => {
    const kinds: readonly string[] = LOG_KINDS;
    for (const kind of ["rule_evaluation_failed", "source_verification_failed", "flag_changed", "extraction_refused"]) {
      expect(kinds).toContain(kind);
    }
  });
});

describe("M1B event kinds keep the unchanged redaction path", () => {
  let spy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => spy.mockRestore());

  it("a rule_evaluation_failed line is redacted exactly like every other kind", () => {
    logEvent("rule_evaluation_failed", { ruleId: "R02.airline_fare_refund.us_dot", error: new Error("boom for ops@example.com sk-abcdefghij1234567890") });
    const line = lastLoggedLine(spy);
    expect(line.kind).toBe("rule_evaluation_failed");
    expect(line.error).toEqual({ name: "Error", message: "boom for example.com sk-***" });
  });

  it("a flag_changed line cannot spoof the envelope", () => {
    logEvent("flag_changed", { kind: "forged", flag: "live_document_extraction", to: true });
    const line = lastLoggedLine(spy);
    expect(line.kind).toBe("flag_changed");
    expect(line.flag).toBe("live_document_extraction");
  });
});

describe("logEvent", () => {
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    spy.mockRestore();
  });

  it("writes exactly one JSON line with kind, a fresh v4-shaped correlation id, and an ISO timestamp", () => {
    const { correlationId } = logEvent("market_failed", { watchId: "abc" });

    expect(spy).toHaveBeenCalledTimes(1);
    const [line] = spy.mock.calls[0] as [string];
    expect(() => JSON.parse(line)).not.toThrow();

    const parsed = lastLoggedLine(spy);
    expect(parsed.kind).toBe("market_failed");
    expect(parsed.correlationId).toBe(correlationId);
    expect(correlationId).toMatch(UUID_RE);
    expect(typeof parsed.at).toBe("string");
    expect(new Date(parsed.at as string).toISOString()).toBe(parsed.at);
    expect(parsed.watchId).toBe("abc");
  });

  it("returns a different correlation id on every call", () => {
    const a = logEvent("budget_exhausted", {});
    const b = logEvent("budget_exhausted", {});
    expect(a.correlationId).not.toBe(b.correlationId);
  });

  it("defaults fields to an empty object when omitted", () => {
    logEvent("scheduler_backlog");
    const line = lastLoggedLine(spy);
    expect(line.kind).toBe("scheduler_backlog");
    expect(Object.keys(line).sort()).toEqual(["at", "correlationId", "kind"]);
  });

  it("does not let caller-supplied fields spoof the envelope", () => {
    logEvent("webhook_rejected", { kind: "forged", correlationId: "forged", at: "forged", reason: "bad signature" });
    const line = lastLoggedLine(spy);
    expect(line.kind).toBe("webhook_rejected");
    expect(line.correlationId).not.toBe("forged");
    expect(line.correlationId).toMatch(UUID_RE);
    expect(line.at).not.toBe("forged");
    expect(line.reason).toBe("bad signature");
  });

  it("redacts fields before they are ever serialized", () => {
    logEvent("extraction_failed", { detail: "auth failed for user@example.com with key sk-abcdefghij1234567890" });
    const line = lastLoggedLine(spy);
    expect(line.detail).toBe("auth failed for example.com with key sk-***");
  });
});

describe("redact", () => {
  it("redacts an OpenAI-style secret key", () => {
    expect(redact({ msg: "failed with key sk-abcdefghij1234567890" })).toEqual({ msg: "failed with key sk-***" });
  });

  it("redacts a Firecrawl-style key", () => {
    expect(redact({ msg: "using fc-abcdefghij1234567890 for the scrape" })).toEqual({
      msg: "using fc-*** for the scrape",
    });
  });

  it("redacts a webhook signing secret", () => {
    expect(redact({ msg: "secret whsec_abcdef123456 rejected the signature" })).toEqual({
      msg: "secret whsec_*** rejected the signature",
    });
  });

  it("redacts a bearer token as a whole, including when the token itself looks like an sk- key", () => {
    expect(redact({ header: "Authorization: Bearer sk-abcdefghij1234567890" })).toEqual({
      header: "Authorization: Bearer ***",
    });
    expect(redact({ header: "bearer abcDEF123-._~+/==" })).toEqual({ header: "Bearer ***" });
  });

  it("reduces an email address to its domain only", () => {
    expect(redact({ to: "nih4l.n7@gmail.com" })).toEqual({ to: "gmail.com" });
    expect(redact("contact ops+alerts@sub.example.co.uk please")).toBe("contact sub.example.co.uk please");
  });

  it("redacts recursively through nested objects and arrays", () => {
    const input = {
      nested: {
        list: ["contact me at ops@example.com", { deeper: "key sk-abcdefghij1234567890 leaked" }],
      },
    };
    expect(redact(input)).toEqual({
      nested: {
        list: ["contact me at example.com", { deeper: "key sk-*** leaked" }],
      },
    });
  });

  it("leaves non-secret-shaped strings, numbers, booleans, null and undefined untouched", () => {
    expect(redact({ a: 1, b: true, c: null, d: "ordinary text", e: undefined })).toEqual({
      a: 1,
      b: true,
      c: null,
      d: "ordinary text",
      e: undefined,
    });
  });

  it("truncates an oversized string instead of logging it whole", () => {
    const big = "x".repeat(5000);
    const out = redact({ big }) as { big: string };
    expect(out.big.length).toBeLessThan(5000);
    expect(out.big).toContain("truncated");
  });

  it("bounds recursion depth against deeply nested input, including a circular reference", () => {
    let nested: unknown = { leaf: "sk-abcdefghij1234567890" };
    for (let i = 0; i < 20; i++) nested = { child: nested };
    expect(() => redact(nested)).not.toThrow();
    expect(JSON.stringify(redact(nested)).length).toBeLessThan(500);

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => redact(circular)).not.toThrow();
  });

  it("bounds array and object width instead of copying an unbounded payload", () => {
    const bigArray = Array.from({ length: 200 }, (_, i) => i);
    const arrayOut = redact({ bigArray }) as { bigArray: unknown[] };
    expect(arrayOut.bigArray.length).toBeLessThanOrEqual(51);
    expect(arrayOut.bigArray.at(-1)).toContain("more item(s) omitted");

    const bigObject: Record<string, number> = {};
    for (let i = 0; i < 100; i++) bigObject[`k${i}`] = i;
    const objectOut = redact(bigObject) as Record<string, unknown>;
    expect(Object.keys(objectOut).length).toBeLessThanOrEqual(51);
    expect(objectOut["..."]).toContain("more field(s) omitted");
  });

  it("summarizes an Error instance instead of dumping its stack", () => {
    const err = new Error("boom sk-abcdefghij1234567890");
    const out = redact({ err }) as { err: { name: string; message: string; stack?: string } };
    expect(out.err.name).toBe("Error");
    expect(out.err.message).toBe("boom sk-***");
    expect(out.err.stack).toBeUndefined();
  });

  it("serializes bigint and Date values instead of letting JSON.stringify throw", () => {
    const out = redact({ big: 9007199254740993n, when: new Date("2026-09-21T00:00:00.000Z") }) as unknown as {
      big: string;
      when: string;
    };
    expect(out.big).toBe("9007199254740993n");
    expect(out.when).toBe("2026-09-21T00:00:00.000Z");
    expect(() => JSON.stringify(out)).not.toThrow();
  });
});
