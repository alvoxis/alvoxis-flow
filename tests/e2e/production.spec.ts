import { ownerWithIssuedInvoice } from "./document-helpers";
import { alertOf, expect, test } from "./support";

/**
 * Production page: a bill of materials, planning an order, a refused completion while stock is
 * short, completing it after a receipt. Synthetic data only. Runs on desktop, tablet and phone.
 */
test("production: bill of materials, plan, short stock, complete", async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  const { companyId, headers } = await ownerWithIssuedInvoice(page, baseURL!);
  const api = `/api/companies/${companyId}`;
  const product = async (name: string) =>
    String(
      (
        await (
          await page.request.post(`${api}/products`, { data: { name, trackStock: true }, headers })
        ).json()
      ).product.id,
    );
  await product("Galds (TEST)");
  const leg = await product("Galda kāja");
  const warehouse = await page.request.post(`${api}/warehouses`, {
    data: { code: "MAIN", name: "Galvenā" },
    headers,
  });
  const warehouseId = String((await warehouse.json()).warehouse.id);

  await page.goto("/en/production");
  await expect(page).toHaveURL(new RegExp(`/en/companies/${companyId}/production$`));
  await expect(page.getByTestId("orders-empty")).toBeVisible();

  // Bill of materials: a table needs 4 legs.
  const editor = page.getByTestId("bom-editor");
  await editor.locator("select[name=bomProductId]").selectOption({ label: "Galds (TEST)" });
  await editor.getByRole("button", { name: "Add component" }).click();
  await editor
    .locator('select[name="components.0.componentId"]')
    .selectOption({ label: "Galda kāja" });
  await editor.locator('input[name="components.0.quantity"]').fill("4");
  await editor.getByRole("button", { name: "Save bill of materials" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Bill of materials saved." }),
  ).toBeVisible();
  await expect(page.getByTestId("bom-row")).toContainText("Galda kāja × 4");

  // Plan 2 tables: needs 8 legs.
  const plan = page.getByTestId("production-plan");
  await plan.locator("select[name=productId]").selectOption({ label: "Galds (TEST)" });
  await plan.locator("input[name=quantity]").fill("2");
  await plan.getByRole("button", { name: "Plan order" }).click();
  const order = page.getByTestId("order-row").filter({ hasText: "PRD-" });
  await expect(order).toHaveAttribute("data-status", "planned");
  await expect(order).toContainText("8 pcs");
  await expect(order).toContainText("available 0");

  // Not enough legs: refused, nothing changes.
  await order.getByRole("button", { name: "Complete" }).click();
  await expect(order.getByTestId("document-issue")).toContainText("Not enough stock");
  await expect(alertOf(page)).toBeVisible();

  const receipt = await page.request.post(`${api}/stock/operations`, {
    data: { kind: "receipt", productId: leg, warehouseId, quantity: "8", occurredOn: "2026-03-02" },
    headers,
  });
  expect(receipt.status()).toBe(201);
  await page.reload();
  await expect(order).toContainText("available 8");
  await order.getByRole("button", { name: "Complete" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "completed; stock updated" }),
  ).toBeVisible();
  await expect(order).toHaveAttribute("data-status", "completed");

  await page.goto(`/en/companies/${companyId}/inventory`);
  await expect(page.getByTestId("stock-row").filter({ hasText: "Galds (TEST)" })).toHaveAttribute(
    "data-total",
    "2",
  );
  await expect(page.getByTestId("stock-row").filter({ hasText: "Galda kāja" })).toHaveAttribute(
    "data-total",
    "0",
  );
});
