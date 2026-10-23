import { ownerWithIssuedInvoice } from "./document-helpers";
import { expect, test } from "./support";

/**
 * Analytics (sales chart with hover readout and table view) and the settings hub; no navigation
 * entry is "coming soon" any more. Synthetic data only. Runs on desktop, tablet and phone.
 */
test("analytics shows the year's net sales; settings links and members; no 'soon' entries", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const { companyId } = await ownerWithIssuedInvoice(page, baseURL!);

  await page.goto("/en/analytics?year=2026");
  await expect(page).toHaveURL(new RegExp(`/en/companies/${companyId}/analytics`));
  await page.goto(`/en/companies/${companyId}/analytics?year=2026`);
  const chart = page.getByTestId("sales-chart").filter({ hasText: "EUR" });
  // INV-2026-0001: 10 × 65.00 + 10 × 45.00 net.
  await expect(chart.getByTestId("sales-total")).toHaveText("1100.00 EUR");
  await chart.getByRole("button", { name: "March: 1100.00 EUR" }).focus();
  await expect(chart.getByTestId("sales-readout")).toContainText("March: 1100.00 EUR");
  await chart.getByText("Show as a table").click();
  await expect(chart.getByTestId("sales-table")).toContainText("1100.00 EUR");
  await expect(page.getByTestId("top-items")).toContainText("Winter jacket");

  await page.goto("/en/settings");
  await expect(page).toHaveURL(new RegExp(`/en/companies/${companyId}/settings$`));
  for (const key of ["profile", "taxCategories", "bankAccounts", "warehouses", "payrollRates"])
    await expect(page.getByTestId(`settings-${key}`)).toBeVisible();
  await expect(page.getByTestId("member-row")).toHaveCount(1);
  await expect(page.getByTestId("member-row")).toContainText("(you)");

  // No navigation entry says "soon".
  await expect(page.locator('[aria-disabled="true"]')).toHaveCount(0);
});
