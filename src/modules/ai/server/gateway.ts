import "server-only";
import { getServerEnv } from "@/config/env";
import { AI_DEFAULT_MODEL } from "../config";
import { type AiGateway, createAnthropicGateway } from "./assistant-service";

/** The Anthropic gateway for this deployment, or null when ANTHROPIC_API_KEY is not set. */
export function getAiGateway(): AiGateway | null {
  const env = getServerEnv();
  return env.ANTHROPIC_API_KEY
    ? createAnthropicGateway(env.ANTHROPIC_API_KEY, env.ANTHROPIC_MODEL ?? AI_DEFAULT_MODEL)
    : null;
}

export function aiMonthlyBudget(): number {
  return getServerEnv().AI_MONTHLY_REQUESTS_PER_COMPANY;
}
