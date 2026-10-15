import { eq, type SQL } from "drizzle-orm";
import { type PgColumn } from "drizzle-orm/pg-core";
import { type CompanyContext } from "@/server/auth/authorization";

/**
 * Builds the mandatory tenant filter for a tenant-scoped table. Every query on a table with
 * a `company_id` column must include this condition, using a context obtained from
 * `requireCompanyAccess` — never a company id taken directly from client input.
 */
export function tenantFilter(companyIdColumn: PgColumn, ctx: CompanyContext): SQL {
  return eq(companyIdColumn, ctx.companyId);
}
