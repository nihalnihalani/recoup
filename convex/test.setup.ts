/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import agentmail from "@agentmail/convex/test";
import firecrawl from "@firecrawl/firecrawl-convex/test";
import workpool from "@convex-dev/workpool/test";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

const modules = import.meta.glob("./**/*.*s");

// `@agentmail/convex/test` and `@convex-dev/workpool/test` each build their
// component's module map with their own `import.meta.glob("./component/**/*.ts")`,
// evaluated from a file that lives under `node_modules/...`. Vite's glob
// importer ignores `**/node_modules/**` by default (it only crawls it when a
// glob passes `{ exhaustive: true }`), so those packages' own `.modules`
// objects are always empty `{}` for a consumer that installed them as a
// dependency (confirmed by printing `Object.keys(agentmail.modules)` here:
// `[]`). `registerComponent` then has no real component sources at all, so
// convex-test's `findModulesRoot` can't find a "_generated" path (it throws
// unless one is supplied) and any dispatch into the component fails with
// `Could not find module for: "<path>"` for every function, not just a
// mis-cased "_generated" stub.
//
// Fix: glob the same directories ourselves, from here, with
// `{ exhaustive: true }` so `**/node_modules/**` is actually crawled, and
// register the components with those real module maps instead of the
// packages' own (broken) `.modules` / `register()` helpers. This also
// happens to pick up each package's real `_generated/*` sources (agentmail
// ships those as compiled `.d.ts`/`.js` only, so its `_generated` entries are
// inert type-only stand-ins that are never actually dispatched to; workpool
// ships real `.ts` sources there, so its component gets fully working
// `_generated` support too).
const agentmailComponentModules = import.meta.glob("../node_modules/@agentmail/convex/src/component/**/*.ts", {
  exhaustive: true,
});
const workpoolComponentModules = import.meta.glob("../node_modules/@convex-dev/workpool/src/component/**/*.ts", {
  exhaustive: true,
});

export function setup() {
  process.env.FIRECRAWL_API_KEY = "fc-test";
  process.env.AGENTMAIL_API_KEY = "am-test";
  process.env.AGENTMAIL_WEBHOOK_SECRET = "whsec_test";
  const t = convexTest(schema, modules);
  t.registerComponent("agentmail", agentmail.schema, agentmailComponentModules);
  t.registerComponent("agentmail/sendPool", workpool.schema, workpoolComponentModules);
  t.registerComponent("agentmail/callbackPool", workpool.schema, workpoolComponentModules);
  firecrawl.register(t);
  return t;
}

/** Inserts a user row and returns an identity-bound handle (getAuthUserId parses `subject.split("|")[0]`). */
export async function signedIn(t: ReturnType<typeof setup>, name = "Tester") {
  const userId: Id<"users"> = await t.run(async (ctx) => ctx.db.insert("users", { name }));
  return { userId, as: t.withIdentity({ subject: `${userId}|session` }) };
}
