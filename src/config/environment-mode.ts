/**
 * Whether this deployment is a test environment that must say so on every page: a Vercel preview
 * deployment (`VERCEL_ENV=preview`, set by Vercel itself) or a deployment explicitly marked with
 * `APP_TEST_MODE=1`. Production (`VERCEL_ENV=production`) is never marked, whatever else is set.
 * Read at build and at request time, so the value must be set for the build too.
 */
export function isTestEnvironment(
  env: Partial<Record<string, string | undefined>> = process.env,
): boolean {
  if (env.VERCEL_ENV === "production") return false;
  return env.VERCEL_ENV === "preview" || env.APP_TEST_MODE === "1";
}
