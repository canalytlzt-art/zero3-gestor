import { isDateCellFormat, readImportSource, type ImportSourceRow } from "./sales-import-source";

export type SalesImportField =
  | "customerName"
  | "saleDate"
  | "totalAmount"
  | "productName"
  | "notes";

export type SalesImportMapping = Record<SalesImportField, number | null>;

export type SalesImportSourceRow = ImportSourceRow & {
  key: string;
  blockIndex: number;
};

export type SalesImportBlock = {
  headerRow: number | null;
  columns: Array<{ index: number; label: string }>;
  mapping: SalesImportMapping;
  dateInferred: boolean;
  dateAmbiguous: boolean;
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
  blocks: SalesImportBlock[];
  ignoredRows: Array<{ source: ImportSourceRow; reason: string }>;
  ignoredHeaderRows: number;
  filterRange: string | null;
};

export type SalesImportWorkbook = {
  sheets: SalesImportSheet[];
};

export type MappedSalesImportRow = {
  key: string;
  sourceSheet: string;
  sourceRow: number;
  customerName: string | null;
  saleDate: string;
  totalCents: number;
  productName: string | null;
  notes: string | null;
};

export type MappedSalesDraftRow = {
  key: string;
  sourceSheet: string;
  sourceRow: number;
  customerName: string | null;
  saleDate: string | null;
  saleDateText: string | null;
  totalCents: number | null;
  amountText: string | null;
  productName: string | null;
  notes: string | null;
};

