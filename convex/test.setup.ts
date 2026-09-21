/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import agentmail from "@agentmail/convex/test";
import firecrawl from "@firecrawl/firecrawl-convex/test";
import workpool from "@convex-dev/workpool/test";
import rl from "@convex-dev/rate-limiter/test";
import bw from "@convex-dev/batch-worker/test"; // for .schema only
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

const modules = import.meta.glob("./**/*.*s");

// @convex-dev/rate-limiter's own package `exports` block only exposes deep
// `src/…` paths through `/test`, and its nested `@convex-dev/batch-worker`
// component is not auto-registered by convex-test. Glob both components'
// source directly out of node_modules (D51); `{ exhaustive: true }` is
// required for `import.meta.glob` to walk into node_modules at all when the
// glob call itself lives outside the package (unlike `rl.modules`, whose own
// glob is evaluated from inside the package and needs no such flag). Both
// components ship `_generated/*.ts` alongside their real modules so
// convex-test's root-prefix inference has something to anchor on.
const rlModules = import.meta.glob("../node_modules/@convex-dev/rate-limiter/src/component/**/*.ts", { exhaustive: true });
const bwModules = import.meta.glob("../node_modules/@convex-dev/batch-worker/src/component/**/*.ts", { exhaustive: true });

export function setup() {
  process.env.FIRECRAWL_API_KEY = "fc-test";
  process.env.AGENTMAIL_API_KEY = "am-test";
  process.env.AGENTMAIL_WEBHOOK_SECRET = "whsec_test";
  const t = convexTest(schema, modules);
  // @agentmail/convex@0.1.0 ships `src/component/_generated/*` as compiled
  // .js/.d.ts only (no .ts source), so `agentmail.modules` (a
  // `import.meta.glob("./component/**/*.ts")`) never matches a path
  // containing "_generated" and convex-test's `findModulesRoot` throws.
  // Add one inert stub module under that path so the root-prefix inference
  // succeeds; nothing in the component ever dispatches to "_generated/*" at
  // runtime (those files are type-only re-exports), so this is never loaded.
  t.registerComponent("agentmail", agentmail.schema, {
    ...agentmail.modules,
    "./component/_generated/root.js": async () => ({}),
  });
  workpool.register(t, "agentmail/sendPool");
  workpool.register(t, "agentmail/callbackPool");
  firecrawl.register(t);
  t.registerComponent("rateLimiter", rl.schema, rlModules);
  t.registerComponent("rateLimiter/batchWorker", bw.schema, bwModules);
  return t;
}

/** Inserts a user row and returns an identity-bound handle (getAuthUserId parses `subject.split("|")[0]`). */
export async function signedIn(t: ReturnType<typeof setup>, name = "Tester") {
  const userId: Id<"users"> = await t.run(async (ctx) => ctx.db.insert("users", { name }));
  return { userId, as: t.withIdentity({ subject: `${userId}|session` }) };
}
