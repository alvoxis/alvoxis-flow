"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { RecordNotice, type RecordNoticeState } from "@/components/records/record-notice";
import { Badge } from "@/components/ui/badge";
import { sendRecord } from "@/features/records/api";
import { useRouter } from "@/i18n/navigation";

export interface MemberItem {
  membershipId: string;
  email: string;
  displayName: string | null;
  roleKey: string;
  roleName: string;
  status: "invited" | "active" | "suspended";
  isSelf: boolean;
}

const selectClass =
  "rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-text focus:border-accent focus:outline-none";

/**
 * Members of the company with their roles. With members.manage, other members' roles can be
 * changed and members suspended or reactivated; the server enforces the owner rules (only owners
 * manage owners; the last owner stays).
 */
export function MembersManager({
  companyId,
  members,
  roles,
  canManage,
  actorIsOwner,
}: {
  companyId: string;
  members: MemberItem[];
  roles: { key: string; name: string }[];
  canManage: boolean;
  actorIsOwner: boolean;
}) {
  const t = useTranslations("settings");
  const tRoles = useTranslations("roles");
  const router = useRouter();
  const [notice, setNotice] = useState<RecordNoticeState | null>(null);
  const [pending, setPending] = useState(false);
  const roleName = (key: string, fallback: string) =>
    tRoles.has(key as Parameters<typeof tRoles>[0])
      ? tRoles(key as Parameters<typeof tRoles>[0])
      : fallback;

  async function change(m: MemberItem, body: object) {
    setPending(true);
    setNotice(null);
    const outcome = await sendRecord(
      `/api/companies/${companyId}/members/${m.membershipId}`,
      "PATCH",
      body,
      "member",
    );
    setPending(false);
    if (outcome.kind === "ok") {
      setNotice({ kind: "done", message: t("members.saved") });
      router.refresh();
    } else setNotice(outcome);
  }

  return (
    <div className="space-y-3" data-testid="members-manager">
      <RecordNotice
        notice={notice}
        onReload={() => router.refresh()}
        stateText={() => t("members.lastOwner")}
      />
      <ul className="divide-y divide-border">
        {members.map((m) => {
          const editable = canManage && !m.isSelf && (actorIsOwner || m.roleKey !== "owner");
          return (
            <li
              key={m.membershipId}
              className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between"
              data-testid="member-row"
              data-email={m.email}
            >
              <div className="min-w-0">
                <p className="break-all text-text">
                  {m.displayName ? `${m.displayName} · ` : ""}
                  {m.email}
                  {m.isSelf ? (
                    <span className="ml-2 text-xs text-muted">({t("members.you")})</span>
                  ) : null}
                </p>
                <p className="flex flex-wrap gap-1 pt-1">
                  <Badge tone="accent">{roleName(m.roleKey, m.roleName)}</Badge>
                  {m.status !== "active" ? (
                    <Badge tone="warning">{t(`members.status.${m.status}`)}</Badge>
                  ) : null}
                </p>
              </div>
              {editable ? (
                <div className="flex flex-wrap items-center gap-2">
                  <label className="sr-only" htmlFor={`role-${m.membershipId}`}>
                    {t("members.role")}
                  </label>
                  <select
                    id={`role-${m.membershipId}`}
                    className={selectClass}
                    value={m.roleKey}
                    disabled={pending}
                    onChange={(e) => void change(m, { roleKey: e.target.value })}
                  >
                    {roles
                      .filter((r) => actorIsOwner || r.key !== "owner")
                      .map((r) => (
                        <option key={r.key} value={r.key}>
                          {roleName(r.key, r.name)}
                        </option>
                      ))}
                  </select>
                  <button
                    type="button"
                    disabled={pending}
                    className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-text hover:border-accent/60 disabled:opacity-60"
                    onClick={() =>
                      void change(m, { status: m.status === "suspended" ? "active" : "suspended" })
                    }
                  >
                    {m.status === "suspended" ? t("members.reactivate") : t("members.suspend")}
                  </button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