export type SalesImportRowResult = {
  kind: "ready" | "pending" | "auxiliary";
  value: MappedSalesImportRow | null;
  draftValue: MappedSalesDraftRow | null;
  needsVerification: boolean;
  errors: string[];
  reason: string;
  dateSource: string;
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
  notes: null,
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
    if (/^(data da venda|data de venda|data venda|sale date)$/.test(header)) return 4;
    if (/^(data|data principal)$/.test(header)) return 2;
    return 0;
  }
  if (field === "totalAmount") {
    if (/\b(unitario|parcela|desconto|taxa|comissao|juros|vencimento)\b/.test(header)) return 0;
    if (/^(valor da venda|valor venda|sale value)$/.test(header)) return 5;
    if (/^(valor total|total da venda|total venda|total value)$/.test(header)) return 4;
    if (/^(valor|total)$/.test(header)) return 2;
    return 0;
  }
  if (field === "productName") {
    return /^(produto|plano|plano produto|produto plano|categoria|product|plan|category)$/.test(header) ? 3 : 0;
  }
  if (field === "notes") {
    return /^(observacao|observacoes|nota|notas|notes|obs)$/.test(header) ? 3 : 0;
  }
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

  let sources: ReturnType<typeof readImportSource>;
  try {
    sources = readImportSource(fileBytes, extension);
  } catch {
    throw new Error("Não foi possível ler o arquivo. Verifique se o XLSX ou CSV está íntegro.");
  }
  if (!sources.length) {
    throw new Error("O arquivo não contém abas ou linhas de dados.");
  }

  const sheets = sources.map((source): SalesImportSheet => {
    const { name, date1904 } = source;
    const makeBlock = (header?: ImportSourceRow): SalesImportBlock => ({
      headerRow: header?.sourceRow ?? null,
      columns: uniqueColumnLabels(Array.from({ length: source.width }, (_, index) =>
        String(header?.cells[index] ?? "").trim() || `Coluna ${excelColumnName(index)}`,
      )).map((label, index) => ({ index, label })),
      mapping: header ? {
        customerName: detectColumn(header.cells, "customerName"),
        saleDate: detectColumn(header.cells, "saleDate"),
        totalAmount: detectColumn(header.cells, "totalAmount"),
        productName: detectColumn(header.cells, "productName"),
        notes: detectColumn(header.cells, "notes"),
      } : emptyMapping(),
      dateInferred: false,
      dateAmbiguous: false,
    });
    const isHeader = (row: ImportSourceRow) => (["customerName", "saleDate", "totalAmount"] as const)
      .filter((field) => row.cells.some((cell) => headerMatch(cell, field) > 0)).length >= 2;
    const firstHeader = source.rows.find(isHeader);
    const blocks = [makeBlock(firstHeader)];
    let blockIndex = 0;
    let ignoredBlankRows = 0;
    let ignoredSummaryRows = 0;
    let ignoredHeaderRows = 0;
    const ignoredRows: SalesImportSheet["ignoredRows"] = [];
    const rows: SalesImportSourceRow[] = [];
    for (const raw of source.rows) {
      const { cells } = raw;
      if (isBlankRow(cells)) {
        ignoredBlankRows += 1;
        continue;
      }
      if (isHeader(raw)) {
        const next = makeBlock(raw);
        if (raw.sourceRow !== firstHeader?.sourceRow
          && (JSON.stringify(next.mapping) !== JSON.stringify(blocks[blockIndex].mapping)
            || JSON.stringify(next.columns) !== JSON.stringify(blocks[blockIndex].columns))) {
          blocks.push(next);
          blockIndex = blocks.length - 1;
        }
        ignoredHeaderRows += 1;
        ignoredRows.push({ source: raw, reason: "Cabeçalho de tabela (original ou repetido)." });
        continue;
      }
      if (firstHeader && raw.sourceRow < firstHeader.sourceRow
        && cells.filter((cell) => String(cell ?? "").trim()).length === 1) {
        ignoredRows.push({ source: raw, reason: "Título/texto isolado antes do cabeçalho." });
        continue;
      }
      if (isSummaryRow(cells, blocks[blockIndex].mapping, date1904)) {
        ignoredSummaryRows += 1;
        ignoredRows.push({ source: raw, reason: "Total/subtotal identificado na estrutura da tabela." });
        continue;
      }
      rows.push({
        ...raw, key: `${name}:${raw.sourceRow}`, blockIndex,
      });
    }
    for (const [index, block] of blocks.entries()) {
      if (block.mapping.saleDate !== null) continue;
      const explicitDateColumns = block.columns.filter((column) => headerMatch(column.label, "saleDate") > 0);
      if (explicitDateColumns.length > 1) {
        block.dateAmbiguous = true;
        continue; // One block-level confirmation is required.
      }
      const dateColumns = new Set(rows.filter((row) => row.blockIndex === index)
        .flatMap((row) => row.sourceCells.filter((cell) =>
          cell.column !== block.mapping.customerName && cell.column !== block.mapping.totalAmount
            && dateEvidence(row, cell.column, block, date1904),
        ).map((cell) => cell.column)));
      if (dateColumns.size === 1) {
        block.mapping.saleDate = [...dateColumns][0];
        block.dateInferred = true;
      } else if (dateColumns.size > 1) block.dateAmbiguous = true;
    }
    const first = blocks[0];
    return {
      name, hidden: source.hidden, headerRow: first.headerRow,
      columns: first.columns, mapping: first.mapping,
      rows, blocks, ignoredRows, ignoredHeaderRows,
      selected: !source.hidden && rows.length > 0,
      ignoredBlankRows, ignoredSummaryRows, date1904, filterRange: source.filterRange,
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
  if (typeof value === "string" && /^\d{4,7}(?:\.\d+)?$/.test(value.trim())) value = Number(value.trim());
  if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 2_958_465) {
    let days = Math.floor(value);
    if (!date1904 && days === 60) return null;
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

function dateEvidence(row: ImportSourceRow, column: number, block: SalesImportBlock, date1904: boolean): boolean {
  const label = normalizeHeader(block.columns[column]?.label);
  if (/\b(fim|vencimento|pagamento|cadastro|parcela|valor|taxa|desconto|numero)\b/.test(label)) return false;
  const value = row.cells[column];
  const metadata = row.sourceCells.find((cell) => cell.column === column);
  const identifiable = headerMatch(label, "saleDate") > 0 || metadata?.type === "d"
    || isDateCellFormat(metadata?.format ?? "")
    || (typeof value === "string" && /^(?:\d{1,2}[/.]\d{1,2}[/.]\d{4}|\d{4}-\d{2}-\d{2})/.test(value.trim()));
  return identifiable && parseImportDate(value, date1904) !== null;
}

export function mapSalesImportRow(
  sheet: SalesImportSheet,
  row: SalesImportSourceRow,
): SalesImportRowResult {
  const block = sheet.blocks[row.blockIndex];
  const mapping = row.blockIndex === 0 ? sheet.mapping : block.mapping;
  let dateColumn = mapping.saleDate;
  let dateFallback = false;
  if ((dateColumn !== null || !block.dateAmbiguous)
    && (dateColumn === null || !String(row.cells[dateColumn] ?? "").trim())) {
    const alternatives = row.sourceCells.filter((cell) => cell.column !== mapping.customerName
      && cell.column !== mapping.totalAmount && dateEvidence(row, cell.column, block, sheet.date1904));
    if (alternatives.length === 1) {
      dateColumn = alternatives[0].column;
      dateFallback = true;
    }
  }
  const columnFor = (field: SalesImportField) => field === "saleDate" ? dateColumn : mapping[field];
  const cell = (field: SalesImportField) => {
    const column = columnFor(field);
    return column === null ? "" : row.cells[column];
  };
  const customerName = String(cell("customerName") ?? "").trim().replace(/\s+/g, " ");
  const saleDate = parseImportDate(cell("saleDate"), sheet.date1904);
  const totalCents = parseImportMoney(cell("totalAmount"));
  const rawProduct = String(cell("productName") ?? "").trim().replace(/\s+/g, " ");
  const rawNotes = String(cell("notes") ?? "").trim();
  const rawDateText = String(cell("saleDate") ?? "").trim();
  const rawAmountText = String(cell("totalAmount") ?? "").trim();
  const nonempty = row.sourceCells.filter((source) => String(source.value ?? "").trim());
  const hasCore = (["customerName", "saleDate", "totalAmount"] as const)
    .some((field) => String(cell(field) ?? "").trim());
  const optionalOnly = nonempty.length > 0 && nonempty.every((source) =>
    /^(modalidade|recorrencia|produto|plano|categoria|observacao|observacoes|nota|notas|notes|obs)$/.test(normalizeHeader(block.columns[source.column]?.label)),
  );
  const hasOtherEvidence = nonempty.some((source) =>
    dateEvidence(row, source.column, block, sheet.date1904)
    || headerMatch(block.columns[source.column]?.label, "totalAmount") > 0,
  );
  const auxiliary = !hasCore && !hasOtherEvidence && (optionalOnly || nonempty.length === 0
    || (nonempty.length === 1 && mapping.customerName !== nonempty[0].column
      && /^(observacao|nota|relatorio|titulo|resumo)\b/.test(normalizeHeader(nonempty[0].value))));
  const errors: string[] = [];
  const fieldError = (field: SalesImportField, label: string) => {
    const column = columnFor(field);
    const source = row.sourceCells.find((item) => item.column === column);
    if (source?.formula && !String(source.value ?? "").trim()) {
      return `${label}: fórmula em ${source.address} sem resultado calculado utilizável.`;
    }
    return `${label}${source ? ` (${source.address})` : ""}.`;
  };
  if (customerName.length > 120) errors.push("Nome do cliente acima de 120 caracteres.");
  if (rawProduct.length > 500) errors.push("Plano/produto acima de 500 caracteres.");
  if (rawNotes.length > 1000) errors.push("Observação acima de 1000 caracteres.");
  if (!saleDate) errors.push(fieldError("saleDate", dateColumn === null
    ? "Data não identificada com segurança; confirme a coluna uma vez neste bloco"
    : "Data da venda ausente ou inválida"));
  if (totalCents === null) errors.push(fieldError("totalAmount", "Valor da venda ausente, inválido ou negativo"));
  const isComplete = Boolean(saleDate && totalCents !== null)
    && customerName.length <= 120
    && rawProduct.length <= 120
    && rawNotes.length <= 1000;
  const reason = auxiliary
    ? `Somente conteúdo auxiliar, sem lançamento nos campos obrigatórios. Células preenchidas: ${nonempty.map((source) => source.address).join(", ") || "nenhuma"}.`
    : errors.join(" ");
  const draftValue = !auxiliary && !isComplete ? {
    key: row.key,
    sourceSheet: sheet.name,
    sourceRow: row.sourceRow,
    customerName: customerName || null,
    saleDate,
    saleDateText: rawDateText.slice(0, 200) || null,
    totalCents,
    amountText: rawAmountText.slice(0, 120) || null,
    productName: rawProduct.slice(0, 500) || null,
    notes: rawNotes.slice(0, 1000) || null,
  } : null;
  const value = !auxiliary && isComplete ? {
    key: row.key,
    sourceSheet: sheet.name,
    sourceRow: row.sourceRow,
    customerName: customerName || null,
    saleDate: saleDate!,
    totalCents: totalCents!,
    productName: rawProduct || null,
    notes: rawNotes || null,
  } : null;
  return {
    kind: auxiliary ? "auxiliary" : value ? "ready" : "pending",
    needsVerification: Boolean(value && (!customerName || !rawProduct)),
    reason,
    dateSource: dateColumn === null ? "Data não identificada" : `${excelColumnName(dateColumn)}${row.sourceRow} · ${block.columns[dateColumn]?.label ?? ""}${dateFallback || block.dateInferred ? " (única data identificável)" : ""}`,
    preview: {
      customerName,
      saleDate: saleDate ?? String(cell("saleDate") ?? "").trim(),
      totalCents,
      amountText: String(cell("totalAmount") ?? "").trim(),
      productName: rawProduct.length <= 120 ? rawProduct || null : null,
    },
    value,
    draftValue,
    errors: auxiliary ? [] : errors,
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
