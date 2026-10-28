-- Additive PostgreSQL schema companion for the optional per-sale modality link.
-- This file is prepared only; do not execute against a shared or production
-- database without explicit approval.
BEGIN;

ALTER TABLE sales
  ADD COLUMN IF NOT EXISTS modality_id uuid;

ALTER TABLE sales
  ADD COLUMN IF NOT EXISTS modality_override boolean NOT NULL DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'sales_modality_id_occupancy_modalities_id_fk'
      AND conrelid = 'sales'::regclass
  ) THEN
    ALTER TABLE sales
      ADD CONSTRAINT sales_modality_id_occupancy_modalities_id_fk
      FOREIGN KEY (modality_id)
      REFERENCES occupancy_modalities(id)
      ON DELETE SET NULL;
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS sales_modality_status_idx
  ON sales(modality_id, status);

COMMIT;
