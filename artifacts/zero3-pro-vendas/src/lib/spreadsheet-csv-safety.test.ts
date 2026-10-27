import assert from 'node:assert/strict';
import test from 'node:test';
import * as XLSX from 'xlsx';
import {
  protectSpreadsheetCsvText,
  protectWorksheetForCsv,
} from './spreadsheet-csv-safety';

test('neutralizes formula-leading text for CSV without changing numeric cells', () => {
  assert.equal(protectSpreadsheetCsvText('=1+1'), "'=1+1");
  assert.equal(protectSpreadsheetCsvText('  @SUM(1,1)'), "'  @SUM(1,1)");
  assert.equal(protectSpreadsheetCsvText('+CMD|example'), "'+CMD|example");
  assert.equal(protectSpreadsheetCsvText('-CMD|example'), "'-CMD|example");
  assert.equal(protectSpreadsheetCsvText('Plano regular'), 'Plano regular');

  const sheet = XLSX.utils.aoa_to_sheet([['=1+1', -250, 'texto normal']]);
  const protectedSheet = protectWorksheetForCsv(sheet);
  assert.equal(protectedSheet.A1?.v, "'=1+1");
  assert.equal(protectedSheet.B1?.v, -250);
  assert.equal(protectedSheet.B1?.t, 'n');
  assert.equal(protectedSheet.C1?.v, 'texto normal');
});
