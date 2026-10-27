CREATE TABLE "billing_events" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"company_id" uuid,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "company_access_grants" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"reason" text NOT NULL,
	"granted_by_user_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_access_grants_reason_ck" CHECK (length(trim("company_access_grants"."reason")) >= 5)
);
--> statement-breakpoint
CREATE TABLE "platform_admins" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"granted_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "company_billing" DROP CONSTRAINT "company_billing_plan_ck";--> statement-breakpoint
ALTER TABLE "billing_events" ADD CONSTRAINT "billing_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_access_grants" ADD CONSTRAINT "company_access_grants_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_access_grants" ADD CONSTRAINT "company_access_grants_granted_by_user_id_users_id_fk" FOREIGN KEY ("granted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_admins" ADD CONSTRAINT "platform_admins_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "billing_events_company_idx" ON "billing_events" USING btree ("company_id","received_at");--> statement-breakpoint
ALTER TABLE "company_billing" ADD CONSTRAINT "company_billing_plan_ck" CHECK ("company_billing"."plan" is null or "company_billing"."plan" in ('flow', 'basic', 'pro', 'business'));