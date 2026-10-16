import { and, desc, eq, gt, ne } from "drizzle-orm";
import { recordAudit } from "@/server/audit/audit-log";
import { type Database } from "@/server/db/client";
import { authSessions } from "@/server/db/schema";
import { type AuthenticatedUser } from "./session";
import { describeUserAgent, type DeviceSummary } from "./user-agent";

export interface SessionView {
  id: string;
  current: boolean;
  createdAt: Date;
  lastActiveAt: Date;
  expiresAt: Date;
  ipAddress: string | null;
  device: DeviceSummary;
  twoFactorVerified: boolean;
}

/** The user's active sessions. Tokens are never returned. */
export async function listMySessions(
  db: Database,
  user: AuthenticatedUser,
): Promise<SessionView[]> {
  const rows = await db
    .select()
    .from(authSessions)
    .where(and(eq(authSessions.userId, user.userId), gt(authSessions.expiresAt, new Date())))
    .orderBy(desc(authSessions.updatedAt));
  return rows.map((s) => ({
    id: s.id,
    current: s.id === user.sessionId,
    createdAt: s.createdAt,
    lastActiveAt: s.updatedAt,
    expiresAt: s.expiresAt,
    ipAddress: s.ipAddress,
    device: describeUserAgent(s.userAgent),
    twoFactorVerified: s.twoFactorVerifiedAt !== null,
  }));
}

/** Revokes one of the user's own sessions. Returns false if it does not exist or is not theirs. */
export async function revokeMySession(
  db: Database,
  user: AuthenticatedUser,
  sessionId: string,
): Promise<boolean> {
  const deleted = await db
    .delete(authSessions)
    .where(and(eq(authSessions.id, sessionId), eq(authSessions.userId, user.userId)))
    .returning({ id: authSessions.id });
  if (deleted.length) {
    await recordAudit(db, {
      companyId: null,
      actorUserId: user.userId,
      action: "auth.session_revoked",
      entityType: "session",
      entityId: sessionId,
      metadata: { current: sessionId === user.sessionId },
    });
  }
  return deleted.length > 0;
}

export async function revokeMyOtherSessions(
  db: Database,
  user: AuthenticatedUser,
): Promise<number> {
  const deleted = await db
    .delete(authSessions)
    .where(and(eq(authSessions.userId, user.userId), ne(authSessions.id, user.sessionId)))
    .returning({ id: authSessions.id });
  await recordAudit(db, {
    companyId: null,
    actorUserId: user.userId,
    action: "auth.other_sessions_revoked",
    entityType: "user",
    entityId: user.userId,
    metadata: { count: deleted.length },
  });
  return deleted.length;
}
