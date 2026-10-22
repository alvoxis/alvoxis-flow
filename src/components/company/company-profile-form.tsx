"use client";

import { useLocale, useTranslations } from "next-intl";
import { useActionState, useState } from "react";
import {
  type CompanyProfileFormState,
  saveCompanyProfileAction,
} from "@/app/[locale]/(app)/companies/[companyId]/profile/actions";
import { Alert, Button, Field } from "@/components/ui/form";
import { Link } from "@/i18n/navigation";
import {
  DEFAULT_PDF_ACCENT,
  PDF_ACCENT_COLORS,
  PDF_ACCENTS,
  type PdfAccent,
} from "@/lib/pdf-accent";

export interface CompanyProfileFormProps {
  companyId: string;
  canEdit: boolean;
  countryName: string;
  country: string;
  values: Record<TextField, string | null>;
  /** Accent colour of the company's document PDFs. */
  pdfAccent: PdfAccent;
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
  pdfAccent,
}: CompanyProfileFormProps) {
  const t = useTranslations("company");
  const [accent, setAccent] = useState<PdfAccent>(pdfAccent ?? DEFAULT_PDF_ACCENT);
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

      <fieldset className="space-y-3" data-testid="pdf-accent">
        <legend className="mb-1 text-sm font-semibold text-text">{t("pdfAccent.legend")}</legend>
        <p className="text-xs text-muted">{t("pdfAccent.hint")}</p>
        <div className="grid gap-4 md:grid-cols-[1fr_15rem] md:items-start">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {PDF_ACCENTS.map((option) => (
              <label
                key={option}
                className="flex min-h-11 cursor-pointer items-center gap-2.5 rounded-lg border border-border bg-surface-2/60 px-3 py-2 text-sm text-text has-checked:border-accent has-disabled:cursor-default"
              >
                <input
                  type="radio"
                  name="pdfAccent"
                  value={option}
                  checked={accent === option}
                  disabled={!canEdit}
                  onChange={() => setAccent(option)}
                  className="accent-violet-500"
                />
                <svg aria-hidden="true" viewBox="0 0 16 16" className="h-4 w-4 shrink-0">
                  <circle
                    cx="8"
                    cy="8"
                    r="7"
                    fill={PDF_ACCENT_COLORS[option].accent}
                    stroke="#ffffff"
                    strokeWidth="1"
                  />
                </svg>
                <span>
                  {t(`pdfAccent.options.${option}`)}
                  {option === DEFAULT_PDF_ACCENT ? (
                    <span className="block text-xs text-muted">{t("pdfAccent.default")}</span>
                  ) : null}
                </span>
              </label>
            ))}
          </div>
          <AccentPreview accent={accent} />
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

/**
 * A miniature invoice page showing where the accent appears in the PDF: the title, the thin rule
 * under the header and the table head, the due-date block and the total. The page stays white
 * and the body text dark, as in the real PDF. Colours are SVG attributes (no inline styles).
 */
function AccentPreview({ accent }: { accent: PdfAccent }) {
  const t = useTranslations("company");
  const tPdf = useTranslations("documentPdf");
  const { accent: color, tint } = PDF_ACCENT_COLORS[accent];
  const text = "#1f2328";
  const rule = "#d9dce1";
  return (
    <figure className="space-y-1.5">
      <svg
        role="img"
        aria-label={t("pdfAccent.previewLabel", { colour: t(`pdfAccent.options.${accent}`) })}
        viewBox="0 0 210 150"
        className="w-full rounded-md border border-border"
        data-testid="pdf-accent-preview"
        data-accent={accent}
      >
        <rect width="210" height="150" fill="#ffffff" />
        <rect x="14" y="14" width="60" height="7" rx="1" fill={text} />
        <rect x="14" y="25" width="44" height="3" rx="1" fill={rule} />
        <text x="196" y="22" textAnchor="end" fontSize="11" fontWeight="700" fill={color}>
          {tPdf("title.invoice")}
        </text>
        <rect x="14" y="36" width="182" height="1.2" fill={color} />
        <rect x="120" y="44" width="76" height="22" rx="1.5" fill={tint} stroke={color} />
        <text x="126" y="53" fontSize="5.5" fill={color}>
          {tPdf("dueDate")}
        </text>
        <rect x="126" y="57" width="34" height="4" rx="1" fill={color} />
        <rect x="14" y="46" width="70" height="3" rx="1" fill={text} />
        <rect x="14" y="52" width="52" height="3" rx="1" fill={rule} />
        <rect x="14" y="58" width="58" height="3" rx="1" fill={rule} />
        <rect x="14" y="78" width="182" height="0.8" fill={color} />
        {[86, 94, 102].map((y) => (
          <g key={y}>
            <rect x="14" y={y} width="96" height="3" rx="1" fill={rule} />
            <rect x="170" y={y} width="26" height="3" rx="1" fill={rule} />
            <rect x="14" y={y + 5} width="182" height="0.4" fill={rule} />
          </g>
        ))}
        <text x="120" y="126" fontSize="7" fontWeight="700" fill={color}>
          {tPdf("grossTotal")}
        </text>
        <rect x="166" y="120" width="30" height="6" rx="1" fill={color} />
        <rect x="120" y="130" width="76" height="0.8" fill={color} />
        <rect x="120" y="132" width="76" height="0.8" fill={color} />
      </svg>
      <figcaption className="text-xs text-muted">{t("pdfAccent.previewCaption")}</figcaption>
    </figure>
  );
}
