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
  "finance.view",
  "finance.manage",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/**
 * Permissions that create or change business data, or use the AI assistant. With an inactive
 * subscription (where subscriptions are enforced) they are withheld, so the company is read-only;
 * viewing, exports, members, settings and billing stay available. See modules/billing/access.ts.
 */
export const PAID_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>([
  "customers.manage",
  "suppliers.manage",
  "products.manage",
  "documents.create",
  "documents.approve",
  "tax_categories.manage",
  "inventory.manage",
  "production.manage",
  "payroll.manage",
  "integrations.manage",
  "ai.use",
  "ai.financial_actions",
  "finance.manage",
]);

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
    "finance.view",
    "finance.manage",
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
    "finance.view",
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
