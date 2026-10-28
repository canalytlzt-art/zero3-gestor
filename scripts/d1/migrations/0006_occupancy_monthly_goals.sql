CREATE TABLE occupancy_monthly_goals (
  month TEXT NOT NULL
    CHECK (
      length(month) = 7
      AND substr(month, 1, 4) GLOB '[0-9][0-9][0-9][0-9]'
      AND substr(month, 5, 1) = '-'
      AND CAST(substr(month, 6, 2) AS INTEGER) BETWEEN 1 AND 12
      AND substr(month, 6, 2) GLOB '[0-9][0-9]'
      AND substr(month, 1, 4) <> '0000'
    ),
  scope_key TEXT NOT NULL,
  modality_id TEXT,
  modality_name TEXT,
  aggregator_target_presences INTEGER
    CHECK (aggregator_target_presences IS NULL OR (typeof(aggregator_target_presences) = 'integer' AND aggregator_target_presences >= 0)),
  occupancy_target_percentage REAL
    CHECK (occupancy_target_percentage IS NULL OR (typeof(occupancy_target_percentage) IN ('integer', 'real') AND occupancy_target_percentage >= 0)),
  notes TEXT CHECK (notes IS NULL OR length(notes) <= 1000),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (month, scope_key),
  CHECK (
    (modality_id IS NULL AND scope_key = 'all' AND modality_name IS NULL)
    OR (modality_id IS NOT NULL AND scope_key = modality_id AND modality_name IS NOT NULL AND length(trim(modality_name)) > 0)
  ),
  CHECK (aggregator_target_presences IS NOT NULL OR occupancy_target_percentage IS NOT NULL)
);

CREATE INDEX occupancy_monthly_goals_modality_month_idx
  ON occupancy_monthly_goals(modality_id, month);
