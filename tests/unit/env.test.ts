import { describe, expect, it } from "vitest";
import { EnvValidationError, parseServerEnv } from "@/config/env";

const SECRET = "test-secret-test-secret-test-secret-1234"; // fixture, not a real secret
const base = { DATABASE_URL: "postgres://u:p@localhost:5432/db", BETTER_AUTH_SECRET: SECRET };

describe("parseServerEnv", () => {
  it("accepts a valid configuration and applies defaults", () => {
    const env = parseServerEnv(base);
    expect(env.NODE_ENV).toBe("development");
    expect(env.APP_URL).toBe("http://localhost:3000");
    expect(env.LOG_LEVEL).toBe("info");
    expect(env.EMAIL_TRANSPORT).toBe("disabled");
    expect(env.GOOGLE_CLIENT_ID).toBeUndefined();
  });

  it("requires a long BETTER_AUTH_SECRET", () => {
    expect(() => parseServerEnv({ ...base, BETTER_AUTH_SECRET: "short" })).toThrow(
      /BETTER_AUTH_SECRET/,
    );
    expect(() => parseServerEnv({ DATABASE_URL: base.DATABASE_URL })).toThrow(/BETTER_AUTH_SECRET/);
  });

  it("requires Google client id and secret together; empty values mean 'not configured'", () => {
    expect(() => parseServerEnv({ ...base, GOOGLE_CLIENT_ID: "id" })).toThrow(/GOOGLE_CLIENT_ID/);
    expect(
      parseServerEnv({ ...base, GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "" }).GOOGLE_CLIENT_ID,
    ).toBeUndefined();
    expect(
      parseServerEnv({ ...base, GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "s" })
        .GOOGLE_CLIENT_SECRET,
    ).toBe("s");
  });

  it("validates email transport configuration", () => {
    expect(() => parseServerEnv({ ...base, EMAIL_TRANSPORT: "smtp" })).toThrow(/SMTP_HOST/);
    expect(() =>
      parseServerEnv({
        ...base,
        EMAIL_TRANSPORT: "file",
        NODE_ENV: "production",
        APP_URL: "https://x.test",
      }),
    ).toThrow(/development and tests only/);
    expect(
      parseServerEnv({
        ...base,
        EMAIL_TRANSPORT: "smtp",
        SMTP_HOST: "smtp.example.test",
        EMAIL_FROM: "no-reply@example.test",
      }).SMTP_PORT,
    ).toBe(587);
  });

  it("requires https in production deployments (localhost builds are exempt)", () => {
    expect(() =>
      parseServerEnv({ ...base, NODE_ENV: "production", APP_URL: "http://app.example.test" }),
    ).toThrow(/https/);
    expect(
      parseServerEnv({ ...base, NODE_ENV: "production", APP_URL: "http://localhost:3000" }).APP_URL,
    ).toBe("http://localhost:3000");
    expect(
      parseServerEnv({
        ...base,
        NODE_ENV: "production",
        APP_URL: "http://localhost:3000",
        EMAIL_TRANSPORT: "file",
      }).EMAIL_TRANSPORT,
    ).toBe("file");
  });

  it("requires an explicit APP_URL on Vercel instead of silently using localhost", () => {
    const vercel = { ...base, NODE_ENV: "production", VERCEL: "1" };
    expect(() => parseServerEnv(vercel)).toThrow(/APP_URL: APP_URL is required on Vercel/);
    // With APP_URL set, the usual production rules apply (https, per-client rate limits).
    expect(() => parseServerEnv({ ...vercel, APP_URL: "https://flow.example.test" })).toThrow(
      /TRUSTED_IP_HEADER/,
    );
    const env = parseServerEnv({
      ...vercel,
      APP_URL: "https://flow.example.test",
      TRUSTED_IP_HEADER: "x-real-ip",
    });
    expect(env.APP_URL).toBe("https://flow.example.test");
    // Outside Vercel the local default is unchanged.
    expect(parseServerEnv({ ...base, NODE_ENV: "production" }).APP_URL).toBe(
      "http://localhost:3000",
    );
  });

  it("fails fast when DATABASE_URL is missing", () => {
    expect(() => parseServerEnv({})).toThrow(EnvValidationError);
  });

  it("rejects non-postgres database URLs and invalid APP_URL", () => {
    expect(() => parseServerEnv({ ...base, DATABASE_URL: "mysql://localhost/db" })).toThrow(
      /postgres/,
    );
    expect(() =>
      parseServerEnv({ ...base, DATABASE_URL: "postgres://localhost/db", APP_URL: "not a url" }),
    ).toThrow(/APP_URL/);
  });

  it("does not include secret values in error messages", () => {
    try {
      parseServerEnv({ ...base, DATABASE_URL: "mysql://user:s3cret@host/db" });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain("s3cret");
    }
  });

  it("parses BETTER_AUTH_SECRETS for key rotation and rejects weak or malformed entries", () => {
    const other = "another-test-secret-another-test-secret-99";
    expect(
      parseServerEnv({ ...base, BETTER_AUTH_SECRETS: `2:${other}, 1:${SECRET}` })
        .BETTER_AUTH_SECRETS,
    ).toEqual([
      { version: 2, value: other },
      { version: 1, value: SECRET },
    ]);
    expect(parseServerEnv(base).BETTER_AUTH_SECRETS).toBeUndefined();
    for (const bad of [`2:short`, `x:${SECRET}`, `${SECRET}`, `1:${SECRET},1:${other}`]) {
      expect(() => parseServerEnv({ ...base, BETTER_AUTH_SECRETS: bad })).toThrow(
        /BETTER_AUTH_SECRETS/,
      );
    }
    // Secret values never appear in the error.
    expect(() => parseServerEnv({ ...base, BETTER_AUTH_SECRETS: "2:tooshort-value" })).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining("tooshort-value") }),
    );
  });

  it("parses TRUSTED_PROXIES as IP/CIDR entries", () => {
    expect(
      parseServerEnv({ ...base, TRUSTED_PROXIES: "10.0.0.0/8, 192.168.1.10,2001:db8::/32" })
        .TRUSTED_PROXIES,
    ).toEqual(["10.0.0.0/8", "192.168.1.10", "2001:db8::/32"]);
    expect(() => parseServerEnv({ ...base, TRUSTED_PROXIES: "proxy.internal" })).toThrow(
      /TRUSTED_PROXIES/,
    );
  });
});

