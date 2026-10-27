import AxeBuilder from "@axe-core/playwright";
import { type Page } from "@playwright/test";
import { expect, test } from "./support";

/**
 * The public website: landing page with an illustrative (labelled) preview, the one €9.99 plan,
 * legal drafts that say they need review, all five languages, the theme switch, the compact menu,
 * no horizontal scrolling and no accessibility violations. Runs on desktop, tablet and phone.
 */
const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/**
 * Entrance animations fade content in; contrast is checked on the settled page, not mid-fade.
 * Animations inside hidden content (the closed menu) do not run until shown, so they are skipped.
 */
const settled = (page: Page) =>
  page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => {
          const target = (a.effect as KeyframeEffect | null)?.target;
          return target ? target.checkVisibility() : false;
        })
        .map((a) => a.finished),
    ),
  );

test("landing page explains the product honestly", async ({ page }) => {
  await page.goto("/en/welcome");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByTestId("preview-illustrative")).toHaveText(
    "Illustrative example — not real data",
  );
  await expect(page.getByTestId("pricing-card")).toContainText("€9.99");
  await expect(page.getByTestId("faq")).toBeVisible();
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await settled(page);
  const axe = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(axe.violations).toEqual([]);
  await page.getByTestId("hero-start").click();
  await expect(page).toHaveURL(/\/en\/sign-up$/);
});

test("pricing shows exactly one plan and the legal pages are marked as drafts", async ({
  page,
}) => {
  await page.goto("/en/pricing");
  await expect(page.getByTestId("pricing-card")).toHaveCount(1);
  await expect(page.getByTestId("pricing-amount")).toHaveText("€9.99");
  await expect(page.getByTestId("pricing-page")).not.toContainText(
    /trial period|Basic|Business plan/i,
  );
  for (const doc of ["privacy", "terms", "subscription", "cookies"]) {
    await page.goto(`/en/legal/${doc}`);
    await expect(page.getByTestId("legal-draft")).toContainText(
      "has not yet been reviewed by a lawyer",
    );
  }
  expect((await page.goto("/en/legal/unknown"))?.status()).toBe(404);
});

test("public pages exist in every language with alternates", async ({ page }) => {
  for (const locale of ["en", "ru", "lv", "lt", "et"]) {
    await page.goto(`/${locale}/features`);
    await expect(page.locator("html")).toHaveAttribute("lang", locale);
    await expect(page.locator('link[rel="alternate"][hreflang="lv"]')).toHaveCount(1);
  }
  const robots = await page.request.get("/robots.txt");
  expect(await robots.text()).toContain("Disallow: /api/");
  const sitemap = await page.request.get("/sitemap.xml");
  expect(await sitemap.text()).toContain("/et/legal/privacy");
});

test("the theme switch changes and remembers the theme without a flash", async ({ page }) => {
  // A hydration error would make React re-render the document and drop the theme attribute.
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.goto("/en/welcome");
  await expect(page.locator("html")).not.toHaveAttribute("data-theme", "light");
  await page.getByTestId("theme-switch").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  const cookies = await page.context().cookies();
  expect(cookies.find((c) => c.name === "alvoxis-theme")?.value).toBe("light");
  await page.goto("/en/pricing");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await settled(page);
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(axe.violations).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test("the compact menu opens and leads to the pages", async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 0) >= 1024, "phone and tablet layout only");
  await page.goto("/en/welcome");
  await page.getByRole("group").or(page.locator("details summary")).first().click();
  await page.locator("details[open]").getByRole("link", { name: "Pricing" }).click();
  await expect(page).toHaveURL(/\/en\/pricing$/);
});
