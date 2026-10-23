import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** CI workflow invariants that would otherwise only fail on GitHub. */
describe("workflows", () => {
  it("runs WebKit in the Playwright image of the installed @playwright/test version", () => {
    const workflow = readFileSync(".github/workflows/webkit.yml", "utf8");
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      devDependencies: Record<string, string>;
    };
    const tag = workflow.match(/image: mcr\.microsoft\.com\/playwright:v([\d.]+)-noble/)?.[1];
    expect(tag).toBe(pkg.devDependencies["@playwright/test"]);
    expect(workflow).not.toContain("playwright install");
  });
});
