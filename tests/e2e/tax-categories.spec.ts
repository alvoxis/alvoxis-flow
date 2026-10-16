import { type Page } from "@playwright/test";
import { secretFromOtpauthUri } from "../support/totp";
import { FIXTURE_TAX, invoiceDraft } from "../support/document-fixtures";
import { E2E_SQL_AVAILABLE, e2eDatabase } from "./e2e-db";
import {
  alertOf,
  createVerifiedUser,
  expect,
  newDevice,
  PASSWORD,
  signInViaForm,
  test,
  totp,
} from "./support";

/**
 * Tax-category catalog page and the category picker in the document editor (stage C2). Fixture
 * categories are arbitrary values, not real country rates; all data is synthetic. Runs on the
 * desktop, tablet and phone projects.
 */

/** Owner of a new company with 2FA (optional) and a complete seller profile. */
async function owner(page: Page, baseURL: string, withTwoFactor = true) {
  await signInViaForm(page, await createVerifiedUser(page.request, baseURL));
  await page.getByTestId("create-company").locator("input[name=name]").fill("Kategorijas SIA");
  await page.getByTestId("create-company").getByRole("button").click();
  const link = page.getByTestId("company-tax-categories-link");
  await expect(link).toBeVisible();
  const catalogUrl = (await link.getAttribute("href"))!;
  const companyId = catalogUrl.split("/").at(-2)!;
  const headers = { origin: baseURL };
  if (withTwoFactor) {
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
        name: "Kategorijas SIA",
        legalName: "SIA Kategorijas Tests",
        registrationNumber: "40000000003",
        vatNumber: "LV40000000003",
        addressLine1: "Testa iela 4",
        addressLine2: "",
        postalCode: "LV-1003",
        city: "Rīga",
      },
      headers,
    });
    expect(profile.status()).toBe(200);
  }
  return { companyId, catalogUrl, headers };
}

async function createCategory(
  page: Page,
  companyId: string,
  headers: Record<string, string>,
  cat: object,
) {
  const res = await page.request.post(`/api/companies/${companyId}/tax-categories`, {
    data: cat,
    headers,
  });
  expect(res.status()).toBe(201);
  return (await res.json()).taxCategory as { id: string; version: number };
}

async function createDraft(
  page: Page,
  companyId: string,
  headers: Record<string, string>,
  taxCategoryId: string | null,
  bankAccountId?: string,
) {
  const {
    lines,
    relation: _r,
    bankAccounts: _b,
    ...rest
  } = invoiceDraft({ buyer: { name: "Testa Pircējs SIA" } });
  const res = await page.request.post(`/api/companies/${companyId}/documents`, {
    data: {
      ...rest,
      ...(bankAccountId ? { bankAccountId } : {}),
      lines: lines.map(({ id: _i, sourceLineId: _s, taxCategory: _t, ...l }) => ({
        ...l,
        taxCategoryId,
      })),
    },
    headers,
  });
  expect(res.status()).toBe(201);
  return String((await res.json()).document.id);
}

const noHorizontalScroll = async (page: Page) =>
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(0);

