import { describe, expect, it } from "vitest";
import { isNavItemActive, NAV_ITEMS } from "@/components/layout/nav-items";
import { issuedShare, summarizeDocuments } from "@/features/dashboard/summary";
import { localeOfPath } from "@/features/errors/locale";

describe("summarizeDocuments", () => {
  it("counts drafts and issued documents and sums invoiced totals per currency", () => {
    const s = summarizeDocuments([
      { type: "invoice", status: "draft", currency: "EUR", grossTotal: null },
      { type: "invoice", status: "issued", currency: "EUR", grossTotal: "121.00" },
      { type: "invoice", status: "issued", currency: "EUR", grossTotal: "0.10" },
      { type: "invoice", status: "issued", currency: "PLN", grossTotal: "1000.50" },
      // Issued delivery notes have no amount.
      { type: "delivery_note", status: "issued", currency: "EUR", grossTotal: null },
    ]);
    expect(s.drafts).toBe(1);
    expect(s.issued).toBe(4);
    expect(s.invoicedTotals).toEqual([
      { currency: "EUR", amount: "121.10" },
      { currency: "PLN", amount: "1000.50" },
    ]);
  });

  it("subtracts issued credit notes and leaves proformas out", () => {
    const s = summarizeDocuments([
      { type: "invoice", status: "issued", currency: "EUR", grossTotal: "1320.00" },
      { type: "credit_note", status: "issued", currency: "EUR", grossTotal: "-324.00" },
      // A draft credit note has not reduced anything yet.
      { type: "credit_note", status: "draft", currency: "EUR", grossTotal: "-996.00" },
      { type: "proforma", status: "issued", currency: "EUR", grossTotal: "5000.00" },
      { type: "invoice", status: "issued", currency: "PLN", grossTotal: "200.00" },
      { type: "credit_note", status: "issued", currency: "PLN", grossTotal: "-200.00" },
    ]);
    expect(s.issued).toBe(5);
    // PLN is fully credited: zero is not shown as an amount.
    expect(s.invoicedTotals).toEqual([{ currency: "EUR", amount: "996.00" }]);
  });

  it("is empty without documents and never invents amounts for drafts", () => {
    expect(summarizeDocuments([])).toEqual({ drafts: 0, issued: 0, invoicedTotals: [] });
    expect(
      summarizeDocuments([
        { type: "invoice", status: "draft", currency: "EUR", grossTotal: "50.00" },
      ]).invoicedTotals,
    ).toEqual([]);
  });
});

describe("issuedShare", () => {
  it("is the rounded percentage of issued documents, 0 without documents", () => {
    expect(issuedShare({ drafts: 0, issued: 0 })).toBe(0);
    expect(issuedShare({ drafts: 3, issued: 0 })).toBe(0);
    expect(issuedShare({ drafts: 0, issued: 2 })).toBe(100);
    expect(issuedShare({ drafts: 1, issued: 2 })).toBe(67);
    expect(issuedShare({ drafts: 2, issued: 1 })).toBe(33);
  });
});

describe("main navigation", () => {
  const documents = NAV_ITEMS.find((i) => i.key === "documents")!;
  const dashboard = NAV_ITEMS.find((i) => i.key === "dashboard")!;

  it("documents is enabled and active on its entry page and on any company's documents", () => {
    expect(documents.soon).toBe(false);
    expect(isNavItemActive(documents, "/documents")).toBe(true);
    expect(isNavItemActive(documents, "/companies/abc/documents")).toBe(true);
    expect(isNavItemActive(documents, "/companies/abc/documents/new")).toBe(true);
    expect(isNavItemActive(documents, "/companies/abc/documents/xyz")).toBe(true);
    expect(isNavItemActive(documents, "/companies/abc/documents-archive")).toBe(false);
    expect(isNavItemActive(documents, "/companies/abc/profile")).toBe(false);
    expect(isNavItemActive(documents, "/")).toBe(false);
    expect(isNavItemActive(dashboard, "/companies/abc/documents")).toBe(false);
  });

  // Company modules: active on their entry page and on any company's pages of that module.
  const COMPANY_MODULES = ["customers", "suppliers", "products", "inventory"];

  it.each(COMPANY_MODULES)("%s is enabled and active on its pages only", (key) => {
    const item = NAV_ITEMS.find((i) => i.key === key)!;
    expect(item.soon).toBe(false);
    expect(isNavItemActive(item, `/${key}`)).toBe(true);
    expect(isNavItemActive(item, `/companies/abc/${key}`)).toBe(true);
    expect(isNavItemActive(item, `/companies/abc/${key}/xyz`)).toBe(true);
    expect(isNavItemActive(item, `/companies/abc/${key}-old`)).toBe(false);
    expect(isNavItemActive(item, "/companies/abc/documents")).toBe(false);
  });

  it("modules that do not exist stay disabled and are never active", () => {
    const built = new Set(["dashboard", "documents", ...COMPANY_MODULES]);
    for (const item of NAV_ITEMS.filter((i) => !built.has(i.key))) {
      expect(item.soon, item.key).toBe(true);
      expect(isNavItemActive(item, item.href)).toBe(false);
    }
  });
});

describe("localeOfPath (global error page)", () => {
  it("takes the locale from the first path segment and falls back to English", () => {
    expect(localeOfPath("/lv/companies/x/documents")).toBe("lv");
    expect(localeOfPath("/et")).toBe("et");
    expect(localeOfPath("/de/x")).toBe("en");
    expect(localeOfPath("/")).toBe("en");
    expect(localeOfPath(null)).toBe("en");
  });
});
