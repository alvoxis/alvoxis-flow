import AxeBuilder from "@axe-core/playwright";
import { type Page } from "@playwright/test";
import { secretFromOtpauthUri } from "../support/totp";
import { createVerifiedUser, expect, PASSWORD, signInViaForm, test, totp } from "./support";

/**
 * The delete-draft confirmation (Base UI AlertDialog, the UI-foundation pilot): keyboard, focus,
 * Esc, screen-reader semantics (axe) and protection against a second submission, on desktop,
 * tablet and phone. Synthetic data only.
 */

async function ownerWithDraft(page: Page, baseURL: string) {
  await signInViaForm(page, await createVerifiedUser(page.request, baseURL));
  await page.getByTestId("create-company").locator("input[name=name]").fill("Dialogi SIA");
  await page.getByTestId("create-company").getByRole("button").click();
  const link = page.getByTestId("company-documents-link");
  await expect(link).toBeVisible();
  const documentsUrl = (await link.getAttribute("href"))!;
  const companyId = documentsUrl.split("/").at(-2)!;
  const headers = { origin: baseURL };
  // The owner role needs 2FA before it may change documents.
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
  const res = await page.request.post(`/api/companies/${companyId}/documents`, {
    data: {
      type: "invoice",
      language: "en",
      currency: "EUR",
      issueDate: "2026-03-02",
      buyer: { name: "Dialoga Pircējs SIA" },
      lines: [],
    },
    headers,
  });
  expect(res.status()).toBe(201);
  const id = String((await res.json()).document.id);
  return { companyId, documentsUrl, id, headers };
}

// The app's service worker has a fetch handler, so API calls pass through it; Playwright's WebKit
// does not route requests that go through a service worker (Chromium does). Without it here,
// page.route below sees the DELETE in every browser.
test.use({ serviceWorkers: "block" });

function rowOf(page: Page, id: string) {
  return page.locator(`[data-testid="document-row"][data-document-id="${id}"]`);
}

test("the delete confirmation is an accessible modal: focus, keyboard, Esc and axe", async ({
  page,
  baseURL,
}) => {
  const { companyId, documentsUrl, id, headers } = await ownerWithDraft(page, baseURL!);
  await page.goto(documentsUrl);
  const trigger = rowOf(page, id).getByRole("button", { name: "Delete draft" });
  await trigger.click();

  const dialog = page.getByRole("alertdialog", { name: "Delete this draft?" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAccessibleDescription(/deleted permanently/);
  // The safe action has the focus; deleting needs a deliberate move to the other button.
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();

  // No accessibility violations in the open dialog (WCAG 2.1 A/AA rules).
  const axe = await new AxeBuilder({ page })
    .include('[data-testid="delete-confirm"]')
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(axe.violations).toEqual([]);

  // Tab and Shift+Tab cycle between the two actions and never leave the dialog.
  const cycle = [
    ["Tab", "Delete permanently"],
    ["Tab", "Cancel"],
    ["Tab", "Delete permanently"],
    ["Shift+Tab", "Cancel"],
    ["Shift+Tab", "Delete permanently"],
    ["Shift+Tab", "Cancel"],
  ] as const;
  for (const [key, focused] of cycle) {
    await page.keyboard.press(key);
    await expect(dialog.getByRole("button", { name: focused })).toBeFocused();
  }
  // The rest of the page is hidden from assistive technology while the dialog is open.
  expect(
    await page
      .getByTestId("new-document-link")
      .evaluate((el) => !!el.closest('[inert], [aria-hidden="true"]')),
  ).toBe(true);

  // Esc closes without deleting and returns the focus to the button that opened the dialog.
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(rowOf(page, id)).toHaveCount(1);
  const stillThere = await page.request.get(`/api/companies/${companyId}/documents/${id}`, {
    headers,
  });
  expect(stillThere.status()).toBe(200);

  // Keyboard only: Enter opens it again, Cancel (focused) closes it, still nothing deleted.
  await trigger.press("Enter");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(rowOf(page, id)).toHaveCount(1);
});

test("confirming deletes the draft exactly once; the actions are blocked meanwhile", async ({
  page,
  baseURL,
}) => {
  const { companyId, documentsUrl, id } = await ownerWithDraft(page, baseURL!);
  // Hold the DELETE request until the test releases it, and count how many are sent.
  let deletes = 0;
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  await page.route(`**/api/companies/${companyId}/documents/${id}`, async (route) => {
    if (route.request().method() !== "DELETE") return route.continue();
    deletes += 1;
    await released;
    await route.continue();
  });

  await page.goto(documentsUrl);
  await rowOf(page, id).getByRole("button", { name: "Delete draft" }).click();
  const dialog = page.getByRole("alertdialog", { name: "Delete this draft?" });
  const confirm = dialog.getByRole("button", { name: "Delete permanently" });
  await confirm.click();

  // While the request runs: both actions are disabled, a second click and Esc change nothing.
  await expect(confirm).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeDisabled();
  await confirm.click({ force: true });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();

  release();
  await expect(page).toHaveURL(new RegExp(`${documentsUrl}\\?deleted=1$`));
  await expect(page.getByRole("status").filter({ hasText: "Draft deleted." })).toBeVisible();
  await expect(rowOf(page, id)).toHaveCount(0);
  expect(deletes).toBe(1);
});

test("with reduced motion the dialog opens and closes without transitions", async ({
  page,
  baseURL,
}) => {
  const { documentsUrl, id } = await ownerWithDraft(page, baseURL!);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(documentsUrl);
  await rowOf(page, id).getByRole("button", { name: "Delete draft" }).click();
  const dialog = page.getByRole("alertdialog", { name: "Delete this draft?" });
  await expect(dialog).toBeVisible();
  const duration = await dialog.evaluate((el) => getComputedStyle(el).transitionDuration);
  expect(parseFloat(duration)).toBeLessThan(0.001);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("the notification region is labelled in the page language", async ({ page }) => {
  await page.goto("/ru/sign-in");
  await expect(page.getByRole("region", { name: "Уведомления" })).toHaveCount(1);
  await page.goto("/lv/sign-in");
  await expect(page.getByRole("region", { name: "Paziņojumi" })).toHaveCount(1);
});
