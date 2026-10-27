CREATE TYPE "public"."expense_recurrence" AS ENUM('none', 'monthly', 'quarterly', 'yearly');--> statement-breakpoint
CREATE TYPE "public"."expense_status" AS ENUM('paid', 'unpaid');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('bank_transfer', 'card', 'cash', 'other');--> statement-breakpoint
CREATE TABLE "document_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"currency" "currency_code" NOT NULL,
	"paid_on" date NOT NULL,
	"method" "payment_method" NOT NULL,
	"reference" text,
	"note" text,
	"source" text DEFAULT 'manual' NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by_user_id" uuid,
	CONSTRAINT "document_payments_amount_ck" CHECK ("document_payments"."amount" > 0),
	CONSTRAINT "document_payments_source_ck" CHECK ("document_payments"."source" in ('manual', 'imported'))
);
--> statement-breakpoint
CREATE TABLE "expenses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"expense_date" date NOT NULL,
	"category" text NOT NULL,
	"description" text NOT NULL,
	"supplier_id" uuid,
	"supplier_name" text,
	"currency" "currency_code" NOT NULL,
	"net_amount" numeric(18, 2) NOT NULL,
	"tax_amount" numeric(18, 2) DEFAULT '0' NOT NULL,
	"tax_recoverable" boolean DEFAULT true NOT NULL,
	"status" "expense_status" DEFAULT 'paid' NOT NULL,
	"due_date" date,
	"paid_on" date,
	"payment_method" "payment_method",
	"reference" text,
	"notes" text,
	"recurrence" "expense_recurrence" DEFAULT 'none' NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expenses_net_ck" CHECK ("expenses"."net_amount" >= 0),
	CONSTRAINT "expenses_tax_ck" CHECK ("expenses"."tax_amount" >= 0),
	CONSTRAINT "expenses_description_ck" CHECK (length(trim("expenses"."description")) > 0),
	CONSTRAINT "expenses_paid_ck" CHECK (("expenses"."status" = 'paid') = ("expenses"."paid_on" is not null)),
	CONSTRAINT "expenses_source_ck" CHECK ("expenses"."source" in ('manual', 'imported')),
	CONSTRAINT "expenses_version_ck" CHECK ("expenses"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "document_payments" ADD CONSTRAINT "document_payments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_payments" ADD CONSTRAINT "document_payments_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_payments" ADD CONSTRAINT "document_payments_voided_by_user_id_users_id_fk" FOREIGN KEY ("voided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_payments" ADD CONSTRAINT "document_payments_document_same_company_fk" FOREIGN KEY ("document_id","company_id") REFERENCES "public"."documents"("id","company_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_supplier_same_company_fk" FOREIGN KEY ("supplier_id","company_id") REFERENCES "public"."counterparties"("id","company_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_payments_document_idx" ON "document_payments" USING btree ("company_id","document_id");--> statement-breakpoint
CREATE INDEX "document_payments_company_paid_on_idx" ON "document_payments" USING btree ("company_id","paid_on");--> statement-breakpoint
CREATE UNIQUE INDEX "document_payments_reference_uq" ON "document_payments" USING btree ("document_id","reference") WHERE "document_payments"."reference" is not null and "document_payments"."voided_at" is null;--> statement-breakpoint
CREATE INDEX "expenses_company_date_idx" ON "expenses" USING btree ("company_id","expense_date");--> statement-breakpoint
CREATE INDEX "expenses_company_category_idx" ON "expenses" USING btree ("company_id","category");