/**
 * Permission catalog. Keys are stable identifiers persisted in the database; adding a key
 * here requires running `pnpm db:seed` (idempotent) so the `permissions` table matches.
 *
 * Permissions for modules not yet implemented are declared now so that role templates are
 * stable, but declaring a permission does not mean the module exists.
 */
export const PERMISSIONS = [
  "company.view",
  "company.manage",
  "company.delete",
  "members.view",
  "members.manage",
  "roles.manage",
  "audit.view",
  "billing.manage",
  "customers.view",
  "customers.manage",
  "suppliers.view",
  "suppliers.manage",
  "products.view",
  "products.manage",
  "documents.view",
  "documents.create",
  "documents.approve",
  "tax_categories.manage",
  "inventory.view",
  "inventory.manage",
  "production.view",
  "production.manage",
  "payroll.view",
  "payroll.manage",
  "analytics.view",
  "integrations.manage",
  "ai.use",
  "ai.financial_actions",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const SYSTEM_ROLES = [
  "owner",
  "administrator",
  "accountant",
  "manager",
  "warehouse_employee",
  "production_employee",
] as const;

export type SystemRoleKey = (typeof SYSTEM_ROLES)[number];

/** Roles whose members must have two-factor authentication enabled. */
export const ROLES_REQUIRING_2FA: readonly SystemRoleKey[] = ["owner", "administrator"];

const all = [...PERMISSIONS];
const without = (...excluded: Permission[]) => all.filter((p) => !excluded.includes(p));

/**
 * Default permission templates copied into each new company. Companies may then customise
 * their own roles; changing these defaults never alters existing companies.
 */
export const DEFAULT_ROLE_PERMISSIONS: Record<SystemRoleKey, readonly Permission[]> = {
  owner: all,
  administrator: without("company.delete", "billing.manage"),
  accountant: [
    "company.view",
    "members.view",
    "audit.view",
    "customers.view",
    "customers.manage",
    "suppliers.view",
    "suppliers.manage",
    "products.view",
    "documents.view",
    "documents.create",
    "documents.approve",
    "tax_categories.manage",
    "inventory.view",
    "payroll.view",
    "payroll.manage",
    "analytics.view",
    "ai.use",
  ],
  manager: [
    "company.view",
    "members.view",
    "customers.view",
    "customers.manage",
    "suppliers.view",
    "suppliers.manage",
    "products.view",
    "products.manage",
    "documents.view",
    "documents.create",
    "inventory.view",
    "production.view",
    "analytics.view",
    "ai.use",
  ],
  warehouse_employee: [
    "company.view",
    "products.view",
    "documents.view",
    "inventory.view",
    "inventory.manage",
  ],
  production_employee: [
    "company.view",
    "products.view",
    "inventory.view",
    "production.view",
    "production.manage",
  ],
};

export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value);
}
