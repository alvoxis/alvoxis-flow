import "dotenv/config";
import { userInfo } from "node:os";
import { parseArgs } from "node:util";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { parseServerEnv } from "../src/config/env";
import { setPlatformAdmin } from "../src/modules/admin/server/admin-service";
import * as schema from "../src/server/db/schema";

/**
 * Grants or revokes access to the SaaS operator area (/admin). The web application can never do
 * this; it needs the deployment's DATABASE_URL, i.e. someone who already holds production
 * credentials. The person must also have two-factor authentication enabled to use the area.
 *
 *   pnpm admin:grant --email ops@example.com --operator "Jane Doe" --reason "TICKET-42"
 *   pnpm admin:grant --email ops@example.com --operator "Jane Doe" --reason "TICKET-43" --revoke
 */
const USAGE =
  'Usage: pnpm admin:grant --email <email> --operator "<your name>" --reason "<ticket>" [--revoke]';

async function main() {
  const { values } = parseArgs({
    options: {
      email: { type: "string" },
      operator: { type: "string" },
      reason: { type: "string" },
      revoke: { type: "boolean", default: false },
    },
  });
  if (!values.email || !values.operator || !values.reason) throw new Error(USAGE);
  const env = parseServerEnv(process.env);
  const pool = new Pool({ connectionString: env.DATABASE_URL, max: 1 });
  try {
    const result = await setPlatformAdmin(drizzle(pool, { schema, casing: "snake_case" }), {
      email: values.email,
      operator: `${values.operator} (os user: ${userInfo().username})`,
      reason: values.reason,
      revoke: values.revoke,
    });
    if (result === "no_user") throw new Error("No user with that email address; nothing changed.");
    console.log(`Platform administrator: ${result}.`);
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
