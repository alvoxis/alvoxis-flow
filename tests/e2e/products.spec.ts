import { createDocument, ownerWithIssuedInvoice } from "./document-helpers";
import { alertOf, expect, test } from "./support";

/**
 * Product catalog page and the "Add from catalog" picker in the document editor. Synthetic data
 * only. Runs on desktop, tablet and phone.
 */
test("products: add with a default tax category, refuse a duplicate SKU, add to a draft, archive", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const { companyId, headers, taxCategoryId } = await ownerWithIssuedInvoice(page, baseURL!);

  await page.goto("/en/products");
  await expect(page).toHaveURL(new RegExp(`/en/companies/${companyId}/products$`));
  await expect(page.getByTestId("products-empty")).toBeVisible();

  await page.getByTestId("product-add").click();
  const form = page.getByTestId("product-form");
  await form.locator("input[name=name]").fill("Darba cimdi (TEST)");
  await form.locator("input[name=sku]").fill("dc-01");
  await form.locator("input[name=unit]").fill("pair");
  await form.locator("input[name=salePrice]").fill("4,75");
  await form.locator("select[name=taxCategoryId]").selectOption({ index: 1 });
  await form.locator("input[name=trackStock]").check();
  await form.getByRole("button", { name: "Add", exact: true }).click();
  const row = page.getByTestId("product-row").filter({ hasText: "Darba cimdi (TEST)" });
  await expect(row).toContainText("DC-01");
  await expect(row).toContainText("4.75 EUR");
  await expect(row).toContainText("Stock tracked");

  // Invalid price and a duplicate SKU are reported.
  await page.getByTestId("product-add").click();
  await form.locator("input[name=name]").fill("Dublikāts");
  await form.locator("input[name=sku]").fill("DC-01");
  await form.getByRole("button", { name: "Add", exact: true }).click();
  await expect(alertOf(page)).toContainText("SKU already exists");
  await form.locator("input[name=sku]").fill("DC-02");
  await form.locator("input[name=salePrice]").fill("abc");
  await form.getByRole("button", { name: "Add", exact: true }).click();
  await expect(form.getByTestId("document-issue")).toContainText("Enter a price like 12.50");
  await form.getByRole("button", { name: "Cancel" }).click();

  // The editor adds a line from the catalog with name, unit, price and tax category.
  const draftId = await createDocument(page, companyId, headers, taxCategoryId);
  await page.goto(`/en/companies/${companyId}/documents/${draftId}`);
  const lines = page.locator('input[name$=".description"]');
  const before = await lines.count();
  await page.getByLabel("Add from catalog").selectOption({ label: "Darba cimdi (TEST) (DC-01)" });
  await expect(lines).toHaveCount(before + 1);
  await expect(lines.nth(before)).toHaveValue("Darba cimdi (TEST)");
  await expect(page.locator(`input[name="lines.${before}.unitPrice"]`)).toHaveValue("4.75");
  await expect(page.locator(`input[name="lines.${before}.unit"]`)).toHaveValue("pair");

  await page.goto(`/en/companies/${companyId}/products`);
  await row.getByRole("button", { name: "Archive" }).click();
  await page
    .getByTestId("product-archive-confirm")
    .getByRole("button", { name: "Archive" })
    .click();
  await expect(page.getByRole("status").filter({ hasText: "Product archived." })).toBeVisible();
  await expect(row).toHaveCount(0);
});
