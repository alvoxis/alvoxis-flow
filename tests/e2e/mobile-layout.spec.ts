import { type Page } from "@playwright/test";
import { createDocument, ownerWithIssuedInvoice } from "./document-helpers";
import { expect, test } from "./support";

/**
 * Every main page on narrow phones (320 px, e.g. iPhone SE with zoom; 390 px, iPhone 15) in
 * English and Lithuanian (one of the longest translations): nothing wider than the screen,
 * nothing pushed past its right edge, document numbers never broken at their hyphens, and no
 * console errors. Synthetic data only.
 */

test.beforeEach(({ page }) => {
  test.skip((page.viewportSize()?.width ?? 0) >= 1024, "phone layout; runs on the phone profile");
});

/** Problems on the current page; an empty list means the layout fits. */
function layoutProblems(page: Page) {
  return page.evaluate(() => {
    const found: string[] = [];
    const root = document.documentElement;
    if (root.scrollWidth > root.clientWidth + 1)
      found.push(`page is ${root.scrollWidth}px wide on a ${root.clientWidth}px screen`);
    const clipped = (el: Element | null): boolean => {
      for (let e = el; e && e !== document.body; e = e.parentElement)
        if (["auto", "scroll", "hidden"].includes(getComputedStyle(e).overflowX)) return true;
      return false;
    };
    for (const el of document.querySelectorAll("body *")) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || getComputedStyle(el).position === "fixed") continue;
      if (r.right > root.clientWidth + 1 && !clipped(el.parentElement))
        found.push(`${el.tagName.toLowerCase()} "${el.textContent?.slice(0, 30)}" overflows`);
    }
    // Document numbers (INV-2026-0001, CN-…) must stay on one line.
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const re = /\b[A-Z]{2,4}-\d{4}-\d{4}\b/g;
      for (let m = re.exec(n.textContent ?? ""); m; m = re.exec(n.textContent ?? "")) {
        const range = document.createRange();
        range.setStart(n, m.index);
        range.setEnd(n, m.index + m[0].length);
        const lines = new Set([...range.getClientRects()].map((x) => Math.round(x.top)));
        if (lines.size > 1) found.push(`"${m[0]}" is broken across lines`);
      }
    }
    return [...new Set(found)];
  });
}

test("main pages fit narrow phones without horizontal scrolling or broken numbers", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on("console", (msg) => msg.type() === "error" && errors.push(msg.text()));
  page.on("pageerror", (err) => errors.push(err.message));

  const { companyId, invoiceId, headers, taxCategoryId } = await ownerWithIssuedInvoice(
    page,
    baseURL!,
  );
  const credit = await page.request.post(
    `/api/companies/${companyId}/documents/${invoiceId}/credit-note`,
    { data: { issueDate: "2026-03-05", lines: "full" }, headers },
  );
  expect(credit.status()).toBe(201);
  const creditId = String((await credit.json()).document.id);
  const draftId = await createDocument(page, companyId, headers, taxCategoryId, {
    buyer: { name: "Ļoti Garš Pircēja Nosaukums Sabiedrība ar Ierobežotu Atbildību (TEST)" },
  });

  const party = await page.request.post(`/api/companies/${companyId}/counterparties`, {
    data: {
      name: "Ļoti Garš Klienta un Piegādātāja Nosaukums Sabiedrība ar Ierobežotu Atbildību (TEST)",
      isCustomer: true,
      isSupplier: true,
      email: "a-very-long-mailbox-name-for-layout-checks@example.test",
      addressLine1: "Ļoti garas ielas nosaukums 123-45",
      city: "Rīga",
      countryCode: "LV",
    },
    headers,
  });
  expect(party.status()).toBe(201);

  const company = `/companies/${companyId}`;
  const paths = [
    "",
    `${company}/documents`,
    `${company}/documents?status=issued&sort=amount_desc`,
    `${company}/documents/new`,
    `${company}/documents/import`,
    `${company}/documents/${invoiceId}`,
    `${company}/documents/${creditId}`,
    `${company}/documents/${draftId}`,
    `${company}/profile`,
    `${company}/tax-categories`,
    `${company}/bank-accounts`,
    `${company}/customers`,
    `${company}/suppliers`,
    "/account/security",
    "/account/two-factor",
  ];
  const problems: Record<string, string[]> = {};
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 800 });
    for (const locale of ["en", "lt"]) {
      for (const path of paths) {
        await page.goto(`/${locale}${path}`);
        await page.waitForLoadState("networkidle");
        const found = await layoutProblems(page);
        if (found.length) problems[`${width}px /${locale}${path}`] = found;
      }
    }
  }
  expect(problems).toEqual({});
  expect(errors).toEqual([]);
});

test("the top bar never covers the brand or overlaps its parts, from small tablets to desktops", async ({
  page,
  baseURL,
}) => {
  const { companyId, headers } = await ownerWithIssuedInvoice(page, baseURL!);
  // A long company name, as the top bar shows it on the company's pages.
  const profile = await page.request.patch(`/api/companies/${companyId}/profile`, {
    data: {
      name: "Ļoti Garš Uzņēmuma Nosaukums Sabiedrība ar Ierobežotu Atbildību",
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
  for (const width of [640, 768, 1024, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    for (const locale of ["en", "lt"]) {
      await page.goto(`/${locale}/companies/${companyId}/documents`);
      const result = await page.evaluate(() => {
        const parts = ["topbar-brand", "topbar-company", "topbar-actions"]
          .map((id) => document.querySelector(`[data-testid="${id}"]`))
          .filter((el): el is Element => !!el && el.getBoundingClientRect().width > 0);
        const rects = parts.map((el) => el.getBoundingClientRect());
        const overlaps: string[] = [];
        for (let i = 0; i < rects.length; i++)
          for (let j = i + 1; j < rects.length; j++)
            if (rects[i]!.right > rects[j]!.left + 1 && rects[j]!.right > rects[i]!.left + 1)
              overlaps.push(
                `${parts[i]!.getAttribute("data-testid")}/${parts[j]!.getAttribute("data-testid")}`,
              );
        const brand = document.querySelector('[data-testid="topbar-brand"]');
        const clipped =
          brand &&
          brand.getBoundingClientRect().width > 0 &&
          brand.scrollWidth > brand.clientWidth + 1;
        return {
          overlaps,
          clipped,
          pageOverflow:
            document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        };
      });
      expect(result, `${width}px /${locale}`).toEqual({
        overlaps: [],
        clipped: false,
        pageOverflow: false,
      });
    }
  }
});
