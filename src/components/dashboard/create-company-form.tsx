"use client";

import { useLocale, useTranslations } from "next-intl";
import { useActionState } from "react";
import { createCompanyAction } from "@/app/[locale]/(app)/account/actions";
import { Card, CardHeader } from "@/components/ui/card";
import { Alert, Button, Field } from "@/components/ui/form";

export function CreateCompanyForm() {
  const t = useTranslations("onboarding");
  const tErr = useTranslations("auth.errors");
  const locale = useLocale();
  const [state, action, pending] = useActionState(createCompanyAction, null);
  return (
    <Card>
      <CardHeader title={t("createCompanyTitle")} description={t("createCompanyBody")} />
      <form
        action={action}
        className="grid gap-4 sm:grid-cols-[1fr_12rem_auto] sm:items-end"
        data-testid="create-company"
      >
        <input type="hidden" name="locale" value={locale} />
        <Field label={t("companyName")} name="name" required maxLength={200} />
        <div className="space-y-1.5">
          <label htmlFor="country" className="block text-sm font-medium text-text">
            {t("country")}
          </label>
          <select
            id="country"
            name="country"
            className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2.5 text-sm text-text"
            defaultValue="LV"
          >
            {(["LV", "LT", "EE", "PL"] as const).map((c) => (
              <option key={c} value={c}>
                {t(`countries.${c}`)}
              </option>
            ))}
          </select>
        </div>
        <Button type="submit" disabled={pending}>
          {t("create")}
        </Button>
      </form>
      {state?.error ? (
        <div className="mt-3">
          <Alert tone="error">{tErr("generic")}</Alert>
        </div>
      ) : null}
    </Card>
  );
}
