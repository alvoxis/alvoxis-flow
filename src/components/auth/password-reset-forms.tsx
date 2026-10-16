"use client";

import { useLocale, useTranslations } from "next-intl";
import { type FormEvent, useState } from "react";
import { Alert, Button, Field } from "@/components/ui/form";
import { Link, useRouter } from "@/i18n/navigation";
import { authClient } from "@/lib/auth-client";
import { authErrorKey, type AuthErrorKey } from "./auth-errors";

export function ForgotPasswordForm({ emailConfigured }: { emailConfigured: boolean }) {
  const t = useTranslations("auth");
  const locale = useLocale();
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<AuthErrorKey | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(null);
    const { error } = await authClient.requestPasswordReset({
      email: String(new FormData(e.currentTarget).get("email")),
      redirectTo: `/${locale}/reset-password`,
    });
    setPending(false);
    if (error) return setError(authErrorKey(error));
    setSent(true);
  }

  return (
    <>
      {!emailConfigured ? <Alert tone="warning">{t("errors.emailNotConfigured")}</Alert> : null}
      {sent ? <Alert tone="success">{t("forgot.sent")}</Alert> : null}
      {error ? <Alert tone="error">{t(`errors.${error}`, { min: 12 })}</Alert> : null}
      {!sent ? (
        <form onSubmit={onSubmit} className="space-y-4" data-testid="forgot-form">
          <Field label={t("email")} name="email" type="email" autoComplete="email" required />
          <Button type="submit" disabled={pending} className="w-full">
            {t("forgot.submit")}
          </Button>
        </form>
      ) : null}
      <Link href="/sign-in" className="block text-center text-sm font-medium text-violet-300">
        {t("backToSignIn")}
      </Link>
    </>
  );
}

export function ResetPasswordForm({
  token,
  minPasswordLength,
}: {
  token: string | null;
  minPasswordLength: number;
}) {
  const t = useTranslations("auth");
  const router = useRouter();
  const [error, setError] = useState<AuthErrorKey | "mismatch" | null>(null);
  const [pending, setPending] = useState(false);

  if (!token) {
    return (
      <>
        <Alert tone="error">{t("reset.invalid")}</Alert>
        <Link
          href="/forgot-password"
          className="block text-center text-sm font-medium text-violet-300"
        >
          {t("reset.requestNew")}
        </Link>
      </>
    );
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const newPassword = String(form.get("password"));
    if (newPassword !== String(form.get("confirm"))) return setError("mismatch");
    setPending(true);
    setError(null);
    const { error } = await authClient.resetPassword({ newPassword, token: token! });
    setPending(false);
    if (error) return setError(authErrorKey(error));
    router.push("/sign-in?reset=1");
  }

  return (
    <>
      {error === "mismatch" ? <Alert tone="error">{t("reset.mismatch")}</Alert> : null}
      {error && error !== "mismatch" ? (
        <Alert tone="error">
          {error === "invalidToken"
            ? t("reset.invalid")
            : t(`errors.${error}`, { min: minPasswordLength })}
        </Alert>
      ) : null}
      <form onSubmit={onSubmit} className="space-y-4" data-testid="reset-form">
        <Field
          label={t("reset.newPassword")}
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={minPasswordLength}
          maxLength={128}
          hint={t("signUp.passwordHint", { min: minPasswordLength })}
        />
        <Field
          label={t("reset.confirm")}
          name="confirm"
          type="password"
          autoComplete="new-password"
          required
          minLength={minPasswordLength}
          maxLength={128}
        />
        <Button type="submit" disabled={pending} className="w-full">
          {t("reset.submit")}
        </Button>
      </form>
    </>
  );
}
