"use client";

import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { IssueList } from "@/components/documents/issue-list";
import { RecordNotice, type RecordNoticeState } from "@/components/records/record-notice";
import { Badge } from "@/components/ui/badge";
import { Alert, Button, Field } from "@/components/ui/form";
import { type ApiIssue } from "@/features/documents/editor-model";
import {
  type EmployeeDraft,
  employeeDraftOf,
  type EmployeeItem,
  emptyEmployee,
  type PayrollCountry,
  type PayrollRunItem,
  type RatesItem,
  runTotals,
  toEmployeeBody,
} from "@/features/payroll/model";
import { fieldOfIssue, sendRecord } from "@/features/records/api";
import { useRouter } from "@/i18n/navigation";

export interface PayrollManagerProps {
  companyId: string;
  today: string;
  employees: EmployeeItem[];
  runs: PayrollRunItem[];
  rates: RatesItem[];
  /** payroll.manage — only decides which controls are shown; the API enforces it. */
  canManage: boolean;
}

const COUNTRIES: PayrollCountry[] = ["LV", "LT", "EE", "PL"];
const selectClass =
  "w-full rounded-lg border border-border bg-surface-2 px-3 py-2.5 text-sm text-text focus:border-accent focus:outline-none";

/**
 * Payroll page: monthly runs (start, adjust a gross amount, recalculate, approve, delete a draft,
 * CSV), employees and the rates per country. A calculation aid: the rates must be checked by the
 * accountant. Renders from the server data and refreshes it after every change.
 */
export function PayrollManager(props: PayrollManagerProps) {
  const { companyId, today, employees, runs, rates, canManage } = props;
  const t = useTranslations("payroll");
  const router = useRouter();
  const [notice, setNotice] = useState<RecordNoticeState | null>(null);
  const done = (message: string) => {
    setNotice({ kind: "done", message });
    router.refresh();
  };

  return (
    <div className="space-y-8" data-testid="payroll-manager">
      <Alert tone="warning">{t("disclaimer")}</Alert>
      {!canManage ? <Alert tone="info">{t("readOnly")}</Alert> : null}
      <RecordNotice
        notice={notice}
        onReload={() => router.refresh()}
        takenText={() => t("outcome.periodTaken")}
        stateText={() => t("outcome.approved")}
      />
      <RunsSection
        companyId={companyId}
        today={today}
        runs={runs}
        canManage={canManage}
        onDone={done}
        onNotice={setNotice}
      />
      <EmployeesSection
        companyId={companyId}
        today={today}
        employees={employees}
        canManage={canManage}
        onDone={done}
        onNotice={setNotice}
      />
      <RatesSection
        companyId={companyId}
        rates={rates}
        canManage={canManage}
        onDone={done}
        onNotice={setNotice}
      />
    </div>
  );
}

type SectionProps = {
  companyId: string;
  canManage: boolean;
  onDone: (message: string) => void;
  onNotice: (n: RecordNoticeState | null) => void;
};

