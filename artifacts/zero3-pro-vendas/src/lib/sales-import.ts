import * as XLSX from "xlsx";

export type SalesImportField =
  | "customerName"
  | "saleDate"
  | "totalAmount"
  | "productName";

export type SalesImportMapping = Record<SalesImportField, number | null>;

export type SalesImportSourceRow = {
  key: string;
  sourceRow: number;
  cells: unknown[];
};

export type SalesImportSheet = {
  name: string;
  hidden: boolean;
  headerRow: number | null;
  columns: Array<{ index: number; label: string }>;
  rows: SalesImportSourceRow[];
  mapping: SalesImportMapping;
  selected: boolean;
  ignoredBlankRows: number;
  ignoredSummaryRows: number;
  date1904: boolean;
};

export type SalesImportWorkbook = {
  sheets: SalesImportSheet[];
};

export type MappedSalesImportRow = {
  key: string;
  sourceSheet: string;
  sourceRow: number;
  customerName: string;
  saleDate: string;
  totalCents: number;
  productName: string | null;
};

export type SalesImportRowResult = {
  value: MappedSalesImportRow | null;
  errors: string[];
  preview: {
    customerName: string;
    saleDate: string;
    totalCents: number | null;
    amountText: string;
    productName: string | null;
  };
};

const emptyMapping = (): SalesImportMapping => ({
  customerName: null,
  saleDate: null,
  totalAmount: null,
  productName: null,
});

