CREATE TABLE occupancy_aggregator_adjustments (
  id TEXT PRIMARY KEY NOT NULL,
  month TEXT NOT NULL CHECK (
    length(month) = 7
    AND month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'
    AND substr(month, 6, 2) BETWEEN '01' AND '12'
  ),
  scope_key TEXT NOT NULL,
  modality_id TEXT,
  modality_name TEXT,
  target_presences INTEGER NOT NULL CHECK (
    target_presences >= 0 AND target_presences <= 2147483647
  ),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  operation_token TEXT NOT NULL,
  deleted_by TEXT,
  deleted_at TEXT,
  UNIQUE (month, scope_key),
  CHECK (
    (scope_key = 'all' AND modality_id IS NULL AND modality_name IS NULL)
    OR (scope_key <> 'all' AND modality_id IS NOT NULL AND modality_name IS NOT NULL)
  )
);

CREATE INDEX occupancy_aggregator_adjustments_month_idx
  ON occupancy_aggregator_adjustments(month, deleted_at, scope_key);

ALTER TABLE occupancy_records
  ADD COLUMN aggregator_origin TEXT
  CHECK (aggregator_origin IS NULL OR aggregator_origin = 'monthly_estimated');

ALTER TABLE occupancy_records
  ADD COLUMN aggregator_adjustment_id TEXT
  REFERENCES occupancy_aggregator_adjustments(id) ON DELETE SET NULL;

CREATE INDEX occupancy_records_aggregator_adjustment_idx
  ON occupancy_records(aggregator_adjustment_id)
  WHERE aggregator_adjustment_id IS NOT NULL;

CREATE TRIGGER occupancy_aggregator_adjustment_scope_insert
BEFORE INSERT ON occupancy_aggregator_adjustments
WHEN NEW.deleted_at IS NULL
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM occupancy_aggregator_adjustments existing
    WHERE existing.month = NEW.month
      AND existing.deleted_at IS NULL
      AND existing.scope_key <> NEW.scope_key
      AND (
        existing.scope_key = 'all'
        OR NEW.scope_key = 'all'
        OR existing.scope_key = NEW.scope_key
      )
  ) THEN RAISE(ABORT, 'occupancy_aggregator_adjustment_scope_overlap') END;
END;

CREATE TRIGGER occupancy_aggregator_adjustment_scope_update
BEFORE UPDATE ON occupancy_aggregator_adjustments
WHEN NEW.deleted_at IS NULL
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM occupancy_aggregator_adjustments existing
    WHERE existing.month = NEW.month
      AND existing.deleted_at IS NULL
      AND existing.id <> NEW.id
      AND (
        existing.scope_key = 'all'
        OR NEW.scope_key = 'all'
        OR existing.scope_key = NEW.scope_key
      )
  ) THEN RAISE(ABORT, 'occupancy_aggregator_adjustment_scope_overlap') END;
END;
