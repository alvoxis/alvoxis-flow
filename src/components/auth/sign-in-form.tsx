"use client";

import { useLocale, useTranslations } from "next-intl";
import { type FormEvent, useState } from "react";
import { Alert, Button, Field } from "@/components/ui/form";
import { Link, useRouter } from "@/i18n/navigation";
import { authClient } from "@/lib/auth-client";
import { authErrorKey, type AuthErrorKey } from "./auth-errors";

export function SignInForm({
  googleEnabled,
  emailConfigured,
  next,
}: {
  googleEnabled: boolean;
  emailConfigured: boolean;
  next?: string;
}) {
  const t = useTranslations("auth");
  const locale = useLocale();
  const router = useRouter();
  const [error, setError] = useState<AuthErrorKey | null>(null);
  const [pending, setPending] = useState(false);
  const [email, setEmail] = useState("");
  const [resent, setResent] = useState(false);

  const target = next && next.startsWith("/") && !next.startsWith("//") ? next : "/";

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setPending(true);
    setError(null);
    const { data, error } = await authClient.signIn.email({
      email: String(form.get("email")),
      password: String(form.get("password")),
    });
    setPending(false);
    if (error) return setError(authErrorKey(error));
    if ((data as { twoFactorRedirect?: boolean } | null)?.twoFactorRedirect)
      return router.push("/two-factor");
    router.push(target);
    router.refresh();
  }

  async function resend() {
    await authClient.sendVerificationEmail({ email, callbackURL: `/${locale}/sign-in?verified=1` });
    setResent(true);
  }

  return (
    <>
      {error ? (
        <Alert tone="error">
          {t(`errors.${error}`, { min: 12 })}
          {error === "emailNotVerified" && emailConfigured && !resent ? (
            <button type="button" onClick={resend} className="mt-1 block font-medium underline">
              {t("signIn.resend")}
            </button>
          ) : null}
        </Alert>
      ) : null}
      {resent ? <Alert tone="info">{t("signIn.resent")}</Alert> : null}
      <form onSubmit={onSubmit} className="space-y-4" data-testid="sign-in-form">
        <Field
          label={t("email")}
          name="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Field
          label={t("password")}
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
        <div className="flex justify-end">
          <Link href="/forgot-password" className="text-sm text-violet-300 hover:text-violet-200">
            {t("signIn.forgot")}
          </Link>
        </div>
        <Button type="submit" disabled={pending} className="w-full">
          {t("signIn.submit")}
        </Button>
      </form>
      {googleEnabled ? (
        <>
          <div className="flex items-center gap-3 text-xs text-muted">
            <span className="h-px flex-1 bg-border" />
            {t("or")}
            <span className="h-px flex-1 bg-border" />
          </div>
          <Button
            type="button"
            variant="secondary"
            className="w-full"
            onClick={() =>
              authClient.signIn.social({
                provider: "google",
                callbackURL: `/${locale}${target === "/" ? "" : target}`,
                errorCallbackURL: `/${locale}/sign-in?error=oauth`,
              })
            }
          >
            {t("signIn.google")}
          </Button>
        </>
      ) : null}
      <p className="text-center text-sm text-muted">
        {t("signIn.noAccount")}{" "}
        <Link href="/sign-up" className="font-medium text-violet-300 hover:text-violet-200">
          {t("signIn.createAccount")}
        </Link>
      </p>
    </>
  );
}
