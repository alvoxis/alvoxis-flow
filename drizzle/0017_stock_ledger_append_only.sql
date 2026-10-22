-- The stock ledger is append-only: any UPDATE, DELETE or TRUNCATE raises an error. Balances are
-- sums of movements, so a changed or removed row would silently change stock history; mistakes
-- are corrected with new movements instead. Companies are archived, never deleted (the company
-- foreign key is ON DELETE RESTRICT).
CREATE OR REPLACE FUNCTION stock_movements_prevent_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'stock_movements is append-only (% not allowed)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER stock_movements_no_update_delete
  BEFORE UPDATE OR DELETE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION stock_movements_prevent_mutation();
--> statement-breakpoint
CREATE TRIGGER stock_movements_no_truncate
  BEFORE TRUNCATE ON stock_movements
  FOR EACH STATEMENT EXECUTE FUNCTION stock_movements_prevent_mutation();