test("catalog: empty hint, create, duplicate code, edit label, archive and restore", async ({
  page,
  baseURL,
}) => {
  const { companyId, headers } = await owner(page, baseURL!);
  // The documents page points an owner with an empty catalog to the setup page.
  await page.getByTestId("company-documents-link").click();
  const hint = page.getByTestId("no-tax-categories");
  await expect(hint).toBeVisible();
  await hint.getByRole("link").click();
  await expect(page.getByTestId("tax-categories-empty")).toBeVisible();
  await noHorizontalScroll(page);

  const form = page.getByTestId("tax-category-create");
  const fill = async (code: string, kind: string, rate: string, label: string) => {
    await form.locator("input[name=code]").fill(code);
    await form.locator("select[name=kind]").selectOption(kind);
    await form.locator("input[name=ratePercent]").fill(rate);
    await form.locator("input[name=label]").fill(label);
    await form.getByRole("button", { name: "Add category" }).click();
  };
  await fill("T20", "standard", "20", "Fixture 20%");
  await expect(page.getByRole("status").filter({ hasText: "Category added." })).toBeVisible();
  const row = page.getByTestId("tax-category-row").filter({ hasText: "T20" });
  await expect(row).toContainText("Fixture 20%");
  await expect(row).toContainText("Active");

  // Server checks: duplicate code and a 0 % "standard" rate.
  await fill("T20", "standard", "20", "Again");
  await expect(alertOf(page)).toContainText("already used");
  await fill("S0", "standard", "0", "Zero");
  await expect(page.getByTestId("document-issue")).toContainText("0%");
  await expect(form.locator("input[name=code]")).toHaveValue("S0"); // input kept for correction

  // Edit label/note (code, treatment and rate are read-only by design).
  await row.getByRole("button", { name: "Edit" }).click();
  const edit = row.getByTestId("tax-category-edit");
  await edit.locator("input[name=label]").fill("Fixture standard");
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Changes saved." })).toBeVisible();
  await expect(row.getByTestId("tax-category-label")).toHaveText("Fixture standard");

  // Archive needs confirmation; restore brings it back.
  await row.getByRole("button", { name: "Archive" }).click();
  await row
    .getByTestId("tax-category-archive-confirm")
    .getByRole("button", { name: "Archive" })
    .click();
  await expect(row).toHaveAttribute("data-archived", "true");
  await row.getByRole("button", { name: "Restore" }).click();
  await expect(row).toHaveAttribute("data-archived", "false");

  // A change made elsewhere is a version conflict with a reload.
  const list = await page.request.get(`/api/companies/${companyId}/tax-categories`);
  const current = (await list.json()).taxCategories[0];
  await page.request.patch(`/api/companies/${companyId}/tax-categories/${current.id}`, {
    data: { expectedVersion: current.version, label: "Changed elsewhere" },
    headers,
  });
  await row.getByRole("button", { name: "Edit" }).click();
  await row.getByTestId("tax-category-edit").locator("input[name=label]").fill("Mine");
  await row.getByTestId("tax-category-edit").getByRole("button", { name: "Save" }).click();
  await expect(alertOf(page)).toContainText("changed elsewhere");
  await alertOf(page).getByRole("button", { name: "Reload" }).click();
  await expect(row.getByTestId("tax-category-label")).toHaveText("Changed elsewhere");
  await noHorizontalScroll(page);
});

test("invoice: choose categories explicitly, add a line, save, reopen and issue", async ({
  page,
  baseURL,
}) => {
  const { companyId, headers } = await owner(page, baseURL!);
  const cat = await createCategory(page, companyId, headers, FIXTURE_TAX.standard20);
  const old = await createCategory(page, companyId, headers, FIXTURE_TAX.zero);
  await page.request.patch(`/api/companies/${companyId}/tax-categories/${old.id}`, {
    data: { expectedVersion: 1, archived: true },
    headers,
  });
  // A company bank account, so the issued invoice has no findings at all.
  const account = await page.request.post(`/api/companies/${companyId}/bank-accounts`, {
    data: { iban: "LV80BANK0000435195001", isDefault: true },
    headers,
  });
  expect(account.status()).toBe(201);
  const bankAccountId = String((await account.json()).bankAccount.id);
  const documentId = await createDraft(page, companyId, headers, null, bankAccountId);
  await page.goto(`/en/companies/${companyId}/documents/${documentId}`);
  const editor = page.getByTestId("document-editor");
  const select = (i: number) => editor.locator(`select[name="lines.${i}.taxCategoryId"]`);

  // Nothing is preselected and archived categories are not offered.
  await expect(select(0)).toHaveValue("");
  await expect(select(0).locator(`option[value="${old.id}"]`)).toHaveCount(0);
  await editor.getByRole("button", { name: "Add line" }).click();
  await expect(select(2)).toHaveValue("");
  await editor.locator('input[name="lines.2.description"]').fill("Fixture service");
  await editor.locator('input[name="lines.2.unitPrice"]').fill("5");
  for (const i of [0, 1, 2]) await select(i).selectOption(cat.id);
  await editor.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Draft saved." })).toBeVisible();
  await noHorizontalScroll(page);

  await page.reload();
  for (const i of [0, 1, 2]) await expect(select(i)).toHaveValue(cat.id);
  await expect(page.getByTestId("document-issue")).toHaveCount(0);
  await editor.getByRole("button", { name: "Issue document" }).click();
  await page.getByTestId("issue-confirm").getByRole("button", { name: "Issue now" }).click();
  await expect(page.getByTestId("issued-notice")).toContainText("INV-2026-0001");
  await expect(page.getByTestId("document-editor")).toHaveCount(0);
  await expect(page.locator('input[name^="lines."], select[name^="lines."], textarea')).toHaveCount(
    0,
  );
  await expect(page.getByTestId("document-lines")).toContainText("Fixture 20%");
});

