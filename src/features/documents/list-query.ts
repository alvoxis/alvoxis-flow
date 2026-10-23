import {
  DOCUMENT_STATUSES,
  DOCUMENT_TYPES,
  type DocumentStatus,
  type DocumentType,
} from "@/modules/documents/domain/types";

/**
 * Search, filters, sorting and paging of a company's document list, kept in the URL so a list
 * can be bookmarked, shared within the company and restored after opening a document. Parsing is
 * tolerant: unknown or invalid values are dropped (never an error page), and the server builds the
 * query from the parsed values only.
 */

export const DOCUMENT_SORTS = [
  "date_desc",
  "date_asc",
  "number_asc",
  "number_desc",
  "amount_desc",
  "amount_asc",
] as const;
export type DocumentSort = (typeof DOCUMENT_SORTS)[number];
export const DEFAULT_DOCUMENT_SORT: DocumentSort = "date_desc";

/** Rows per page of the document list. */
export const DOCUMENT_PAGE_SIZE = 25;
/** Longest search text kept (longer input is cut). */
export const MAX_SEARCH_LENGTH = 100;

export interface DocumentListQuery {
  /** Search text (number or buyer name), trimmed and with single spaces; "" = no search. */
  q: string;
  type: DocumentType | null;
  status: DocumentStatus | null;
  /** Issue-date range, inclusive, YYYY-MM-DD. */
  from: string | null;
  to: string | null;
  sort: DocumentSort;
  /** 1-based. */
  page: number;
}

export const EMPTY_DOCUMENT_QUERY: DocumentListQuery = {
  q: "",
  type: null,
  status: null,
  from: null,
  to: null,
  sort: DEFAULT_DOCUMENT_SORT,
  page: 1,
};

type RawParams = URLSearchParams | Record<string, string | string[] | undefined>;

function first(params: RawParams, key: string): string {
  const v = params instanceof URLSearchParams ? params.get(key) : params[key];
  return (Array.isArray(v) ? v[0] : v) ?? "";
}

function isoDate(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value ? value : null;
}

function oneOf<T extends string>(values: readonly T[], value: string): T | null {
  return (values as readonly string[]).includes(value) ? (value as T) : null;
}

/** Search text as the user means it: no surrounding or repeated whitespace, bounded length. */
export function normalizeSearch(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, MAX_SEARCH_LENGTH).trim();
}

export function parseDocumentListQuery(params: RawParams): DocumentListQuery {
  let from = isoDate(first(params, "from"));
  let to = isoDate(first(params, "to"));
  // A reversed range is read the way it was meant.
  if (from && to && from > to) [from, to] = [to, from];
  const page = Number(first(params, "page"));
  return {
    q: normalizeSearch(first(params, "q")),
    type: oneOf(DOCUMENT_TYPES, first(params, "type")),
    status: oneOf(DOCUMENT_STATUSES, first(params, "status")),
    from,
    to,
    sort: oneOf(DOCUMENT_SORTS, first(params, "sort")) ?? DEFAULT_DOCUMENT_SORT,
    page: Number.isInteger(page) && page >= 1 && page <= 10_000 ? page : 1,
  };
}

/** Whether any search or filter narrows the list (sorting and paging do not). */
export function isFiltered(q: DocumentListQuery): boolean {
  return Boolean(q.q || q.type || q.status || q.from || q.to);
}

/** The query as URL parameters: only non-default values, in a stable order ("" when default). */
export function toQueryString(q: DocumentListQuery, overrides: Partial<DocumentListQuery> = {}) {
  const v = { ...q, ...overrides };
  const params = new URLSearchParams();
  if (v.q) params.set("q", v.q);
  if (v.type) params.set("type", v.type);
  if (v.status) params.set("status", v.status);
  if (v.from) params.set("from", v.from);
  if (v.to) params.set("to", v.to);
  if (v.sort !== DEFAULT_DOCUMENT_SORT) params.set("sort", v.sort);
  if (v.page > 1) params.set("page", String(v.page));
  const s = params.toString();
  return s ? `?${s}` : "";
}

/** First and last row numbers shown, for "Showing 26–50 of 60". */
export function pageRange(page: number, total: number, size = DOCUMENT_PAGE_SIZE) {
  const start = total === 0 ? 0 : Math.min((page - 1) * size + 1, total);
  const end = Math.min(page * size, total);
  return { start, end, pages: Math.max(1, Math.ceil(total / size)) };
}
