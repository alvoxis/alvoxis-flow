import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { runMigrations } from "@/server/db/migrate";
import { seedPermissions } from "@/server/db/seed-permissions";
import { testDatabaseUrl } from "./test-db";

/** Rebuilds the disposable test database from migrations before the integration run. */
export default async function setup(): Promise<void> {
  const url = testDatabaseUrl();
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    await pool.query(
      "DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;",
    );
  } finally {
    await pool.end();
  }
  await runMigrations(url);
  const seedPool = new Pool({ connectionString: url, max: 1 });
  try {
    await seedPermissions(drizzle(seedPool));
  } finally {
    await seedPool.end();
  }
}
