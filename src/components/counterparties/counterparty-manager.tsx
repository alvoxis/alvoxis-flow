"use client";

import { useTranslations } from "next-intl";
import { useId, useMemo, useState } from "react";
import { IssueList } from "@/components/documents/issue-list";
import { RecordNotice, type RecordNoticeState } from "@/components/records/record-notice";
import { Badge } from "@/components/ui/badge";
import { Alert, Button, Field } from "@/components/ui/form";
import {
  addressLine,
  type CounterpartyDraft,
  type CounterpartyItem,
  type CounterpartyKind,
  draftOf,
  emptyCounterparty,
  type TextField,
  toCounterpartyBody,
} from "@/features/counterparties/model";
import { type ApiIssue } from "@/features/documents/editor-model";
import { fieldOfIssue, sendRecord } from "@/features/records/api";
import { Link, useRouter } from "@/i18n/navigation";

export interface CounterpartyManagerProps {
  companyId: string;
  kind: CounterpartyKind;
  items: CounterpartyItem[];
  /** customers.manage / suppliers.manage for this page's kind; the API enforces it. */
  canManage: boolean;
  /** documents.view: show a link to the customer's documents. */
  canViewDocuments: boolean;
}

const byName = (a: CounterpartyItem, b: CounterpartyItem) =>
  Number(a.archived) - Number(b.archived) || a.name.localeCompare(b.name);

/**
 * Customers or suppliers of a company over the API: search, add, edit, archive and restore. A
 * record can be both a customer and a supplier; it then appears on both pages.
 */
