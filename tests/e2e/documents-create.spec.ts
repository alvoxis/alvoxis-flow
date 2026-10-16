import { type Page } from "@playwright/test";
import { secretFromOtpauthUri } from "../support/totp";
import { FIXTURE_TAX } from "../support/document-fixtures";
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
 * Stage B: "New document" form and deleting drafts (editor and list), on desktop, tablet and
 * phone. Synthetic data only; the fixture tax category is an arbitrary value, not a real rate.
 */

/** Signed-in owner of a new company with 2FA and a complete seller profile. */
async function owner(page: Page, baseURL: string) {
  const email = await createVerifiedUser(page.request, baseURL);
  await signInViaForm(page, email);
  await page.getByTestId("create-company").locator("input[name=name]").fill("Melnraksti SIA");
  await page.getByTestId("create-company").getByRole("button").click();
  const link = page.getByTestId("company-documents-link");
  await expect(link).toBeVisible();
  const documentsUrl = (await link.getAttribute("href"))!;
  const companyId = documentsUrl.split("/").at(-2)!;
  const headers = { origin: baseURL };
  const enable = await page.request.post("/api/auth/two-factor/enable", {
    data: { password: PASSWORD },
    headers,
  });
  const secret = secretFromOtpauthUri(String((await enable.json()).totpURI));
  expect(
    (
      await page.request.post("/api/auth/two-factor/verify-totp", {
        data: { code: totp(secret) },
        headers,
      })
    ).status(),
  ).toBe(200);
  expect(
    (
      await page.request.patch(`/api/companies/${companyId}/profile`, {
        data: {
          name: "Melnraksti SIA",
          legalName: "SIA Melnraksti Tests",
          registrationNumber: "40000000004",
          vatNumber: "LV40000000004",
          addressLine1: "Testa iela 5",
          addressLine2: "",
          postalCode: "LV-1004",
          city: "Rīga",
        },
        headers,
      })
    ).status(),
  ).toBe(200);
  return { email, companyId, documentsUrl, headers };
}

/** A draft created through the API with the same minimal body the form sends. */
async function apiDraft(
  page: Page,
  companyId: string,
  headers: Record<string, string>,
  buyer: string,
) {
  const res = await page.request.post(`/api/companies/${companyId}/documents`, {
    data: {
      type: "invoice",
      language: "en",
      currency: "EUR",
      issueDate: "2026-03-02",
      buyer: { name: buyer },
      lines: [],
    },
    headers,
  });
  expect(res.status()).toBe(201);
  return String((await res.json()).document.id);
}

const row = (page: Page, buyerOrId: string) =>
  page.locator(`[data-testid="document-row"][data-document-id="${buyerOrId}"]`);

const noHorizontalScroll = async (page: Page) =>
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(0);

test("create a draft from the form, add a line with a chosen category and issue it", async ({
  page,
  baseURL,
}) => {
  const { companyId, documentsUrl, headers } = await owner(page, baseURL!);
  const cat = await page.request.post(`/api/companies/${companyId}/tax-categories`, {
    data: FIXTURE_TAX.standard20,
    headers,
  });
  const categoryId = String((await cat.json()).taxCategory.id);

  await page.goto(documentsUrl);
  await page.getByTestId("new-document-link").click();
  const form = page.getByTestId("new-document-form");
  // No credit notes; currency must be chosen explicitly; the date is the browser's today.
  await expect(form.locator("select[name=type] option")).toHaveText([
    "Invoice",
    "Proforma invoice",
    "Delivery note",
  ]);
  await expect(form.locator("select[name=currency]")).toHaveValue("");
  await expect(form.getByRole("button", { name: "Create draft" })).toBeDisabled();
  const browserToday = await page.evaluate(() => {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  });
  await expect(form.locator("input[name=issueDate]")).toHaveValue(browserToday);
  await expect(form.locator("select[name=language]")).toHaveValue("en");

  await form.locator("select[name=currency]").selectOption("EUR");
  await form.locator("input[name=issueDate]").fill("2026-03-02");
  await form.locator("input[name=buyerName]").fill("Jauns Pircējs SIA");
  await noHorizontalScroll(page);
  await form.getByRole("button", { name: "Create draft" }).click();

  await expect(page).toHaveURL(/\/documents\/[0-9a-f-]{36}$/);
  const editor = page.getByTestId("document-editor");
  await expect(editor.locator('input[name="buyer.name"]')).toHaveValue("Jauns Pircējs SIA");
  await editor.getByRole("button", { name: "Add line" }).click();
  await editor.locator('input[name="lines.0.description"]').fill("Fixture service");
  await editor.locator('input[name="lines.0.unitPrice"]').fill("50");
  await editor.locator('select[name="lines.0.taxCategoryId"]').selectOption(categoryId);
  await editor.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Draft saved." })).toBeVisible();
  await editor.getByRole("button", { name: "Issue document" }).click();
  await page.getByTestId("issue-confirm").getByRole("button", { name: "Issue now" }).click();
  await expect(page.getByTestId("issued-notice")).toContainText("INV-2026-0001");
  // Issued documents offer no delete action, here or in the list.
  await expect(page.getByTestId("delete-draft")).toHaveCount(0);
  await page.goto(documentsUrl);
  await expect(page.getByTestId("document-status")).toHaveText("Issued");
  await expect(page.getByTestId("delete-draft")).toHaveCount(0);
});

