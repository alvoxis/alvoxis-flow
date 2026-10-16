import { describe, expect, it } from "vitest";
import {
  accountName,
  formatIban,
  interpretBankAccountResponse,
  toCreateBankAccountBody,
} from "@/features/bank-accounts/model";
import { toCreateDraftBody } from "@/features/documents/create-model";
import { toDraftInput } from "@/features/documents/editor-model";
import { draftInputSchema } from "@/modules/documents/domain/schema";
import { invoiceDraft } from "../support/document-fixtures";

const ID = "00000000-0000-4000-8000-000000000001";

describe("bank-account client model", () => {
  it("classifies API answers by status and error code", () => {
    const account = { id: ID, iban: "LV80BANK0000435195001" };
    expect(interpretBankAccountResponse(201, { bankAccount: account })).toEqual({
      kind: "ok",
      bankAccount: account,
    });
    expect(interpretBankAccountResponse(409, { error: "iban_taken" })).toEqual({
      kind: "ibanTaken",
    });
    expect(interpretBankAccountResponse(409, { error: "version_conflict" })).toEqual({
      kind: "conflict",
    });
    expect(interpretBankAccountResponse(422, { error: "validation_failed", issues: [] })).toEqual({
      kind: "invalid",
      issues: [],
    });
    expect(interpretBankAccountResponse(404, null)).toEqual({ kind: "notFound" });
    expect(interpretBankAccountResponse(500, null)).toEqual({ kind: "error" });
  });

  it("builds the POST body without empty fields and formats IBANs for display", () => {
    expect(
      toCreateBankAccountBody({
        label: " ",
        bankName: "",
        iban: " lv80 ",
        bic: "",
        isDefault: false,
      }),
    ).toEqual({ iban: "lv80" });
    expect(formatIban("LV80BANK0000435195001")).toBe("LV80 BANK 0000 4351 9500 1");
    expect(
      accountName({ label: null, bankName: "Example Bank AS", iban: "LV80BANK0000435195001" }),
    ).toBe("Example Bank AS · LV80 BANK 0000 4351 9500 1");
  });
});

describe("documents send an account id, never inline details", () => {
  const form = {
    type: "invoice" as const,
    language: "en" as const,
    currency: "EUR" as const,
    issueDate: "2026-03-02",
    buyerName: "B",
  };

  it("the create body carries the chosen account except for delivery notes", () => {
    expect(toCreateDraftBody({ ...form, bankAccountId: ID })).toMatchObject({ bankAccountId: ID });
    expect(toCreateDraftBody({ ...form, bankAccountId: "" })).not.toHaveProperty("bankAccountId");
    expect(
      toCreateDraftBody({ ...form, type: "delivery_note", bankAccountId: ID }),
    ).not.toHaveProperty("bankAccountId");
  });

  it("the editor body sends bankAccountId only when the choice changed", () => {
    const draft = { ...invoiceDraft(), bankAccountId: ID };
    const unchanged = toDraftInput(draft);
    expect(unchanged).not.toHaveProperty("bankAccountId");
    expect(unchanged).not.toHaveProperty("bankAccounts");
    expect(toDraftInput(draft, { bankAccountId: null })).toMatchObject({ bankAccountId: null });
    expect(draftInputSchema.safeParse(toDraftInput(draft, { bankAccountId: ID })).success).toBe(
      true,
    );
    // Inline details are refused by the server's input schema.
    expect(draftInputSchema.safeParse({ ...unchanged, bankAccounts: [] }).success).toBe(false);
  });
});
