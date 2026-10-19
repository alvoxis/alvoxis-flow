import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * GET /api/health with invalid or unreachable configuration. Synthetic values only; the
 * "unavailable" case points at a closed local port, so nothing real is contacted.
 */
const FAKE_SECRET = "FAKESECRETVALUE"; // must never appear in a response
const original = { ...process.env };

async function health(env: Record<string, string | undefined>) {
  vi.resetModules(); // getServerEnv caches the parsed environment per module instance
  for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
  Object.assign(process.env, original);
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const { GET } = await import("@/app/api/health/route");
  const res = await GET();
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) as Record<string, unknown> };
}

afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
  Object.assign(process.env, original);
});

describe("GET /api/health", () => {
  it("names the missing variables (never values) when the configuration is invalid", async () => {
    const r = await health({
      DATABASE_URL: undefined,
      BETTER_AUTH_SECRET: `short-${FAKE_SECRET}`,
    });
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({
      status: "degraded",
      database: "not_configured",
      invalid: ["BETTER_AUTH_SECRET", "DATABASE_URL"],
    });
    expect(r.text).not.toContain(FAKE_SECRET);
  });

  it("reports a Vercel deployment without APP_URL by name", async () => {
    const r = await health({
      NODE_ENV: "production",
      VERCEL: "1",
      APP_URL: undefined,
      DATABASE_URL: `postgres://u:${FAKE_SECRET}@127.0.0.1:1/db`,
      BETTER_AUTH_SECRET: `${FAKE_SECRET}-${"x".repeat(32)}`,
    });
    expect(r.status).toBe(503);
    expect(r.body.invalid).toEqual(["APP_URL"]);
    expect(r.text).not.toContain(FAKE_SECRET);
    expect(r.text).not.toMatch(/postgres:\/\//);
  });

  it("a preview pointing at another database is refused before connecting, by name only", async () => {
    const r = await health({
      NODE_ENV: "production",
      VERCEL: "1",
      VERCEL_ENV: "preview",
      VERCEL_BRANCH_URL: "app-git-main-team.vercel.app",
      VERCEL_PROJECT_PRODUCTION_URL: "app.vercel.app",
      APP_URL: undefined,
      TRUSTED_IP_HEADER: "x-real-ip",
      PREVIEW_DATABASE_HOST: "ep-test-1.c-8.eu-central-1.aws.neon.tech",
      DATABASE_URL: `postgres://u:${FAKE_SECRET}@ep-production-1.c-7.eu-central-1.aws.neon.tech/db`,
      BETTER_AUTH_SECRET: `${FAKE_SECRET}-${"x".repeat(32)}`,
    });
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ database: "not_configured", invalid: ["DATABASE_URL"] });
    expect(r.text).not.toContain(FAKE_SECRET);
    expect(r.text).not.toMatch(/ep-production|ep-test|neon\.tech/);
  });

  it("valid configuration but no reachable database: 503 unavailable, no variable list", async () => {
    const r = await health({
      NODE_ENV: "test",
      DATABASE_URL: `postgres://u:${FAKE_SECRET}@127.0.0.1:1/db`,
      BETTER_AUTH_SECRET: `${FAKE_SECRET}-${"x".repeat(32)}`,
    });
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ status: "degraded", database: "unavailable" });
    expect(r.body).not.toHaveProperty("invalid");
    expect(r.text).not.toContain(FAKE_SECRET);
  });
});
