import * as XLSX from "xlsx";
import { isValidCalendarDate } from "./occupancy-calendar";

export type OccupancyImportOptions = {
  missingYear?: number;
  scaleDecisions?: Record<string, "fraction" | "percent">;
};

export type OccupancyImportEntry = {
  index: number;
  sourceSheet: string;
  sourceCell: string;
  sourceCells: Record<string, string>;
  kind: "daily" | "monthly" | null;
  period: string | null;
  modalityName: string | null;
  percentage: number | null;
  reportedPercentage: number | null;
  presences: number | null;
  capacity: number | null;
  aggregatorPresences: number | null;
  startTime: string | null;
  endTime: string | null;
  className: string | null;
  status: "ready" | "pending" | "ignored";
  reason: string;
  overlapKey?: string;
  scaleKey?: string | null;
};

export type ParsedOccupancyImport = {
  fileHash: string;
  sheets: Array<{ name: string; hidden: boolean; entryCount: number; selected: boolean }>;
  entries: OccupancyImportEntry[];
  missingYear: boolean;
  yearsFound: number[];
  scaleDecisions: Array<{ key: string; sheet: string; column: string; example: string }>;
  blankCount: number;
  ignoredCount: number;
};

type Cell = { address: string; column: number; value: unknown; format: string; formula?: string; error?: string };
type SourceSheet = { name: string; hidden: boolean; date1904: boolean; rows: Map<number, Map<number, Cell>> };
type Period = { kind: "daily" | "monthly"; value: string | null; missingYear: boolean; year?: number; month?: number };
type Block = {
  headerRow: number;
  kind: "records" | "modality-months" | "date-modalities";
  periodColumn?: number;
  modalityColumn?: number;
  percentageColumn?: number;
  timeColumn?: number;
  startTimeColumn?: number;
  endTimeColumn?: number;
  presenceCapacityColumn?: number;
  presencesColumn?: number;
  capacityColumn?: number;
  aggregatorColumn?: number;
  classColumn?: number;
  yearColumn?: number;
  forceMonthly?: boolean;
  monthColumns?: Array<{ column: number; period: Period; yearHint?: number }>;
  modalityColumns?: Array<{ column: number; name: string }>;
  ambiguousPeriod?: boolean;
  scaleKey: string;
  scaleColumn: string;
  inferredScale?: "fraction" | "percent";
};

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_CONTENT_CELLS = 250_000;
const MAX_ROWS = 25_000;
const MONTHS = new Map<string, number>([
  ["janeiro", 1], ["jan", 1], ["january", 1],
  ["fevereiro", 2], ["fev", 2], ["feb", 2], ["february", 2],
  ["março", 3], ["marco", 3], ["mar", 3], ["march", 3],
  ["abril", 4], ["abr", 4], ["apr", 4], ["april", 4],
  ["maio", 5], ["mai", 5], ["may", 5],
  ["junho", 6], ["jun", 6], ["june", 6],
  ["julho", 7], ["jul", 7], ["july", 7],
  ["agosto", 8], ["ago", 8], ["aug", 8], ["august", 8],
  ["setembro", 9], ["set", 9], ["sep", 9], ["september", 9],
  ["outubro", 10], ["out", 10], ["oct", 10], ["october", 10],
  ["novembro", 11], ["nov", 11], ["november", 11],
  ["dezembro", 12], ["dez", 12], ["dec", 12], ["december", 12],
]);

function normalize(value: unknown) {
  return String(value ?? "").trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR").replace(/[^a-z0-9%]+/g, " ").trim().replace(/\s+/g, " ");
}

function columnName(column: number) {
  let value = column + 1;
  let name = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

function makeCell(address: string, cell: XLSX.CellObject): Cell {
  const { c: column } = XLSX.utils.decode_cell(address);
  const formula = typeof cell.f === "string" && cell.f ? cell.f : undefined;
  const isError = cell.t === "e";
  const value = isError ? (cell.w || `Erro Excel ${cell.v}`) : cell.t === "z" ? "" : cell.v ?? "";
  return { address, column, value, format: String(cell.z ?? ""), ...(formula ? { formula } : {}), ...(isError ? { error: String(cell.w ?? cell.v ?? "erro na fórmula") } : {}) };
}

function sheetYears(name: string, rows: Map<number, Map<number, Cell>>, headerRow = Number.POSITIVE_INFINITY) {
  const text = [name];
  for (const [row, cells] of rows) {
    if (row >= headerRow || row > 30) continue;
    for (const cell of cells.values()) if (typeof cell.value === "string") text.push(cell.value);
  }
  return [...new Set(text.flatMap((value) => [...value.matchAll(/\b(?:19|20|21)\d{2}\b/g)].map((match) => Number(match[0]))))];
}

function readPeriod(value: unknown, date1904: boolean, forceMonthly = false, yearHint?: number): Period | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const iso = `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, "0")}-${String(value.getUTCDate()).padStart(2, "0")}`;
    return forceMonthly ? { kind: "monthly", value: iso.slice(0, 7), missingYear: false, year: value.getUTCFullYear(), month: value.getUTCMonth() + 1 } : { kind: "daily", value: iso, missingYear: false };
  }
  const text = String(value ?? "").trim();
  if (!text) return null;
  const iso = /^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/.exec(text);
  if (iso) {
    const year = Number(iso[1]); const month = Number(iso[2]);
    const day = iso[3] === undefined ? null : Number(iso[3]);
    if (year < 1 || month < 1 || month > 12) return null;
    if (day === null || forceMonthly) return { kind: "monthly", value: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`, missingYear: false, year, month };
    if (!isValidCalendarDate(year, month, day)) return null;
    return { kind: "daily", value: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`, missingYear: false };
  }
  const brazilian = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/.exec(text);
  if (brazilian) {
    const [day, month, year] = brazilian.slice(1).map(Number);
    if (month < 1 || month > 12 || day < 1 || year < 1) return null;
    if (forceMonthly) return { kind: "monthly", value: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`, missingYear: false, year, month };
    if (!isValidCalendarDate(year, month, day)) return null;
    return { kind: "daily", value: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`, missingYear: false };
  }
  const monthYear = /^(\d{1,2})[/-](\d{4})$/.exec(text);
  if (monthYear) {
    const month = Number(monthYear[1]); const year = Number(monthYear[2]);
    if (month < 1 || month > 12 || year < 1) return null;
    return { kind: "monthly", value: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`, missingYear: false, year, month };
  }
  const monthWords = normalize(text).replace(/\b(de|do|da|mes|competencia)\b/g, " ").trim();
  const words = monthWords.split(/[\s/-]+/).filter(Boolean);
  const month = words.map((word) => MONTHS.get(word)).find((value) => value !== undefined);
  if (month) {
    const yearToken = words.find((word) => /^\d{4}$/.test(word));
    const year = yearToken ? Number(yearToken) : yearHint;
    if (year) return { kind: "monthly", value: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`, missingYear: false, year, month };
    return { kind: "monthly", value: null, missingYear: true, month };
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    if (forceMonthly && Number.isInteger(value) && value >= 1 && value <= 12) {
      if (yearHint) return { kind: "monthly", value: `${yearHint}-${String(value).padStart(2, "0")}`, missingYear: false, year: yearHint, month: value };
      return { kind: "monthly", value: null, missingYear: true, month: value };
    }
    if (value >= 0 && value <= 2_958_465) {
      let days = Math.floor(value);
      if (!date1904 && days === 60) return null;
       let epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, days >= 60 ? 30 : 31);
      const date = new Date(epoch + days * 86_400_000);
      if (!Number.isNaN(date.getTime())) {
        const year = date.getUTCFullYear(); const month = date.getUTCMonth() + 1; const day = date.getUTCDate();
        const period = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
        return forceMonthly ? { kind: "monthly", value: period, missingYear: false, year, month } : { kind: "daily", value: `${period}-${String(day).padStart(2, "0")}`, missingYear: false };
      }
    }
  }
  return null;
}

