-- Two-way sync between users.email_verified (auth library) and users.email_verified_at (stage 1).
-- 0006 treated email_verified as the only source, so an UPDATE that set just email_verified_at
-- was silently reverted. Whichever column a statement changes now wins; on INSERT a timestamp
-- implies verified. Function body only — the trigger from 0006 keeps pointing at it.
CREATE OR REPLACE FUNCTION users_sync_email_verified_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.email_verified_at IS NOT NULL THEN
      NEW.email_verified := true;
    ELSIF NEW.email_verified THEN
      NEW.email_verified_at := now();
    END IF;
  ELSIF NEW.email_verified IS DISTINCT FROM OLD.email_verified THEN
    IF NEW.email_verified THEN
      NEW.email_verified_at := COALESCE(NEW.email_verified_at, now());
    ELSE
      NEW.email_verified_at := NULL;
    END IF;
  ELSIF NEW.email_verified_at IS DISTINCT FROM OLD.email_verified_at THEN
    NEW.email_verified := NEW.email_verified_at IS NOT NULL;
  END IF;
  RETURN NEW;
END;
$$;
