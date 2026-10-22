/**
 * Validates and normalizes a Neon connection string for the manual migration workflows
 * (.github/workflows/neon-test-migrations.yml, neon-production-migrations.yml). Runs with plain
 * Node 22 (type stripping): no dependencies, no imports from the application.
 *
 *   node scripts/ci/neon-test-url.ts check [URL_VAR HOST_VAR]   exit 0 when valid; prints nothing
 *   node scripts/ci/neon-test-url.ts print [URL_VAR HOST_VAR]   prints the normalized URL to
 *                                                               stdout (for `url="$(…)"`)
 *
 * Inputs (environment): the secret URL_VAR and the expected direct endpoint host HOST_VAR (not a
 * secret); defaults NEON_TEST_DATABASE_URL / NEON_TEST_DB_HOST. Error messages name these
 * variables but never contain the URL, the password or any part of the secret.
 */

import { readFileSync } from "node:fs";

export type NeonUrlResult = { ok: true; url: string } | { ok: false; error: string };
export interface NeonUrlNames {
  url: string;
  host: string;
}
/**
 * Endpoint ids from src/config/neon-test-endpoints.json: the test workflows accept only `allow`,
 * the production workflow refuses `deny` (the same list), whatever the hand-typed variables say.
 */
export interface NeonEndpointRules {
  allow?: readonly string[];
  deny?: readonly string[];
}
const TEST_NAMES: NeonUrlNames = { url: "NEON_TEST_DATABASE_URL", host: "NEON_TEST_DB_HOST" };
/** Only these variable names may be read: never arbitrary environment variables. */
const VAR_NAME = /^NEON_[A-Z0-9_]+$/;

/** Direct (non-pooled) Neon endpoint host, e.g. ep-name-123.c-8.eu-central-1.aws.neon.tech. */
const DIRECT_HOST = /^ep-[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+(-[a-z0-9]+)*)+\.neon\.tech$/;
/** The pg driver lets query parameters (host, port, ssl*, …) override the URL; allow only these. */
const ALLOWED_PARAMS = new Set(["sslmode", "channel_binding"]);
/** Accepted TLS modes; `require` is tightened to `verify-full` before any connection. */
const ACCEPTED_SSLMODES = new Set(["require", "verify-full"]);

export function checkNeonTestUrl(
  rawUrl: string | undefined,
  rawExpectedHost: string | undefined,
  names: NeonUrlNames = TEST_NAMES,
  endpoints: NeonEndpointRules = {},
): NeonUrlResult {
  const fail = (error: string): NeonUrlResult => ({ ok: false, error });
  const URL_VAR = names.url;
  const HOST_VAR = names.host;
  if (!rawUrl) return fail(`Secret ${URL_VAR} is not set`);
  const expected = (rawExpectedHost ?? "").trim().toLowerCase();
  if (!expected) return fail(`Variable ${HOST_VAR} is not set`);
  if (!DIRECT_HOST.test(expected) || expected.includes("-pooler"))
    return fail(
      `${HOST_VAR} must be a direct Neon endpoint host (ep-….neon.tech, without -pooler)`,
    );

  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return fail(`${URL_VAR} is not a valid URL`);
  }
  if (!/^postgres(ql)?:$/.test(u.protocol)) return fail(`${URL_VAR} is not a postgres:// URL`);
  for (const key of u.searchParams.keys())
    if (!ALLOWED_PARAMS.has(key))
      return fail(`${URL_VAR} may only carry the sslmode and channel_binding parameters`);
  if (u.hostname.includes("-pooler"))
    return fail("Use the direct (non-pooled) Neon connection string for migrations");
  if (u.hostname !== expected) return fail(`The ${URL_VAR} host is not ${HOST_VAR}`);
  const endpointId = expected.split(".")[0]!;
  if (endpoints.allow && !endpoints.allow.includes(endpointId))
    return fail(`${HOST_VAR} is not a test endpoint listed in src/config/neon-test-endpoints.json`);
  if (endpoints.deny?.includes(endpointId))
    return fail(`${HOST_VAR} is a test endpoint (src/config/neon-test-endpoints.json)`);

  const sslmode = u.searchParams.getAll("sslmode");
  if (sslmode.length !== 1 || !ACCEPTED_SSLMODES.has(sslmode[0]!))
    return fail(`${URL_VAR} must set sslmode=verify-full or sslmode=require (once)`);
  if (sslmode[0] === "verify-full") return { ok: true, url: rawUrl };
  // require → verify-full: certificate and host name are verified (never a weaker mode).
  u.searchParams.set("sslmode", "verify-full");
  return { ok: true, url: u.toString() };
}

function main(mode: string | undefined, urlVar?: string, hostVar?: string): void {
  const names = urlVar || hostVar ? { url: urlVar ?? "", host: hostVar ?? "" } : TEST_NAMES;
  if (
    (mode !== "check" && mode !== "print") ||
    !VAR_NAME.test(names.url) ||
    !VAR_NAME.test(names.host)
  ) {
    console.error("::error::Usage: neon-test-url.ts check|print [NEON_…_URL_VAR NEON_…_HOST_VAR]");
    process.exit(2);
  }
  // The test names may only reach listed test endpoints; any other names (production) never may.
  const listed = Object.keys(
    (
      JSON.parse(
        readFileSync(new URL("../../src/config/neon-test-endpoints.json", import.meta.url), "utf8"),
      ) as { endpoints: Record<string, string> }
    ).endpoints,
  );
  const rules = names.url === TEST_NAMES.url ? { allow: listed } : { deny: listed };
  const result = checkNeonTestUrl(process.env[names.url], process.env[names.host], names, rules);
  if (!result.ok) {
    console.error(`::error::${result.error}; nothing was done.`);
    process.exit(1);
  }
  if (mode === "print") process.stdout.write(result.url);
}

const invokedPath = process.argv[1] ?? "";
if (invokedPath.endsWith("/scripts/ci/neon-test-url.ts"))
  main(process.argv[2], process.argv[3], process.argv[4]);
