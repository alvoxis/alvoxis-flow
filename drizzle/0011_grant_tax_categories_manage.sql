-- Grants the new `tax_categories.manage` permission to the existing system roles that receive it
-- in the role templates (owner, administrator, accountant). New companies get it from the
-- templates. Idempotent: the key is created if `pnpm db:seed` has not run yet, and existing
-- grants are left alone. Custom (non-system) roles are not changed.
INSERT INTO "permissions" ("key") VALUES ('tax_categories.manage') ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_key")
SELECT "id", 'tax_categories.manage' FROM "roles"
WHERE "is_system" AND "key" IN ('owner', 'administrator', 'accountant')
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
