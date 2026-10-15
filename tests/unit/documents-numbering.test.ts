import { describe, expect, it } from "vitest";
import {
  formatDocumentNumber,
  numberingPeriodKey,
  validateNumberingPattern,
} from "@/modules/documents/domain";

describe("formatDocumentNumber", () => {
  it.each([
    ["{seq:2}/{yyyy}", 1, "2025-01-03", "01/2025"],
    ["{seq}/{yyyy}", 28, "2025-06-10", "28/2025"],
    ["{seq:3}-1/{yyyy}", 4, "2024-09-02", "004-1/2024"],
    ["INV-{yyyy}-{seq:4}", 42, "2026-10-14", "INV-2026-0042"],
    ["CN{yy}{mm}-{seq:3}", 7, "2026-03-31", "CN2603-007"],
  ])("%s with %i on %s → %s", (pattern, seq, date, expected) => {
    expect(formatDocumentNumber(pattern, seq, date)).toBe(expected);
  });

  it("does not truncate sequences longer than the padding", () => {
    expect(formatDocumentNumber("{seq:2}/{yyyy}", 123, "2025-01-01")).toBe("123/2025");
  });

  it("rejects invalid sequences and dates", () => {
    expect(() => formatDocumentNumber("{seq}", 0, "2025-01-01")).toThrow();
    expect(() => formatDocumentNumber("{seq}", 1.5, "2025-01-01")).toThrow();
    expect(() => formatDocumentNumber("{seq}", 1, "01.01.2025")).toThrow();
  });
});

describe("validateNumberingPattern", () => {
  it("accepts well-formed patterns", () => {
    expect(
      validateNumberingPattern({ pattern: "INV-{yyyy}-{seq:4}", resetPolicy: "yearly" }),
    ).toEqual([]);
    expect(validateNumberingPattern({ pattern: "P{seq:5}", resetPolicy: "never" })).toEqual([]);
  });

  it("requires exactly one sequence token", () => {
    expect(
      validateNumberingPattern({ pattern: "INV-{yyyy}", resetPolicy: "never" }),
    ).toContainEqual(expect.stringMatching(/exactly one/));
    expect(
      validateNumberingPattern({ pattern: "{seq}-{seq}", resetPolicy: "never" }),
    ).toContainEqual(expect.stringMatching(/exactly one/));
  });

  it("requires a year token when resetting yearly", () => {
    expect(
      validateNumberingPattern({ pattern: "INV-{seq}", resetPolicy: "yearly" }),
    ).toContainEqual(expect.stringMatching(/yearly/));
  });

  it("rejects unknown tokens, stray braces and unsafe characters", () => {
    expect(
      validateNumberingPattern({ pattern: "{seq}{day}", resetPolicy: "never" }),
    ).toContainEqual(expect.stringMatching(/Unknown/));
    expect(validateNumberingPattern({ pattern: "{seq}}", resetPolicy: "never" })).toContainEqual(
      expect.stringMatching(/braces/),
    );
    expect(validateNumberingPattern({ pattern: "<b>{seq}", resetPolicy: "never" })).toContainEqual(
      expect.stringMatching(/unsupported/),
    );
  });
});

describe("numberingPeriodKey", () => {
  it("buckets yearly series by issue year", () => {
    expect(
      numberingPeriodKey({ pattern: "{seq}/{yyyy}", resetPolicy: "yearly" }, "2025-12-31"),
    ).toBe("2025");
    expect(numberingPeriodKey({ pattern: "{seq}", resetPolicy: "never" }, "2025-12-31")).toBe(
      "all",
    );
  });
});
