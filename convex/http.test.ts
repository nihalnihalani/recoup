/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Webhook } from "svix";
import agentmailTest from "@agentmail/convex/test";
import staticHostingTest from "@convex-dev/static-hosting/test";
import { internal } from "./_generated/api";
import { setup } from "./test.setup";

/**
 * P08 contract tests for convex/http.ts, exercised through `t.fetch` against
 * the real httpRouter (T02). Nothing here calls a real provider: the
 * AgentMail webhook signature is computed locally with the same `svix`
 * library `@agentmail/convex` verifies with, using the
 * `AGENTMAIL_WEBHOOK_SECRET` `test.setup.ts` sets ("whsec_test").
 *
 * `test.setup.ts` is used as-is (not edited by this task). It registers the
 * "agentmail" component from `@agentmail/convex/test`'s `modules`, which is
 * `import.meta.glob("./component/**\/!(*.*.*)*.ts")` evaluated from
 * `node_modules/@agentmail/convex/dist/test.js` -- but `dist/component/`
 * ships only compiled `.d.ts` files (no plain `.ts` source: confirmed by
 * `find node_modules/@agentmail/convex/dist/component -iname '*.ts'`), so
 * that glob matches nothing and dispatching into `component.lib.<fn>` under
 * plain `setup()` fails with `Could not find module for: "lib"` -- the same
 * limitation convex/drafts.test.ts:402-411 already documents for `sendMessage`
 * ("the component's module map is empty and any dispatch into it fails...").
 *
 * The tests that need a real signed delivery to actually reach
 * `component.lib.handleEvent` re-register "agentmail" themselves (D51's
 * exhaustive-glob treatment, applied locally in THIS file only -- test.setup.ts
 * is never touched) against the component's real `src/` tree instead of the
 * empty `dist/test.js` map; `registerComponent` is a plain overwrite
 * (node_modules/convex-test/dist/index.js:1891), so calling it again after
 * `setup()` simply replaces the empty component registration with a working
 * one before any component state exists. The static-hosting component isn't
 * registered by `test.setup.ts` at all, so the one test that falls through to
 * its catch-all route registers it the same way.
 */

const SECRET = "whsec_test"; // must match test.setup.ts's AGENTMAIL_WEBHOOK_SECRET
const PATH = "/agentmail/webhook";

const agentmailSrcModules = import.meta.glob("../node_modules/@agentmail/convex/src/component/**/*.ts", {
  exhaustive: true,
});
const staticHostingSrcModules = import.meta.glob("../node_modules/@convex-dev/static-hosting/src/component/**/*.ts", {
  exhaustive: true,
});

/** `setup()`, but with a real (not empty) module map for the agentmail component, so a signed delivery can actually dispatch into it. */
function setupWithAgentmailDispatch(): ReturnType<typeof setup> {
  const t = setup();
  t.registerComponent("agentmail", agentmailTest.schema, agentmailSrcModules);
  return t;
}

/** `setup()` plus the staticHosting component, for the one test that falls through to its catch-all route (not registered by test.setup.ts at all). */
function setupWithStaticHosting(): ReturnType<typeof setup> {
  const t = setup();
  t.registerComponent("staticHosting", staticHostingTest.schema, staticHostingSrcModules);
  return t;
}

function sign(id: string, timestampSeconds: number, body: string): string {
  return new Webhook(SECRET).sign(id, new Date(timestampSeconds * 1000), body);
}

function svixHeaders(over: Partial<Record<"svix-id" | "svix-timestamp" | "svix-signature", string>> = {}) {
  return {
    "content-type": "application/json",
    "svix-id": "msg_test_1",
    "svix-timestamp": String(Math.floor(Date.now() / 1000)),
    "svix-signature": "v1,not-a-real-signature",
    ...over,
  };
}

/**
 * A minimal, well-formed `message.received` event body (component shape,
 * `vEvent` in node_modules/@agentmail/convex/src/component/shared.ts). `thread`
 * is included (even as `null`) because `inbound.onMessageReceived`'s own args
 * validator declares it `v.any()`, not `v.optional(v.any())`: a real delivery
 * that omitted `thread` entirely would make the callbackPool dispatch fail
 * argument validation ("Missing required field `thread`") before
 * `onMessageReceived`'s handler -- and its try/catch -- ever runs, which
 * would mean no `processedEvents` row is written for that delivery, contrary
 * to inbound.ts's own "must never throw" contract. Confirmed empirically
 * against this test harness; not otherwise exercised here since AgentMail's
 * real webhook payloads always carry a `thread` value.
 */
