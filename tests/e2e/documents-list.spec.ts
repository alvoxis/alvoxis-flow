import { type Page } from "@playwright/test";
import { secretFromOtpauthUri } from "../support/totp";
import { createVerifiedUser, expect, PASSWORD, signInViaForm, test, totp } from "./support";

/** Stage A: the buyer in the document list (desktop, tablet, phone). Synthetic data only. */

async function ownerWithCompany(page: Page, baseURL: string) {
  await signInViaForm(page, await createVerifiedUser(page.request, baseURL));
  await page.getByTestId("create-company").locator("input[name=name]").fill("Saraksts SIA");
  await page.getByTestId("create-company").getByRole("button").click();
  const link = page.getByTestId("company-documents-link");
  await expect(link).toBeVisible();
  const documentsUrl = (await link.getAttribute("href"))!;
  const headers = { origin: baseURL };
  const enable = await page.request.post("/api/auth/two-factor/enable", {
    data: { password: PASSWORD },
    headers,
  });
  const secret = secretFromOtpauthUri(String((await enable.json()).totpURI));
  expect(
    (
      await page.request.post("/api/auth/two-factor/verify-totp", {
        data: { code: totp(secret) },
        headers,
      })
    ).status(),
  ).toBe(200);
  return { companyId: documentsUrl.split("/").at(-2)!, documentsUrl, headers };
}

async function draft(page: Page, companyId: string, headers: object, buyer: string) {
  const res = await page.request.post(`/api/companies/${companyId}/documents`, {
    data: {
      type: "invoice",
      language: "en",
      currency: "EUR",
      issueDate: "2026-03-02",
      buyer: { name: buyer },
      lines: [],
    },
    headers: headers as Record<string, string>,
  });
  expect(res.status()).toBe(201);
  return String((await res.json()).document.id);
}

test("the list shows the buyer; long names are cut but fully available; empty is a dash", async ({
  page,
  baseURL,
}) => {
  const { companyId, documentsUrl, headers } = await ownerWithCompany(page, baseURL!);
  const longName = `${"Ļoti Gara Nosaukuma Pircēja Sabiedrība ".repeat(8)}SIA`.slice(0, 300);
  expect(longName).toHaveLength(300);
  const normal = await draft(page, companyId, headers, "Parasts Pircējs SIA");
  const long = await draft(page, companyId, headers, longName);
  const empty = await draft(page, companyId, headers, "");

  await page.goto(documentsUrl);
  const buyer = (id: string) =>
    page
      .locator(`[data-testid="document-row"][data-document-id="${id}"]`)
      .getByTestId("document-buyer");
  await expect(buyer(normal)).toHaveText("Parasts Pircējs SIA");
  await expect(buyer(empty)).toHaveText("—");
  // Full name in the accessible text and the tooltip; visually cut with an ellipsis.
  await expect(buyer(long)).toHaveText(longName);
  await expect(buyer(long)).toHaveAttribute("title", longName);
  expect(await buyer(long).evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);

  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(buyer(long)).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    ).toBeLessThanOrEqual(0);
  }
  // Desktop table header.
  await expect(page.getByText("Buyer", { exact: true })).toBeVisible();
});