function parseMonthHeading(value: unknown, yearHint?: number): Period | null {
  const period = readPeriod(value, false, true, yearHint);
  if (period) return period;
  const text = normalize(value);
  const numeric = /^(\d{1,2})$/.exec(text);
  if (numeric) {
    const month = Number(numeric[1]);
    if (month >= 1 && month <= 12) return { kind: "monthly", value: yearHint ? `${yearHint}-${String(month).padStart(2, "0")}` : null, missingYear: !yearHint, year: yearHint, month };
  }
  return null;
}

function fieldForHeader(value: unknown): "period" | "month" | "modality" | "percentage" | "class" | "year" | "time" | "startTime" | "endTime" | "presenceCapacity" | "presences" | "capacity" | "aggregatorPresences" | null {
  const header = normalize(value).replace(/%/g, " ").replace(/\s+/g, " ").trim();
  if (/^(data|dia|data da aula|data da atividade|data aula)$/.test(header)) return "period";
  if (/^(mes|mes ano|mes ano competencia|competencia|mes competencia|month|year month|mes e ano)$/.test(header)) return "month";
  if (/^(modalidade|atividade|modality|activity|aula)$/.test(header)) return "modality";
  if (/^(ocupacao|ocupacao percentual|percentual ocupacao|percentual|percentual de ocupacao|taxa ocupacao|occupancy|occupancy rate|percent|taxa)$/.test(header)) return "percentage";
  if (/^(presencas vagas|presencas capacidade|presenca vagas|presenca capacidade|presencas por vagas|presencas\/vagas|presencas-vagas)$/.test(header)) return "presenceCapacity";
  if (/^(presencas|presenca|participantes|frequencia)$/.test(header)) return "presences";
  if (/^(agregadores|agregador|presencas agregadores|presencas de agregadores|alunos agregadores|alunos de plataformas|check in agregadores|aggregators)$/.test(header)) return "aggregatorPresences";
  if (/^(vagas|vagas totais|capacidade|capacidade total|lotacao total)$/.test(header)) return "capacity";
  if (/^(horario inicial|hora inicial|hora de inicio|horario de inicio|inicio|hora inicio|start time)$/.test(header)) return "startTime";
  if (/^(horario final|hora final|hora de fim|horario de fim|fim|hora fim|end time)$/.test(header)) return "endTime";
  if (/^(horario|hora|horario da aula|hora da aula|time)$/.test(header)) return "time";
  if (/^(turma|horario|turma horario|classe|class|horario turma)$/.test(header)) return "class";
  if (/^(ano|year)$/.test(header)) return "year";
  return null;
}

function headerFields(row: Map<number, Cell>) {
  const fields = new Map<string, number[]>();
  for (const [column, cell] of row) {
    const field = fieldForHeader(cell.value);
    if (field) fields.set(field, [...(fields.get(field) ?? []), column]);
  }
  return fields;
}

function asYear(value: unknown) {
  const text = String(value ?? "").trim();
  if (/^(?:19|20|21)\d{2}$/.test(text)) return Number(text);
  return null;
}

function rowYearHint(source: SourceSheet, row: number, column: number, yearColumn?: number) {
  if (yearColumn !== undefined) {
    const value = asYear(source.rows.get(row)?.get(yearColumn)?.value);
    if (value) return value;
  }
  for (let nearby = row - 1; nearby >= Math.max(0, row - 3); nearby -= 1) {
    const value = asYear(source.rows.get(nearby)?.get(column)?.value);
    if (value) return value;
  }
  return undefined;
}

function headerYearHint(source: SourceSheet, headerRow: number, column: number, globalYears: number[]) {
  for (let row = headerRow - 1; row >= Math.max(0, headerRow - 3); row -= 1) {
    const sameColumn = asYear(source.rows.get(row)?.get(column)?.value);
    if (sameColumn) return sameColumn;
    const cells = source.rows.get(row);
    if (!cells) continue;
    const priorYears = [...cells.entries()].filter(([col]) => col <= column).map(([, cell]) => asYear(cell.value)).filter((year): year is number => year !== null);
    if (priorYears.length) return priorYears.at(-1);
  }
  return globalYears.length === 1 ? globalYears[0] : undefined;
}