function messageReceivedBody(over: { event_id?: string; inbox_id?: string } = {}): string {
  return JSON.stringify({
    type: "event",
    event_type: "message.received",
    event_id: over.event_id ?? "evt_test_1",
    message: {
      inbox_id: over.inbox_id ?? "inbox_unclaimed",
      message_id: "msg_inbound_1",
      thread_id: "thread_1",
      from: "shopper@example.com",
      to: "recoup-test@agentmail.to",
      subject: "Re: your order",
      text: "hello",
    },
    thread: null,
  });
}

/** Signs `body` with a fresh id/timestamp and returns fetch-ready headers. */
function signedHeaders(body: string, id = "msg_signed_1"): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000);
  return svixHeaders({
    "svix-id": id,
    "svix-timestamp": String(timestamp),
    "svix-signature": sign(id, timestamp, body),
  });
}

async function processedEventCount(t: ReturnType<typeof setup>): Promise<number> {
  return (await t.run(async (ctx) => ctx.db.query("processedEvents").collect())).length;
}

// Fake timers throughout, matching the convention in convex/inbound.test.ts:
// a scheduled function fired on a real timer could otherwise run in the
// background unobserved. Every payload here targets an inbox no `profiles`
// row claims, so `inbound.onMessageReceived` takes the D33 "ignored" branch
// and schedules nothing further -- draining with `finishAllScheduledFunctions`
// is safe to run to completion and never reaches a provider call
// (intake.processEvent / replies.classify).
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("POST /agentmail/webhook", () => {
  it("unsigned request is refused with 401 and writes no processedEvents row", async () => {
    const t = setup();
    const body = messageReceivedBody();
    const res = await t.fetch(PATH, {
      method: "POST",
      body,
      headers: { "content-type": "application/json" }, // no svix-* headers at all
    });
    expect(res.status).toBe(401);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await processedEventCount(t)).toBe(0);
  });

  it("a bad signature is refused with 401 and writes no processedEvents row", async () => {
    const t = setup();
    const body = messageReceivedBody();
    const timestamp = Math.floor(Date.now() / 1000);
    // Well-formed headers, but the signature was not computed over this body/secret.
    const res = await t.fetch(PATH, {
      method: "POST",
      body,
      headers: svixHeaders({
        "svix-timestamp": String(timestamp),
        "svix-signature": "v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      }),
    });
    expect(res.status).toBe(401);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await processedEventCount(t)).toBe(0);
  });

  it("malformed JSON with fake (unverified) svix headers is refused 4xx, not 500", async () => {
    const t = setup();
    const body = "{ this is not valid json";
    const res = await t.fetch(PATH, { method: "POST", body, headers: svixHeaders() });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await processedEventCount(t)).toBe(0);
  });

  it("malformed JSON under an otherwise-valid signature is still refused 4xx, not 500", async () => {
    // The signature is computed correctly over this exact (invalid-JSON)
    // body, so this exercises the JSON.parse failure inside svix's own
    // verify() (standardwebhooks checks the HMAC BEFORE parsing, so a valid
    // signature over garbage JSON reaches JSON.parse), not the HMAC check
    // itself. Current behaviour: @agentmail/convex's webhook.ts wraps ANY
    // verify() failure (bad signature or this JSON.parse throw) into the
    // same WebhookVerificationError, so this also comes back 401, not 500.
    const t = setup();
    const body = "{ this is not valid json";
    const res = await t.fetch(PATH, { method: "POST", body, headers: signedHeaders(body, "msg_malformed_signed") });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await processedEventCount(t)).toBe(0);
  });

  it("a correctly signed message.received event returns 2xx and writes exactly one processedEvents row", async () => {
    const t = setupWithAgentmailDispatch();
    const body = messageReceivedBody({ event_id: "evt_accepted_1" });
    const res = await t.fetch(PATH, { method: "POST", body, headers: signedHeaders(body, "msg_accepted_1") });
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);
    // Drains the callbackPool workpool dispatch of inbound.onMessageReceived.
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await processedEventCount(t)).toBe(1);
    const [row] = await t.run(async (ctx) => ctx.db.query("processedEvents").collect());
    expect(row.externalId).toBe("evt_accepted_1");
    // No `profiles` row claims "inbox_unclaimed" (D33): ignored, not an error.
    expect(row.route).toBe("ignored");
    expect(row.status).toBe("succeeded");
  });

  it("replaying the same signed payload again still leaves exactly one processedEvents row", async () => {
    const t = setupWithAgentmailDispatch();
    const body = messageReceivedBody({ event_id: "evt_replayed_1" });
    const headers = signedHeaders(body, "msg_replayed_1");

    const first = await t.fetch(PATH, { method: "POST", body, headers });
    expect(first.status).toBeGreaterThanOrEqual(200);
    expect(first.status).toBeLessThan(300);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await processedEventCount(t)).toBe(1);

    // Byte-for-byte replay of the exact same signed delivery (same svix-id,
    // timestamp and signature, e.g. a provider retry): the AgentMail
    // component dedupes on the event's own `event_id`
    // (node_modules/@agentmail/convex/src/component/lib.ts:438-443,
    // `handleEvent`'s `events.by_eventId` lookup) before ever re-invoking the
    // `onMessageReceived` callback a second time.
    const second = await t.fetch(PATH, { method: "POST", body, headers });
    expect(second.status).toBeGreaterThanOrEqual(200);
    expect(second.status).toBeLessThan(300);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await processedEventCount(t)).toBe(1);
  });

  it("an oversized unsigned body is rejected, not a 500, and writes no processedEvents row", async () => {
    const t = setup();
    // ~2 MB body (PLAN.md item (f)): documents that a large delivery cannot
    // crash the endpoint. Left unsigned so this does not also depend on
    // Convex's own document/argument size ceiling for a *signed* 2 MB body
    // reaching the database, which is a separate, larger question this test
    // does not attempt (see the report's "known gaps").
    const big = "x".repeat(2 * 1024 * 1024);
    const body = JSON.stringify({
      type: "event",
      event_type: "message.received",
      event_id: "evt_big_1",
      message: {
        inbox_id: "inbox_unclaimed",
        message_id: "msg_big_1",
        thread_id: "t",
        from: "a@example.com",
        to: "b@example.com",
        text: big,
      },
      thread: null,
    });
    const res = await t.fetch(PATH, { method: "POST", body, headers: svixHeaders() });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(600);
    expect(res.status).not.toBe(200);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await processedEventCount(t)).toBe(0);
  });
});

