import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { type CalculationResult, type ParsedCalculation } from "@/modules/costing/domain/calculate";
import { products } from "./business";
import { currencyCode } from "./documents";
import { companies, users } from "./identity";

/**
 * Saved cost calculations. `input` is the validated calculation; `result` is what the server
 * computed from it when it was saved (the browser's live figures are never stored). Optionally
 * linked to a product of the same company (composite foreign key).
 */
export const costCalculations = pgTable(
  "cost_calculations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    productId: uuid("product_id"),
    currency: currencyCode("currency").notNull(),
    input: jsonb("input").$type<ParsedCalculation>().notNull(),
    result: jsonb("result").$type<CalculationResult>().notNull(),
    version: integer("version").notNull().default(1),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    foreignKey({
      name: "cost_calculations_product_same_company_fk",
      columns: [t.productId, t.companyId],
      foreignColumns: [products.id, products.companyId],
    }).onDelete("restrict"),
    index("cost_calculations_company_idx").on(t.companyId, t.updatedAt),
    check("cost_calculations_name_ck", sql`length(trim(${t.name})) > 0`),
    check("cost_calculations_version_ck", sql`${t.version} > 0`),
  ],
);

/**
 * One row per AI assistant request: who, which company, the model, token counts and outcome.
 * Never the question or the answer (they may contain business data); used for rate limits,
 * monthly budgets and the operator's cost overview.
 */
export const aiUsage = pgTable(
  "ai_usage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    model: text("model").notNull(),
    status: text("status").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    toolCalls: integer("tool_calls").notNull().default(0),
    durationMs: integer("duration_ms").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("ai_usage_company_created_idx").on(t.companyId, t.createdAt),
    index("ai_usage_user_created_idx").on(t.userId, t.createdAt),
    check("ai_usage_status_ck", sql`${t.status} in ('ok', 'error', 'timeout', 'refused')`),
  ],
);
