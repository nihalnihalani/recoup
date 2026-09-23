/// <reference types="vite/client" />
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConvexError } from "convex/values";
import { setup } from "../test.setup";
import { internal } from "../_generated/api";
import { authMail, authMailTransport, sendViaProvider } from "./authMail";

/** `sendVerificationRequest` is typed with one declared parameter (the
 * library's own `EmailConfig` shape); the library actually calls it with an
 * undeclared second `ctx` argument (contract T05 g4). Tests reach past the
 * declared type the same way the library does at runtime. */
type SendVerificationRequest = (
  args: { identifier: string; token: string; expires: Date },
  ctx: unknown,
) => Promise<void>;

function send(kind: "verify" | "reset") {
  return authMail(kind).sendVerificationRequest as unknown as SendVerificationRequest;
}

describe("authMail() generateVerificationToken (D65)", () => {
  it("produces an 8-digit numeric code for both kinds", async () => {
    for (const kind of ["verify", "reset"] as const) {
      const code = await authMail(kind).generateVerificationToken!();
      expect(code).toMatch(/^\d{8}$/);
    }
  });

  it("uses distinct provider ids so a verify code cannot double as a reset code", () => {
    expect(authMail("verify").id).toBe("recoup-verify");
    expect(authMail("reset").id).toBe("recoup-reset");
  });

  it("sets maxAge from VERIFICATION_CODE_TTL_S (900s / 15 minutes)", () => {
    expect(authMail("verify").maxAge).toBe(900);
    expect(authMail("reset").maxAge).toBe(900);
  });
});

describe("authMail().sendVerificationRequest wiring (contract T05 f2)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes the plain code, kind and a fixed subject to the transport, with expiry rounded from `expires`", async () => {
    const t = setup();
    const spy = vi.spyOn(authMailTransport, "send").mockResolvedValue(undefined);
    const expires = new Date(Date.now() + 15 * 60_000);

    await t.run(
      async (ctx) => await send("verify")({ identifier: "person@example.com", token: "12345678", expires }, ctx),
    );

    expect(spy).toHaveBeenCalledTimes(1);
    // D102: `send` now also receives `ctx` as a second (undeclared) argument
    // — asserted loosely here (`expect.anything()`), since its exact shape
    // is convex-test's plumbing, not this wiring contract's concern.
    expect(spy).toHaveBeenCalledWith(
      {
        to: "person@example.com",
        kind: "verify",
        code: "12345678",
        expiresInMinutes: 15,
      },
      expect.anything(),
    );
  });

  it("the reset kind reaches the transport as kind: reset", async () => {
    const t = setup();
    const spy = vi.spyOn(authMailTransport, "send").mockResolvedValue(undefined);
    const expires = new Date(Date.now() + 15 * 60_000);

    await t.run(async (ctx) => await send("reset")({ identifier: "person@example.com", token: "87654321", expires }, ctx));

    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ kind: "reset", code: "87654321" }), expect.anything());
  });

  it("throws (before the transport is reached) when ctx is missing", async () => {
    const spy = vi.spyOn(authMailTransport, "send").mockResolvedValue(undefined);
    await expect(
      send("verify")({ identifier: "person@example.com", token: "12345678", expires: new Date() }, undefined),
    ).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });

  it("4th send to the same address within an hour throws and does not reach the transport", async () => {
    const t = setup();
    const spy = vi.spyOn(authMailTransport, "send").mockResolvedValue(undefined);
    const args = { identifier: "capped@example.com", token: "12345678", expires: new Date(Date.now() + 900_000) };

    for (let i = 0; i < 3; i++) {
      await t.run(async (ctx) => await send("verify")(args, ctx));
    }
    expect(spy).toHaveBeenCalledTimes(3);

    await expect(t.run(async (ctx) => await send("verify")(args, ctx))).rejects.toThrow();
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it("the per-address cap is shared across verify and reset (same rate-limit key: the address)", async () => {
    const t = setup();
    vi.spyOn(authMailTransport, "send").mockResolvedValue(undefined);
    const identifier = "shared@example.com";
    const expires = new Date(Date.now() + 900_000);

    await t.run(async (ctx) => await send("verify")({ identifier, token: "11111111", expires }, ctx));
    await t.run(async (ctx) => await send("reset")({ identifier, token: "22222222", expires }, ctx));
    await t.run(async (ctx) => await send("verify")({ identifier, token: "33333333", expires }, ctx));

    await expect(t.run(async (ctx) => await send("reset")({ identifier, token: "44444444", expires }, ctx))).rejects.toThrow();
  });
});

