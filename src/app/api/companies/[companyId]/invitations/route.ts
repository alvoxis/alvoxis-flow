import { headers } from "next/headers";
import { z } from "zod";
import { getServerEnv } from "@/config/env";
import { getAuth, getMailer } from "@/server/auth/instance";
import { requireUser, toActor } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { apiError, invalidBody, ok } from "@/server/http/api-errors";
import { createInvitation, listInvitations } from "@/server/tenancy/invitations-service";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ companyId: string }> };

/** Open invitations of the company (members.view). */
export async function GET(_request: Request, { params }: Params) {
  const id = z.uuid().safeParse((await params).companyId);
  if (!id.success) return ok({ error: "invalid_request" }, 400);
  try {
    const db = getDb();
    const user = await requireUser(getAuth(), db, await headers());
    return ok({ invitations: await listInvitations(db, toActor(user), id.data) });
  } catch (err) {
    return apiError(err);
  }
}

/**
 * Invites a person (members.manage): `{ email, roleKey }`. Returns the invitation, the link to
 * share and whether the email was delivered. Invalid → 422; an existing member → 409
 * member_exists; the owner role by a non-owner → 403.
 */
export async function POST(request: Request, { params }: Params) {
  const id = z.uuid().safeParse((await params).companyId);
  if (!id.success) return ok({ error: "invalid_request" }, 400);
  try {
    const db = getDb();
    const user = await requireUser(getAuth(), db, await headers());
    const body: unknown = await request.json().catch(() => null);
    if (body === null || typeof body !== "object") return ok({ error: "invalid_request" }, 400);
    const created = await createInvitation(
      db,
      getMailer(),
      getServerEnv().APP_URL,
      toActor(user),
      id.data,
      body,
    );
    return ok(created, 201);
  } catch (err) {
    return invalidBody(err);
  }
}
