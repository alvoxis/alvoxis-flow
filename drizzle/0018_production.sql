CREATE TYPE "public"."production_order_status" AS ENUM('planned', 'completed', 'cancelled');--> statement-breakpoint
CREATE TABLE "product_components" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"component_id" uuid NOT NULL,
	"quantity" numeric(18, 4) NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_components_product_component_uq" UNIQUE("product_id","component_id"),
	CONSTRAINT "product_components_quantity_ck" CHECK ("product_components"."quantity" > 0),
	CONSTRAINT "product_components_not_self_ck" CHECK ("product_components"."product_id" <> "product_components"."component_id")
);
--> statement-breakpoint
CREATE TABLE "production_order_components" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"component_id" uuid NOT NULL,
	"quantity" numeric(18, 4) NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "production_order_components_uq" UNIQUE("order_id","component_id"),
	CONSTRAINT "production_order_components_quantity_ck" CHECK ("production_order_components"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "production_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"number" text NOT NULL,
	"product_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"quantity" numeric(18, 4) NOT NULL,
	"status" "production_order_status" DEFAULT 'planned' NOT NULL,
	"planned_on" date NOT NULL,
	"completed_on" date,
	"note" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "production_orders_id_company_uq" UNIQUE("id","company_id"),
	CONSTRAINT "production_orders_company_number_uq" UNIQUE("company_id","number"),
	CONSTRAINT "production_orders_quantity_ck" CHECK ("production_orders"."quantity" > 0),
	CONSTRAINT "production_orders_completed_ck" CHECK (("production_orders"."status" = 'completed') = ("production_orders"."completed_on" is not null)),
	CONSTRAINT "production_orders_version_ck" CHECK ("production_orders"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "product_components" ADD CONSTRAINT "product_components_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_components" ADD CONSTRAINT "product_components_product_same_company_fk" FOREIGN KEY ("product_id","company_id") REFERENCES "public"."products"("id","company_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_components" ADD CONSTRAINT "product_components_component_same_company_fk" FOREIGN KEY ("component_id","company_id") REFERENCES "public"."products"("id","company_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_order_components" ADD CONSTRAINT "production_order_components_order_fk" FOREIGN KEY ("order_id","company_id") REFERENCES "public"."production_orders"("id","company_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_order_components" ADD CONSTRAINT "production_order_components_component_fk" FOREIGN KEY ("component_id","company_id") REFERENCES "public"."products"("id","company_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_product_same_company_fk" FOREIGN KEY ("product_id","company_id") REFERENCES "public"."products"("id","company_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_warehouse_same_company_fk" FOREIGN KEY ("warehouse_id","company_id") REFERENCES "public"."warehouses"("id","company_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "production_orders_company_status_idx" ON "production_orders" USING btree ("company_id","status");