export function CounterpartyManager({
  companyId,
  kind,
  items: initial,
  canManage,
  canViewDocuments,
}: CounterpartyManagerProps) {
  const t = useTranslations("counterparties");
  const router = useRouter();
  const [items, setItems] = useState(() => [...initial].sort(byName));
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<RecordNoticeState | null>(null);
  const url = `/api/companies/${companyId}/counterparties`;

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter(
      (c) =>
        (showArchived || !c.archived) &&
        (!q ||
          [c.name, c.registrationNumber, c.vatNumber, c.email, c.contactName, c.city]
            .filter(Boolean)
            .some((v) => v!.toLowerCase().includes(q))),
    );
  }, [items, query, showArchived]);

  const replace = (item: CounterpartyItem) =>
    setItems((list) =>
      // A record that no longer has this page's role leaves the list.
      [
        ...list.filter((c) => c.id !== item.id),
        ...((kind === "customer" ? item.isCustomer : item.isSupplier) ? [item] : []),
      ].sort(byName),
    );

  return (
    <div className="space-y-5" data-testid="counterparty-manager" data-kind={kind}>
      {!canManage ? <Alert tone="info">{t("readOnly")}</Alert> : null}
      <RecordNotice
        notice={notice}
        onReload={() => router.refresh()}
        takenText={() => t("outcome.registrationTaken")}
      />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1">
          <Field
            label={t("search")}
            name="q"
            type="search"
            value={query}
            placeholder={t("searchPlaceholder")}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <label className="flex items-center gap-2 py-2 text-sm text-text">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          />
          {t("showArchived")}
        </label>
        {canManage && !adding ? (
          <Button type="button" onClick={() => setAdding(true)} data-testid="counterparty-add">
            {t(`add.${kind}`)}
          </Button>
        ) : null}
      </div>

      {adding ? (
        <CounterpartyForm
          title={t(`add.${kind}`)}
          initial={emptyCounterparty(kind)}
          submitLabel={t("create")}
          onCancel={() => setAdding(false)}
          onSubmit={async (draft) => {
            const outcome = await sendRecord<CounterpartyItem>(
              url,
              "POST",
              toCounterpartyBody(draft),
              "counterparty",
            );
            if (outcome.kind === "ok") {
              replace(outcome.value);
              setAdding(false);
              setNotice({ kind: "done", message: t("done.created") });
            } else setNotice(outcome);
            return outcome;
          }}
        />
      ) : null}

      {visible.length === 0 ? (
        <p className="text-sm text-muted" data-testid="counterparties-empty">
          {items.length === 0 ? t(`empty.${kind}`) : t("noMatches")}
        </p>
      ) : (
        <ul className="space-y-3" data-testid="counterparty-list">
          {visible.map((item) => (
            <CounterpartyRow
              key={`${item.id}-${item.version}`}
              url={`${url}/${item.id}`}
              companyId={companyId}
              item={item}
              canManage={canManage}
              canViewDocuments={canViewDocuments && item.isCustomer}
              onChanged={(next, message) => {
                replace(next);
                setNotice({ kind: "done", message });
              }}
              onNotice={setNotice}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function CounterpartyRow({
  url,
  companyId,
  item,
  canManage,
  canViewDocuments,
  onChanged,
  onNotice,
}: {
  url: string;
  companyId: string;
  item: CounterpartyItem;
  canManage: boolean;
  canViewDocuments: boolean;
  onChanged: (item: CounterpartyItem, message: string) => void;
  onNotice: (n: RecordNoticeState | null) => void;
}) {
  const t = useTranslations("counterparties");
  const confirmId = useId();
  const [mode, setMode] = useState<"view" | "edit" | "confirmArchive">("view");
  const [pending, setPending] = useState(false);

  async function patch(body: object, message: string) {
    setPending(true);
    onNotice(null);
    const outcome = await sendRecord<CounterpartyItem>(
      url,
      "PATCH",
      { expectedVersion: item.version, ...body },
      "counterparty",
    );
    setPending(false);
    if (outcome.kind === "ok") onChanged(outcome.value, message);
    else onNotice(outcome);
    return outcome;
  }

  const ids = [
    item.registrationNumber ? `${t("fields.registrationNumber")}: ${item.registrationNumber}` : "",
    item.vatNumber ? `${t("fields.vatNumber")}: ${item.vatNumber}` : "",
  ].filter(Boolean);
  const contact = [item.contactName, item.email, item.phone].filter(Boolean);
  const address = addressLine(item);

  return (
    <li
      className="rounded-xl border border-border p-3"
      data-testid="counterparty-row"
      data-name={item.name}
      data-archived={item.archived}
    >
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium break-words text-text" data-testid="counterparty-name">
              {item.name}
            </span>
            {item.isCustomer ? <Badge tone="accent">{t("role.customer")}</Badge> : null}
            {item.isSupplier ? <Badge tone="accent">{t("role.supplier")}</Badge> : null}
            {item.archived ? <Badge>{t("status.archived")}</Badge> : null}
          </div>
          {ids.length ? <p className="text-xs break-words text-muted">{ids.join(" · ")}</p> : null}
          {contact.length ? (
            <p className="text-sm break-words text-muted">{contact.join(" · ")}</p>
          ) : null}
          {address ? <p className="text-sm break-words text-muted">{address}</p> : null}
          {item.paymentTermDays !== null && item.isCustomer ? (
            <p className="text-xs text-muted">{t("paymentTerm", { days: item.paymentTermDays })}</p>
          ) : null}
        </div>
        {mode === "view" ? (
          <div className="flex shrink-0 flex-wrap gap-2">
            {canViewDocuments ? (
              <Link
                href={`/companies/${companyId}/documents?q=${encodeURIComponent(item.name)}`}
                className="inline-flex items-center rounded-lg border border-border bg-surface-2 px-4 py-2.5 text-sm text-text hover:border-accent/60"
              >
                {t("documents")}
              </Link>
            ) : null}
            {canManage ? (
              <>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={pending}
                  onClick={() => setMode("edit")}
                >
                  {t("edit")}
                </Button>
                {item.archived ? (
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={pending}
                    onClick={() => void patch({ archived: false }, t("done.restored"))}
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
              </>
            ) : null}
          </div>
        ) : null}
      </div>

      {mode === "edit" ? (
        <div className="mt-3">
          <CounterpartyForm
            title={t("edit")}
            initial={draftOf(item)}
            submitLabel={t("save")}
            onCancel={() => setMode("view")}
            onSubmit={(draft) => patch(toCounterpartyBody(draft), t("done.saved"))}
          />
        </div>
      ) : null}

      {mode === "confirmArchive" ? (
        <div
          role="alertdialog"
          aria-labelledby={`${confirmId}-title`}
          aria-describedby={`${confirmId}-body`}
          className="mt-3 space-y-3 rounded-xl border border-accent/50 bg-accent-soft/40 p-3"
          data-testid="counterparty-archive-confirm"
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
              onClick={() => void patch({ archived: true }, t("done.archived"))}
            >
              {t("archive")}
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

const FIELD_MAX: Record<TextField, number> = {
  name: 200,
  registrationNumber: 50,
  vatNumber: 20,
  email: 254,
  phone: 50,
  contactName: 200,
  addressLine1: 200,
  addressLine2: 200,
  postalCode: 20,
  city: 100,
  countryCode: 2,
  notes: 2000,
};

function CounterpartyForm({
  title,
  initial,
  submitLabel,
  onCancel,
  onSubmit,
}: {
  title: string;
  initial: CounterpartyDraft;
  submitLabel: string;
  onCancel: () => void;
  onSubmit: (draft: CounterpartyDraft) => Promise<{ kind: string; issues?: ApiIssue[] }>;
}) {
  const t = useTranslations("counterparties");
  const notesId = useId();
  const [draft, setDraft] = useState(initial);
  const [issues, setIssues] = useState<ApiIssue[]>([]);
  const [pending, setPending] = useState(false);
  const bad = new Set(issues.map((i) => fieldOfIssue(i.path)));
  const set = (patch: Partial<CounterpartyDraft>) => setDraft((d) => ({ ...d, ...patch }));

  const field = (name: TextField | "paymentTermDays", extra: { wide?: boolean } = {}) => (
    <div className={extra.wide ? "sm:col-span-2" : undefined}>
      <Field
        label={t(`fields.${name}`)}
        name={name}
        value={draft[name]}
        maxLength={name === "paymentTermDays" ? 3 : FIELD_MAX[name]}
        required={name === "name"}
        inputMode={name === "paymentTermDays" ? "numeric" : undefined}
        type={name === "email" ? "email" : "text"}
        autoCapitalize={name === "countryCode" || name === "vatNumber" ? "characters" : undefined}
        onChange={(e) => set({ [name]: e.target.value })}
        aria-invalid={bad.has(name) || undefined}
        className={bad.has(name) ? "border-red-500" : undefined}
      />
    </div>
  );

  return (
    <form
      className="space-y-4 rounded-xl border border-border p-4"
      data-testid="counterparty-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setPending(true);
        const outcome = await onSubmit(draft);
        setPending(false);
        setIssues(outcome.kind === "invalid" ? (outcome.issues ?? []) : []);
      }}
    >
      <h3 className="text-sm font-semibold text-text">{title}</h3>
      <div className="grid gap-4 sm:grid-cols-2">
        {field("name", { wide: true })}
        {field("registrationNumber")}
        {field("vatNumber")}
        {field("contactName")}
        {field("email")}
        {field("phone")}
        {field("paymentTermDays")}
        {field("addressLine1", { wide: true })}
        {field("addressLine2", { wide: true })}
        {field("postalCode")}
        {field("city")}
        {field("countryCode")}
        <fieldset className="flex flex-wrap items-center gap-4 sm:col-span-2">
          <legend className="mb-1 text-sm font-medium text-text">{t("fields.roles")}</legend>
          <label className="flex items-center gap-2 text-sm text-text">
            <input
              type="checkbox"
              name="isCustomer"
              checked={draft.isCustomer}
              onChange={(e) => set({ isCustomer: e.target.checked })}
            />
            {t("role.customer")}
          </label>
          <label className="flex items-center gap-2 text-sm text-text">
            <input
              type="checkbox"
              name="isSupplier"
              checked={draft.isSupplier}
              onChange={(e) => set({ isSupplier: e.target.checked })}
            />
            {t("role.supplier")}
          </label>
        </fieldset>
        <div className="space-y-1.5 sm:col-span-2">
          <label className="block text-sm font-medium text-text" htmlFor={notesId}>
            {t("fields.notes")}
          </label>
          <textarea
            id={notesId}
            name="notes"
            rows={3}
            maxLength={FIELD_MAX.notes}
            value={draft.notes}
            onChange={(e) => set({ notes: e.target.value })}
            className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2.5 text-sm text-text focus:border-accent focus:outline-none"
          />
        </div>
      </div>
      <IssueList issues={issues} />
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button type="submit" disabled={pending}>
          {submitLabel}
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel}>
          {t("cancel")}
        </Button>
      </div>
    </form>
  );
}
