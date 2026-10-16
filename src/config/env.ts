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
  APP_URL: z.url().default("http://localhost:3000"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug"]).default("info"),

  /** Signs/encrypts session cookies, 2FA secrets and backup codes. ≥ 32 random characters. */
  BETTER_AUTH_SECRET: z.string().min(32, "BETTER_AUTH_SECRET must be at least 32 characters"),

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
});

export const serverEnvSchema = baseSchema.superRefine((env, ctx) => {
  if (Boolean(env.GOOGLE_CLIENT_ID) !== Boolean(env.GOOGLE_CLIENT_SECRET)) {
    ctx.addIssue({
      code: "custom",
      path: ["GOOGLE_CLIENT_ID"],
      message: "Set both GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, or neither",
    });
  }
  if (env.EMAIL_TRANSPORT === "file" && env.NODE_ENV === "production") {
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
  if (env.NODE_ENV === "production" && !env.APP_URL.startsWith("https://")) {
    ctx.addIssue({
      code: "custom",
      path: ["APP_URL"],
      message: "APP_URL must use https in production",
    });
  }
});

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
