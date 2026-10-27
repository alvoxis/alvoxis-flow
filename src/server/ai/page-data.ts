import "server-only";
import { z } from "zod";
import { assistantStatus } from "@/modules/ai/server/assistant-service";
import { aiMonthlyBudget, getAiGateway } from "@/modules/ai/server/gateway";
import { type AuthenticatedUser, toActor } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { ForbiddenError, TwoFactorRequiredError } from "@/server/errors";

export type AssistantPageData =
  | { status: "ok"; assistant: Awaited<ReturnType<typeof assistantStatus>> }
  | { status: "two_factor_required" }
  | { status: "not_found" };

/** The assistant page: configured or not, whether this role may ask, the month's remaining budget. */
export async function assistantPageData(
  user: AuthenticatedUser,
  companyId: string,
): Promise<AssistantPageData> {
  if (!z.uuid().safeParse(companyId).success) return { status: "not_found" };
  try {
    const assistant = await assistantStatus(
      getDb(),
      getAiGateway(),
      aiMonthlyBudget(),
      toActor(user),
      companyId,
    );
    return { status: "ok", assistant };
  } catch (err) {
    if (err instanceof TwoFactorRequiredError) return { status: "two_factor_required" };
    if (err instanceof ForbiddenError) return { status: "not_found" };
    throw err;
  }
}
