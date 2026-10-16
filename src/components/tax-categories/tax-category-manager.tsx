"use client";

import { useTranslations } from "next-intl";
import { type ReactNode, useId, useState } from "react";
import { IssueList } from "@/components/documents/issue-list";
import { Badge } from "@/components/ui/badge";
import { Alert, Button, Field } from "@/components/ui/form";
import { type ApiIssue } from "@/features/documents/editor-model";
import {
  type CategoryDraft,
  type CategoryOutcome,
  fieldOfIssue,
  interpretCategoryResponse,
  KINDS,
  type TaxCategoryItem,
  toCreateBody,
} from "@/features/tax-categories/model";
import { Link, useRouter } from "@/i18n/navigation";

export interface TaxCategoryManagerProps {
  companyId: string;
  categories: TaxCategoryItem[];
  /** tax_categories.manage — only decides which controls are shown; the API enforces it. */
  canManage: boolean;
}

type Notice =
  | { kind: "created" | "saved" | "archived" | "restored" | "invalid" }
  | Exclude<CategoryOutcome, { kind: "ok" | "invalid" }>;

async function send(url: string, method: string, body: unknown): Promise<CategoryOutcome> {
  try {
    const res = await fetch(url, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return interpretCategoryResponse(res.status, await res.json().catch(() => null));
  } catch {
    return { kind: "error" };
  }
}

const EMPTY: CategoryDraft = { code: "", kind: "standard", ratePercent: "", label: "", note: "" };

/**
 * Company tax-category catalog over the API (POST to create, PATCH to edit label/note or to
 * archive/restore). It offers no categories or rates of its own; the server checks permissions,
 * uniqueness and consistency. A table on wide screens, cards on phones (one list, two layouts).
 */
export function TaxCategoryManager({ companyId, categories, canManage }: TaxCategoryManagerProps) {
  const t = useTranslations("taxCategories");
  const router = useRouter();
  const [items, setItems] = useState(categories);
  const [notice, setNotice] = useState<Notice | null>(null);
  const url = `/api/companies/${companyId}/tax-categories`;

  const replace = (item: TaxCategoryItem) =>
    setItems((list) =>
      [...list.filter((c) => c.id !== item.id), item].sort((a, b) => a.code.localeCompare(b.code)),
    );

  return (
    <div className="space-y-6" data-testid="tax-category-manager">
      <Alert tone="info">{t("noRatesProvided")}</Alert>
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
        <p className="text-sm text-muted" data-testid="tax-categories-empty">
          {t("empty")}
        </p>
      ) : (
        <div>
          <div className="hidden grid-cols-[1fr_2fr_1.5fr_1fr_auto] gap-3 border-b border-border px-2 pb-2 text-xs font-medium tracking-wide text-muted uppercase md:grid">
            <span>{t("colCode")}</span>
            <span>{t("colLabel")}</span>
            <span>{t("colTreatment")}</span>
            <span>{t("colStatus")}</span>
            <span className="sr-only">{t("colActions")}</span>
          </div>
          <ul
            className="space-y-3 md:space-y-0 md:divide-y md:divide-border"
            data-testid="tax-category-list"
          >
            {items.map((item) => (
              <CategoryRow
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

function treatment(t: ReturnType<typeof useTranslations<"taxCategories">>, item: TaxCategoryItem) {
  return item.kind === "standard"
    ? `${t("kind.standard")} · ${item.ratePercent}%`
    : `${t(`kind.${item.kind}`)} · 0%`;
}

function CreateForm({
  url,
  onCreated,
  onNotice,
}: {
  url: string;
  onCreated: (item: TaxCategoryItem) => void;
  onNotice: (n: Notice | null) => void;
}) {
  const t = useTranslations("taxCategories");
  const id = useId();
  const [draft, setDraft] = useState<CategoryDraft>(EMPTY);
  const [issues, setIssues] = useState<ApiIssue[]>([]);
  const [pending, setPending] = useState(false);
  const bad = new Set(
    issues.filter((i) => i.severity === "error").map((i) => fieldOfIssue(i.path)),
  );
  const set = (patch: Partial<CategoryDraft>) => setDraft((d) => ({ ...d, ...patch }));

  const field = (name: "code" | "ratePercent" | "label", hint?: string, max?: number) => (
    <Field
      label={t(`fields.${name}`)}
      name={name}
      value={draft[name]}
      maxLength={max}
      inputMode={name === "ratePercent" ? "decimal" : undefined}
      required
      hint={hint}
      onChange={(e) => set({ [name]: e.target.value })}
      aria-invalid={bad.has(name) || undefined}
      className={bad.has(name) ? "border-red-500" : undefined}
    />
  );

  return (
    <form
      className="space-y-4 rounded-xl border border-border p-4"
      data-testid="tax-category-create"
      onSubmit={async (e) => {
        e.preventDefault();
        setPending(true);
        onNotice(null);
        const outcome = await send(url, "POST", toCreateBody(draft));
        setPending(false);
        if (outcome.kind === "ok") {
          setIssues([]);
          setDraft(EMPTY);
          onCreated(outcome.taxCategory);
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
        {field("code", t("fields.codeHint"), 30)}
        <label className="block space-y-1.5" htmlFor={`${id}-kind`}>
          <span className="block text-sm font-medium text-text">{t("fields.kind")}</span>
          <select
            id={`${id}-kind`}
            name="kind"
            value={draft.kind}
            onChange={(e) => set({ kind: e.target.value as CategoryDraft["kind"] })}
            className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2.5 text-sm text-text focus:border-accent focus:outline-none"
          >
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {t(`kind.${k}`)}
              </option>
            ))}
          </select>
        </label>
        {field("ratePercent", t("fields.rateHint"))}
        {field("label", undefined, 100)}
        <label className="block space-y-1.5 sm:col-span-2">
          <span className="block text-sm font-medium text-text">{t("fields.note")}</span>
          <textarea
            name="note"
            value={draft.note}
            maxLength={1000}
            rows={2}
            onChange={(e) => set({ note: e.target.value })}
            className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2.5 text-sm text-text focus:border-accent focus:outline-none"
          />
          <span className="block text-xs text-muted">{t("fields.noteHint")}</span>
        </label>
      </div>
      <IssueList issues={issues} />
      <Button type="submit" disabled={pending}>
        {t("create")}
      </Button>
    </form>
  );
}

function CategoryRow({
  url,
  item,
  canManage,
  onChanged,
  onNotice,
}: {
  url: string;
  item: TaxCategoryItem;
  canManage: boolean;
  onChanged: (item: TaxCategoryItem, kind: "saved" | "archived" | "restored") => void;
  onNotice: (n: Notice | null) => void;
}) {
  const t = useTranslations("taxCategories");
  const confirmId = useId();
  const [mode, setMode] = useState<"view" | "edit" | "confirmArchive">("view");
  const [label, setLabel] = useState(item.label);
  const [note, setNote] = useState(item.note ?? "");
  const [pending, setPending] = useState(false);

  async function patch(body: object, kind: "saved" | "archived" | "restored") {
    setPending(true);
    onNotice(null);
    const outcome = await send(url, "PATCH", { expectedVersion: item.version, ...body });
    setPending(false);
    if (outcome.kind === "ok") onChanged(outcome.taxCategory, kind);
    else onNotice(outcome.kind === "invalid" ? { kind: "invalid" } : outcome);
  }

  const cell = (heading: string, children: ReactNode) => (
    <div className="flex justify-between gap-3 text-sm md:block">
      <span className="text-muted md:hidden">{heading}</span>
      <span className="text-right text-text md:text-left">{children}</span>
    </div>
  );

  return (
    <li
      className="rounded-xl border border-border p-3 md:rounded-none md:border-0 md:px-2 md:py-3"
      data-testid="tax-category-row"
      data-code={item.code}
      data-archived={item.archived}
    >
      <div className="grid gap-2 md:grid-cols-[1fr_2fr_1.5fr_1fr_auto] md:items-center md:gap-3">
        {cell(t("colCode"), <span className="font-medium">{item.code}</span>)}
        {cell(
          t("colLabel"),
          <>
            <span data-testid="tax-category-label">{item.label}</span>
            {item.note ? <span className="block text-xs text-muted">{item.note}</span> : null}
          </>,
        )}
        {cell(t("colTreatment"), treatment(t, item))}
        {cell(
          t("colStatus"),
          <Badge tone={item.archived ? "neutral" : "success"}>
            {t(item.archived ? "status.archived" : "status.active")}
          </Badge>,
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
          data-testid="tax-category-edit"
          onSubmit={(e) => {
            e.preventDefault();
            void patch({ label: label.trim(), note: note.trim() || null }, "saved");
          }}
        >
          <p className="text-xs text-muted">{t("immutableHint")}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label={t("fields.label")}
              name="label"
              value={label}
              maxLength={100}
              required
              onChange={(e) => setLabel(e.target.value)}
            />
            <Field
              label={t("fields.note")}
              name="note"
              value={note}
              maxLength={1000}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
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
          data-testid="tax-category-archive-confirm"
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
  const t = useTranslations("taxCategories");
  const tCompany = useTranslations("company");
  if (!notice) return null;
  switch (notice.kind) {
    case "created":
    case "saved":
    case "archived":
    case "restored":
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
