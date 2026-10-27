import { expect, signedInPage, test } from "./support";

/** The operator area is not reachable for an ordinary signed-in user: it looks like any unknown page. */
test("ordinary users get not-found at /admin", async ({ page, baseURL }) => {
  await signedInPage(page, baseURL!);
  const res = await page.goto("/en/admin");
  expect(res?.status()).toBe(404);
  await expect(page.getByTestId("admin")).toHaveCount(0);
});
