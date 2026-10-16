import { type Page } from "@playwright/test";
import { secretFromOtpauthUri } from "../support/totp";
import { FIXTURE_TAX, invoiceDraft } from "../support/document-fixtures";
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
 * Draft API input built from the synthetic fixture (no real customer data). Lines reference the
 * company's own tax category by id; the fixture rate is arbitrary, not a real country rate.
 */
function draftInput(taxCategoryId: string | null) {
  const {
    lines,
    relation: _r,
    bankAccounts: _b,
    ...rest
  } = invoiceDraft({ buyer: { name: "Testa Pircējs SIA" } });
  return {
    ...rest,
    lines: lines.map(({ id: _id, sourceLineId: _s, taxCategory: _t, ...l }) => ({
      ...l,
      taxCategoryId,
    })),
  };
}

/** Owner of a new company with a complete seller profile, 2FA (optional) and one draft. */
async function ownerWithDraft(page: Page, baseURL: string, withTwoFactor = true) {
  const email = await createVerifiedUser(page.request, baseURL);
  await signInViaForm(page, email);
  await page.getByTestId("create-company").locator("input[name=name]").fill("Dokumenti SIA");
  await page.getByTestId("create-company").getByRole("button").click();
  const docsLink = page.getByTestId("company-documents-link");
  await expect(docsLink).toBeVisible();
  const documentsUrl = (await docsLink.getAttribute("href"))!;
  const companyId = documentsUrl.split("/").at(-2)!;
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
        name: "Dokumenti SIA",
        legalName: "SIA Dokumenti Tests",
        registrationNumber: "40000000002",
        vatNumber: "LV40000000002",
        addressLine1: "Testa iela 3",
        addressLine2: "",
        postalCode: "LV-1002",
        city: "Rīga",
      },
      headers,
    });
    expect(profile.status()).toBe(200);
  }
  let taxCategoryId: string | null = null;
  if (withTwoFactor) {
    const category = await page.request.post(`/api/companies/${companyId}/tax-categories`, {
      data: FIXTURE_TAX.standard20,
      headers,
    });
    expect(category.status()).toBe(201);
    taxCategoryId = String((await category.json()).taxCategory.id);
  }
  const created = await page.request.post(`/api/companies/${companyId}/documents`, {
    data: draftInput(taxCategoryId),
    headers,
  });
  const documentId = withTwoFactor ? String((await created.json()).document.id) : null;
  return { companyId, documentsUrl, documentId, headers, taxCategoryId };
}

