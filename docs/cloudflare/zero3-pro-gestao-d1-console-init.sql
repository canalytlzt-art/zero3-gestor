-- ZERO3 PRO GESTAO - D1 console initialization
-- Target expected: zero3-pro-gestao-db
-- Source of schema: scripts/d1/migrations/0001_zero3_schema.sql
--                   scripts/d1/migrations/0002_sales_import_origin_unique.sql
-- This script creates schema only. It does not import historical data.
-- Run the blocks in order in the Cloudflare D1 Console.

-- BLOCK 0 - PREFLIGHT (read-only)
-- Expected on an uninitialized application database: zero rows.
-- Stop if any application table or d1_migrations already exists.
SELECT name
FROM sqlite_schema
WHERE type = 'table'
  AND name IN (
    'd1_migrations',
    'idempotency_keys',
    'occupancy_modalities',
    'products',
    'sales',
    'sales_goals',
    'sales_refunds',
    'sales_history',
    'sales_import_batches',
    'occupancy_records',
    'occupancy_history'
  )
ORDER BY name;

-- BLOCK 1 - WRANGLER MIGRATION TRACKING TABLE
-- Exact table definition used by Wrangler 4.152.0.
CREATE TABLE IF NOT EXISTS d1_migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- BLOCK 2 - MIGRATION 0001_zero3_schema.sql
CREATE TABLE IF NOT EXISTS idempotency_keys (
  id TEXT PRIMARY KEY NOT NULL,
  actor_id TEXT NOT NULL CHECK (length(trim(actor_id)) > 0),
  operation TEXT NOT NULL CHECK (length(trim(operation)) > 0),
  key TEXT NOT NULL CHECK (length(trim(key)) > 0),
  request_hash TEXT NOT NULL CHECK (
    length(request_hash) = 64 AND request_hash NOT GLOB '*[^a-f0-9]*'
  ),
  response_payload TEXT CHECK (response_payload IS NULL OR json_valid(response_payload)),
  resource_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (actor_id, operation, key)
);
CREATE INDEX IF NOT EXISTS idempotency_actor_created_at_idx
  ON idempotency_keys(actor_id, created_at);

CREATE TABLE IF NOT EXISTS occupancy_modalities (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  normalized_name TEXT NOT NULL CHECK (length(trim(normalized_name)) > 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (normalized_name)
);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  normalized_name TEXT NOT NULL CHECK (length(trim(normalized_name)) > 0),
  modality_id TEXT REFERENCES occupancy_modalities(id) ON DELETE SET NULL,
  suggested_price_cents INTEGER NOT NULL DEFAULT 0
    CHECK (suggested_price_cents >= 0 AND suggested_price_cents <= 9007199254740991),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (normalized_name)
);
CREATE INDEX IF NOT EXISTS products_active_name_idx ON products(is_active, normalized_name);
CREATE INDEX IF NOT EXISTS products_modality_id_idx ON products(modality_id);

CREATE TABLE IF NOT EXISTS sales (
  id TEXT PRIMARY KEY NOT NULL,
  product_id TEXT REFERENCES products(id) ON DELETE RESTRICT,
  sale_date TEXT NOT NULL CHECK (date(sale_date) IS NOT NULL AND length(sale_date) = 10),
  product_name TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_amount_cents INTEGER NOT NULL
    CHECK (unit_amount_cents >= 0 AND unit_amount_cents <= 9007199254740991),
  total_cents INTEGER NOT NULL
    CHECK (total_cents >= 0 AND total_cents <= 9007199254740991),
  customer_name TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  cancellation_reason TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by TEXT,
  updated_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (total_cents = quantity * unit_amount_cents),
  CHECK (
    (status = 'active' AND cancellation_reason IS NULL)
    OR (status = 'cancelled' AND length(trim(coalesce(cancellation_reason, ''))) > 0)
  )
);
CREATE INDEX IF NOT EXISTS sales_date_status_idx ON sales(sale_date, status);
CREATE INDEX IF NOT EXISTS sales_product_status_idx ON sales(product_id, status);

CREATE TABLE IF NOT EXISTS sales_goals (
  id TEXT PRIMARY KEY NOT NULL,
  month TEXT NOT NULL CHECK (
    length(month) = 7 AND month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'
    AND substr(month, 6, 2) BETWEEN '01' AND '12'
  ),
  scope_key TEXT NOT NULL,
  product_id TEXT REFERENCES products(id) ON DELETE RESTRICT,
  product_name TEXT,
  target_cents INTEGER NOT NULL
    CHECK (target_cents > 0 AND target_cents <= 9007199254740991),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at TEXT NOT NULL,
  UNIQUE (month, scope_key),
  CHECK (
    (product_id IS NULL AND product_name IS NULL AND scope_key = 'all-plans')
    OR (product_id IS NOT NULL AND product_name IS NOT NULL AND scope_key = 'product:' || product_id)
  )
);
CREATE INDEX IF NOT EXISTS sales_goals_product_month_idx ON sales_goals(product_id, month);

