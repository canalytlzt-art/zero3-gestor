-- ZERO3 PRO GESTAO — migrações aditivas 0003–0007 para revisão no Console D1
-- Banco esperado: zero3-pro-gestao-db
--
-- Segurança:
--   * Este arquivo NÃO deve ser executado como uma única submissão.
--   * Rode o preflight e confira os resultados antes de continuar.
--   * Rode cada bloco de migração separadamente.
--   * Só rode o bloco "REGISTRAR" depois que todas as instruções da migração
--     correspondente terminarem sem erro e a verificação indicada passar.
--   * Se qualquer registro 0003–0007 já existir em d1_migrations, PARE e
--     confira o esquema; não reaplique ALTER TABLE.
--   * Nenhuma instrução apaga ou atualiza registros existentes.

-- BLOCO 0 — PREFLIGHT (somente leitura)
-- Esperado: 0001 e 0002 registradas; nenhuma das 0003–0007 registrada.
SELECT id, name, applied_at
FROM d1_migrations
WHERE name IN (
  '0001_zero3_schema.sql',
  '0002_sales_import_origin_unique.sql',
  '0003_sales_pending_drafts.sql',
  '0004_occupancy_aggregator_presences.sql',
  '0005_active_contracts_monthly.sql',
  '0006_occupancy_monthly_goals.sql',
  '0007_sales_modality_link.sql'
)
ORDER BY id;

-- Esperado: as quatro tabelas-base abaixo existem.
SELECT name
FROM sqlite_schema
WHERE type = 'table'
  AND name IN (
    'sales',
    'occupancy_records',
    'occupancy_modalities',
    'd1_migrations'
  )
ORDER BY name;

-- Inspecione as colunas-base. Antes das migrações, as colunas novas abaixo
-- devem estar ausentes: aggregator_presences, sales.modality_id e
-- sales.modality_override.
PRAGMA table_info(occupancy_records);
PRAGMA table_info(sales);
PRAGMA table_info(occupancy_modalities);

-- Esperado antes da aplicação: nenhum resultado para estes objetos novos.
SELECT type, name
FROM sqlite_schema
WHERE name IN (
  'sales_pending_drafts',
  'sales_pending_import_origin_unique',
  'sales_pending_status_created_idx',
  'active_contracts_monthly',
  'active_contracts_monthly_updated_at_idx',
  'occupancy_monthly_goals',
  'occupancy_monthly_goals_modality_month_idx',
  'sales_modality_status_idx'
)
ORDER BY type, name;

