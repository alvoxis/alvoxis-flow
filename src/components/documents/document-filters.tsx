import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import {
  DOCUMENT_SORTS,
  type DocumentListQuery,
  isFiltered,
  MAX_SEARCH_LENGTH,
} from "@/features/documents/list-query";
import { DOCUMENT_STATUSES, DOCUMENT_TYPES } from "@/modules/documents/domain/types";

const control =
  "w-full min-h-11 rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-text focus:border-accent focus:outline-none";

/**
 * Search, filters and sorting of the document list as a plain GET form: the values live in the
 * URL, the server runs the query, and it works without JavaScript. Applying a filter starts again
 * at page 1 (the page parameter is not part of the form).
 */
export function DocumentFilters({
  companyId,
  query,
}: {
  companyId: string;
  query: DocumentListQuery;
}) {
  const t = useTranslations("documents.filters");
  const tType = useTranslations("documentPdf.title");
  const tStatus = useTranslations("documents.status");
  const listUrl = `/companies/${companyId}/documents`;
  return (
    <div role="search">
      <form
        method="get"
        className="grid grid-cols-1 gap-3 rounded-xl border border-border bg-surface-2/40 p-3 min-[360px]:grid-cols-2 lg:grid-cols-[1.5fr_1fr_1.15fr_1fr_1fr_1.25fr]"
        data-testid="document-filters"
      >
        <label className="block space-y-1 min-[360px]:col-span-2 lg:col-span-1">
          <span className="block text-xs font-medium text-muted">{t("search")}</span>
          <input
            type="search"
            name="q"
            defaultValue={query.q}
            maxLength={MAX_SEARCH_LENGTH}
            placeholder={t("searchPlaceholder")}
            autoComplete="off"
            className={control}
          />
        </label>
        <label className="block space-y-1">
          <span className="block text-xs font-medium text-muted">{t("type")}</span>
          <select name="type" defaultValue={query.type ?? ""} className={control}>
            <option value="">{t("anyType")}</option>
            {DOCUMENT_TYPES.map((type) => (
              <option key={type} value={type}>
                {tType(type)}
              </option>
            ))}
          </select>
        </label>
        <label className="block space-y-1">
          <span className="block text-xs font-medium text-muted">{t("status")}</span>
          <select name="status" defaultValue={query.status ?? ""} className={control}>
            <option value="">{t("anyStatus")}</option>
            {DOCUMENT_STATUSES.map((status) => (
              <option key={status} value={status}>
                {tStatus(status)}
              </option>
            ))}
          </select>
        </label>
        <label className="block space-y-1">
          <span className="block text-xs font-medium text-muted">{t("from")}</span>
          <input type="date" name="from" defaultValue={query.from ?? ""} className={control} />
        </label>
        <label className="block space-y-1">
          <span className="block text-xs font-medium text-muted">{t("to")}</span>
          <input type="date" name="to" defaultValue={query.to ?? ""} className={control} />
        </label>
        <label className="block space-y-1 min-[360px]:col-span-2 lg:col-span-1">
          <span className="block text-xs font-medium text-muted">{t("sort")}</span>
          <select name="sort" defaultValue={query.sort} className={control}>
            {DOCUMENT_SORTS.map((sort) => (
              <option key={sort} value={sort}>
                {t(`sorts.${sort}`)}
              </option>
            ))}
          </select>
        </label>
        <div className="flex flex-wrap items-center gap-3 min-[360px]:col-span-2 lg:col-span-6">
          <button
            type="submit"
            className="min-h-11 rounded-lg bg-accent-strong px-4 text-sm font-medium text-white hover:bg-violet-700"
          >
            {t("apply")}
          </button>
          {isFiltered(query) || query.sort !== "date_desc" ? (
            <Link
              href={listUrl}
              className="inline-flex min-h-11 items-center rounded-lg px-3 text-sm text-violet-300 hover:underline"
              data-testid="document-filters-reset"
            >
              {t("reset")}
            </Link>
          ) : null}
          {query.sort.startsWith("amount") ? (
            <p className="text-xs text-muted">{t("amountSortHint")}</p>
          ) : null}
        </div>
      </form>
    </div>
  );
}

/** Previous/next links and "26–50 of 60"; hidden when everything fits on one page. */
export function DocumentPagination({
  companyId,
  page,
  pages,
  start,
  end,
  total,
  hrefFor,
}: {
  companyId: string;
  page: number;
  pages: number;
  start: number;
  end: number;
  total: number;
  /** Query string for a page number (keeps search, filters and sorting). */
  hrefFor: (page: number) => string;
}) {
  const t = useTranslations("documents.filters");
  const listUrl = `/companies/${companyId}/documents`;
  const link =
    "inline-flex min-h-11 items-center rounded-lg border border-border px-4 text-sm text-text hover:border-accent/60";
  return (
    <nav
      aria-label={t("pagination")}
      className="flex flex-wrap items-center justify-between gap-3 pt-2"
      data-testid="document-pagination"
    >
      <p className="text-sm text-muted" aria-live="polite">
        {t("showing", { start, end, total })}
      </p>
      {pages > 1 ? (
        <div className="flex gap-2">
          {page > 1 ? (
            <Link href={`${listUrl}${hrefFor(page - 1)}`} className={link} rel="prev">
              {t("previous")}
            </Link>
          ) : null}
          {page < pages ? (
            <Link href={`${listUrl}${hrefFor(page + 1)}`} className={link} rel="next">
              {t("next")}
            </Link>
          ) : null}
        </div>
      ) : null}
    </nav>
  );
}
