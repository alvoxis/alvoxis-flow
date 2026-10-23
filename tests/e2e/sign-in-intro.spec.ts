import { expect, test } from "./support";

/**
 * The sign-in intro (3D word, particle field) never stands in the way: the form is usable during
 * it, any key skips it, and with reduced motion the card shows at once. Runs on desktop, tablet and
 * phone.
 */
const opacity = (el: Element) => Number(getComputedStyle(el).opacity);

test("the intro can be skipped and the form works right away", async ({ page }) => {
  await page.goto("/en/sign-in");
  await expect(page.getByTestId("sign-in-intro")).toBeVisible();
  const card = page.locator(".intro-card");
  await expect.poll(() => card.evaluate(opacity)).toBeLessThan(1);
  await page.keyboard.press("Shift");
  await expect.poll(() => card.evaluate(opacity)).toBe(1);
  await expect(page.getByRole("button", { name: "Skip" })).toHaveCount(0);
  await page.getByTestId("sign-in-form").locator("input[name=email]").fill("a@example.test");
  await expect(page.getByTestId("sign-in-form").locator("input[name=email]")).toHaveValue(
    "a@example.test",
  );
});

test("with reduced motion the sign-in card shows at once", async ({ browser }) => {
  const context = await browser.newContext({ reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.goto("/en/sign-in");
  await expect.poll(() => page.locator(".intro-card").evaluate(opacity)).toBe(1);
  await context.close();
});
