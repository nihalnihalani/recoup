import { describe, expect, it } from "vitest";
import {
  assembleExport,
  EXPORT_CLOSE,
  EXPORT_TABLES,
  exportDocumentParts,
  exportFilename,
  exportPreamble,
  exportTableChunk,
  fetchAllRows,
  type ExportPage,
} from "./accountExport";

describe("EXPORT_TABLES", () => {
  it("mirrors convex/account.ts's EXPORT_TABLES union exactly (19 tables, no duplicates)", () => {
    expect(EXPORT_TABLES).toEqual([
      "purchases",
      "items",
      "claims",
      "ledgerEvents",
      "claimNotes",
      "drafts",
      "replies",
      "followUps",
      "policies",
      "priceChecks",
      "watches",
      "watchChecks",
      "offers",
      "offerChecks",
      "marketPrices",
      "mailLog",
      "processedEvents",
      "alertSettings",
      "profiles",
    ]);
    expect(new Set(EXPORT_TABLES).size).toBe(EXPORT_TABLES.length);
  });
});

describe("exportFilename", () => {
  it("formats as recoup-export-YYYY-MM-DD.json in UTC", () => {
    expect(exportFilename(new Date("2026-09-21T23:59:00Z"))).toBe("recoup-export-2026-09-21.json");
    expect(exportFilename(new Date("2026-01-05T00:00:00Z"))).toBe("recoup-export-2026-01-05.json");
  });

  it("pads single-digit months and days", () => {
    expect(exportFilename(new Date(Date.UTC(2026, 2, 4)))).toBe("recoup-export-2026-03-04.json");
  });
});

describe("fetchAllRows", () => {
  it("stops at the first null cursor and returns all rows in order", async () => {
    const pages: ExportPage[] = [
      { rows: [1, 2], cursor: "c1" },
      { rows: [3, 4], cursor: "c2" },
      { rows: [5], cursor: null },
    ];
    let calls = 0;
    const fetchPage = async (cursor: string | undefined) => {
      expect(cursor).toBe(calls === 0 ? undefined : pages[calls - 1].cursor ?? undefined);
      return pages[calls++];
    };
    const rows = await fetchAllRows(fetchPage);
    expect(rows).toEqual([1, 2, 3, 4, 5]);
    expect(calls).toBe(3);
  });

  it("returns an empty array for a table with no rows (single empty page, null cursor)", async () => {
    const rows = await fetchAllRows(async () => ({ rows: [], cursor: null }));
    expect(rows).toEqual([]);
  });

  it("reports progress after every page", async () => {
    const pages: ExportPage[] = [
      { rows: [1, 2], cursor: "c1" },
      { rows: [3], cursor: null },
    ];
    let i = 0;
    const progress: number[] = [];
    const rows = await fetchAllRows(
      async () => pages[i++],
      (rowsSoFar) => progress.push(rowsSoFar),
    );
    expect(rows).toEqual([1, 2, 3]);
    expect(progress).toEqual([2, 3]);
  });

  it("throws rather than looping forever if the server never returns a null cursor", async () => {
    await expect(fetchAllRows(async () => ({ rows: [], cursor: "same" }))).rejects.toThrow(
      /never returned a null cursor/,
    );
  });
});

describe("exportDocumentParts / assembleExport", () => {
  it("joining the parts produces exactly JSON.stringify of the assembled document", () => {
    const tables: Array<[(typeof EXPORT_TABLES)[number], unknown[]]> = [
      ["purchases", [{ _id: "p1", merchant: "Acme" }]],
      ["items", []],
      ["claims", [{ _id: "c1" }, { _id: "c2" }]],
    ];
    const exportedAt = 1_726_000_000_000;
    const joined = exportDocumentParts(exportedAt, tables).join("");
    expect(JSON.parse(joined)).toEqual(assembleExport(exportedAt, tables));
    expect(joined).toBe(JSON.stringify(assembleExport(exportedAt, tables)));
  });

  it("handles zero tables", () => {
    const joined = exportDocumentParts(42, []).join("");
    expect(JSON.parse(joined)).toEqual({ exportedAt: 42, tables: {} });
  });

  it("never drops another user's data in - it only ever serializes what it was handed", () => {
    const tables: Array<[(typeof EXPORT_TABLES)[number], unknown[]]> = [["watches", [{ _id: "w1", userId: "userA" }]]];
    const doc = assembleExport(1, tables);
    expect(doc.tables.watches).toEqual([{ _id: "w1", userId: "userA" }]);
    expect(Object.keys(doc.tables)).toEqual(["watches"]);
  });
});

describe("streaming assembly (exportPreamble / exportTableChunk / EXPORT_CLOSE)", () => {
  it("built one table at a time, matches the non-streaming assembly exactly", () => {
    const exportedAt = 1_700_000_000_000;
    const built = [
      exportPreamble(exportedAt),
      exportTableChunk("purchases", [{ _id: "p1" }], true),
      exportTableChunk("items", [], false),
      exportTableChunk("claims", [{ _id: "c1" }, { _id: "c2" }], false),
      EXPORT_CLOSE,
    ].join("");

    const nonStreaming = exportDocumentParts(exportedAt, [
      ["purchases", [{ _id: "p1" }]],
      ["items", []],
      ["claims", [{ _id: "c1" }, { _id: "c2" }]],
    ]).join("");

    expect(built).toBe(nonStreaming);
    expect(JSON.parse(built)).toEqual({
      exportedAt,
      tables: { purchases: [{ _id: "p1" }], items: [], claims: [{ _id: "c1" }, { _id: "c2" }] },
    });
  });

  it("a single table (first and only) needs no leading comma", () => {
    const joined = [exportPreamble(1), exportTableChunk("profiles", [{ _id: "u1" }], true), EXPORT_CLOSE].join("");
    expect(JSON.parse(joined)).toEqual({ exportedAt: 1, tables: { profiles: [{ _id: "u1" }] } });
  });
});
