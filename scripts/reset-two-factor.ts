import "dotenv/config";
import { userInfo } from "node:os";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { parseServerEnv } from "../src/config/env";
import { operatorResetTwoFactor } from "../src/server/auth/operator";
import * as schema from "../src/server/db/schema";
import { createMailer } from "../src/server/notifications/mailer";

/**
 * Break-glass 2FA reset. Needs the production environment (DATABASE_URL, BETTER_AUTH_SECRET,
 * mail settings) — i.e. it can only be run by someone who already holds production credentials.
 * Verify the person's identity out of band BEFORE running it. See docs/auth/AUTHENTICATION.md.
 *
 *   pnpm auth:reset-2fa --email user@example.com --operator "Jane Doe" \
 *     --reason "TICKET-123, identity verified by call-back to registered number"
 */
const USAGE =
  'Usage: pnpm auth:reset-2fa --email <email> --operator "<your name>" --reason "<ticket + how identity was verified>" [--yes]';

async function main() {
  const { values } = parseArgs({
    options: {
      email: { type: "string" },
      operator: { type: "string" },
      reason: { type: "string" },
      yes: { type: "boolean", default: false },
    },
  });
  if (!values.email || !values.operator || !values.reason) throw new Error(USAGE);

  const env = parseServerEnv(process.env);
  const mailer = createMailer(env);
  if (!mailer.configured)
    console.warn("WARNING: email is not configured; the account owner will NOT be notified.");

  if (!values.yes) {
    if (!process.stdin.isTTY) throw new Error("Not interactive: re-run with --yes to confirm.");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const typed = await rl.question(
      `This removes two-factor authentication for ${values.email} and signs them out everywhere.\nType the email address again to confirm: `,
    );
    rl.close();
    if (typed.trim().toLowerCase() !== values.email.trim().toLowerCase())
      throw new Error("Confirmation did not match; nothing was changed.");
  }

  const pool = new Pool({ connectionString: env.DATABASE_URL, max: 1 });
  try {
    const result = await operatorResetTwoFactor(
      drizzle(pool, { schema, casing: "snake_case" }),
      mailer,
      {
        email: values.email,
        reason: values.reason,
        operator: `${values.operator} (os user: ${userInfo().username})`,
      },
      env.APP_URL,
    );
    if (!result) throw new Error("No user with that email address; nothing was changed.");
    console.log(
      `Two-factor authentication reset for user ${result.userId}; ${result.revokedSessions} session(s) revoked; owner notified: ${result.notified ? "yes" : "NO"}.`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
