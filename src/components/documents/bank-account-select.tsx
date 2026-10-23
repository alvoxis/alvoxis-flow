"use client";

import { useTranslations } from "next-intl";
import { useId } from "react";
import { accountName, type BankAccountItem } from "@/features/bank-accounts/model";
import { Link } from "@/i18n/navigation";

const selectClass =
  "w-full rounded-lg border border-border bg-surface-2 px-3 py-2.5 text-sm text-text focus:border-accent focus:outline-none disabled:opacity-60";

/**
 * Picks one of the company's active bank accounts for a document ("" = none). Only the id is
 * sent; the server copies the account's details into the document and freezes them on issue.
 * `extra` is an option for a value that is no longer offered (e.g. an archived account).
 */
export function BankAccountSelect({
  companyId,
  accounts,
  value,
  onChange,
  disabled,
  extra,
}: {
  companyId: string;
  accounts: readonly BankAccountItem[];
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
  extra?: { value: string; label: string };
}) {
  const t = useTranslations("bankAccounts");
  const id = useId();
  return (
    <div className="space-y-1.5 sm:col-span-2" data-testid="bank-account-picker">
      <label htmlFor={id} className="block text-sm font-medium text-text">
        {t("picker.label")}
      </label>
      <select
        id={id}
        name="bankAccountId"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className={selectClass}
      >
        <option value="">{t("picker.none")}</option>
        {extra ? (
          <option value={extra.value} disabled>
            {extra.label}
          </option>
        ) : null}
        {accounts.map((a) => (
          <option key={a.id} value={a.id}>
            {accountName(a)}
            {a.isDefault ? ` (${t("status.default")})` : ""}
          </option>
        ))}
      </select>
      <p className="text-xs text-muted">
        {accounts.length === 0 ? t("picker.empty") : t("picker.hint")}{" "}
        <Link href={`/companies/${companyId}/bank-accounts`} className="text-violet-300 underline">
          {t("picker.manage")}
        </Link>
      </p>
    </div>
  );
}
