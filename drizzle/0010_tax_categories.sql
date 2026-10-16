CREATE TYPE "public"."tax_treatment_kind" AS ENUM('standard', 'zero_rated', 'exempt', 'reverse_charge', 'outside_scope');--> statement-breakpoint
CREATE TABLE "tax_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"kind" "tax_treatment_kind" NOT NULL,
	"rate_percent" numeric(5, 2) NOT NULL,
	"label" text NOT NULL,
	"note" text,
	"version" integer DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_categories_id_company_uq" UNIQUE("id","company_id"),
	CONSTRAINT "tax_categories_company_code_uq" UNIQUE("company_id","code"),
	CONSTRAINT "tax_categories_rate_ck" CHECK ("tax_categories"."rate_percent" >= 0 and "tax_categories"."rate_percent" < 100 and (("tax_categories"."kind" = 'standard') = ("tax_categories"."rate_percent" > 0))),
	CONSTRAINT "tax_categories_version_ck" CHECK ("tax_categories"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "document_lines" ADD COLUMN "tax_category_id" uuid;--> statement-breakpoint
ALTER TABLE "tax_categories" ADD CONSTRAINT "tax_categories_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_categories" ADD CONSTRAINT "tax_categories_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_lines" ADD CONSTRAINT "document_lines_tax_category_same_company_fk" FOREIGN KEY ("tax_category_id","company_id") REFERENCES "public"."tax_categories"("id","company_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_lines_tax_category_idx" ON "document_lines" USING btree ("tax_category_id");