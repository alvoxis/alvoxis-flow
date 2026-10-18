import AxeBuilder from "@axe-core/playwright";
import { type Page } from "@playwright/test";
import { FIXTURE_TAX, invoiceDraft } from "../support/document-fixtures";
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
 * Credit notes from the UI: an issued invoice → the credit-note dialog (full or partial) → the
 * draft in the existing editor → issued through the usual confirmation. Covers form checks, the
 * localized rule findings of the API, access by role, other tenants, double submission, phone
 * layout and accessibility. Synthetic data only; the fixture tax rate is arbitrary.
 */

// API calls from the page go through the app's service worker; WebKit does not route those
// (see dialogs.spec.ts), and the double-submit test below holds the request with page.route.
test.use({ serviceWorkers: "block" });

type Headers = Record<string, string>;

/** Owner with 2FA, a complete seller profile and an issued invoice INV-2026-0001 (2026-03-02):
 *  line 1 "Winter jacket" 10 × 65.00, line 2 "Safety boots" 10 × 45.00, fixture tax 20 %. */
async function ownerWithIssuedInvoice(page: Page, baseURL: string) {
  await signInViaForm(page, await createVerifiedUser(page.request, baseURL));
  await page.getByTestId("create-company").locator("input[name=name]").fill("Kredīts SIA");
  await page.getByTestId("create-company").getByRole("button").click();
  const docsLink = page.getByTestId("company-documents-link");
  await expect(docsLink).toBeVisible();
  const companyId = (await docsLink.getAttribute("href"))!.split("/").at(-2)!;
  const headers: Headers = { origin: baseURL };
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
  const profile = await page.request.patch(`/api/companies/${companyId}/profile`, {
    data: {
      name: "Kredīts SIA",
      legalName: "SIA Kredīts Tests",
      registrationNumber: "40000000005",
      vatNumber: "LV40000000005",
      addressLine1: "Testa iela 7",
      addressLine2: "",
      postalCode: "LV-1005",
      city: "Rīga",
    },
    headers,
  });
  expect(profile.status()).toBe(200);
  const category = await page.request.post(`/api/companies/${companyId}/tax-categories`, {
    data: FIXTURE_TAX.standard20,
    headers,
  });
  const taxCategoryId = String((await category.json()).taxCategory.id);
  const {
    lines,
    relation: _r,
    bankAccounts: _b,
    ...rest
  } = invoiceDraft({ buyer: { name: "Kredīta Pircējs SIA" } });
  const created = await page.request.post(`/api/companies/${companyId}/documents`, {
    data: {
      ...rest,
      lines: lines.map(({ id: _id, sourceLineId: _s, taxCategory: _t, ...l }) => ({
        ...l,
        taxCategoryId,
      })),
    },
    headers,
  });
  expect(created.status()).toBe(201);
  const invoiceId = String((await created.json()).document.id);
  const issued = await page.request.post(
    `/api/companies/${companyId}/documents/${invoiceId}/issue`,
    { data: { expectedVersion: 1 }, headers },
  );
  expect(issued.status()).toBe(200);
  const invoiceUrl = `/en/companies/${companyId}/documents/${invoiceId}`;
  return { companyId, invoiceId, invoiceUrl, headers };
}

function creditDialog(page: Page) {
  return page.getByRole("alertdialog", { name: "Credit note for invoice INV-2026-0001" });
}

async function openCreditDialog(page: Page, invoiceUrl: string) {
  await page.goto(invoiceUrl);
  await page.getByRole("button", { name: "Create credit note" }).click();
  const dialog = creditDialog(page);
  await expect(dialog).toBeVisible();
  return dialog;
}

function lineInput(page: Page, n: number, description: string) {
  return creditDialog(page).getByRole("textbox", {
    name: `Quantity to credit, line ${n}: ${description}`,
  });
}

