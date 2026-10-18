import AxeBuilder from "@axe-core/playwright";
import { type Page } from "@playwright/test";
import { createDocument, ownerWithIssuedInvoice } from "./document-helpers";
import { E2E_SQL_AVAILABLE, e2eDatabase } from "./e2e-db";
import { createVerifiedUser, expect, newDevice, signInViaForm, test } from "./support";

/**
 * Documents workspace: search, filters, sorting and paging of the list (server-side, kept in the
 * URL and restored by a document's back link), and the invoice ↔ credit note links in both
 * directions, with roles, other tenants, phone layout and accessibility. Synthetic data only.
 */

test.use({ serviceWorkers: "block" });

function overflow(page: Page) {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

async function axe(page: Page, selector: string) {
  const result = await new AxeBuilder({ page })
    .include(selector)
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(result.violations).toEqual([]);
}

const rows = (page: Page) => page.getByTestId("document-row");

test("search, filters and sorting run on the server, stay in the URL and survive a visit", async ({
  page,
  baseURL,
}) => {
  const { companyId, headers, taxCategoryId } = await ownerWithIssuedInvoice(page, baseURL!);
  // INV-2026-0001 (issued, "Kredīta Pircējs SIA", 2026-03-02) plus three more.
  await createDocument(page, companyId, headers, taxCategoryId, {
    buyer: { name: "Alfa Kurpes SIA" },
    issueDate: "2026-03-05",
    issue: true,
  });
  await createDocument(page, companyId, headers, taxCategoryId, {
    buyer: { name: "Alfa Kurpes SIA" },
    issueDate: "2026-03-08",
  });
  await createDocument(page, companyId, headers, taxCategoryId, {
    type: "proforma",
    buyer: { name: "Beta Zābaki SIA" },
    issueDate: "2026-02-20",
  });
  const listUrl = `/en/companies/${companyId}/documents`;
  await page.goto(listUrl);
  const filters = page.getByTestId("document-filters");
  await expect(rows(page)).toHaveCount(4);
  await expect(page.getByTestId("document-pagination")).toContainText("1–4 of 4");
  await expect(page.getByTestId("document-filters-reset")).toHaveCount(0);
  await axe(page, '[data-testid="document-filters"]');

  // Search by buyer, with extra spaces; the result is the same on a reload (URL state).
  await filters.getByLabel("Search").fill("   alfa    kurpes ");
  await filters.getByRole("button", { name: "Apply" }).click();
  await expect(page).toHaveURL(/q=alfa\+kurpes/);
  await expect(rows(page)).toHaveCount(2);
  await page.reload();
  await expect(rows(page)).toHaveCount(2);
  await expect(filters.getByLabel("Search")).toHaveValue("alfa kurpes");

  // Status filter on top of the search, then open the document and come back to the same view.
  await filters.getByLabel("Status").selectOption("issued");
  await filters.getByRole("button", { name: "Apply" }).click();
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).getByTestId("document-number")).toHaveText("INV-2026-0002");
  await rows(page).getByRole("link").click();
  await expect(page.getByTestId("document-heading")).toContainText("INV-2026-0002");
  await page.getByTestId("documents-back-link").click();
  await expect(page).toHaveURL(/q=alfa\+kurpes&status=issued$/);
  await expect(rows(page)).toHaveCount(1);
  await expect(filters.getByLabel("Status")).toHaveValue("issued");

  // Search by number, type and date range.
  await page.goto(`${listUrl}?q=inv-2026-0001`);
  await expect(rows(page).getByTestId("document-number")).toHaveText(["INV-2026-0001"]);
  await page.goto(`${listUrl}?type=proforma`);
  await expect(rows(page)).toHaveCount(1);
  await page.goto(`${listUrl}?from=2026-03-01&to=2026-03-06`);
  await expect(rows(page).getByTestId("document-number")).toHaveText([
    "INV-2026-0002",
    "INV-2026-0001",
  ]);

  // Sorting by number: issued numbers ascending, drafts (no number) last.
  await page.goto(listUrl);
  await filters.getByLabel("Sort by").selectOption("number_asc");
  await filters.getByRole("button", { name: "Apply" }).click();
  await expect(rows(page).getByTestId("document-number")).toHaveText([
    "INV-2026-0001",
    "INV-2026-0002",
    "Not issued yet",
    "Not issued yet",
  ]);
  await filters.getByLabel("Sort by").selectOption("amount_desc");
  await filters.getByRole("button", { name: "Apply" }).click();
  await expect(filters).toContainText("Amounts are sorted within each currency");

  // Nothing found: a clear message and a way back; reset clears everything.
  await page.goto(`${listUrl}?q=no-such-document`);
  await expect(page.getByTestId("documents-no-matches")).toContainText(
    "No documents match your search or filters.",
  );
  await expect(page.getByTestId("documents-empty")).toHaveCount(0);
  await page.getByTestId("document-filters-reset").click();
  await expect(page).toHaveURL(new RegExp(`${listUrl}$`));
  await expect(rows(page)).toHaveCount(4);

  // Invalid parameters are ignored instead of failing.
  await page.goto(`${listUrl}?type=receipt&from=2026-02-31&sort=evil&page=-1`);
  await expect(page).toHaveURL(new RegExp(`${listUrl}$`)); // cleaned up
  await expect(rows(page)).toHaveCount(4);

  // Phone width: filters and list fit without horizontal scrolling; controls are 44 px high.
  for (const width of [375, 390]) {
    await page.setViewportSize({ width, height: 800 });
    expect(await overflow(page)).toBeLessThanOrEqual(0);
  }
  const box = await filters.getByRole("button", { name: "Apply" }).boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);
});

