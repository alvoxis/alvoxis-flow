import "dotenv/config";
import { createDatabase } from "../src/server/db/client";
import { seedSyntheticData } from "../src/server/test-data/synthetic-data";
import { checkTestDataTarget } from "../src/server/test-data/target-guard";

/**
 * Writes the FICTITIOUS test companies and documents (src/server/test-data/synthetic-data.ts) for
 * an existing test user. Only for a test database: see target-guard.ts for the checks made before
 * any connection. Prints a summary without connection details.
 *
 *   TEST_DATA_CONFIRM=synthetic-test-data TEST_DATA_DB_HOST=<test db host> \
 *   TEST_DATA_OWNER_EMAIL=tester1@example.test DATABASE_URL=… pnpm db:test-data
 */
const target = checkTestDataTarget(process.env);
if (!target.ok) {
  console.error(`Test data: ${target.error}`);
  process.exit(1);
}

const { db, pool } = createDatabase(process.env.DATABASE_URL!);
seedSyntheticData(db, process.env.TEST_DATA_OWNER_EMAIL ?? "")
  .then((summary) => {
    console.log(`Test data for ${summary.owner}:`);
    for (const c of summary.companies)
      console.log(
        c.created
          ? `  created "${c.name}" with ${c.documents} documents`
          : `  "${c.name}" already exists, left unchanged`,
      );
  })
  .catch((err: unknown) => {
    // Error class and message only: service errors carry codes, never connection details.
    console.error("Test data failed:", err instanceof Error ? `${err.name}: ${err.message}` : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
