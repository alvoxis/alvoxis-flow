import AxeBuilder from "@axe-core/playwright";
import { type Page } from "@playwright/test";
import { FIXTURE_TAX } from "../support/document-fixtures";
import { secretFromOtpauthUri } from "../support/totp";
import { E2E_SQL_AVAILABLE, e2eDatabase } from "./e2e-db";
import {
  createVerifiedUser,
  expect,
  newDevice,
  PASSWORD,
  signInViaForm,
  test,
  totp,
} from "./support";

/**
 * The dashboard's company cards (stage 2 visuals): one card per company with its real document
 * figures, empty and no-access states, other tenants' companies never shown, no horizontal
 * scrolling on a phone and no accessibility violations. Synthetic data only; the fixture tax
 * category is an arbitrary value, not a real rate.
 */

type Headers = Record<string, string>;

/** Signs in a new verified user with 2FA enrolled (owners need it to use documents). */
async function signedInWith2fa(
  page: Page,
  baseURL: string,
): Promise<{ email: string; headers: Headers }> {
  const email = await createVerifiedUser(page.request, baseURL);
  await signInViaForm(page, email);
  // The session cookie is set once the dashboard has loaded.
  await expect(page.getByTestId("create-company")).toBeVisible();
  const headers = { origin: baseURL };
  const enable = await page.request.post("/api/auth/two-factor/enable", {
    data: { password: PASSWORD },
    headers,
  });
  const secret = secretFromOtpauthUri(String((await enable.json()).totpURI));
  const verified = await page.request.post("/api/auth/two-factor/verify-totp", {
    data: { code: totp(secret) },
    headers,
  });
  expect(verified.status()).toBe(200);
  return { email, headers };
}

async function createCompany(page: Page, headers: Headers, name: string): Promise<string> {
  const res = await page.request.post("/api/companies", {
    data: { name, country: "LV" },
    headers,
  });
  expect(res.status()).toBe(201);
  return String((await res.json()).companyId);
}

async function createDraft(page: Page, companyId: string, headers: Headers, lines: object[] = []) {
  const res = await page.request.post(`/api/companies/${companyId}/documents`, {
    data: {
      type: "invoice",
      language: "en",
      currency: "EUR",
      issueDate: "2026-03-02",
      buyer: { name: "Kartītes Pircējs SIA" },
      lines,
    },
    headers,
  });
  expect(res.status()).toBe(201);
  return String((await res.json()).document.id);
}

/** An issued invoice of 10.00 + 20 % fixture tax = 12.00 EUR gross. */
async function issueInvoice(page: Page, companyId: string, headers: Headers, name: string) {
  const profile = await page.request.patch(`/api/companies/${companyId}/profile`, {
    data: {
      name,
      legalName: `SIA ${name}`,
      registrationNumber: "40000000004",
      vatNumber: "LV40000000004",
      addressLine1: "Testa iela 5",
      addressLine2: "",
      postalCode: "LV-1004",
      city: "Rīga",
    },
    headers,
  });
  expect(profile.status()).toBe(200);
  const cat = await page.request.post(`/api/companies/${companyId}/tax-categories`, {
    data: FIXTURE_TAX.standard20,
    headers,
  });
  const taxCategoryId = String((await cat.json()).taxCategory.id);
  const id = await createDraft(page, companyId, headers, [
    { description: "Item", quantity: "1", unitPrice: "10", taxCategoryId },
  ]);
  const issued = await page.request.post(`/api/companies/${companyId}/documents/${id}/issue`, {
    data: { expectedVersion: 1 },
    headers,
  });
  expect(issued.status()).toBe(200);
}

function card(page: Page, companyId: string) {
  return page.locator(`[data-testid="company-list"] [data-company-id="${companyId}"]`);
}

