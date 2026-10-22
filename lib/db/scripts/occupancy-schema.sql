CREATE TABLE IF NOT EXISTS occupancy_modalities (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  normalized_name text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT occupancy_modalities_name_valid CHECK (length(btrim(name)) BETWEEN 1 AND 120 AND length(btrim(normalized_name)) > 0),
  CONSTRAINT occupancy_modalities_version_valid CHECK (version > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS occupancy_modalities_name_unique ON occupancy_modalities(normalized_name);
CREATE TABLE IF NOT EXISTS occupancy_records (
  id uuid PRIMARY KEY,
  modality_id uuid NOT NULL REFERENCES occupancy_modalities(id) ON DELETE RESTRICT,
  kind text NOT NULL,
  date date,
  month text NOT NULL,
  percentage numeric NOT NULL,
  class_name text,
  scope_key text NOT NULL DEFAULT '',
  notes text,
  source_file_hash text,
  source_sheet text,
  source_cell text,
  source_cells jsonb,
  version integer NOT NULL DEFAULT 1,
  created_by text NOT NULL,
  updated_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT occupancy_percentage_valid CHECK (percentage >= 0 AND percentage <= 100 AND percentage <> 'NaN'::numeric),
  CONSTRAINT occupancy_period_valid CHECK (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$' AND left(month,4) <> '0000' AND ((kind = 'daily' AND date IS NOT NULL AND month = to_char(date,'YYYY-MM')) OR (kind = 'monthly' AND date IS NULL))),
  CONSTRAINT occupancy_record_version_valid CHECK (version > 0),
  CONSTRAINT occupancy_record_text_valid CHECK (coalesce(length(class_name),0) <= 120 AND coalesce(length(notes),0) <= 1000)
);
ALTER TABLE occupancy_records ADD COLUMN IF NOT EXISTS source_file_hash text;
ALTER TABLE occupancy_records ADD COLUMN IF NOT EXISTS source_sheet text;
ALTER TABLE occupancy_records ADD COLUMN IF NOT EXISTS source_cell text;
ALTER TABLE occupancy_records ADD COLUMN IF NOT EXISTS source_cells jsonb;
DO $$ BEGIN
  ALTER TABLE occupancy_records ADD CONSTRAINT occupancy_record_source_valid CHECK (
    (source_file_hash IS NULL AND source_sheet IS NULL AND source_cell IS NULL AND source_cells IS NULL)
    OR (source_file_hash ~ '^[a-f0-9]{64}$' AND length(btrim(source_sheet)) BETWEEN 1 AND 120
      AND source_cell ~ '^[A-Z]{1,4}[1-9][0-9]*$' AND jsonb_typeof(source_cells) = 'object')
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS occupancy_records_source_cell_unique
  ON occupancy_records(source_file_hash, source_sheet, source_cell)
  WHERE deleted_at IS NULL AND source_file_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS occupancy_records_scope_unique ON occupancy_records(modality_id,kind,month,coalesce(date,'0001-01-01'::date),scope_key) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS occupancy_records_month_idx ON occupancy_records(month,modality_id);
CREATE TABLE IF NOT EXISTS occupancy_history (
  id uuid PRIMARY KEY,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  operation text NOT NULL,
  actor_id text NOT NULL,
  before_data jsonb,
  after_data jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
