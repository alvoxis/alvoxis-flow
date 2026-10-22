import AxeBuilder from "@axe-core/playwright";
import { type Page } from "@playwright/test";
import { secretFromOtpauthUri } from "../support/totp";
import {
  alertOf,
  createVerifiedUser,
  expect,
  newDevice,
  PASSWORD,
  signInViaForm,
  test,
  totp,
} from "./support";

/** Signed-in owner of a new company; enrols 2FA through the API unless `withTwoFactor` is false. */
async function ownerWithCompany(page: Page, baseURL: string, withTwoFactor = true) {
  const email = await createVerifiedUser(page.request, baseURL);
  await signInViaForm(page, email);
  await page.getByTestId("create-company").locator("input[name=name]").fill("Profils SIA");
  await page.getByTestId("create-company").getByRole("button").click();
  await expect(page.getByTestId("company-profile-link")).toBeVisible();
  if (withTwoFactor) {
    const enable = await page.request.post("/api/auth/two-factor/enable", {
      data: { password: PASSWORD },
      headers: { origin: baseURL },
    });
    const secret = secretFromOtpauthUri(String((await enable.json()).totpURI));
    const verify = await page.request.post("/api/auth/two-factor/verify-totp", {
      data: { code: totp(secret) },
      headers: { origin: baseURL },
    });
    expect(verify.status()).toBe(200);
  }
  await page.goto("/en");
  const href = await page.getByTestId("company-profile-link").getAttribute("href");
  return { email, profileUrl: href! };
}

test("owner edits the company profile; values are saved and validated", async ({
  page,
  baseURL,
}) => {
  const { profileUrl } = await ownerWithCompany(page, baseURL!);
  await page.getByTestId("company-profile-link").click();
  await expect(page).toHaveURL(new RegExp(`${profileUrl}$`));
  const form = page.getByTestId("company-profile-form");
  await expect(page.getByTestId("company-country")).toHaveText("Latvia");

  // Format check: an Estonian prefix is refused for a Latvian company.
  await form.locator("input[name=vatNumber]").fill("EE123456789");
  await form.getByRole("button", { name: "Save profile" }).click();
  await expect(alertOf(page)).toContainText("Please check the highlighted fields");
  await expect(form.locator("input[name=vatNumber]")).toHaveAttribute("aria-invalid", "true");

  // Synthetic company data only.
  await form.locator("input[name=legalName]").fill("SIA Profils Tests");
  await form.locator("input[name=registrationNumber]").fill("40000000001");
  await form.locator("input[name=vatNumber]").fill("lv 40000000001");
  await form.locator("input[name=addressLine1]").fill("Testa iela 2");
  await form.locator("input[name=postalCode]").fill("LV-1001");
  await form.locator("input[name=city]").fill("Rīga");
  await form.getByRole("button", { name: "Save profile" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Profile saved." })).toBeVisible();

  await page.reload();
  await expect(form.locator("input[name=vatNumber]")).toHaveValue("LV40000000001");
  await expect(form.locator("input[name=city]")).toHaveValue("Rīga");
});

test("profile access: 2FA required for the owner, invisible to other users", async ({
  page,
  browser,
  baseURL,
}) => {
  const { profileUrl } = await ownerWithCompany(page, baseURL!, false);
  await page.goto(profileUrl);
  await expect(
    page.getByRole("status").filter({ hasText: "two-factor authentication" }),
  ).toBeVisible();
  await expect(page.getByTestId("company-profile-form")).toHaveCount(0);
  const companyId = profileUrl.split("/").at(-2)!;
  expect((await page.request.get(`/api/companies/${companyId}/profile`)).status()).toBe(403);

  const other = await newDevice(browser);
  const otherPage = await other.newPage();
  await signInViaForm(otherPage, await createVerifiedUser(otherPage.request, baseURL!));
  await expect(otherPage).toHaveURL(/\/en$/);
  const res = await otherPage.goto(profileUrl);
  expect(res?.status()).toBe(404);
  const api = await otherPage.request.patch(`/api/companies/${companyId}/profile`, {
    data: { name: "Hijacked" },
    headers: { origin: baseURL! },
  });
  expect(api.status()).toBe(403);
  await other.close();
});

test("document colour: the owner picks a palette colour, sees the preview and it is saved", async ({
  page,
  baseURL,
}) => {
  const { profileUrl } = await ownerWithCompany(page, baseURL!);
  await page.goto(profileUrl);
  const colours = page.getByTestId("pdf-accent");
  const preview = page.getByTestId("pdf-accent-preview");
  await expect(colours.getByRole("radio")).toHaveCount(6);
  await expect(colours.getByRole("radio", { name: /Dark blue/ })).toBeChecked();
  await expect(preview).toHaveAttribute("data-accent", "navy");
  await expect(preview).toHaveAccessibleName("Invoice preview in Dark blue");

  await colours.getByRole("radio", { name: "Teal" }).check();
  await expect(preview).toHaveAttribute("data-accent", "teal");
  await expect(preview).toHaveAccessibleName("Invoice preview in Teal");

  // No accessibility violations on the profile form with the colour choice (WCAG 2.1 A/AA).
  const axe = await new AxeBuilder({ page })
    .include('[data-testid="company-profile-form"]')
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(axe.violations).toEqual([]);
  // Fits a phone without horizontal scrolling.
  await page.setViewportSize({ width: 375, height: 800 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(0);

  await page
    .getByTestId("company-profile-form")
    .getByRole("button", { name: "Save profile" })
    .click();
  await expect(page.getByRole("status").filter({ hasText: "Profile saved." })).toBeVisible();
  await page.reload();
  await expect(colours.getByRole("radio", { name: "Teal" })).toBeChecked();
  await expect(preview).toHaveAttribute("data-accent", "teal");

  // The API refuses anything outside the palette.
  const companyId = profileUrl.split("/").at(-2)!;
  const bad = await page.request.patch(`/api/companies/${companyId}/profile`, {
    data: { name: "Profils SIA", pdfAccent: "#ff0000" },
    headers: { origin: baseURL! },
  });
  expect(bad.status()).toBe(400);
  expect((await bad.json()).fieldErrors).toHaveProperty("pdfAccent");
});
