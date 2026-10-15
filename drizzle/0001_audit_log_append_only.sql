-- Audit logs are append-only: any UPDATE or DELETE raises an error.
-- Companies and users referenced by audit logs therefore cannot be hard-deleted
-- (FKs are ON DELETE RESTRICT); they are archived/disabled instead.
-- Retention/erasure (e.g. GDPR pseudonymisation) will be handled by a dedicated,
-- audited maintenance procedure in a later stage.
CREATE OR REPLACE FUNCTION audit_logs_prevent_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only (% not allowed)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER audit_logs_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_prevent_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_logs_no_truncate
  BEFORE TRUNCATE ON audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_prevent_mutation();