describe("authMailTransport.send default implementation (AgentMail REST)", () => {
  const ENV_KEYS = ["AGENTMAIL_API_KEY", "ALERTS_INBOX_ID", "AGENTMAIL_BASE_URL"] as const;
  const saved: Record<string, string | undefined> = {};

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  function stashEnv() {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
  }

  it("throws a non-enumerating error without echoing the body when ALERTS_INBOX_ID is missing", async () => {
    stashEnv();
    process.env.AGENTMAIL_API_KEY = "am-test";
    delete process.env.ALERTS_INBOX_ID;
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(
      authMailTransport.send({ to: "a@b.com", kind: "verify", code: "12345678", expiresInMinutes: 15 }),
    ).rejects.toThrow(ConvexError);
    await expect(
      authMailTransport.send({ to: "a@b.com", kind: "verify", code: "12345678", expiresInMinutes: 15 }),
    ).rejects.toThrow("Could not send the email right now");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("throws without echoing the body when AGENTMAIL_API_KEY is missing", async () => {
    stashEnv();
    delete process.env.AGENTMAIL_API_KEY;
    process.env.ALERTS_INBOX_ID = "inbox_1";
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(
      authMailTransport.send({ to: "a@b.com", kind: "verify", code: "12345678", expiresInMinutes: 15 }),
    ).rejects.toThrow("Could not send the email right now");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("throws without echoing a non-ok response body (it may quote the auth header)", async () => {
    stashEnv();
    process.env.AGENTMAIL_API_KEY = "am-test";
    process.env.ALERTS_INBOX_ID = "inbox_1";
    const secretBody = "unauthorized: Bearer am-test is invalid";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(secretBody, { status: 401 })),
    );

    let caught: unknown;
    try {
      await authMailTransport.send({ to: "a@b.com", kind: "verify", code: "12345678", expiresInMinutes: 15 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConvexError);
    expect(JSON.stringify((caught as ConvexError<string>).data)).not.toContain("am-test");
    expect(JSON.stringify((caught as ConvexError<string>).data)).not.toContain(secretBody);
  });

  it("posts to the inbox's send endpoint with bearer auth and the fixed template on success", async () => {
    stashEnv();
    process.env.AGENTMAIL_API_KEY = "am-test";
    process.env.ALERTS_INBOX_ID = "inbox_1";
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    await authMailTransport.send({ to: "a@b.com", kind: "reset", code: "12345678", expiresInMinutes: 15 });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.agentmail.to/v0/inboxes/inbox_1/messages/send");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer am-test");
    const body = JSON.parse(init.body as string);
    expect(body.to).toEqual(["a@b.com"]);
    expect(body.subject).toBe("Your Recoup password reset code");
    expect(body.text).toContain("12345678");
    expect(body.text).toContain("15 minutes");
    expect(body.text).not.toMatch(/https?:\/\//); // no links (invariant)
  });
});

describe("authMailTransport.send — D102: E2E code capture (E2E_SEED_ENABLED)", () => {
  const ENV_KEYS = ["E2E_SEED_ENABLED", "CONVEX_SITE_URL", "AGENTMAIL_API_KEY", "ALERTS_INBOX_ID"] as const;
  const saved: Record<string, string | undefined> = {};

  function stashEnv() {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
  }

  afterEach(() => {
    vi.restoreAllMocks();
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  async function readCapturedCode(t: ReturnType<typeof setup>, email: string) {
    return await t.run(async (ctx) =>
      ctx.db
        .query("opsState")
        .withIndex("by_key", (q) => q.eq("key", `e2e:code:${email}`))
        .unique(),
    );
  }

  it("with E2E_SEED_ENABLED=true, a signUp's code send records the code and succeeds even when the provider throws (no credentials)", async () => {
    stashEnv();
    process.env.E2E_SEED_ENABLED = "true";
    process.env.CONVEX_SITE_URL = "https://recoup-test.convex.site";
    // A keyless disposable deployment: the real AgentMail call would throw.
    delete process.env.AGENTMAIL_API_KEY;
    delete process.env.ALERTS_INBOX_ID;

    const t = setup();
    const email = "e2e-capture@example.com";
    const expires = new Date(Date.now() + 900_000);

    // Does not throw, even though sendViaProvider necessarily would.
    await t.run(async (ctx) => {
      await send("verify")({ identifier: email, token: "12345678", expires }, ctx);
    });

    const row = await readCapturedCode(t, email);
    expect(row?.cursor).toBe("12345678");
  });

  it("with E2E_SEED_ENABLED unset, nothing is recorded and a provider failure still throws (behavior unchanged)", async () => {
    stashEnv();
    delete process.env.E2E_SEED_ENABLED;
    delete process.env.AGENTMAIL_API_KEY;
    delete process.env.ALERTS_INBOX_ID;

    const t = setup();
    const email = "no-e2e@example.com";
    const expires = new Date(Date.now() + 900_000);

    await expect(
      t.run(async (ctx) => await send("verify")({ identifier: email, token: "87654321", expires }, ctx)),
    ).rejects.toThrow("Could not send the email right now");

    expect(await readCapturedCode(t, email)).toBeNull();
  });

  it("recordE2ECode refuses on the documented production host even when E2E_SEED_ENABLED is set", async () => {
    stashEnv();
    process.env.E2E_SEED_ENABLED = "true";
    process.env.CONVEX_SITE_URL = "https://cool-oyster-399.convex.site";

    const t = setup();
    const email = "prod-guard@example.com";

    await expect(
      t.mutation(internal.lib.authMail.recordE2ECode, { email, code: "12345678", kind: "verify" }),
    ).rejects.toThrow();

    expect(await readCapturedCode(t, email)).toBeNull();
  });

  it("recordE2ECode refuses when E2E_SEED_ENABLED is not set to the exact string \"true\"", async () => {
    stashEnv();
    delete process.env.E2E_SEED_ENABLED;
    process.env.CONVEX_SITE_URL = "https://recoup-test.convex.site";

    const t = setup();
    const email = "gate-off@example.com";

    await expect(
      t.mutation(internal.lib.authMail.recordE2ECode, { email, code: "12345678", kind: "reset" }),
    ).rejects.toThrow();

    expect(await readCapturedCode(t, email)).toBeNull();
  });
});

describe("P10-OW-12: RECOUP_PROVIDER_MODE=stub", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    delete process.env.AGENTMAIL_API_KEY;
    delete process.env.ALERTS_INBOX_ID;
  });

  it("sendViaProvider (the auth-code AgentMail-send call site) throws a stub error without ever calling fetch, even with real-looking credentials present", async () => {
    process.env.AGENTMAIL_API_KEY = "a-real-looking-key";
    process.env.ALERTS_INBOX_ID = "inbox-real";
    vi.stubEnv("RECOUP_PROVIDER_MODE", "stub");
    // QA2-3: stub mode now refuses without a positive dev/E2E signal; supply the dev host.
    vi.stubEnv("CONVEX_SITE_URL", "https://adorable-lion-138.convex.site");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(sendViaProvider({ to: "user@example.com", kind: "verify", code: "12345678", expiresInMinutes: 15 })).rejects.toThrow(
      /RECOUP_PROVIDER_MODE=stub/,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("with E2E_SEED_ENABLED=true, a signUp's code send still records the code and succeeds under RECOUP_PROVIDER_MODE=stub, without ever calling fetch (real credentials present, unlike the keyless case above)", async () => {
    process.env.E2E_SEED_ENABLED = "true";
    process.env.CONVEX_SITE_URL = "https://adorable-lion-138.convex.site";
    process.env.AGENTMAIL_API_KEY = "a-real-looking-key";
    process.env.ALERTS_INBOX_ID = "inbox-real";
    vi.stubEnv("RECOUP_PROVIDER_MODE", "stub");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const t = setup();
    const email = "e2e-stub-capture@example.com";
    const expires = new Date(Date.now() + 900_000);

    await t.run(async (ctx) => {
      await send("verify")({ identifier: email, token: "22334455", expires }, ctx);
    });

    const row = await t.run(async (ctx) =>
      ctx.db.query("opsState").withIndex("by_key", (q) => q.eq("key", `e2e:code:${email}`)).unique(),
    );
    expect(row?.cursor).toBe("22334455");
    expect(fetchSpy).not.toHaveBeenCalled();

    delete process.env.E2E_SEED_ENABLED;
    delete process.env.CONVEX_SITE_URL;
  });
});
