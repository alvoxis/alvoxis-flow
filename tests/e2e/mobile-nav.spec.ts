import AxeBuilder from "@axe-core/playwright";
import { type Page } from "@playwright/test";
import { expect, signedInPage, test } from "./support";

/**
 * The main navigation drawer below the `lg` breakpoint (phones, tablets): it covers the whole
 * height of the screen above the page (regression: it used to be clipped to the sticky top bar,
 * with the page showing through the menu), locks and restores page scrolling, closes by X, Esc,
 * backdrop, navigation and growing to the desktop layout, keeps focus inside and returns it, and
 * scrolls when the screen is too short for the whole list.
 */

test.beforeEach(({ page }) => {
  test.skip((page.viewportSize()?.width ?? 0) >= 1024, "the drawer exists below lg only");
});

async function openDrawer(page: Page) {
  await page.getByRole("button", { name: "Open menu" }).click();
  const drawer = page.getByTestId("mobile-nav");
  await expect(drawer).toBeVisible();
  // The opening transition has finished.
  await expect
    .poll(() =>
      drawer.evaluate(
        (el) => !el.hasAttribute("data-starting-style") && el.getAnimations().length === 0,
      ),
    )
    .toBe(true);
  return drawer;
}

/** Whether the element on top at the centre of `locator` is the locator's element (or inside it). */
function isOnTop(page: Page, testId: string, name: string) {
  return page.evaluate(
    ({ testId, name }) => {
      const scope = document.querySelector(`[data-testid="${testId}"]`)!;
      const link = [...scope.querySelectorAll("a")].find((a) => a.textContent?.includes(name))!;
      const r = link.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return Boolean(hit && link.contains(hit));
    },
    { testId, name },
  );
}

const scrollLocked = (page: Page) =>
  page.evaluate(() =>
    [document.documentElement, document.body].some(
      (el) =>
        getComputedStyle(el).overflow === "hidden" || getComputedStyle(el).overflowY === "hidden",
    ),
  );

test("the open drawer covers the screen height above the page, with its own accessible dialog", async ({
  page,
  baseURL,
}) => {
  await signedInPage(page, baseURL!);
  await page.goto("/en");
  const drawer = await openDrawer(page);
  const viewport = page.viewportSize()!;
  const box = (await drawer.boundingBox())!;
  expect(box.y).toBe(0);
  expect(box.height).toBeGreaterThanOrEqual(viewport.height - 1);
  expect(box.width).toBeLessThan(viewport.width);

  const dialog = page.getByRole("dialog", { name: "Main navigation" });
  await expect(dialog).toBeVisible();
  // Every item is readable: nothing of the page is drawn over the menu.
  for (const name of ["Dashboard", "Documents"])
    expect(await isOnTop(page, "mobile-nav", name)).toBe(true);
  await expect(dialog.getByText("Settings")).toBeVisible();
  await expect(dialog.getByRole("link", { name: "Dashboard" })).toHaveAttribute(
    "aria-current",
    "page",
  );

  const axe = await new AxeBuilder({ page }).include('[data-testid="mobile-nav"]').analyze();
  expect(axe.violations).toEqual([]);
});

test("page scrolling is locked while open and restored after every way of closing", async ({
  page,
  baseURL,
}) => {
  await signedInPage(page, baseURL!);
  await page.goto("/en");
  const trigger = page.getByRole("button", { name: "Open menu" });
  expect(await scrollLocked(page)).toBe(false);

  // X button
  await openDrawer(page);
  expect(await scrollLocked(page)).toBe(true);
  await page.getByRole("button", { name: "Close menu" }).click();
  await expect(page.getByTestId("mobile-nav")).toBeHidden();
  await expect.poll(() => scrollLocked(page)).toBe(false);
  await expect(trigger).toBeFocused();

  // Escape
  await openDrawer(page);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("mobile-nav")).toBeHidden();
  await expect.poll(() => scrollLocked(page)).toBe(false);
  await expect(trigger).toBeFocused();

  // A tap on the backdrop, beside the drawer.
  const drawer = await openDrawer(page);
  const box = (await drawer.boundingBox())!;
  const viewport = page.viewportSize()!;
  await page.getByTestId("mobile-nav-backdrop").click({
    position: { x: box.x + box.width + (viewport.width - box.width) / 2, y: viewport.height / 2 },
  });
  await expect(drawer).toBeHidden();
  await expect.poll(() => scrollLocked(page)).toBe(false);
});

test("keyboard focus stays inside the open drawer", async ({ page, baseURL }) => {
  await signedInPage(page, baseURL!);
  await page.goto("/en");
  const drawer = await openDrawer(page);
  const focusInside = () => drawer.evaluate((el) => el.contains(document.activeElement));
  await expect.poll(focusInside).toBe(true);
  // At either end of the list Base UI's focus guard (outside the drawer) holds focus for a moment
  // and then moves it back into the drawer, so each step waits for focus to settle inside.
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press("Tab");
    await expect.poll(focusInside).toBe(true);
  }
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press("Shift+Tab");
    await expect.poll(focusInside).toBe(true);
  }
});

test("following a link closes the drawer and unlocks scrolling", async ({ page, baseURL }) => {
  await signedInPage(page, baseURL!);
  await page.goto("/en");
  const drawer = await openDrawer(page);
  await drawer.getByRole("link", { name: "Documents" }).click();
  await expect(page).toHaveURL(/\/en\/documents$/);
  await expect(drawer).toBeHidden();
  await expect.poll(() => scrollLocked(page)).toBe(false);
  expect(
    await page.evaluate(() => document.querySelectorAll('[data-testid="mobile-nav"]').length),
  ).toBe(0);
});

test("growing to the desktop layout closes the drawer; a short landscape screen scrolls the list", async ({
  page,
  baseURL,
}) => {
  await signedInPage(page, baseURL!);
  await page.goto("/en");
  await openDrawer(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.getByTestId("mobile-nav")).toBeHidden();
  await expect.poll(() => scrollLocked(page)).toBe(false);

  // Phone in landscape: the list is longer than the screen and scrolls inside the drawer.
  await page.setViewportSize({ width: 740, height: 340 });
  const drawer = await openDrawer(page);
  const list = drawer.getByRole("navigation");
  const { scrollHeight, clientHeight, overflowY } = await list.evaluate((el) => ({
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    overflowY: getComputedStyle(el).overflowY,
  }));
  expect(overflowY).toBe("auto");
  expect(scrollHeight).toBeGreaterThan(clientHeight);
  const last = drawer.getByText("Settings");
  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeInViewport();
  expect((await drawer.boundingBox())!.height).toBeGreaterThanOrEqual(339);
});
