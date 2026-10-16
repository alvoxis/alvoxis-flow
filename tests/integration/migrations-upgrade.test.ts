import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabaseUrl } from "./test-db";

/**
 * Upgrades a database that is exactly at the schema on `main` before stage 2 (migrations
 * 0000–0004, with data) to the current migrations, and checks that a failed upgrade leaves it
 * untouched. Uses separate throw-away databases next to the test database.
 */
const MIGRATIONS = path.resolve(process.cwd(), "drizzle");
const STAGE_1_LAST_INDEX = 4; // 0004_documents_import_source — the last migration on main
const journal = JSON.parse(readFileSync(path.join(MIGRATIONS, "meta/_journal.json"), "utf8")) as {
  entries: { idx: number; tag: string }[];
};

let admin: Pool;
const created: string[] = [];
const dirs: string[] = [];

function migrationsFolder(filter: (idx: number) => boolean, extra?: { tag: string; sql: string }) {
  const dir = mkdtempSync(path.join(tmpdir(), "alvoxis-migrations-"));
  dirs.push(dir);
  cpSync(MIGRATIONS, dir, { recursive: true });
  const entries = journal.entries.filter((e) => filter(e.idx));
  if (extra) {
    const idx = journal.entries.length;
    entries.push({ ...journal.entries.at(-1)!, idx, tag: extra.tag, when: Date.now() } as never);
    writeFileSync(path.join(dir, `${extra.tag}.sql`), extra.sql);
  }
  writeFileSync(path.join(dir, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
  return dir;
}

async function freshDatabase(suffix: string) {
  const base = new URL(testDatabaseUrl());
  const name = `${base.pathname.slice(1)}_${suffix}`;
  await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${name}"`);
  created.push(name);
  base.pathname = `/${name}`;
  return new Pool({ connectionString: base.toString(), max: 1 });
}

async function seedStage1(pool: Pool) {
  const ids = await pool.query<{ id: string }>(
    `INSERT INTO users (email, display_name, email_verified_at)
     VALUES ('verified@example.test', 'Verified', now() - interval '30 days'),
            ('pending@example.test', 'Pending', NULL)
     RETURNING id`,
  );
  const company = await pool.query<{ id: string }>(
    `INSERT INTO companies (name, country) VALUES ('Upgrade Test SIA', 'LV') RETURNING id`,
  );
  await pool.query(
    `INSERT INTO audit_logs (company_id, actor_user_id, action) VALUES ($1, $2, 'stage1.event')`,
    [company.rows[0]!.id, ids.rows[0]!.id],
  );
}

const count = async (pool: Pool, sql: string) =>
  Number((await pool.query<{ n: string }>(sql)).rows[0]!.n);

beforeAll(() => {
  admin = new Pool({ connectionString: testDatabaseUrl(), max: 1 });
});
afterAll(async () => {
  for (const name of created) await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await admin.end();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("upgrading an existing stage-1 database", () => {
  it("applies the auth migrations without losing or corrupting existing data", async () => {
    const pool = await freshDatabase("upgrade");
    try {
      const db = drizzle(pool);
      await migrate(db, { migrationsFolder: migrationsFolder((i) => i <= STAGE_1_LAST_INDEX) });
      await seedStage1(pool);

      await migrate(db, { migrationsFolder: MIGRATIONS });

      expect(await count(pool, "SELECT count(*) AS n FROM users")).toBe(2);
      expect(await count(pool, "SELECT count(*) AS n FROM companies")).toBe(1);
      expect(await count(pool, "SELECT count(*) AS n FROM audit_logs")).toBe(1);
      const users = await pool.query<{ email: string; email_verified: boolean; at: Date | null }>(
        "SELECT email, email_verified, email_verified_at AS at FROM users ORDER BY email",
      );
      expect(users.rows.map((u) => [u.email, u.email_verified, u.at !== null])).toEqual([
        ["pending@example.test", false, false],
        ["verified@example.test", true, true],
      ]);
      for (const table of [
        "auth_sessions",
        "auth_accounts",
        "auth_verifications",
        "two_factors",
        "auth_rate_limits",
        "two_factor_used_codes",
      ])
        expect(await count(pool, `SELECT count(*) AS n FROM ${table}`)).toBe(0);

      // The two columns stay in sync whichever one a statement changes.
      await pool.query(
        "UPDATE users SET email_verified_at = now() WHERE email = 'pending@example.test'",
      );
      expect(
        (await pool.query("SELECT email_verified FROM users WHERE email = 'pending@example.test'"))
          .rows[0].email_verified,
      ).toBe(true);
      await pool.query(
        "UPDATE users SET email_verified = false WHERE email = 'pending@example.test'",
      );
      expect(
        (
          await pool.query(
            "SELECT email_verified_at FROM users WHERE email = 'pending@example.test'",
          )
        ).rows[0].email_verified_at,
      ).toBeNull();
      await pool.query(
        "INSERT INTO users (email, email_verified_at) VALUES ('imported@example.test', now())",
      );
      expect(
        (await pool.query("SELECT email_verified FROM users WHERE email = 'imported@example.test'"))
          .rows[0].email_verified,
      ).toBe(true);
      // The append-only audit log is still protected after the upgrade.
      await expect(pool.query("DELETE FROM audit_logs")).rejects.toThrow();
    } finally {
      await pool.end();
    }
  });

  it("a failing upgrade rolls back completely and can be retried", async () => {
    const pool = await freshDatabase("upgrade_fail");
    try {
      const db = drizzle(pool);
      await migrate(db, { migrationsFolder: migrationsFolder((i) => i <= STAGE_1_LAST_INDEX) });
      await seedStage1(pool);
      const applied = await count(pool, "SELECT count(*) AS n FROM drizzle.__drizzle_migrations");

      // All stage-2 migrations plus one that fails at the end, in a single run.
      const broken = migrationsFolder(() => true, {
        tag: "9999_simulated_failure",
        sql: "SELECT 1 / 0;",
      });
      await expect(migrate(db, { migrationsFolder: broken })).rejects.toThrow();

      // Nothing from the failed run remains: no auth tables, no new column, same history.
      expect(await count(pool, "SELECT count(*) AS n FROM drizzle.__drizzle_migrations")).toBe(
        applied,
      );
      expect(
        await count(
          pool,
          "SELECT count(*) AS n FROM information_schema.tables WHERE table_name = 'auth_sessions'",
        ),
      ).toBe(0);
      expect(
        await count(
          pool,
          "SELECT count(*) AS n FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'email_verified'",
        ),
      ).toBe(0);
      expect(await count(pool, "SELECT count(*) AS n FROM users")).toBe(2);

      // After fixing the cause, the same upgrade succeeds.
      await migrate(db, { migrationsFolder: MIGRATIONS });
      expect(await count(pool, "SELECT count(*) AS n FROM users WHERE email_verified")).toBe(1);
    } finally {
      await pool.end();
    }
  });
});
