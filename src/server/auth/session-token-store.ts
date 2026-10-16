import { createHash } from "node:crypto";
import type { BetterAuthOptions, DBAdapter, Where } from "better-auth/types";

/**
 * Session tokens are stored as SHA-256 digests, so a copy of the database (backup, replica, a
 * read-only leak) contains no usable session. The browser keeps the random token in its signed
 * cookie; only its digest is written to `auth_sessions.token`.
 *
 * Better Auth 1.7 has no option for this, so the database adapter is wrapped: every read and
 * write of the `session` model's `token` field goes through the digest, and records handed back
 * to the library carry the caller's token again. The tokens are 32 random characters, so a fast
 * hash is sufficient (no salt or key needed, and no dependency on BETTER_AUTH_SECRET rotation).
 *
 * Compatibility: rows written before hashing (by an older release, or before migration 0008)
 * still match and are re-written as digests the first time they are used.
 */
export const SESSION_TOKEN_PREFIX = "sha256:";

export function hashSessionToken(token: string): string {
  if (token.startsWith(SESSION_TOKEN_PREFIX)) return token;
  return SESSION_TOKEN_PREFIX + createHash("sha256").update(token, "utf8").digest("base64url");
}

/**
 * Database values a presented token may match. A value that already looks like a digest never
 * matches: a digest copied from the database is not a usable token.
 */
export function storedTokenCandidates(token: string): string[] {
  if (token.startsWith(SESSION_TOKEN_PREFIX)) return [];
  return [hashSessionToken(token), token];
}

// Base64url never contains "!", so this can never equal a stored digest.
const NO_MATCH = `${SESSION_TOKEN_PREFIX}!`;
const SESSION_MODELS = new Set(["session", "auth_sessions"]);

type Mode = "lookup" | "write";

/** Rewrites `token` conditions; returns the new where list and stored-value → caller-token map. */
function mapWhere(where: Where[] | undefined, mode: Mode) {
  const original = new Map<string, string>();
  if (!where) return { where, original };
  const mapped = where.map((clause) => {
    if (clause.field !== "token") return clause;
    const values = Array.isArray(clause.value) ? clause.value : [clause.value];
    const stored = values.flatMap((value) => {
      if (typeof value !== "string") return [];
      // Writes may receive digests the library read back from a list (e.g. "revoke all").
      const candidates =
        mode === "write" && value.startsWith(SESSION_TOKEN_PREFIX)
          ? [value]
          : storedTokenCandidates(value);
      for (const c of candidates) original.set(c, value);
      return candidates;
    });
    const operator = clause.operator ?? "eq";
    if (operator === "eq" || operator === "in")
      return { ...clause, operator: "in" as const, value: stored.length ? stored : [NO_MATCH] };
    if (operator === "ne" || operator === "not_in")
      return { ...clause, operator: "not_in" as const, value: stored.length ? stored : [NO_MATCH] };
    throw new Error(`Unsupported operator "${operator}" on session token`);
  });
  return { where: mapped, original };
}

function restoreToken<T>(record: T, original: Map<string, string>): T {
  if (!record || typeof record !== "object") return record;
  const token = (record as { token?: unknown }).token;
  if (typeof token !== "string") return record;
  const callerToken = original.get(token);
  return callerToken ? { ...record, token: callerToken } : record;
}

function hashUpdate(update: Record<string, unknown>) {
  return typeof update.token === "string"
    ? { ...update, token: hashSessionToken(update.token) }
    : update;
}

function wrap<A extends Omit<DBAdapter, "transaction"> & Partial<Pick<DBAdapter, "transaction">>>(
  inner: A,
): A {
  const isSession = (model: string) => SESSION_MODELS.has(model);
  const wrapped: A = {
    ...inner,
    create: async (args) => {
      const token = (args.data as { token?: unknown }).token;
      if (!isSession(args.model) || typeof token !== "string") return inner.create(args);
      const created = await inner.create({
        ...args,
        data: { ...args.data, token: hashSessionToken(token) },
      });
      return restoreToken(created, new Map([[hashSessionToken(token), token]]));
    },
    findOne: async (args) => {
      if (!isSession(args.model)) return inner.findOne(args);
      const { where, original } = mapWhere(args.where, "lookup");
      const found = await inner.findOne({ ...args, where: where! });
      const stored = (found as { token?: unknown } | null)?.token;
      if (typeof stored === "string" && !stored.startsWith(SESSION_TOKEN_PREFIX)) {
        // A row from before hashing: replace the plain token with its digest now.
        await inner.update({
          model: args.model,
          where: [{ field: "token", value: stored }],
          update: { token: hashSessionToken(stored) },
        });
      }
      return restoreToken(found, original);
    },
    findMany: async (args) => {
      if (!isSession(args.model)) return inner.findMany(args);
      const { where, original } = mapWhere(args.where, "lookup");
      const rows = await inner.findMany({
        ...args,
        where,
        // Each token may now match up to two candidate values.
        ...(args.limit !== undefined && original.size ? { limit: args.limit * 2 } : {}),
      });
      return rows.map((row) => restoreToken(row, original));
    },
    count: async (args) =>
      isSession(args.model)
        ? inner.count({ ...args, where: mapWhere(args.where, "lookup").where })
        : inner.count(args),
    update: async (args) => {
      if (!isSession(args.model)) return inner.update(args);
      const { where, original } = mapWhere(args.where, "write");
      return restoreToken(
        await inner.update({ ...args, where: where!, update: hashUpdate(args.update) }),
        original,
      );
    },
    updateMany: async (args) =>
      isSession(args.model)
        ? inner.updateMany({
            ...args,
            where: mapWhere(args.where, "write").where!,
            update: hashUpdate(args.update),
          })
        : inner.updateMany(args),
    delete: async (args) =>
      isSession(args.model)
        ? inner.delete({ ...args, where: mapWhere(args.where, "write").where! })
        : inner.delete(args),
    deleteMany: async (args) =>
      isSession(args.model)
        ? inner.deleteMany({ ...args, where: mapWhere(args.where, "write").where! })
        : inner.deleteMany(args),
    consumeOne: async (args) => {
      if (!isSession(args.model)) return inner.consumeOne(args);
      const { where, original } = mapWhere(args.where, "write");
      return restoreToken(await inner.consumeOne({ ...args, where: where! }), original);
    },
  };
  if (inner.transaction) {
    const transaction = inner.transaction;
    (wrapped as DBAdapter).transaction = (callback) => transaction((trx) => callback(wrap(trx)));
  }
  return wrapped;
}

/** Wraps a Better Auth adapter factory (e.g. `drizzleAdapter(...)`) so session tokens are hashed. */
export function withHashedSessionTokens(
  factory: (options: BetterAuthOptions) => DBAdapter<BetterAuthOptions>,
): (options: BetterAuthOptions) => DBAdapter<BetterAuthOptions> {
  return (options) => wrap(factory(options));
}
