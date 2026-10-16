"use client";

import { useLocale, useTranslations } from "next-intl";
import { type FormEvent, useState } from "react";
import { Alert, Button, Field } from "@/components/ui/form";
import { Link } from "@/i18n/navigation";
import { authClient } from "@/lib/auth-client";
import { authErrorKey, type AuthErrorKey } from "./auth-errors";

export function SignUpForm({
  minPasswordLength,
  emailConfigured,
}: {
  minPasswordLength: number;
  emailConfigured: boolean;
}) {
  const t = useTranslations("auth");
  const locale = useLocale();
  const [error, setError] = useState<AuthErrorKey | null>(null);
  const [pending, setPending] = useState(false);
  const [submittedEmail, setSubmittedEmail] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const email = String(form.get("email"));
    setPending(true);
    setError(null);
    const { error } = await authClient.signUp.email({
      email,
      password: String(form.get("password")),
      name: String(form.get("name")),
      locale,
      callbackURL: `/${locale}/sign-in?verified=1`,
    } as Parameters<typeof authClient.signUp.email>[0]);
    setPending(false);
    if (error) return setError(authErrorKey(error));
    setSubmittedEmail(email);
  }

  if (submittedEmail) {
    return (
      <div className="space-y-4" data-testid="check-email">
        <h2 className="text-lg font-semibold text-text">{t("checkEmail.title")}</h2>
        <Alert tone="success">{t("checkEmail.body", { email: submittedEmail })}</Alert>
        <Link href="/sign-in" className="block text-center text-sm font-medium text-violet-300">
          {t("backToSignIn")}
        </Link>
      </div>
    );
  }

  return (
    <>
      {!emailConfigured ? <Alert tone="warning">{t("errors.emailNotConfigured")}</Alert> : null}
      {error ? (
        <Alert tone="error">{t(`errors.${error}`, { min: minPasswordLength })}</Alert>
      ) : null}
      <form onSubmit={onSubmit} className="space-y-4" data-testid="sign-up-form">
        <Field label={t("name")} name="name" autoComplete="name" required maxLength={200} />
        <Field label={t("email")} name="email" type="email" autoComplete="email" required />
        <Field
          label={t("password")}
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={minPasswordLength}
          maxLength={128}
          hint={t("signUp.passwordHint", { min: minPasswordLength })}
        />
        <Button type="submit" disabled={pending} className="w-full">
          {t("signUp.submit")}
        </Button>
      </form>
      <p className="text-center text-sm text-muted">
        {t("signUp.haveAccount")}{" "}
        <Link href="/sign-in" className="font-medium text-violet-300 hover:text-violet-200">
          {t("signUp.signIn")}
        </Link>
      </p>
    </>
  );
}
