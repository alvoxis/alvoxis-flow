import "server-only";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { getServerEnv } from "@/config/env";
import * as schema from "./schema";

export type Database = NodePgDatabase<typeof schema>;
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
/** Accepts either the root database handle or an open transaction. */
export type DbOrTx = Database | Transaction;

export function createDatabase(connectionString: string): { db: Database; pool: Pool } {
  const pool = new Pool({ connectionString, max: 10 });
  return { db: drizzle(pool, { schema, casing: "snake_case" }), pool };
}

const globalForDb = globalThis as unknown as { __alvoxisDb?: Database };

/** Lazily created singleton (re-used across hot reloads in development). */
export function getDb(): Database {
  globalForDb.__alvoxisDb ??= createDatabase(getServerEnv().DATABASE_URL).db;
  return globalForDb.__alvoxisDb;
}
