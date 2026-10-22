import { describe, expect, it } from "vitest";
import {
  DEFAULT_DOCUMENT_SORT,
  DOCUMENT_PAGE_SIZE,
  EMPTY_DOCUMENT_QUERY,
  isFiltered,
  MAX_SEARCH_LENGTH,
  normalizeSearch,
  pageRange,
  parseDocumentListQuery,
  toQueryString,
} from "@/features/documents/list-query";

describe("document list query", () => {
  it("defaults to everything, newest first, page 1", () => {
    expect(parseDocumentListQuery({})).toEqual(EMPTY_DOCUMENT_QUERY);
    expect(EMPTY_DOCUMENT_QUERY.sort).toBe(DEFAULT_DOCUMENT_SORT);
    expect(isFiltered(EMPTY_DOCUMENT_QUERY)).toBe(false);
    expect(toQueryString(EMPTY_DOCUMENT_QUERY)).toBe("");
  });

  it("reads valid values from the URL, as records or URLSearchParams", () => {
    const expected = {
      q: "INV-2026",
      type: "credit_note",
      status: "issued",
      from: "2026-03-01",
      to: "2026-03-31",
      sort: "amount_asc",
      page: 3,
    };
    const raw = { ...expected, page: "3" };
    expect(parseDocumentListQuery(raw)).toEqual(expected);
    expect(parseDocumentListQuery(new URLSearchParams(raw))).toEqual(expected);
    expect(parseDocumentListQuery({ ...raw, type: ["proforma", "invoice"] }).type).toBe("proforma");
  });

  it("search text ignores surrounding and repeated whitespace and is bounded", () => {
    expect(normalizeSearch("   Kredīta   Pircējs \t SIA  ")).toBe("Kredīta Pircējs SIA");
    expect(normalizeSearch("   ")).toBe("");
    expect(normalizeSearch("x".repeat(500))).toHaveLength(MAX_SEARCH_LENGTH);
    expect(parseDocumentListQuery({ q: "  inv  0001 " }).q).toBe("inv 0001");
  });

  it("drops unknown or invalid values instead of failing", () => {
    expect(
      parseDocumentListQuery({
        type: "receipt",
        status: "paid",
        from: "2026-02-30",
        to: "31.03.2026",
        sort: "buyer",
        page: "-2",
      }),
    ).toEqual(EMPTY_DOCUMENT_QUERY);
    for (const page of ["0", "1.5", "abc", "100000", ""])
      expect(parseDocumentListQuery({ page }).page).toBe(1);
  });

  it("reads a reversed date range the way it was meant", () => {
    expect(parseDocumentListQuery({ from: "2026-04-01", to: "2026-03-01" })).toMatchObject({
      from: "2026-03-01",
      to: "2026-04-01",
    });
  });

  it("writes only non-default values, and round-trips", () => {
    const q = parseDocumentListQuery({ q: "boots & co", status: "draft", page: "2" });
    expect(isFiltered(q)).toBe(true);
    const qs = toQueryString(q);
    expect(qs).toBe("?q=boots+%26+co&status=draft&page=2");
    expect(parseDocumentListQuery(new URLSearchParams(qs))).toEqual(q);
    expect(toQueryString(q, { page: 1 })).toBe("?q=boots+%26+co&status=draft");
    // Sorting alone is not a filter, but is kept in the URL.
    const sorted = parseDocumentListQuery({ sort: "number_desc" });
    expect(isFiltered(sorted)).toBe(false);
    expect(toQueryString(sorted)).toBe("?sort=number_desc");
  });

  it("a back link can only carry list parameters, never another URL", () => {
    const back = new URLSearchParams("next=https://evil.example&q=x&redirect=/admin");
    expect(toQueryString(parseDocumentListQuery(back))).toBe("?q=x");
  });

  it("computes the rows shown on a page", () => {
    expect(DOCUMENT_PAGE_SIZE).toBe(25);
    expect(pageRange(1, 0)).toEqual({ start: 0, end: 0, pages: 1 });
    expect(pageRange(1, 10)).toEqual({ start: 1, end: 10, pages: 1 });
    expect(pageRange(2, 60)).toEqual({ start: 26, end: 50, pages: 3 });
    expect(pageRange(3, 60)).toEqual({ start: 51, end: 60, pages: 3 });
    expect(pageRange(9, 60)).toEqual({ start: 60, end: 60, pages: 3 });
  });
});
