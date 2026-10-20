import { randomUUID } from "node:crypto";
import { parseServerEnv } from "@/config/env";
import { createAuth, type Auth } from "@/server/auth/auth";
import { type Database } from "@/server/db/client";
import { MemoryMailer } from "@/server/notifications/mailer";

export const TEST_APP_URL = "http://localhost:3000";

export const TEST_AUTH_SECRET = "integration-test-secret-not-for-production-0001";

export function createTestAuth(db: Database, overrides: Record<string, string | undefined> = {}) {
  const env = parseServerEnv({
    NODE_ENV: "test",
    DATABASE_URL: process.env.TEST_DATABASE_URL,
    APP_URL: TEST_APP_URL,
    // Fixture secret for the disposable test database only.
    BETTER_AUTH_SECRET: TEST_AUTH_SECRET,
    TRUSTED_IP_HEADER: "x-forwarded-for",
    ...overrides,
  });
  const mailer = new MemoryMailer();
  return { auth: createAuth({ db, env, mailer }), mailer, env };
}

/** A browser-like client: cookie jar, fixed IP and user agent, calls the real auth handler. */
export class AuthClient {
  readonly cookies = new Map<string, string>();
  readonly ip: string;
  constructor(
    private readonly auth: Auth,
    ip?: string,
    readonly userAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36",
    /** The site the browser is on (must match the auth instance's APP_URL). */
    readonly origin = TEST_APP_URL,
  ) {
    this.ip = ip ?? `10.${rand()}.${rand()}.${rand()}`;
  }

  headers(): Headers {
    const h = new Headers({
      origin: this.origin,
      "user-agent": this.userAgent,
      "x-forwarded-for": this.ip,
    });
    if (this.cookies.size)
      h.set("cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    return h;
  }

  async request(path: string, init: { method?: string; body?: unknown } = {}) {
    const headers = this.headers();
    if (init.body !== undefined) headers.set("content-type", "application/json");
    const res = await this.auth.handler(
      new Request(`${this.origin}/api/auth${path}`, {
        method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
        headers,
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        redirect: "manual",
      }),
    );
    for (const raw of res.headers.getSetCookie()) {
      const [pair] = raw.split(";");
      const idx = pair!.indexOf("=");
      const name = pair!.slice(0, idx);
      const value = pair!.slice(idx + 1);
      if (value === "" || /max-age=0/i.test(raw)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return {
      status: res.status,
      json: json as Record<string, unknown> | null,
      headers: res.headers,
    };
  }

  /** Opens a link from an email (e.g. verification) and follows nothing. */
  async openLink(url: string) {
    const u = new URL(url);
    return this.request(`${u.pathname.replace(/^\/api\/auth/, "")}${u.search}`);
  }

  get rawSetCookieNames() {
    return [...this.cookies.keys()];
  }
}

function rand() {
  return Math.floor(Math.random() * 250) + 1;
}

export function uniqueEmail(prefix = "user"): string {
  return `${prefix}-${randomUUID()}@example.test`;
}

export const STRONG_PASSWORD = "correct-horse-battery-staple-42";

/** Higher-level flows shared by the auth test files. */
export function authFlows(h: ReturnType<typeof createTestAuth>) {
  const linkFor = (to: string, kind: string) => {
    const msg = [...h.mailer.outbox].reverse().find((m) => m.to === to && m.kind === kind);
    return msg?.text.match(/https?:\/\/\S+/)?.[0] ?? null;
  };
  const registerAndVerify = async (email = uniqueEmail(), password = STRONG_PASSWORD) => {
    const c = new AuthClient(h.auth);
    await c.request("/sign-up/email", {
      body: { email, password, name: "Test User", locale: "lv" },
    });
    await c.openLink(linkFor(email, "verify")!);
    return { email, password };
  };
  const signedIn = async (email: string, password = STRONG_PASSWORD, ip?: string) => {
    const c = new AuthClient(h.auth, ip);
    const res = await c.request("/sign-in/email", { body: { email, password } });
    return { c, res };
  };
  return { linkFor, registerAndVerify, signedIn };
}
