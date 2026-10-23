import { createDocument, ownerWithIssuedInvoice } from "./document-helpers";
import { alertOf, expect, test } from "./support";

/**
 * Customers and suppliers pages and the customer picker in the document editor. Synthetic data
 * only. Runs on desktop, tablet and phone.
 */
test("customers: add, find, make a supplier too, fill a draft's buyer, archive", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const { companyId, headers, taxCategoryId } = await ownerWithIssuedInvoice(page, baseURL!);

  // The navigation entry goes straight to the only company's customers.
  await page.goto("/en/customers");
  await expect(page).toHaveURL(new RegExp(`/en/companies/${companyId}/customers$`));
  await expect(page.getByTestId("counterparties-empty")).toBeVisible();

  await page.getByTestId("counterparty-add").click();
  const form = page.getByTestId("counterparty-form");
  await form.locator("input[name=name]").fill("Pircējs Tests SIA");
  await form.locator("input[name=registrationNumber]").fill("40000000099");
  await form.locator("input[name=vatNumber]").fill("lv40000000099");
  await form.locator("input[name=email]").fill("pircejs@example.test");
  await form.locator("input[name=paymentTermDays]").fill("10");
  await form.locator("input[name=city]").fill("Rīga");
  await form.getByRole("button", { name: "Add", exact: true }).click();
  const row = page.getByTestId("counterparty-row").filter({ hasText: "Pircējs Tests SIA" });
  await expect(row).toBeVisible();
  await expect(row).toContainText("LV40000000099");
  await expect(row).toContainText("Payment term: 10 days");

  // A second record with the same registration number is refused.
  await page.getByTestId("counterparty-add").click();
  await form.locator("input[name=name]").fill("Dublikāts SIA");
  await form.locator("input[name=registrationNumber]").fill("40000000099");
  await form.getByRole("button", { name: "Add", exact: true }).click();
  await expect(alertOf(page)).toContainText("registration number already exists");
  await form.getByRole("button", { name: "Cancel" }).click();

  // Search filters the list.
  await page.getByLabel("Search").fill("nothing-like-this");
  await expect(page.getByTestId("counterparties-empty")).toContainText("Nothing matches");
  await page.getByLabel("Search").fill("pircējs");
  await expect(row).toBeVisible();

  // Make it a supplier as well: it then appears on the suppliers page.
  await row.getByRole("button", { name: "Edit" }).click();
  await row.getByLabel("Supplier").check();
  await row.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Changes saved." })).toBeVisible();
  await page.goto(`/en/companies/${companyId}/suppliers`);
  await expect(
    page.getByTestId("counterparty-row").filter({ hasText: "Pircējs Tests SIA" }),
  ).toBeVisible();

  // The draft editor fills the buyer (and an invoice's due date) from the customer.
  const draftId = await createDocument(page, companyId, headers, taxCategoryId, {
    buyer: { name: "Placeholder" },
  });
  await page.goto(`/en/companies/${companyId}/documents/${draftId}`);
  await page
    .getByLabel("Fill in from customers")
    .selectOption({ label: "Pircējs Tests SIA (40000000099)" });
  await expect(page.locator('input[name="buyer.name"]')).toHaveValue("Pircējs Tests SIA");
  await expect(page.locator('input[name="buyer.vatNumber"]')).toHaveValue("LV40000000099");
  await expect(page.locator('input[name="buyer.email"]')).toHaveValue("pircejs@example.test");

  // Archive: hidden from the list until "Show archived".
  await page.goto(`/en/companies/${companyId}/customers`);
  const archiveRow = page.getByTestId("counterparty-row").filter({ hasText: "Pircējs Tests SIA" });
  await archiveRow.getByRole("button", { name: "Archive" }).click();
  await page
    .getByTestId("counterparty-archive-confirm")
    .getByRole("button", { name: "Archive" })
    .click();
  await expect(page.getByRole("status").filter({ hasText: "Record archived." })).toBeVisible();
  await expect(archiveRow).toHaveCount(0);
  await page.getByLabel("Show archived").check();
  await expect(archiveRow).toHaveAttribute("data-archived", "true");
});