-- BLOCO 1 — MIGRAÇÃO 0003_sales_pending_drafts.sql
CREATE TABLE IF NOT EXISTS sales_pending_drafts (
  id TEXT PRIMARY KEY NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'completed')),
  customer_name TEXT CHECK (customer_name IS NULL OR length(customer_name) <= 1000),
  sale_date TEXT CHECK (
    sale_date IS NULL OR (date(sale_date) IS NOT NULL AND length(sale_date) = 10)
  ),
  sale_date_text TEXT CHECK (sale_date_text IS NULL OR length(sale_date_text) <= 200),
  product_name TEXT CHECK (product_name IS NULL OR length(product_name) <= 500),
  total_cents INTEGER CHECK (
    total_cents IS NULL OR (total_cents >= 0 AND total_cents <= 9007199254740991)
  ),
  amount_text TEXT CHECK (amount_text IS NULL OR length(amount_text) <= 120),
  notes TEXT CHECK (notes IS NULL OR length(notes) <= 1000),
  source_file_hash TEXT CHECK (
    source_file_hash IS NULL
    OR (length(source_file_hash) = 64 AND source_file_hash NOT GLOB '*[^a-f0-9]*')
  ),
  source_file_name TEXT CHECK (source_file_name IS NULL OR length(source_file_name) <= 255),
  source_sheet TEXT CHECK (source_sheet IS NULL OR length(source_sheet) <= 255),
  source_row INTEGER CHECK (source_row IS NULL OR source_row > 0),
  linked_sale_id TEXT REFERENCES sales(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (source_file_hash IS NULL AND source_file_name IS NULL AND source_sheet IS NULL AND source_row IS NULL)
    OR
    (source_file_hash IS NOT NULL AND source_file_name IS NOT NULL AND source_sheet IS NOT NULL AND source_row IS NOT NULL)
  ),
  CHECK (
    (status = 'pending' AND linked_sale_id IS NULL)
    OR (status = 'completed' AND linked_sale_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS sales_pending_import_origin_unique
  ON sales_pending_drafts(source_file_hash, source_sheet, source_row)
  WHERE source_file_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS sales_pending_status_created_idx
  ON sales_pending_drafts(status, created_at);

-- Verifique que a tabela e os dois índices existem; só então rode BLOCO 1R.
SELECT type, name
FROM sqlite_schema
WHERE name IN (
  'sales_pending_drafts',
  'sales_pending_import_origin_unique',
  'sales_pending_status_created_idx'
)
ORDER BY type, name;

-- BLOCO 1R — REGISTRAR 0003 (rodar somente após BLOCO 1 concluir com sucesso)
INSERT INTO d1_migrations (name)
SELECT '0003_sales_pending_drafts.sql'
WHERE NOT EXISTS (
  SELECT 1 FROM d1_migrations WHERE name = '0003_sales_pending_drafts.sql'
);

-- BLOCO 2 — MIGRAÇÃO 0004_occupancy_aggregator_presences.sql
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

-- Verifique aggregator_presences em PRAGMA table_info(occupancy_records);
-- só então rode BLOCO 2R.

-- BLOCO 2R — REGISTRAR 0004 (rodar somente após BLOCO 2 concluir com sucesso)
INSERT INTO d1_migrations (name)
SELECT '0004_occupancy_aggregator_presences.sql'
WHERE NOT EXISTS (
  SELECT 1 FROM d1_migrations WHERE name = '0004_occupancy_aggregator_presences.sql'
);

-- BLOCO 3 — MIGRAÇÃO 0005_active_contracts_monthly.sql
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

-- Verifique que a tabela e o índice existem; só então rode BLOCO 3R.
SELECT type, name
FROM sqlite_schema
WHERE name IN (
  'active_contracts_monthly',
  'active_contracts_monthly_updated_at_idx'
)
ORDER BY type, name;

-- BLOCO 3R — REGISTRAR 0005 (rodar somente após BLOCO 3 concluir com sucesso)
INSERT INTO d1_migrations (name)
SELECT '0005_active_contracts_monthly.sql'
WHERE NOT EXISTS (
  SELECT 1 FROM d1_migrations WHERE name = '0005_active_contracts_monthly.sql'
);

-- BLOCO 4 — MIGRAÇÃO 0006_occupancy_monthly_goals.sql
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

-- Verifique que a tabela e o índice existem; só então rode BLOCO 4R.
SELECT type, name
FROM sqlite_schema
WHERE name IN (
  'occupancy_monthly_goals',
  'occupancy_monthly_goals_modality_month_idx'
)
ORDER BY type, name;

-- BLOCO 4R — REGISTRAR 0006 (rodar somente após BLOCO 4 concluir com sucesso)
INSERT INTO d1_migrations (name)
SELECT '0006_occupancy_monthly_goals.sql'
WHERE NOT EXISTS (
  SELECT 1 FROM d1_migrations WHERE name = '0006_occupancy_monthly_goals.sql'
);

-- BLOCO 5 — MIGRAÇÃO 0007_sales_modality_link.sql
ALTER TABLE sales
  ADD COLUMN modality_id TEXT
  REFERENCES occupancy_modalities(id) ON DELETE SET NULL;

ALTER TABLE sales
  ADD COLUMN modality_override INTEGER NOT NULL DEFAULT 0
  CHECK (modality_override IN (0, 1));

CREATE INDEX IF NOT EXISTS sales_modality_status_idx
  ON sales(modality_id, status);

-- Verifique modality_id e modality_override em PRAGMA table_info(sales),
-- e o índice abaixo; só então rode BLOCO 5R.
SELECT type, name
FROM sqlite_schema
WHERE name = 'sales_modality_status_idx';

-- BLOCO 5R — REGISTRAR 0007 (rodar somente após BLOCO 5 concluir com sucesso)
INSERT INTO d1_migrations (name)
SELECT '0007_sales_modality_link.sql'
WHERE NOT EXISTS (
  SELECT 1 FROM d1_migrations WHERE name = '0007_sales_modality_link.sql'
);

-- BLOCO FINAL — VERIFICAÇÃO (somente leitura)
SELECT id, name, applied_at
FROM d1_migrations
WHERE name IN (
  '0003_sales_pending_drafts.sql',
  '0004_occupancy_aggregator_presences.sql',
  '0005_active_contracts_monthly.sql',
  '0006_occupancy_monthly_goals.sql',
  '0007_sales_modality_link.sql'
)
ORDER BY id;

SELECT type, name
FROM sqlite_schema
WHERE name IN (
  'sales_pending_drafts',
  'sales_pending_import_origin_unique',
  'sales_pending_status_created_idx',
  'active_contracts_monthly',
  'active_contracts_monthly_updated_at_idx',
  'occupancy_monthly_goals',
  'occupancy_monthly_goals_modality_month_idx',
  'sales_modality_status_idx'
)
ORDER BY type, name;

PRAGMA table_info(occupancy_records);
PRAGMA table_info(sales);
PRAGMA foreign_key_check;
