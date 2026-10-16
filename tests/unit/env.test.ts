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

  it("requires https in production", () => {
    expect(() => parseServerEnv({ ...base, NODE_ENV: "production" })).toThrow(/https/);
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
});
