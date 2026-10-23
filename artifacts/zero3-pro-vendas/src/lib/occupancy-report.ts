import * as XLSX from 'xlsx';
import type { OccupancyBackupSelection, OccupancyRecord } from '@workspace/api-client-react';

type EffectiveGroup = { daily: OccupancyRecord[]; monthly: OccupancyRecord[] };

const weekdayNames = ['Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado', 'Domingo'];
const occupancyColumns = [
  'Modalidade', 'Data', 'Horário inicial', 'Presenças/Vagas', 'Ocupação (%)',
  'Horário final', 'Turma', 'Observação', 'Tipo do registro', 'Percentual original (%)', 'Critério de cálculo',
];
const summaryColumns = [
  'Competência mensal', 'Modalidade agregada', 'Aulas consideradas', 'Aulas medidas', 'Registros legados',
  'Presenças somadas', 'Vagas somadas', 'Ocupação calculada (%)', 'Percentual legado (%) — média simples, sem contagens', 'Critério',
];
const timeColumns = [
  'Faixa horária', 'Modalidade analisada', 'Aulas diárias', 'Aulas medidas', 'Registros legados',
  'Presenças somadas', 'Vagas somadas', 'Ocupação calculada (%)', 'Percentual legado (%) — média simples, sem contagens',
];

function normalized(value: string | null | undefined) {
  return (value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('pt-BR');
}

function measured(record: OccupancyRecord) {
  return record.presences !== null && record.capacity !== null;
}

function completeRange(selection: OccupancyBackupSelection, month: string) {
  if (selection.mode !== 'range' || !selection.fromDate || !selection.toDate) return true;
  const [year, monthNumber] = month.split('-').map(Number);
  const end = new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
  return `${month}-01` >= selection.fromDate && end <= selection.toDate;
}

export function selectEffectiveOccupancyRecords(
  records: readonly OccupancyRecord[],
  selection: OccupancyBackupSelection,
): OccupancyRecord[] {
  const unique = [...new Map(records.map((record) => [record.id, record])).values()];
  const allowMonthly = selection.mode !== 'range'
    || unique.every((record) => record.kind !== 'monthly' || completeRange(selection, record.month));
  if (!allowMonthly || selection.startTimes?.length || selection.weekdays?.length) {
    return unique.filter((record) => record.kind === 'daily');
  }

  const scopes = new Map<string, EffectiveGroup>();
  for (const record of unique) {
    const key = JSON.stringify([record.month, record.modalityId, normalized(record.className)]);
    const group = scopes.get(key) ?? { daily: [], monthly: [] };
    group[record.kind].push(record);
    scopes.set(key, group);
  }
  const result: OccupancyRecord[] = [];
  for (const { daily, monthly } of scopes.values()) {
    const monthlyMeasured = monthly.filter(measured);
    const monthlyLegacy = monthly.filter((record) => !measured(record));
    const dailyMeasured = daily.filter(measured);
    const dailyLegacy = daily.filter((record) => !measured(record));
    result.push(...(monthlyMeasured.length ? monthlyMeasured : dailyMeasured));
    result.push(...(monthlyLegacy.length ? monthlyLegacy : dailyLegacy));
  }
  return result;
}

function numericTotal(records: readonly OccupancyRecord[], key: 'presences' | 'capacity') {
  return records.reduce((sum, record) => sum + (record[key] ?? 0), 0);
}

function average(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function dateValue(record: OccupancyRecord) {
  return record.kind === 'monthly' ? record.month : record.period;
}

function occupancyValue(record: OccupancyRecord) {
  return record.percentage;
}

function calculationCriterion(record: OccupancyRecord) {
  if (measured(record)) return 'Presenças ÷ vagas (percentual ponderado)';
  if (record.reportedPercentage !== null) return 'Percentual informado na origem; sem contagens';
  return 'Percentual legado; sem contagens';
}

function detailedRows(records: readonly OccupancyRecord[]) {
  return records.map((record) => ({
    'Modalidade': record.modalityName,
    'Data': dateValue(record),
    'Horário inicial': record.startTime ?? '',
    'Presenças/Vagas': record.presences === null || record.capacity === null ? '' : `${record.presences}/${record.capacity}`,
    'Ocupação (%)': occupancyValue(record),
    'Horário final': record.endTime ?? '',
    'Turma': record.className ?? '',
    'Observação': record.notes ?? '',
    'Tipo do registro': record.kind === 'monthly' ? 'Mensal' : 'Diário',
    'Percentual original (%)': record.reportedPercentage ?? '',
    'Critério de cálculo': calculationCriterion(record),
  }));
}

function summaryRows(records: readonly OccupancyRecord[], selection: OccupancyBackupSelection) {
  const selected = selectEffectiveOccupancyRecords(records, selection);
  const groups = new Map<string, OccupancyRecord[]>();
  for (const record of selected) {
    const key = JSON.stringify([record.month, record.modalityId]);
    const group = groups.get(key) ?? [];
    group.push(record);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const sample = group[0]!;
    const measuredRecords = group.filter(measured);
    const legacyRecords = group.filter((record) => !measured(record));
    const presences = numericTotal(measuredRecords, 'presences');
    const capacity = numericTotal(measuredRecords, 'capacity');
    return {
      'Competência mensal': sample.month,
      'Modalidade agregada': sample.modalityName,
      'Aulas consideradas': group.length,
      'Aulas medidas': measuredRecords.length,
      'Registros legados': legacyRecords.length,
      'Presenças somadas': presences,
      'Vagas somadas': capacity,
      'Ocupação calculada (%)': capacity ? presences / capacity * 100 : '',
      'Percentual legado (média simples; sem contagens)': average(legacyRecords.map((record) => record.reportedPercentage ?? record.percentage)) ?? '',
      'Critério': measuredRecords.length && legacyRecords.length ? 'Medições ponderadas e percentuais legados separados'
        : measuredRecords.length ? 'Soma de presenças ÷ soma de vagas'
          : legacyRecords.length ? 'Média somente dos percentuais legados' : 'Sem registros',
    };
  }).sort((a, b) => `${a['Competência mensal']}|${a['Modalidade agregada']}`.localeCompare(`${b['Competência mensal']}|${b['Modalidade agregada']}`));
}

function timeRows(records: readonly OccupancyRecord[]) {
  const daily = records.filter((record) => record.kind === 'daily' && record.startTime);
  const groups = new Map<string, OccupancyRecord[]>();
  for (const record of daily) {
    const key = JSON.stringify([record.startTime, record.modalityId, record.modalityName]);
    const group = groups.get(key) ?? [];
    group.push(record);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const sample = group[0]!;
    const measuredRecords = group.filter(measured);
    const legacyRecords = group.filter((record) => !measured(record));
    const presences = numericTotal(measuredRecords, 'presences');
    const capacity = numericTotal(measuredRecords, 'capacity');
    return {
      'Faixa horária': sample.startTime ?? '',
      'Modalidade analisada': sample.modalityName,
      'Aulas diárias': group.length,
      'Aulas medidas': measuredRecords.length,
      'Registros legados': legacyRecords.length,
      'Presenças somadas': presences,
      'Vagas somadas': capacity,
      'Ocupação calculada (%)': capacity ? presences / capacity * 100 : '',
      'Percentual legado (média simples; sem contagens)': average(legacyRecords.map((record) => record.reportedPercentage ?? record.percentage)) ?? '',
    };
  }).sort((a, b) => `${a['Faixa horária']}|${a['Modalidade analisada']}`.localeCompare(`${b['Faixa horária']}|${b['Modalidade analisada']}`));
}

