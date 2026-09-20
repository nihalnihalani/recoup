/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import agentmail from "@agentmail/convex/test";
import firecrawl from "@firecrawl/firecrawl-convex/test";
import workpool from "@convex-dev/workpool/test";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

const modules = import.meta.glob("./**/*.*s");

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
  return t;
}

/** Inserts a user row and returns an identity-bound handle (getAuthUserId parses `subject.split("|")[0]`). */
export async function signedIn(t: ReturnType<typeof setup>, name = "Tester") {
  const userId: Id<"users"> = await t.run(async (ctx) => ctx.db.insert("users", { name }));
  return { userId, as: t.withIdentity({ subject: `${userId}|session` }) };
}
