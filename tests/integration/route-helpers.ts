import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { type Actor } from "@/server/auth/authorization";
import { type Permission } from "@/server/auth/permissions";
import { type Database } from "@/server/db/client";
import { memberships, rolePermissions, roles, users } from "@/server/db/schema";
import { createCompanyWithOwner } from "@/server/tenancy/company-service";

/**
 * Helpers for tests that call real route handlers (the session lookup is stubbed in each test
 * file with vi.mock): synthetic users, companies, members of system or custom roles, and request
 * builders. Synthetic data only.
 */
export function routeHelpers(db: () => Database) {
  const actorOf = (userId: string): Actor => ({ userId, twoFactorVerified: true });

  async function newUser(prefix = "route") {
    const [u] = await db()
      .insert(users)
      .values({ email: `${prefix}-${randomUUID()}@example.test` })
      .returning();
    return u!;
  }

  async function newCompany(name = "Records Co") {
    const owner = actorOf((await newUser()).id);
    const { companyId } = await createCompanyWithOwner(db(), owner, { name, country: "LV" });
    return { owner, companyId };
  }

  async function member(companyId: string, roleKey: string) {
    const u = await newUser();
    const [role] = await db()
      .select()
      .from(roles)
      .where(and(eq(roles.companyId, companyId), eq(roles.key, roleKey)));
    await db().insert(memberships).values({ companyId, userId: u.id, roleId: role!.id });
    return actorOf(u.id);
  }

  /** A member of a new custom role holding exactly `permissions`. */
  async function customMember(companyId: string, permissions: Permission[]) {
    const [role] = await db()
      .insert(roles)
      .values({ companyId, key: `custom-${randomUUID()}`, name: "Custom" })
      .returning();
    if (permissions.length)
      await db()
        .insert(rolePermissions)
        .values(permissions.map((permissionKey) => ({ roleId: role!.id, permissionKey })));
    const u = await newUser();
    await db().insert(memberships).values({ companyId, userId: u.id, roleId: role!.id });
    return actorOf(u.id);
  }

  return { actorOf, newUser, newCompany, member, customMember };
}

export const req = (method: string, body?: unknown, url = "http://localhost/api") =>
  new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

export const params = <T extends object>(v: T) => ({ params: Promise.resolve(v) });

export async function call(res: Response | Promise<Response>) {
  const r = await res;
  // Response bodies are asserted field by field; a loose type keeps the assertions readable.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: r.status, body: (await r.json()) as Record<string, any> };
}

export const issueCodes = (body: { issues?: unknown }) =>
  (body.issues as { code: string }[]).map((i) => i.code).sort();
