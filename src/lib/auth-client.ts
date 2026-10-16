"use client";

import { twoFactorClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

/** Browser client for the auth endpoints under /api/auth (same origin; cookies are HttpOnly). */
export const authClient = createAuthClient({
  basePath: "/api/auth",
  plugins: [twoFactorClient()],
});
