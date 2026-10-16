"use client";

import { useLocale, useTranslations } from "next-intl";
import { useActionState } from "react";
import {
  type CompanyProfileFormState,
  saveCompanyProfileAction,
} from "@/app/[locale]/(app)/companies/[companyId]/profile/actions";
import { Alert, Button, Field } from "@/components/ui/form";
import { Link } from "@/i18n/navigation";

export interface CompanyProfileFormProps {
  companyId: string;
  canEdit: boolean;
  countryName: string;
  country: string;
  values: Record<TextField, string | null>;
}

type TextField =
  | "name"
  | "legalName"
  | "registrationNumber"
  | "vatNumber"
  | "addressLine1"
  | "addressLine2"
  | "postalCode"
  | "city";

const MAX_LENGTH: Record<TextField, number> = {
  name: 200,
  legalName: 300,
  registrationNumber: 32,
  vatNumber: 20,
  addressLine1: 200,
  addressLine2: 200,
  postalCode: 16,
  city: 100,
};

export function CompanyProfileForm({
  companyId,
  canEdit,
  countryName,
  country,
  values,
}: CompanyProfileFormProps) {
  const t = useTranslations("company");
  const locale = useLocale();
  const [state, action, pending] = useActionState<CompanyProfileFormState, FormData>(
    saveCompanyProfileAction,
    null,
  );
  const invalid = new Set(state?.status === "invalid" ? state.fields : []);

  const field = (name: TextField, hint?: string) => (
    <Field
      label={t(name)}
      name={name}
      defaultValue={values[name] ?? ""}
      maxLength={MAX_LENGTH[name]}
      required={name === "name"}
      readOnly={!canEdit}
      aria-invalid={invalid.has(name) || undefined}
      hint={invalid.has(name) ? t(`fieldError.${name}`) : hint}
      className={invalid.has(name) ? "border-red-500" : undefined}
    />
  );

  return (
    <form action={action} className="space-y-6" data-testid="company-profile-form">
      <input type="hidden" name="companyId" value={companyId} />
      <input type="hidden" name="locale" value={locale} />
      {!canEdit ? <Alert tone="info">{t("readOnly")}</Alert> : null}

      <div className="grid gap-4 sm:grid-cols-2">
        {field("name")}
        {field("legalName")}
        <div className="space-y-1.5">
          <span className="block text-sm font-medium text-text">{t("country")}</span>
          <p
            className="rounded-lg border border-border bg-surface px-3 py-2.5 text-sm text-text"
            data-testid="company-country"
          >
            {countryName}
          </p>
          <p className="text-xs text-muted">{t("countryHint")}</p>
        </div>
        {field("registrationNumber")}
        {field("vatNumber", t("vatNumberHint", { prefix: country }))}
      </div>

      <fieldset className="space-y-4">
        <legend className="mb-2 text-sm font-semibold text-text">{t("address")}</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          {field("addressLine1")}
          {field("addressLine2")}
          {field("postalCode")}
          {field("city")}
        </div>
      </fieldset>

      {state?.status === "saved" ? <Alert tone="success">{t("saved")}</Alert> : null}
      {state?.status === "invalid" ? <Alert tone="error">{t("invalid")}</Alert> : null}
      {state?.status === "forbidden" ? <Alert tone="error">{t("forbidden")}</Alert> : null}
      {state?.status === "error" ? <Alert tone="error">{t("error")}</Alert> : null}
      {state?.status === "two_factor_required" ? (
        <Alert tone="error">
          {t("twoFactorRequired")} <Link href="/account/two-factor">{t("setUpTwoFactor")}</Link>
        </Alert>
      ) : null}

      {canEdit ? (
        <Button type="submit" disabled={pending}>
          {t("save")}
        </Button>
      ) : null}
    </form>
  );
}
