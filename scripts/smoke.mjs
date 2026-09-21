#!/usr/bin/env node
// T22 (P12): a real, runnable smoke check against a deployed `convex.site`
// origin -- the "no service targets or smoke checks" gap the phase 0
// reproduction audit found
// (docs/reviews/2026-09-21-phase0-reproduction.md, P12 row "No service
// targets or smoke checks"). See docs/ops/RUNBOOK.md for when to run this
// and how to read a failure.
//
// Checks:
//   1. GET /, /watching, /settings, /claims/x -> 200, text/html (the SPA
//      catch-all from `@convex-dev/static-hosting`; every client-side route
//      falls back to the same index.html).
//   2. Every <script>/<link> asset the root page references, fetched and
//      scanned for a "*.convex.cloud" host: exactly one distinct host must
//      appear (the build should point at one Convex deployment, never zero
//      and never more than one baked-in origin).
//   3. POST /agentmail/webhook with body "{}" and no signature headers ->
//      401 (the component's own signature check refuses an unsigned/invalid
//      request; see convex/http.test.ts for the fuller contract-level
//      version of this check).
//   4. GET /.well-known/openid-configuration -> 200 (Convex Auth's own
//      route, `auth.addHttpRoutes`; independent of the static site build).
//
// Usage:
//   node scripts/smoke.mjs [siteUrl]
//   SITE_URL=https://your-deployment.convex.site node scripts/smoke.mjs
//
// `siteUrl` defaults to our own dev deployment (D62), never a production
// host. This script only ever reads; it never deploys anything -- do not
// add a `deploy` step here or to whatever calls this script.
//
// Exits 0 only if every check passed; prints one table row per check either
// way. A path 404ing does not crash the script -- it is recorded as a clear,
// named failure (the static site build may simply not be deployed to this
// host yet; this script never runs `npm run deploy` to fix that itself).

const DEFAULT_SITE_URL = "https://adorable-lion-138.convex.site";
const FETCH_TIMEOUT_MS = 15_000;
const HTML_PATHS = ["/", "/watching", "/settings", "/claims/x"];
const CONVEX_CLOUD_HOST_RE = /https?:\/\/([a-z0-9-]+\.convex\.cloud)/gi;
const ASSET_TAG_RES = [/<script[^>]+src="([^"]+)"/gi, /<link[^>]+href="([^"]+\.(?:js|css))"/gi];
// F-T25-1: `convex`'s own ConvexReactClient constructor throws this literal
// example URL in its "no address provided" / "wrong address type" error
// messages (node_modules/convex/src/react/client.ts:358 as of convex@1.46.0:
// `` `ConvexReactClient requires a URL like 'https://happy-otter-123.convex.cloud', ...` ``).
// That whole client library ships inside the app bundle, so this literal
// string always matches CONVEX_CLOUD_HOST_RE too -- an inert, never-real
// host baked into a third-party dependency's error text, not a second
// Convex deployment this build actually talks to. Excluded by name so the
// check still fails on any OTHER second host (a real regression: the build
// pointing at more than one live deployment).
const DOCUMENTED_EXAMPLE_HOST = "happy-otter-123.convex.cloud";

const siteUrl = (process.argv[2] ?? process.env.SITE_URL ?? DEFAULT_SITE_URL).trim().replace(/\/+$/, "");

/** @type {Array<{ check: string; result: "PASS" | "FAIL"; detail: string }>} */
const rows = [];
let anyFailed = false;

function record(check, ok, detail = "") {
  rows.push({ check, result: ok ? "PASS" : "FAIL", detail });
  if (!ok) anyFailed = true;
}

function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

async function fetchWithTimeout(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** GET one path, expecting 200 text/html. Returns the body on success, null otherwise (including a 404, reported as a named "not deployed" failure rather than a crash). */
async function checkHtmlPage(path) {
  const url = `${siteUrl}${path}`;
  try {
    const res = await fetchWithTimeout(url);
    const contentType = res.headers.get("content-type") ?? "";
    if (res.status === 404 || res.status === 503) {
      // `@convex-dev/static-hosting` answers "/" with 503 (its own built-in
      // "nothing uploaded yet" setup page) when no site has ever been
      // pushed, and any other path with a plain 404 (no matching asset, no
      // index.html to fall back to either) -- both mean the same thing:
      // this host has Convex functions but no static build deployed to it.
      record(
        `GET ${path}`,
        false,
        `${res.status} -- the static site build is not deployed on this host (this repo's own dev static site may simply not have been pushed here; see docs/ops/RUNBOOK.md before assuming a real regression)`,
      );
      return null;
    }
    const ok = res.status === 200 && contentType.includes("text/html");
    record(`GET ${path}`, ok, `${res.status} ${contentType}`.trim());
    return ok ? await res.text() : null;
  } catch (err) {
    record(`GET ${path}`, false, `request failed: ${errorMessage(err)}`);
    return null;
  }
}

function extractAssetUrls(html, baseUrl) {
  const urls = new Set();
  for (const re of ASSET_TAG_RES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(html)) !== null) {
      try {
        urls.add(new URL(m[1], baseUrl).toString());
      } catch {
        // Malformed asset URL in the HTML: skip rather than crash the script over it.
      }
    }
  }
  return [...urls];
}

