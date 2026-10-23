"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { RecordNotice, type RecordNoticeState } from "@/components/records/record-notice";
import { Button } from "@/components/ui/form";
import { sendRecord } from "@/features/records/api";
import { useRouter } from "@/i18n/navigation";

/** Accept button of the invitation page; on success opens the company's settings. */
export function InvitationAccept({ token }: { token: string }) {
  const t = useTranslations("invitations");
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<RecordNoticeState | null>(null);

  async function accept() {
    setPending(true);
    setNotice(null);
    const outcome = await sendRecord<string>(
      "/api/invitations/accept",
      "POST",
      { token },
      "companyId",
    );
    if (outcome.kind === "ok") {
      router.push(`/companies/${outcome.value}/settings`);
      router.refresh();
      return;
    }
    setPending(false);
    setNotice(outcome);
  }

  return (
    <div className="space-y-3">
      <RecordNotice
        notice={notice}
        onReload={() => router.refresh()}
        stateText={(code) =>
          t.has(`state.${code}` as Parameters<typeof t>[0])
            ? t(`state.${code}` as Parameters<typeof t>[0])
            : t("state.invitation.closed")
        }
      />
      <Button
        type="button"
        className="w-full"
        disabled={pending}
        onClick={() => void accept()}
        data-testid="invitation-accept"
      >
        {t("accept")}
      </Button>
    </div>
  );
}