test("the list is paged on the server with previous/next links", async ({ page, baseURL }) => {
  const { companyId, headers, taxCategoryId } = await ownerWithIssuedInvoice(page, baseURL!);
  for (let i = 0; i < 25; i++)
    await createDocument(page, companyId, headers, taxCategoryId, {
      buyer: { name: `Lapa ${i}` },
    });
  const listUrl = `/en/companies/${companyId}/documents`;
  await page.goto(`${listUrl}?status=draft`);
  const pager = page.getByTestId("document-pagination");
  await expect(rows(page)).toHaveCount(25);
  await expect(pager).toContainText("1–25 of 25");
  await expect(pager.getByRole("link")).toHaveCount(0);

  await page.goto(listUrl);
  await expect(pager).toContainText("1–25 of 26");
  await pager.getByRole("link", { name: "Next page" }).click();
  await expect(page).toHaveURL(/page=2$/);
  await expect(rows(page)).toHaveCount(1);
  await expect(pager).toContainText("26–26 of 26");
  await pager.getByRole("link", { name: "Previous page" }).click();
  await expect(rows(page)).toHaveCount(25);
  await axe(page, '[data-testid="document-pagination"]');
});

test("invoice ↔ credit note: listed on the invoice, linked back from the note", async ({
  page,
  baseURL,
}) => {
  const { invoiceUrl, invoiceId } = await ownerWithIssuedInvoice(page, baseURL!);
  await page.goto(invoiceUrl);
  const related = page.getByTestId("related-credit-notes");
  await expect(related.getByTestId("related-credit-notes-empty")).toHaveText(
    "No credit notes for this invoice yet.",
  );

  // A credit note draft (full) from the dialog: its page links back to the invoice.
  await page.getByRole("button", { name: "Create credit note" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Create draft" }).click();
  await expect(page.getByTestId("document-heading")).toHaveText("Credit note (Draft)");
  const relation = page.getByTestId("document-relation");
  await expect(relation).toContainText("Credit note for invoice INV-2026-0001 dated 2 Mar 2026");
  const noteUrl = page.url();

  await relation.getByRole("link", { name: "INV-2026-0001" }).click();
  await expect(page).toHaveURL(new RegExp(`${invoiceId}$`));
  const items = related.getByTestId("related-credit-note");
  await expect(items).toHaveCount(1);
  await expect(items).toHaveAttribute("data-status", "draft");
  await expect(items).toContainText("Not issued yet");
  await expect(items).toContainText("Draft");

  // Issue it: the invoice then lists CN-2026-0001 as issued with a negative total.
  await page.goto(noteUrl);
  await page.getByRole("button", { name: "Issue document" }).click();
  await page.getByTestId("issue-confirm").getByRole("button", { name: "Issue now" }).click();
  await expect(page.getByTestId("issued-notice")).toContainText("CN-2026-0001");
  await expect(page.getByTestId("document-relation")).toContainText("INV-2026-0001");
  await page.getByTestId("document-relation-link").click();
  await expect(items).toHaveAttribute("data-status", "issued");
  await expect(items).toContainText("CN-2026-0001");
  await expect(items).toContainText("Issued");
  await expect(items).toContainText("-€");
  await axe(page, '[data-testid="related-credit-notes"]');

  // Phone layout: cards, no horizontal scrolling; the link opens the credit note.
  await page.setViewportSize({ width: 375, height: 800 });
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await items.getByRole("link", { name: /CN-2026-0001/ }).click();
  await expect(page.getByTestId("document-heading")).toContainText("CN-2026-0001");
  expect(await overflow(page)).toBeLessThanOrEqual(0);
});

test("roles and tenants: viewers see the links, cannot create; other companies get 404", async ({
  page,
  browser,
  baseURL,
}) => {
  test.skip(!E2E_SQL_AVAILABLE, "needs the isolated e2e database (E2E_DATABASE_URL)");
  const owner = await newDevice(browser);
  const ownerPage = await owner.newPage();
  const { companyId, invoiceUrl, headers } = await ownerWithIssuedInvoice(ownerPage, baseURL!);
  const created = await ownerPage.request.post(
    `/api/companies/${companyId}/documents/${invoiceUrl.split("/").at(-1)}/credit-note`,
    { data: { issueDate: "2026-03-10", lines: "full" }, headers },
  );
  const noteId = String((await created.json()).document.id);
  await owner.close();

  // A warehouse employee (documents.view only) sees both links but cannot create credit notes.
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
  await page.goto(invoiceUrl);
  await expect(page.getByTestId("related-credit-note")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Create credit note" })).toHaveCount(0);
  await page.getByTestId("related-credit-note").getByRole("link").click();
  await expect(page.getByTestId("document-relation-link")).toHaveText("INV-2026-0001");
  await page.goto(`/en/companies/${companyId}/documents?type=credit_note`);
  await expect(rows(page)).toHaveCount(1);

  // Another tenant: neither the invoice nor the note nor the list is reachable.
  const stranger = await newDevice(browser);
  const strangerPage = await stranger.newPage();
  await signInViaForm(strangerPage, await createVerifiedUser(strangerPage.request, baseURL!));
  await expect(strangerPage).toHaveURL(/\/en$/);
  for (const url of [
    invoiceUrl,
    `/en/companies/${companyId}/documents/${noteId}`,
    `/en/companies/${companyId}/documents?q=INV`,
  ]) {
    expect((await strangerPage.goto(url))?.status(), url).toBe(404);
  }
  await stranger.close();
});