function createBlock(source: SourceSheet, rowIndex: number, globalYears: number[]): Block | null {
  const row = source.rows.get(rowIndex);
  if (!row?.size) return null;
  const fields = headerFields(row);
  const one = (key: string) => fields.get(key)?.length === 1 ? fields.get(key)![0] : undefined;
  const periodColumn = one("period");
  const monthColumn = one("month");
  const modalityColumn = one("modality");
  const percentageColumn = one("percentage");
  const timeColumn = one("time");
  const startTimeColumn = one("startTime");
  const endTimeColumn = one("endTime");
  const presenceCapacityColumn = one("presenceCapacity");
  const presencesColumn = one("presences");
  const capacityColumn = one("capacity");
  const aggregatorColumn = one("aggregatorPresences");
  const classColumn = one("class");
  const yearColumn = one("year");
  const periodInputColumn = periodColumn ?? monthColumn;
  const hasCountColumns = presenceCapacityColumn !== undefined || presencesColumn !== undefined || capacityColumn !== undefined;
  if (periodInputColumn !== undefined && modalityColumn !== undefined && (percentageColumn !== undefined || hasCountColumns)) {
    const otherAmbiguity = [
      fields.get("period"), fields.get("month"), fields.get("modality"), fields.get("percentage"),
      fields.get("time"), fields.get("startTime"), fields.get("endTime"),
      fields.get("presenceCapacity"), fields.get("presences"), fields.get("capacity"),
    ].some((columns) => (columns?.length ?? 0) > 1)
      || (presenceCapacityColumn !== undefined && (presencesColumn !== undefined || capacityColumn !== undefined))
      || (timeColumn !== undefined && (startTimeColumn !== undefined || endTimeColumn !== undefined));
    return {
      headerRow: rowIndex, kind: "records", periodColumn: periodInputColumn, modalityColumn, percentageColumn,
      timeColumn, startTimeColumn, endTimeColumn, presenceCapacityColumn, presencesColumn, capacityColumn, aggregatorColumn,
      classColumn, yearColumn, forceMonthly: periodColumn === undefined || monthColumn !== undefined,
      ambiguousPeriod: otherAmbiguity,
      scaleKey: `${source.name}::${rowIndex + 1}::${columnName(percentageColumn ?? presenceCapacityColumn ?? presencesColumn ?? 0)}`,
      scaleColumn: percentageColumn === undefined ? "—" : columnName(percentageColumn),
    };
  }
  if (modalityColumn !== undefined) {
    const monthColumns = [...row.entries()].flatMap(([column, cell]) => {
      if (column === modalityColumn || column === yearColumn || column === classColumn) return [];
      const period = parseMonthHeading(cell.value, headerYearHint(source, rowIndex, column, globalYears));
      return period ? [{ column, period, yearHint: period.year }] : [];
    });
    if (monthColumns.length) {
      return {
        headerRow: rowIndex, kind: "modality-months", modalityColumn, classColumn, yearColumn, monthColumns,
        scaleKey: `${source.name}::${rowIndex + 1}::matrix`, scaleColumn: monthColumns.map(({ column }) => columnName(column)).join(", "),
      };
    }
  }
  if (periodColumn !== undefined) {
    const modalityColumns = [...row.entries()].flatMap(([column, cell]) => {
      if (column === periodColumn || column === classColumn || column === yearColumn || ["class", "year", "month", "percentage"].some((key) => fields.get(key)?.includes(column))) return [];
      const name = String(cell.value ?? "").trim().replace(/\s+/g, " ");
      return name ? [{ column, name }] : [];
    });
    if (modalityColumns.length) {
      return {
        headerRow: rowIndex, kind: "date-modalities", periodColumn, classColumn, yearColumn, modalityColumns,
        scaleKey: `${source.name}::${rowIndex + 1}::matrix`, scaleColumn: modalityColumns.map(({ column }) => columnName(column)).join(", "),
      };
    }
  }
  return null;
}

function isBlank(value: unknown) { return value === null || value === undefined || String(value).trim() === ""; }
function isTotalRow(cells: Map<number, Cell>) {
  const first = [...cells.values()].map((cell) => normalize(cell.value)).find(Boolean) ?? "";
  return /^(total|total geral|total do periodo|subtotal|media|media geral|grand total|resumo)$/.test(first);
}

function percentFormat(format: string) {
  const cleaned = format.replace(/"[^"]*"|\\./g, "");
  return cleaned.includes("%");
}

function parseClock(raw: unknown): string | null {
  const text = String(raw ?? "").trim();
  const match = text.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] ?? 0);
  if (hour > 23 || minute > 59 || second !== 0) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function parseTimeValue(raw: unknown): string | null {
  if (raw instanceof Date && Number.isFinite(raw.getTime())) {
    return `${String(raw.getUTCHours()).padStart(2, "0")}:${String(raw.getUTCMinutes()).padStart(2, "0")}`;
  }
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0 && raw < 1) {
    const minutes = Math.round(raw * 24 * 60);
    if (minutes < 0 || minutes >= 24 * 60) return null;
    return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  }
  return parseClock(raw);
}

function parseTimeCell(cell: Cell | undefined, allowRange: boolean) {
  if (!cell || isBlank(cell.value)) return { startTime: null, endTime: null, error: "Horário inicial ausente." };
  if (cell.error || (cell.formula && isBlank(cell.value))) {
    return { startTime: null, endTime: null, error: cellError(cell, "Horário") };
  }
  if (allowRange && typeof cell.value === "string") {
    const text = cell.value.trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const range = text.match(/^(.+?)\s*(?:[-–—]|(?:\s+)(?:a|as|ate)\s+)\s*(.*?)$/i);
    if (range) {
      const startTime = parseTimeValue(range[1]);
      const endTime = range[2] ? parseTimeValue(range[2]) : null;
      if (!startTime) return { startTime: null, endTime: null, error: `Horário inicial inválido em ${cell.address}; use HH:MM.` };
      if (range[2] && !endTime) return { startTime, endTime: null, error: `Horário final inválido em ${cell.address}; use HH:MM.` };
      return { startTime, endTime, error: null };
    }
  }
  const startTime = parseTimeValue(cell.value);
  return startTime
    ? { startTime, endTime: null, error: null }
    : { startTime: null, endTime: null, error: `Horário inválido em ${cell.address}; use HH:MM ou HH:MM - HH:MM.` };
}

