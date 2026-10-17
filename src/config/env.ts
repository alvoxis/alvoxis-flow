import { z } from "zod";

/**
 * Server-side environment schema. Values are validated lazily on first access so that
 * `next build` does not require runtime secrets, but any server code that needs the
 * environment fails fast with a clear message instead of running misconfigured.
 *
 * Never import this module from client components: it may expose secrets.
 */
const optionalNonEmpty = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== "" ? v : undefined));

const baseSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z
    .string()
    .min(1, "DATABASE_URL is required")
    .refine((v) => /^postgres(ql)?:\/\//.test(v), "DATABASE_URL must be a postgres:// URL"),
  /** Public origin; defaults to the local dev server, but must be set explicitly on Vercel. */
  APP_URL: z.url().optional(),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug"]).default("info"),
  /** Set to "1" by Vercel on its build and runtime machines (read-only platform signal). */
  VERCEL: optionalNonEmpty,

  /** Signs/encrypts session cookies, 2FA secrets and backup codes. ≥ 32 random characters. */
  BETTER_AUTH_SECRET: z.string().min(32, "BETTER_AUTH_SECRET must be at least 32 characters"),
  /**
   * Optional key rotation: "<version>:<secret>,…", newest first (e.g. "2:new…,1:old…"). New data
   * is encrypted with the first entry; older entries stay readable. BETTER_AUTH_SECRET is still
   * used to read data written before rotation was enabled. See docs/auth/AUTHENTICATION.md.
   */
  BETTER_AUTH_SECRETS: optionalNonEmpty.transform((v, ctx) => {
    if (!v) return undefined;
    const entries = v.split(",").map((raw) => {
      const entry = raw.trim();
      const idx = entry.indexOf(":");
      const version = Number(entry.slice(0, idx));
      const value = entry.slice(idx + 1).trim();
      return { version, value, ok: idx > 0 && Number.isInteger(version) && version >= 0 };
    });
    const versions = new Set(entries.map((e) => e.version));
    if (entries.some((e) => !e.ok) || versions.size !== entries.length) {
      ctx.addIssue({
        code: "custom",
        message: 'BETTER_AUTH_SECRETS must be "<version>:<secret>" entries with unique versions',
      });
      return z.NEVER;
    }
    if (entries.some((e) => e.value.length < 32)) {
      ctx.addIssue({
        code: "custom",
        message: "Every BETTER_AUTH_SECRETS entry needs ≥ 32 characters",
      });
      return z.NEVER;
    }
    return entries.map(({ version, value }) => ({ version, value }));
  }),

  /** Google OAuth (optional). Both values must be set together; never exposed to the browser. */
  GOOGLE_CLIENT_ID: optionalNonEmpty,
  GOOGLE_CLIENT_SECRET: optionalNonEmpty,

  /**
   * Email delivery. "disabled" means emails are NOT sent and the UI says so; "file" writes
   * messages to EMAIL_FILE_DIR for local development and tests only; "smtp" sends via SMTP.
   */
  EMAIL_TRANSPORT: z.enum(["disabled", "file", "smtp"]).default("disabled"),
  EMAIL_FROM: optionalNonEmpty,
  EMAIL_FILE_DIR: z.string().default("tmp/mail"),
  SMTP_HOST: optionalNonEmpty,
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: z.enum(["true", "false"]).default("false"),
  SMTP_USER: optionalNonEmpty,
  SMTP_PASSWORD: optionalNonEmpty,

  /**
   * Header that carries the client IP when running behind a trusted reverse proxy. Used for
   * rate limiting and the session device list. Leave unset when not behind a proxy.
   */
  TRUSTED_IP_HEADER: optionalNonEmpty,
  /**
   * Comma-separated IPs/CIDR ranges of your reverse proxies. When set, a multi-hop
   * TRUSTED_IP_HEADER (e.g. x-forwarded-for "client, proxy") is read from the right, skipping these
   * hops, so a client-supplied left-most value is ignored. Unset: only single-value headers count.
   */
  TRUSTED_PROXIES: optionalNonEmpty.transform((v, ctx) => {
    if (!v) return undefined;
    const list = v
      .split(",")
      .map((e) => e.trim())
      .filter(Boolean);
    const cidr = /^(\d{1,3}(\.\d{1,3}){3}|[0-9a-fA-F:]+)(\/\d{1,3})?$/;
    if (list.length === 0 || list.some((e) => !cidr.test(e))) {
      ctx.addIssue({
        code: "custom",
        message: "TRUSTED_PROXIES must be IP addresses or CIDR ranges",
      });
      return z.NEVER;
    }
    return list;
  }),
});

