import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "@/server/db/schema";
import { type Database } from "@/server/db/client";

export function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url)
    throw new Error("TEST_DATABASE_URL is not set; integration tests need a disposable database.");
  // Safety net: integration setup drops the schema, so refuse anything not clearly a test DB.
  const dbName = new URL(url).pathname.slice(1);
  if (!/test/i.test(dbName)) {
    throw new Error(
      `Refusing to run integration tests against "${dbName}": name must contain "test".`,
    );
  }
  return url;
}

export function openTestDb(): { db: Database; pool: Pool } {
  const pool = new Pool({ connectionString: testDatabaseUrl(), max: 4 });
  return { db: drizzle(pool, { schema, casing: "snake_case" }), pool };
}
