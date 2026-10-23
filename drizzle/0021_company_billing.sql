CREATE TABLE "company_billing" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"stripe_customer_id" text NOT NULL,
	"stripe_subscription_id" text,
	"plan" text,
	"status" text,
	"trial_ends_at" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"trial_used" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_billing_plan_ck" CHECK ("company_billing"."plan" is null or "company_billing"."plan" in ('basic', 'pro', 'business'))
);
--> statement-breakpoint
ALTER TABLE "company_billing" ADD CONSTRAINT "company_billing_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "company_billing_customer_uq" ON "company_billing" USING btree ("stripe_customer_id");