/** True for http(s)://localhost / 127.0.0.1 — local runs and CI of a production build, never a real deployment. */
export function isLocalhostUrl(url: string): boolean {
  try {
    return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

const DEFAULT_APP_URL = "http://localhost:3000";

export const serverEnvSchema = baseSchema
  .superRefine((env, ctx) => {
    if (env.VERCEL === "1" && !env.APP_URL) {
      // The localhost default would silently become the auth base URL, the only trusted origin
      // and the host of every email link, so sign-in on the deployment could never work.
      ctx.addIssue({
        code: "custom",
        path: ["APP_URL"],
        message: "APP_URL is required on Vercel (the deployment's public https:// origin)",
      });
    }
    const appUrl = env.APP_URL ?? DEFAULT_APP_URL;
    const realDeployment = env.NODE_ENV === "production" && !isLocalhostUrl(appUrl);
    if (Boolean(env.GOOGLE_CLIENT_ID) !== Boolean(env.GOOGLE_CLIENT_SECRET)) {
      ctx.addIssue({
        code: "custom",
        path: ["GOOGLE_CLIENT_ID"],
        message: "Set both GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, or neither",
      });
    }
    if (env.EMAIL_TRANSPORT === "file" && realDeployment) {
      ctx.addIssue({
        code: "custom",
        path: ["EMAIL_TRANSPORT"],
        message: "The file transport is for development and tests only",
      });
    }
    if (env.EMAIL_TRANSPORT === "smtp") {
      for (const key of ["SMTP_HOST", "EMAIL_FROM"] as const) {
        if (!env[key])
          ctx.addIssue({
            code: "custom",
            path: [key],
            message: `${key} is required when EMAIL_TRANSPORT=smtp`,
          });
      }
    }
    if (env.EMAIL_TRANSPORT !== "disabled" && !env.EMAIL_FROM && env.EMAIL_TRANSPORT !== "file") {
      ctx.addIssue({
        code: "custom",
        path: ["EMAIL_FROM"],
        message: "EMAIL_FROM is required to send email",
      });
    }
    if (realDeployment && !env.TRUSTED_IP_HEADER) {
      // Without a client IP the auth rate limiter uses one bucket shared by every visitor, so a
      // single attacker could exhaust the sign-in limit for everyone.
      ctx.addIssue({
        code: "custom",
        path: ["TRUSTED_IP_HEADER"],
        message:
          "TRUSTED_IP_HEADER is required in production so rate limits apply per client (e.g. x-forwarded-for behind your proxy)",
      });
    }
    if (realDeployment && !appUrl.startsWith("https://")) {
      ctx.addIssue({
        code: "custom",
        path: ["APP_URL"],
        message: "APP_URL must use https in production",
      });
    }
  })
  .transform((env) => ({ ...env, APP_URL: env.APP_URL ?? DEFAULT_APP_URL }));

export type ServerEnv = z.infer<typeof serverEnvSchema>;

export class EnvValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid server environment:\n  - ${issues.join("\n  - ")}`);
    this.name = "EnvValidationError";
  }
}

export function parseServerEnv(source: Record<string, string | undefined>): ServerEnv {
  const result = serverEnvSchema.safeParse(source);
  if (!result.success) {
    throw new EnvValidationError(
      result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    );
  }
  return result.data;
}

let cached: ServerEnv | undefined;

export function getServerEnv(): ServerEnv {
  cached ??= parseServerEnv(process.env);
  return cached;
}
