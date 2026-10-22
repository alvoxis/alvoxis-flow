/**
 * Decides whether synthetic test data may be written to a database. Pure (no I/O), so the rules
 * are unit-tested. Refusals name the variables to fix, never their values.
 *
 * Writing is allowed only when all of these hold:
 * - the run is confirmed with TEST_DATA_CONFIRM=synthetic-test-data;
 * - it is not a production deployment (VERCEL_ENV=production);
 * - DATABASE_URL is a postgres:// URL whose host equals TEST_DATA_DB_HOST exactly (the pooled
 *   and direct host of one Neon endpoint count as the same), declared separately on purpose;
 * - that host is a local database or a test endpoint committed to src/config/neon-test-endpoints.json
 *   (both variables are typed in by hand, so a production URL with its own host is refused too).
 */
import { isListedTestDatabase } from "@/config/test-database";

export const TEST_DATA_CONFIRMATION = "synthetic-test-data";

export type TestDataTarget = { ok: true } | { ok: false; error: string };

export function checkTestDataTarget(
  env: Partial<Record<string, string | undefined>>,
): TestDataTarget {
  const fail = (error: string): TestDataTarget => ({ ok: false, error });
  if (env.TEST_DATA_CONFIRM !== TEST_DATA_CONFIRMATION)
    return fail(`Set TEST_DATA_CONFIRM=${TEST_DATA_CONFIRMATION} to write synthetic test data`);
  if (env.VERCEL_ENV === "production") return fail("Refusing to run on a production deployment");
  const expected = (env.TEST_DATA_DB_HOST ?? "").trim().toLowerCase();
  if (!expected) return fail("TEST_DATA_DB_HOST is not set (the host of the test database)");
  let host: string;
  try {
    const url = new URL(env.DATABASE_URL ?? "");
    if (!/^postgres(ql)?:$/.test(url.protocol))
      return fail("DATABASE_URL is not a postgres:// URL");
    host = url.hostname.toLowerCase();
  } catch {
    return fail("DATABASE_URL is not set or not a valid URL");
  }
  const endpoint = (h: string) => h.replace(/^([^.]+)-pooler\./, "$1.");
  if (endpoint(host) !== endpoint(expected))
    return fail("The DATABASE_URL host is not TEST_DATA_DB_HOST; nothing was written");
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host) && !isListedTestDatabase(host))
    return fail(
      "The DATABASE_URL host is not a local database or a listed test endpoint (src/config/neon-test-endpoints.json); nothing was written",
    );
  return { ok: true };
}
