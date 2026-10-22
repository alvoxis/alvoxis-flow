import { describe, expect, it } from "vitest";
import { checkTestDataTarget, TEST_DATA_CONFIRMATION } from "@/server/test-data/target-guard";

// TEST_HOST is a listed test endpoint (src/config/neon-test-endpoints.json); everything else,
// including the credentials, is fictitious.
const TEST_HOST = "ep-rapid-grass-bap8luwv.c-8.eu-central-1.aws.neon.tech";
const ok = {
  TEST_DATA_CONFIRM: TEST_DATA_CONFIRMATION,
  TEST_DATA_DB_HOST: TEST_HOST,
  DATABASE_URL: `postgresql://u:Secr3t@${TEST_HOST}/neondb?sslmode=verify-full`,
};

describe("checkTestDataTarget (synthetic test data may only go to the declared test database)", () => {
  it("allows the declared test host, direct or pooled", () => {
    expect(checkTestDataTarget(ok)).toEqual({ ok: true });
    expect(
      checkTestDataTarget({
        ...ok,
        DATABASE_URL: `postgres://u:p@${TEST_HOST.replace(/^([^.]+)/, "$1-pooler")}/neondb`,
      }),
    ).toEqual({ ok: true });
  });

  it("refuses without confirmation, on production, or for any other host", () => {
    const refused = (env: Record<string, string | undefined>) => {
      const r = checkTestDataTarget(env);
      expect(r.ok).toBe(false);
      return r.ok ? "" : r.error;
    };
    expect(refused({ ...ok, TEST_DATA_CONFIRM: undefined })).toMatch(/TEST_DATA_CONFIRM/);
    expect(refused({ ...ok, TEST_DATA_CONFIRM: "yes" })).toMatch(/TEST_DATA_CONFIRM/);
    expect(refused({ ...ok, VERCEL_ENV: "production" })).toMatch(/production/);
    expect(refused({ ...ok, TEST_DATA_DB_HOST: "" })).toMatch(/TEST_DATA_DB_HOST/);
    expect(refused({ ...ok, DATABASE_URL: undefined })).toMatch(/DATABASE_URL/);
    expect(refused({ ...ok, DATABASE_URL: "mysql://u:p@x/db" })).toMatch(/postgres/);
    const other = refused({
      ...ok,
      DATABASE_URL: "postgresql://u:Secr3t@ep-production-1.c-7.eu-central-1.aws.neon.tech/neondb",
    });
    expect(other).toMatch(/not TEST_DATA_DB_HOST/);
    // Never echoes the URL, the password or a host.
    expect(other).not.toMatch(/Secr3t|ep-production|ep-rapid/);
    expect(
      refused({ ...ok, DATABASE_URL: `postgresql://u:p@${TEST_HOST}.attacker.test/neondb` }),
    ).toMatch(/not TEST_DATA_DB_HOST/);
  });

  it("refuses an unlisted endpoint even when both variables agree; allows a local database", () => {
    const prod = "ep-production-1.c-7.eu-central-1.aws.neon.tech";
    const r = checkTestDataTarget({
      ...ok,
      TEST_DATA_DB_HOST: prod,
      DATABASE_URL: `postgresql://u:Secr3t@${prod}/neondb`,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/listed test endpoint/);
      expect(r.error).not.toMatch(/Secr3t|ep-production/);
    }
    expect(
      checkTestDataTarget({
        ...ok,
        TEST_DATA_DB_HOST: "localhost",
        DATABASE_URL: "postgres://u:p@localhost:5432/alvoxis_flow",
      }),
    ).toEqual({ ok: true });
  });
});
