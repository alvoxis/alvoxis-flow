/** Too many assistant questions (per user per minute) or the company's monthly budget is used up. */
export class AiLimitError extends Error {
  constructor(public readonly code: "rate_limited" | "budget_exhausted") {
    super(`AI limit: ${code}`);
    this.name = "AiLimitError";
  }
}
