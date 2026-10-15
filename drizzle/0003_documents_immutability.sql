-- Issued documents are immutable. Corrections are new documents (credit notes / replacements)
-- linked to the original. These triggers enforce that at the database level, independent of
-- application code.

CREATE OR REPLACE FUNCTION documents_guard_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'issued' THEN
      RAISE EXCEPTION 'issued document % cannot be deleted', OLD.id USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN OLD;
  END IF;

  -- UPDATE
  IF OLD.status = 'issued' THEN
    RAISE EXCEPTION 'issued document % cannot be modified', OLD.id USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.company_id <> OLD.company_id OR NEW.type <> OLD.type THEN
    RAISE EXCEPTION 'document company and type cannot change' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER documents_guard_mutation
  BEFORE UPDATE OR DELETE ON documents
  FOR EACH ROW EXECUTE FUNCTION documents_guard_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION documents_guard_issue_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Documents are created as drafts and issued through an UPDATE, except imported historical
  -- documents, which keep their original number.
  IF NEW.status = 'issued' AND NEW.origin <> 'imported' THEN
    RAISE EXCEPTION 'documents must be created as drafts' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER documents_guard_issue_insert
  BEFORE INSERT ON documents
  FOR EACH ROW EXECUTE FUNCTION documents_guard_issue_insert();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION document_lines_guard_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parent_status document_status;
  parent_id uuid;
BEGIN
  parent_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.document_id ELSE NEW.document_id END;
  SELECT status INTO parent_status FROM documents WHERE id = parent_id;
  -- parent_status is NULL while a draft is being deleted (cascade); allow that.
  IF parent_status = 'issued' THEN
    RAISE EXCEPTION 'lines of issued document % cannot be changed', parent_id USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.document_id <> OLD.document_id OR NEW.company_id <> OLD.company_id) THEN
    RAISE EXCEPTION 'line cannot move between documents' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER document_lines_guard_mutation
  BEFORE INSERT OR UPDATE OR DELETE ON document_lines
  FOR EACH ROW EXECUTE FUNCTION document_lines_guard_mutation();
