-- Grants the new finance permissions (payments and expenses) to the existing system roles that
-- receive them in the role templates: finance.view to owner, administrator, accountant and manager;
-- finance.manage to owner, administrator and accountant. New companies get them from the templates.
-- Idempotent: the keys are created if `pnpm db:seed` has not run yet, existing grants are left
-- alone, and custom (non-system) roles are not changed.
INSERT INTO "permissions" ("key") VALUES ('finance.view'), ('finance.manage') ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_key")
SELECT "id", 'finance.view' FROM "roles"
WHERE "is_system" AND "key" IN ('owner', 'administrator', 'accountant', 'manager')
ON CONFLICT ("role_id", "permission_key") DO NOTHING;--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_key")
SELECT "id", 'finance.manage' FROM "roles"
WHERE "is_system" AND "key" IN ('owner', 'administrator', 'accountant')
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
