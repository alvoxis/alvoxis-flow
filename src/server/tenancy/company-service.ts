import { and, asc, eq, isNull } from "drizzle-orm";
import { recordAudit } from "@/server/audit/audit-log";
import { type Actor } from "@/server/auth/authorization";
import {
  DEFAULT_ROLE_PERMISSIONS,
  ROLES_REQUIRING_2FA,
  SYSTEM_ROLES,
} from "@/server/auth/permissions";
import { type Database, type DbOrTx } from "@/server/db/client";
import { companies, memberships, rolePermissions, roles } from "@/server/db/schema";

export type CountryCode = (typeof companies.country.enumValues)[number];

export interface CreateCompanyInput {
  name: string;
  country: CountryCode;
  legalName?: string;
  registrationNumber?: string;
  vatNumber?: string;
}

/** Human-readable names are display defaults; the UI translates by `key`. */
const SYSTEM_ROLE_NAMES: Record<(typeof SYSTEM_ROLES)[number], string> = {
  owner: "Owner",
  administrator: "Administrator",
  accountant: "Accountant",
  manager: "Manager",
  warehouse_employee: "Warehouse employee",
  production_employee: "Production employee",
};

/**
 * Creates a company, its system roles (from templates), and an owner membership for the
 * actor — atomically, with an audit record.
 */
export async function createCompanyWithOwner(
  db: Database,
  actor: Actor,
  input: CreateCompanyInput,
): Promise<{ companyId: string }> {
  return db.transaction(async (tx) => {
    const [company] = await tx
      .insert(companies)
      .values({
        name: input.name.trim(),
        country: input.country,
        legalName: input.legalName ?? null,
        registrationNumber: input.registrationNumber ?? null,
        vatNumber: input.vatNumber ?? null,
      })
      .returning({ id: companies.id });
    if (!company) throw new Error("Company insert returned no row");

    const insertedRoles = await tx
      .insert(roles)
      .values(
        SYSTEM_ROLES.map((key) => ({
          companyId: company.id,
          key,
          name: SYSTEM_ROLE_NAMES[key],
          isSystem: true,
          requiresTwoFactor: ROLES_REQUIRING_2FA.includes(key),
        })),
      )
      .returning({ id: roles.id, key: roles.key });

    const grants = insertedRoles.flatMap((r) =>
      DEFAULT_ROLE_PERMISSIONS[r.key as (typeof SYSTEM_ROLES)[number]].map((permissionKey) => ({
        roleId: r.id,
        permissionKey,
      })),
    );
    await tx.insert(rolePermissions).values(grants);

    const ownerRole = insertedRoles.find((r) => r.key === "owner");
    if (!ownerRole) throw new Error("Owner role missing");

    await tx.insert(memberships).values({
      companyId: company.id,
      userId: actor.userId,
      roleId: ownerRole.id,
      status: "active",
    });

    await recordAudit(tx, {
      companyId: company.id,
      actorUserId: actor.userId,
      action: "company.created",
      entityType: "company",
      entityId: company.id,
      metadata: { country: input.country },
    });

    return { companyId: company.id };
  });
}

/** Companies the user is an active member of. Never returns other tenants' companies. */
export async function listCompaniesForUser(db: DbOrTx, userId: string) {
  return db
    .select({
      id: companies.id,
      name: companies.name,
      country: companies.country,
      roleKey: roles.key,
    })
    .from(memberships)
    .innerJoin(companies, eq(companies.id, memberships.companyId))
    .innerJoin(roles, eq(roles.id, memberships.roleId))
    .where(
      and(
        eq(memberships.userId, userId),
        eq(memberships.status, "active"),
        isNull(companies.archivedAt),
      ),
    )
    .orderBy(asc(companies.name));
}
