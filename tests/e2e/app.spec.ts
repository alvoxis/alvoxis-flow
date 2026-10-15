import { expect, test } from "@playwright/test";

const TITLES = {
  en: "Dashboard",
  ru: "Обзор",
  lv: "Pārskats",
  lt: "Apžvalga",
  et: "Ülevaade",
} as const;

test("root redirects to a locale and renders the dashboard", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/en$/);
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  await expect(page.getByTestId("sample-data-banner")).toBeVisible();
});

for (const [locale, title] of Object.entries(TITLES)) {
  test(`renders the dashboard in ${locale}`, async ({ page }) => {
    await page.goto(`/${locale}`);
    await expect(page.locator("html")).toHaveAttribute("lang", locale);
    await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
  });
}

test("shows per-currency totals without mixing EUR and PLN", async ({ page }) => {
  await page.goto("/en");
  const grid = page.getByTestId("kpi-grid");
  await expect(grid.locator('[data-currency="EUR"]').first()).toHaveText("€8,560.40");
  await expect(grid.locator('[data-currency="PLN"]').first()).toHaveText("PLN 12,450.50");
});

test("switches language and keeps the user on the same page", async ({ page }) => {
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

test("layout has no horizontal overflow", async ({ page }) => {
  await page.goto("/en");
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test("uses a table on wide screens and a list on phones", async ({ page, isMobile }) => {
  await page.goto("/en");
  const table = page.getByTestId("recent-documents-table");
  if (isMobile) {
    await expect(table).toBeHidden();
    await page.getByRole("button", { name: "Open menu" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("link", { name: "Dashboard" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  } else {
    await expect(table).toBeVisible();
    // The amount column must be on screen without horizontal scrolling.
    await expect(table.getByRole("columnheader", { name: "Amount" })).toBeInViewport({ ratio: 1 });
  }
});

test("sends security headers and serves the PWA manifest", async ({ request }) => {
  const res = await request.get("/en");
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