/** Scans every asset the root page references for exactly one distinct "*.convex.cloud" host. */
async function checkBundleReferencesOneConvexCloudHost(rootHtml) {
  const check = "bundle references exactly one .convex.cloud host";
  if (!rootHtml) {
    record(check, false, "skipped: GET / did not return HTML (see the GET / row above)");
    return;
  }
  const assetUrls = extractAssetUrls(rootHtml, `${siteUrl}/`);
  if (assetUrls.length === 0) {
    record(check, false, "no <script src> or <link href> asset tags found on /");
    return;
  }

  const hosts = new Set();
  const unreadable = [];
  for (const assetUrl of assetUrls) {
    try {
      const res = await fetchWithTimeout(assetUrl);
      if (!res.ok) {
        unreadable.push(`${assetUrl} (${res.status})`);
        continue;
      }
      const text = await res.text();
      CONVEX_CLOUD_HOST_RE.lastIndex = 0;
      let m;
      while ((m = CONVEX_CLOUD_HOST_RE.exec(text)) !== null) hosts.add(m[1].toLowerCase());
    } catch (err) {
      unreadable.push(`${assetUrl} (${errorMessage(err)})`);
    }
  }

  // F-T25-1: drop the inert documented example host before judging
  // uniqueness -- see DOCUMENTED_EXAMPLE_HOST's own comment.
  hosts.delete(DOCUMENTED_EXAMPLE_HOST);

  if (hosts.size === 0 && unreadable.length > 0) {
    record(check, false, `could not read any referenced asset: ${unreadable.join(", ")}`);
    return;
  }
  const ok = hosts.size === 1;
  const suffix = unreadable.length > 0 ? ` (also unreadable: ${unreadable.join(", ")})` : "";
  record(check, ok, ok ? `${[...hosts][0]}${suffix}` : `found ${hosts.size} distinct host(s): ${[...hosts].join(", ") || "none"}${suffix}`);
}

async function checkWebhookRejectsEmptyBody() {
  const check = "POST /agentmail/webhook {} -> 401";
  try {
    const res = await fetchWithTimeout(`${siteUrl}/agentmail/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    record(check, res.status === 401, `got ${res.status}`);
  } catch (err) {
    record(check, false, `request failed: ${errorMessage(err)}`);
  }
}

async function checkOpenIdConfiguration() {
  const check = "GET /.well-known/openid-configuration -> 200";
  try {
    const res = await fetchWithTimeout(`${siteUrl}/.well-known/openid-configuration`);
    record(check, res.status === 200, `got ${res.status}`);
  } catch (err) {
    record(check, false, `request failed: ${errorMessage(err)}`);
  }
}

async function main() {
  console.log(`[smoke] target: ${siteUrl}`);

  let rootHtml = null;
  for (const path of HTML_PATHS) {
    const html = await checkHtmlPage(path);
    if (path === "/") rootHtml = html;
  }
  await checkBundleReferencesOneConvexCloudHost(rootHtml);
  await checkWebhookRejectsEmptyBody();
  await checkOpenIdConfiguration();

  console.table(rows);

  const failedCount = rows.filter((r) => r.result === "FAIL").length;
  if (anyFailed) {
    console.error(`[smoke] FAILED - ${failedCount} of ${rows.length} check(s) failed against ${siteUrl}`);
    process.exitCode = 1;
    return;
  }
  console.log(`[smoke] OK - ${rows.length} check(s) passed against ${siteUrl}`);
}

main().catch((err) => {
  console.error(`[smoke] FAILED - unexpected error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exitCode = 1;
});
