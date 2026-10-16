import { readFile } from "node:fs/promises";
import { type Page } from "@playwright/test";
import { extractText } from "unpdf";
import { secretFromOtpauthUri } from "../support/totp";
import { FIXTURE_TAX } from "../support/document-fixtures";
import { createVerifiedUser, expect, PASSWORD, signInViaForm, test, totp } from "./support";

/** Getting the PDF of a draft and of an issued document from the UI. Synthetic data only. */

async function ownerWithDraft(page: Page, baseURL: string) {
  await signInViaForm(page, await createVerifiedUser(page.request, baseURL));
  await page.getByTestId("create-company").locator("input[name=name]").fill("PDF SIA");
  await page.getByTestId("create-company").getByRole("button").click();
  const link = page.getByTestId("company-documents-link");
  await expect(link).toBeVisible();
  const documentsUrl = (await link.getAttribute("href"))!;
  const companyId = documentsUrl.split("/").at(-2)!;
  const headers = { origin: baseURL };
  const enable = await page.request.post("/api/auth/two-factor/enable", {
    data: { password: PASSWORD },
    headers,
  });
  const secret = secretFromOtpauthUri(String((await enable.json()).totpURI));
  await page.request.post("/api/auth/two-factor/verify-totp", {
    data: { code: totp(secret) },
    headers,
  });
  await page.request.patch(`/api/companies/${companyId}/profile`, {
    data: {
      name: "PDF SIA",
      legalName: "SIA PDF Tests",
      registrationNumber: "40000000005",
      vatNumber: "LV40000000005",
      addressLine1: "Testa iela 6",
      addressLine2: "",
      postalCode: "LV-1005",
      city: "Rīga",
    },
    headers,
  });
  const cat = await page.request.post(`/api/companies/${companyId}/tax-categories`, {
    data: FIXTURE_TAX.standard20,
    headers,
  });
  const taxCategoryId = String((await cat.json()).taxCategory.id);
  const res = await page.request.post(`/api/companies/${companyId}/documents`, {
    data: {
      type: "invoice",
      language: "en",
      currency: "EUR",
      issueDate: "2026-03-02",
      buyer: { name: "PDF Pircējs SIA" },
      lines: [{ description: "Fixture service", quantity: "2", unitPrice: "50", taxCategoryId }],
    },
    headers,
  });
  expect(res.status()).toBe(201);
  return { documentUrl: `${documentsUrl}/${(await res.json()).document.id}` };
}

async function downloadedText(page: Page, trigger: () => Promise<void>) {
  const [download] = await Promise.all([page.waitForEvent("download"), trigger()]);
  const bytes = new Uint8Array(await readFile((await download.path())!));
  expect(Buffer.from(bytes.subarray(0, 5)).toString()).toBe("%PDF-");
  const { text } = await extractText(bytes, { mergePages: true });
  return { name: download.suggestedFilename(), text: text.replace(/\s+/g, " ") };
}

test("download and open the PDF of a draft and of the issued document", async ({
  page,
  baseURL,
}) => {
  const { documentUrl } = await ownerWithDraft(page, baseURL!);
  await page.goto(documentUrl);
  const links = page.getByTestId("pdf-links");
  await expect(links).toContainText("not issued");

  // Draft: watermarked preview, no number.
  const draft = await downloadedText(page, () => links.getByTestId("pdf-download").click());
  expect(draft.name).toMatch(/^draft-invoice-[0-9a-f]{8}\.pdf$/);
  expect(draft.text).toContain("DRAFT — not issued");
  expect(draft.text).toContain("PDF Pircējs SIA");
  // "Open" shows the same file inline in a new tab.
  const openHref = (await links.getByTestId("pdf-open").getAttribute("href"))!;
  expect(await links.getByTestId("pdf-open").getAttribute("target")).toBe("_blank");
  const inline = await page.request.get(openHref);
  expect(inline.headers()["content-type"]).toBe("application/pdf");
  expect(inline.headers()["content-disposition"]).toMatch(/^inline; filename="draft-invoice-/);

  // Unsaved edits are not in the PDF: the editor says so.
  await page.getByTestId("document-editor").locator('textarea[name="notes"]').fill("Not saved yet");
  await expect(page.getByTestId("pdf-unsaved-hint")).toBeVisible();
  await page.reload();

  // Issue, then get the final PDF.
  await page.getByRole("button", { name: "Issue document" }).click();
  await page.getByTestId("issue-confirm").getByRole("button", { name: "Issue now" }).click();
  await expect(page.getByTestId("issued-notice")).toContainText("INV-2026-0001");
  const issuedLinks = page.getByTestId("pdf-links");
  await expect(issuedLinks.getByTestId("pdf-open")).toHaveText("Open PDF");
  const issued = await downloadedText(page, () => issuedLinks.getByTestId("pdf-download").click());
  expect(issued.name).toBe("INV-2026-0001.pdf");
  expect(issued.text).toContain("INV-2026-0001");
  expect(issued.text).toContain("SIA PDF Tests");
  expect(issued.text).not.toContain("DRAFT");

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(issuedLinks.getByTestId("pdf-download")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(0);
});
