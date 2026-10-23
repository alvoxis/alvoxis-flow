import { ownerWithIssuedInvoice } from "./document-helpers";
import {
  createVerifiedUser,
  expect,
  mailLink,
  newDevice,
  signInViaForm,
  test,
  uniqueEmail,
} from "./support";

/**
 * Member invitations: the owner invites by email from the settings page, the invitee opens the
 * emailed link, signs in, accepts and lands in the company with the invited role. Synthetic
 * addresses only (file mail transport). Runs on desktop, tablet and phone.
 */
test("invite a member by email and accept the invitation", async ({ page, baseURL, browser }) => {
  test.setTimeout(120_000);
  const { companyId } = await ownerWithIssuedInvoice(page, baseURL!);
  const email = uniqueEmail("invitee");

  await page.goto(`/en/companies/${companyId}/settings`);
  const manager = page.getByTestId("invitations-manager");
  await manager.getByLabel("Email address").fill(email);
  await manager.getByLabel("Role").selectOption("accountant");
  await manager.getByTestId("invite-submit").click();
  await expect(manager.getByText("Invitation sent")).toBeVisible();
  const shown = await manager.getByTestId("invitation-link").textContent();
  const row = manager.getByTestId("invitation-row").filter({ hasText: email });
  await expect(row).toContainText("Accountant");
  const link = await mailLink(email, "invitation");
  expect(link).toBe(shown);

  // The invitee signs up, opens the link, is sent to sign in and comes back to accept.
  const device = await newDevice(browser);
  const invitee = await device.newPage();
  await createVerifiedUser(invitee.request, baseURL!, email);
  const path = new URL(link).pathname;
  await invitee.goto(path);
  await expect(invitee).toHaveURL(/\/en\/sign-in\?next=/);
  await signInViaForm(invitee, email);
  // signInViaForm opens the plain sign-in page, so go back to the link once signed in.
  await expect(invitee).toHaveURL(/\/en$/);
  await invitee.goto(path);
  await expect(invitee.getByText("as Accountant")).toBeVisible();
  await invitee.getByTestId("invitation-accept").click();
  await expect(invitee).toHaveURL(new RegExp(`/en/companies/${companyId}/settings$`));
  await expect(invitee.getByTestId("member-row")).toHaveCount(2);
  await expect(invitee.getByTestId("member-row").filter({ hasText: email })).toContainText(
    "Accountant",
  );

  // The link works only once.
  await invitee.goto(path);
  await expect(invitee.getByText("already been used")).toBeVisible();
  await device.close();

  await page.reload();
  await expect(page.getByTestId("invitation-row")).toHaveCount(0);
  await expect(page.getByTestId("member-row")).toHaveCount(2);
});
