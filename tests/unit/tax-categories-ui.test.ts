import { describe, expect, it } from "vitest";
import {
  type CategoryOption,
  chooseCategory,
  legacySnapshots,
  lineTaxState,
  newLine,
  restoreLegacy,
  toDraftInput,
} from "@/features/documents/editor-model";
import {
  fieldOfIssue,
  interpretCategoryResponse,
  toCreateBody,
} from "@/features/tax-categories/model";
import { draftInputSchema } from "@/modules/documents/domain/schema";
import { FIXTURE_TAX, invoiceDraft, line } from "../support/document-fixtures";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const active: CategoryOption[] = [
  { id: A, code: "T20", kind: "standard", ratePercent: "20", label: "Fixture 20%", note: null },
];

describe("line tax state (display only; the server decides)", () => {
  it("distinguishes linked, archived, legacy and missing categories", () => {
    expect(lineTaxState({ ...line({ id: "1" }), taxCategoryId: A }, active)).toBe("linked");
    expect(lineTaxState({ ...line({ id: "1" }), taxCategoryId: B }, active)).toBe("archived");
    expect(lineTaxState(line({ id: "1" }), active)).toBe("legacy");
    expect(lineTaxState(newLine("n"), active)).toBe("none");
  });
});

describe("choosing, restoring and sending categories", () => {
  it("an explicit choice sends only the catalog id; the line id is kept", () => {
    const chosen = chooseCategory(line({ id: "L1" }), active[0]!);
    expect(chosen).toMatchObject({
      taxCategoryId: A,
      taxCategory: { code: "T20", label: "Fixture 20%" },
    });
    const body = toDraftInput(invoiceDraft({ lines: [chosen] }));
    expect(body.lines[0]).toMatchObject({ id: "L1", taxCategoryId: A });
    expect(body.lines[0]).not.toHaveProperty("taxCategory");
    expect(draftInputSchema.safeParse(body).success).toBe(true);
  });

  it("new lines never get a category automatically", () => {
    expect(newLine("n")).toMatchObject({ taxCategory: null });
    expect(newLine("n")).not.toHaveProperty("taxCategoryId");
    const body = toDraftInput(invoiceDraft({ lines: [line({ id: "L1" }), newLine("n")] }));
    expect(body.lines.map((l) => l.taxCategoryId)).toEqual([null, null]);
  });

  it("restore puts the pre-catalog snapshot back and resubmits the line unlinked with its id", () => {
    const legacyLine = line({ id: "L1" }); // snapshot without catalog link
    const previous = legacySnapshots([legacyLine, { ...line({ id: "L2" }), taxCategoryId: A }]);
    expect([...previous.keys()]).toEqual(["L1"]);
    const restored = restoreLegacy(chooseCategory(legacyLine, active[0]!), previous.get("L1")!);
    expect(restored).toEqual(legacyLine);
    expect(lineTaxState(restored, active)).toBe("legacy");
    expect(toDraftInput(invoiceDraft({ lines: [restored] })).lines[0]).toMatchObject({
      id: "L1",
      taxCategoryId: null,
    });
    expect(previous.get("L1")).toEqual(FIXTURE_TAX.standard20);
  });
});

describe("catalog API answers", () => {
  const item = {
    id: A,
    code: "T20",
    kind: "standard",
    ratePercent: "20",
    label: "L",
    note: null,
    archived: false,
    version: 1,
  };
  it.each([
    [201, { taxCategory: item, issues: [] }, "ok"],
    [200, { taxCategory: item }, "ok"],
    [422, { error: "validation_failed", issues: [] }, "invalid"],
    [409, { error: "code_taken" }, "codeTaken"],
    [409, { error: "version_conflict" }, "conflict"],
    [401, { error: "unauthenticated" }, "signedOut"],
    [401, { error: "two_factor_challenge_required" }, "twoFactor"],
    [403, { error: "two_factor_enrollment_required" }, "twoFactor"],
    [403, { error: "forbidden" }, "forbidden"],
    [404, { error: "not_found" }, "notFound"],
    [500, null, "error"],
  ])("%i %j → %s", (status, body, kind) => {
    expect(interpretCategoryResponse(status, body).kind).toBe(kind);
  });

  it("builds the create body without inventing values", () => {
    expect(
      toCreateBody({
        code: " T7 ",
        kind: "standard",
        ratePercent: " 7,5 ",
        label: " Seven ",
        note: " ",
      }),
    ).toEqual({ code: "T7", kind: "standard", ratePercent: "7.5", label: "Seven" });
    expect(fieldOfIssue("ratePercent")).toBe("ratePercent");
    expect(fieldOfIssue("")).toBe("");
  });
});