function parseCountCell(cell: Cell | undefined, label: string, allowZero: boolean) {
  if (!cell || isBlank(cell.value)) return { value: null, error: `${label} ausente${cell ? ` em ${cell.address}` : ""}.` };
  if (cell.error || (cell.formula && isBlank(cell.value))) return { value: null, error: cellError(cell, label) };
  const raw = cell.value;
  const value = typeof raw === "number"
    ? (Number.isSafeInteger(raw) ? raw : null)
    : (/^\d+$/.test(String(raw).trim()) ? Number(String(raw).trim()) : null);
  if (value === null || !Number.isSafeInteger(value) || value > 2_147_483_647 || (allowZero ? value < 0 : value < 1)) {
    return { value: null, error: `${label} em ${cell.address} deve ser um número inteiro ${allowZero ? "maior ou igual a zero" : "maior que zero"}.` };
  }
  return { value, error: null };
}

function parsePresenceCapacityCell(cell: Cell | undefined) {
  if (!cell || isBlank(cell.value)) return { presences: null, capacity: null, error: `Presenças/vagas ausentes${cell ? ` em ${cell.address}` : ""}.` };
  if (cell.error || (cell.formula && isBlank(cell.value))) return { presences: null, capacity: null, error: cellError(cell, "Presenças/vagas") };
  const match = String(cell.value).trim().match(/^(\d+)\s*\/\s*(\d+)$/);
  if (!match) return { presences: null, capacity: null, error: `Presenças/vagas inválidas em ${cell.address}; use um formato como 10/18.` };
  const presences = Number(match[1]);
  const capacity = Number(match[2]);
  if (!Number.isSafeInteger(presences) || presences > 2_147_483_647 || !Number.isSafeInteger(capacity) || capacity < 1 || capacity > 2_147_483_647) {
    return { presences: null, capacity: null, error: `Presenças/vagas inválidas em ${cell.address}; presenças devem ser inteiras e vagas maiores que zero.` };
  }
  return { presences, capacity, error: null };
}

function parsePercent(raw: unknown): { value: number | null; explicitPercent: boolean; error: string | null } {
  if (typeof raw === "number") return Number.isFinite(raw)
    ? { value: raw, explicitPercent: false, error: null }
    : { value: null, explicitPercent: false, error: "Número não finito." };
  const text = String(raw ?? "").trim();
  const explicitPercent = /%\s*$/.test(text);
  const numberText = text.replace(/%\s*$/, "").replace(/[\s\u00a0]/g, "");
  if (!numberText || !/^[+-]?\d[\d.,]*$/.test(numberText)) return { value: null, explicitPercent, error: "Percentual ausente ou inválido." };
  let normalized = numberText;
  if (normalized.includes(",") && normalized.includes(".")) {
    const comma = normalized.lastIndexOf(","); const dot = normalized.lastIndexOf(".");
    const decimal = comma > dot ? "," : ".";
    const group = decimal === "," ? "." : ",";
    normalized = normalized.split(group).join("").replace(decimal, ".");
  } else if (normalized.includes(",")) normalized = normalized.replace(",", ".");
  const value = Number(normalized);
  return Number.isFinite(value)
    ? { value, explicitPercent, error: null }
    : { value: null, explicitPercent, error: "Percentual inválido." };
}

function explainFormula(cell: Cell | undefined, label: string) {
  if (!cell?.formula) return `${label} ausente.`;
  if (cell.error) return `${label}: erro de fórmula em ${cell.address} (${cell.error}).`;
  if (isBlank(cell.value)) return `${label}: fórmula em ${cell.address} sem resultado calculado utilizável.`;
  return null;
}

function finalizePercentage(cell: Cell | undefined, scale: "fraction" | "percent" | undefined, optional = false) {
  if (!cell || isBlank(cell.value)) return { value: null, error: optional ? null : explainFormula(cell, "Percentual") ?? "Percentual ausente.", needsScale: false };
  if (cell.error) return { value: null, error: `Erro de fórmula em ${cell.address}: ${cell.error}.`, needsScale: false };
  const parsed = parsePercent(cell.value);
  if (parsed.error || parsed.value === null) return { value: null, error: `Percentual inválido em ${cell.address}.`, needsScale: false };
  const fractionFromFormat = percentFormat(cell.format);
  const fractionFromText = parsed.explicitPercent;
  if (fractionFromFormat || fractionFromText) {
    const value = fractionFromText ? parsed.value : parsed.value * 100;
    return { value, error: value < 0 ? `Percentual negativo em ${cell.address}; revise na planilha.` : null, needsScale: false };
  }
  if (scale === "fraction") {
    if (parsed.value < 0 || parsed.value > 1) return { value: parsed.value, error: `A escala confirmada de 0 a 1 não corresponde a ${parsed.value} em ${cell.address}.`, needsScale: false };
    return { value: parsed.value * 100, error: null, needsScale: false };
  }
  if (scale === "percent") {
    return { value: parsed.value, error: parsed.value < 0 ? `Percentual negativo em ${cell.address}; revise a planilha.` : null, needsScale: false };
  }
  return { value: parsed.value, error: parsed.value < 0 ? `Percentual negativo em ${cell.address}; revise a planilha.` : null, needsScale: false, ambiguous: parsed.value > 0 && parsed.value <= 1 };
}

function inferBlockScale(source: SourceSheet, block: Block) {
  const columns = block.kind === "records"
    ? [block.percentageColumn].filter((value): value is number => value !== undefined)
    : block.kind === "modality-months"
      ? (block.monthColumns ?? []).map(({ column }) => column)
      : (block.modalityColumns ?? []).map(({ column }) => column);
  const values: number[] = [];
  for (const [rowIndex, row] of source.rows) {
    if (rowIndex <= block.headerRow || isTotalRow(row)) continue;
    for (const column of columns) {
      const cell = row.get(column);
      if (!cell || isBlank(cell.value) || percentFormat(cell.format)) continue;
      const parsed = parsePercent(cell.value);
       if (parsed.error || parsed.explicitPercent || parsed.value === null || parsed.value < 0) continue;
      values.push(parsed.value);
    }
  }
  if (values.some((value) => value > 1)) return "percent" as const;
  return values.some((value) => value > 0) ? undefined : "percent" as const;
}

