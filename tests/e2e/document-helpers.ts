import { type Page } from "@playwright/test";
import { FIXTURE_TAX, invoiceDraft } from "../support/document-fixtures";
import { secretFromOtpauthUri } from "../support/totp";
import { createVerifiedUser, expect, PASSWORD, signInViaForm, totp } from "./support";

/** Shared e2e set-up for document tests. Synthetic data only; the fixture tax rate is arbitrary. */

export type Headers = Record<string, string>;

/** Owner with 2FA, a complete seller profile and an issued invoice INV-2026-0001 (2026-03-02):
 *  line 1 "Winter jacket" 10 × 65.00, line 2 "Safety boots" 10 × 45.00, fixture tax 20 %. */
export async function ownerWithIssuedInvoice(page: Page, baseURL: string) {
  await signInViaForm(page, await createVerifiedUser(page.request, baseURL));
  await page.getByTestId("create-company").locator("input[name=name]").fill("Kredīts SIA");
  await page.getByTestId("create-company").getByRole("button").click();
  const docsLink = page.getByTestId("company-documents-link");
  await expect(docsLink).toBeVisible();
  const companyId = (await docsLink.getAttribute("href"))!.split("/").at(-2)!;
  const headers: Headers = { origin: baseURL };
  const enable = await page.request.post("/api/auth/two-factor/enable", {
    data: { password: PASSWORD },
    headers,
  });
  const secret = secretFromOtpauthUri(String((await enable.json()).totpURI));
  const verified = await page.request.post("/api/auth/two-factor/verify-totp", {
    data: { code: totp(secret) },
    headers,
  });
  expect(verified.status()).toBe(200);
  const profile = await page.request.patch(`/api/companies/${companyId}/profile`, {
    data: {
      name: "Kredīts SIA",
      legalName: "SIA Kredīts Tests",
      registrationNumber: "40000000005",
      vatNumber: "LV40000000005",
      addressLine1: "Testa iela 7",
      addressLine2: "",
      postalCode: "LV-1005",
      city: "Rīga",
    },
    headers,
  });
  expect(profile.status()).toBe(200);
  const category = await page.request.post(`/api/companies/${companyId}/tax-categories`, {
    data: FIXTURE_TAX.standard20,
    headers,
  });
  const taxCategoryId = String((await category.json()).taxCategory.id);
  const invoiceId = await createDocument(page, companyId, headers, taxCategoryId, {
    buyer: { name: "Kredīta Pircējs SIA" },
    issue: true,
  });
  const invoiceUrl = `/en/companies/${companyId}/documents/${invoiceId}`;
  return { companyId, invoiceId, invoiceUrl, headers, taxCategoryId };
}

/**
 * Creates a document through the API from the synthetic invoice fixture (2 lines, the given tax
 * category), optionally issued. Returns its id.
 */
export async function createDocument(
  page: Page,
  companyId: string,
  headers: Headers,
  taxCategoryId: string,
  options: Parameters<typeof invoiceDraft>[0] & { issue?: boolean } = {},
): Promise<string> {
  const { issue, ...overrides } = options;
  const { lines, relation: _r, bankAccounts: _b, ...rest } = invoiceDraft(overrides);
  const created = await page.request.post(`/api/companies/${companyId}/documents`, {
    data: {
      ...rest,
      lines: lines.map(({ id: _id, sourceLineId: _s, taxCategory: _t, ...l }) => ({
        ...l,
        taxCategoryId,
      })),
    },
    headers,
  });
  expect(created.status()).toBe(201);
  const id = String((await created.json()).document.id);
  if (issue) {
    const issued = await page.request.post(`/api/companies/${companyId}/documents/${id}/issue`, {
      data: { expectedVersion: 1 },
      headers,
    });
    expect(issued.status()).toBe(200);
  }
  return id;
}
