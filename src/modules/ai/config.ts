/** AI assistant settings that are not secrets (the API key comes from the server environment). */
export const AI_DEFAULT_MODEL = "claude-opus-5-5";
/** Questions per user per minute. */
export const AI_RATE_PER_MINUTE = 5;
/** Model ↔ tool round trips per question (each round may call several tools). */
export const AI_MAX_ROUNDS = 6;
/** Wall-clock limit of one question, all rounds included. */
export const AI_TIMEOUT_MS = 90_000;
export const AI_MAX_QUESTION_CHARS = 2000;
/** Earlier questions and answers of the conversation sent back for context. */
export const AI_MAX_HISTORY_TURNS = 4;
export const AI_MAX_HISTORY_CHARS = 4000;