function cellAddress(source: SourceSheet, row: number, column: number) {
  const existing = source.rows.get(row)?.get(column);
  return existing?.address ?? `${columnName(column)}${row + 1}`;
}

export async function parseOccupancySpreadsheet(bytes: ArrayBuffer, filename: string, options: OccupancyImportOptions = {}): Promise<ParsedOccupancyImport> {
  if (bytes.byteLength > MAX_FILE_BYTES) throw new Error("O arquivo excede 25 MB. Divida a planilha e importe em lotes menores.");
  if (!bytes.byteLength) throw new Error("Arquivo vazio ou não recebido.");
  const extension = filename.split(".").at(-1)?.toLocaleLowerCase("pt-BR");
  if (extension !== "xlsx" && extension !== "csv") throw new Error("Formato não suportado. Selecione uma planilha XLSX ou CSV.");

  let input: ArrayBuffer | string = bytes;
  if (extension === "csv") {
    try { input = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { input = new TextDecoder("windows-1252").decode(bytes); }
  }
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(input, { type: typeof input === "string" ? "string" : "array", raw: true, cellDates: false, cellNF: true, cellFormula: true, cellStyles: true, sheetStubs: true });
  } catch { throw new Error("Não foi possível ler o arquivo. Verifique se o XLSX ou CSV está íntegro."); }
  if (!workbook.SheetNames.length) throw new Error("O arquivo não contém abas ou dados.");

  let contentCells = 0;
  const sourceSheets: SourceSheet[] = workbook.SheetNames.map((name, index) => {
    const worksheet = workbook.Sheets[name] ?? {};
    const rows = new Map<number, Map<number, Cell>>();
    for (const [address, rawCell] of Object.entries(worksheet)) {
      if (!/^[A-Z]{1,4}[1-9]\d*$/.test(address)) continue;
      const cell = rawCell as XLSX.CellObject;
      if (cell.t === "z" && !cell.f) continue;
      if (cell.v === undefined && !cell.f) continue;
      const source = makeCell(address, cell);
      if (isBlank(source.value) && !source.formula && !source.error) continue;
      const position = XLSX.utils.decode_cell(address);
      if (position.r > 100_000 || position.c > 4_095) throw new Error(`A aba ${name} contém conteúdo fora do limite de leitura segura (linha 100.001/coluna 4.096).`);
      contentCells += 1;
      if (contentCells > MAX_CONTENT_CELLS) throw new Error("A planilha tem mais de 250 mil células preenchidas. Divida o arquivo para evitar processamento excessivo.");
      const row = rows.get(position.r) ?? new Map<number, Cell>();
      row.set(position.c, source);
      rows.set(position.r, row);
    }
    return { name, hidden: Boolean(workbook.Workbook?.Sheets?.[index]?.Hidden), date1904: workbook.Workbook?.WBProps?.date1904 === true, rows };
  });
  const bytesHash = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  const fileHash = [...new Uint8Array(bytesHash)].map((value) => value.toString(16).padStart(2, "0")).join("");

  const entries: OccupancyImportEntry[] = [];
  const sheetInfo: ParsedOccupancyImport["sheets"] = [];
  const globalYears = new Set<number>();
  let missingYear = false;
  let blankCount = 0;
  let ignoredCount = 0;
  const pendingScale: ParsedOccupancyImport["scaleDecisions"] = [];
  let index = 0;
  const isInstructionSheet = (name: string) => {
    const normalized = name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pt-BR").replace(/[^a-z0-9]/g, "");
    return normalized === "modelo" || normalized === "comousar"
      || normalized === "resumomodalidademes" || normalized === "comparacaoporhorario";
  };
  const appendUnmapped = (source: SourceSheet, rowIndex: number, cells: Cell[], reason: string) => {
    index += 1;
    if (index > MAX_ROWS) throw new Error("A planilha contém mais de 25 mil registros possíveis. Divida a planilha em arquivos menores.");
    entries.push({
      index, sourceSheet: source.name, sourceCell: cells[0]?.address ?? cellAddress(source, rowIndex, 0),
      sourceCells: Object.fromEntries(cells.slice(0, 4).map((cell, position) => [position === 0 ? "period" : `field${position}`, cell.address])),
      kind: null, period: null, modalityName: null, percentage: null, reportedPercentage: null,
      presences: null, capacity: null, aggregatorPresences: null, startTime: null, endTime: null, className: null, status: "pending", reason,
    });
  };

  const append = (
    source: SourceSheet,
    block: Block,
    rowIndex: number,
    periodCell: Cell | undefined,
    modalityCell: Cell | undefined,
    percentageCell: Cell | undefined,
    classCell: Cell | undefined,
    forceMonthly?: boolean,
    knownYears: number[] = [],
    yearHintOverride?: number,
    measurementCells?: {
      timeCell?: Cell;
      startTimeCell?: Cell;
      endTimeCell?: Cell;
      presenceCapacityCell?: Cell;
      presencesCell?: Cell;
      capacityCell?: Cell;
      aggregatorCell?: Cell;
    },
  ) => {
    index += 1;
    if (index > MAX_ROWS) throw new Error("A planilha contém mais de 25 mil registros possíveis. Divida a planilha em arquivos menores.");
    const hasMeasurementColumns = Boolean(measurementCells && (
      block.presenceCapacityColumn !== undefined || block.presencesColumn !== undefined || block.capacityColumn !== undefined
    ));
    const sourceCells: Record<string, string> = {};
    if (periodCell) sourceCells.period = periodCell.address;
    if (modalityCell) sourceCells.modality = modalityCell.address;
    if (percentageCell) sourceCells.percentage = percentageCell.address;
    if (measurementCells?.timeCell) sourceCells.startTime = measurementCells.timeCell.address;
    if (measurementCells?.startTimeCell) sourceCells.startTime = measurementCells.startTimeCell.address;
    if (measurementCells?.endTimeCell && !isBlank(measurementCells.endTimeCell.value)) sourceCells.endTime = measurementCells.endTimeCell.address;
    if (measurementCells?.presenceCapacityCell) {
      sourceCells.presences = measurementCells.presenceCapacityCell.address;
      sourceCells.capacity = measurementCells.presenceCapacityCell.address;
    }
    if (measurementCells?.presencesCell) sourceCells.presences = measurementCells.presencesCell.address;
    if (measurementCells?.capacityCell) sourceCells.capacity = measurementCells.capacityCell.address;
    if (measurementCells?.aggregatorCell && !isBlank(measurementCells.aggregatorCell.value)) {
      sourceCells.aggregatorPresences = measurementCells.aggregatorCell.address;
    }
    if (classCell && !isBlank(classCell.value)) sourceCells.class = classCell.address;
    const periodHint = periodCell ? rowYearHint(source, rowIndex, periodCell.column, block.yearColumn) : undefined;
    const yearHint = periodHint ?? yearHintOverride ?? (knownYears.length === 1 ? knownYears[0] : undefined) ?? options.missingYear;
    let resolved: Period | null = null;
    let periodError: string | null = null;
    if (periodCell) {
      resolved = readPeriod(periodCell.value, source.date1904, forceMonthly ?? block.forceMonthly, yearHint);
      if (!resolved) periodError = cellError(periodCell, "Data/competência");
    }
    const rawModality = String(modalityCell?.value ?? "").trim().replace(/\s+/g, " ");
    const modalityError = modalityCell?.formula && isBlank(modalityCell.value)
      ? `Fórmula sem resultado em ${modalityCell.address}.`
      : !rawModality ? (modalityCell ? `Modalidade ausente em ${modalityCell.address}.` : "Modalidade não identificada nesta linha.") : rawModality.length > 120 ? "Modalidade acima de 120 caracteres." : null;
    const pctResult = finalizePercentage(percentageCell, options.scaleDecisions?.[block.scaleKey] ?? block.inferredScale, hasMeasurementColumns);
    let presences: number | null = null;
    let capacity: number | null = null;
    let aggregatorPresences: number | null = null;
    const countErrors: string[] = [];
    if (hasMeasurementColumns) {
      if (measurementCells?.presenceCapacityCell) {
        const parsedCounts = parsePresenceCapacityCell(measurementCells.presenceCapacityCell);
        presences = parsedCounts.presences;
        capacity = parsedCounts.capacity;
        if (parsedCounts.error) countErrors.push(parsedCounts.error);
      } else {
        const parsedPresences = parseCountCell(measurementCells?.presencesCell, "Presenças", true);
        const parsedCapacity = parseCountCell(measurementCells?.capacityCell, "Vagas", false);
        presences = parsedPresences.value;
        capacity = parsedCapacity.value;
        if (parsedPresences.error) countErrors.push(parsedPresences.error);
        if (parsedCapacity.error) countErrors.push(parsedCapacity.error);
      }
    }
    if (measurementCells?.aggregatorCell && !isBlank(measurementCells.aggregatorCell.value)) {
      const parsedAggregators = parseCountCell(measurementCells.aggregatorCell, "Agregadores", true);
      aggregatorPresences = parsedAggregators.value;
      if (parsedAggregators.error) countErrors.push(parsedAggregators.error);
      if (!hasMeasurementColumns || presences === null) {
        countErrors.push("Informe presenças e capacidade para cadastrar agregadores.");
      }
      if (aggregatorPresences !== null && presences !== null && aggregatorPresences > presences) {
        countErrors.push("Agregadores não pode ultrapassar o total de presenças.");
      }
    }
    const timeResult = measurementCells?.timeCell
      ? parseTimeCell(measurementCells.timeCell, true)
      : measurementCells?.startTimeCell
        ? parseTimeCell(measurementCells.startTimeCell, false)
        : { startTime: null, endTime: null, error: "Horário inicial ausente." };
    const endTimeResult = measurementCells?.endTimeCell && !isBlank(measurementCells.endTimeCell.value)
      ? parseTimeCell(measurementCells.endTimeCell, false)
      : null;
    const startTime = timeResult.startTime;
    const endTime = endTimeResult?.startTime ?? timeResult.endTime;
    if (measurementCells?.timeCell && timeResult.endTime) sourceCells.endTime = measurementCells.timeCell.address;
    const errors: string[] = [];
    if (periodError) errors.push(periodError);
    if (modalityError) errors.push(modalityError);
    if (pctResult.error) errors.push(pctResult.error);
    errors.push(...countErrors);
    if (hasMeasurementColumns) {
      if (timeResult.error) errors.push(timeResult.error);
      if (endTimeResult?.error) errors.push(endTimeResult.error);
      if (resolved?.kind !== "daily") errors.push("Aulas com presenças e vagas precisam de uma data diária, não apenas de mês/ano.");
    }
    const computedPercentage = presences !== null && capacity !== null && capacity > 0
      ? Number((presences / capacity * 100).toFixed(6))
      : null;
    if (hasMeasurementColumns && computedPercentage !== null && pctResult.value !== null
      && Math.abs(computedPercentage - pctResult.value) > 0.5) {
      errors.push(`Ocupação informada ${pctResult.value}% diverge da calculada ${computedPercentage}% em mais de 0,5 ponto percentual; revise antes de importar.`);
    }
    const unresolvedYear = resolved?.missingYear === true && !options.missingYear;
    if (unresolvedYear) {
      missingYear = true;
      errors.push("Ano não informado. Escolha o ano uma única vez para os meses sem ano neste lote.");
    }
    const needsScale = !pctResult.error && "ambiguous" in pctResult && pctResult.ambiguous === true
      && !options.scaleDecisions?.[block.scaleKey] && !block.inferredScale;
    if (needsScale) {
      if (!pendingScale.some((item) => item.key === block.scaleKey)) {
        pendingScale.push({ key: block.scaleKey, sheet: source.name, column: block.scaleColumn, example: `${String(percentageCell?.value ?? "")} (${percentageCell?.address ?? "sem endereço"})` });
      }
      errors.push("Escala ambígua. Confirme se os números sem símbolo representam 0–100% ou 0–1 antes de importar.");
    }
    const validMeasurements = hasMeasurementColumns
      ? presences !== null && capacity !== null && capacity > 0 && Boolean(startTime) && resolved?.kind === "daily"
      : Boolean(percentageCell && pctResult.value !== null);
    const validSource = Boolean(periodCell && modalityCell && validMeasurements);
    const missing = errors.length > 0 || !resolved?.value || !rawModality || !validSource;
    const sparseData = [periodCell, modalityCell, percentageCell, measurementCells?.timeCell,
      measurementCells?.startTimeCell, measurementCells?.endTimeCell, measurementCells?.presenceCapacityCell,
      measurementCells?.presencesCell, measurementCells?.capacityCell, measurementCells?.aggregatorCell]
      .filter((cell) => cell && !isBlank(cell.value)).length;
    const status = missing ? "pending" : "ready";
    entries.push({
      index, sourceSheet: source.name,
      sourceCell: measurementCells?.presenceCapacityCell?.address
        ?? measurementCells?.presencesCell?.address
        ?? percentageCell?.address
        ?? cellAddress(source, rowIndex, block.percentageColumn ?? block.presenceCapacityColumn ?? block.presencesColumn ?? 0),
      sourceCells, kind: resolved?.kind ?? null, period: resolved?.value ?? null,
      modalityName: rawModality || null,
      percentage: computedPercentage ?? pctResult.value,
      reportedPercentage: computedPercentage === null ? null : pctResult.value,
      presences, capacity, aggregatorPresences, startTime, endTime,
      className: classCell && !isBlank(classCell.value) ? String(classCell.value).trim().replace(/\s+/g, " ") : null,
      status: !validSource && sparseData === 0 ? "ignored" : status,
      reason: !validSource && sparseData === 0 ? "Linha sem dados de ocupação." : errors.join(" ") || "Pronto para conferência.",
      scaleKey: needsScale ? block.scaleKey : null,
    });
  };

  for (const source of sourceSheets) {
    if (isInstructionSheet(source.name)) {
      ignoredCount += source.rows.size;
      continue;
    }
    const knownYears = sheetYears(`${filename} ${source.name}`, source.rows);
    for (const year of knownYears) globalYears.add(year);
    const rowIndices = [...source.rows.keys()].sort((a, b) => a - b);
    if (rowIndices.length) {
      blankCount += rowIndices[0];
      for (let position = 1; position < rowIndices.length; position += 1) blankCount += rowIndices[position] - rowIndices[position - 1] - 1;
    }
    const blocks: Block[] = [];
    for (const rowIndex of rowIndices) {
      const block = createBlock(source, rowIndex, knownYears);
      if (block) blocks.push(block);
    }
    const usableBlocks = blocks.filter((block) => !block.ambiguousPeriod);
    for (const block of usableBlocks) block.inferredScale = inferBlockScale(source, block);
    if (!usableBlocks.length) {
      for (const rowIndex of rowIndices) {
        const row = source.rows.get(rowIndex)!;
        const cells = [...row.values()].filter((cell) => !isBlank(cell.value));
        if (isTotalRow(row)) { ignoredCount += 1; continue; }
        if (headerFields(row).size >= 2) { ignoredCount += 1; continue; }
        if (cells.length <= 1 && cells.every((cell) => typeof cell.value === "string" && !parsePercent(cell.value).explicitPercent)) {
          ignoredCount += 1;
          continue;
        }
        appendUnmapped(source, rowIndex, cells, `Cabeçalho não identificado com segurança. Confira data/mês, modalidade e percentual${cells[0] ? ` próximo de ${cells[0].address}` : ""}.`);
      }
      continue;
    }
    const headerRows = new Set(blocks.map((block) => block.headerRow));
    for (const rowIndex of rowIndices) if (headerFields(source.rows.get(rowIndex)!).size >= 2) headerRows.add(rowIndex);
    const selectedBlock = (row: number) => [...blocks].filter((block) => block.headerRow < row).at(-1);
    for (const rowIndex of rowIndices) {
      const cells = source.rows.get(rowIndex)!;
      const repeatingHeader = createBlock(source, rowIndex, knownYears);
      const fields = headerFields(cells);
      const unresolvedHeader = fields.size >= 2 && ([...fields.values()].some((columns) => columns.length > 1) || !repeatingHeader);
      if (headerRows.has(rowIndex) || repeatingHeader || unresolvedHeader || isTotalRow(cells)) {
        if (headerRows.has(rowIndex) || repeatingHeader || unresolvedHeader) ignoredCount += 1;
        if (isTotalRow(cells)) ignoredCount += 1;
        continue;
      }
      const block = selectedBlock(rowIndex);
      const latestHeader = [...headerRows].filter((headerRow) => headerRow < rowIndex).at(-1);
      if (!block || block.ambiguousPeriod || (latestHeader !== undefined && block.headerRow < latestHeader)) {
        const populated = [...cells.values()].filter((cell) => !isBlank(cell.value));
        if (!populated.length) blankCount += 1;
        else appendUnmapped(source, rowIndex, populated, block?.ambiguousPeriod
          ? "Cabeçalho ambíguo; verifique as colunas antes de importar."
          : "Dados abaixo de um cabeçalho não identificado; nenhum valor foi enviado.");
        continue;
      }
      const yearsInRow = [...cells.values()].map((cell) => asYear(cell.value)).filter((year): year is number => year !== null);
      for (const year of yearsInRow) globalYears.add(year);
      if (block.kind === "records") {
        const periodCell = cells.get(block.periodColumn!);
        const modalityCell = cells.get(block.modalityColumn!);
        const percentageCell = block.percentageColumn === undefined ? undefined : cells.get(block.percentageColumn);
        const classCell = block.classColumn === undefined ? undefined : cells.get(block.classColumn);
        const timeCell = block.timeColumn === undefined ? undefined : cells.get(block.timeColumn);
        const startTimeCell = block.startTimeColumn === undefined ? undefined : cells.get(block.startTimeColumn);
        const endTimeCell = block.endTimeColumn === undefined ? undefined : cells.get(block.endTimeColumn);
        const presenceCapacityCell = block.presenceCapacityColumn === undefined ? undefined : cells.get(block.presenceCapacityColumn);
        const presencesCell = block.presencesColumn === undefined ? undefined : cells.get(block.presencesColumn);
        const capacityCell = block.capacityColumn === undefined ? undefined : cells.get(block.capacityColumn);
        const aggregatorCell = block.aggregatorColumn === undefined ? undefined : cells.get(block.aggregatorColumn);
        if ([periodCell, modalityCell, percentageCell, classCell, timeCell, startTimeCell, endTimeCell,
          presenceCapacityCell, presencesCell, capacityCell, aggregatorCell].every((cell) => !cell || isBlank(cell.value))) continue;
        const rowYear = block.yearColumn === undefined ? undefined : asYear(cells.get(block.yearColumn)?.value);
        if (rowYear) globalYears.add(rowYear);
        append(source, block, rowIndex, periodCell, modalityCell, percentageCell, classCell, block.forceMonthly,
          rowYear ? [rowYear] : knownYears, undefined,
          { timeCell, startTimeCell, endTimeCell, presenceCapacityCell, presencesCell, capacityCell, aggregatorCell });
      } else if (block.kind === "modality-months") {
        const modalityCell = cells.get(block.modalityColumn!);
        if (!modalityCell || isBlank(modalityCell.value)) { ignoredCount += 1; continue; }
        const classCell = block.classColumn === undefined ? undefined : cells.get(block.classColumn);
        for (const monthColumn of block.monthColumns ?? []) {
          const percentageCell = cells.get(monthColumn.column);
          if (!percentageCell || isBlank(percentageCell.value)) continue;
          const periodCell = source.rows.get(block.headerRow)?.get(monthColumn.column);
          const hint = headerYearHint(source, block.headerRow, monthColumn.column, knownYears);
          const monthPeriod = readPeriod(periodCell?.value, source.date1904, true, hint ?? options.missingYear);
          append(source, block, rowIndex, periodCell, modalityCell, percentageCell, classCell, true, knownYears, hint);
          const current = entries.at(-1)!;
          if (monthPeriod) { current.period = monthPeriod.value; current.kind = "monthly"; }
          if (monthPeriod?.missingYear && !options.missingYear) {
            current.status = "pending"; current.reason += " Ano não informado; defina-o para esta aba.";
            missingYear = true;
          }
        }
      } else {
        const periodCell = cells.get(block.periodColumn!);
        if (!periodCell || isBlank(periodCell.value)) {
          const populated = (block.modalityColumns ?? []).filter(({ column }) => !isBlank(cells.get(column)?.value));
          for (const item of populated) append(source, block, rowIndex, undefined, undefined, cells.get(item.column), undefined, false);
          continue;
        }
        const year = block.yearColumn === undefined ? undefined : asYear(cells.get(block.yearColumn)?.value);
        for (const modality of block.modalityColumns ?? []) {
          const percentageCell = cells.get(modality.column);
          if (!percentageCell || isBlank(percentageCell.value)) continue;
          const virtualModalityCell: Cell = { address: cellAddress(source, rowIndex, modality.column), column: modality.column, value: modality.name, format: "" };
          const classCell = block.classColumn === undefined ? undefined : cells.get(block.classColumn);
           append(source, block, rowIndex, periodCell, virtualModalityCell, percentageCell, classCell, false, year ? [year] : knownYears);
        }
      }
    }
  }

  const explicitYears = [...globalYears].filter((year) => year >= 1 && year <= 9999).sort();
  const seen = new Map<string, OccupancyImportEntry>();
  const monthlyAndDaily = new Map<string, OccupancyImportEntry[]>();
  for (const entry of entries) {
    if (entry.status !== "ready" || !entry.period || !entry.modalityName || entry.kind === null) continue;
    const scope = `${normalize(entry.modalityName)}\u0000${entry.period.slice(0, 7)}\u0000${normalize(entry.className ?? "")}`;
    const representations = monthlyAndDaily.get(scope) ?? [];
    representations.push(entry);
    monthlyAndDaily.set(scope, representations);
    const key = `${normalize(entry.modalityName)}\u0000${entry.kind}\u0000${entry.period}\u0000${normalize(entry.className ?? "")}\u0000${entry.startTime ?? ""}`;
    const prior = seen.get(key);
    if (prior) {
      const overlapKey = `same-scope\u0000${key}`;
      prior.overlapKey = overlapKey;
      entry.overlapKey = overlapKey;
      if (prior.sourceSheet === entry.sourceSheet) {
        entry.reason = `Escopo repetido no arquivo em ${prior.sourceCell}. Marque apenas uma ocorrência para importar.`;
      }
    } else seen.set(key, entry);
  }
  for (const [scope, group] of monthlyAndDaily) {
    if (!group.some((entry) => entry.kind === "daily") || !group.some((entry) => entry.kind === "monthly")) continue;
    const overlapKey = `daily-monthly\u0000${scope}`;
    for (const entry of group) {
      entry.overlapKey = overlapKey;
      entry.reason += " Há registros diários e um resumo mensal para a mesma modalidade/mês; escolha uma representação antes de importar.";
    }
  }
  for (const sheet of sourceSheets) {
    const sheetEntries = entries.filter((entry) => entry.sourceSheet === sheet.name);
    sheetInfo.push({ name: sheet.name, hidden: sheet.hidden, entryCount: sheetEntries.length, selected: !sheet.hidden && sheetEntries.some((entry) => entry.status !== "ignored") });
  }
  ignoredCount += entries.filter((entry) => entry.status === "ignored").length;
  return {
    fileHash, sheets: sheetInfo, entries, missingYear,
    yearsFound: explicitYears, scaleDecisions: pendingScale,
    blankCount, ignoredCount,
  };
}

function cellError(cell: Cell | undefined, label: string) {
  if (!cell) return `${label} ausente.`;
  if (cell.error) return `Erro de fórmula em ${cell.address}: ${cell.error}.`;
  if (cell.formula && isBlank(cell.value)) return `Fórmula em ${cell.address} sem resultado calculado utilizável.`;
  return `Data/competência inválida em ${cell.address}.`;
}