function overflow(page: Page) {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

test("full credit note: dialog → draft in the editor → issued with the next CN number", async ({
  page,
  baseURL,
}) => {
  const { invoiceUrl } = await ownerWithIssuedInvoice(page, baseURL!);
  const dialog = await openCreditDialog(page, invoiceUrl);

  // An accessible modal: described, focus on the safe action, no axe violations, fits a phone.
  await expect(dialog).toHaveAccessibleDescription(/invoice itself is never changed/);
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await expect(dialog.getByRole("radio", { name: /Everything that remains/ })).toBeChecked();
  await expect(dialog.getByLabel("Document language")).toHaveValue("en");
  const axe = await new AxeBuilder({ page })
    .include('[data-testid="credit-note-dialog"]')
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(axe.violations).toEqual([]);
  expect(await overflow(page)).toBeLessThanOrEqual(0);

  await dialog.getByLabel("Issue date").fill("2026-03-10");
  await dialog.getByLabel("Document language").selectOption("lv");
  await dialog.getByRole("button", { name: "Create draft" }).click();

  // The new draft opens in the existing editor: credited lines are fixed and negative.
  await expect(page.getByTestId("document-heading")).toHaveText("Credit note (Draft)");
  const editor = page.getByTestId("document-editor");
  await expect(editor.locator('input[name="lines.0.quantity"]')).toHaveValue("-10");
  await expect(editor.locator('input[name="lines.1.quantity"]')).toHaveValue("-10");
  await expect(editor.locator('input[name="issueDate"]')).toHaveValue("2026-03-10");

  // Issued through the usual (modal) confirmation; the number comes from the credit-note series.
  await editor.getByRole("button", { name: "Issue document" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Issue this document?" });
  await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
  await confirm.getByRole("button", { name: "Issue now" }).click();
  await expect(page.getByTestId("issued-notice")).toContainText("CN-2026-0001");
  await expect(page.getByTestId("document-heading")).toContainText("Credit note CN-2026-0001");
  await expect(page.getByTestId("document-gross-total")).toContainText("-");
  // A credit note cannot itself be credited from the UI.
  await expect(page.getByRole("button", { name: "Create credit note" })).toHaveCount(0);

  // Everything is credited now: a second full credit note is refused with a clear message and
  // the dialog stays open.
  const again = await openCreditDialog(page, invoiceUrl);
  await again.getByRole("button", { name: "Create draft" }).click();
  await expect(
    again.locator('[data-testid="document-issue"][data-code="creditNote.nothingRemaining"]'),
  ).toHaveText(/This invoice has already been credited in full\./);
  await expect(again).toBeVisible();
});

test("partial credit note: form checks, localized API findings and the remaining quantity", async ({
  page,
  baseURL,
}) => {
  const { companyId, invoiceId, invoiceUrl, headers } = await ownerWithIssuedInvoice(
    page,
    baseURL!,
  );
  let posts = 0;
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith("/credit-note")) posts += 1;
  });
  const dialog = await openCreditDialog(page, invoiceUrl);
  await dialog.getByRole("radio", { name: /Selected lines/ }).check();
  await expect(dialog.getByTestId("credit-note-line")).toHaveCount(2);
  await expect(dialog.getByTestId("credit-note-line").first()).toContainText("Invoiced: 10 pcs");
  const submit = dialog.getByRole("button", { name: "Create draft" });

  // Caught in the form, nothing is sent: no line, bad numbers, more than invoiced, early date.
  await submit.click();
  await expect(dialog.getByTestId("credit-note-form-error")).toHaveText(
    "Enter a quantity for at least one line.",
  );
  await lineInput(page, 1, "Winter jacket").fill("0");
  await lineInput(page, 2, "Safety boots").fill("11");
  await dialog.getByLabel("Issue date").fill("2026-03-01");
  await submit.click();
  await expect(lineInput(page, 1, "Winter jacket")).toHaveAttribute("aria-invalid", "true");
  await expect(lineInput(page, 1, "Winter jacket")).toHaveAccessibleDescription(
    /greater than zero/,
  );
  await expect(lineInput(page, 2, "Safety boots")).toHaveAccessibleDescription(
    "This is more than the invoiced quantity.",
  );
  await expect(dialog.getByTestId("credit-note-form-error")).toHaveText(
    "The credit note date cannot be earlier than the invoice date.",
  );
  expect(posts).toBe(0);

  // Another credit note issued meanwhile (here through the API) leaves 4 boots; asking for 6 is
  // refused by the server with its own, translated rule code.
  const invoice = await page.request.get(`/api/companies/${companyId}/documents/${invoiceId}`, {
    headers,
  });
  const bootsLineId = String((await invoice.json()).document.draft.lines[1].id);
  const other = await page.request.post(
    `/api/companies/${companyId}/documents/${invoiceId}/credit-note`,
    {
      data: { issueDate: "2026-03-05", lines: [{ sourceLineId: bootsLineId, quantity: "6" }] },
      headers,
    },
  );
  expect(other.status()).toBe(201);
  const otherId = String((await other.json()).document.id);
  const issuedOther = await page.request.post(
    `/api/companies/${companyId}/documents/${otherId}/issue`,
    { data: { expectedVersion: 1 }, headers },
  );
  expect(issuedOther.status()).toBe(200);

  await lineInput(page, 1, "Winter jacket").fill("");
  await lineInput(page, 2, "Safety boots").fill("6");
  await dialog.getByLabel("Issue date").fill("2026-03-10");
  await submit.click();
  await expect(
    dialog.locator(
      '[data-testid="document-issue"][data-code="creditNote.quantity.exceedsRemaining"]',
    ),
  ).toHaveText(/more than what remains on an invoice line/);
  await expect(dialog.getByText("The credit note draft was not created.")).toBeVisible();
  expect(posts).toBe(1);

  // What remains is accepted (decimal comma allowed): one draft line, 4 boots credited.
  await lineInput(page, 2, "Safety boots").fill("4,0");
  await submit.click();
  await expect(page.getByTestId("document-heading")).toHaveText("Credit note (Draft)");
  const editor = page.getByTestId("document-editor");
  await expect(editor.locator('input[name="lines.0.quantity"]')).toHaveValue("-4");
  await expect(editor.locator('input[name="lines.1.quantity"]')).toHaveCount(0);
});

