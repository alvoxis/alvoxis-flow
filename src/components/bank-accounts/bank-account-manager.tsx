"use client";

import { useTranslations } from "next-intl";
import { type ReactNode, useId, useState } from "react";
import { IssueList } from "@/components/documents/issue-list";
import { Badge } from "@/components/ui/badge";
import { Alert, Button, Field } from "@/components/ui/form";
import {
  type BankAccountDraft,
  type BankAccountItem,
  type BankAccountOutcome,
  EMPTY_BANK_ACCOUNT,
  fieldOfIssue,
  formatIban,
  interpretBankAccountResponse,
  toCreateBankAccountBody,
} from "@/features/bank-accounts/model";
import { type ApiIssue } from "@/features/documents/editor-model";
import { Link, useRouter } from "@/i18n/navigation";

export interface BankAccountManagerProps {
  companyId: string;
  accounts: BankAccountItem[];
  /** company.manage — only decides which controls are shown; the API enforces it. */
  canManage: boolean;
}

type Done = "created" | "saved" | "archived" | "restored" | "defaultSet";
type Notice = { kind: Done | "invalid" } | Exclude<BankAccountOutcome, { kind: "ok" | "invalid" }>;

async function send(url: string, method: string, body: unknown): Promise<BankAccountOutcome> {
  try {
    const res = await fetch(url, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return interpretBankAccountResponse(res.status, await res.json().catch(() => null));
  } catch {
    return { kind: "error" };
  }
}

/** Default first, then active before archived; stable by IBAN otherwise. */
const order = (a: BankAccountItem, b: BankAccountItem) =>
  Number(b.isDefault) - Number(a.isDefault) ||
  Number(a.archived) - Number(b.archived) ||
  a.iban.localeCompare(b.iban);

/**
 * Company bank accounts over the API (POST to add, PATCH to edit, archive/restore or make
 * default). The IBAN of an account never changes; issued documents keep the details they were
 * issued with. A table on wide screens, cards on phones (one list, two layouts).
 */
export function BankAccountManager({ companyId, accounts, canManage }: BankAccountManagerProps) {
  const t = useTranslations("bankAccounts");
  const router = useRouter();
  const [items, setItems] = useState(() => [...accounts].sort(order));
  const [notice, setNotice] = useState<Notice | null>(null);
  const url = `/api/companies/${companyId}/bank-accounts`;

  // A new default clears the flag on the others (the server does the same).
  const replace = (item: BankAccountItem) =>
    setItems((list) =>
      [
        ...list
          .filter((a) => a.id !== item.id)
          .map((a) => (item.isDefault && a.isDefault ? { ...a, isDefault: false } : a)),
        item,
      ].sort(order),
    );

  return (
    <div className="space-y-6" data-testid="bank-account-manager">
      <Alert tone="info">{t("snapshotHint")}</Alert>
      {!canManage ? <Alert tone="info">{t("readOnly")}</Alert> : null}
      {canManage ? (
        <CreateForm
          url={url}
          onCreated={(item) => {
            replace(item);
            setNotice({ kind: "created" });
          }}
          onNotice={setNotice}
        />
      ) : null}
      <NoticeAlert notice={notice} onReload={() => router.refresh()} />

      {items.length === 0 ? (
        <p className="text-sm text-muted" data-testid="bank-accounts-empty">
          {t("empty")}
        </p>
      ) : (
        <div>
          <div className="hidden grid-cols-[1.5fr_2fr_1fr_1fr_auto] gap-3 border-b border-border px-2 pb-2 text-xs font-medium tracking-wide text-muted uppercase md:grid">
            <span>{t("colName")}</span>
            <span>{t("colIban")}</span>
            <span>{t("colBic")}</span>
            <span>{t("colStatus")}</span>
            <span className="sr-only">{t("colActions")}</span>
          </div>
          <ul
            className="space-y-3 md:space-y-0 md:divide-y md:divide-border"
            data-testid="bank-account-list"
          >
            {items.map((item) => (
              <AccountRow
                key={`${item.id}-${item.version}`}
                url={`${url}/${item.id}`}
                item={item}
                canManage={canManage}
                onChanged={(next, kind) => {
                  replace(next);
                  setNotice({ kind });
                }}
                onNotice={setNotice}
              />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function CreateForm({
  url,
  onCreated,
  onNotice,
}: {
  url: string;
  onCreated: (item: BankAccountItem) => void;
  onNotice: (n: Notice | null) => void;
}) {
  const t = useTranslations("bankAccounts");
  const [draft, setDraft] = useState<BankAccountDraft>(EMPTY_BANK_ACCOUNT);
  const [issues, setIssues] = useState<ApiIssue[]>([]);
  const [pending, setPending] = useState(false);
  const bad = new Set(
    issues.filter((i) => i.severity === "error").map((i) => fieldOfIssue(i.path)),
  );
  const set = (patch: Partial<BankAccountDraft>) => setDraft((d) => ({ ...d, ...patch }));

  const field = (
    name: "iban" | "bic" | "label" | "bankName",
    opts: { max: number; required?: boolean; hint?: string },
  ) => (
    <Field
      label={t(`fields.${name}`)}
      name={name}
      value={draft[name]}
      maxLength={opts.max}
      required={opts.required}
      hint={opts.hint}
      autoCapitalize={name === "iban" || name === "bic" ? "characters" : undefined}
      spellCheck={name === "iban" || name === "bic" ? false : undefined}
      onChange={(e) => set({ [name]: e.target.value })}
      aria-invalid={bad.has(name) || undefined}
      className={bad.has(name) ? "border-red-500" : undefined}
    />
  );

  return (
    <form
      className="space-y-4 rounded-xl border border-border p-4"
      data-testid="bank-account-create"
      onSubmit={async (e) => {
        e.preventDefault();
        setPending(true);
        onNotice(null);
        const outcome = await send(url, "POST", toCreateBankAccountBody(draft));
        setPending(false);
        if (outcome.kind === "ok") {
          setIssues([]);
          setDraft(EMPTY_BANK_ACCOUNT);
          onCreated(outcome.bankAccount);
        } else if (outcome.kind === "invalid") {
          setIssues(outcome.issues);
          onNotice({ kind: "invalid" });
        } else {
          setIssues([]);
          onNotice(outcome);
        }
      }}
    >
      <h3 className="text-sm font-semibold text-text">{t("create")}</h3>
      <div className="grid gap-4 sm:grid-cols-2">
        {field("iban", { max: 64, required: true, hint: t("fields.ibanHint") })}
        {field("bic", { max: 20, hint: t("fields.bicHint") })}
        {field("bankName", { max: 200 })}
        {field("label", { max: 100, hint: t("fields.labelHint") })}
        <label className="flex items-center gap-2 text-sm text-text sm:col-span-2">
          <input
            type="checkbox"
            name="isDefault"
            checked={draft.isDefault}
            onChange={(e) => set({ isDefault: e.target.checked })}
          />
          {t("fields.isDefault")}
        </label>
      </div>
      <IssueList issues={issues} />
      <Button type="submit" disabled={pending}>
        {t("create")}
      </Button>
    </form>
  );
}

function AccountRow({
  url,
  item,
  canManage,
  onChanged,
  onNotice,
}: {
  url: string;
  item: BankAccountItem;
  canManage: boolean;
  onChanged: (item: BankAccountItem, kind: Done) => void;
  onNotice: (n: Notice | null) => void;
}) {
  const t = useTranslations("bankAccounts");
  const confirmId = useId();
  const [mode, setMode] = useState<"view" | "edit" | "confirmArchive">("view");
  const [label, setLabel] = useState(item.label ?? "");
  const [bankName, setBankName] = useState(item.bankName ?? "");
  const [bic, setBic] = useState(item.bic ?? "");
  const [issues, setIssues] = useState<ApiIssue[]>([]);
  const [pending, setPending] = useState(false);

  async function patch(body: object, kind: Done) {
    setPending(true);
    onNotice(null);
    const outcome = await send(url, "PATCH", { expectedVersion: item.version, ...body });
    setPending(false);
    if (outcome.kind === "ok") onChanged(outcome.bankAccount, kind);
    else if (outcome.kind === "invalid") {
      setIssues(outcome.issues);
      onNotice({ kind: "invalid" });
    } else onNotice(outcome);
  }

  const cell = (heading: string, children: ReactNode) => (
    <div className="flex justify-between gap-3 text-sm md:block">
      <span className="text-muted md:hidden">{heading}</span>
      <span className="min-w-0 text-right break-words text-text md:text-left">{children}</span>
    </div>
  );

  return (
    <li
      className="rounded-xl border border-border p-3 md:rounded-none md:border-0 md:px-2 md:py-3"
      data-testid="bank-account-row"
      data-iban={item.iban}
      data-archived={item.archived}
      data-default={item.isDefault}
    >
      <div className="grid gap-2 md:grid-cols-[1.5fr_2fr_1fr_1fr_auto] md:items-center md:gap-3">
        {cell(
          t("colName"),
          <>
            <span className="font-medium" data-testid="bank-account-name">
              {item.label || item.bankName || "—"}
            </span>
            {item.label && item.bankName ? (
              <span className="block text-xs text-muted">{item.bankName}</span>
            ) : null}
          </>,
        )}
        {cell(t("colIban"), <span className="font-mono">{formatIban(item.iban)}</span>)}
        {cell(t("colBic"), item.bic ?? "—")}
        {cell(
          t("colStatus"),
          <span className="inline-flex flex-wrap justify-end gap-1 md:justify-start">
            <Badge tone={item.archived ? "neutral" : "success"}>
              {t(item.archived ? "status.archived" : "status.active")}
            </Badge>
            {item.isDefault ? (
              <span data-testid="bank-account-default">
                <Badge tone="accent">{t("status.default")}</Badge>
              </span>
            ) : null}
          </span>,
        )}
        {canManage && mode === "view" ? (
          <div className="flex flex-wrap gap-2 md:justify-end">
            <Button
              type="button"
              variant="secondary"
              disabled={pending}
              onClick={() => setMode("edit")}
            >
              {t("edit")}
            </Button>
            {!item.archived && !item.isDefault ? (
              <Button
                type="button"
                variant="secondary"
                disabled={pending}
                onClick={() => void patch({ isDefault: true }, "defaultSet")}
              >
                {t("makeDefault")}
              </Button>
            ) : null}
            {item.archived ? (
              <Button
                type="button"
                variant="secondary"
                disabled={pending}
                onClick={() => void patch({ archived: false }, "restored")}
              >
                {t("restore")}
              </Button>
            ) : (
              <Button
                type="button"
                variant="secondary"
                disabled={pending}
                onClick={() => setMode("confirmArchive")}
              >
                {t("archive")}
              </Button>
            )}
          </div>
        ) : (
          <span className="hidden md:block" />
        )}
      </div>

      {mode === "edit" ? (
        <form
          className="mt-3 space-y-3"
          data-testid="bank-account-edit"
          onSubmit={(e) => {
            e.preventDefault();
            void patch(
              {
                label: label.trim() || null,
                bankName: bankName.trim() || null,
                bic: bic.trim() || null,
              },
              "saved",
            );
          }}
        >
          <p className="text-xs text-muted">{t("immutableHint")}</p>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field
              label={t("fields.label")}
              name="label"
              value={label}
              maxLength={100}
              onChange={(e) => setLabel(e.target.value)}
            />
            <Field
              label={t("fields.bankName")}
              name="bankName"
              value={bankName}
              maxLength={200}
              onChange={(e) => setBankName(e.target.value)}
            />
            <Field
              label={t("fields.bic")}
              name="bic"
              value={bic}
              maxLength={20}
              autoCapitalize="characters"
              spellCheck={false}
              onChange={(e) => setBic(e.target.value)}
            />
          </div>
          <IssueList issues={issues} />
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button type="submit" disabled={pending}>
              {t("save")}
            </Button>
            <Button type="button" variant="secondary" onClick={() => setMode("view")}>
              {t("cancel")}
            </Button>
          </div>
        </form>
      ) : null}

      {mode === "confirmArchive" ? (
        <div
          role="alertdialog"
          aria-labelledby={`${confirmId}-title`}
          aria-describedby={`${confirmId}-body`}
          className="mt-3 space-y-3 rounded-xl border border-accent/50 bg-accent-soft/40 p-3"
          data-testid="bank-account-archive-confirm"
        >
          <p id={`${confirmId}-title`} className="text-sm font-semibold text-text">
            {t("archiveConfirmTitle")}
          </p>
          <p id={`${confirmId}-body`} className="text-sm text-muted">
            {t("archiveConfirmBody")}
          </p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button
              type="button"
              disabled={pending}
              onClick={() => void patch({ archived: true }, "archived")}
            >
              {t("archiveConfirm")}
            </Button>
            <Button type="button" variant="secondary" onClick={() => setMode("view")}>
              {t("cancel")}
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

function NoticeAlert({ notice, onReload }: { notice: Notice | null; onReload: () => void }) {
  const t = useTranslations("bankAccounts");
  const tCompany = useTranslations("company");
  if (!notice) return null;
  switch (notice.kind) {
    case "created":
    case "saved":
    case "archived":
    case "restored":
    case "defaultSet":
      return <Alert tone="success">{t(`done.${notice.kind}`)}</Alert>;
    case "conflict":
      return (
        <Alert tone="error">
          {t("outcome.conflict")}{" "}
          <button type="button" className="underline" onClick={onReload}>
            {t("reload")}
          </button>
        </Alert>
      );
    case "twoFactor":
      return (
        <Alert tone="error">
          {t("outcome.twoFactor")}{" "}
          <Link href="/account/two-factor">{tCompany("setUpTwoFactor")}</Link>
        </Alert>
      );
    default:
      return <Alert tone="error">{t(`outcome.${notice.kind}`)}</Alert>;
  }
}
