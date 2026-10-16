import { and, eq, isNull } from "drizzle-orm";
import { type DbOrTx } from "@/server/db/client";
import { companies, memberships, roles } from "@/server/db/schema";

/**
 * True when the user holds an active membership, in a non-archived company, with a role that
 * requires two-factor authentication (owner/administrator by default).
 */
export async function userRequiresTwoFactor(db: DbOrTx, userId: string): Promise<boolean> {
  const rows = await db
    .select({ id: memberships.id })
    .from(memberships)
    .innerJoin(
      roles,
      and(eq(roles.id, memberships.roleId), eq(roles.companyId, memberships.companyId)),
    )
    .innerJoin(companies, eq(companies.id, memberships.companyId))
    .where(
      and(
        eq(memberships.userId, userId),
        eq(memberships.status, "active"),
        eq(roles.requiresTwoFactor, true),
        isNull(companies.archivedAt),
      ),
    )
    .limit(1);
  return rows.length > 0;
}
