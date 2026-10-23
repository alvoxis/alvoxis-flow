import { ownerWithIssuedInvoice } from "./document-helpers";
import { expect, test } from "./support";

/**
 * Payroll page: add an employee, start a month, apply a bonus, approve (final), CSV link.
 * Synthetic people and amounts; the default rates are starting values, not legal advice.
 * Runs on desktop, tablet and phone.
 */
test("payroll: employee, month, bonus, approval", async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  const { companyId } = await ownerWithIssuedInvoice(page, baseURL!);

  await page.goto("/en/payroll");
  await expect(page).toHaveURL(new RegExp(`/en/companies/${companyId}/payroll$`));
  await expect(page.getByText("A calculation aid, not a tax declaration")).toBeVisible();
  await expect(page.getByTestId("rates-row").filter({ hasText: "Latvia" })).toContainText(
    "Starting values",
  );

  await page.getByTestId("employee-add").click();
  const form = page.getByTestId("employee-form");
  await form.locator("input[name=firstName]").fill("Anna");
  await form.locator("input[name=lastName]").fill("Testa");
  await form.locator("input[name=monthlyGross]").fill("2000");
  await form.locator("input[name=monthlyAllowance]").fill("510");
  await form.locator("input[name=employmentStart]").fill("2026-01-01");
  await form.getByRole("button", { name: "Add employee" }).click();
  await expect(page.getByTestId("employee-row").filter({ hasText: "Anna Testa" })).toContainText(
    "2000.00 EUR",
  );

  const start = page.getByTestId("payroll-start");
  await start.locator("input[name=period]").fill("2026-02");
  await start.getByRole("button", { name: "Start payroll month" }).click();
  const run = page.getByTestId("run-row").filter({ hasText: "2026-02" });
  await expect(run).toHaveAttribute("data-status", "draft");
  const line = run.getByTestId("run-line").filter({ hasText: "Anna Testa" });
  await expect(line.locator('[data-field="net"]')).toHaveText("1463.60 EUR");

  // A bonus this month only.
  await line.getByLabel("Gross this month").fill("2500");
  await line.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Gross amount applied." })).toBeVisible();
  await expect(line.locator('[data-field="gross"]')).toHaveText("2500.00 EUR");

  await run.getByRole("button", { name: "Approve" }).click();
  await page.getByTestId("run-approve-confirm").getByRole("button", { name: "Approve" }).click();
  await expect(run).toHaveAttribute("data-status", "approved");
  await expect(run.getByRole("button", { name: "Recalculate" })).toHaveCount(0);
  await expect(run.getByRole("link", { name: "Download CSV" })).toHaveAttribute(
    "href",
    /\/payroll\/runs\/[^/]+\/csv$/,
  );
});
