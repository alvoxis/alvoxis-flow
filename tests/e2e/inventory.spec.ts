import { ownerWithIssuedInvoice } from "./document-helpers";
import { alertOf, expect, test } from "./support";

/**
 * Warehouse page: warehouses, receipts, issues, transfers and counts, and the zero floor.
 * Synthetic data only. Runs on desktop, tablet and phone.
 */
test("inventory: warehouses, receipt, refused over-issue, transfer, count", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const { companyId, headers } = await ownerWithIssuedInvoice(page, baseURL!);
  const product = await page.request.post(`/api/companies/${companyId}/products`, {
    data: { name: "Ķiveres (TEST)", unit: "pcs", trackStock: true, purchasePrice: "12.5" },
    headers,
  });
  expect(product.status()).toBe(201);

  await page.goto("/en/inventory");
  await expect(page).toHaveURL(new RegExp(`/en/companies/${companyId}/inventory$`));
  await expect(page.getByText("No warehouses yet")).toBeVisible();

  const create = page.getByTestId("warehouse-create");
  const stores: [string, string][] = [
    ["main", "Galvenā noliktava"],
    ["RIGA", "Rīgas filiāle"],
  ];
  for (const [code, name] of stores) {
    await create.locator("input[name=code]").fill(code);
    await create.locator("input[name=name]").fill(name);
    await create.getByRole("button", { name: "Add warehouse" }).click();
    await expect(
      page.getByTestId("warehouse-row").filter({ hasText: code.toUpperCase() }),
    ).toBeVisible();
  }
  await expect(page.getByTestId("warehouse-row").filter({ hasText: "MAIN" })).toContainText(
    "Default",
  );

  const form = page.getByTestId("stock-operation");
  const stockRow = page.getByTestId("stock-row").filter({ hasText: "Ķiveres (TEST)" });
  // Receipt of 10 into MAIN (the default warehouse is preselected).
  await form.locator("select[name=productId]").selectOption({ label: "Ķiveres (TEST)" });
  await form.locator("input[name=quantity]").fill("10");
  await form.getByRole("button", { name: "Record receipt" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Receipt recorded." })).toBeVisible();
  await expect(stockRow).toHaveAttribute("data-total", "10");
  await expect(page.getByTestId("stock-value")).toContainText("125.00 EUR");

  // Issuing more than the balance is refused.
  await form.locator("select[name=kind]").selectOption("issue");
  await form.locator("select[name=productId]").selectOption({ label: "Ķiveres (TEST)" });
  await form.locator("input[name=quantity]").fill("11");
  await form.getByRole("button", { name: "Record issue" }).click();
  await expect(form.getByTestId("document-issue")).toContainText("Not enough stock");
  await expect(alertOf(page)).toBeVisible();

  // Transfer 4 to RIGA, then count RIGA at 3 (one missing).
  await form.locator("select[name=kind]").selectOption("transfer");
  await form.locator("select[name=productId]").selectOption({ label: "Ķiveres (TEST)" });
  await form.locator("select[name=toWarehouseId]").selectOption({ label: "RIGA · Rīgas filiāle" });
  await form.locator("input[name=quantity]").fill("4");
  await form.getByRole("button", { name: "Record transfer" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Transfer recorded." })).toBeVisible();
  await expect(stockRow).toContainText("MAIN: 6");
  await expect(stockRow).toContainText("RIGA: 4");

  await form.locator("select[name=kind]").selectOption("count");
  await form.locator("select[name=productId]").selectOption({ label: "Ķiveres (TEST)" });
  await form.locator("select[name=warehouseId]").selectOption({ label: "RIGA · Rīgas filiāle" });
  await form.locator("input[name=quantity]").fill("3");
  await form.getByRole("button", { name: "Record count" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Count recorded." })).toBeVisible();
  await expect(stockRow).toHaveAttribute("data-total", "9");
  await expect(page.getByTestId("movement-row").first()).toHaveAttribute("data-kind", "adjustment");

  // A warehouse that holds stock cannot be archived.
  await page
    .getByTestId("warehouse-row")
    .filter({ hasText: "RIGA" })
    .getByRole("button", { name: "Archive" })
    .click();
  await expect(alertOf(page)).toContainText("still holds stock");
});
