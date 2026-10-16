"use client";

import { useTranslations } from "next-intl";
import { type FormEvent, useMemo, useState } from "react";
import { renderSVG } from "uqr";
import { Alert, Button, Field } from "@/components/ui/form";
import { useRouter } from "@/i18n/navigation";
import { authClient } from "@/lib/auth-client";
import { authErrorKey, type AuthErrorKey } from "./auth-errors";

export function TwoFactorChallengeForm() {
  const t = useTranslations("auth");
  const router = useRouter();
  const [mode, setMode] = useState<"totp" | "recovery">("totp");
  const [error, setError] = useState<AuthErrorKey | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const code = String(new FormData(e.currentTarget).get("code")).replace(/\s+/g, "");
    setPending(true);
    setError(null);
    const { error } =
      mode === "totp"
        ? await authClient.twoFactor.verifyTotp({ code })
        : await authClient.twoFactor.verifyBackupCode({ code });
    setPending(false);
    if (error) return setError(authErrorKey(error));
    router.push("/");
    router.refresh();
  }

  return (
    <>
      {mode === "recovery" ? (
        <p className="text-sm text-muted">{t("twoFactor.recoverySubtitle")}</p>
      ) : null}
      {error ? <Alert tone="error">{t(`errors.${error}`, { min: 12 })}</Alert> : null}
      <form onSubmit={onSubmit} className="space-y-4" data-testid="two-factor-form" key={mode}>
        {mode === "totp" ? (
          <Field
            label={t("twoFactor.code")}
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9 ]{6,7}"
            maxLength={7}
            required
            autoFocus
          />
        ) : (
          <Field
            label={t("twoFactor.recoveryCode")}
            name="code"
            autoComplete="off"
            maxLength={20}
            required
            autoFocus
          />
        )}
        <Button type="submit" disabled={pending} className="w-full">
          {t("twoFactor.submit")}
        </Button>
      </form>
      <button
        type="button"
        className="block w-full text-center text-sm font-medium text-violet-300"
        onClick={() => {
          setMode(mode === "totp" ? "recovery" : "totp");
          setError(null);
        }}
      >
        {mode === "totp" ? t("twoFactor.useRecovery") : t("twoFactor.useTotp")}
      </button>
      <p className="text-xs text-muted">{t("twoFactor.lostAccess")}</p>
    </>
  );
}

function RecoveryCodes({ codes }: { codes: string[] }) {
  const t = useTranslations("auth.setup");
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-3">
      <ul
        className="grid grid-cols-2 gap-2 rounded-lg border border-border bg-surface-2 p-3 font-mono text-sm text-text"
        data-testid="recovery-codes"
      >
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <Button
        type="button"
        variant="secondary"
        onClick={async () => {
          await navigator.clipboard?.writeText(codes.join("\n")).catch(() => undefined);
          setCopied(true);
        }}
      >
        {copied ? t("copied") : t("copy")}
      </Button>
    </div>
  );
}

