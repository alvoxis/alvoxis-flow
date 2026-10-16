import "server-only";
import { getServerEnv } from "@/config/env";
import { getDb } from "@/server/db/client";
import { createMailer, type Mailer } from "@/server/notifications/mailer";
import { type Auth, createAuth } from "./auth";

const globalForAuth = globalThis as unknown as { __alvoxisAuth?: Auth; __alvoxisMailer?: Mailer };

export function getMailer(): Mailer {
  globalForAuth.__alvoxisMailer ??= createMailer(getServerEnv());
  return globalForAuth.__alvoxisMailer;
}

/** Lazily created auth instance (env is validated on first use, not at build time). */
export function getAuth(): Auth {
  globalForAuth.__alvoxisAuth ??= createAuth({
    db: getDb(),
    env: getServerEnv(),
    mailer: getMailer(),
  });
  return globalForAuth.__alvoxisAuth;
}

export function isGoogleConfigured(): boolean {
  const env = getServerEnv();
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}
