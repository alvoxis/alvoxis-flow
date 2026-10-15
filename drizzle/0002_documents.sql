CREATE TYPE "public"."currency_code" AS ENUM('EUR', 'PLN');--> statement-breakpoint
CREATE TYPE "public"."document_origin" AS ENUM('created', 'imported');--> statement-breakpoint
CREATE TYPE "public"."document_relation_kind" AS ENUM('credits', 'converted_from', 'delivers', 'replaces');--> statement-breakpoint
CREATE TYPE "public"."document_status" AS ENUM('draft', 'issued');--> statement-breakpoint
CREATE TYPE "public"."document_type" AS ENUM('invoice', 'proforma', 'credit_note', 'delivery_note');--> statement-breakpoint
CREATE TYPE "public"."document_line_kind" AS ENUM('item', 'charge');--> statement-breakpoint
CREATE TYPE "public"."numbering_reset_policy" AS ENUM('never', 'yearly');--> statement-breakpoint
CREATE TABLE "document_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"kind" "document_line_kind" DEFAULT 'item' NOT NULL,
	"description" text NOT NULL,
	"quantity" numeric(18, 4) NOT NULL,
	"unit" text,
	"unit_price" numeric(18, 4),
	"discount_percent" numeric(5, 2),
	"tax_category" jsonb,
	"weight_kg" numeric(14, 3),
	"source_line_id" uuid,
	"net_amount" numeric(18, 2),
	CONSTRAINT "document_lines_id_company_uq" UNIQUE("id","company_id"),
	CONSTRAINT "document_lines_position_uq" UNIQUE("document_id","position")
);
--> statement-breakpoint
CREATE TABLE "document_number_counters" (
	"series_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"period_key" text NOT NULL,
	"last_value" integer NOT NULL,
	CONSTRAINT "document_number_counters_series_id_period_key_pk" PRIMARY KEY("series_id","period_key"),
	CONSTRAINT "document_number_counters_positive_ck" CHECK ("document_number_counters"."last_value" > 0)
);
--> statement-breakpoint
CREATE TABLE "document_number_series" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"document_type" "document_type" NOT NULL,
	"name" text NOT NULL,
	"pattern" text NOT NULL,
	"reset_policy" "numbering_reset_policy" NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_number_series_id_company_uq" UNIQUE("id","company_id")
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"type" "document_type" NOT NULL,
	"status" "document_status" DEFAULT 'draft' NOT NULL,
	"origin" "document_origin" DEFAULT 'created' NOT NULL,
	"series_id" uuid,
	"number" text,
	"language" "locale_code" NOT NULL,
	"currency" "currency_code" NOT NULL,
	"issue_date" date NOT NULL,
	"due_date" date,
	"supply_date" date,
	"valid_until" date,
	"seller" jsonb NOT NULL,
	"buyer" jsonb NOT NULL,
	"deliver_to" jsonb,
	"bank_accounts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"buyer_reference" text,
	"payment_terms" text,
	"notes" text,
	"footer" text,
	"exchange_rate" jsonb,
	"relation_kind" "document_relation_kind",
	"related_document_id" uuid,
	"net_total" numeric(18, 2),
	"tax_total" numeric(18, 2),
	"gross_total" numeric(18, 2),
	"tax_summary" jsonb,
	"snapshot" jsonb,
	"content_hash" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by_user_id" uuid,
	"issued_by_user_id" uuid,
	"issued_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documents_id_company_uq" UNIQUE("id","company_id"),
	CONSTRAINT "documents_company_type_number_uq" UNIQUE("company_id","type","number"),
	CONSTRAINT "documents_issued_complete_ck" CHECK ("documents"."status" = 'draft' or ("documents"."number" is not null and "documents"."issued_at" is not null and "documents"."content_hash" is not null and "documents"."snapshot" is not null)),
	CONSTRAINT "documents_relation_pair_ck" CHECK (("documents"."relation_kind" is null) = ("documents"."related_document_id" is null)),
	CONSTRAINT "documents_credit_note_relation_ck" CHECK ("documents"."type" <> 'credit_note' or "documents"."relation_kind" = 'credits'),
	CONSTRAINT "documents_due_after_issue_ck" CHECK ("documents"."due_date" is null or "documents"."due_date" >= "documents"."issue_date")
);
--> statement-breakpoint
ALTER TABLE "document_lines" ADD CONSTRAINT "document_lines_document_fk" FOREIGN KEY ("document_id","company_id") REFERENCES "public"."documents"("id","company_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_lines" ADD CONSTRAINT "document_lines_source_same_company_fk" FOREIGN KEY ("source_line_id","company_id") REFERENCES "public"."document_lines"("id","company_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_number_counters" ADD CONSTRAINT "document_number_counters_series_fk" FOREIGN KEY ("series_id","company_id") REFERENCES "public"."document_number_series"("id","company_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_number_series" ADD CONSTRAINT "document_number_series_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_issued_by_user_id_users_id_fk" FOREIGN KEY ("issued_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_series_same_company_fk" FOREIGN KEY ("series_id","company_id") REFERENCES "public"."document_number_series"("id","company_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_related_same_company_fk" FOREIGN KEY ("related_document_id","company_id") REFERENCES "public"."documents"("id","company_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_lines_source_idx" ON "document_lines" USING btree ("source_line_id");--> statement-breakpoint
CREATE UNIQUE INDEX "document_number_series_one_default_uq" ON "document_number_series" USING btree ("company_id","document_type") WHERE "document_number_series"."is_default" and "document_number_series"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "documents_company_issue_date_idx" ON "documents" USING btree ("company_id","issue_date");--> statement-breakpoint
CREATE INDEX "documents_related_idx" ON "documents" USING btree ("related_document_id");