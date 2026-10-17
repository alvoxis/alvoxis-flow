import { execFileSync } from "node:child_process";
import path from "node:path";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { checkNeonTestUrl } from "../../scripts/ci/neon-test-url";

/**
 * The pre-check of .github/workflows/neon-test-migrations.yml. Synthetic hosts and passwords
 * only; nothing connects to a database (pg.Client is constructed, never connected).
 */
const HOST = "ep-quiet-sun-a1b2c3d4.c-8.eu-central-1.aws.neon.tech";
const PASSWORD = "FAKEPASSWORD123";
const url = (query: string, host = HOST) =>
  `postgresql://neondb_owner:${PASSWORD}@${host}/neondb${query ? `?${query}` : ""}`;

const ok = (raw: string, expected = HOST) => {
  const r = checkNeonTestUrl(raw, expected);
  if (!r.ok) throw new Error(`expected ok, got: ${r.error}`);
  return r.url;
};
const refused = (raw: string | undefined, ...expected: [string | undefined] | []) => {
  const r = checkNeonTestUrl(raw, expected.length ? expected[0] : HOST);
  expect(r.ok).toBe(false);
  if (r.ok) return "";
  expect(r.error).not.toContain(PASSWORD);
  return r.error;
};

describe("normalization", () => {
  it("keeps sslmode=verify-full unchanged", () => {
    const raw = url("sslmode=verify-full&channel_binding=require");
    expect(ok(raw)).toBe(raw);
  });

  it("tightens Neon's default sslmode=require to verify-full and keeps everything else", () => {
    const normalized = ok(url("sslmode=require&channel_binding=require"));
    const parsed = new URL(normalized);
    expect(parsed.searchParams.getAll("sslmode")).toEqual(["verify-full"]);
    expect(parsed.searchParams.get("channel_binding")).toBe("require");
    expect(parsed.hostname).toBe(HOST);
    expect(parsed.username).toBe("neondb_owner");
    expect(parsed.password).toBe(PASSWORD);
    expect(parsed.pathname).toBe("/neondb");
  });

  it("the pg driver reads the normalized URL as the same host, user, database and TLS on", () => {
    const client = new pg.Client({ connectionString: ok(url("sslmode=require")) });
    const params = (
      client as unknown as {
        connectionParameters: { host: string; user: string; database: string; ssl: unknown };
      }
    ).connectionParameters;
    expect(params).toMatchObject({ host: HOST, user: "neondb_owner", database: "neondb" });
    expect(params.ssl).toBeTruthy();
  });

  it("accepts the expected host with other casing or surrounding spaces", () => {
    expect(ok(url("sslmode=verify-full"), `  ${HOST.toUpperCase()} `)).toBe(
      url("sslmode=verify-full"),
    );
  });
});

describe("refusals (before any connection)", () => {
  it.each([
    ["missing sslmode", url("")],
    ["sslmode=disable", url("sslmode=disable")],
    ["sslmode=prefer", url("sslmode=prefer")],
    ["sslmode=allow", url("sslmode=allow")],
    ["sslmode=verify-ca", url("sslmode=verify-ca")],
    ["sslmode empty", url("sslmode=")],
    ["duplicate sslmode", url("sslmode=require&sslmode=verify-full")],
    ["duplicate sslmode with disable", url("sslmode=verify-full&sslmode=disable")],
  ])("%s", (_name, raw) => {
    expect(refused(raw)).toMatch(/sslmode/);
  });

  it("another Neon host, a non-Neon host and a user-info trick", () => {
    expect(refused(url("sslmode=require", "ep-other-x9.c-8.eu-central-1.aws.neon.tech"))).toMatch(
      /is not NEON_TEST_DB_HOST/,
    );
    expect(refused(url("sslmode=require", "db.example.com"))).toMatch(/is not NEON_TEST_DB_HOST/);
    expect(
      refused(`postgresql://${HOST}:${PASSWORD}@evil.example.com/neondb?sslmode=require`),
    ).toMatch(/is not NEON_TEST_DB_HOST/);
  });

  it("pooled hosts, in the URL or in the expected host", () => {
    const pooled = HOST.replace(".c-8", "-pooler.c-8");
    expect(refused(url("sslmode=require", pooled))).toMatch(/non-pooled/);
    expect(refused(url("sslmode=require"), pooled)).toMatch(/NEON_TEST_DB_HOST must be/);
  });

  it("query parameters other than sslmode and channel_binding (e.g. a host override)", () => {
    for (const extra of ["host=prod.example.com", "port=6543", "sslrootcert=x", "options=x"])
      expect(refused(url(`sslmode=require&${extra}`))).toMatch(/may only carry/);
  });

  it("missing inputs, invalid URLs and other schemes", () => {
    expect(refused(undefined)).toMatch(/NEON_TEST_DATABASE_URL is not set/);
    expect(refused("")).toMatch(/NEON_TEST_DATABASE_URL is not set/);
    expect(refused(url("sslmode=require"), undefined)).toMatch(/NEON_TEST_DB_HOST is not set/);
    expect(refused(url("sslmode=require"), "  ")).toMatch(/NEON_TEST_DB_HOST is not set/);
    expect(refused(url("sslmode=require"), "db.example.com")).toMatch(/NEON_TEST_DB_HOST must be/);
    expect(refused(`not a url ${PASSWORD}`)).toMatch(/not a valid URL/);
    expect(refused(url("sslmode=require").replace("postgresql:", "mysql:"))).toMatch(
      /not a postgres/,
    );
  });
});

describe("command line, as the workflow runs it (plain Node, no dependencies)", () => {
  const script = path.resolve(process.cwd(), "scripts/ci/neon-test-url.ts");
  const run = (mode: string, raw: string, expected = HOST) => {
    try {
      const stdout = execFileSync(process.execPath, ["--no-warnings", script, mode], {
        // Only what the script reads (no inherited secrets), as in the workflow step.
        env: {
          PATH: process.env.PATH,
          NEON_TEST_DATABASE_URL: raw,
          NEON_TEST_DB_HOST: expected,
        } as unknown as NodeJS.ProcessEnv,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { code: 0, stdout, stderr: "" };
    } catch (err) {
      const e = err as { status: number; stdout: string; stderr: string };
      return { code: e.status, stdout: e.stdout, stderr: e.stderr };
    }
  };

  it("check prints nothing on success; print writes only the normalized URL", () => {
    expect(run("check", url("sslmode=require"))).toEqual({ code: 0, stdout: "", stderr: "" });
    const printed = run("print", url("sslmode=require&channel_binding=require"));
    expect(printed.code).toBe(0);
    expect(printed.stdout).toBe(ok(url("sslmode=require&channel_binding=require")));
  });

  it("refusals exit 1 with a GitHub error annotation that never contains the secret", () => {
    for (const raw of [
      url("sslmode=disable"),
      url("sslmode=require", "ep-other-x9.c-8.eu-central-1.aws.neon.tech"),
      `not a url ${PASSWORD}`,
    ]) {
      for (const mode of ["check", "print"]) {
        const r = run(mode, raw);
        expect(r.code).toBe(1);
        expect(r.stdout).toBe("");
        expect(r.stderr).toMatch(/^::error::.*nothing was done\.\n$/);
        expect(r.stderr).not.toContain(PASSWORD);
        expect(r.stderr).not.toContain("neondb_owner");
      }
    }
  });
});
