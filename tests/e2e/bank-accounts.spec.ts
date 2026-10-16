import { type Page } from "@playwright/test";
import { secretFromOtpauthUri } from "../support/totp";
import { FIXTURE_TAX } from "../support/document-fixtures";
import {
  alertOf,
  createVerifiedUser,
  expect,
  PASSWORD,
  signInViaForm,
  test,
  totp,
} from "./support";

/**
 * Company bank accounts page and the account picker on documents: details are copied into the
 * document and frozen on issue; later edits or archiving do not change issued documents.
 * Synthetic IBANs (valid checksums, fictitious banks) only. Runs on desktop, tablet and phone.
 */

const IBAN_A = "LV80BANK0000435195001";
const IBAN_B = "LT121000011101001000";

/** Signed-in owner of a new company with 2FA, a complete seller profile and one tax category. */
async function owner(page: Page, baseURL: string) {
  await signInViaForm(page, await createVerifiedUser(page.request, baseURL));
  await page.getByTestId("create-company").locator("input[name=name]").fill("Konti SIA");
  await page.getByTestId("create-company").getByRole("button").click();
  const link = page.getByTestId("company-bank-accounts-link");
  await expect(link).toBeVisible();
  const accountsUrl = (await link.getAttribute("href"))!;
  const companyId = accountsUrl.split("/").at(-2)!;
  const headers = { origin: baseURL };
  const enable = await page.request.post("/api/auth/two-factor/enable", {
    data: { password: PASSWORD },
    headers,
  });
  const secret = secretFromOtpauthUri(String((await enable.json()).totpURI));
  const verify = await page.request.post("/api/auth/two-factor/verify-totp", {
    data: { code: totp(secret) },
    headers,
  });
  expect(verify.status()).toBe(200);
  const profile = await page.request.patch(`/api/companies/${companyId}/profile`, {
    data: {
      name: "Konti SIA",
      legalName: "SIA Konti Tests",
      registrationNumber: "40000000005",
      vatNumber: "LV40000000005",
      addressLine1: "Testa iela 6",
      addressLine2: "",
      postalCode: "LV-1005",
      city: "Rīga",
    },
    headers,
  });
  expect(profile.status()).toBe(200);
  const cat = await page.request.post(`/api/companies/${companyId}/tax-categories`, {
    data: FIXTURE_TAX.standard20,
    headers,
  });
  const categoryId = String((await cat.json()).taxCategory.id);
  return { companyId, accountsUrl, headers, categoryId };
}

async function apiAccount(
  page: Page,
  companyId: string,
  headers: Record<string, string>,
  data: object,
) {
  const res = await page.request.post(`/api/companies/${companyId}/bank-accounts`, {
    data,
    headers,
  });
  expect(res.status()).toBe(201);
  return (await res.json()).bankAccount as { id: string; version: number };
}

const accountRow = (page: Page, iban: string) =>
  page.locator(`[data-testid="bank-account-row"][data-iban="${iban}"]`);

const noHorizontalScroll = async (page: Page) =>
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(0);

