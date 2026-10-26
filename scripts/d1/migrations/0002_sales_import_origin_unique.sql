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
