import type { FunctionArgs } from "convex/server";
import type { api } from "../../convex/_generated/api";

/**
 * Pure helpers behind Settings' "Export my data" button (T19, P09).
 *
 * The button itself drives `api.account.exportPage` imperatively via
 * `useConvex().query(...)` inside a click handler (T18's contract: one
 * table, one page, a cursor, repeat until `cursor` is `null` — not a React
 * hook called in a loop). Everything here is the pure, testable part of
 * that flow: the exact table list to walk (`EXPORT_TABLES` below, checked
 * against the server at compile time and in the test), the paging loop shape
 * (parameterized over an injectable `fetchPage` so it needs no real Convex
 * client to test), and the JSON assembly that keeps the download bounded —
 * built as string parts, one table at a time, instead of holding the whole
 * export as a second in-memory object and calling `JSON.stringify` on it.
 */

/**
 * Every table `api.account.exportPage` can serve, in the server's order:
 * a copy of `convex/account.ts`'s `EXPORT_TABLE_NAMES`. The list stays here
 * rather than being imported because `account.ts` is server code (its
 * imports reach `_generated/server` and the rate limiter), which must not be
 * bundled into the browser. It cannot drift silently:
 *  - compile time: `SameTables` below fails `npm run typecheck` unless this
 *    list and `exportPage`'s `table` argument are the same set;
 *  - run time: `accountExport.test.ts` imports `EXPORT_TABLE_NAMES` and
 *    compares the two arrays, order included.
 * M15 (D163): the seven wave-1 recovery tables M14 made exportable.
 */
export const EXPORT_TABLES = [
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
  "transactions",
  "facts",
  "incidents",
  "evidence",
  "opportunities",
  "evaluations",
  "nonCashRemedies",
] as const;

export type ExportTable = (typeof EXPORT_TABLES)[number];

/** The `table` argument `exportPage` accepts, straight from the generated API types. */
type ServerExportTable = FunctionArgs<typeof api.account.exportPage>["table"];
/** `true` only when both unions hold exactly the same members. */
type SameTables = [ServerExportTable] extends [ExportTable] ? ([ExportTable] extends [ServerExportTable] ? true : false) : false;
type AssertTrue<T extends true> = T;
/** Compile-time only: a table added to (or removed from) `exportPage` without this list makes this line a type error. */
export type ExportTablesMatchServer = AssertTrue<SameTables>;

/** One page of `api.account.exportPage`'s return shape. */
export type ExportPage = { rows: unknown[]; cursor: string | null };

/** The assembled download's shape (T18/T19 contract, verbatim): `{ exportedAt, tables: {...} }`. */
export type ExportDocument = { exportedAt: number; tables: Record<string, unknown[]> };

/** `recoup-export-<YYYY-MM-DD>.json` (contract, verbatim). UTC so the filename never depends on the browser's timezone. */
export function exportFilename(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `recoup-export-${y}-${m}-${d}.json`;
}

/**
 * Safety valve against a non-terminating cursor. D115 (checkpoint 6b-2,
 * Opus review of T18 at e265bb9): the server's own via-parent pagination
 * (`convex/account.ts`'s `readParentTable`) had a real bug where a parent
 * with more than 200 children never advanced its queue, so `exportPage`
 * could return a `cursor` that never becomes `null` — this client-side cap
 * stays regardless of whether/when that server bug is fixed, because a
 * frontend loop should never trust a server cursor to be well-behaved.
 * 500 pages at 200 rows/page is 100,000 rows, far more than any real
 * account-owned table, so this never fires for a genuine export.
 */
const MAX_PAGES_PER_TABLE = 500;

/**
 * Walks one table's pages via `fetchPage` (typically `(cursor) =>
 * convex.query(api.account.exportPage, { table, cursor })`) until the
 * server reports `cursor: null`, calling `onPage` after each page so a
 * caller can render progress ("purchases: 640 rows…") without waiting for
 * the whole table. Returns every row for that table, concatenated in
 * server order. Throws (rather than looping forever) if the cursor is
 * still non-null after `MAX_PAGES_PER_TABLE` pages, or if any one page
 * fetch itself throws — either way the caller's export aborts entirely
 * rather than silently returning a partial table.
 */
export async function fetchAllRows(
  fetchPage: (cursor: string | undefined) => Promise<ExportPage>,
  onPage?: (rowsSoFar: number) => void,
): Promise<unknown[]> {
  const rows: unknown[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES_PER_TABLE; page++) {
    const result = await fetchPage(cursor);
    rows.push(...result.rows);
    onPage?.(rows.length);
    if (result.cursor === null) return rows;
    cursor = result.cursor;
  }
  throw new Error(
    `Export did not finish paging after ${MAX_PAGES_PER_TABLE} pages — the server never returned a null cursor.`,
  );
}

/**
 * The document's opening fragment, up to (not including) the first table's
 * chunk — everything a streaming caller needs before it has fetched any
 * table.
 */
export function exportPreamble(exportedAt: number): string {
  return `{"exportedAt":${JSON.stringify(exportedAt)},"tables":{`;
}

/**
 * One table's `"name":[...]` fragment, the same way `JSON.stringify` would
 * render it inside the larger `tables` object. `isFirst` controls the
 * leading comma so a streaming caller (`Settings.tsx`'s export handler) can
 * emit one table at a time — fetch a table's rows, turn them into this one
 * string, append it to the growing parts array, and let the row array itself
 * be garbage-collected before fetching the next table — without ever
 * holding every table's rows in memory at once.
 */
export function exportTableChunk(table: ExportTable, rows: unknown[], isFirst: boolean): string {
  return `${isFirst ? "" : ","}${JSON.stringify(table)}:${JSON.stringify(rows)}`;
}

/** The document's closing fragment. */
export const EXPORT_CLOSE = "}}";

/**
 * Builds the export document as an array of string parts that, joined in
 * order, form the exact JSON text `JSON.stringify(assembleExport(exportedAt,
 * tables))` would produce — but computed one table's chunk at a time via
 * `exportTableChunk`. Non-streaming (all `tables` must already be in hand),
 * so it exists for tests and any caller that already has every table's rows
 * rather than fetching them page by page; `Settings.tsx`'s actual export
 * handler streams by calling `exportPreamble`/`exportTableChunk`/
 * `EXPORT_CLOSE` directly as each table's fetch completes, so it never holds
 * more than one table's rows in memory at a time.
 */
export function exportDocumentParts(exportedAt: number, tables: Array<[ExportTable, unknown[]]>): string[] {
  return [
    exportPreamble(exportedAt),
    ...tables.map(([name, rows], i) => exportTableChunk(name, rows, i === 0)),
    EXPORT_CLOSE,
  ];
}

/** Non-streaming equivalent of `exportDocumentParts`, for tests and anywhere the plain object is more useful than the JSON text. */
export function assembleExport(exportedAt: number, tables: Array<[ExportTable, unknown[]]>): ExportDocument {
  return { exportedAt, tables: Object.fromEntries(tables) };
}
