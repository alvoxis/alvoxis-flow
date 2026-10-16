import {
  alertOf,
  createVerifiedUser,
  expect,
  mailLink,
  newDevice,
  PASSWORD,
  signInViaForm,
  test,
  totp,
  uniqueEmail,
} from "./support";

test("registers, confirms the email address and signs in (localized UI)", async ({ page }) => {
  const email = uniqueEmail("signup");
  await page.goto("/lt/sign-up");
  const form = page.getByTestId("sign-up-form");
  await form.locator("input[name=name]").fill("Rūta Testė");
  await form.locator("input[name=email]").fill(email);
  await form.locator("input[name=password]").fill(PASSWORD);
  await form.getByRole("button").click();
  await expect(page.getByTestId("check-email")).toContainText(email);

  // Signing in before confirming is refused with a translated message.
  await signInViaForm(page, email, "lt");
  await expect(alertOf(page)).toContainText("patvirtinkite el. pašto adresą");

  await page.goto(await mailLink(email, "verify"));
  await expect(page).toHaveURL(/\/lt\/sign-in\?verified=1/);
  await expect(page.getByRole("status").first()).toContainText("patvirtintas");
  await signInViaForm(page, email, "lt");
  await expect(page).toHaveURL(/\/lt$/);
  await expect(page.getByTestId("create-company")).toBeVisible();
});

test("password reset: generic answer, single-use link, other sessions signed out", async ({
  page,
  browser,
  baseURL,
}) => {
  const email = await createVerifiedUser(page.request, baseURL!);
  const other = await newDevice(browser);
  const otherPage = await other.newPage();
  await signInViaForm(otherPage, email);
  await expect(otherPage).toHaveURL(/\/en$/);

  await page.goto("/en/forgot-password");
  await page.getByTestId("forgot-form").locator("input[name=email]").fill(email);
  await page.getByTestId("forgot-form").getByRole("button").click();
  await expect(page.getByRole("status")).toContainText("If an account exists");

  const link = await mailLink(email, "reset");
  await page.goto(link);
  await expect(page).toHaveURL(/\/en\/reset-password\?token=/);
  const newPassword = "another-very-long-password-91";
  await page.getByTestId("reset-form").locator("input[name=password]").fill(newPassword);
  await page.getByTestId("reset-form").locator("input[name=confirm]").fill(newPassword);
  await page.getByTestId("reset-form").getByRole("button").click();
  await expect(page).toHaveURL(/\/en\/sign-in\?reset=1/);

  // The same link cannot be used twice.
  await page.goto(link);
  await expect(alertOf(page)).toContainText("invalid or has expired");

  // The other device was signed out.
  await otherPage.goto("/en");
  await expect(otherPage).toHaveURL(/\/en\/sign-in/);
  await other.close();

  await signInViaForm(page, email, "en", newPassword);
  await expect(page).toHaveURL(/\/en$/);
});

test("owners must enrol in 2FA; the second factor is then required at every sign-in", async ({
  page,
  baseURL,
}) => {
  const email = await createVerifiedUser(page.request, baseURL!);
  await signInViaForm(page, email);
  await page.getByTestId("create-company").locator("input[name=name]").fill("E2E Owner SIA");
  await page.getByTestId("create-company").getByRole("button").click();
  await expect(page.getByTestId("two-factor-required")).toBeVisible();

  // Direct API call cannot bypass the requirement.
  const companies = (await (await page.request.get("/api/me")).json()) as {
    companies: { id: string }[];
  };
  const companyId = companies.companies[0]!.id;
  const blocked = await page.request.get(`/api/companies/${companyId}/documents`);
  expect(blocked.status()).toBe(403);
  expect(await blocked.json()).toEqual({ error: "two_factor_enrollment_required" });

  // Enrol.
  await page.getByTestId("two-factor-required").getByRole("link").click();
  await page.getByTestId("two-factor-setup-password").locator("input").fill(PASSWORD);
  await page.getByTestId("two-factor-setup-password").getByRole("button").click();
  const secret = (await page.getByTestId("totp-secret").textContent())!.trim();
  await page.getByTestId("two-factor-setup-verify").locator("input[name=code]").fill(totp(secret));
  await page.getByTestId("two-factor-setup-verify").getByRole("button").click();
  const codeItems = page.getByTestId("recovery-codes").locator("li");
  await expect(codeItems).toHaveCount(10);
  const codes = (await codeItems.allTextContents()).map((c) => c.trim());
  await page.getByRole("button", { name: "I have saved my codes" }).click();
  await expect(page.getByTestId("two-factor-required")).toHaveCount(0);
  expect((await page.request.get(`/api/companies/${companyId}/documents`)).status()).toBe(200);

  // Sign out; signing in again requires the second factor (recovery code path).
  await page.getByTestId("sign-out").first().click();
  await expect(page).toHaveURL(/\/en\/sign-in/);
  await signInViaForm(page, email);
  await expect(page).toHaveURL(/\/en\/two-factor/);
  // Without completing the challenge there is no session at all.
  expect((await page.request.get(`/api/companies/${companyId}/documents`)).status()).toBe(401);
  await page.getByRole("button", { name: "Use a recovery code instead" }).click();
  await page.getByTestId("two-factor-form").locator("input[name=code]").fill(codes[0]!);
  await page.getByTestId("two-factor-form").getByRole("button").click();
  await expect(page).toHaveURL(/\/en$/);

  // Owners cannot switch 2FA off.
  await page.goto("/en/account/security");
  await expect(page.getByText("Required for your role")).toBeVisible();
  await expect(page.getByTestId("disable-two-factor")).toHaveCount(0);
});

test("lists sessions and signs out another device", async ({ page, browser, baseURL }) => {
  const email = await createVerifiedUser(page.request, baseURL!);
  await signInViaForm(page, email);
  const other = await newDevice(browser, {
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1",
  });
  const otherPage = await other.newPage();
  await signInViaForm(otherPage, email);
  await expect(otherPage).toHaveURL(/\/en$/);

  await page.goto("/en/account/security");
  const rows = page.getByTestId("session-row");
  await expect(rows).toHaveCount(2);
  await expect(page.getByTestId("sessions-list")).toContainText("Safari · iOS");
  await expect(page.getByTestId("sessions-list")).toContainText("This device");

  await page.getByTestId("revoke-others").click();
  await expect(rows).toHaveCount(1);
  await otherPage.goto("/en");
  await expect(otherPage).toHaveURL(/\/en\/sign-in/);
  await other.close();
});

test("company data endpoints reject unauthenticated and non-member requests", async ({
  page,
  request,
  baseURL,
}) => {
  expect((await request.get("/api/me")).status()).toBe(401);
  const someCompany = "00000000-0000-4000-8000-000000000000";
  const anon = await request.get(`/api/companies/${someCompany}/documents`);
  expect(anon.status()).toBe(401);
  expect(await anon.json()).toEqual({ error: "unauthenticated" });

  await createVerifiedUser(page.request, baseURL!).then((email) => signInViaForm(page, email));
  await expect(page).toHaveURL(/\/en$/);
  const res = await page.request.get(`/api/companies/${someCompany}/documents`);
  expect(res.status()).toBe(403);
  expect(await res.json()).toEqual({ error: "forbidden" });
});
