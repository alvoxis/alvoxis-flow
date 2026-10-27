import { headers } from "next/headers";
import { z } from "zod";
import { askAssistant } from "@/modules/ai/server/assistant-service";
import { aiMonthlyBudget, getAiGateway } from "@/modules/ai/server/gateway";
import { getAuth } from "@/server/auth/instance";
import { requireUser, toActor } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { invalidBody, ok } from "@/server/http/api-errors";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

type Params = { params: Promise<{ companyId: string }> };

/**
 * Asks the AI assistant (ai.use): `{ question, locale?, history? }` → `{ answer, status,
 * toolsUsed, model, remainingThisMonth }`. Not configured → 409 ai.notConfigured; too many
 * questions → 429 rate_limited / budget_exhausted; no active subscription → 402.
 */
export async function POST(request: Request, { params }: Params) {
  const id = z.uuid().safeParse((await params).companyId);
  if (!id.success) return ok({ error: "invalid_request" }, 400);
  try {
    const db = getDb();
    const user = await requireUser(getAuth(), db, await headers());
    const body: unknown = await request.json().catch(() => null);
    if (body === null || typeof body !== "object") return ok({ error: "invalid_request" }, 400);
    const answer = await askAssistant(
      db,
      getAiGateway(),
      aiMonthlyBudget(),
      toActor(user),
      id.data,
      body,
    );
    return ok(answer);
  } catch (err) {
    return invalidBody(err);
  }
}
