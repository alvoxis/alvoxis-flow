import { describe, expect, it } from "vitest";
import {
  interpretDeleteResponse,
  localToday,
  NEW_DOCUMENT_TYPES,
  toCreateDraftBody,
} from "@/features/documents/create-model";
import { draftInputSchema } from "@/modules/documents/domain/schema";

describe("new draft body", () => {
  const form = {
    type: "invoice" as const,
    language: "lv" as const,
    currency: "EUR" as const,
    issueDate: "2026-03-02",
    buyerName: "  Testa Pircējs SIA ",
  };

  it("is the minimal input the API accepts: no seller, no lines, no tax categories", () => {
    const body = toCreateDraftBody(form);
    expect(body).toEqual({
      type: "invoice",
      language: "lv",
      currency: "EUR",
      issueDate: "2026-03-02",
      buyer: { name: "Testa Pircējs SIA" },
      lines: [],
    });
    expect(body).not.toHaveProperty("seller");
    // The server adds the seller from the company profile before this schema runs.
    expect(draftInputSchema.safeParse({ ...body, seller: { name: "Profile" } }).success).toBe(true);
  });

  it("never defaults the currency: an unchosen currency is refused by the API schema", () => {
    const body = toCreateDraftBody({ ...form, currency: "" });
    expect(body.currency).toBe("");
    expect(draftInputSchema.safeParse({ ...body, seller: { name: "Profile" } }).success).toBe(
      false,
    );
  });

  it("offers invoices, proformas and delivery notes, never credit notes", () => {
    expect(NEW_DOCUMENT_TYPES).toEqual(["invoice", "proforma", "delivery_note"]);
  });
});

describe("localToday (browser calendar day)", () => {
  it("uses local date parts, not the UTC date", () => {
    const d = new Date(2026, 2, 1, 23, 59, 59); // local 1 March, any time zone
    expect(localToday(d)).toBe("2026-03-01");
    expect(localToday(new Date(2026, 0, 1, 0, 0, 0))).toBe("2026-01-01");
    expect(localToday(new Date(2026, 11, 31, 23, 30))).toBe("2026-12-31");
  });
});

describe("delete responses", () => {
  it.each([
    [200, { deleted: true }, "deleted"],
    [409, { error: "invalid_state", code: "document.notDraft" }, "notDraft"],
    [404, { error: "not_found" }, "notFound"],
    [403, { error: "forbidden" }, "forbidden"],
    [403, { error: "two_factor_enrollment_required" }, "twoFactor"],
    [401, { error: "two_factor_challenge_required" }, "twoFactor"],
    [401, { error: "unauthenticated" }, "signedOut"],
    [400, { error: "invalid_request" }, "error"],
    [500, null, "error"],
    [200, { deleted: false }, "error"],
  ])("%i %j → %s", (status, body, kind) => {
    expect(interpretDeleteResponse(status, body).kind).toBe(kind);
  });
});
