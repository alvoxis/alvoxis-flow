import testEndpoints from "./neon-test-endpoints.json";

/**
 * The committed allowlist of TEST database endpoints (neon-test-endpoints.json). The Preview
 * variables (DATABASE_URL, PREVIEW_DATABASE_HOST) are both typed in by hand, so a production
 * connection string pasted together with its own host would pass a host comparison alone; the
 * list in the repository closes that gap. scripts/ci/neon-test-url.ts reads the same file.
 */
export const TEST_DATABASE_ENDPOINTS: readonly string[] = Object.keys(testEndpoints.endpoints);

/**
 * The Neon endpoint id of a host ("ep-…", the pooled "-pooler" form counts as the same), or
 * undefined for anything that is not a Neon host.
 */
export function neonEndpointId(host: string): string | undefined {
  const h = host.trim().toLowerCase();
  if (!h.endsWith(".neon.tech")) return undefined;
  const first = h.split(".")[0]!.replace(/-pooler$/, "");
  return /^ep-[a-z0-9-]+$/.test(first) ? first : undefined;
}

/** True only for a host of one of the listed test endpoints. */
export function isListedTestDatabase(host: string): boolean {
  const id = neonEndpointId(host);
  return id !== undefined && TEST_DATABASE_ENDPOINTS.includes(id);
}
