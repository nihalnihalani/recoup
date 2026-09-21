/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import agentmail from "@agentmail/convex/test";
import firecrawl from "@firecrawl/firecrawl-convex/test";
import workpool from "@convex-dev/workpool/test"; // for .schema only
import rl from "@convex-dev/rate-limiter/test";
import bw from "@convex-dev/batch-worker/test"; // for .schema only
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

const modules = import.meta.glob("./**/*.*s");

// D51: several mounted components' own `/test` re-export resolves to an
// empty module map when loaded from here, so any dispatch into them fails
// with "Could not find module". `@agentmail/convex/test`'s glob is
// `"./component/**/!(*.*.*)*.ts"` (meant to skip the `_generated/*.d.ts`
// stubs) but that extglob negation is not honored by Vite's `import.meta.glob`
// matcher, so it silently matches nothing at all — not even `lib.ts` — which
// is why `sendMessage`/`onEvent` dispatch previously failed here (documented
// at drafts.test.ts:402-437) even though the file-level comment blamed a
// dist-vs-src split. `@convex-dev/rate-limiter`'s package `exports` block
// only exposes deep `src/…` paths through `/test`, and its nested
// `@convex-dev/batch-worker` component is not auto-registered by convex-test
// at all. The fix for all of them is the same: glob each component's `src/`
// tree directly out of node_modules with a plain `**/*.ts` pattern.
// `{ exhaustive: true }` is required for `import.meta.glob` to walk into
// node_modules at all when the glob call itself lives outside the package
// (unlike `workpool.modules`/`rl.modules`, whose own glob is evaluated from
// inside the package and needs no such flag — `@convex-dev/workpool`'s plain
// `**/*.ts` glob is not affected by the extglob bug and works as shipped, but
// it is nested twice under "agentmail" here, so it is re-globbed the same way
// for consistency and to rule out any evaluation-site difference). Every
// component ships `_generated/*.ts` alongside its real modules so
// convex-test's root-prefix inference has something to anchor on.
const agentmailModules = import.meta.glob("../node_modules/@agentmail/convex/src/component/**/*.ts", { exhaustive: true });
const workpoolModules = import.meta.glob("../node_modules/@convex-dev/workpool/src/component/**/*.ts", { exhaustive: true });
const rlModules = import.meta.glob("../node_modules/@convex-dev/rate-limiter/src/component/**/*.ts", { exhaustive: true });
const bwModules = import.meta.glob("../node_modules/@convex-dev/batch-worker/src/component/**/*.ts", { exhaustive: true });

export function setup() {
  process.env.FIRECRAWL_API_KEY = "fc-test";
  process.env.AGENTMAIL_API_KEY = "am-test";
  process.env.AGENTMAIL_WEBHOOK_SECRET = "whsec_test";
  const t = convexTest(schema, modules);
  t.registerComponent("agentmail", agentmail.schema, agentmailModules);
  t.registerComponent("agentmail/sendPool", workpool.schema, workpoolModules);
  t.registerComponent("agentmail/callbackPool", workpool.schema, workpoolModules);
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
