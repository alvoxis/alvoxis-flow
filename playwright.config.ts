import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 3100);
// Allows using a pre-installed Chromium (e.g. in sandboxes) instead of a downloaded one.
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined;
/** Mail written by the file transport during e2e runs; tests read verification/reset links here. */
export const E2E_MAIL_DIR = "tmp/e2e-mail";

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    launchOptions: { executablePath },
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    {
      name: "tablet",
      use: { ...devices["Desktop Chrome"], viewport: { width: 820, height: 1180 } },
    },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: `pnpm start --port ${PORT}`,
    url: `http://localhost:${PORT}/en`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      APP_URL: `http://localhost:${PORT}`,
      // Falls back to DATABASE_URL from the environment or .env when not set.
      ...(process.env.E2E_DATABASE_URL ? { DATABASE_URL: process.env.E2E_DATABASE_URL } : {}),
      // Fixture secret for local/CI test databases only.
      BETTER_AUTH_SECRET:
        process.env.E2E_BETTER_AUTH_SECRET ?? "e2e-test-secret-not-for-production-000000001",
      EMAIL_TRANSPORT: "file",
      // Each test context sends its own client IP so rate limits are per client, as in production.
      TRUSTED_IP_HEADER: "x-forwarded-for",
      EMAIL_FILE_DIR: E2E_MAIL_DIR,
      GOOGLE_CLIENT_ID: "",
      GOOGLE_CLIENT_SECRET: "",
    },
  },
});
