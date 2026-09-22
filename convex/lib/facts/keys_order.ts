/**
 * M21 (wave 2): online-order (R05) keys, incl. `retail.order_total` (tax + shipping; contract §3.4 paid-total cap). An empty stub in wave 1 so `lib/facts/catalog.ts` already merges this file; the owner appends
 * specs here (`as const satisfies readonly FactSpec[]`) and they join `FactKey` automatically. Keys are never renamed.
 */
import type { FactSpec } from "./catalog";

export const ORDER_FACT_SPECS = [] as const satisfies readonly FactSpec[];