function horizontalOverflow(page: Page) {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

test("each company has its own card with its real figures, on every screen size", async ({
  page,
  baseURL,
}) => {
  const { headers } = await signedInWith2fa(page, baseURL!);
  const alfa = await createCompany(page, headers, "Alfa Kartīte SIA");
  const beta = await createCompany(page, headers, "Beta Kartīte SIA");
  await issueInvoice(page, alfa, headers, "Alfa Kartīte SIA");
  await createDraft(page, alfa, headers);

  await page.goto("/en");
  await expect(page.getByTestId("company-list").locator("[data-company-id]")).toHaveCount(2);

  // Alfa: one draft, one issued invoice of 12.00 EUR, and the drafts/issued bar at 50 %.
  const a = card(page, alfa);
  await expect(a.getByTestId("company-profile-link")).toHaveText("Alfa Kartīte SIA");
  await expect(a.getByTestId("overview-drafts")).toHaveText("1");
  await expect(a.getByTestId("overview-issued")).toHaveText("1");
  await expect(a.locator('[data-testid="overview-totals"] [data-currency="EUR"]')).toHaveText(
    "€12.00",
  );
  await expect(a.getByTestId("overview-share")).toHaveAttribute("data-share", "50");
  await expect(a.getByTestId("company-documents-link")).toHaveAttribute(
    "href",
    `/en/companies/${alfa}/documents`,
  );

  // Beta: no documents yet, so no figures at all (nothing invented).
  const b = card(page, beta);
  await expect(b.getByTestId("overview-empty")).toBeVisible();
  await expect(b.getByTestId("overview-totals")).toHaveCount(0);
  await expect(b.getByTestId("overview-share")).toHaveCount(0);
  await expect(b.getByTestId("company-documents-link")).toHaveAttribute(
    "href",
    `/en/companies/${beta}/documents`,
  );
  // The empty state leads to creating the first document; payments are said to be untracked.
  await expect(b.getByTestId("overview-create-document")).toHaveAttribute(
    "href",
    `/en/companies/${beta}/documents/new`,
  );
  await expect(page.getByTestId("overview-notes")).toContainText("Payments are not tracked yet");
  await expect(a.getByText("Invoiced, net of credit notes")).toBeVisible();

  // No accessibility violations on the dashboard (WCAG 2.1 A/AA rules).
  const axe = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(axe.violations).toEqual([]);

  // No horizontal scrolling on a phone or a desktop, with long amounts and names.
  for (const width of [375, 390, 820, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(a.getByTestId("overview-totals")).toBeVisible();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  }

  // The top bar names the company of the current page (shown from sm), never "no company".
  await page.setViewportSize({ width: 820, height: 900 });
  await expect(page.getByTestId("topbar-company")).toHaveCount(0);
  await a.getByTestId("company-documents-link").click();
  await expect(page.getByTestId("topbar-company")).toHaveText(/Alfa Kartīte SIA/);
  await page.goto("/en");

  // With reduced motion the cards have no transitions.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.reload();
  const duration = await card(page, alfa).evaluate((el) => getComputedStyle(el).transitionDuration);
  expect(parseFloat(duration)).toBeLessThan(0.001);
});

test("a role without documents.view sees no figures; other tenants' companies never appear", async ({
  page,
  browser,
  baseURL,
}) => {
  test.skip(!E2E_SQL_AVAILABLE, "needs the isolated e2e database (E2E_DATABASE_URL)");
  // Another tenant: an owner with two companies, one of them with an issued invoice.
  const other = await newDevice(browser);
  const ownerPage = await other.newPage();
  const { headers } = await signedInWith2fa(ownerPage, baseURL!);
  const shared = await createCompany(ownerPage, headers, "Kopīga Kartīte SIA");
  await createCompany(ownerPage, headers, "Slēpta Kartīte SIA");
  await issueInvoice(ownerPage, shared, headers, "Kopīga Kartīte SIA");

  // This user is a production employee (no documents.view) in the shared company only.
  const email = await createVerifiedUser(page.request, baseURL!);
  const db = e2eDatabase();
  try {
    await db.query(
      `INSERT INTO memberships (company_id, user_id, role_id)
       SELECT $1, u.id, r.id FROM users u, roles r
       WHERE u.email = $2 AND r.company_id = $1 AND r.key = 'production_employee'`,
      [shared, email],
    );
  } finally {
    await db.end();
  }
  await signInViaForm(page, email);
  await expect(page).toHaveURL(/\/en$/);

  const list = page.getByTestId("company-list");
  await expect(list.locator("[data-company-id]")).toHaveCount(1);
  const c = card(page, shared);
  await expect(c.getByTestId("overview-unavailable")).toBeVisible();
  await expect(c.getByTestId("overview-totals")).toHaveCount(0);
  await expect(c.getByTestId("overview-create-document")).toHaveCount(0);
  await expect(page.getByText("€12.00")).toHaveCount(0);
  await expect(page.getByText("Slēpta Kartīte SIA")).toHaveCount(0);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  await other.close();
});
