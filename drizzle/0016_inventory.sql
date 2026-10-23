CREATE TYPE "public"."stock_movement_kind" AS ENUM('receipt', 'issue', 'adjustment', 'transfer_out', 'transfer_in', 'production_consume', 'production_output');--> statement-breakpoint
CREATE TABLE "stock_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"kind" "stock_movement_kind" NOT NULL,
	"quantity" numeric(18, 4) NOT NULL,
	"unit_cost" numeric(18, 4),
	"occurred_on" date NOT NULL,
	"reference" text,
	"note" text,
	"group_id" uuid,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_movements_quantity_ck" CHECK ("stock_movements"."quantity" <> 0),
	CONSTRAINT "stock_movements_sign_ck" CHECK (("stock_movements"."kind" in ('receipt', 'transfer_in', 'production_output') and "stock_movements"."quantity" > 0)
        or ("stock_movements"."kind" in ('issue', 'transfer_out', 'production_consume') and "stock_movements"."quantity" < 0)
        or "stock_movements"."kind" = 'adjustment'),
	CONSTRAINT "stock_movements_unit_cost_ck" CHECK ("stock_movements"."unit_cost" is null or "stock_movements"."unit_cost" >= 0)
);
--> statement-breakpoint
CREATE TABLE "warehouses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "warehouses_id_company_uq" UNIQUE("id","company_id"),
	CONSTRAINT "warehouses_company_code_uq" UNIQUE("company_id","code"),
	CONSTRAINT "warehouses_code_ck" CHECK ("warehouses"."code" ~ '^[A-Z0-9][A-Z0-9_-]{0,19}$'),
	CONSTRAINT "warehouses_name_ck" CHECK (length(trim("warehouses"."name")) > 0),
	CONSTRAINT "warehouses_version_ck" CHECK ("warehouses"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_product_same_company_fk" FOREIGN KEY ("product_id","company_id") REFERENCES "public"."products"("id","company_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_warehouse_same_company_fk" FOREIGN KEY ("warehouse_id","company_id") REFERENCES "public"."warehouses"("id","company_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouses" ADD CONSTRAINT "warehouses_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stock_movements_balance_idx" ON "stock_movements" USING btree ("company_id","product_id","warehouse_id");--> statement-breakpoint
CREATE INDEX "stock_movements_company_created_idx" ON "stock_movements" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "stock_movements_group_idx" ON "stock_movements" USING btree ("group_id");--> statement-breakpoint
CREATE UNIQUE INDEX "warehouses_one_default_uq" ON "warehouses" USING btree ("company_id") WHERE "warehouses"."is_default" and "warehouses"."archived_at" is null;