export function TwoFactorSetup({ next }: { next: string }) {
  const t = useTranslations("auth");
  const router = useRouter();
  const [step, setStep] = useState<"password" | "scan" | "codes">("password");
  const [totpURI, setTotpURI] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[]>([]);
  const [error, setError] = useState<AuthErrorKey | null>(null);
  const [pending, setPending] = useState(false);

  const qr = useMemo(() => (totpURI ? renderSVG(totpURI, { border: 2 }) : null), [totpURI]);
  const secret = totpURI ? new URL(totpURI).searchParams.get("secret") : null;

  async function start(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(null);
    const { data, error } = await authClient.twoFactor.enable({
      password: String(new FormData(e.currentTarget).get("password")),
    });
    setPending(false);
    if (error || !data || data.method !== "totp") return setError(authErrorKey(error));
    setTotpURI(data.totpURI);
    setCodes(data.backupCodes);
    setStep("scan");
  }

  async function verify(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(null);
    const { error } = await authClient.twoFactor.verifyTotp({
      code: String(new FormData(e.currentTarget).get("code")).replace(/\s+/g, ""),
    });
    setPending(false);
    if (error) return setError(authErrorKey(error));
    setStep("codes");
  }

  return (
    <div className="space-y-5">
      {error ? <Alert tone="error">{t(`errors.${error}`, { min: 12 })}</Alert> : null}
      {step === "password" ? (
        <form onSubmit={start} className="space-y-4" data-testid="two-factor-setup-password">
          <h2 className="text-sm font-semibold text-text">{t("setup.step1")}</h2>
          <Field
            label={t("password")}
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
          <Button type="submit" disabled={pending}>
            {t("setup.start")}
          </Button>
        </form>
      ) : null}
      {step === "scan" && qr ? (
        <form onSubmit={verify} className="space-y-4" data-testid="two-factor-setup-verify">
          <h2 className="text-sm font-semibold text-text">{t("setup.step2")}</h2>
          <div
            role="img"
            aria-label={t("setup.qrAlt")}
            className="mx-auto w-48 rounded-lg bg-white p-2 [&_svg]:h-auto [&_svg]:w-full"
            // SVG generated locally by the QR library from the otpauth URI.
            dangerouslySetInnerHTML={{ __html: qr }}
          />
          <p className="text-xs text-muted">{t("setup.manual")}</p>
          <code
            className="block rounded-lg bg-surface-2 px-3 py-2 font-mono text-sm break-all text-text"
            data-testid="totp-secret"
          >
            {secret}
          </code>
          <h2 className="text-sm font-semibold text-text">{t("setup.step3")}</h2>
          <Field
            label={t("twoFactor.code")}
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9 ]{6,7}"
            maxLength={7}
            required
          />
          <Button type="submit" disabled={pending}>
            {t("setup.verify")}
          </Button>
        </form>
      ) : null}
      {step === "codes" ? (
        <div className="space-y-4">
          <h2 className="text-sm font-semibold text-text">{t("setup.recoveryTitle")}</h2>
          <Alert tone="warning">{t("setup.recoveryBody")}</Alert>
          <RecoveryCodes codes={codes} />
          <Button
            type="button"
            onClick={() => {
              router.push(next);
              router.refresh();
            }}
          >
            {t("setup.done")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export function TwoFactorSettings({
  enabled,
  requiredForRole,
}: {
  enabled: boolean;
  requiredForRole: boolean;
}) {
  const t = useTranslations("auth");
  const router = useRouter();
  const [error, setError] = useState<AuthErrorKey | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [pending, setPending] = useState(false);

  async function disable(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(null);
    const { error } = await authClient.twoFactor.disable({
      password: String(new FormData(e.currentTarget).get("password")),
    });
    setPending(false);
    if (error) return setError(authErrorKey(error));
    router.refresh();
  }

  async function regenerate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(null);
    const { data, error } = await authClient.twoFactor.generateBackupCodes({
      password: String(new FormData(e.currentTarget).get("password")),
    });
    setPending(false);
    if (error || !data) return setError(authErrorKey(error));
    setCodes(data.backupCodes);
  }

  if (!enabled) return null;
  return (
    <div className="space-y-5">
      {error ? <Alert tone="error">{t(`errors.${error}`, { min: 12 })}</Alert> : null}
      <form onSubmit={regenerate} className="space-y-3" data-testid="regenerate-codes">
        <p className="text-sm text-muted">{t("security.regenerateHelp")}</p>
        <Field
          label={t("password")}
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
        <Button type="submit" variant="secondary" disabled={pending}>
          {t("security.regenerate")}
        </Button>
      </form>
      {codes ? (
        <div className="space-y-2">
          <Alert tone="warning">{t("security.regenerated")}</Alert>
          <RecoveryCodes codes={codes} />
        </div>
      ) : null}
      {requiredForRole ? (
        <p className="text-sm text-muted">{t("security.requiredForRole")}</p>
      ) : (
        <form onSubmit={disable} className="space-y-3" data-testid="disable-two-factor">
          <p className="text-sm text-muted">{t("security.disableHelp")}</p>
          <Field
            label={t("password")}
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
          <Button type="submit" variant="danger" disabled={pending}>
            {t("security.disable")}
          </Button>
        </form>
      )}
    </div>
  );
}

export function ChangePasswordForm({ minPasswordLength }: { minPasswordLength: number }) {
  const t = useTranslations("auth");
  const router = useRouter();
  const [error, setError] = useState<AuthErrorKey | null>(null);
  const [done, setDone] = useState(false);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    setPending(true);
    setError(null);
    setDone(false);
    const { error } = await authClient.changePassword({
      currentPassword: String(data.get("currentPassword")),
      newPassword: String(data.get("newPassword")),
      revokeOtherSessions: true,
    });
    setPending(false);
    if (error) return setError(authErrorKey(error));
    form.reset();
    setDone(true);
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4" data-testid="change-password">
      {done ? <Alert tone="success">{t("security.passwordChanged")}</Alert> : null}
      {error ? (
        <Alert tone="error">{t(`errors.${error}`, { min: minPasswordLength })}</Alert>
      ) : null}
      <Field
        label={t("security.currentPassword")}
        name="currentPassword"
        type="password"
        autoComplete="current-password"
        required
      />
      <Field
        label={t("security.newPassword")}
        name="newPassword"
        type="password"
        autoComplete="new-password"
        required
        minLength={minPasswordLength}
        maxLength={128}
        hint={t("signUp.passwordHint", { min: minPasswordLength })}
      />
      <Button type="submit" disabled={pending}>
        {t("security.changePassword")}
      </Button>
    </form>
  );
}

export function SignOutButton({ className, label }: { className?: string; label: string }) {
  const router = useRouter();
  return (
    <Button
      type="button"
      variant="ghost"
      className={className}
      data-testid="sign-out"
      onClick={async () => {
        await authClient.signOut();
        router.push("/sign-in");
        router.refresh();
      }}
    >
      {label}
    </Button>
  );
}