function styleOccupancyColumns(sheet: XLSX.WorkSheet) {
  const range = XLSX.utils.decode_range(sheet['!ref'] ?? 'A1:A1');
  const percentColumns = new Set<number>();
  for (let col = 0; col <= range.e.c; col += 1) {
    const heading = String(sheet[XLSX.utils.encode_cell({ r: 0, c: col })]?.v ?? '');
    if (heading.includes('(%)')) percentColumns.add(col);
  }
  for (let row = 1; row <= range.e.r; row += 1) {
    for (const col of percentColumns) {
      const cell = sheet[XLSX.utils.encode_cell({ r: row, c: col })];
      // Valores estão em pontos percentuais (ex.: 83,33); literal % evita multiplicação por 100.
      if (cell && typeof cell.v === 'number') cell.z = '0.00"%"';
    }
  }
}

function jsonSheet(rows: Record<string, unknown>[], headers: string[]) {
  const sheet = XLSX.utils.json_to_sheet(rows, { header: headers });
  if (rows.length === 0) XLSX.utils.sheet_add_aoa(sheet, [headers], { origin: 'A1' });
  return sheet;
}

export function createOccupancyWorkbook(records: readonly OccupancyRecord[], selection: OccupancyBackupSelection) {
  const workbook = XLSX.utils.book_new();
  const detailed = jsonSheet(detailedRows(records), occupancyColumns);
  detailed['!cols'] = [22, 14, 12, 16, 16, 14, 24, 36, 18, 22, 42].map((wch) => ({ wch }));
  styleOccupancyColumns(detailed);
  XLSX.utils.book_append_sheet(workbook, detailed, 'Lançamentos');

  const summary = jsonSheet(summaryRows(records, selection), summaryColumns);
  summary['!cols'] = [14, 22, 16, 14, 16, 12, 10, 20, 36, 42].map((wch) => ({ wch }));
  styleOccupancyColumns(summary);
  XLSX.utils.book_append_sheet(workbook, summary, 'Resumo modalidade-mês');

  const times = jsonSheet(timeRows(records), timeColumns);
  times['!cols'] = [12, 22, 15, 14, 16, 12, 10, 20, 36].map((wch) => ({ wch }));
  styleOccupancyColumns(times);
  XLSX.utils.book_append_sheet(workbook, times, 'Comparação por horário');
  return workbook;
}

export function createOccupancyCsv(records: readonly OccupancyRecord[]) {
  const sheet = jsonSheet(detailedRows(records), occupancyColumns);
  return `\uFEFF${XLSX.utils.sheet_to_csv(sheet, { FS: ';', RS: '\r\n' })}`;
}

export function occupancyWeekdayName(weekday: number) {
  return weekdayNames[weekday - 1] ?? String(weekday);
}

export function occupancyReportFileName(period: string, extension: 'xlsx' | 'csv' | 'json') {
  const safe = period.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  return `ocupacao_${safe || 'periodo'}.${extension}`;
}
