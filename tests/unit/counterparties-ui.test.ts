import { describe, expect, it } from "vitest";
import {
  addDays,
  addressLine,
  buyerFromCounterparty,
  type CounterpartyItem,
  draftOf,
  emptyCounterparty,
  toCounterpartyBody,
} from "@/features/counterparties/model";
import { fieldOfIssue, interpretRecordResponse } from "@/features/records/api";

const ITEM: CounterpartyItem = {
  id: "c1",
  isCustomer: true,
  isSupplier: false,
  name: "Baltic Test Buyer SIA",
  registrationNumber: "40000000099",
  vatNumber: "LV40000000099",
  email: "buyer@example.test",
  phone: null,
  contactName: "Anna Test",
  addressLine1: "Testa iela 1",
  addressLine2: null,
  postalCode: "LV-1001",
  city: "Rīga",
  countryCode: "LV",
  paymentTermDays: 14,
  notes: null,
  archived: false,
  version: 3,
};

describe("counterparty form model", () => {
  it("starts with the page's role and sends trimmed values, empty fields as null", () => {
    const d = { ...emptyCounterparty("supplier"), name: "  Nemunas UAB ", city: " Vilnius " };
    expect(d).toMatchObject({ isCustomer: false, isSupplier: true });
    expect(toCounterpartyBody(d)).toMatchObject({
      name: "Nemunas UAB",
      city: "Vilnius",
      email: null,
      paymentTermDays: null,
      isSupplier: true,
    });
  });

  it("sends the payment term as a number; anything else reaches the server as out of range", () => {
    const d = emptyCounterparty("customer");
    expect(toCounterpartyBody({ ...d, paymentTermDays: " 30 " }).paymentTermDays).toBe(30);
    expect(toCounterpartyBody({ ...d, paymentTermDays: "abc" }).paymentTermDays).toBe(-1);
  });

  it("round-trips a record through the form", () => {
    const body = toCounterpartyBody(draftOf(ITEM));
    expect(body).toMatchObject({ name: ITEM.name, paymentTermDays: 14, phone: null });
    expect(addressLine(ITEM)).toBe("Testa iela 1, LV-1001 Rīga, LV");
  });

  it("copies a customer into the buyer without empty fields", () => {
    expect(buyerFromCounterparty(ITEM)).toEqual({
      name: "Baltic Test Buyer SIA",
      registrationNumber: "40000000099",
      vatNumber: "LV40000000099",
      email: "buyer@example.test",
      contactName: "Anna Test",
      address: { lines: ["Testa iela 1"], postalCode: "LV-1001", city: "Rīga", countryCode: "LV" },
    });
    expect(
      buyerFromCounterparty({
        ...ITEM,
        addressLine1: null,
        postalCode: null,
        city: null,
        countryCode: null,
      }),
    ).not.toHaveProperty("address");
  });

  it("adds calendar days across months and leap years", () => {
    expect(addDays("2026-01-25", 14)).toBe("2026-02-08");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2026-12-31", 0)).toBe("2026-12-31");
  });
});

describe("record API outcomes", () => {
  it("classifies documented statuses and codes", () => {
    expect(interpretRecordResponse(201, { counterparty: ITEM }, "counterparty")).toEqual({
      kind: "ok",
      value: ITEM,
    });
    expect(interpretRecordResponse(422, { error: "validation_failed", issues: [] }, "x").kind).toBe(
      "invalid",
    );
    expect(interpretRecordResponse(409, { error: "version_conflict" }, "x").kind).toBe("conflict");
    expect(interpretRecordResponse(409, { error: "registration_taken" }, "x")).toEqual({
      kind: "taken",
      code: "registration_taken",
    });
    expect(
      interpretRecordResponse(409, { error: "invalid_state", code: "run.posted" }, "x"),
    ).toEqual({ kind: "state", code: "run.posted" });
    expect(interpretRecordResponse(401, { error: "two_factor_challenge_required" }, "x").kind).toBe(
      "twoFactor",
    );
    expect(interpretRecordResponse(401, {}, "x").kind).toBe("signedOut");
    expect(interpretRecordResponse(403, { error: "forbidden" }, "x").kind).toBe("forbidden");
    expect(interpretRecordResponse(404, {}, "x").kind).toBe("notFound");
    expect(interpretRecordResponse(500, null, "x").kind).toBe("error");
    // A 2xx without the expected key is not a success.
    expect(interpretRecordResponse(200, {}, "x").kind).toBe("error");
  });

  it("maps issue paths to form fields", () => {
    expect(fieldOfIssue("email")).toBe("email");
    expect(fieldOfIssue("components[2].quantity")).toBe("components");
    expect(fieldOfIssue("address.city")).toBe("address");
  });
});
