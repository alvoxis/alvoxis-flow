CREATE TYPE "public"."product_kind" AS ENUM('goods', 'service');--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" "product_kind" DEFAULT 'goods' NOT NULL,
	"sku" text,
	"name" text NOT NULL,
	"description" text,
	"unit" text DEFAULT 'pcs' NOT NULL,
	"barcode" text,
	"currency" text DEFAULT 'EUR' NOT NULL,
	"sale_price" numeric(18, 4),
	"purchase_price" numeric(18, 4),
	"tax_category_id" uuid,
	"track_stock" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_id_company_uq" UNIQUE("id","company_id"),
	CONSTRAINT "products_name_ck" CHECK (length(trim("products"."name")) > 0),
	CONSTRAINT "products_unit_ck" CHECK (length(trim("products"."unit")) > 0),
	CONSTRAINT "products_currency_ck" CHECK ("products"."currency" in ('EUR', 'PLN')),
	CONSTRAINT "products_sale_price_ck" CHECK ("products"."sale_price" is null or "products"."sale_price" >= 0),
	CONSTRAINT "products_purchase_price_ck" CHECK ("products"."purchase_price" is null or "products"."purchase_price" >= 0),
	CONSTRAINT "products_track_stock_ck" CHECK (not "products"."track_stock" or "products"."kind" = 'goods'),
	CONSTRAINT "products_version_ck" CHECK ("products"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_tax_category_same_company_fk" FOREIGN KEY ("tax_category_id","company_id") REFERENCES "public"."tax_categories"("id","company_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "products_active_sku_uq" ON "products" USING btree ("company_id","sku") WHERE "products"."archived_at" is null and "products"."sku" is not null;--> statement-breakpoint
CREATE INDEX "products_company_name_idx" ON "products" USING btree ("company_id","name");