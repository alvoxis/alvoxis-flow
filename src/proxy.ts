import createMiddleware from "next-intl/middleware";
import { type NextRequest, NextResponse } from "next/server";
import { LOCALES } from "./i18n/config";
import { routing } from "./i18n/routing";

const intl = createMiddleware(routing);

/** Session cookie names of the auth library (plain and __Secure- prefixed on https). */
const SESSION_COOKIES = ["alvoxis.session_token", "__Secure-alvoxis.session_token"];
const HOME = new RegExp(`^/(${LOCALES.join("|")})/?$`);

/**
 * Locale negotiation (next-intl), plus one presentation choice: a visitor without a session
 * cookie who opens the home page `/{locale}` sees the public landing page (`/{locale}/welcome`)
 * instead of being sent to sign-in. This is not an authorization decision — every app page still
 * checks the session on the server, and a stale cookie simply leads to the sign-in page.
 */
export default function proxy(request: NextRequest) {
  const response = intl(request);
  const home = HOME.exec(request.nextUrl.pathname);
  if (!home || response.headers.has("location")) return response;
  if (SESSION_COOKIES.some((name) => request.cookies.has(name))) return response;
  const url = request.nextUrl.clone();
  url.pathname = `/${home[1]}/welcome`;
  const rewritten = NextResponse.rewrite(url);
  response.headers.forEach((value, key) => {
    if (key.startsWith("set-cookie") || key === "link") rewritten.headers.set(key, value);
  });
  return rewritten;
}

export const config = {
  // Everything except API routes, Next internals and files with an extension.
  matcher: "/((?!api|_next|_vercel|.*\\..*).*)",
};
