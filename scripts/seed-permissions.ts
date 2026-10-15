import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { seedPermissions } from "../src/server/db/seed-permissions";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

const pool = new Pool({ connectionString: url, max: 1 });
seedPermissions(drizzle(pool))
  .then((n) => console.log(`Permission catalog synced (${n} new keys).`))
  .catch((err: unknown) => {
    console.error("Seeding failed:", err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