describe("GET /agentmail/webhook", () => {
  it("falls through to the static-hosting catch-all instead of 500ing", async () => {
    const t = setupWithStaticHosting();
    const res = await t.fetch(PATH, { method: "GET" });
    // No route is registered for GET on this exact path, so it falls to the
    // static-hosting catch-all (registered last in http.ts, after the exact
    // POST route). With nothing deployed to the component, the real
    // behaviour is a plain 404 (or the setup-mode 503 for "/index.html",
    // which this path is not) -- either way, not an unhandled-exception 500.
    expect(res.status).not.toBe(500);
  });
});

describe("FIXED (D86/T06): inbound.onMessageReceived's args validator", () => {
  /**
   * Was FINDING (convex/inbound.ts:94): the args validator declared
   * `thread: v.any()`, not `v.optional(v.any())`, but the component's own
   * event shape allows a "message.received" delivery with no `thread` at
   * all (node_modules/@agentmail/convex/src/component/shared.ts `vEvent`:
   * `thread: v.optional(v.any())`). `handleEvent` passes `event.thread`
   * straight through to this callback
   * (node_modules/@agentmail/convex/src/component/lib.ts ~488-495), so a
   * delivery whose `thread` is genuinely absent failed Convex's own argument
   * validation ("Missing required field `thread`") before
   * `onMessageReceived`'s handler -- and its try/catch -- ever ran. That
   * silently violated the function's own contract, quoted at
   * convex/inbound.ts:82-91: "It is the one function in the app that must
   * never throw... Every failure is therefore recorded as a processedEvents
   * row." Reproduced directly against the internal mutation, bypassing the
   * webhook route and signature entirely, so this was not a harness
   * artefact of the component-dispatch limitation documented above; it was
   * this function's own args shape.
   *
   * Fixed in convex/inbound.ts: `thread: v.optional(v.any())`. This test now
   * asserts the fix (flipped from `it.fails` to a normal passing `it`, D86).
   */
  it("a message.received delivery with no `thread` field still writes a processedEvents row, without throwing", async () => {
    const t = setup();
    await t.mutation(internal.inbound.onMessageReceived, {
      message: { inbox_id: "inbox_1", message_id: "m1", from: "a@b.com", subject: "s", text: "t" },
      eventId: "evt-no-thread",
    } as never);
    const rows = await t.run(async (ctx) => ctx.db.query("processedEvents").collect());
    expect(rows.length).toBe(1);
  });
});

