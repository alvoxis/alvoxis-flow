import { ownerWithIssuedInvoice } from "./document-helpers";
import { expect, test } from "./support";

/**
 * Without ANTHROPIC_API_KEY (as in tests) the assistant page says it is not configured, explains
 * what data would be sent, and the rest of the company keeps working. No AI response is faked.
 */
test("the assistant explains when it is not configured", async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  const { companyId } = await ownerWithIssuedInvoice(page, baseURL!);
  await page.goto(`/en/companies/${companyId}/assistant`);
  await expect(page.getByTestId("assistant-not-configured")).toBeVisible();
  await expect(page.getByTestId("assistant-privacy")).toContainText("Anthropic");
  await expect(page.getByTestId("assistant-chat")).toHaveCount(0);
  await page.goto(`/en/companies/${companyId}/dashboard`);
  await expect(page.getByTestId("business-dashboard")).toBeVisible();
});
