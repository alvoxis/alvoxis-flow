/**
 * Validates and normalizes the Neon TEST connection string for
 * .github/workflows/neon-test-migrations.yml. Runs with plain Node 22 (type stripping): no
 * dependencies, no imports from the application.
 *
 *   node scripts/ci/neon-test-url.ts check   exit 0 when valid; prints nothing on success
 *   node scripts/ci/neon-test-url.ts print   prints the normalized URL to stdout (for
 *                                            `url="$(…)"`), nothing else
 *
 * Inputs (environment): NEON_TEST_DATABASE_URL (secret), NEON_TEST_DB_HOST (expected direct
 * endpoint host, not a secret). Error messages never contain the URL, the password or any part
 * of the secret.
 */

export type NeonUrlResult = { ok: true; url: string } | { ok: false; error: string };

/** Direct (non-pooled) Neon endpoint host, e.g. ep-name-123.c-8.eu-central-1.aws.neon.tech. */
const DIRECT_HOST = /^ep-[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+(-[a-z0-9]+)*)+\.neon\.tech$/;
/** The pg driver lets query parameters (host, port, ssl*, …) override the URL; allow only these. */
const ALLOWED_PARAMS = new Set(["sslmode", "channel_binding"]);
/** Accepted TLS modes; `require` is tightened to `verify-full` before any connection. */
const ACCEPTED_SSLMODES = new Set(["require", "verify-full"]);

export function checkNeonTestUrl(
  rawUrl: string | undefined,
  rawExpectedHost: string | undefined,
): NeonUrlResult {
  const fail = (error: string): NeonUrlResult => ({ ok: false, error });
  if (!rawUrl) return fail("Secret NEON_TEST_DATABASE_URL is not set");
  const expected = (rawExpectedHost ?? "").trim().toLowerCase();
  if (!expected) return fail("Variable NEON_TEST_DB_HOST is not set");
  if (!DIRECT_HOST.test(expected) || expected.includes("-pooler"))
    return fail(
      "NEON_TEST_DB_HOST must be a direct Neon endpoint host (ep-….neon.tech, without -pooler)",
    );

  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return fail("NEON_TEST_DATABASE_URL is not a valid URL");
  }
  if (!/^postgres(ql)?:$/.test(u.protocol))
    return fail("NEON_TEST_DATABASE_URL is not a postgres:// URL");
  for (const key of u.searchParams.keys())
    if (!ALLOWED_PARAMS.has(key))
      return fail(
        "NEON_TEST_DATABASE_URL may only carry the sslmode and channel_binding parameters",
      );
  if (u.hostname.includes("-pooler"))
    return fail("Use the direct (non-pooled) Neon connection string for migrations");
  if (u.hostname !== expected)
    return fail("The NEON_TEST_DATABASE_URL host is not NEON_TEST_DB_HOST");

  const sslmode = u.searchParams.getAll("sslmode");
  if (sslmode.length !== 1 || !ACCEPTED_SSLMODES.has(sslmode[0]!))
    return fail("NEON_TEST_DATABASE_URL must set sslmode=verify-full or sslmode=require (once)");
  if (sslmode[0] === "verify-full") return { ok: true, url: rawUrl };
  // require → verify-full: certificate and host name are verified (never a weaker mode).
  u.searchParams.set("sslmode", "verify-full");
  return { ok: true, url: u.toString() };
}

function main(mode: string | undefined): void {
  if (mode !== "check" && mode !== "print") {
    console.error("::error::Usage: neon-test-url.ts check|print");
    process.exit(2);
  }
  const result = checkNeonTestUrl(
    process.env.NEON_TEST_DATABASE_URL,
    process.env.NEON_TEST_DB_HOST,
  );
  if (!result.ok) {
    console.error(`::error::${result.error}; nothing was done.`);
    process.exit(1);
  }
  if (mode === "print") process.stdout.write(result.url);
}

const invokedPath = process.argv[1] ?? "";
if (invokedPath.endsWith("/scripts/ci/neon-test-url.ts")) main(process.argv[2]);
