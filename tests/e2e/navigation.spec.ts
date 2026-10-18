import { type Page } from "@playwright/test";
import { secretFromOtpauthUri } from "../support/totp";
import {
  createVerifiedUser,
  expect,
  PASSWORD,
  signedInPage,
  signInViaForm,
  test,
  totp,
} from "./support";

/** "Documents" in the main navigation and the real dashboard figures. Synthetic data only. */

async function ownerWithCompany(page: Page, baseURL: string, name: string) {
  await signInViaForm(page, await createVerifiedUser(page.request, baseURL));
  await page.getByTestId("create-company").locator("input[name=name]").fill(name);
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

/** Opens the main navigation (the drawer below the lg breakpoint) and returns its container. */
async function mainNav(page: Page) {
  if ((page.viewportSize()?.width ?? 0) >= 1024) return page.getByRole("navigation").first();
  await page.getByRole("button", { name: "Open menu" }).click();
  return page.getByRole("dialog");
}

function noHorizontalOverflow(page: Page) {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

test("Documents without a company points to creating one", async ({ page, baseURL }) => {
  await signedInPage(page, baseURL!);
  await page.goto("/en");
  await (await mainNav(page)).getByRole("link", { name: "Documents" }).click();
  await expect(page).toHaveURL(/\/en\/documents$/);
  await page.getByTestId("documents-create-company-link").click();
  await expect(page).toHaveURL(/\/en$/);
  await expect(page.getByTestId("create-company")).toBeVisible();
});

test("Documents opens the only company's documents and is marked as the current section", async ({
  page,
  baseURL,
}) => {
  const { documentsUrl } = await ownerWithCompany(page, baseURL!, "Navigācija SIA");
  await page.goto("/en");
  await (await mainNav(page)).getByRole("link", { name: "Documents" }).click();
  await expect(page).toHaveURL(new RegExp(`${documentsUrl}$`));
  const current = (await mainNav(page)).getByRole("link", { name: "Documents" });
  await expect(current).toHaveAttribute("aria-current", "page");
  expect(await noHorizontalOverflow(page)).toBeLessThanOrEqual(0);
});

test("the dashboard shows the company's real document figures", async ({ page, baseURL }) => {
  const { companyId, headers } = await ownerWithCompany(page, baseURL!, "Skaitļi SIA");
  await page.goto("/en");
  const row = page.locator(`[data-testid="documents-overview"] [data-company-id="${companyId}"]`);
  await expect(row.getByTestId("overview-empty")).toBeVisible();

  const res = await page.request.post(`/api/companies/${companyId}/documents`, {
    data: {
      type: "invoice",
      language: "en",
      currency: "EUR",
      issueDate: "2026-03-02",
      buyer: { name: "Pircējs SIA" },
      lines: [],
    },
    headers,
  });
  expect(res.status()).toBe(201);
  await page.reload();
  await expect(row.getByTestId("overview-drafts")).toHaveText("1");
  await expect(row.getByTestId("overview-issued")).toHaveText("0");
  await expect(row.getByTestId("overview-totals")).toHaveText("—");
  expect(await noHorizontalOverflow(page)).toBeLessThanOrEqual(0);
});
