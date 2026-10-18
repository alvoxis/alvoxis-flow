import { describe, expect, it } from "vitest";
import { isTestEnvironment } from "@/config/environment-mode";

describe("isTestEnvironment (the test-environment banner)", () => {
  it("marks Vercel preview deployments and explicitly marked test deployments", () => {
    expect(isTestEnvironment({ VERCEL_ENV: "preview" })).toBe(true);
    expect(isTestEnvironment({ APP_TEST_MODE: "1" })).toBe(true);
    expect(isTestEnvironment({ VERCEL_ENV: "development", APP_TEST_MODE: "1" })).toBe(true);
  });

  it("never marks production, and needs an exact opt-in elsewhere", () => {
    expect(isTestEnvironment({ VERCEL_ENV: "production" })).toBe(false);
    expect(isTestEnvironment({ VERCEL_ENV: "production", APP_TEST_MODE: "1" })).toBe(false);
    expect(isTestEnvironment({})).toBe(false);
    expect(isTestEnvironment({ APP_TEST_MODE: "true" })).toBe(false);
    expect(isTestEnvironment({ APP_TEST_MODE: "" })).toBe(false);
  });
});
