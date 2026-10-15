import "dotenv/config";
import { runMigrations } from "../src/server/db/migrate";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set. Copy .env.example to .env or export it.");
  process.exit(1);
}

runMigrations(url)
  .then(() => console.log("Migrations applied."))
  .catch((err: unknown) => {
    console.error("Migration failed:", err);
    process.exit(1);
  });