function normalizeHeader(value: unknown): string {
  return String(value ?? "")
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function headerMatch(value: unknown, field: SalesImportField): number {
  const header = normalizeHeader(value);
  if (!header) return 0;

  if (field === "customerName") {
    if (/^(nome do cliente|nome cliente|cliente|nome)$/.test(header)) return 3;
    return 0;
  }
  if (field === "saleDate") {
    if (/^(data de inicio|data inicio|dt inicio|inicio)$/.test(header)) return 5;
    if (/^(data da venda|data venda|sale date)$/.test(header)) return 4;
    if (header === "data") return 2;
    return 0;
  }
  if (field === "totalAmount") {
    if (/\b(unitario|parcela|desconto|taxa|comissao|juros|vencimento)\b/.test(header)) return 0;
    if (/^(valor da venda|valor venda|sale value)$/.test(header)) return 5;
    if (/^(valor total|total da venda|total venda|total value)$/.test(header)) return 4;
    if (/^(valor|total)$/.test(header)) return 2;
    return 0;
  }
  if (/^(produto|plano|categoria|product|plan|category)$/.test(header)) return 3;
  return 0;
}

function detectColumn(row: unknown[], field: SalesImportField): number | null {
  const candidates = row
    .map((value, index) => ({ index, rank: headerMatch(value, field) }))
    .filter(({ rank }) => rank > 0);
  if (!candidates.length) return null;
  const highestRank = Math.max(...candidates.map(({ rank }) => rank));
  const best = candidates.filter(({ rank }) => rank === highestRank);
  return best.length === 1 ? best[0].index : null;
}

function isBlankRow(row: unknown[]): boolean {
  return row.every((value) => value === null || value === undefined || String(value).trim() === "");
}

function isSummaryRow(row: unknown[], mapping: SalesImportMapping, date1904: boolean): boolean {
  const firstText = row.find((value) => typeof value === "string" && value.trim()) as string | undefined;
  if (!firstText) return false;
  const normalized = normalizeHeader(firstText);
  const summaryLabel = /^(sub ?total|total|total geral|total do periodo|total final|total de vendas|total vendas|grand total|resumo)$/.test(normalized);
  const hasSaleDate = mapping.saleDate !== null
    && parseImportDate(row[mapping.saleDate], date1904) !== null;
  return summaryLabel && !hasSaleDate;
}

function excelColumnName(index: number): string {
  let number = index + 1;
  let label = "";
  while (number > 0) {
    const remainder = (number - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    number = Math.floor((number - 1) / 26);
  }
  return label;
}

function uniqueColumnLabels(labels: string[]): string[] {
  return labels.map((label, index) => {
    if (labels.indexOf(label) === index) return label;
    return `${label} · coluna ${excelColumnName(index)}`;
  });
}

export async function parseSalesSpreadsheet(
  fileBytes: ArrayBuffer,
  filename: string,
): Promise<SalesImportWorkbook> {
  const extension = filename.split(".").at(-1)?.toLocaleLowerCase("pt-BR");
  if (extension !== "xlsx" && extension !== "csv") {
    throw new Error("Formato não suportado. Selecione um arquivo XLSX ou CSV.");
  }
  if (!fileBytes.byteLength) {
    throw new Error("Arquivo vazio ou não recebido.");
  }

  let workbook: XLSX.WorkBook;
  try {
    if (extension === "csv") {
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(fileBytes);
      } catch {
        text = new TextDecoder("windows-1252").decode(fileBytes);
      }
      workbook = XLSX.read(text, { type: "string", cellDates: false, raw: true });
    } else {
      workbook = XLSX.read(fileBytes, { type: "array", cellDates: false, raw: true });
    }
  } catch {
    throw new Error("Não foi possível ler o arquivo. Verifique se o XLSX ou CSV está íntegro.");
  }
  if (!workbook.SheetNames.length) {
    throw new Error("O arquivo não contém abas ou linhas de dados.");
  }

  const date1904 = workbook.Workbook?.WBProps?.date1904 === true;
  const sheets = workbook.SheetNames.map((name, sheetIndex): SalesImportSheet => {
    const worksheet = workbook.Sheets[name];
    const grid = worksheet
      ? XLSX.utils.sheet_to_json<unknown[]>(worksheet, {
          header: 1,
          raw: true,
          defval: "",
          blankrows: true,
          range: 0,
        }) as unknown[][]
      : [];
    const headerLimit = grid.length;
    let headerRow: number | null = null;
    let bestScore = 0;
    for (let rowIndex = 0; rowIndex < headerLimit; rowIndex += 1) {
      const row = grid[rowIndex] ?? [];
      if (isBlankRow(row)) continue;
      const score = (["customerName", "saleDate", "totalAmount"] as const)
        .filter((field) => detectColumn(row, field) !== null).length;
      if (score > bestScore) {
        bestScore = score;
        headerRow = rowIndex;
      }
      if (score === 3) break;
    }

    const width = grid.reduce((maximum, row) => Math.max(maximum, row.length), 0);
    const rawHeader = headerRow === null ? [] : (grid[headerRow] ?? []);
    const labels = uniqueColumnLabels(Array.from({ length: width }, (_, index) => {
      const value = String(rawHeader[index] ?? "").trim();
      return value || `Coluna ${excelColumnName(index)}`;
    }));
    const mapping = headerRow === null ? emptyMapping() : {
      customerName: detectColumn(rawHeader, "customerName"),
      saleDate: detectColumn(rawHeader, "saleDate"),
      totalAmount: detectColumn(rawHeader, "totalAmount"),
      productName: detectColumn(rawHeader, "productName"),
    };
    const dataStart = headerRow === null ? 0 : headerRow + 1;
    let ignoredBlankRows = 0;
    let ignoredSummaryRows = 0;
    const rows: SalesImportSourceRow[] = [];
    for (let rowIndex = dataStart; rowIndex < grid.length; rowIndex += 1) {
      const cells = grid[rowIndex] ?? [];
      if (isBlankRow(cells)) {
        ignoredBlankRows += 1;
        continue;
      }
      if (isSummaryRow(cells, mapping, date1904)) {
        ignoredSummaryRows += 1;
        continue;
      }
      rows.push({
        key: `${name}:${rowIndex + 1}`,
        sourceRow: rowIndex + 1,
        cells,
      });
    }
    const hidden = (workbook.Workbook?.Sheets?.[sheetIndex] as { Hidden?: number } | undefined)?.Hidden !== undefined
      && (workbook.Workbook?.Sheets?.[sheetIndex] as { Hidden?: number }).Hidden !== 0;
    const requiredMapped = mapping.customerName !== null
      && mapping.saleDate !== null
      && mapping.totalAmount !== null;
    return {
      name,
      hidden,
      headerRow: headerRow === null ? null : headerRow + 1,
      columns: labels.map((label, index) => ({ index, label })),
      rows,
      mapping,
      selected: !hidden && requiredMapped && rows.length > 0,
      ignoredBlankRows,
      ignoredSummaryRows,
      date1904,
    };
  });
  return { sheets };
}

function validCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

export function parseImportDate(value: unknown, date1904 = false): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const date = `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, "0")}-${String(value.getUTCDate()).padStart(2, "0")}`;
    return validCalendarDate(date) ? date : null;
  }
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    let days = Math.floor(value);
    let epoch = Date.UTC(1899, 11, 31);
    if (date1904) {
      epoch = Date.UTC(1904, 0, 1);
    } else if (days >= 60) {
      // Excel's 1900 date system includes the nonexistent 29 February 1900.
      days -= 1;
    }
    const date = new Date(epoch + days * 86_400_000);
    if (Number.isNaN(date.getTime())) return null;
    const formatted = date.toISOString().slice(0, 10);
    return validCalendarDate(formatted) ? formatted : null;
  }
  const text = String(value ?? "").trim();
  const iso = /^(\d{4}-\d{2}-\d{2})(?:[T ].*)?$/.exec(text);
  if (iso && validCalendarDate(iso[1])) return iso[1];
  const brazilian = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/.exec(text);
  if (brazilian) {
    const date = `${brazilian[3]}-${brazilian[2].padStart(2, "0")}-${brazilian[1].padStart(2, "0")}`;
    return validCalendarDate(date) ? date : null;
  }
  return null;
}

