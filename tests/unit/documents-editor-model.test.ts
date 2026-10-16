import { describe, expect, it } from "vitest";
import {
  fieldOf,
  hasErrorAt,
  interpretResponse,
  lineIndexOf,
  newLine,
  toDraftInput,
} from "@/features/documents/editor-model";
import { draftInputSchema } from "@/modules/documents/domain/schema";
import { invoiceDraft, line } from "../support/document-fixtures";

describe("interpretResponse (document API → UI outcome)", () => {
  const doc = { id: "d", status: "draft", number: null, version: 2, issues: [] };

  it.each([
    [200, { document: doc }, "ok"],
    [201, { document: doc }, "ok"],
    [422, { error: "validation_failed", issues: [] }, "invalid"],
    [409, { error: "version_conflict" }, "conflict"],
    [409, { error: "invalid_state", code: "document.notDraft" }, "notDraft"],
    [409, { error: "invalid_state", code: "document.alreadyIssued" }, "notDraft"],
    [409, { error: "invalid_state", code: "document.typeChange" }, "state"],
    [401, { error: "unauthenticated" }, "signedOut"],
    [401, { error: "two_factor_challenge_required" }, "twoFactor"],
    [403, { error: "two_factor_enrollment_required" }, "twoFactor"],
    [403, { error: "forbidden" }, "forbidden"],
    [404, { error: "not_found" }, "notFound"],
    [400, { error: "invalid_request" }, "error"],
    [500, { error: "internal_error" }, "error"],
    [502, null, "error"],
    [200, { deleted: true }, "error"],
  ])("%i %j → %s", (status, body, kind) => {
    expect(interpretResponse(status, body).kind).toBe(kind);
  });

  it("keeps the server's issues and state codes", () => {
    const issues = [{ code: "buyer.name.required", severity: "error", path: "buyer.name" }];
    expect(interpretResponse(422, { error: "validation_failed", issues })).toEqual({
      kind: "invalid",
      issues,
    });
    expect(interpretResponse(409, { error: "invalid_state", code: "x.y" })).toEqual({
      kind: "state",
      code: "x.y",
    });
  });
});

describe("issue paths", () => {
  it("reads line indexes from validation and shape-error paths", () => {
    expect(lineIndexOf("lines[2].unitPrice")).toBe(2);
    expect(lineIndexOf("lines.3.quantity")).toBe(3);
    expect(lineIndexOf("lines")).toBeNull();
    expect(lineIndexOf("buyer.name")).toBeNull();
    expect(fieldOf("lines[2].taxCategory.kind")).toBe("lines.taxCategory.kind");
    expect(fieldOf("lines.12.unitPrice")).toBe("lines.unitPrice");
  });

  it("marks only error-severity findings of the given field and line", () => {
    const issues = [
      { code: "line.unitPrice.required", severity: "error" as const, path: "lines[1].unitPrice" },
      {
        code: "tax.note.recommended",
        severity: "warning" as const,
        path: "lines[0].taxCategory.note",
      },
      {
        code: "input.invalid_format",
        severity: "error" as const,
        path: "buyer.address.countryCode",
      },
    ];
    expect(hasErrorAt(issues, "lines.unitPrice", 1)).toBe(true);
    expect(hasErrorAt(issues, "lines.unitPrice", 0)).toBe(false);
    expect(hasErrorAt(issues, "lines.taxCategory", 0)).toBe(false);
    expect(hasErrorAt(issues, "buyer.address")).toBe(true);
    expect(hasErrorAt(issues, "buyer.name")).toBe(false);
  });
});

describe("toDraftInput (PATCH body)", () => {
  it("is accepted by the server's draft schema and drops empty optional fields", () => {
    const draft = invoiceDraft({
      dueDate: "",
      notes: "  ",
      buyer: {
        name: "Pircējs SIA",
        vatNumber: "",
        email: "",
        address: { lines: ["", ""], postalCode: "", city: "", countryCode: "" },
      },
      lines: [
        { ...line({ id: "a" }), unit: "", discountPercent: "", unitPrice: "", sourceLineId: "s" },
      ],
    });
    const body = toDraftInput(draft);
    expect(body.dueDate).toBeUndefined();
    expect(body.notes).toBeUndefined();
    expect(body.buyer.vatNumber).toBeUndefined();
    expect(body.buyer.address).toBeUndefined();
    // An empty price becomes "no price" so the server reports line.unitPrice.required.
    expect(body.lines[0]!.unitPrice).toBeNull();
    expect(body.lines[0]).not.toHaveProperty("sourceLineId");
    expect(body).not.toHaveProperty("relation");
    expect(draftInputSchema.safeParse(body).success).toBe(true);
  });

  it("keeps edited values verbatim (no client-side rounding or recalculation)", () => {
    const draft = invoiceDraft({
      lines: [{ ...line({ id: "a" }), quantity: "1.125", unitPrice: "10.005" }],
      buyer: { name: "B", address: { lines: ["Iela 1"], countryCode: "lt" } },
    });
    const body = toDraftInput(draft);
    expect(body.lines[0]).toMatchObject({ quantity: "1.125", unitPrice: "10.005" });
    expect(body.buyer.address).toEqual({
      lines: ["Iela 1"],
      postalCode: undefined,
      city: undefined,
      countryCode: "LT",
    });
  });

  it("new lines reuse the previous line's tax category and pricing mode", () => {
    const prev = line({ id: "a" });
    expect(newLine(prev, "n")).toMatchObject({
      id: "n",
      taxCategory: prev.taxCategory,
      unitPrice: "",
    });
    expect(newLine({ ...prev, unitPrice: null }, "n").unitPrice).toBeNull();
    expect(newLine(undefined, "n").taxCategory).toBeNull();
  });
});
