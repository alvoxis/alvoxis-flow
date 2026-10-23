import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { ownerWithIssuedInvoice } from "./document-helpers";
import { E2E_SQL_AVAILABLE, e2eDatabase } from "./e2e-db";
import { createVerifiedUser, expect, signInViaForm, test } from "./support";

/**
 * Importing a PDF invoice: upload → server reads it (nothing stored, nothing created) → the user
 * checks every finding, confirms a duplicate, picks the tax category → a draft opens in the
 * editor. The PDF is a FICTITIOUS sample rendered by the app itself.
 */

test.use({ serviceWorkers: "block" });

/** The app's own English sample invoice, rendered by `pnpm docs:samples` (a separate process). */
function samplePdf(): Buffer {
  const dir = mkdtempSync(path.join(tmpdir(), "alvoxis-import-"));
  execFileSync("pnpm", ["-s", "docs:samples", dir, "en"], { stdio: "ignore" });
  return readFileSync(path.join(dir, "invoice.en.pdf"));
}

test("import a PDF: review the findings and a duplicate, then a draft opens in the editor", async ({
  page,
  baseURL,
}) => {
  // The owner already has INV-2026-0001 dated 2026-03-02, like the sample PDF: a certain duplicate.
  const { companyId } = await ownerWithIssuedInvoice(page, baseURL!);
  const pdf = samplePdf();
  let requests = 0;
  page.on("request", (r) => {
    if (r.url().includes("/documents/import")) requests += r.method() === "POST" ? 1 : 0;
  });

  await page.goto(`/en/companies/${companyId}/documents`);
  await page.getByTestId("import-pdf-link").click();
  await expect(page.getByRole("heading", { name: "Import a PDF invoice" })).toBeVisible();
  const upload = page.getByTestId("import-upload");
  await expect(upload).toContainText("is not stored");

  // Checked in the browser: no file, a file that is too large; on the server: not a PDF.
  await upload.getByRole("button", { name: "Read PDF" }).click();
  await expect(page.getByTestId("import-notice")).toHaveText("Choose a PDF file first.");
  await upload.getByLabel("PDF file").setInputFiles({
    name: "big.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.alloc(5 * 1024 * 1024),
  });
  await upload.getByRole("button", { name: "Read PDF" }).click();
  await expect(page.getByTestId("import-notice")).toHaveText("The file is larger than 4 MB.");
  expect(requests).toBe(0);
  await upload.getByLabel("PDF file").setInputFiles({
    name: "notes.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("hello"),
  });
  await upload.getByRole("button", { name: "Read PDF" }).click();
  await expect(page.getByTestId("import-notice")).toHaveText("This file is not a PDF.");

  await upload.getByLabel("PDF file").setInputFiles({
    name: "invoice.pdf",
    mimeType: "application/pdf",
    buffer: pdf,
  });
  await upload.getByRole("button", { name: "Read PDF" }).click();
  const review = page.getByTestId("import-review");
  await expect(review.getByTestId("import-file")).toHaveText("invoice.pdf: 1 page read");
  await expect(review.locator('input[name="number"]')).toHaveValue("INV-2026-0001");
  await expect(review.getByLabel("Buyer name")).toHaveValue("Sample Shipping Agency Ltd");
  await expect(review.getByTestId("import-line")).toHaveCount(4);
  await expect(review.getByText("Seller: your company")).toBeVisible();
  const ambiguous = review.locator(
    '[data-testid="import-finding"][data-code="date.formatAmbiguous"]',
  );
  await expect(ambiguous).toContainText("A date can be read in more than one way");
  await expect(review.getByTestId("import-duplicates")).toContainText("INV-2026-0001");
  await expect(review.getByTestId("import-duplicates")).toContainText("almost certainly the same");

  // No accessibility violations on the review form (WCAG 2.1 A/AA); fits a phone.
  const axe = await new AxeBuilder({ page })
    .include('[data-testid="import-review"]')
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(axe.violations).toEqual([]);

  // Nothing is created until every gap is closed.
  const before = requests;
  await review.getByRole("button", { name: "Create draft" }).click();
  await expect(page.getByTestId("import-problems")).toContainText("Choose a tax category.");
  await expect(page.getByTestId("import-problems")).toContainText("Check every finding.");
  await expect(page.getByTestId("import-problems")).toContainText("possible duplicate");
  expect(requests).toBe(before);

  for (const finding of await review.getByTestId("import-finding").getByRole("checkbox").all())
    await finding.check();
  await review.getByText("I have checked the existing document").click();
  await review.getByLabel("Tax category for all lines").selectOption({ index: 1 });
  await review.getByRole("button", { name: "Create draft" }).click();

  await expect(page.getByTestId("document-heading")).toHaveText("Invoice (Draft)");
  const editor = page.getByTestId("document-editor");
  await expect(editor.locator('input[name="buyer.name"]')).toHaveValue(
    "Sample Shipping Agency Ltd",
  );
  await expect(editor.locator('input[name="lines.0.quantity"]')).toHaveValue("10");
  await expect(editor.locator('input[name="lines.3.description"]')).toHaveValue("Shipping");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(0);
});

test("import is only offered to roles that may create documents", async ({
  page,
  browser,
  baseURL,
}) => {
  test.skip(!E2E_SQL_AVAILABLE, "needs the isolated e2e database (E2E_DATABASE_URL)");
  const owner = await browser.newContext();
  const ownerPage = await owner.newPage();
  const { companyId } = await ownerWithIssuedInvoice(ownerPage, baseURL!);
  await owner.close();
  const email = await createVerifiedUser(page.request, baseURL!);
  const db = e2eDatabase();
  try {
    await db.query(
      `INSERT INTO memberships (company_id, user_id, role_id)
       SELECT $1, u.id, r.id FROM users u, roles r
       WHERE u.email = $2 AND r.company_id = $1 AND r.key = 'warehouse_employee'`,
      [companyId, email],
    );
  } finally {
    await db.end();
  }
  await signInViaForm(page, email);
  await expect(page).toHaveURL(/\/en$/);
  await page.goto(`/en/companies/${companyId}/documents`);
  await expect(page.getByTestId("document-row")).toHaveCount(1);
  await expect(page.getByTestId("import-pdf-link")).toHaveCount(0);
  expect((await page.goto(`/en/companies/${companyId}/documents/import`))?.status()).toBe(404);
});
