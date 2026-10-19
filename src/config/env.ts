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
  /** Set by Vercel: "production", "preview" or "development" (read-only platform signals). */
  VERCEL_ENV: optionalNonEmpty,
  /** Set by Vercel: host of the branch alias, of this deployment and of the production domain. */
  VERCEL_BRANCH_URL: optionalNonEmpty,
  VERCEL_URL: optionalNonEmpty,
  VERCEL_PROJECT_PRODUCTION_URL: optionalNonEmpty,
  /**
   * Preview deployments only (required there): the host of the separate TEST database, e.g. the
   * Neon endpoint host. DATABASE_URL must point to exactly this host, so a production connection
   * string copied into Preview by mistake is refused instead of used. Not a secret.
   */
  PREVIEW_DATABASE_HOST: optionalNonEmpty,

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

/**
 * SMTP hosts a preview deployment may use: sandboxes that catch every message and deliver
 * nothing to the recipients, so testing can never email real people.
 */
export const PREVIEW_SMTP_SANDBOX_HOSTS: readonly string[] = ["sandbox.smtp.mailtrap.io"];

/** Host of a postgres:// URL in lower case, or undefined when it cannot be parsed. */
function databaseHost(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}

/** A Neon endpoint's pooled and direct hosts differ only by "-pooler" in the first label. */
function sameDatabaseEndpoint(a: string, b: string): boolean {
  const normalize = (host: string) =>
    host
      .trim()
      .toLowerCase()
      .replace(/^([^.]+)-pooler\./, "$1.");
  return normalize(a) === normalize(b);
}

/** Host part of an origin or a bare host name (Vercel's VERCEL_* URLs carry no scheme). */
function hostOf(value: string): string {
  try {
    return new URL(value.includes("://") ? value : `https://${value}`).host.toLowerCase();
  } catch {
    return value.toLowerCase();
  }
}

/**
 * The public origin: APP_URL, or on a Vercel preview without APP_URL the branch alias Vercel
 * assigns (https://<project>-git-<branch>-<team>.vercel.app), never the production domain.
 */
function effectiveAppUrl(env: z.infer<typeof baseSchema>): string | undefined {
  if (env.APP_URL) return env.APP_URL;
  if (env.VERCEL_ENV === "preview" && env.VERCEL_BRANCH_URL)
    return `https://${hostOf(env.VERCEL_BRANCH_URL)}`;
  return undefined;
}

export const serverEnvSchema = baseSchema
  .superRefine((env, ctx) => {
    if (env.VERCEL === "1" && !effectiveAppUrl(env)) {
      // The localhost default would silently become the auth base URL, the only trusted origin
      // and the host of every email link, so sign-in on the deployment could never work.
      ctx.addIssue({
        code: "custom",
        path: ["APP_URL"],
        message: "APP_URL is required on Vercel (the deployment's public https:// origin)",
      });
    }
    const appUrl = effectiveAppUrl(env) ?? DEFAULT_APP_URL;
    if (env.VERCEL_ENV === "preview") checkPreview(env, appUrl, ctx);
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
  .transform((env) => ({ ...env, APP_URL: effectiveAppUrl(env) ?? DEFAULT_APP_URL }));

/**
 * Extra rules for Vercel preview deployments, the test environment: the database must be the
 * declared test database, the public URL must be this preview (never the production domain) and
 * email may only go to a sandbox. Messages name variables, never their values.
 */
function checkPreview(env: z.infer<typeof baseSchema>, appUrl: string, ctx: z.RefinementCtx) {
  const dbHost = databaseHost(env.DATABASE_URL);
  if (!env.PREVIEW_DATABASE_HOST) {
    ctx.addIssue({
      code: "custom",
      path: ["PREVIEW_DATABASE_HOST"],
      message:
        "PREVIEW_DATABASE_HOST is required on preview deployments (the host of the separate test database)",
    });
  } else if (!dbHost || !sameDatabaseEndpoint(dbHost, env.PREVIEW_DATABASE_HOST)) {
    ctx.addIssue({
      code: "custom",
      path: ["DATABASE_URL"],
      message:
        "On preview deployments DATABASE_URL must point to the test database host given in PREVIEW_DATABASE_HOST",
    });
  }
  const appHost = hostOf(appUrl);
  if (env.VERCEL_PROJECT_PRODUCTION_URL && appHost === hostOf(env.VERCEL_PROJECT_PRODUCTION_URL)) {
    ctx.addIssue({
      code: "custom",
      path: ["APP_URL"],
      message: "On preview deployments APP_URL must not be the production domain",
    });
  } else {
    const ownHosts = [env.VERCEL_BRANCH_URL, env.VERCEL_URL].filter(Boolean).map((h) => hostOf(h!));
    if (ownHosts.length > 0 && !ownHosts.includes(appHost)) {
      ctx.addIssue({
        code: "custom",
        path: ["APP_URL"],
        message:
          "On preview deployments APP_URL must be this preview's own URL (leave it unset to use the branch URL)",
      });
    }
  }
  if (
    env.EMAIL_TRANSPORT === "smtp" &&
    env.SMTP_HOST &&
    !PREVIEW_SMTP_SANDBOX_HOSTS.includes(env.SMTP_HOST.trim().toLowerCase())
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["SMTP_HOST"],
      message: `On preview deployments SMTP_HOST must be an email sandbox host (${PREVIEW_SMTP_SANDBOX_HOSTS.join(", ")})`,
    });
  }
}

export type ServerEnv = z.infer<typeof serverEnvSchema>;

export class EnvValidationError extends Error {
  /** Names of the invalid or missing variables (never their values), sorted and deduplicated. */
  readonly variables: string[];
  constructor(
    public readonly issues: string[],
    variables: string[] = [],
  ) {
    super(`Invalid server environment:\n  - ${issues.join("\n  - ")}`);
    this.name = "EnvValidationError";
    this.variables = [...new Set(variables)].sort();
  }
}

export function parseServerEnv(source: Record<string, string | undefined>): ServerEnv {
  const result = serverEnvSchema.safeParse(source);
  if (!result.success) {
    throw new EnvValidationError(
      result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
      result.error.issues.map((i) => String(i.path[0] ?? "(root)")),
    );
  }
  return result.data;
}

let cached: ServerEnv | undefined;

export function getServerEnv(): ServerEnv {
  cached ??= parseServerEnv(process.env);
  return cached;
}