test("manage accounts, choose one on a new invoice, issue it; later edits do not change it", async ({
  page,
  baseURL,
}) => {
  const { companyId, accountsUrl, categoryId } = await owner(page, baseURL!);
  await page.goto(accountsUrl);
  await expect(page.getByTestId("bank-accounts-empty")).toBeVisible();
  await noHorizontalScroll(page);

  const form = page.getByTestId("bank-account-create");
  const add = async (fields: Record<string, string>, isDefault = false) => {
    for (const [name, value] of Object.entries(fields))
      await form.locator(`input[name=${name}]`).fill(value);
    if (isDefault) await form.locator("input[name=isDefault]").check();
    await form.getByRole("button", { name: "Add account" }).click();
  };
  // Server checks: IBAN checksum and BIC format.
  await add({ iban: "LV80 BANK 0000 4351 9500 2", bic: "EXAMLV2X" });
  await expect(
    page.locator('[data-testid="document-issue"][data-code="bankAccount.iban.invalid"]'),
  ).toBeVisible();
  await add({ iban: "lv80 bank 0000 4351 9500 1", bic: "EXAM" });
  await expect(
    page.locator('[data-testid="document-issue"][data-code="bankAccount.bic.invalid"]'),
  ).toBeVisible();
  await expect(form.locator("input[name=iban]")).toHaveValue("lv80 bank 0000 4351 9500 1");

  await add({ bic: "examlv2x", bankName: "Example Bank AS", label: "Main" }, true);
  await expect(page.getByRole("status").filter({ hasText: "Account added." })).toBeVisible();
  await expect(accountRow(page, IBAN_A)).toContainText("LV80 BANK 0000 4351 9500 1");
  await expect(accountRow(page, IBAN_A)).toContainText("EXAMLV2X");
  await expect(accountRow(page, IBAN_A).getByTestId("bank-account-default")).toBeVisible();
  await add({ iban: IBAN_B, bankName: "Sample Credit Union" });
  await expect(accountRow(page, IBAN_B)).toBeVisible();
  await add({ iban: IBAN_A });
  await expect(alertOf(page)).toContainText("already used");
  await noHorizontalScroll(page);

  // New invoice: the default account is preselected; choose the other one.
  await page.goto(`/en/companies/${companyId}/documents/new`);
  const newForm = page.getByTestId("new-document-form");
  const picker = newForm.locator("select[name=bankAccountId]");
  const accounts = (
    await (await page.request.get(`/api/companies/${companyId}/bank-accounts`)).json()
  ).bankAccounts as { id: string; iban: string }[];
  const idOf = (iban: string) => accounts.find((a) => a.iban === iban)!.id;
  await expect(picker).toHaveValue(idOf(IBAN_A));
  await newForm.locator("select[name=type]").selectOption("delivery_note");
  await expect(picker).toHaveCount(0); // delivery notes carry no bank details
  await newForm.locator("select[name=type]").selectOption("invoice");
  await picker.selectOption(idOf(IBAN_B));
  await newForm.locator("select[name=currency]").selectOption("EUR");
  await newForm.locator("input[name=issueDate]").fill("2026-03-02");
  await newForm.locator("input[name=buyerName]").fill("Konta Pircējs SIA");
  await noHorizontalScroll(page);
  await newForm.getByRole("button", { name: "Create draft" }).click();
  await expect(page).toHaveURL(/\/documents\/[0-9a-f-]{36}$/);
  const documentUrl = page.url();

  const editor = page.getByTestId("document-editor");
  const bank = editor.getByTestId("document-bank");
  await expect(bank.locator("select[name=bankAccountId]")).toHaveValue(idOf(IBAN_B));
  await expect(bank.getByTestId("document-bank-iban")).toHaveText("LT12 1000 0111 0100 1000");
  await editor.getByRole("button", { name: "Add line" }).click();
  await editor.locator('input[name="lines.0.description"]').fill("Fixture service");
  await editor.locator('input[name="lines.0.unitPrice"]').fill("50");
  await editor.locator('select[name="lines.0.taxCategoryId"]').selectOption(categoryId);
  await editor.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Draft saved." })).toBeVisible();
  await editor.getByRole("button", { name: "Issue document" }).click();
  await page.getByTestId("issue-confirm").getByRole("button", { name: "Issue now" }).click();
  await expect(page.getByTestId("issued-notice")).toContainText("INV-2026-0001");
  const issuedBank = page.getByTestId("document-bank-details");
  await expect(issuedBank).toContainText("Sample Credit Union");
  await expect(issuedBank.getByTestId("document-bank-iban")).toHaveText("LT12 1000 0111 0100 1000");

  // Rename the bank and archive the account; the issued invoice keeps its details.
  await page.goto(accountsUrl);
  const rowB = accountRow(page, IBAN_B);
  await rowB.getByRole("button", { name: "Edit" }).click();
  await rowB.getByTestId("bank-account-edit").locator("input[name=bankName]").fill("Renamed Bank");
  await rowB.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Changes saved." })).toBeVisible();
  await expect(accountRow(page, IBAN_B)).toContainText("Renamed Bank");
  await accountRow(page, IBAN_B).getByRole("button", { name: "Archive" }).click();
  await accountRow(page, IBAN_B)
    .getByTestId("bank-account-archive-confirm")
    .getByRole("button", { name: "Archive" })
    .click();
  await expect(page.getByRole("status").filter({ hasText: "Account archived." })).toBeVisible();
  await expect(accountRow(page, IBAN_B)).toHaveAttribute("data-archived", "true");

  await page.goto(documentUrl);
  await expect(page.getByTestId("document-bank-details")).toContainText("Sample Credit Union");
  await expect(page.getByTestId("document-bank-details")).not.toContainText("Renamed Bank");
});

test("an archived account blocks issuing until another account is chosen", async ({
  page,
  baseURL,
}) => {
  const { companyId, headers, categoryId } = await owner(page, baseURL!);
  const a = await apiAccount(page, companyId, headers, { iban: IBAN_A, isDefault: true });
  const b = await apiAccount(page, companyId, headers, { iban: IBAN_B, bankName: "Sample CU" });
  const res = await page.request.post(`/api/companies/${companyId}/documents`, {
    data: {
      type: "invoice",
      language: "en",
      currency: "EUR",
      issueDate: "2026-03-02",
      buyer: { name: "Bloķēts SIA" },
      bankAccountId: a.id,
      lines: [{ description: "Item", quantity: "1", unitPrice: "10", taxCategoryId: categoryId }],
    },
    headers,
  });
  const documentId = String((await res.json()).document.id);
  const archived = await page.request.patch(`/api/companies/${companyId}/bank-accounts/${a.id}`, {
    data: { expectedVersion: a.version, archived: true },
    headers,
  });
  expect(archived.status()).toBe(200);

  await page.goto(`/en/companies/${companyId}/documents/${documentId}`);
  const editor = page.getByTestId("document-editor");
  const picker = editor.getByTestId("document-bank").locator("select[name=bankAccountId]");
  await expect(picker).toHaveValue(a.id);
  await expect(picker.locator("option:checked")).toContainText("Archived account");
  await expect(
    page.locator('[data-testid="document-issue"][data-code="bankAccount.archived"]'),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await noHorizontalScroll(page);

  await editor.getByRole("button", { name: "Issue document" }).click();
  await page.getByTestId("issue-confirm").getByRole("button", { name: "Issue now" }).click();
  await expect(alertOf(page)).toBeVisible();
  await expect(page.getByTestId("issued-notice")).toHaveCount(0);

  await picker.selectOption(b.id);
  await editor.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Draft saved." })).toBeVisible();
  await expect(
    page.locator('[data-testid="document-issue"][data-code="bankAccount.archived"]'),
  ).toHaveCount(0);
  await editor.getByRole("button", { name: "Issue document" }).click();
  await page.getByTestId("issue-confirm").getByRole("button", { name: "Issue now" }).click();
  // The refused attempt used no number.
  await expect(page.getByTestId("issued-notice")).toContainText("INV-2026-0001");
  await expect(page.getByTestId("document-bank-details")).toContainText("Sample CU");
});
