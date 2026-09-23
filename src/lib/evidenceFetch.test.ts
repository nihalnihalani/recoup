/**
 * M24: the browser side of the evidence routes. Uploads send the declared doc type, retry exactly once after a 401
 * with a fresh token (§9), and map every refusal to plain copy that never claims a file was stored. Previews are
 * built only for an image whose server type AND bytes agree (DA-A-28b).
 */
import { describe, expect, it, vi } from "vitest";
import { evidenceSiteUrl, fetchEvidenceFile, MAX_UPLOAD_BYTES, uploadEvidence } from "./evidenceFetch";

const SITE = "https://quiet-fox-1.convex.site";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
const PDF = new Uint8Array(new TextEncoder().encode("%PDF-1.7\n%âãÏÓ\n1 0 obj"));

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function file(bytes: Uint8Array<ArrayBuffer>, name = "receipt.png"): Blob & { name: string } {
  return Object.assign(new Blob([bytes]), { name });
}

describe("evidenceSiteUrl", () => {
  it("uses the explicit site URL, else derives it from the cloud URL", () => {
    expect(evidenceSiteUrl({ VITE_CONVEX_SITE_URL: "https://a.convex.site/" })).toBe("https://a.convex.site");
    expect(evidenceSiteUrl({ VITE_CONVEX_URL: "https://quiet-fox-1.convex.cloud" })).toBe(SITE);
    expect(evidenceSiteUrl({ VITE_CONVEX_URL: "https://example.com" })).toBeNull();
    expect(evidenceSiteUrl({})).toBeNull();
  });
});

