/**
 * F4 (checkpoint 4, D94): one-shot, resumable backfill for auth rows that
 * predate D67's normalize-on-write (trim + lowercase every email before it
 * ever reaches the database).
 *
 * F1's fix gave `authMail`'s `Email({...})` config a real binding check
 * (`account.providerAccountId === params.email`), and `guardedAuthorize`
 * always normalizes `params.email` before that comparison runs (D67). A
 * legacy row created before D67 shipped — say `providerAccountId:
 * "Legacy@Example.com"` — can never match again: every future lookup uses
 * the normalized `"legacy@example.com"`, which the indexed
 * `providerAndAccountId` lookup will never find, so the account is
 * permanently unreachable (`InvalidAccountId` on every flow) even though the
 * row, and its password hash, are perfectly intact. This migration repairs
 * that by lowercasing/trimming `authAccounts.providerAccountId` (only for
 * `provider: "password"`; that is the only provider config this app
 * registers) and, for the linked user, `users.email`, wherever the stored
 * value differs from `normalizeEmail(value)`.
 *
 * Bounded to `PAGE_SIZE` `authAccounts` rows per transaction (Convex's
 * per-mutation document-read/write limits), resumable across invocations via
 * a single `opsState` row keyed `"authMigrate"` (same pattern as
 * `market.ts`'s `migrateStamps`, D75-style), and idempotent: normalizing an
 * already-normalized row is a no-op (the `!== normalizeEmail(x)` guard), and
 * once fully caught up a bare re-run reads the stored end-of-table cursor
 * and does nothing (`done: true`, `scanned: 0`).
 *
 * Never merges two accounts that normalize to the same address — that would
 * silently pick a winner for two humans who signed up under distinct
 * casings/whitespace of the same mailbox before D67 and now collide. A
 * collision is refused and recorded (counted in the return value and logged
 * with both document ids) so an operator can resolve it by hand; the row is
 * left exactly as it was.
 */
import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { internal } from "../_generated/api";
import { normalizeEmail } from "./email";

/** `opsState.key` for this migration's resumable cursor. */
export const AUTH_MIGRATE_OPS_KEY = "authMigrate";

/** `authAccounts` rows scanned per transaction — well under Convex's per-mutation document limits. */
const PAGE_SIZE = 200;

/** The only provider this app registers rows under (`convex/auth.ts`); other provider ids are left untouched. */
const PASSWORD_PROVIDER_ID = "password";

/** `normalizeEmail` throws `ConvexError` on a value that doesn't even look like an email; never let one bad legacy row abort the whole page. */
function tryNormalizeEmail(raw: string): string | null {
  try {
    return normalizeEmail(raw);
  } catch {
    return null;
  }
}

export const normalizeLegacyAccounts = internalMutation({
  args: { cursor: v.optional(v.string()) },
  returns: v.object({
    done: v.boolean(),
    scanned: v.number(),
    accountsNormalized: v.number(),
    usersNormalized: v.number(),
    collisions: v.number(),
    unnormalizable: v.number(),
  }),
  handler: async (ctx, args) => {
    const opsRow = await ctx.db
      .query("opsState")
      .withIndex("by_key", (q) => q.eq("key", AUTH_MIGRATE_OPS_KEY))
      .unique();
    const cursor = args.cursor ?? opsRow?.cursor ?? null;

    const page = await ctx.db.query("authAccounts").paginate({ cursor, numItems: PAGE_SIZE });

    let accountsNormalized = 0;
    let usersNormalized = 0;
    let collisions = 0;
    let unnormalizable = 0;

    for (const account of page.page) {
      if (account.provider !== PASSWORD_PROVIDER_ID) continue;

      const normalizedAccountId = tryNormalizeEmail(account.providerAccountId);
      if (normalizedAccountId === null) {
        unnormalizable++;
      } else if (normalizedAccountId !== account.providerAccountId) {
        const collidingAccount = await ctx.db
          .query("authAccounts")
          .withIndex("providerAndAccountId", (q) =>
            q.eq("provider", PASSWORD_PROVIDER_ID).eq("providerAccountId", normalizedAccountId),
          )
          .unique();
        if (collidingAccount !== null && collidingAccount._id !== account._id) {
          collisions++;
          console.error(
            `authMigrate: refusing to merge authAccounts ${account._id} into ${collidingAccount._id} ` +
              `(both normalize to the same providerAccountId)`,
          );
        } else {
          await ctx.db.patch(account._id, { providerAccountId: normalizedAccountId });
          accountsNormalized++;
        }
      }

      const user = await ctx.db.get(account.userId);
      if (user === null || user.email === undefined) continue;
      const normalizedUserEmail = tryNormalizeEmail(user.email);
      if (normalizedUserEmail === null || normalizedUserEmail === user.email) continue;

      const collidingUser = await ctx.db
        .query("users")
        .withIndex("email", (q) => q.eq("email", normalizedUserEmail))
        .unique();
      if (collidingUser !== null && collidingUser._id !== user._id) {
        collisions++;
        console.error(
          `authMigrate: refusing to merge users ${user._id} into ${collidingUser._id} ` +
            `(both normalize to the same email)`,
        );
      } else {
        await ctx.db.patch(user._id, { email: normalizedUserEmail });
        usersNormalized++;
      }
    }

    const now = Date.now();
    if (opsRow) {
      await ctx.db.patch(opsRow._id, { cursor: page.continueCursor, updatedAt: now });
    } else {
      await ctx.db.insert("opsState", { key: AUTH_MIGRATE_OPS_KEY, cursor: page.continueCursor, updatedAt: now });
    }

    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.lib.authMigrate.normalizeLegacyAccounts, {});
    }

    return { done: page.isDone, scanned: page.page.length, accountsNormalized, usersNormalized, collisions, unnormalizable };
  },
});