test("list → edit draft → validation on issue → confirm issue → numbered and read-only", async ({
  page,
  baseURL,
}) => {
  const { documentsUrl, documentId } = await ownerWithDraft(page, baseURL!);
  await page.getByTestId("company-documents-link").click();
  await expect(page).toHaveURL(new RegExp(`${documentsUrl}$`));
  const row = page.getByTestId("document-row");
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId("document-number")).toHaveText("Not issued yet");
  await expect(row.getByTestId("document-status")).toHaveText("Draft");

  await row.getByRole("link").click();
  const editor = page.getByTestId("document-editor");
  await expect(editor.locator('input[name="buyer.name"]')).toHaveValue("Testa Pircējs SIA");
  await expect(page.getByTestId("document-gross-total")).toBeVisible();

  // Lines show their catalog category; nothing is chosen implicitly.
  await expect(editor.locator('select[name="lines.0.taxCategoryId"]')).not.toHaveValue("");

  // Business-rule errors are saved as findings and block issuing (server validation).
  await editor.locator('input[name="buyer.name"]').fill("");
  await expect(editor.getByRole("button", { name: "Issue document" })).toBeDisabled();
  await editor.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Draft saved." })).toBeVisible();
  await expect(
    page.getByTestId("document-issue").filter({ hasText: "Enter the buyer's name." }),
  ).toBeVisible();
  await editor.getByRole("button", { name: "Issue document" }).click();
  await page.getByTestId("issue-confirm").getByRole("button", { name: "Issue now" }).click();
  await expect(alertOf(page)).toContainText("cannot be issued yet");
  await expect(editor.locator('input[name="buyer.name"]')).toHaveAttribute("aria-invalid", "true");

  // Fix, save, then issue after confirming; cancelling first changes nothing.
  await editor.locator('input[name="buyer.name"]').fill("Labots Pircējs SIA");
  await editor.locator('input[name="lines.0.quantity"]').fill("3");
  await editor.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Draft saved." })).toBeVisible();
  await editor.getByRole("button", { name: "Issue document" }).click();
  await page.getByTestId("issue-confirm").getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByTestId("issue-confirm")).toHaveCount(0);
  await editor.getByRole("button", { name: "Issue document" }).click();
  await page.getByTestId("issue-confirm").getByRole("button", { name: "Issue now" }).click();

  await expect(page.getByTestId("issued-notice")).toContainText("INV-2026-0001");
  await expect(page.getByTestId("document-heading")).toContainText("INV-2026-0001");
  await expect(page.getByTestId("document-status")).toHaveText("Issued");
  await expect(page.getByTestId("document-editor")).toHaveCount(0);
  await expect(page.locator("input, textarea")).toHaveCount(0);
  await expect(page.getByTestId("document-view")).toContainText("Labots Pircējs SIA");

  await page.reload();
  await expect(page.getByTestId("document-editor")).toHaveCount(0);
  await page.goto(documentsUrl);
  await expect(page.getByTestId("document-number")).toHaveText("INV-2026-0001");
  await expect(page.getByTestId("document-status")).toHaveText("Issued");

  // Phone and tablet widths: list and issued document fit without horizontal page scrolling.
  const overflow = () =>
    page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
  for (const width of [390, 820]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(documentsUrl);
    await expect(page.getByTestId("document-number")).toHaveText("INV-2026-0001");
    expect(await overflow()).toBeLessThanOrEqual(0);
    await page.goto(`${documentsUrl}/${documentId}`);
    await expect(page.getByTestId("document-view")).toBeVisible();
    expect(await overflow()).toBeLessThanOrEqual(0);
  }
});

test("a change made elsewhere is reported as a conflict; reload shows the newer version", async ({
  page,
  baseURL,
}) => {
  const { companyId, documentId, headers, taxCategoryId } = await ownerWithDraft(page, baseURL!);
  await page.goto(`/en/companies/${companyId}/documents/${documentId}`);
  const editor = page.getByTestId("document-editor");
  await expect(editor.locator('input[name="buyer.name"]')).toHaveValue("Testa Pircējs SIA");

  // Another tab saves first (version 1 → 2).
  const other = await page.request.patch(`/api/companies/${companyId}/documents/${documentId}`, {
    data: {
      expectedVersion: 1,
      draft: { ...draftInput(taxCategoryId), notes: "Saved in another tab" },
    },
    headers,
  });
  expect(other.status()).toBe(200);

  await editor.locator('input[name="buyer.name"]').fill("Mana versija SIA");
  await editor.getByRole("button", { name: "Save draft" }).click();
  await expect(alertOf(page)).toContainText("changed elsewhere");
  await alertOf(page).getByRole("button", { name: "Reload" }).click();
  await expect(editor.locator('textarea[name="notes"]')).toHaveValue("Saved in another tab");
  await expect(editor.locator('input[name="buyer.name"]')).toHaveValue("Testa Pircējs SIA");
});

test("access: 2FA required for the owner, other users get 404", async ({
  page,
  browser,
  baseURL,
}) => {
  const { documentsUrl } = await ownerWithDraft(page, baseURL!, false);
  await page.goto(documentsUrl);
  await expect(
    page.getByRole("status").filter({ hasText: "two-factor authentication" }),
  ).toBeVisible();
  await expect(page.getByTestId("document-list")).toHaveCount(0);

  const other = await newDevice(browser);
  const otherPage = await other.newPage();
  await signInViaForm(otherPage, await createVerifiedUser(otherPage.request, baseURL!));
  await expect(otherPage).toHaveURL(/\/en$/);
  expect((await otherPage.goto(documentsUrl))?.status()).toBe(404);

  await other.close();
});
