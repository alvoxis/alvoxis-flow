"use client";

import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { Alert, Button } from "@/components/ui/form";
import { type DeleteOutcome, interpretDeleteResponse } from "@/features/documents/create-model";
import { Link, useRouter } from "@/i18n/navigation";

/**
 * Deletes a draft through `DELETE …/documents/{id}` after an explicit confirmation, then returns
 * to the documents list with a confirmation message. Shown only for drafts and only to users with
 * documents.create; the server refuses everything else (issued → 409, other company → 404).
 */
export function DeleteDraftButton({
  companyId,
  documentId,
  compact = false,
  fromEditor = false,
}: {
  companyId: string;
  documentId: string;
  /** Smaller trigger for list rows. */
  compact?: boolean;
  /** Opened from the editor: the confirmation also warns that unsaved changes are lost. */
  fromEditor?: boolean;
}) {
  const t = useTranslations("documents");
  const tCompany = useTranslations("company");
  const router = useRouter();
  const id = useId();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<Exclude<DeleteOutcome, { kind: "deleted" }> | null>(null);
  const listUrl = `/companies/${companyId}/documents`;

  async function remove() {
    setPending(true);
    let result: DeleteOutcome;
    try {
      const res = await fetch(`/api/companies/${companyId}/documents/${documentId}`, {
        method: "DELETE",
      });
      result = interpretDeleteResponse(res.status, await res.json().catch(() => null));
    } catch {
      result = { kind: "error" };
    }
    setPending(false);
    setConfirming(false);
    if (result.kind === "deleted") {
      router.push(`${listUrl}?deleted=1`);
      router.refresh();
      return;
    }
    setOutcome(result);
  }

  return (
    <div className="space-y-2" data-testid="delete-draft">
      {!confirming ? (
        <Button
          type="button"
          variant={compact ? "ghost" : "danger"}
          className={compact ? "px-0 py-1 text-danger hover:text-red-300" : undefined}
          disabled={pending}
          onClick={() => {
            setOutcome(null);
            setConfirming(true);
          }}
        >
          {t("deleteDraft")}
        </Button>
      ) : (
        <div
          role="alertdialog"
          aria-labelledby={`${id}-title`}
          aria-describedby={`${id}-body`}
          className="space-y-3 rounded-xl border border-red-800/60 bg-red-950/30 p-3"
          data-testid="delete-confirm"
        >
          <p id={`${id}-title`} className="text-sm font-semibold text-text">
            {t("deleteConfirmTitle")}
          </p>
          <p id={`${id}-body`} className="text-sm text-muted" data-testid="delete-confirm-body">
            {t(fromEditor ? "deleteConfirmBodyEditor" : "deleteConfirmBody")}
          </p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button type="button" variant="danger" disabled={pending} onClick={() => void remove()}>
              {t("deleteConfirm")}
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={pending}
              onClick={() => setConfirming(false)}
            >
              {t("cancel")}
            </Button>
          </div>
        </div>
      )}
      {outcome ? (
        <Alert tone="error">
          {outcome.kind === "twoFactor" ? (
            <>
              {t("outcome.twoFactor")}{" "}
              <Link href="/account/two-factor">{tCompany("setUpTwoFactor")}</Link>
            </>
          ) : (
            <>
              {t(`outcome.${outcome.kind}`)}
              {outcome.kind === "notDraft" || outcome.kind === "notFound" ? (
                <>
                  {" "}
                  <button type="button" className="underline" onClick={() => router.refresh()}>
                    {t("reload")}
                  </button>
                </>
              ) : null}
            </>
          )}
        </Alert>
      ) : null}
    </div>
  );
}
