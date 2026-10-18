"use client";

import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Alert, Button } from "@/components/ui/form";
import { type DeleteOutcome, interpretDeleteResponse } from "@/features/documents/create-model";
import { Link, useRouter } from "@/i18n/navigation";

/**
 * Deletes a draft through `DELETE …/documents/{id}` after an explicit confirmation in a modal
 * alert dialog, then returns to the documents list with a confirmation message. Shown only for
 * drafts and only to users with documents.create; the server refuses everything else (issued →
 * 409, other company → 404).
 *
 * The dialog opens with focus on Cancel (the safe action); Esc and Cancel close it, and focus goes
 * back to the trigger. While the request runs both actions are disabled and the dialog cannot be
 * closed, so the draft is deleted at most once. A refusal closes the dialog and is shown as an
 * inline alert under the trigger.
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
  const cancelRef = useRef<HTMLButtonElement>(null);
  // A ref, not state: it blocks a second click that lands before React re-renders the buttons.
  const inFlight = useRef(false);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<Exclude<DeleteOutcome, { kind: "deleted" }> | null>(null);
  const listUrl = `/companies/${companyId}/documents`;

  async function remove() {
    if (inFlight.current) return;
    inFlight.current = true;
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
    inFlight.current = false;
    setPending(false);
    setOpen(false);
    if (result.kind === "deleted") {
      router.push(`${listUrl}?deleted=1`);
      router.refresh();
      return;
    }
    setOutcome(result);
  }

  return (
    <div className="space-y-2" data-testid="delete-draft">
      <AlertDialog
        open={open}
        onOpenChange={(next) => {
          // Not while the request runs: Esc must not hide a deletion that is still in progress.
          if (inFlight.current) return;
          if (next) setOutcome(null);
          setOpen(next);
        }}
      >
        <AlertDialogTrigger
          render={
            <Button
              type="button"
              variant={compact ? "ghost" : "danger"}
              className={compact ? "px-0 py-1 text-danger hover:text-red-300" : undefined}
            />
          }
          disabled={pending}
        >
          {t("deleteDraft")}
        </AlertDialogTrigger>
        <AlertDialogContent initialFocus={cancelRef} data-testid="delete-confirm">
          <AlertDialogTitle className="text-base font-semibold text-text">
            {t("deleteConfirmTitle")}
          </AlertDialogTitle>
          <AlertDialogDescription className="text-sm text-muted" data-testid="delete-confirm-body">
            {t(fromEditor ? "deleteConfirmBodyEditor" : "deleteConfirmBody")}
          </AlertDialogDescription>
          <AlertDialogFooter>
            <Button
              type="button"
              variant="danger"
              disabled={pending}
              aria-busy={pending || undefined}
              onClick={() => void remove()}
            >
              {t("deleteConfirm")}
            </Button>
            <AlertDialogCancel ref={cancelRef} disabled={pending}>
              {t("cancel")}
            </AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
