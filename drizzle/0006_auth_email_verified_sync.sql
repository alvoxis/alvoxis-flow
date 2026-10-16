-- Backfill the boolean required by the auth library from the existing timestamp.
UPDATE users SET email_verified = true WHERE email_verified_at IS NOT NULL;
--> statement-breakpoint
-- Keep email_verified_at (audit-friendly) consistent with email_verified, whoever updates it.
CREATE OR REPLACE FUNCTION users_sync_email_verified_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.email_verified AND NEW.email_verified_at IS NULL THEN
    NEW.email_verified_at := now();
  ELSIF NOT NEW.email_verified THEN
    NEW.email_verified_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER users_sync_email_verified_at
  BEFORE INSERT OR UPDATE OF email_verified, email_verified_at ON users
  FOR EACH ROW EXECUTE FUNCTION users_sync_email_verified_at();
