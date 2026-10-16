import { useTranslations } from "next-intl";

/**
 * Links to the document's PDF (`GET …/pdf`, documents.view — the same right as seeing the page).
 * "Open" shows it in a new tab; "Download" saves it. Plain links: the API answers with the file.
 */
export function PdfLinks({
  companyId,
  documentId,
  draft,
}: {
  companyId: string;
  documentId: string;
  draft: boolean;
}) {
  const t = useTranslations("documents.pdf");
  const href = `/api/companies/${companyId}/documents/${documentId}/pdf`;
  const linkClass =
    "inline-flex items-center justify-center rounded-lg border border-border bg-surface-2 px-4 py-2.5 text-sm font-medium text-text hover:border-accent/60";
  return (
    <div className="space-y-1.5" data-testid="pdf-links">
      <div className="flex flex-col gap-2 sm:flex-row">
        <a href={href} target="_blank" rel="noopener" className={linkClass} data-testid="pdf-open">
          {t(draft ? "openDraft" : "open")}
        </a>
        <a href={`${href}?download=1`} download className={linkClass} data-testid="pdf-download">
          {t(draft ? "downloadDraft" : "download")}
        </a>
      </div>
      {draft ? <p className="text-xs text-muted">{t("draftHint")}</p> : null}
    </div>
  );
}