CREATE TABLE IF NOT EXISTS sales_refunds (
  id TEXT PRIMARY KEY NOT NULL,
  sale_id TEXT NOT NULL REFERENCES sales(id) ON DELETE RESTRICT,
  refund_date TEXT NOT NULL CHECK (date(refund_date) IS NOT NULL AND length(refund_date) = 10),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0 AND amount_cents <= 9007199254740991),
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'voided')),
  void_reason TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by TEXT,
  updated_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (status = 'active' AND void_reason IS NULL)
    OR (status = 'voided' AND length(trim(coalesce(void_reason, ''))) > 0)
  )
);
CREATE INDEX IF NOT EXISTS sales_refunds_sale_status_idx ON sales_refunds(sale_id, status);
CREATE INDEX IF NOT EXISTS sales_refunds_date_status_idx ON sales_refunds(refund_date, status);

CREATE TABLE IF NOT EXISTS sales_history (
  id TEXT PRIMARY KEY NOT NULL,
  entity_type TEXT NOT NULL CHECK (length(trim(entity_type)) > 0),
  entity_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (length(trim(operation)) > 0),
  actor_id TEXT NOT NULL,
  before_data TEXT CHECK (before_data IS NULL OR json_valid(before_data)),
  after_data TEXT CHECK (after_data IS NULL OR json_valid(after_data)),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sales_history_entity_idx
  ON sales_history(entity_type, entity_id, created_at);
CREATE INDEX IF NOT EXISTS sales_history_created_at_idx ON sales_history(created_at);

CREATE TABLE IF NOT EXISTS sales_import_batches (
  id TEXT PRIMARY KEY NOT NULL,
  actor_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (length(trim(source)) > 0),
  file_hash TEXT NOT NULL CHECK (
    length(file_hash) = 64 AND file_hash NOT GLOB '*[^a-f0-9]*'
  ),
  status TEXT NOT NULL DEFAULT 'previewed' CHECK (status IN ('previewed', 'completed', 'failed')),
  row_count INTEGER NOT NULL DEFAULT 0 CHECK (row_count >= 0),
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (actor_id, source, file_hash)
);
CREATE INDEX IF NOT EXISTS sales_import_actor_created_at_idx
  ON sales_import_batches(actor_id, created_at);

CREATE TABLE IF NOT EXISTS occupancy_records (
  id TEXT PRIMARY KEY NOT NULL,
  modality_id TEXT NOT NULL REFERENCES occupancy_modalities(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('daily', 'monthly')),
  date TEXT CHECK (date IS NULL OR (date(date) IS NOT NULL AND length(date) = 10)),
  month TEXT NOT NULL CHECK (
    length(month) = 7 AND month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'
    AND substr(month, 6, 2) BETWEEN '01' AND '12'
  ),
  percentage TEXT NOT NULL,
  reported_percentage TEXT,
  presences INTEGER CHECK (presences IS NULL OR presences >= 0),
  capacity INTEGER CHECK (capacity IS NULL OR capacity > 0),
  start_time TEXT,
  end_time TEXT,
  class_name TEXT,
  scope_key TEXT NOT NULL DEFAULT '',
  notes TEXT,
  source_file_hash TEXT,
  source_sheet TEXT,
  source_cell TEXT,
  source_cells TEXT CHECK (source_cells IS NULL OR json_valid(source_cells)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  CHECK (
    (kind = 'daily' AND date IS NOT NULL AND month = substr(date, 1, 7))
    OR (kind = 'monthly' AND date IS NULL)
  ),
  CHECK (
    (presences IS NULL AND capacity IS NULL AND start_time IS NULL AND end_time IS NULL)
    OR (kind = 'daily' AND date IS NOT NULL AND presences IS NOT NULL
      AND capacity IS NOT NULL AND capacity > 0 AND start_time IS NOT NULL)
  ),
  CHECK (reported_percentage IS NULL OR (presences IS NOT NULL AND capacity IS NOT NULL)),
  CHECK (length(coalesce(class_name, '')) <= 120 AND length(coalesce(notes, '')) <= 1000),
  CHECK (
    (source_file_hash IS NULL AND source_sheet IS NULL AND source_cell IS NULL AND source_cells IS NULL)
    OR (
      length(source_file_hash) = 64 AND source_file_hash NOT GLOB '*[^a-f0-9]*'
      AND length(trim(source_sheet)) BETWEEN 1 AND 120
      AND source_cell NOT GLOB '*[^A-Z0-9]*' AND source_cell GLOB '[A-Z]*[1-9]*'
      AND json_valid(source_cells) AND json_type(source_cells) = 'object'
    )
  )
);
CREATE INDEX IF NOT EXISTS occupancy_records_month_idx ON occupancy_records(month, modality_id);
CREATE UNIQUE INDEX IF NOT EXISTS occupancy_records_scope_unique
  ON occupancy_records(
    modality_id, kind, month, coalesce(date, '0001-01-01'),
    scope_key, coalesce(start_time, '00:00:00')
  ) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS occupancy_records_source_cell_unique
  ON occupancy_records(source_file_hash, source_sheet, source_cell)
  WHERE deleted_at IS NULL AND source_file_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS occupancy_history (
  id TEXT PRIMARY KEY NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  before_data TEXT CHECK (before_data IS NULL OR json_valid(before_data)),
  after_data TEXT CHECK (after_data IS NULL OR json_valid(after_data)),
  created_at TEXT NOT NULL
);

-- Record the exact filename Wrangler uses to prevent a future re-apply.
INSERT INTO d1_migrations (name)
SELECT '0001_zero3_schema.sql'
WHERE NOT EXISTS (
  SELECT 1 FROM d1_migrations WHERE name = '0001_zero3_schema.sql'
);

-- BLOCK 3 - MIGRATION 0002_sales_import_origin_unique.sql
CREATE UNIQUE INDEX IF NOT EXISTS sales_history_import_origin_unique
  ON sales_history(
    json_extract(after_data, '$.sourceFileHash'),
    json_extract(after_data, '$.sourceSheet'),
    json_extract(after_data, '$.sourceRow')
  )
  WHERE entity_type = 'sale'
    AND operation = 'import'
    AND after_data IS NOT NULL
    AND json_valid(after_data);

-- Record the exact filename Wrangler uses to prevent a future re-apply.
INSERT INTO d1_migrations (name)
SELECT '0002_sales_import_origin_unique.sql'
WHERE NOT EXISTS (
  SELECT 1 FROM d1_migrations WHERE name = '0002_sales_import_origin_unique.sql'
);

-- BLOCK 4 - POSTFLIGHT (read-only)
-- Expected migration records: both filenames above.
SELECT id, name, applied_at
FROM d1_migrations
ORDER BY id;

-- Expected application tables: exactly these ten names.
SELECT name
FROM sqlite_schema
WHERE type = 'table'
  AND name IN (
    'idempotency_keys',
    'occupancy_modalities',
    'products',
    'sales',
    'sales_goals',
    'sales_refunds',
    'sales_history',
    'sales_import_batches',
    'occupancy_records',
    'occupancy_history'
  )
ORDER BY name;

-- Expected application indexes: 15 names, including the import-origin unique index.
SELECT name
FROM sqlite_schema
WHERE type = 'index'
  AND name IN (
    'idempotency_actor_created_at_idx',
    'products_active_name_idx',
    'products_modality_id_idx',
    'sales_date_status_idx',
    'sales_product_status_idx',
    'sales_goals_product_month_idx',
    'sales_refunds_sale_status_idx',
    'sales_refunds_date_status_idx',
    'sales_history_entity_idx',
    'sales_history_created_at_idx',
    'sales_import_actor_created_at_idx',
    'occupancy_records_month_idx',
    'occupancy_records_scope_unique',
    'occupancy_records_source_cell_unique',
    'sales_history_import_origin_unique'
  )
ORDER BY name;

-- All these counts should be zero immediately after schema-only initialization.
SELECT COUNT(*) AS sales_rows FROM sales;
SELECT COUNT(*) AS sales_refund_rows FROM sales_refunds;
SELECT COUNT(*) AS sales_goal_rows FROM sales_goals;
SELECT COUNT(*) AS product_rows FROM products;
SELECT COUNT(*) AS occupancy_modality_rows FROM occupancy_modalities;
SELECT COUNT(*) AS occupancy_record_rows FROM occupancy_records;
SELECT COUNT(*) AS sales_history_rows FROM sales_history;
SELECT COUNT(*) AS occupancy_history_rows FROM occupancy_history;
SELECT COUNT(*) AS sales_import_batch_rows FROM sales_import_batches;
SELECT COUNT(*) AS idempotency_key_rows FROM idempotency_keys;

-- Expected: no rows (no foreign-key violations).
PRAGMA foreign_key_check;
