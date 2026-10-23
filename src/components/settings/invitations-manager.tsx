"use client";

import { useTranslations } from "next-intl";
import { type FormEvent, useState } from "react";
import { RecordNotice, type RecordNoticeState } from "@/components/records/record-notice";
import { Badge } from "@/components/ui/badge";
import { Alert, Button, Field } from "@/components/ui/form";
import { interpretRecordResponse, sendRecord } from "@/features/records/api";
import { useRouter } from "@/i18n/navigation";

export interface InvitationItem {
  id: string;
  email: string;
  roleKey: string;
  roleName: string;
  expiresAt: string;
  expired: boolean;
}

const selectClass =
  "w-full rounded-lg border border-border bg-surface-2 px-3 py-2.5 text-sm text-text focus:border-accent focus:outline-none";

/**
 * Open invitations of the company and, with members.manage, a form to invite someone by email
 * with a role. After inviting, the link is shown once so it can be shared even when email is not
 * configured; the server decides who may invite which role.
 */
export function InvitationsManager({
  companyId,
  invitations,
  roles,
  canManage,
  actorIsOwner,
}: {
  companyId: string;
  invitations: InvitationItem[];
  roles: { key: string; name: string }[];
  canManage: boolean;
  actorIsOwner: boolean;
}) {
  const t = useTranslations("invitations");
  const tRoles = useTranslations("roles");
  const router = useRouter();
  const [notice, setNotice] = useState<RecordNoticeState | null>(null);
  const [created, setCreated] = useState<{ link: string; delivery: string } | null>(null);
  const [pending, setPending] = useState(false);
  const [copied, setCopied] = useState(false);
  const roleName = (key: string, fallback: string) =>
    tRoles.has(key as Parameters<typeof tRoles>[0])
      ? tRoles(key as Parameters<typeof tRoles>[0])
      : fallback;
  const invitable = roles.filter((r) => actorIsOwner || r.key !== "owner");

  async function invite(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    setPending(true);
    setNotice(null);
    setCreated(null);
    setCopied(false);
    try {
      const res = await fetch(`/api/companies/${companyId}/invitations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: data.get("email"), roleKey: data.get("roleKey") }),
      });
      const body = (await res.json().catch(() => null)) as {
        link?: string;
        delivery?: string;
      } | null;
      const outcome = interpretRecordResponse(res.status, body, "invitation");
      if (outcome.kind === "ok" && body?.link) {
        setCreated({ link: body.link, delivery: body.delivery ?? "failed" });
        form.reset();
        router.refresh();
      } else setNotice(outcome.kind === "ok" ? { kind: "error" } : outcome);
    } catch {
      setNotice({ kind: "error" });
    }
    setPending(false);
  }

  async function revoke(id: string) {
    setPending(true);
    setNotice(null);
    const outcome = await sendRecord(
      `/api/companies/${companyId}/invitations/${id}`,
      "DELETE",
      {},
      "revoked",
    );
    setPending(false);
    if (outcome.kind === "ok") {
      setNotice({ kind: "done", message: t("revoked") });
      router.refresh();
    } else setNotice(outcome);
  }

  return (
    <div className="space-y-4" data-testid="invitations-manager">
      {canManage ? (
        <form onSubmit={invite} className="grid gap-3 sm:grid-cols-[1fr_12rem_auto] sm:items-end">
          <Field
            label={t("email")}
            name="email"
            type="email"
            required
            maxLength={254}
            autoComplete="off"
          />
          <div className="space-y-1.5">
            <label htmlFor="invite-role" className="block text-sm font-medium text-text">
              {t("role")}
            </label>
            <select
              id="invite-role"
              name="roleKey"
              className={selectClass}
              defaultValue={invitable.find((r) => r.key === "manager")?.key ?? invitable[0]?.key}
            >
              {invitable.map((r) => (
                <option key={r.key} value={r.key}>
                  {roleName(r.key, r.name)}
                </option>
              ))}
            </select>
          </div>
          <Button type="submit" disabled={pending} data-testid="invite-submit">
            {t("invite")}
          </Button>
        </form>
      ) : null}
      <RecordNotice
        notice={notice}
        onReload={() => router.refresh()}
        takenText={(code) => (code === "member_exists" ? t("memberExists") : t("error"))}
      />
      {created ? (
        <Alert tone={created.delivery === "sent" ? "success" : "warning"}>
          <span className="block">
            {t(`delivery.${created.delivery}` as Parameters<typeof t>[0])}
          </span>
          <span className="mt-2 flex flex-wrap items-center gap-2">
            <code className="text-xs break-all" data-testid="invitation-link">
              {created.link}
            </code>
            <button
              type="button"
              className="underline"
              onClick={() =>
                void navigator.clipboard
                  ?.writeText(created.link)
                  .then(() => setCopied(true))
                  .catch(() => undefined)
              }
            >
              {copied ? t("copied") : t("copy")}
            </button>
          </span>
        </Alert>
      ) : null}
      {invitations.length ? (
        <ul className="divide-y divide-border" aria-label={t("open")}>
          {invitations.map((i) => (
            <li
              key={i.id}
              className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between"
              data-testid="invitation-row"
              data-email={i.email}
            >
              <div className="min-w-0">
                <p className="break-all text-text">{i.email}</p>
                <p className="flex flex-wrap gap-1 pt-1">
                  <Badge tone="accent">{roleName(i.roleKey, i.roleName)}</Badge>
                  <Badge tone="warning">
                    {i.expired ? t("expired") : t("expires", { date: i.expiresAt.slice(0, 10) })}
                  </Badge>
                </p>
              </div>
              {canManage && (actorIsOwner || i.roleKey !== "owner") ? (
                <Button
                  type="button"
                  variant="secondary"
                  disabled={pending}
                  onClick={() => void revoke(i.id)}
                >
                  {t("revoke")}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">{t("none")}</p>
      )}
    </div>
  );
}
