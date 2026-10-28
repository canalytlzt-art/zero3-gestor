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
  source_sheet TEXT CHECK (source_sheet IS NULL OR length(source_sheet) BETWEEN 1 AND 255),
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
