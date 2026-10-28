ALTER TABLE sales
  ADD COLUMN modality_id TEXT
  REFERENCES occupancy_modalities(id) ON DELETE SET NULL;

ALTER TABLE sales
  ADD COLUMN modality_override INTEGER NOT NULL DEFAULT 0
  CHECK (modality_override IN (0, 1));

CREATE INDEX IF NOT EXISTS sales_modality_status_idx
  ON sales(modality_id, status);