describe("preview deployments (VERCEL_ENV=preview): the test environment", () => {
  // TEST_DB is a listed test endpoint (src/config/neon-test-endpoints.json; ids are not secrets);
  // the other hosts and the Vercel URLs are fictitious.
  const TEST_DB = "ep-rapid-grass-bap8luwv.c-8.eu-central-1.aws.neon.tech";
  const OTHER_DB = "ep-other-endpoint-654321.c-7.eu-central-1.aws.neon.tech";
  const preview = {
    ...base,
    NODE_ENV: "production",
    VERCEL: "1",
    VERCEL_ENV: "preview",
    VERCEL_BRANCH_URL: "app-git-main-team.vercel.app",
    VERCEL_URL: "app-abc123-team.vercel.app",
    VERCEL_PROJECT_PRODUCTION_URL: "app.vercel.app",
    TRUSTED_IP_HEADER: "x-real-ip",
    DATABASE_URL: `postgresql://u:p@${TEST_DB.replace(/^([^.]+)/, "$1-pooler")}/neondb?sslmode=verify-full`,
    PREVIEW_DATABASE_HOST: TEST_DB,
  };
  const issuesOf = (env: Record<string, string | undefined>) => {
    try {
      parseServerEnv(env);
      return [];
    } catch (err) {
      return (err as EnvValidationError).variables;
    }
  };

  it("accepts the test database (pooled or direct host) and uses the branch URL as APP_URL", () => {
    const env = parseServerEnv(preview);
    expect(env.APP_URL).toBe("https://app-git-main-team.vercel.app");
    expect(
      parseServerEnv({ ...preview, DATABASE_URL: `postgres://u:p@${TEST_DB}/neondb` }).APP_URL,
    ).toBe("https://app-git-main-team.vercel.app");
    expect(
      parseServerEnv({ ...preview, APP_URL: "https://app-abc123-team.vercel.app" }).APP_URL,
    ).toBe("https://app-abc123-team.vercel.app");
  });

  it("refuses any database other than the declared test database", () => {
    expect(issuesOf({ ...preview, PREVIEW_DATABASE_HOST: undefined })).toEqual([
      "PREVIEW_DATABASE_HOST",
    ]);
    expect(issuesOf({ ...preview, DATABASE_URL: `postgresql://u:p@${OTHER_DB}/neondb` })).toEqual([
      "DATABASE_URL",
    ]);
    // A look-alike host is not the same endpoint.
    expect(
      issuesOf({ ...preview, DATABASE_URL: `postgresql://u:p@${TEST_DB}.evil.test/neondb` }),
    ).toEqual(["DATABASE_URL"]);
  });

  it("accepts only test endpoints committed to the repository, whatever the variables say", () => {
    // The common paste mistake done twice: a production string together with its own host.
    expect(
      issuesOf({
        ...preview,
        DATABASE_URL: `postgresql://u:p@${OTHER_DB}/neondb`,
        PREVIEW_DATABASE_HOST: OTHER_DB,
      }),
    ).toEqual(["PREVIEW_DATABASE_HOST"]);
    expect(
      issuesOf({
        ...preview,
        DATABASE_URL: "postgresql://u:p@db.example.test/neondb",
        PREVIEW_DATABASE_HOST: "db.example.test",
      }),
    ).toEqual(["PREVIEW_DATABASE_HOST"]);
    // The other listed endpoint (the baseline branch) is accepted.
    const baseline = "ep-young-queen-ba1c9tj8.c-8.eu-central-1.aws.neon.tech";
    expect(
      issuesOf({
        ...preview,
        DATABASE_URL: `postgresql://u:p@${baseline}/neondb`,
        PREVIEW_DATABASE_HOST: baseline,
      }),
    ).toEqual([]);
    // Listed early too, while the secrets are still missing.
    expect(
      issuesOf({
        NODE_ENV: "production",
        VERCEL: "1",
        VERCEL_ENV: "preview",
        VERCEL_BRANCH_URL: "app-git-main-team.vercel.app",
        TRUSTED_IP_HEADER: "x-real-ip",
        PREVIEW_DATABASE_HOST: OTHER_DB,
      }),
    ).toContain("PREVIEW_DATABASE_HOST");
  });

  it("never uses the production domain or another site as APP_URL", () => {
    expect(issuesOf({ ...preview, APP_URL: "https://app.vercel.app" })).toEqual(["APP_URL"]);
    expect(issuesOf({ ...preview, APP_URL: "https://elsewhere.example.test" })).toEqual([
      "APP_URL",
    ]);
    // Without the branch URL and without APP_URL there is no safe default.
    expect(issuesOf({ ...preview, VERCEL_BRANCH_URL: undefined, VERCEL_URL: undefined })).toEqual([
      "APP_URL",
    ]);
  });

  it("sends email only through a sandbox", () => {
    const smtp = { EMAIL_TRANSPORT: "smtp", EMAIL_FROM: "Test <no-reply@example.test>" };
    expect(
      parseServerEnv({ ...preview, ...smtp, SMTP_HOST: "sandbox.smtp.mailtrap.io" }).SMTP_HOST,
    ).toBe("sandbox.smtp.mailtrap.io");
    expect(issuesOf({ ...preview, ...smtp, SMTP_HOST: "smtp.real-mail.example.test" })).toEqual([
      "SMTP_HOST",
    ]);
  });

  it("error messages name variables, never their values", () => {
    let message = "";
    try {
      parseServerEnv({
        ...preview,
        DATABASE_URL: `postgresql://user:Sup3rS3cret@${OTHER_DB}/neondb`,
      });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/DATABASE_URL/);
    expect(message).not.toMatch(/Sup3rS3cret|ep-other|ep-rapid/);
  });

  it("lists every missing preview variable at once, even before the secrets are set", () => {
    // A fresh preview: Vercel's own variables only, nothing configured yet.
    const fresh = {
      NODE_ENV: "production",
      VERCEL: "1",
      VERCEL_ENV: "preview",
      VERCEL_BRANCH_URL: "app-git-main-team.vercel.app",
    };
    expect(issuesOf(fresh)).toEqual([
      "BETTER_AUTH_SECRET",
      "DATABASE_URL",
      "PREVIEW_DATABASE_HOST",
      "TRUSTED_IP_HEADER",
    ]);
    // Without a branch URL from Vercel, APP_URL is reported too.
    expect(issuesOf({ ...fresh, VERCEL_BRANCH_URL: undefined })).toContain("APP_URL");
    // Not on production or local runs.
    expect(issuesOf({ ...fresh, VERCEL_ENV: "production" })).toEqual([
      "BETTER_AUTH_SECRET",
      "DATABASE_URL",
    ]);
  });

  it("production and local runs are unaffected by the preview rules", () => {
    const production = {
      ...preview,
      VERCEL_ENV: "production",
      PREVIEW_DATABASE_HOST: undefined,
      APP_URL: "https://app.vercel.app",
      DATABASE_URL: `postgresql://u:p@${OTHER_DB}/neondb`,
    };
    expect(parseServerEnv(production).APP_URL).toBe("https://app.vercel.app");
    // Production never falls back to the branch URL: APP_URL stays required there.
    expect(issuesOf({ ...production, APP_URL: undefined })).toEqual(["APP_URL"]);
    expect(parseServerEnv(base).APP_URL).toBe("http://localhost:3000");
  });

  it("production refuses the declared test database, pooled or direct", () => {
    const production = { ...preview, VERCEL_ENV: "production", APP_URL: "https://app.vercel.app" };
    // Preview-only variables leaked into production: DATABASE_URL is the test database.
    expect(issuesOf(production)).toEqual(["DATABASE_URL"]);
    expect(issuesOf({ ...production, DATABASE_URL: `postgres://u:p@${TEST_DB}/neondb` })).toEqual([
      "DATABASE_URL",
    ]);
    // A listed test endpoint is refused even without PREVIEW_DATABASE_HOST.
    expect(
      issuesOf({
        ...production,
        PREVIEW_DATABASE_HOST: undefined,
        DATABASE_URL: `postgres://u:p@${TEST_DB}/neondb`,
      }),
    ).toEqual(["DATABASE_URL"]);
    // Its own database is fine even when PREVIEW_DATABASE_HOST is visible to production.
    expect(
      parseServerEnv({ ...production, DATABASE_URL: `postgresql://u:p@${OTHER_DB}/neondb` })
        .APP_URL,
    ).toBe("https://app.vercel.app");
  });
});
