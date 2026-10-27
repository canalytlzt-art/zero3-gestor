import * as XLSX from 'xlsx';

const formulaLikeText = /^[\u0000-\u0020]*[=+\-@]/;

export function protectSpreadsheetCsvText(value: string): string {
  return formulaLikeText.test(value) ? `'${value}` : value;
}

export function protectWorksheetForCsv(worksheet: XLSX.WorkSheet): XLSX.WorkSheet {
  const protectedWorksheet: XLSX.WorkSheet = { ...worksheet };
  if (!worksheet['!ref']) return protectedWorksheet;

  const range = XLSX.utils.decode_range(worksheet['!ref']);
  for (let row = range.s.r; row <= range.e.r; row += 1) {
    for (let column = range.s.c; column <= range.e.c; column += 1) {
      const address = XLSX.utils.encode_cell({ r: row, c: column });
      const cell = worksheet[address];
      if ((cell?.t !== 's' && cell?.t !== 'str') || typeof cell.v !== 'string') continue;
      const safeText = protectSpreadsheetCsvText(cell.v);
      if (safeText === cell.v) continue;
      const safeCell = { ...cell, t: 's' as const, v: safeText };
      delete safeCell.f;
      protectedWorksheet[address] = safeCell;
    }
  }
  return protectedWorksheet;
}
