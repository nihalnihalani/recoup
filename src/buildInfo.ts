/**
 * P12-W6: which frontend build is running. Vite's `define` replaces `__RECOUP_BUILD__` with the git revision it
 * built from (`vite.config.ts`; a `-dirty` suffix when the tree had uncommitted changes, `RECOUP_BUILD_ID` overrides).
 * The same id is in `<meta name="recoup-build">` and `dist/build-info.json`, so a page, a deploy and the dist summary
 * can be matched. Tests and anything not built by Vite read "dev".
 */
declare const __RECOUP_BUILD__: string | undefined;

export const BUILD_ID: string = typeof __RECOUP_BUILD__ === "string" && __RECOUP_BUILD__.length > 0 ? __RECOUP_BUILD__ : "dev";
