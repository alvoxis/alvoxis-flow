import AxeBuilder from "@axe-core/playwright";
import { ownerWithIssuedInvoice } from "./document-helpers";
import { expect, test } from "./support";

/**
 * Money flow end to end: the owner records a payment on an issued invoice (status changes from
 * the server's answer), adds an expense on the Finance page, and the business overview shows the
 * figures from those records, with working quick actions, a table view of the chart, no
 * horizontal scrolling and no accessibility violations. Runs on desktop, tablet and phone.
 * The invoice is 1100.00 net + 20 % fixture tax = 1320.00 EUR (synthetic data, arbitrary rate).
 */
test("payments, expenses and the business overview work together", async ({ page, baseURL }) => {
  test.setTimeout(150_000);
  const { companyId, invoiceUrl } = await ownerWithIssuedInvoice(page, baseURL!);

  await page.goto(invoiceUrl);
  const panel = page.getByTestId("payments-panel");
  await expect(panel.getByTestId("payment-status")).toHaveText("Unpaid");
  await expect(panel.getByTestId("payments-balance")).toContainText("1,320.00");
  await panel.locator("input[name=amount]").fill("320");
  await panel.locator("input[name=paidOn]").fill("2026-03-10");
  await panel.getByTestId("payment-record").click();
  await expect(panel.getByTestId("payment-status")).toHaveText("Partially paid");
  await expect(panel.getByTestId("payments-balance")).toContainText("1,000.00");
  // More than the open balance is refused by the server.
  await panel.locator("input[name=amount]").fill("1000.01");
  await panel.getByTestId("payment-record").click();
  await expect(panel.getByRole("alert")).toBeVisible();
  await expect(panel.getByTestId("payment-status")).toHaveText("Partially paid");

  await page.goto(`/en/companies/${companyId}/finance`);
  await expect(page.getByTestId("expenses-empty")).toBeVisible();
  await page.getByTestId("expense-add").click();
  const form = page.getByTestId("expense-form");
  await form.locator("input[name=description]").fill("Workshop rent March");
  await form.locator("input[name=expenseDate]").fill("2026-03-05");
  await form.locator("input[name=netAmount]").fill("200");
  await form.locator("input[name=taxAmount]").fill("42");
  await form.getByTestId("expense-save").click();
  await expect(page.getByTestId("expense-row")).toHaveCount(1);
  await expect(page.getByTestId("expense-row")).toContainText("€242.00");

  await page.goto(
    `/en/companies/${companyId}/dashboard?range=custom&from=2026-03-01&to=2026-03-31`,
  );
  const kpis = page.getByTestId("kpis-EUR");
  await expect(kpis.getByTestId("kpi-revenue")).toContainText("€1,100.00");
  await expect(kpis.getByTestId("kpi-expenses")).toContainText("€200.00");
  await expect(kpis.getByTestId("kpi-result")).toContainText("€900.00");
  await expect(kpis.getByTestId("kpi-cashIn")).toContainText("€320.00");
  await expect(page.getByTestId("tile-receivables")).toContainText("€1,000.00");
  await expect(page.getByTestId("activity-list")).toContainText("Payment recorded");
  // The chart's values are reachable without hovering.
  await page.getByText("Show as table").first().click();
  await expect(page.getByRole("table").first()).toContainText("€1,100.00");

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  const axe = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(axe.violations).toEqual([]);

  await page.getByTestId("quick-expense").click();
  await expect(page).toHaveURL(new RegExp(`/en/companies/${companyId}/finance$`));

  await page.goto(`/en/companies/${companyId}/reports?view=receivables`);
  await expect(page.getByTestId("report-table")).toContainText("Kredīta Pircējs SIA");
  await expect(page.getByTestId("report-table")).toContainText("1,000.00");
  await expect(page.getByTestId("report-csv")).toHaveAttribute("href", /format=csv/);
});
