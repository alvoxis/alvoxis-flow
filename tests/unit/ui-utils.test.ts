import { describe, expect, it } from "vitest";
import { cn } from "@/lib/utils";

describe("cn", () => {
  it("joins conditional class names like clsx", () => {
    expect(cn("a", false && "b", null, undefined, ["c", { d: true, e: false }])).toBe("a c d");
  });

  it("lets a later utility override an earlier one of the same kind", () => {
    expect(cn("px-4 py-2.5", "px-0")).toBe("py-2.5 px-0");
    expect(cn("bg-surface", "bg-accent-soft/40")).toBe("bg-accent-soft/40");
  });

  it("treats the app's colour tokens as colours, not as font sizes", () => {
    // text-muted / text-text are colours; text-sm is a size: both kinds must survive together.
    expect(cn("text-sm text-muted", "text-text")).toBe("text-sm text-text");
    expect(cn("border border-border", "border-red-800/60")).toBe("border border-red-800/60");
  });
});
