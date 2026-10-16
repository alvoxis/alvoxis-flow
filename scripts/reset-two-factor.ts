import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { operatorResetTwoFactor } from "../src/server/auth/operator";
import * as schema from "../src/server/db/schema";

/**
 * Usage: pnpm auth:reset-2fa <email> "<reason / ticket reference>"
 * Verify the person's identity out of band BEFORE running this. See docs/auth/AUTHENTICATION.md.
 */
const [email, reason] = process.argv.slice(2);
const url = process.env.DATABASE_URL;
if (!url || !email || !reason) {
  console.error('Usage: DATABASE_URL=... pnpm auth:reset-2fa <email> "<reason>"');
  process.exit(1);
}

const pool = new Pool({ connectionString: url, max: 1 });
operatorResetTwoFactor(drizzle(pool, { schema, casing: "snake_case" }), email, reason)
  .then((result) => {
    if (!result) {
      console.error("No user with that email address.");
      process.exitCode = 1;
      return;
    }
    console.log(
      `Two-factor authentication reset for user ${result.userId}; ${result.revokedSessions} session(s) revoked.`,
    );
  })
  .catch((err: unknown) => {
    console.error("Reset failed:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
