import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { parseServerEnv } from "../src/config/env";
import { reencryptTwoFactorData, secretConfigFromEnv } from "../src/server/auth/operator";
import * as schema from "../src/server/db/schema";

/**
 * Key rotation step 2: re-encrypts all 2FA data with the newest BETTER_AUTH_SECRETS entry.
 * Run after deploying with the new key first in BETTER_AUTH_SECRETS. Safe to re-run.
 */
async function main() {
  const env = parseServerEnv(process.env);
  const key = secretConfigFromEnv(env);
  if (typeof key === "string")
    throw new Error("Set BETTER_AUTH_SECRETS (newest key first) before re-encrypting.");
  const pool = new Pool({ connectionString: env.DATABASE_URL, max: 1 });
  try {
    const result = await reencryptTwoFactorData(
      drizzle(pool, { schema, casing: "snake_case" }),
      key,
    );
    console.log(
      `Re-encrypted ${result.updated}, already current ${result.skipped}, unreadable ${result.unreadable.length}.`,
    );
    if (result.unreadable.length > 0) {
      console.error(
        `Unreadable rows (keep the old key; reset these users with auth:reset-2fa): ${result.unreadable.join(", ")}`,
      );
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
