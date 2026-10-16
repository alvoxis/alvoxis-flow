CREATE TABLE "company_bank_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"label" text,
	"bank_name" text,
	"iban" text NOT NULL,
	"bic" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_bank_accounts_id_company_uq" UNIQUE("id","company_id"),
	CONSTRAINT "company_bank_accounts_iban_ck" CHECK ("company_bank_accounts"."iban" ~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$'),
	CONSTRAINT "company_bank_accounts_bic_ck" CHECK ("company_bank_accounts"."bic" is null or "company_bank_accounts"."bic" ~ '^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$'),
	CONSTRAINT "company_bank_accounts_version_ck" CHECK ("company_bank_accounts"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "bank_account_id" uuid;--> statement-breakpoint
ALTER TABLE "company_bank_accounts" ADD CONSTRAINT "company_bank_accounts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_bank_accounts" ADD CONSTRAINT "company_bank_accounts_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "company_bank_accounts_active_iban_uq" ON "company_bank_accounts" USING btree ("company_id","iban") WHERE "company_bank_accounts"."archived_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "company_bank_accounts_one_default_uq" ON "company_bank_accounts" USING btree ("company_id") WHERE "company_bank_accounts"."is_default" and "company_bank_accounts"."archived_at" is null;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_bank_account_same_company_fk" FOREIGN KEY ("bank_account_id","company_id") REFERENCES "public"."company_bank_accounts"("id","company_id") ON DELETE restrict ON UPDATE no action;