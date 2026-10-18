import { expect, signedInPage, test } from "./support";

const TITLES = {
  en: "Dashboard",
  ru: "Обзор",
  lv: "Pārskats",
  lt: "Apžvalga",
  et: "Ülevaade",
} as const;

test("root redirects unauthenticated visitors to the localized sign-in page", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/en\/sign-in$/);
  await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
});

test("signed-in users see the dashboard", async ({ page, baseURL }) => {
  await signedInPage(page, baseURL!);
  await page.goto("/");
  await expect(page).toHaveURL(/\/en$/);
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  // No sample figures: a new user without a company is asked to create one.
  await expect(page.getByTestId("create-company")).toBeVisible();
  await expect(page.getByTestId("sample-data-banner")).toHaveCount(0);
  await expect(page.getByTestId("kpi-grid")).toHaveCount(0);
  await expect(page.getByTestId("documents-overview")).toHaveCount(0);
});

for (const [locale, title] of Object.entries(TITLES)) {
  test(`renders the dashboard in ${locale}`, async ({ page, baseURL }) => {
    await signedInPage(page, baseURL!);
    await page.goto(`/${locale}`);
    await expect(page.locator("html")).toHaveAttribute("lang", locale);
    await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
  });
}

test("switches language and keeps the user on the same page", async ({ page, baseURL }) => {
  await signedInPage(page, baseURL!);
  await page.goto("/en");
  await page.getByTestId("locale-switcher").selectOption("lv");
  await expect(page).toHaveURL(/\/lv$/);
  await expect(page.getByRole("heading", { level: 1, name: TITLES.lv })).toBeVisible();
});

test("unknown pages show a localized 404", async ({ page }) => {
  const res = await page.goto("/et/does-not-exist");
  expect(res?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "Lehte ei leitud" })).toBeVisible();
});

test("layout has no horizontal overflow", async ({ page, baseURL }) => {
  await signedInPage(page, baseURL!);
  await page.goto("/en");
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test("the main navigation is reachable on every screen size", async ({ page, baseURL }) => {
  await signedInPage(page, baseURL!);
  await page.goto("/en");
  // Below the lg breakpoint (phones and tablets) the navigation lives in a drawer.
  if ((page.viewportSize()?.width ?? 0) < 1024) {
    await page.getByRole("button", { name: "Open menu" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("link", { name: "Dashboard" })).toBeVisible();
    await expect(dialog.getByRole("link", { name: "Documents" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  } else {
    const nav = page.getByRole("navigation").first();
    await expect(nav.getByRole("link", { name: "Documents" })).toBeVisible();
  }
});

test("sends security headers and serves the PWA manifest", async ({ request }) => {
  const res = await request.get("/en/sign-in");
  expect(res.headers()["x-frame-options"]).toBe("DENY");
  expect(res.headers()["x-content-type-options"]).toBe("nosniff");
  expect(res.headers()["x-powered-by"]).toBeUndefined();

  const manifest = await request.get("/manifest.webmanifest");
  expect(manifest.ok()).toBe(true);
  expect((await manifest.json()).name).toBe("ALVOXIS Flow");
});

test("health endpoint reports status without leaking configuration", async ({ request }) => {
  const res = await request.get("/api/health");
  const body = await res.json();
  expect(["ok", "degraded"]).toContain(body.status);
  expect(JSON.stringify(body)).not.toMatch(/postgres:\/\//);
});
