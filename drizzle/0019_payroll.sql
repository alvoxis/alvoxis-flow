CREATE TYPE "public"."payroll_run_status" AS ENUM('draft', 'approved');--> statement-breakpoint
CREATE TABLE "employees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"position" text,
	"email" text,
	"tax_country" text NOT NULL,
	"employment_start" date NOT NULL,
	"employment_end" date,
	"monthly_gross" numeric(12, 2) NOT NULL,
	"monthly_allowance" numeric(12, 2) DEFAULT '0' NOT NULL,
	"monthly_tax_credit" numeric(12, 2) DEFAULT '0' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employees_id_company_uq" UNIQUE("id","company_id"),
	CONSTRAINT "employees_country_ck" CHECK ("employees"."tax_country" in ('LV', 'LT', 'EE', 'PL')),
	CONSTRAINT "employees_name_ck" CHECK (length(trim("employees"."first_name")) > 0 and length(trim("employees"."last_name")) > 0),
	CONSTRAINT "employees_amounts_ck" CHECK ("employees"."monthly_gross" >= 0 and "employees"."monthly_allowance" >= 0 and "employees"."monthly_tax_credit" >= 0),
	CONSTRAINT "employees_dates_ck" CHECK ("employees"."employment_end" is null or "employees"."employment_end" >= "employees"."employment_start"),
	CONSTRAINT "employees_version_ck" CHECK ("employees"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "payroll_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"employee_name" text NOT NULL,
	"tax_country" text NOT NULL,
	"currency" text NOT NULL,
	"gross" numeric(12, 2) NOT NULL,
	"allowance" numeric(12, 2) NOT NULL,
	"tax_credit" numeric(12, 2) NOT NULL,
	"employee_social" numeric(12, 2) NOT NULL,
	"health" numeric(12, 2) NOT NULL,
	"taxable" numeric(12, 2) NOT NULL,
	"income_tax" numeric(12, 2) NOT NULL,
	"net" numeric(12, 2) NOT NULL,
	"employer_social" numeric(12, 2) NOT NULL,
	"employer_cost" numeric(12, 2) NOT NULL,
	"rates" jsonb NOT NULL,
	CONSTRAINT "payroll_lines_run_employee_uq" UNIQUE("run_id","employee_id")
);
--> statement-breakpoint
CREATE TABLE "payroll_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"country" text NOT NULL,
	"employee_social_rate" numeric(5, 3) NOT NULL,
	"employer_social_rate" numeric(5, 3) NOT NULL,
	"income_tax_rate" numeric(5, 3) NOT NULL,
	"employee_health_rate" numeric(5, 3) NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_rates_company_country_uq" UNIQUE("company_id","country"),
	CONSTRAINT "payroll_rates_country_ck" CHECK ("payroll_rates"."country" in ('LV', 'LT', 'EE', 'PL')),
	CONSTRAINT "payroll_rates_range_ck" CHECK ("payroll_rates"."employee_social_rate" between 0 and 99.999 and "payroll_rates"."employer_social_rate" between 0 and 99.999
        and "payroll_rates"."income_tax_rate" between 0 and 99.999 and "payroll_rates"."employee_health_rate" between 0 and 99.999)
);
--> statement-breakpoint
CREATE TABLE "payroll_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"period" text NOT NULL,
	"status" "payroll_run_status" DEFAULT 'draft' NOT NULL,
	"approved_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_runs_id_company_uq" UNIQUE("id","company_id"),
	CONSTRAINT "payroll_runs_company_period_uq" UNIQUE("company_id","period"),
	CONSTRAINT "payroll_runs_period_ck" CHECK ("payroll_runs"."period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "payroll_runs_approved_ck" CHECK (("payroll_runs"."status" = 'approved') = ("payroll_runs"."approved_at" is not null)),
	CONSTRAINT "payroll_runs_version_ck" CHECK ("payroll_runs"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_lines" ADD CONSTRAINT "payroll_lines_run_fk" FOREIGN KEY ("run_id","company_id") REFERENCES "public"."payroll_runs"("id","company_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_lines" ADD CONSTRAINT "payroll_lines_employee_fk" FOREIGN KEY ("employee_id","company_id") REFERENCES "public"."employees"("id","company_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_rates" ADD CONSTRAINT "payroll_rates_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "employees_company_name_idx" ON "employees" USING btree ("company_id","last_name","first_name");