function RunsSection({
  companyId,
  today,
  runs,
  canManage,
  onDone,
  onNotice,
}: SectionProps & { today: string; runs: PayrollRunItem[] }) {
  const t = useTranslations("payroll");
  const [period, setPeriod] = useState(today.slice(0, 7));
  const [issues, setIssues] = useState<ApiIssue[]>([]);
  const [pending, setPending] = useState(false);
  const url = `/api/companies/${companyId}/payroll/runs`;

  return (
    <section className="space-y-3" aria-labelledby="runs-title">
      <h3 id="runs-title" className="text-sm font-semibold text-text">
        {t("runs.title")}
      </h3>
      {canManage ? (
        <form
          className="flex flex-col gap-3 rounded-xl border border-border p-4 sm:flex-row sm:items-end"
          data-testid="payroll-start"
          onSubmit={async (e) => {
            e.preventDefault();
            setPending(true);
            onNotice(null);
            const outcome = await sendRecord(url, "POST", { period }, "run");
            setPending(false);
            if (outcome.kind === "ok") {
              setIssues([]);
              onDone(t("done.started", { period }));
            } else {
              setIssues(outcome.kind === "invalid" ? outcome.issues : []);
              onNotice(outcome);
            }
          }}
        >
          <div className="sm:w-48">
            <Field
              label={t("runs.period")}
              name="period"
              type="month"
              required
              value={period}
              onChange={(e) => setPeriod(e.target.value)}
            />
          </div>
          <Button type="submit" disabled={pending}>
            {t("runs.start")}
          </Button>
          <div className="sm:basis-full">
            <IssueList issues={issues} />
          </div>
        </form>
      ) : null}
      {runs.length === 0 ? (
        <p className="text-sm text-muted" data-testid="runs-empty">
          {t("runs.empty")}
        </p>
      ) : (
        <ul className="space-y-3" data-testid="run-list">
          {runs.map((r) => (
            <RunRow
              key={`${r.id}-${r.version}`}
              companyId={companyId}
              run={r}
              canManage={canManage}
              onDone={onDone}
              onNotice={onNotice}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function RunRow({
  companyId,
  run,
  canManage,
  onDone,
  onNotice,
}: SectionProps & { run: PayrollRunItem }) {
  const t = useTranslations("payroll");
  const [open, setOpen] = useState(run.status === "draft");
  const [confirming, setConfirming] = useState(false);
  const [gross, setGross] = useState<Record<string, string>>({});
  const [issues, setIssues] = useState<ApiIssue[]>([]);
  const [pending, setPending] = useState(false);
  const url = `/api/companies/${companyId}/payroll/runs/${run.id}`;
  const draft = run.status === "draft";
  const editable = canManage && draft;

  async function change(body: object, message: string) {
    setPending(true);
    onNotice(null);
    const outcome = await sendRecord(
      url,
      "PATCH",
      { expectedVersion: run.version, ...body },
      "run",
    );
    setPending(false);
    if (outcome.kind === "ok") onDone(message);
    else {
      setIssues(outcome.kind === "invalid" ? outcome.issues : []);
      onNotice(outcome);
    }
  }

  return (
    <li
      className="space-y-3 rounded-xl border border-border p-3"
      data-testid="run-row"
      data-period={run.period}
      data-status={run.status}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm text-text">{run.period}</span>
        <Badge tone={draft ? "warning" : "success"}>{t(`status.${run.status}`)}</Badge>
        <span className="text-xs text-muted">{t("runs.lines", { count: run.lines.length })}</span>
        <button
          type="button"
          className="ml-auto text-sm text-violet-300 hover:underline"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? t("runs.hide") : t("runs.show")}
        </button>
      </div>
      <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-3" data-testid="run-totals">
        {runTotals(run.lines).map((s) => (
          <div key={s.currency} className="contents">
            <div>
              <dt className="text-xs text-muted">{t("cols.gross")}</dt>
              <dd className="whitespace-nowrap tabular-nums">
                {s.gross} {s.currency}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted">{t("cols.net")}</dt>
              <dd className="whitespace-nowrap tabular-nums">
                {s.net} {s.currency}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted">{t("cols.employerCost")}</dt>
              <dd className="whitespace-nowrap tabular-nums">
                {s.employerCost} {s.currency}
              </dd>
            </div>
          </div>
        ))}
      </dl>
      {open ? (
        <ul className="space-y-2" data-testid="run-lines">
          {run.lines.map((l) => (
            <li
              key={l.id}
              className="space-y-2 rounded-lg bg-surface-2/50 p-3 text-sm"
              data-testid="run-line"
              data-employee={l.employeeName}
            >
              <p className="font-medium break-words text-text">
                {l.employeeName} <span className="text-xs text-muted">{l.taxCountry}</span>
              </p>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
                {(
                  [
                    "gross",
                    "employeeSocial",
                    "health",
                    "incomeTax",
                    "net",
                    "employerSocial",
                    "employerCost",
                  ] as const
                ).map((k) => (
                  <div key={k}>
                    <dt className="text-xs text-muted">{t(`cols.${k}`)}</dt>
                    <dd className="whitespace-nowrap tabular-nums" data-field={k}>
                      {l[k]} {l.currency}
                    </dd>
                  </div>
                ))}
              </dl>
              {editable ? (
                <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                  <div className="sm:w-48">
                    <Field
                      label={t("runs.grossThisMonth")}
                      name={`gross-${l.employeeId}`}
                      inputMode="decimal"
                      maxLength={16}
                      value={gross[l.employeeId] ?? l.gross}
                      onChange={(e) => setGross({ ...gross, [l.employeeId]: e.target.value })}
                    />
                  </div>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={pending || (gross[l.employeeId] ?? l.gross) === l.gross}
                    onClick={() =>
                      void change(
                        {
                          action: "setGross",
                          employeeId: l.employeeId,
                          gross: gross[l.employeeId],
                        },
                        t("done.grossSet"),
                      )
                    }
                  >
                    {t("runs.applyGross")}
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      <IssueList issues={issues} />
      <div className="flex flex-wrap gap-2">
        <a
          href={`${url}/csv`}
          className="inline-flex items-center rounded-lg border border-border bg-surface-2 px-4 py-2.5 text-sm text-text hover:border-accent/60"
        >
          {t("runs.csv")}
        </a>
        {editable && !confirming ? (
          <>
            <Button
              type="button"
              variant="secondary"
              disabled={pending}
              onClick={() => void change({ action: "recalculate" }, t("done.recalculated"))}
            >
              {t("runs.recalculate")}
            </Button>
            <Button type="button" disabled={pending} onClick={() => setConfirming(true)}>
              {t("runs.approve")}
            </Button>
            <Button
              type="button"
              variant="danger"
              disabled={pending}
              onClick={async () => {
                setPending(true);
                onNotice(null);
                try {
                  const res = await fetch(`${url}?expectedVersion=${run.version}`, {
                    method: "DELETE",
                  });
                  if (res.ok) onDone(t("done.deleted", { period: run.period }));
                  else onNotice({ kind: res.status === 409 ? "conflict" : "error" });
                } catch {
                  onNotice({ kind: "error" });
                } finally {
                  setPending(false);
                }
              }}
            >
              {t("runs.delete")}
            </Button>
          </>
        ) : null}
      </div>
      {confirming ? (
        <div
          role="alertdialog"
          aria-label={t("runs.approveTitle")}
          className="space-y-3 rounded-xl border border-accent/50 bg-accent-soft/40 p-3"
          data-testid="run-approve-confirm"
        >
          <p className="text-sm text-text">{t("runs.approveBody")}</p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button
              type="button"
              disabled={pending}
              onClick={() =>
                void change({ action: "approve" }, t("done.approved", { period: run.period }))
              }
            >
              {t("runs.approve")}
            </Button>
            <Button type="button" variant="secondary" onClick={() => setConfirming(false)}>
              {t("cancel")}
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

function EmployeesSection({
  companyId,
  today,
  employees,
  canManage,
  onDone,
  onNotice,
}: SectionProps & { today: string; employees: EmployeeItem[] }) {
  const t = useTranslations("payroll");
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const url = `/api/companies/${companyId}/payroll/employees`;

  return (
    <section className="space-y-3" aria-labelledby="employees-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="employees-title" className="text-sm font-semibold text-text">
          {t("employees.title")}
        </h3>
        {canManage && editing === null ? (
          <Button type="button" onClick={() => setEditing("new")} data-testid="employee-add">
            {t("employees.add")}
          </Button>
        ) : null}
      </div>
      {editing === "new" ? (
        <EmployeeForm
          initial={emptyEmployee(today)}
          submitLabel={t("employees.add")}
          onCancel={() => setEditing(null)}
          onSubmit={async (d) => {
            onNotice(null);
            const outcome = await sendRecord(url, "POST", toEmployeeBody(d), "employee");
            if (outcome.kind === "ok") {
              setEditing(null);
              onDone(t("done.employeeAdded"));
            } else onNotice(outcome);
            return outcome;
          }}
        />
      ) : null}
      {employees.length === 0 ? (
        <p className="text-sm text-muted">{t("employees.empty")}</p>
      ) : (
        <ul className="space-y-2" data-testid="employee-list">
          {employees.map((e) => (
            <li
              key={`${e.id}-${e.version}`}
              className="space-y-2 rounded-xl border border-border p-3"
              data-testid="employee-row"
              data-name={`${e.firstName} ${e.lastName}`}
            >
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <p className="font-medium break-words text-text">
                    {e.firstName} {e.lastName}
                    {e.archived ? (
                      <span className="ml-2 text-xs text-muted">({t("archived")})</span>
                    ) : null}
                  </p>
                  <p className="text-xs break-words text-muted">
                    {[e.position, e.taxCountry, `${e.employmentStart} – ${e.employmentEnd ?? "…"}`]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                  <p className="text-sm whitespace-nowrap text-text tabular-nums">
                    {e.monthlyGross} {e.currency} / {t("employees.month")}
                  </p>
                </div>
                {canManage && editing === null ? (
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" variant="secondary" onClick={() => setEditing(e.id)}>
                      {t("edit")}
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={async () => {
                        onNotice(null);
                        const outcome = await sendRecord(
                          `${url}/${e.id}`,
                          "PATCH",
                          { expectedVersion: e.version, archived: !e.archived },
                          "employee",
                        );
                        if (outcome.kind === "ok")
                          onDone(t(e.archived ? "done.employeeRestored" : "done.employeeArchived"));
                        else onNotice(outcome);
                      }}
                    >
                      {t(e.archived ? "restore" : "archive")}
                    </Button>
                  </div>
                ) : null}
              </div>
              {editing === e.id ? (
                <EmployeeForm
                  initial={employeeDraftOf(e)}
                  submitLabel={t("save")}
                  onCancel={() => setEditing(null)}
                  onSubmit={async (d) => {
                    onNotice(null);
                    const outcome = await sendRecord(
                      `${url}/${e.id}`,
                      "PATCH",
                      { expectedVersion: e.version, ...toEmployeeBody(d) },
                      "employee",
                    );
                    if (outcome.kind === "ok") {
                      setEditing(null);
                      onDone(t("done.employeeSaved"));
                    } else onNotice(outcome);
                    return outcome;
                  }}
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function EmployeeForm({
  initial,
  submitLabel,
  onCancel,
  onSubmit,
}: {
  initial: EmployeeDraft;
  submitLabel: string;
  onCancel: () => void;
  onSubmit: (d: EmployeeDraft) => Promise<{ kind: string; issues?: ApiIssue[] }>;
}) {
  const t = useTranslations("payroll");
  const id = useId();
  const [d, setD] = useState(initial);
  const [issues, setIssues] = useState<ApiIssue[]>([]);
  const [pending, setPending] = useState(false);
  const bad = new Set(issues.map((i) => fieldOfIssue(i.path)));
  const set = (patch: Partial<EmployeeDraft>) => setD((x) => ({ ...x, ...patch }));
  const field = (
    name: Exclude<keyof EmployeeDraft, "taxCountry">,
    extra: { type?: string; decimal?: boolean; required?: boolean; hint?: string } = {},
  ) => (
    <Field
      label={t(`fields.${name}`)}
      name={name}
      type={extra.type ?? "text"}
      required={extra.required}
      hint={extra.hint}
      inputMode={extra.decimal ? "decimal" : undefined}
      value={d[name]}
      onChange={(e) => set({ [name]: e.target.value })}
      aria-invalid={bad.has(name) || undefined}
      className={bad.has(name) ? "border-red-500" : undefined}
    />
  );
  return (
    <form
      className="space-y-4 rounded-xl border border-border p-4"
      data-testid="employee-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setPending(true);
        const outcome = await onSubmit(d);
        setPending(false);
        setIssues(outcome.kind === "invalid" ? (outcome.issues ?? []) : []);
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {field("firstName", { required: true })}
        {field("lastName", { required: true })}
        {field("position")}
        {field("email", { type: "email" })}
        <div className="space-y-1.5">
          <label htmlFor={`${id}-country`} className="block text-sm font-medium text-text">
            {t("fields.taxCountry")}
          </label>
          <select
            id={`${id}-country`}
            name="taxCountry"
            value={d.taxCountry}
            onChange={(e) => set({ taxCountry: e.target.value as PayrollCountry })}
            className={selectClass}
          >
            {COUNTRIES.map((c) => (
              <option key={c} value={c}>
                {t(`country.${c}`)}
              </option>
            ))}
          </select>
        </div>
        {field("monthlyGross", { decimal: true, required: true })}
        {field("employmentStart", { type: "date", required: true })}
        {field("employmentEnd", { type: "date" })}
        {field("monthlyAllowance", { decimal: true, hint: t("fields.allowanceHint") })}
        {field("monthlyTaxCredit", { decimal: true, hint: t("fields.taxCreditHint") })}
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

function RatesSection({
  companyId,
  rates,
  canManage,
  onDone,
  onNotice,
}: SectionProps & { rates: RatesItem[] }) {
  const t = useTranslations("payroll");
  return (
    <section className="space-y-3" aria-labelledby="rates-title">
      <h3 id="rates-title" className="text-sm font-semibold text-text">
        {t("rates.title")}
      </h3>
      <p className="text-xs text-muted">{t("rates.hint")}</p>
      <ul className="grid gap-3 lg:grid-cols-2" data-testid="rates-list">
        {rates.map((r) => (
          <RatesForm
            key={`${r.country}-${r.version}`}
            companyId={companyId}
            rates={r}
            canManage={canManage}
            onDone={onDone}
            onNotice={onNotice}
          />
        ))}
      </ul>
    </section>
  );
}

function RatesForm({
  companyId,
  rates,
  canManage,
  onDone,
  onNotice,
}: SectionProps & { rates: RatesItem }) {
  const t = useTranslations("payroll");
  const keys = [
    "employeeSocialRate",
    "employerSocialRate",
    "incomeTaxRate",
    "employeeHealthRate",
  ] as const;
  const [values, setValues] = useState(() => Object.fromEntries(keys.map((k) => [k, rates[k]])));
  const [issues, setIssues] = useState<ApiIssue[]>([]);
  const [pending, setPending] = useState(false);
  return (
    <li
      className="rounded-xl border border-border p-3"
      data-testid="rates-row"
      data-country={rates.country}
    >
      <form
        className="space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setPending(true);
          onNotice(null);
          const outcome = await sendRecord(
            `/api/companies/${companyId}/payroll/rates`,
            "PUT",
            { country: rates.country, expectedVersion: rates.version, ...values },
            "rates",
          );
          setPending(false);
          if (outcome.kind === "ok") {
            setIssues([]);
            onDone(t("done.ratesSaved", { country: rates.country }));
          } else {
            setIssues(outcome.kind === "invalid" ? outcome.issues : []);
            onNotice(outcome);
          }
        }}
      >
        <p className="flex items-center gap-2 text-sm font-medium text-text">
          {t(`country.${rates.country}`)}
          {rates.isDefault ? <Badge tone="warning">{t("rates.default")}</Badge> : null}
        </p>
        <div className="grid grid-cols-2 gap-3">
          {keys.map((k) => (
            <Field
              key={k}
              label={`${t(`rates.${k}`)}, %`}
              name={`${rates.country}-${k}`}
              inputMode="decimal"
              maxLength={10}
              readOnly={!canManage}
              value={values[k]}
              onChange={(e) => setValues({ ...values, [k]: e.target.value })}
            />
          ))}
        </div>
        <IssueList issues={issues} />
        {canManage ? (
          <Button type="submit" variant="secondary" disabled={pending}>
            {t("rates.save")}
          </Button>
        ) : null}
      </form>
    </li>
  );
}