test("one click, one draft: the dialog is locked while the request runs", async ({
  page,
  baseURL,
}) => {
  const { companyId, invoiceId, invoiceUrl, headers } = await ownerWithIssuedInvoice(
    page,
    baseURL!,
  );
  let posts = 0;
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  await page.route(
    `**/api/companies/${companyId}/documents/${invoiceId}/credit-note`,
    async (r) => {
      posts += 1;
      await released;
      await r.continue();
    },
  );
  const dialog = await openCreditDialog(page, invoiceUrl);
  const submit = dialog.getByRole("button", { name: "Create draft" });
  await submit.click();
  await expect(submit).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeDisabled();
  await submit.click({ force: true });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  release();
  await expect(page.getByTestId("document-heading")).toHaveText("Credit note (Draft)");
  expect(posts).toBe(1);
  const list = await page.request.get(`/api/companies/${companyId}/documents`, { headers });
  const notes = ((await list.json()).documents as { type: string }[]).filter(
    (d) => d.type === "credit_note",
  );
  expect(notes).toHaveLength(1);
});

test("roles: a manager creates but cannot issue; warehouse sees no button; other tenants get 404", async ({
  page,
  browser,
  baseURL,
}) => {
  test.skip(!E2E_SQL_AVAILABLE, "needs the isolated e2e database (E2E_DATABASE_URL)");
  const owner = await newDevice(browser);
  const ownerPage = await owner.newPage();
  const { companyId, invoiceUrl } = await ownerWithIssuedInvoice(ownerPage, baseURL!);
  await owner.close();

  const member = async (role: string) => {
    const email = await createVerifiedUser(page.request, baseURL!);
    const db = e2eDatabase();
    try {
      await db.query(
        `INSERT INTO memberships (company_id, user_id, role_id)
         SELECT $1, u.id, r.id FROM users u, roles r
         WHERE u.email = $2 AND r.company_id = $1 AND r.key = $3`,
        [companyId, email, role],
      );
    } finally {
      await db.end();
    }
    return email;
  };

  // Warehouse employee: may view the invoice, may not create credit notes.
  const warehouse = await newDevice(browser);
  const warehousePage = await warehouse.newPage();
  await signInViaForm(warehousePage, await member("warehouse_employee"));
  await expect(warehousePage).toHaveURL(/\/en$/);
  await warehousePage.goto(invoiceUrl);
  await expect(warehousePage.getByTestId("issued-notice")).toBeVisible();
  await expect(warehousePage.getByRole("button", { name: "Create credit note" })).toHaveCount(0);
  await warehouse.close();

  // Manager: creates the draft, but issuing needs documents.approve.
  await signInViaForm(page, await member("manager"));
  await expect(page).toHaveURL(/\/en$/);
  const dialog = await openCreditDialog(page, invoiceUrl);
  await dialog.getByRole("button", { name: "Create draft" }).click();
  await expect(page.getByTestId("document-heading")).toHaveText("Credit note (Draft)");
  await expect(page.getByRole("button", { name: "Issue document" })).toHaveCount(0);

  // Another tenant's owner cannot even see the invoice (404), so there is nothing to credit.
  const stranger = await newDevice(browser);
  const strangerPage = await stranger.newPage();
  await signInViaForm(strangerPage, await createVerifiedUser(strangerPage.request, baseURL!));
  await expect(strangerPage).toHaveURL(/\/en$/);
  const res = await strangerPage.goto(invoiceUrl);
  expect(res?.status()).toBe(404);
  await expect(strangerPage.getByRole("button", { name: "Create credit note" })).toHaveCount(0);
  await stranger.close();
});

test("phone layout and reduced motion: no horizontal scrolling, no transitions", async ({
  page,
  baseURL,
}) => {
  const { invoiceUrl } = await ownerWithIssuedInvoice(page, baseURL!);
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const width of [375, 390]) {
    await page.setViewportSize({ width, height: 740 });
    const dialog = await openCreditDialog(page, invoiceUrl);
    await dialog.getByRole("radio", { name: /Selected lines/ }).check();
    await expect(dialog.getByTestId("credit-note-line")).toHaveCount(2);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    expect(await dialog.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
    const box = (await dialog.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    // The submit button is reachable (the dialog scrolls inside the viewport if needed).
    await dialog.getByRole("button", { name: "Create draft" }).scrollIntoViewIfNeeded();
    await expect(dialog.getByRole("button", { name: "Create draft" })).toBeInViewport();
    const duration = await dialog.evaluate((el) => getComputedStyle(el).transitionDuration);
    expect(parseFloat(duration)).toBeLessThan(0.001);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  }
});