export function mapSalesImportRow(
  sheet: SalesImportSheet,
  row: SalesImportSourceRow,
): SalesImportRowResult {
  const cell = (field: SalesImportField) => {
    const column = sheet.mapping[field];
    return column === null ? "" : row.cells[column];
  };
  const customerName = String(cell("customerName") ?? "").trim().replace(/\s+/g, " ");
  const saleDate = parseImportDate(cell("saleDate"), sheet.date1904);
  const totalCents = parseImportMoney(cell("totalAmount"));
  const rawProduct = String(cell("productName") ?? "").trim().replace(/\s+/g, " ");
  const errors: string[] = [];
  if (!customerName) errors.push("Nome do cliente ausente.");
  else if (customerName.length > 120) errors.push("Nome do cliente acima de 120 caracteres.");
  if (sheet.mapping.customerName === null) errors.push("Coluna do cliente não identificada.");
  if (!saleDate) errors.push("Data de início inválida.");
  if (sheet.mapping.saleDate === null) errors.push("Coluna da data de início não identificada.");
  if (totalCents === null) errors.push("Valor da venda inválido ou negativo.");
  if (sheet.mapping.totalAmount === null) errors.push("Coluna do valor da venda não identificada.");
  if (rawProduct.length > 120) errors.push("Produto acima de 120 caracteres.");
  return {
    preview: {
      customerName,
      saleDate: saleDate ?? String(cell("saleDate") ?? "").trim(),
      totalCents,
      amountText: String(cell("totalAmount") ?? "").trim(),
      productName: rawProduct || null,
    },
    value: customerName
      && customerName.length <= 120
      && saleDate
      && totalCents !== null
      && rawProduct.length <= 120
      && sheet.mapping.customerName !== null
      && sheet.mapping.saleDate !== null
      && sheet.mapping.totalAmount !== null
      ? {
          key: row.key,
          sourceSheet: sheet.name,
          sourceRow: row.sourceRow,
          customerName,
          saleDate,
          totalCents,
          productName: rawProduct || null,
        }
      : null,
    errors,
  };
}

export function parseImportMoney(value: unknown): number | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return null;
    const cents = Math.round(value * 100);
    return Number.isSafeInteger(cents) && Math.abs(value * 100 - cents) < 1e-7
      ? cents
      : null;
  }
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  let text = raw.replace(/^R\$\s*/i, "").replace(/[\s\u00a0]/g, "");
  if (!text || !/^\d[\d.,]*$/.test(text)) return null;
  if (text.includes(",") && text.includes(".")) {
    if (/^\d{1,3}(?:\.\d{3})+,\d{1,2}$/.test(text)) {
      text = text.replace(/\./g, "").replace(",", ".");
    } else if (/^\d{1,3}(?:,\d{3})+\.\d{1,2}$/.test(text)) {
      text = text.replace(/,/g, "");
    } else {
      return null;
    }
  } else if (text.includes(",")) {
    if (/^\d+,\d{1,2}$/.test(text)) {
      text = text.replace(",", ".");
    } else {
      return null;
    }
  } else if (text.includes(".")) {
    if (/^\d{1,3}(?:\.\d{3})+$/.test(text)) {
      text = text.replace(/\./g, "");
    } else if (!/^\d+\.\d{1,2}$/.test(text)) {
      return null;
    }
  }
  const [whole, fraction = ""] = text.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(cents) ? cents : null;
}
