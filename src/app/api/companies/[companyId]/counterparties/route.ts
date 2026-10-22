import { headers } from "next/headers";
import { z } from "zod";
import {
  createCounterparty,
  listCounterparties,
} from "@/modules/counterparties/server/counterparty-service";
import { getAuth } from "@/server/auth/instance";
import { requireUser, toActor } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { apiError, invalidBody, ok } from "@/server/http/api-errors";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ companyId: string }> };

const kindSchema = z.enum(["customer", "supplier"]);

/**
 * Customers (`?kind=customer`, customers.view) or suppliers (`?kind=supplier`, suppliers.view),
 * by name. `q` searches name, registration/VAT number, email and contact; `includeArchived=1`
 * adds archived records.
 */
export async function GET(request: Request, { params }: Params) {
  const id = z.uuid().safeParse((await params).companyId);
  const search = new URL(request.url).searchParams;
  const kind = kindSchema.safeParse(search.get("kind"));
  if (!id.success || !kind.success) return ok({ error: "invalid_request" }, 400);
  try {
    const db = getDb();
    const user = await requireUser(getAuth(), db, await headers());
    return ok({
      counterparties: await listCounterparties(db, toActor(user), id.data, kind.data, {
        q: search.get("q") ?? undefined,
        includeArchived: search.get("includeArchived") === "1",
      }),
    });
  } catch (err) {
    return apiError(err);
  }
}

/**
 * Adds a customer and/or supplier: `{ name, isCustomer?, isSupplier?, registrationNumber?,
 * vatNumber?, email?, phone?, contactName?, addressLine1?, addressLine2?, postalCode?, city?,
 * countryCode?, paymentTermDays?, notes? }`. Invalid fields → 422 with issues; an active record
 * with the same registration number → 409 registration_taken.
 */
export async function POST(request: Request, { params }: Params) {
  const id = z.uuid().safeParse((await params).companyId);
  if (!id.success) return ok({ error: "invalid_request" }, 400);
  try {
    const db = getDb();
    const user = await requireUser(getAuth(), db, await headers());
    const body: unknown = await request.json().catch(() => null);
    if (body === null || typeof body !== "object") return ok({ error: "invalid_request" }, 400);
    return ok({ counterparty: await createCounterparty(db, toActor(user), id.data, body) }, 201);
  } catch (err) {
    return invalidBody(err);
  }
}
