import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashSessionToken } from "@/server/auth/session-token-store";
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

  it("hashes sessions stored before 0008 exactly like the application, and re-running changes nothing", async () => {
    const pool = await freshDatabase("upgrade_sessions");
    try {
      const db = drizzle(pool);
      const before0008 = journal.entries.find(
        (e) => e.tag === "0008_auth_hash_session_tokens",
      )!.idx;
      await migrate(db, { migrationsFolder: migrationsFolder((i) => i < before0008) });
      await seedStage1(pool);
      const { rows } = await pool.query<{ id: string }>("SELECT id FROM users LIMIT 1");
      const plain = "LegacyPlainSessionToken0123456789ab";
      await pool.query(
        "INSERT INTO auth_sessions (token, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')",
        [plain, rows[0]!.id],
      );

      await migrate(db, { migrationsFolder: MIGRATIONS });
      const token = async () =>
        (await pool.query<{ token: string }>("SELECT token FROM auth_sessions")).rows[0]!.token;
      expect(await token()).toBe(hashSessionToken(plain));

      // Re-running the migrator, or the statement itself, is a no-op.
      await migrate(db, { migrationsFolder: MIGRATIONS });
      await pool.query(
        readFileSync(path.join(MIGRATIONS, "0008_auth_hash_session_tokens.sql"), "utf8"),
      );
      expect(await token()).toBe(hashSessionToken(plain));
    } finally {
      await pool.end();
    }
  });
});

describe("upgrading to the tax-category catalog (0010–0011)", () => {
  const BEFORE_CATALOG = 9; // 0009_company_profile_address

  it("leaves issued documents untouched and grants tax_categories.manage only to system roles", async () => {
    const pool = await freshDatabase("taxcat");
    try {
      const db = drizzle(pool);
      await migrate(db, { migrationsFolder: migrationsFolder((i) => i <= BEFORE_CATALOG) });
      const company = (
        await pool.query<{ id: string }>(
          `INSERT INTO companies (name, country) VALUES ('Catalog Upgrade SIA', 'LV') RETURNING id`,
        )
      ).rows[0]!.id;
      for (const [key, isSystem] of [
        ["owner", true],
        ["administrator", true],
        ["accountant", true],
        ["manager", true],
        ["auditor", false],
      ] as const) {
        await pool.query(
          `INSERT INTO roles (company_id, key, name, is_system) VALUES ($1, $2, $2, $3)`,
          [company, key, isSystem],
        );
      }
      // An issued document with an inline (pre-catalog) tax snapshot; fictitious values.
      const docId = (
        await pool.query<{ id: string }>(
          `INSERT INTO documents (company_id, type, language, currency, issue_date, seller, buyer)
           VALUES ($1, 'invoice', 'en', 'EUR', '2026-01-05', '{"name":"S"}', '{"name":"B"}')
           RETURNING id`,
          [company],
        )
      ).rows[0]!.id;
      await pool.query(
        `INSERT INTO document_lines (company_id, document_id, position, description, quantity, unit_price, tax_category)
         VALUES ($1, $2, 1, 'Fixture item', 1, 10, '{"code":"T20","kind":"standard","ratePercent":"20","label":"Fixture 20%"}')`,
        [company, docId],
      );
      await pool.query(
        `UPDATE documents SET status = 'issued', number = 'INV-2026-0001', issued_at = now(),
           content_hash = 'fixture-hash', snapshot = '{"number":"INV-2026-0001"}' WHERE id = $1`,
        [docId],
      );
      const snapshot = async () =>
        (
          await pool.query<{ doc: object; line: Record<string, unknown> }>(
            `SELECT to_jsonb(d) AS doc, to_jsonb(l) AS line FROM documents d
             JOIN document_lines l ON l.document_id = d.id WHERE d.id = $1`,
            [docId],
          )
        ).rows[0]!;
      const before = await snapshot();

      await migrate(db, { migrationsFolder: MIGRATIONS });
      const after = await snapshot();
      // Later migrations only add the (empty) bank-account link (0012).
      const { bank_account_id: bankLink, ...docAfter } = after.doc as Record<string, unknown>;
      expect(bankLink).toBeNull();
      expect(docAfter).toEqual(before.doc);
      const { tax_category_id: linkId, ...lineAfter } = after.line;
      expect(linkId).toBeNull();
      expect(lineAfter).toEqual(before.line);
      // Still immutable after the upgrade.
      await expect(
        pool.query(`UPDATE document_lines SET tax_category_id = NULL WHERE document_id = $1`, [
          docId,
        ]),
      ).rejects.toThrow();

      const grants = async () =>
        (
          await pool.query<{ key: string }>(
            `SELECT r.key FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
             WHERE rp.permission_key = 'tax_categories.manage' ORDER BY r.key`,
          )
        ).rows.map((r) => r.key);
      expect(await grants()).toEqual(["accountant", "administrator", "owner"]);
      // The grant migration is idempotent.
      const grantSql = readFileSync(
        path.join(MIGRATIONS, "0011_grant_tax_categories_manage.sql"),
        "utf8",
      );
      for (const stmt of grantSql.split("--> statement-breakpoint")) await pool.query(stmt);
      expect(await grants()).toEqual(["accountant", "administrator", "owner"]);
      expect(await count(pool, `SELECT count(*) AS n FROM tax_categories`)).toBe(0); // no presets
    } finally {
      await pool.end();
    }
  });
});

