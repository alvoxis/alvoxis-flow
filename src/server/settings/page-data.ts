import "server-only";
import { z } from "zod";
import { type AuthenticatedUser, toActor } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { ForbiddenError, TwoFactorRequiredError } from "@/server/errors";
import {
  listMembers,
  type MemberView,
  type RoleOption,
  settingsAccess,
} from "@/server/tenancy/members-service";

export type SettingsPageData =
  | {
      status: "ok";
      access: Awaited<ReturnType<typeof settingsAccess>>;
      members: { members: MemberView[]; roles: RoleOption[] } | null;
    }
  | { status: "two_factor_required" }
  | { status: "not_found" };

/** Settings page (any active member): sections by permission; members with members.view. */
export async function settingsPageData(
  user: AuthenticatedUser,
  companyId: string,
): Promise<SettingsPageData> {
  if (!z.uuid().safeParse(companyId).success) return { status: "not_found" };
  const db = getDb();
  const actor = toActor(user);
  try {
    const access = await settingsAccess(db, actor, companyId);
    const members = access.members ? await listMembers(db, actor, companyId) : null;
    return { status: "ok", access, members };
  } catch (err) {
    if (err instanceof TwoFactorRequiredError) return { status: "two_factor_required" };
    if (err instanceof ForbiddenError) return { status: "not_found" };
    throw err;
  }
}