describe("uploadEvidence", () => {
  it("posts the file with its declared type and a bearer token, and reports what the server stored", async () => {
    const fetchImpl = vi.fn(async () => json(200, { evidenceId: "ev1", duplicate: false, extractionStatus: "store_only" }));
    const result = await uploadEvidence({ file: file(PNG, "reçu.png"), docType: "receipt", getToken: () => "tok", siteUrl: SITE, fetchImpl, online: true });
    expect(result).toEqual({ ok: true, evidenceId: "ev1", duplicate: false, extractionStatus: "store_only" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${SITE}/evidence/upload`);
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ Authorization: "Bearer tok", "X-Doc-Type": "receipt", "X-File-Name": "re%C3%A7u.png" });
  });

  it("refuses to send without a declared type, when offline, when empty or over 10 MB", async () => {
    const fetchImpl = vi.fn();
    const base = { getToken: () => "tok", siteUrl: SITE, fetchImpl, online: true };
    expect(await uploadEvidence({ ...base, file: file(PNG), docType: "" })).toMatchObject({ ok: false, reason: "unknown_doc_type" });
    expect(await uploadEvidence({ ...base, file: file(PNG), docType: "receipt", online: false })).toMatchObject({ ok: false, reason: "offline" });
    expect(await uploadEvidence({ ...base, file: file(new Uint8Array(0)), docType: "receipt" })).toMatchObject({ ok: false, reason: "empty" });
    const big = Object.assign(new Blob([new Uint8Array(MAX_UPLOAD_BYTES + 1)]), { name: "big.pdf" });
    expect(await uploadEvidence({ ...base, file: big, docType: "receipt" })).toMatchObject({ ok: false, reason: "too_large" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("after a 401, retries exactly once with the token the auth client holds now", async () => {
    const tokens = ["expired", "fresh"];
    const getToken = vi.fn(() => tokens.shift() ?? null);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(401, { error: "unauthorized" }))
      .mockResolvedValueOnce(json(200, { evidenceId: "ev2", duplicate: true, extractionStatus: "awaiting_doc_type" }));
    const result = await uploadEvidence({ file: file(PNG), docType: "other", getToken, siteUrl: SITE, fetchImpl, online: true });
    expect(result).toMatchObject({ ok: true, evidenceId: "ev2", duplicate: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect((fetchImpl.mock.calls[1][1] as RequestInit).headers).toMatchObject({ Authorization: "Bearer fresh" });
  });

  it("a second 401 is a signed-out result, never a third try", async () => {
    const fetchImpl = vi.fn(async () => json(401, { error: "unauthorized" }));
    const result = await uploadEvidence({ file: file(PNG), docType: "receipt", getToken: () => "tok", siteUrl: SITE, fetchImpl, online: true });
    expect(result).toMatchObject({ ok: false, reason: "unauthorized" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.ok === false && result.message).toContain("Nothing was stored");
  });

  it("maps the route's refusals to plain copy", async () => {
    const cases: [Response, string][] = [
      [json(415, { error: "unsupported_type" }), "unsupported_type"],
      [json(413, { error: "too_large" }), "too_large"],
      [json(429, { error: "rate_limited" }), "rate_limited"],
      [json(429, { error: "quota" }), "quota"],
      [json(400, { error: "unknown_doc_type" }), "unknown_doc_type"],
      [json(500, { error: "upload_failed" }), "failed"],
    ];
    for (const [response, reason] of cases) {
      const result = await uploadEvidence({ file: file(PNG), docType: "receipt", getToken: () => "tok", siteUrl: SITE, fetchImpl: vi.fn(async () => response), online: true });
      expect(result, reason).toMatchObject({ ok: false, reason });
    }
  });

  it("a network failure says nothing was stored", async () => {
    const result = await uploadEvidence({
      file: file(PNG), docType: "receipt", getToken: () => "tok", siteUrl: SITE, online: true,
      fetchImpl: vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    });
    expect(result).toMatchObject({ ok: false, reason: "network" });
  });
});

describe("fetchEvidenceFile (DA-A-28b)", () => {
  const base = { evidenceId: "ev1", getToken: () => "tok", siteUrl: SITE, online: true };
  const fileResponse = (bytes: Uint8Array<ArrayBuffer>, type: string, disposition = 'attachment; filename="x"') =>
    new Response(new Blob([bytes]), { status: 200, headers: { "Content-Type": type, "Content-Disposition": disposition } });

  it("previews an image only when the server type and the bytes agree", async () => {
    const result = await fetchEvidenceFile({ ...base, fetchImpl: vi.fn(async () => fileResponse(PNG, "image/png")) });
    expect(result).toMatchObject({ kind: "image", mime: "image/png" });
  });

  it("a PDF is download-only, never previewed", async () => {
    const result = await fetchEvidenceFile({
      ...base,
      fetchImpl: vi.fn(async () => fileResponse(PDF, "application/pdf", "attachment; filename=\"r.pdf\"; filename*=UTF-8''re%C3%A7u.pdf")),
    });
    expect(result).toMatchObject({ kind: "download_only", mime: "application/pdf", fileName: "reçu.pdf" });
  });

  it("a response that claims an image but carries other bytes is never previewed", async () => {
    const result = await fetchEvidenceFile({ ...base, fetchImpl: vi.fn(async () => fileResponse(PDF, "image/png")) });
    expect(result.kind).toBe("download_only");
    expect(result.kind === "download_only" && result.blob.type).toBe("application/octet-stream");
  });

  it("maps not found, rate limit and a lasting 401", async () => {
    expect(await fetchEvidenceFile({ ...base, fetchImpl: vi.fn(async () => json(404, { error: "not_found" })) })).toMatchObject({ kind: "error", reason: "not_found" });
    expect(await fetchEvidenceFile({ ...base, fetchImpl: vi.fn(async () => json(429, { error: "rate_limited" })) })).toMatchObject({ kind: "error", reason: "rate_limited" });
    const unauthorized = vi.fn(async () => json(401, { error: "unauthorized" }));
    expect(await fetchEvidenceFile({ ...base, fetchImpl: unauthorized })).toMatchObject({ kind: "error", reason: "unauthorized" });
    expect(unauthorized).toHaveBeenCalledTimes(2);
  });

  it("offline asks the user to come back online", async () => {
    const fetchImpl = vi.fn();
    expect(await fetchEvidenceFile({ ...base, online: false, fetchImpl })).toMatchObject({ kind: "error", reason: "offline" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
