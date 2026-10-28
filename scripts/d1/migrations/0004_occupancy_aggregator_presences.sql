ALTER TABLE occupancy_records
  ADD COLUMN aggregator_presences INTEGER
  CHECK (
    aggregator_presences IS NULL
    OR (
      aggregator_presences >= 0
      AND presences IS NOT NULL
      AND aggregator_presences <= presences
    )
  );
