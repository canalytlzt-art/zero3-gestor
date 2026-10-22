import * as XLSX from "xlsx";

export type ImportSourceCell = {
  address: string;
  column: number;
  value: unknown;
  type: string;
  format: string;
  formatted: string;
  formula?: string;
  hiddenColumn: boolean;
};

export type ImportSourceRow = {
  sourceRow: number;
  cells: unknown[];
  sourceCells: ImportSourceCell[];
  hidden: boolean;
  inFilterRange: boolean;
};

export function isDateCellFormat(format: string): boolean {
  return /[dy]/i.test(format.replace(/"[^"]*"|\\./g, ""));
}

export function readImportSource(bytes: ArrayBuffer, extension: string) {
  let input: ArrayBuffer | string = bytes;
  if (extension === "csv") {
    try {
      input = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      input = new TextDecoder("windows-1252").decode(bytes);
    }
  }
  const workbook = XLSX.read(input, {
    type: typeof input === "string" ? "string" : "array",
    raw: true, cellDates: false, cellNF: true, cellFormula: true,
    cellStyles: true, sheetStubs: true,
  });
  const date1904 = workbook.Workbook?.WBProps?.date1904 === true;
  return workbook.SheetNames.map((name, index) => {
    const worksheet = workbook.Sheets[name];
    const entries = Object.entries(worksheet ?? {})
      .filter(([address]) => /^[A-Z]+[1-9]\d*$/.test(address))
      .map(([address, cell]) => ({ address, cell: cell as XLSX.CellObject, position: XLSX.utils.decode_cell(address) }));
    const range = worksheet?.["!ref"] ? XLSX.utils.decode_range(worksheet["!ref"]) : null;
    const lastRow = entries.reduce((maximum, { position }) => Math.max(maximum, position.r), range?.e.r ?? -1);
    const width = entries.reduce((maximum, { position }) => Math.max(maximum, position.c + 1), (range?.e.c ?? -1) + 1);
    // Keep physical coordinates, including holes and styled/empty cells.
    const rows: ImportSourceRow[] = Array.from({ length: lastRow + 1 }, (_, row) => ({
      sourceRow: row + 1, cells: Array(width).fill(""), sourceCells: [],
      hidden: worksheet?.["!rows"]?.[row]?.hidden === true,
      inFilterRange: false,
    }));
    const filterRange = worksheet?.["!autofilter"]?.ref;
    if (filterRange) {
      const filter = XLSX.utils.decode_range(filterRange);
      for (const row of rows) row.inFilterRange = row.sourceRow > filter.s.r && row.sourceRow <= filter.e.r + 1;
    }
    for (const { address, cell, position } of entries) {
      // SheetJS represents a formula without a cached value as t:"z", v:0.
      // That placeholder is not a calculated monetary zero.
      const value = cell.t === "z" ? "" : cell.t === "e" ? cell.w || `Erro Excel ${cell.v}` : cell.v ?? "";
      rows[position.r].cells[position.c] = value;
      rows[position.r].sourceCells.push({
        address, column: position.c, value, type: cell.t || "z",
        format: String(cell.z ?? ""), formatted: cell.w || "",
        ...(cell.f ? { formula: cell.f } : {}),
        hiddenColumn: worksheet?.["!cols"]?.[position.c]?.hidden === true,
      });
    }
    return {
      name, rows, width, date1904,
      hidden: Boolean(workbook.Workbook?.Sheets?.[index]?.Hidden),
      filterRange: filterRange ?? null,
    };
  });
}
