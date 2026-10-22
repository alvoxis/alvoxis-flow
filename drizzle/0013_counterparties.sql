CREATE TABLE "counterparties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"is_customer" boolean DEFAULT false NOT NULL,
	"is_supplier" boolean DEFAULT false NOT NULL,
	"name" text NOT NULL,
	"registration_number" text,
	"vat_number" text,
	"email" text,
	"phone" text,
	"contact_name" text,
	"address_line1" text,
	"address_line2" text,
	"postal_code" text,
	"city" text,
	"country_code" text,
	"payment_term_days" integer,
	"notes" text,
	"version" integer DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "counterparties_id_company_uq" UNIQUE("id","company_id"),
	CONSTRAINT "counterparties_role_ck" CHECK ("counterparties"."is_customer" or "counterparties"."is_supplier"),
	CONSTRAINT "counterparties_name_ck" CHECK (length(trim("counterparties"."name")) > 0),
	CONSTRAINT "counterparties_country_ck" CHECK ("counterparties"."country_code" is null or "counterparties"."country_code" ~ '^[A-Z]{2}$'),
	CONSTRAINT "counterparties_payment_term_ck" CHECK ("counterparties"."payment_term_days" is null or "counterparties"."payment_term_days" between 0 and 365),
	CONSTRAINT "counterparties_version_ck" CHECK ("counterparties"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "counterparties" ADD CONSTRAINT "counterparties_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "counterparties" ADD CONSTRAINT "counterparties_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "counterparties_active_registration_uq" ON "counterparties" USING btree ("company_id","registration_number") WHERE "counterparties"."archived_at" is null and "counterparties"."registration_number" is not null;--> statement-breakpoint
CREATE INDEX "counterparties_company_name_idx" ON "counterparties" USING btree ("company_id","name");