test("delete drafts from the editor and from the list, with cancel and confirmation", async ({
  page,
  baseURL,
}) => {
  const { companyId, documentsUrl, headers } = await owner(page, baseURL!);
  const fromEditor = await apiDraft(page, companyId, headers, "Dzēšams 1");
  const fromList = await apiDraft(page, companyId, headers, "Dzēšams 2");

  await page.goto(`${documentsUrl}/${fromEditor}`);
  const del = page.getByTestId("delete-draft");
  await del.getByRole("button", { name: "Delete draft" }).click();
  await del.getByTestId("delete-confirm").getByRole("button", { name: "Cancel" }).click();
  await expect(del.getByTestId("delete-confirm")).toHaveCount(0);
  await del.getByRole("button", { name: "Delete draft" }).click();
  await del.getByRole("button", { name: "Delete permanently" }).click();
  await expect(page).toHaveURL(new RegExp(`${documentsUrl}\\?deleted=1$`));
  await expect(page.getByRole("status").filter({ hasText: "Draft deleted." })).toBeVisible();
  await expect(row(page, fromEditor)).toHaveCount(0);

  const listDel = row(page, fromList).getByTestId("delete-draft");
  await listDel.getByRole("button", { name: "Delete draft" }).click();
  await listDel.getByRole("button", { name: "Cancel" }).click();
  await expect(row(page, fromList)).toHaveCount(1);
  await page.setViewportSize({ width: 390, height: 844 });
  await noHorizontalScroll(page);
  await listDel.getByRole("button", { name: "Delete draft" }).click();
  await listDel.getByRole("button", { name: "Delete permanently" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Draft deleted." })).toBeVisible();
  await expect(row(page, fromList)).toHaveCount(0);
  await expect(page.getByTestId("documents-empty")).toBeVisible();
});

test("a draft issued meanwhile cannot be deleted: 409 with a reload", async ({ page, baseURL }) => {
  const { companyId, documentsUrl, headers } = await owner(page, baseURL!);
  const cat = await page.request.post(`/api/companies/${companyId}/tax-categories`, {
    data: FIXTURE_TAX.standard20,
    headers,
  });
  const categoryId = String((await cat.json()).taxCategory.id);
  const res = await page.request.post(`/api/companies/${companyId}/documents`, {
    data: {
      type: "invoice",
      language: "en",
      currency: "EUR",
      issueDate: "2026-03-02",
      buyer: { name: "Steidzams SIA" },
      lines: [{ description: "Item", quantity: "1", unitPrice: "10", taxCategoryId: categoryId }],
    },
    headers,
  });
  const id = String((await res.json()).document.id);
  await page.goto(documentsUrl);
  // Issued in another tab after the list was loaded.
  expect(
    (
      await page.request.post(`/api/companies/${companyId}/documents/${id}/issue`, {
        data: { expectedVersion: 1 },
        headers,
      })
    ).status(),
  ).toBe(200);
  const listDel = row(page, id).getByTestId("delete-draft");
  await listDel.getByRole("button", { name: "Delete draft" }).click();
  await listDel.getByRole("button", { name: "Delete permanently" }).click();
  await expect(alertOf(page)).toContainText("already been issued");
  await alertOf(page).getByRole("button", { name: "Reload" }).click();
  await expect(row(page, id).getByTestId("document-status")).toHaveText("Issued");
  await expect(row(page, id).getByTestId("delete-draft")).toHaveCount(0);
});

test("a view-only role sees no create or delete actions; the API refuses them", async ({
  page,
  browser,
  baseURL,
}) => {
  test.skip(!E2E_SQL_AVAILABLE, "needs the isolated e2e database (E2E_DATABASE_URL)");
  const { companyId, documentsUrl, headers } = await owner(page, baseURL!);
  const id = await apiDraft(page, companyId, headers, "Skatāms SIA");

  const other = await newDevice(browser);
  const viewer = await other.newPage();
  const email = await createVerifiedUser(viewer.request, baseURL!);
  // Membership with the warehouse role (documents.view only), set up in the e2e database.
  const db = e2eDatabase();
  try {
    await db.query(
      `INSERT INTO memberships (company_id, user_id, role_id)
       SELECT $1, u.id, r.id FROM users u, roles r
       WHERE u.email = $2 AND r.company_id = $1 AND r.key = 'warehouse_employee'`,
      [companyId, email],
    );
  } finally {
    await db.end();
  }
  await signInViaForm(viewer, email);
  await expect(viewer).toHaveURL(/\/en$/);
  await viewer.goto(documentsUrl);
  await expect(row(viewer, id)).toHaveCount(1);
  await expect(viewer.getByTestId("new-document-link")).toHaveCount(0);
  await expect(viewer.getByTestId("delete-draft")).toHaveCount(0);
  await viewer.goto(`${documentsUrl}/${id}`);
  await expect(viewer.getByTestId("delete-draft")).toHaveCount(0);
  await viewer.goto(`${documentsUrl}/new`);
  await expect(viewer.getByTestId("new-document-form")).toHaveCount(0);
  await expect(viewer.getByRole("status").filter({ hasText: "cannot create" })).toBeVisible();
  const refused = await viewer.request.delete(`/api/companies/${companyId}/documents/${id}`, {
    headers: { origin: baseURL! },
  });
  expect(refused.status()).toBe(403);
  await other.close();
});

for (const [timezoneId, expected] of [
  ["Pacific/Kiritimati", "2026-03-02"], // UTC+14: already 2 March
  ["America/Los_Angeles", "2026-03-01"], // UTC−8: still 1 March
] as const) {
  test(`issue date defaults to the browser's calendar day (${timezoneId})`, async ({
    browser,
    baseURL,
  }) => {
    const context = await newDevice(browser, { timezoneId });
    const page = await context.newPage();
    const { documentsUrl } = await owner(page, baseURL!);
    await page.clock.setFixedTime(new Date("2026-03-01T23:30:00Z"));
    await page.goto(`${documentsUrl}/new`);
    await expect(
      page.getByTestId("new-document-form").locator("input[name=issueDate]"),
    ).toHaveValue(expected);
    await context.close();
  });
}
