import "server-only";
import { createTranslator } from "next-intl";
import { CATALOGS } from "@/i18n/catalogs";
import { type AppLocale, LOCALES } from "@/i18n/config";
import { type EmailMessage } from "./mailer";

export type AuthEmailKind =
  | "verify"
  | "reset"
  | "existingAccount"
  | "newSignIn"
  | "passwordChanged"
  | "twoFactorEnabled"
  | "twoFactorDisabled"
  | "signInLocked";

export function asLocale(value: unknown): AppLocale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value)
    ? (value as AppLocale)
    : "en";
}

/** Builds a plain-text, localized security email. Values are inserted as plain text. */
export function authEmail(
  kind: AuthEmailKind,
  to: string,
  locale: AppLocale,
  values: { name?: string | null; link?: string; time?: string; device?: string },
): EmailMessage {
  const t = createTranslator({ locale, messages: CATALOGS[locale], namespace: "email" });
  const params = {
    link: values.link ?? "",
    time: values.time ?? new Date().toISOString().replace("T", " ").slice(0, 16),
    device: values.device ?? t("unknownDevice"),
  };
  const greeting = t("greeting", { name: values.name?.trim() || to });
  return {
    kind,
    to,
    subject: `ALVOXIS Flow: ${t(`${kind}.subject`)}`,
    text: `${greeting}\n\n${t(`${kind}.body`, params)}\n\n—\n${t("footer")}\n`,
  };
}
