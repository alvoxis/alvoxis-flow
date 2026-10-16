import { headers } from "next/headers";
import { getAuth } from "@/server/auth/instance";
import { requireUser } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { apiError, ok } from "@/server/http/api-errors";
import { listCompaniesForUser } from "@/server/tenancy/company-service";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const db = getDb();
    const user = await requireUser(getAuth(), db, await headers());
    return ok({
      user: {
        id: user.userId,
        email: user.email,
        displayName: user.displayName,
        twoFactorEnabled: user.twoFactorEnabled,
      },
      companies: await listCompaniesForUser(db, user.userId),
    });
  } catch (err) {
    return apiError(err);
  }
}
