import { describe, expect, it } from "vitest";
import { sanitizeError } from "./errors";

describe("sanitizeError", () => {
  it("buckets an extraction failure", () => {
    expect(sanitizeError("OpenAI returned no parsed output for inbound_email")).toBe("Extraction failed");
    expect(sanitizeError("ZodError: [ { \"message\": \"Required\" } ]")).toBe("Extraction failed");
  });

  it("buckets an upstream provider failure", () => {
    expect(sanitizeError("APIConnectionError: Connection error.")).toBe("Provider error");
    expect(sanitizeError("RateLimitError: 429 Too Many Requests")).toBe("Provider error");
    expect(sanitizeError("OPENAI_API_KEY is not set on this deployment")).toBe("Provider error");
  });

  it("buckets one of our own boundary assertions", () => {
    expect(sanitizeError("ConvexError: unitPrice must be a non-negative safe integer")).toBe("Invalid data");
    expect(sanitizeError("idempotency conflict")).toBe("Invalid data");
  });

  it("falls back to a generic message for anything else, including empty or missing input", () => {
    expect(sanitizeError("something bizarre happened")).toBe("Something went wrong");
    expect(sanitizeError(undefined)).toBe("Something went wrong");
    expect(sanitizeError("")).toBe("Something went wrong");
  });
});
