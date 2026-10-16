import { describe, expect, it } from "vitest";
import {
  DEFAULT_ROLE_PERMISSIONS,
  PERMISSIONS,
  ROLES_REQUIRING_2FA,
  SYSTEM_ROLES,
} from "@/server/auth/permissions";

describe("permission catalog", () => {
  it("has unique keys in module.action form", () => {
    expect(new Set(PERMISSIONS).size).toBe(PERMISSIONS.length);
    for (const p of PERMISSIONS) expect(p).toMatch(/^[a-z_]+\.[a-z_]+$/);
  });

  it("defines a template for every system role using only known permissions", () => {
    for (const role of SYSTEM_ROLES) {
      const perms = DEFAULT_ROLE_PERMISSIONS[role];
      expect(perms.length).toBeGreaterThan(0);
      for (const p of perms) expect(PERMISSIONS).toContain(p);
    }
  });

  it("gives the owner every permission", () => {
    expect([...DEFAULT_ROLE_PERMISSIONS.owner].sort()).toEqual([...PERMISSIONS].sort());
  });

  it("reserves company deletion and billing for the owner", () => {
    for (const role of SYSTEM_ROLES.filter((r) => r !== "owner")) {
      expect(DEFAULT_ROLE_PERMISSIONS[role]).not.toContain("company.delete");
      expect(DEFAULT_ROLE_PERMISSIONS[role]).not.toContain("billing.manage");
    }
  });

  it("does not let operational roles manage members, roles or AI financial actions", () => {
    for (const role of [
      "warehouse_employee",
      "production_employee",
      "manager",
      "accountant",
    ] as const) {
      expect(DEFAULT_ROLE_PERMISSIONS[role]).not.toContain("members.manage");
      expect(DEFAULT_ROLE_PERMISSIONS[role]).not.toContain("roles.manage");
      expect(DEFAULT_ROLE_PERMISSIONS[role]).not.toContain("ai.financial_actions");
    }
  });

  it("requires 2FA for owners and administrators", () => {
    expect([...ROLES_REQUIRING_2FA].sort()).toEqual(["administrator", "owner"]);
  });
});