describe("upgrading to company bank accounts (0012)", () => {
  const BEFORE_ACCOUNTS = 11; // 0011_grant_tax_categories_manage

  it("keeps inline bank details of drafts and issued documents; creates no accounts", async () => {
    const pool = await freshDatabase("bankacc");
    try {
      const db = drizzle(pool);
      await migrate(db, { migrationsFolder: migrationsFolder((i) => i <= BEFORE_ACCOUNTS) });
      const company = (
        await pool.query<{ id: string }>(
          `INSERT INTO companies (name, country) VALUES ('Bank Upgrade SIA', 'LV') RETURNING id`,
        )
      ).rows[0]!.id;
      // Fictitious details with a valid checksum, as entered before accounts existed.
      const bank = JSON.stringify([{ bankName: "Example Bank AS", iban: "LV80BANK0000435195001" }]);
      const insertDoc = async () =>
        (
          await pool.query<{ id: string }>(
            `INSERT INTO documents (company_id, type, language, currency, issue_date, seller, buyer, bank_accounts)
             VALUES ($1, 'invoice', 'en', 'EUR', '2026-01-05', '{"name":"S"}', '{"name":"B"}', $2)
             RETURNING id`,
            [company, bank],
          )
        ).rows[0]!.id;
      const draftId = await insertDoc();
      const issuedId = await insertDoc();
      await pool.query(
        `UPDATE documents SET status = 'issued', number = 'INV-2026-0001', issued_at = now(),
           content_hash = 'fixture-hash', snapshot = '{"number":"INV-2026-0001"}' WHERE id = $1`,
        [issuedId],
      );
      const rows = async () =>
        (
          await pool.query<{ id: string; doc: Record<string, unknown> }>(
            `SELECT id, to_jsonb(d) AS doc FROM documents d WHERE company_id = $1 ORDER BY id`,
            [company],
          )
        ).rows;
      const before = await rows();

      await migrate(db, { migrationsFolder: MIGRATIONS });
      const after = await rows();
      expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id));
      after.forEach(({ doc: { bank_account_id: link, ...rest } }, i) => {
        expect(link).toBeNull();
        expect(rest).toEqual(before[i]!.doc);
      });
      expect(await count(pool, `SELECT count(*) AS n FROM company_bank_accounts`)).toBe(0);
      // Issued documents stay immutable; a link to another company's account is refused.
      await expect(
        pool.query(`UPDATE documents SET bank_accounts = '[]' WHERE id = $1`, [issuedId]),
      ).rejects.toThrow();
      const other = (
        await pool.query<{ id: string }>(
          `INSERT INTO companies (name, country) VALUES ('Other SIA', 'LV') RETURNING id`,
        )
      ).rows[0]!.id;
      const foreign = (
        await pool.query<{ id: string }>(
          `INSERT INTO company_bank_accounts (company_id, iban) VALUES ($1, 'LV80BANK0000435195001') RETURNING id`,
          [other],
        )
      ).rows[0]!.id;
      await expect(
        pool.query(`UPDATE documents SET bank_account_id = $1 WHERE id = $2`, [foreign, draftId]),
      ).rejects.toThrow();
    } finally {
      await pool.end();
    }
  });
});
