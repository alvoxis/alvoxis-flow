ALTER TABLE "documents" ADD COLUMN "source_file_sha256" text;--> statement-breakpoint
CREATE INDEX "documents_company_source_file_idx" ON "documents" USING btree ("company_id","source_file_sha256");