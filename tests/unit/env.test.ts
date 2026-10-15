import { describe, expect, it } from "vitest";
import { EnvValidationError, parseServerEnv } from "@/config/env";

describe("parseServerEnv", () => {
  it("accepts a valid configuration and applies defaults", () => {
    const env = parseServerEnv({ DATABASE_URL: "postgres://u:p@localhost:5432/db" });
    expect(env.NODE_ENV).toBe("development");
    expect(env.APP_URL).toBe("http://localhost:3000");
    expect(env.LOG_LEVEL).toBe("info");
  });

  it("fails fast when DATABASE_URL is missing", () => {
    expect(() => parseServerEnv({})).toThrow(EnvValidationError);
  });

  it("rejects non-postgres database URLs and invalid APP_URL", () => {
    expect(() => parseServerEnv({ DATABASE_URL: "mysql://localhost/db" })).toThrow(/postgres/);
    expect(() =>
      parseServerEnv({ DATABASE_URL: "postgres://localhost/db", APP_URL: "not a url" }),
    ).toThrow(/APP_URL/);
  });

  it("does not include secret values in error messages", () => {
    try {
      parseServerEnv({ DATABASE_URL: "mysql://user:s3cret@host/db" });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain("s3cret");
    }
  });
});
