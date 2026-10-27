"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui/form";
import { sendRecord } from "@/features/records/api";
import { useRouter } from "@/i18n/navigation";

/** Grant or revoke time-limited internal access for one company (operator only; audited). */
export function AccessGrantControls({
  companyId,
  granted,
}: {
  companyId: string;
  granted: boolean;
}) {
  const t = useTranslations("admin");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [days, setDays] = useState("14");
  const [failed, setFailed] = useState(false);
  const url = `/api/admin/companies/${companyId}/access-grant`;
  if (granted)
    return (
      <Button
        type="button"
        variant="ghost"
        className="px-2 py-1 text-xs"
        onClick={async () => {
          const r = await sendRecord(url, "DELETE", {}, "revoked");
          if (r.kind === "ok") router.refresh();
          else setFailed(true);
        }}
      >
        {t("revoke")}
      </Button>
    );
  if (!open)
    return (
      <Button
        type="button"
        variant="ghost"
        className="px-2 py-1 text-xs"
        onClick={() => setOpen(true)}
      >
        {t("grant")}
      </Button>
    );
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        const r = await sendRecord(url, "POST", { days: Number(days), reason }, "grant");
        if (r.kind === "ok") {
          setOpen(false);
          router.refresh();
        } else setFailed(true);
      }}
    >
      <label className="text-xs text-muted">
        {t("days")}
        <input
          type="number"
          min={1}
          max={90}
          value={days}
          onChange={(e) => setDays(e.target.value)}
          className="mt-1 block w-20 rounded-lg border border-border bg-surface-2 px-2 py-1 text-sm text-text"
        />
      </label>
      <label className="text-xs text-muted">
        {t("reason")}
        <input
          required
          minLength={5}
          maxLength={300}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="mt-1 block rounded-lg border border-border bg-surface-2 px-2 py-1 text-sm text-text"
        />
      </label>
      <Button type="submit" className="px-3 py-1.5 text-xs">
        {t("confirmGrant")}
      </Button>
      {failed ? (
        <span role="alert" className="text-xs text-danger">
          {t("failed")}
        </span>
      ) : null}
    </form>
  );
}