describe("GET/POST /alerts/unsubscribe (T06, contract T06(g).5)", () => {
  async function seedAlertSettings(t: ReturnType<typeof setup>, token: string) {
    const userId = await t.run(async (ctx) => ctx.db.insert("users", { name: "Tester" }));
    await t.run((ctx) =>
      ctx.db.insert("alertSettings", { userId, alertsEnabled: true, unsubscribeToken: token, updatedAt: Date.now() }),
    );
    return userId;
  }

  it("GET returns a 200 page with a POST form, and writes nothing", async () => {
    const t = setup();
    const userId = await seedAlertSettings(t, "tok-get-1");

    const res = await t.fetch(`/alerts/unsubscribe?token=tok-get-1`, { method: "GET" });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<form");
    expect(html).toContain('method="POST"');
    expect(html).toContain("tok-get-1");

    const row = await t.run((ctx) =>
      ctx.db.query("alertSettings").withIndex("by_user", (q) => q.eq("userId", userId)).first(),
    );
    expect(row?.alertsEnabled).toBe(true); // untouched by GET
  });

  it("POST with a valid token disables alerts and marks user_unsubscribed", async () => {
    const t = setup();
    const userId = await seedAlertSettings(t, "tok-post-1");

    const res = await t.fetch(`/alerts/unsubscribe?token=tok-post-1`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/no longer receive/i);

    const row = await t.run((ctx) =>
      ctx.db.query("alertSettings").withIndex("by_user", (q) => q.eq("userId", userId)).first(),
    );
    expect(row?.alertsEnabled).toBe(false);
    expect(row?.suppressedReason).toBe("user_unsubscribed");
  });

  it("POST with a garbage/wrong token still returns 200 and writes nothing (never leaks validity)", async () => {
    const t = setup();
    const userId = await seedAlertSettings(t, "tok-real-1");

    const res = await t.fetch(`/alerts/unsubscribe?token=${"x".repeat(500)}`, { method: "POST" });
    expect(res.status).toBe(200);

    const row = await t.run((ctx) =>
      ctx.db.query("alertSettings").withIndex("by_user", (q) => q.eq("userId", userId)).first(),
    );
    expect(row?.alertsEnabled).toBe(true); // the real row, untouched
  });

  it("POST with no token at all still returns 200", async () => {
    const t = setup();
    const res = await t.fetch(`/alerts/unsubscribe`, { method: "POST" });
    expect(res.status).toBe(200);
  });
});

describe("auth discovery route", () => {
  it("GET /.well-known/openid-configuration returns 200", async () => {
    const previous = process.env.CONVEX_SITE_URL;
    // @convex-dev/auth's discovery route requires CONVEX_SITE_URL
    // (node_modules/@convex-dev/auth/dist/server/utils.js:requireEnv), which
    // the platform sets in production/dev deployments but which convex-test
    // does not synthesize; test.setup.ts does not set it either, so it is
    // set here, scoped to this one test, and restored afterwards.
    process.env.CONVEX_SITE_URL = "https://example-test.convex.site";
    try {
      const t = setup();
      const res = await t.fetch("/.well-known/openid-configuration", { method: "GET" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { issuer?: string };
      expect(body.issuer).toBe("https://example-test.convex.site");
    } finally {
      if (previous === undefined) delete process.env.CONVEX_SITE_URL;
      else process.env.CONVEX_SITE_URL = previous;
    }
  });
});
