import { ownerWithIssuedInvoice } from "./document-helpers";
import { expect, test } from "./support";

/**
 * The cost calculator: lines update the result live, an unverified duty rate is flagged, margin
 * and markup differ, and saving stores the server's recalculated result. Arbitrary test values;
 * the 10 % duty is not a real tariff.
 */
test("calculates a batch cost and saves it", async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  const { companyId } = await ownerWithIssuedInvoice(page, baseURL!);
  await page.goto(`/en/companies/${companyId}/costing`);
  const calc = page.getByTestId("cost-calculator");
  await expect(page.getByTestId("costing-empty")).toBeVisible();
  await calc.locator("input[name=name]").fill("Jacket batch");
  await calc.locator("input[name=quantity]").fill("100");
  // Default lines: purchase (per unit) and delivery (total).
  await calc.locator("input[name=amount-0]").fill("4.50");
  await calc.locator("input[name=amount-1]").fill("120");
  await calc.getByRole("button", { name: "+ Customs duty" }).click();
  await calc.locator("input[name=amount-2]").fill("10");
  await expect(page.getByTestId("cost-total")).toHaveText("€627.00");
  await expect(page.getByTestId("cost-unit")).toHaveText("€6.2700");
  await expect(page.getByTestId("cost-warnings")).toContainText("not marked verified");
  await calc.locator("input[name=salePrice]").fill("9");
  await expect(page.getByTestId("cost-margin")).toHaveText("30.33 %");
  await expect(page.getByTestId("cost-markup")).toHaveText("43.54 %");
  await page.getByTestId("cost-save").click();
  await expect(page.getByTestId("costing-saved")).toContainText("Jacket batch");
  await expect(page.getByTestId("costing-saved")).toContainText("Needs verification");
});
