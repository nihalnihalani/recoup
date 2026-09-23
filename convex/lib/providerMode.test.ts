import { afterEach, describe, expect, it, vi } from "vitest";
import { ConvexError } from "convex/values";
import { providerStubMode, stubbedProviderError, stubInboxFor, STUB_INBOX_DOMAIN } from "./providerMode";

/**
 * P10-OW-12: the core fail-closed switch every provider call site in `convex/` calls. See that finding's row in
 * `docs/reviews/2026-09-23-P01-P12-reaudit.md` for the full call-site list; each call site's own stub branch is
 * unit-tested next to its real call (e.g. `convex/lib/ai.test.ts`, `convex/priceWatch.test.ts`,
 * `convex/market.test.ts`).
 */
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("providerStubMode", () => {
  it("is false when RECOUP_PROVIDER_MODE is unset (the ordinary, real-call path)", () => {
    vi.stubEnv("RECOUP_PROVIDER_MODE", undefined);
    expect(providerStubMode()).toBe(false);
  });

  it("is false for any value other than exactly \"stub\"", () => {
    vi.stubEnv("RECOUP_PROVIDER_MODE", "true");
    expect(providerStubMode()).toBe(false);
    vi.stubEnv("RECOUP_PROVIDER_MODE", "Stub");
    expect(providerStubMode()).toBe(false);
  });

  it("is true when RECOUP_PROVIDER_MODE=stub and CONVEX_SITE_URL is the documented dev deployment (a positive signal)", () => {
    vi.stubEnv("RECOUP_PROVIDER_MODE", "stub");
    vi.stubEnv("CONVEX_SITE_URL", "https://adorable-lion-138.convex.site");
    expect(providerStubMode()).toBe(true);
  });

  it("is true when RECOUP_PROVIDER_MODE=stub, CONVEX_SITE_URL is unset/unrecognized, but E2E_SEED_ENABLED=true (a positive signal, e.g. CI's dedicated E2E deployment)", () => {
    vi.stubEnv("RECOUP_PROVIDER_MODE", "stub");
    vi.stubEnv("CONVEX_SITE_URL", undefined);
    vi.stubEnv("E2E_SEED_ENABLED", "true");
    expect(providerStubMode()).toBe(true);
    vi.stubEnv("CONVEX_SITE_URL", "https://some-ci-e2e-deployment.convex.site");
    expect(providerStubMode()).toBe(true);
  });

  // QA2-3 (adversarial re-review): the first version of this file defaulted an unset/unknown CONVEX_SITE_URL to
  // `true` -- a denylist, not a positive match -- so any deployment other than the two named literals silently
  // entered stub mode with no refusal and no log if RECOUP_PROVIDER_MODE were ever mis-set there. These three
  // tests pin the inverted, fail-closed-by-default behavior: refuse unless a positive dev/E2E signal is present.
  it("FAIL-CLOSED (QA2-3): throws -- does NOT default to true -- when RECOUP_PROVIDER_MODE=stub and CONVEX_SITE_URL is unset entirely and E2E_SEED_ENABLED is not set", () => {
    vi.stubEnv("RECOUP_PROVIDER_MODE", "stub");
    vi.stubEnv("CONVEX_SITE_URL", undefined);
    vi.stubEnv("E2E_SEED_ENABLED", undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => providerStubMode()).toThrow(ConvexError);
    expect(() => providerStubMode()).toThrow(/no positive signal/);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("FAIL-CLOSED (QA2-3): throws for an unrecognized deployment (neither the dev host nor E2E_SEED_ENABLED=true) -- e.g. a renamed or new production deployment RECOUP_PROVIDER_MODE was mistakenly set on", () => {
    vi.stubEnv("RECOUP_PROVIDER_MODE", "stub");
    vi.stubEnv("CONVEX_SITE_URL", "https://some-other-prod.convex.site");
    vi.stubEnv("E2E_SEED_ENABLED", undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => providerStubMode()).toThrow(ConvexError);
    expect(() => providerStubMode()).toThrow(/no positive signal/);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("FAIL-CLOSED: throws (never returns true) when RECOUP_PROVIDER_MODE=stub but CONVEX_SITE_URL looks like the production deployment, even with E2E_SEED_ENABLED=true (defense in depth, QA2-3)", () => {
    vi.stubEnv("RECOUP_PROVIDER_MODE", "stub");
    vi.stubEnv("CONVEX_SITE_URL", "https://cool-oyster-399.convex.site");
    vi.stubEnv("E2E_SEED_ENABLED", "true");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => providerStubMode()).toThrow(ConvexError);
    expect(() => providerStubMode()).toThrow(/production deployment/);
    // "log loudly": a refused attempt is also written to the deployment's own log stream, not only thrown.
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("FAIL-CLOSED: still refuses even when CONVEX_SITE_URL only CONTAINS the production marker (a subdomain/lookalike host)", () => {
    vi.stubEnv("RECOUP_PROVIDER_MODE", "stub");
    vi.stubEnv("CONVEX_SITE_URL", "https://cool-oyster-399.evil.example");
    vi.stubEnv("E2E_SEED_ENABLED", "true");
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => providerStubMode()).toThrow(ConvexError);
  });
});

describe("stubbedProviderError", () => {
  it("names the provider and is a ConvexError (so it flows through the same error-shaped handling as a real provider failure)", () => {
    const err = stubbedProviderError("Firecrawl scrape", "https://acme.example/p/1");
    expect(err).toBeInstanceOf(ConvexError);
    expect(err.message).toContain("Firecrawl scrape");
    expect(err.message).toContain("https://acme.example/p/1");
    expect(err.message).toContain("RECOUP_PROVIDER_MODE=stub");
  });

  it("omits the detail parenthetical when no detail is given", () => {
    const err = stubbedProviderError("ShopSavvy");
    expect(err.message).toBe("RECOUP_PROVIDER_MODE=stub: ShopSavvy is stubbed for e2e; no live call was made.");
  });
});

describe("stubInboxFor", () => {
  it("is deterministic per user id", () => {
    const a = stubInboxFor("k17abcdef123");
    const b = stubInboxFor("k17abcdef123");
    expect(a).toEqual(b);
  });

  it("gives two different users two different addresses", () => {
    const a = stubInboxFor("userAAAAAAAA");
    const b = stubInboxFor("userBBBBBBBB");
    expect(a.inboxEmail).not.toBe(b.inboxEmail);
    expect(a.inboxId).not.toBe(b.inboxId);
  });

  it("always lands on the reserved .example domain -- never routable, never spendable", () => {
    const { inboxEmail } = stubInboxFor("someUserId12");
    expect(inboxEmail.endsWith(`@${STUB_INBOX_DOMAIN}`)).toBe(true);
    expect(STUB_INBOX_DOMAIN.endsWith(".example")).toBe(true);
  });
});
