import { ownerWithIssuedInvoice } from "./document-helpers";
import { expect, test } from "./support";

/**
 * The subscription page: the owner reaches it from the settings hub; without a Stripe key (as in
 * tests) it says subscriptions are not available, shows the one plan at €9.99 per month and offers
 * nothing to buy. Runs on desktop, tablet and phone.
 */
test("the owner opens the subscription page from settings", async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  const { companyId } = await ownerWithIssuedInvoice(page, baseURL!);
  await page.goto(`/en/companies/${companyId}/settings`);
  await page.getByTestId("settings-billing").click();
  await expect(page).toHaveURL(new RegExp(`/en/companies/${companyId}/billing$`));
  await expect(page.getByRole("heading", { name: "Subscription" })).toBeVisible();
  await expect(page.getByTestId("billing-not-configured")).toBeVisible();
  await expect(page.getByTestId("billing-plan")).toHaveCount(1);
  await expect(page.getByTestId("billing-plan")).toContainText("€9.99");
  await expect(page.getByTestId("billing-subscribe")).toHaveCount(0);
});
