import { Pool } from "pg";

/**
 * SQL fixtures for e2e tests, ONLY against the isolated e2e database: E2E_DATABASE_URL must be
 * set, point to a local host and name a database ending in `_e2e` (CI and the local setup use
 * `alvoxis_flow_e2e`). Anything else is refused, so a fixture can never touch a dev, shared or
 * production database. Tests that need it skip when E2E_DATABASE_URL is not set.
 */
export const E2E_SQL_AVAILABLE = Boolean(process.env.E2E_DATABASE_URL);

export function e2eDatabase(): Pool {
  const raw = process.env.E2E_DATABASE_URL;
  if (!raw) throw new Error("E2E_DATABASE_URL is required for SQL fixtures");
  const url = new URL(raw);
  const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
  if (!local || !url.pathname.slice(1).endsWith("_e2e"))
    throw new Error("Refusing SQL fixtures outside a local *_e2e database");
  return new Pool({ connectionString: raw, max: 1 });
}
