CREATE TABLE IF NOT EXISTS active_contracts_monthly (
  month TEXT PRIMARY KEY
    CHECK (
      length(month) = 7
      AND substr(month, 1, 4) GLOB '[0-9][0-9][0-9][0-9]'
      AND substr(month, 5, 1) = '-'
      AND CAST(substr(month, 6, 2) AS INTEGER) BETWEEN 1 AND 12
      AND substr(month, 6, 2) GLOB '[0-9][0-9]'
    ),
  active_count INTEGER NOT NULL CHECK (typeof(active_count) = 'integer' AND active_count >= 0),
  target_count INTEGER CHECK (target_count IS NULL OR (typeof(target_count) = 'integer' AND target_count >= 0)),
  notes TEXT CHECK (notes IS NULL OR length(notes) <= 1000),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS active_contracts_monthly_updated_at_idx
  ON active_contracts_monthly(updated_at);
