# Handoff: UI side session → main session

2026-09-20, evening. Side session is finished; nothing of mine is uncommitted or running. Not pushed.

## What this session did

1. **`f0e5cb7` backend for the dashboard.** New `convex/tracking.ts` → `api.tracking.overview`: every owned item with paid price, priced observation history (oldest first, max 90), latest, lowest, drop vs paid, price-adjustment window end, and its open `price_adjustment` claim with balance. Signed-out returns empty; bounded to 60 purchases (`capped`); example money excluded from totals (D27). 3 tests. `convex/examples.ts` now seeds an 11-point, labelled example price history (only affects accounts that load the example after this commit; the loader is idempotent).
2. **`34bf74a` UI redesign, price-first, modelled on Cruip Mosaic** (look only; no Mosaic source copied, it is GPL). 24 files under `src/` + `index.html`.
   - Theme: Inter, gray-100 page, white `rounded-xl shadow-xs` cards, violet `#8470ff` primary, green/red change pills, gray-900 buttons. Token **names** kept (`paper ink line harbor moss rust gold teal`), values remapped in `src/index.css`; shared class strings in `src/lib/ui.ts` (all export names unchanged).
   - Shell: sidebar + sticky header frame (`src/components/Shell.tsx`).
   - New components, hand-rolled SVG, no new deps: `src/components/charts/{PriceChart,Sparkline,WindowMeter,LedgerBar,StatusSteps}.tsx`, `src/components/DeltaBadge.tsx`, plus `components/purchase/*`, `components/claim/*`.
   - Board = dashboard (stat cards, price-history hero chart, money-on-the-table bars, tracked-items table). Purchase = per-item price chart + paid/now/lowest + claim steps + rule card. Claim = evidence chart, window + ledger cards, composer, reply timeline. Settings, SignIn restyled. Return-credit UI removed from Purchase (backend untouched).
3. Verified: typecheck, lint, build clean; 295 tests pass at that commit; all pages checked in the browser at 1440px and 375px, no console errors. Build uploaded to `https://earnest-setter-354.convex.site`.

## For the main session

- You have since committed `96829ce` (watches) and have uncommitted edits in `src/App.tsx` and `src/components/Shell.tsx`; I did not touch them. Add the watchlist nav item in Shell's `NAV` list; reuse `PriceChart` / `Sparkline` / `DeltaBadge` / `WindowMeter` for watch pages (props are in each file's header).
- Re-upload the static site after your UI changes: `npx @convex-dev/static-hosting upload --build`.
- Known cosmetic: one lint warning in `convex/lib/passage.ts:25` (useless escape), one pre-existing in `Money.tsx`.
- The 21st MCP tools were not reachable from this session.
