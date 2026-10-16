import { describe, expect, it } from "vitest";
import { parseDraftInput, validateTaxCategory } from "@/modules/documents/domain";
import { taxCategoryFindings } from "@/modules/documents/server/tax-category-service";
import { FIXTURE_TAX, invoiceDraft, line } from "../support/document-fixtures";

const ID = "00000000-0000-4000-8000-000000000001";

describe("validateTaxCategory (technical consistency, not country tax rules)", () => {
  it.each([
    [{ kind: "standard", ratePercent: "20" }, []],
    [{ kind: "standard", ratePercent: "0" }, ["tax.rate.zeroRequiresTreatment"]],
    [{ kind: "exempt", ratePercent: "5", note: "n" }, ["tax.rate.mustBeZeroForTreatment"]],
    [{ kind: "standard", ratePercent: "100" }, ["tax.rate.invalid"]],
    [{ kind: "standard", ratePercent: "7.125" }, ["tax.rate.invalid"]],
    // Unchanged pre-existing behaviour: an unknown kind is also "not standard".
    [{ kind: "vat", ratePercent: "20" }, ["tax.kind.invalid", "tax.rate.mustBeZeroForTreatment"]],
  ] as const)("%j → %j", (cat, codes) => {
    const errors = validateTaxCategory(cat as never).filter((i) => i.severity === "error");
    expect(errors.map((i) => i.code)).toEqual(codes);
  });

  it("only recommends (warning) a note for non-standard treatments, with prefixed paths", () => {
    expect(
      validateTaxCategory({ kind: "exempt", ratePercent: "0" }, "lines[1].taxCategory"),
    ).toEqual([
      { code: "tax.note.recommended", severity: "warning", path: "lines[1].taxCategory.note" },
    ]);
    expect(validateTaxCategory({ kind: "standard", ratePercent: "0" })[0]!.path).toBe("");
  });
});

describe("draft input references the catalog by id", () => {
  const base = () => {
    const { lines, relation: _r, ...rest } = invoiceDraft();
    return {
      ...rest,
      lines: lines.map(({ id: _i, sourceLineId: _s, taxCategory: _t, ...l }) => l),
    };
  };

  it("keeps taxCategoryId and leaves the snapshot to the server", () => {
    const input = base();
    const draft = parseDraftInput(
      { ...input, lines: input.lines.map((l) => ({ ...l, taxCategoryId: ID })) },
      () => "l1",
    );
    expect(draft.lines.every((l) => l.taxCategoryId === ID && l.taxCategory === null)).toBe(true);
    const none = parseDraftInput(base(), () => "l1");
    expect(none.lines[0]).not.toHaveProperty("taxCategoryId");
  });

  it("refuses inline category objects and non-uuid ids", () => {
    const input = base();
    expect(() =>
      parseDraftInput(
        {
          ...input,
          lines: input.lines.map((l) => ({ ...l, taxCategory: FIXTURE_TAX.standard20 })),
        },
        () => "l1",
      ),
    ).toThrow();
    expect(() =>
      parseDraftInput(
        { ...input, lines: input.lines.map((l) => ({ ...l, taxCategoryId: "T20" })) },
        () => "l1",
      ),
    ).toThrow();
  });
});

describe("taxCategoryFindings (blocking catalog findings)", () => {
  const withLines = (...lines: ReturnType<typeof line>[]) => invoiceDraft({ lines });

  it("flags archived, unknown and unlinked categories", () => {
    const draft = withLines(
      { ...line({ id: "a" }), taxCategoryId: ID },
      { ...line({ id: "b" }), taxCategoryId: "00000000-0000-4000-8000-000000000002" },
      line({ id: "c" }), // inline snapshot from before the catalog
      { ...line({ id: "d" }), taxCategory: null },
    );
    const findings = taxCategoryFindings(draft, new Map([[ID, { archivedAt: new Date() }]]));
    expect(findings).toEqual([
      { code: "line.taxCategory.archived", severity: "error", path: "lines[0].taxCategory" },
      { code: "line.taxCategory.unknown", severity: "error", path: "lines[1].taxCategory" },
      { code: "line.taxCategory.unlinked", severity: "error", path: "lines[2].taxCategory" },
    ]);
    expect(taxCategoryFindings(draft, new Map([[ID, { archivedAt: null }]]))).toHaveLength(2);
  });

  it("does not check credit notes (they keep the invoice's snapshots)", () => {
    expect(taxCategoryFindings(invoiceDraft({ type: "credit_note" }), new Map())).toEqual([]);
  });
});
