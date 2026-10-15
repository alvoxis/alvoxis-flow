import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { PERMISSIONS } from "@/server/auth/permissions";
import { permissions } from "./schema";

/**
 * Idempotently inserts every permission key from the code catalog. Keys are never deleted
 * automatically: removing a permission requires an explicit migration.
 */
export async function seedPermissions(
  db: NodePgDatabase<Record<string, unknown>>,
): Promise<number> {
  const rows = PERMISSIONS.map((key) => ({ key }));
  const inserted = await db.insert(permissions).values(rows).onConflictDoNothing().returning();
  return inserted.length;
}
