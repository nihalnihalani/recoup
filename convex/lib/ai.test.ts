import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const parseMock = vi.fn();

vi.mock("openai", () => {
  return {
    default: class {
      responses = { parse: parseMock };
    },
  };
});

import { extract, MODEL } from "./ai";

const Simple = z.object({ ok: z.boolean() });

describe("extract", () => {
  const ORIGINAL_ENV = process.env.OPENAI_API_KEY;

  beforeEach(() => {
    parseMock.mockReset();
  });

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = ORIGINAL_ENV;
  });

  it("throws a clear error when OPENAI_API_KEY is unset, without a network call", async () => {
    delete process.env.OPENAI_API_KEY;
    await expect(
      extract("simple", Simple, "system prompt", "user content"),
    ).rejects.toThrow("OPENAI_API_KEY is not set on this deployment");
    expect(parseMock).not.toHaveBeenCalled();
  });

  it("returns zod-validated output on success", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    parseMock.mockResolvedValue({ output_parsed: { ok: true } });

    const result = await extract("simple", Simple, "system prompt", "user content");

    expect(result).toEqual({ ok: true });
    expect(parseMock).toHaveBeenCalledTimes(1);
    const callArgs = parseMock.mock.calls[0][0];
    expect(callArgs.model).toBe(MODEL);
    expect(callArgs.input[0].role).toBe("system");
    expect(callArgs.input[1]).toEqual({ role: "user", content: "user content" });
  });

  it("throws when OpenAI returns no parsed output", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    parseMock.mockResolvedValue({ output_parsed: null });

    await expect(
      extract("simple", Simple, "system prompt", "user content"),
    ).rejects.toThrow("OpenAI returned no parsed output for simple");
  });

  it("throws when the parsed output fails zod validation", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    parseMock.mockResolvedValue({ output_parsed: { ok: "not-a-boolean" } });

    await expect(
      extract("simple", Simple, "system prompt", "user content"),
    ).rejects.toThrow();
  });

  it("truncates oversized user input to MAX_INPUT_CHARS", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    parseMock.mockResolvedValue({ output_parsed: { ok: true } });

    const huge = "x".repeat(70_000);
    await extract("simple", Simple, "system prompt", huge);

    const callArgs = parseMock.mock.calls[0][0];
    expect(callArgs.input[1].content.length).toBe(60_000);
  });
});
