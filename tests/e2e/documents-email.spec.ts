import { ownerWithIssuedInvoice } from "./document-helpers";
import { expect, mailOf, test, uniqueEmail } from "./support";

/**
 * Sending an issued invoice by email from its page: the dialog, the sent notice and the message
 * with the PDF attached (file mail transport; nothing leaves the machine). Synthetic data only.
 * Runs on desktop, tablet and phone.
 */
test("send an issued invoice by email with its PDF attached", async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  const { invoiceUrl } = await ownerWithIssuedInvoice(page, baseURL!);
  const to = uniqueEmail("buyer");

  await page.goto(invoiceUrl);
  const number = (await page.getByTestId("document-heading").textContent())!.match(
    /INV-\d{4}-\d{4}/,
  )![0];
  await page.getByTestId("email-open").click();
  const dialog = page.getByTestId("email-dialog");
  await expect(dialog).toContainText(`Send ${number} by email`);
  await dialog.getByLabel("Recipient's email").fill(to);
  await dialog.getByLabel("Message (optional)").fill("Thank you for your order.");
  await dialog.getByTestId("email-send").click();
  await expect(dialog.getByRole("status")).toContainText(`Sent to ${to}.`);

  const msg = await mailOf(to, "document");
  expect(msg.subject).toContain(number);
  expect(msg.text).toContain("Thank you for your order.");
  expect(msg.attachments).toEqual([
    expect.objectContaining({ filename: `${number}.pdf`, contentType: "application/pdf" }),
  ]);

  // An invalid address is refused without closing the dialog.
  await dialog.getByLabel("Recipient's email").fill("not-an-address");
  await dialog.getByTestId("email-send").click();
  await expect(dialog).toBeVisible();
});
