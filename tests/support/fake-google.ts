import { vi } from "vitest";

/** Fixture OAuth client for tests only — not a real Google client. */
export const FAKE_GOOGLE = {
  GOOGLE_CLIENT_ID: "test-client-id.apps.example.test",
  GOOGLE_CLIENT_SECRET: "test-client-secret-not-real",
};

export interface GoogleClaims {
  sub: string;
  email: string;
  email_verified: boolean;
  name?: string;
}

const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

/**
 * Replaces Google's token endpoint: the next authorization code exchange returns an id_token with
 * `claims`. Every other request goes to the real fetch. Returns the spy (restore it after use).
 */
export function stubGoogleTokenEndpoint(claims: () => GoogleClaims) {
  const realFetch = globalThis.fetch;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith("https://oauth2.googleapis.com/token")) return realFetch(input, init);
    const now = Math.floor(Date.now() / 1000);
    const idToken = [
      b64url({ alg: "RS256", kid: "test", typ: "JWT" }),
      b64url({
        iss: "https://accounts.google.com",
        aud: FAKE_GOOGLE.GOOGLE_CLIENT_ID,
        iat: now,
        exp: now + 600,
        name: "Google User",
        ...claims(),
      }),
      "signature",
    ].join(".");
    return new Response(
      JSON.stringify({
        access_token: "test-access-token",
        expires_in: 3599,
        token_type: "Bearer",
        scope: "openid email profile",
        id_token: idToken,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
}