test("old draft: warning, data kept on save, restore before save, explicit choice to issue", async ({
  page,
  baseURL,
}) => {
  test.skip(!E2E_SQL_AVAILABLE, "needs the isolated e2e database (E2E_DATABASE_URL)");
  const { companyId, headers } = await owner(page, baseURL!);
  const cat = await createCategory(page, companyId, headers, FIXTURE_TAX.standard20);
  const documentId = await createDraft(page, companyId, headers, cat.id);
  // Simulate a draft saved before the catalog existed: snapshot kept, link removed.
  const db = e2eDatabase();
  try {
    await db.query(`UPDATE document_lines SET tax_category_id = NULL WHERE document_id = $1`, [
      documentId,
    ]);
  } finally {
    await db.end();
  }

  await page.goto(`/en/companies/${companyId}/documents/${documentId}`);
  const editor = page.getByTestId("document-editor");
  const warnings = editor.getByTestId("legacy-warning");
  await expect(warnings).toHaveCount(2);
  await expect(warnings.first()).toContainText("Fixture 20%");

  // Issuing is blocked with an explanation, and no number is used.
  await editor.getByRole("button", { name: "Issue document" }).click();
  await page.getByTestId("issue-confirm").getByRole("button", { name: "Issue now" }).click();
  await expect(alertOf(page)).toContainText("cannot be issued yet");
  await expect(
    page
      .getByTestId("document-issue")
      .filter({ hasText: "before the company's tax category list" }),
  ).toHaveCount(2);

  // An unrelated save keeps the old tax data.
  await editor.locator('textarea[name="notes"]').fill("Edited, tax untouched");
  await editor.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Draft saved." })).toBeVisible();
  await page.reload();
  await expect(editor.getByTestId("legacy-warning")).toHaveCount(2);

  // Choosing and then "Restore previous value" before saving brings the old value back.
  const select = editor.locator('select[name="lines.0.taxCategoryId"]');
  await select.selectOption(cat.id);
  await expect(editor.getByTestId("legacy-warning")).toHaveCount(1);
  await editor.getByRole("button", { name: "Restore previous value" }).click();
  await expect(editor.getByTestId("legacy-warning")).toHaveCount(2);
  await expect(select).toHaveValue("");

  // Explicit choice on every line, save, issue.
  await select.selectOption(cat.id);
  await editor.locator('select[name="lines.1.taxCategoryId"]').selectOption(cat.id);
  await editor.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Draft saved." })).toBeVisible();
  await expect(editor.getByTestId("legacy-warning")).toHaveCount(0);
  await expect(editor.getByRole("button", { name: "Restore previous value" })).toHaveCount(0);
  await editor.getByRole("button", { name: "Issue document" }).click();
  await page.getByTestId("issue-confirm").getByRole("button", { name: "Issue now" }).click();
  await expect(page.getByTestId("issued-notice")).toContainText("INV-2026-0001");
  await noHorizontalScroll(page);
});

test("access: other users get 404, owners without 2FA see the 2FA notice", async ({
  page,
  browser,
  baseURL,
}) => {
  const { catalogUrl } = await owner(page, baseURL!, false);
  await page.goto(catalogUrl);
  await expect(
    page.getByRole("status").filter({ hasText: "two-factor authentication" }),
  ).toBeVisible();
  await expect(page.getByTestId("tax-category-manager")).toHaveCount(0);

  const other = await newDevice(browser);
  const otherPage = await other.newPage();
  await signInViaForm(otherPage, await createVerifiedUser(otherPage.request, baseURL!));
  await expect(otherPage).toHaveURL(/\/en$/);
  expect((await otherPage.goto(catalogUrl))?.status()).toBe(404);
  await other.close();
});
