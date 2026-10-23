import assert from 'node:assert/strict';
import test from 'node:test';
import * as XLSX from 'xlsx';
import type { OccupancyBackupSelection, OccupancyRecord } from '@workspace/api-client-react';
import { parseOccupancySpreadsheet } from './occupancy-import';
import {
  createOccupancyCsv,
  createOccupancyWorkbook,
  selectEffectiveOccupancyRecords,
} from './occupancy-report';

function record(
  id: string,
  values: Partial<OccupancyRecord> = {},
): OccupancyRecord {
  const base: OccupancyRecord = {
    id,
    kind: 'daily',
    period: '2026-07-01',
    month: '2026-07',
    modalityId: 'a0fdfb5a-7d50-46c8-8be3-174ee9720de5',
    modalityName: 'Pilates',
    percentage: 0,
    reportedPercentage: null,
    presences: 0,
    capacity: 18,
    startTime: '06:00',
    endTime: null,
    className: 'Manhã',
    notes: null,
    sourceFileHash: null,
    sourceSheet: null,
    sourceCell: null,
    sourceCells: null,
    version: 1,
    createdAt: '2026-07-01T10:00:00.000Z',
    updatedAt: '2026-07-01T10:00:00.000Z',
  };
  return { ...base, ...values };
}

const july: OccupancyBackupSelection = { mode: 'months', months: ['2026-07'] };

test('uses weighted occupancy, retains zero and above-capacity values, and separates legacy rows', () => {
  const rows = [
    record('one-of-two', { period: '2026-07-01', percentage: 50, presences: 1, capacity: 2 }),
    record('nine-of-ten', { period: '2026-07-02', percentage: 90, presences: 9, capacity: 10 }),
    record('zero', { period: '2026-07-03', percentage: 0, presences: 0, capacity: 18, startTime: '07:00' }),
    record('over', { period: '2026-07-04', percentage: 105.555556, presences: 19, capacity: 18, startTime: '07:00' }),
    record('legacy', {
      kind: 'monthly', period: '2026-07', percentage: 76.5, reportedPercentage: 76.5,
      presences: null, capacity: null, startTime: null, endTime: null,
    }),
  ];
  const effective = selectEffectiveOccupancyRecords(rows, july);
  const measured = effective.filter((item) => item.presences !== null && item.capacity !== null);
  const totalPresences = measured.reduce((sum, item) => sum + (item.presences ?? 0), 0);
  const totalCapacity = measured.reduce((sum, item) => sum + (item.capacity ?? 0), 0);
  assert.equal(totalPresences, 29);
  assert.equal(totalCapacity, 48);
  const weightedPair = selectEffectiveOccupancyRecords(rows.slice(0, 2), july);
  assert.equal(
    (weightedPair.reduce((sum, item) => sum + (item.presences ?? 0), 0)
      / weightedPair.reduce((sum, item) => sum + (item.capacity ?? 0), 0) * 100).toFixed(2),
    '83.33',
  );
  assert.equal(effective.find((item) => item.id === 'zero')?.percentage, 0);
  assert.ok((effective.find((item) => item.id === 'over')?.percentage ?? 0) > 100);
  assert.ok(effective.includes(rows[4]!));

  const workbook = createOccupancyWorkbook(rows, july);
  const detailRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets.Lançamentos!);
  assert.equal(detailRows.find((item) => item['Data'] === '2026-07-03')?.['Presenças/Vagas'], '0/18');
  assert.equal(detailRows.find((item) => item['Data'] === '2026-07-03')?.['Ocupação (%)'], 0);
  assert.equal(detailRows.find((item) => item['Data'] === '2026-07-04')?.['Presenças/Vagas'], '19/18');
  assert.equal(detailRows.find((item) => item['Data'] === '2026-07-04')?.['Ocupação (%)'], 105.555556);
  assert.equal(detailRows.find((item) => item['Tipo do registro'] === 'Mensal')?.['Presenças/Vagas'], '');
  assert.equal(detailRows.find((item) => item['Tipo do registro'] === 'Mensal')?.['Percentual original (%)'], 76.5);
  const summaryRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets['Resumo modalidade-mês']!);
  assert.equal(summaryRows[0]?.['Presenças somadas'], 29);
  assert.equal(summaryRows[0]?.['Vagas somadas'], 48);
  assert.equal(summaryRows[0]?.['Ocupação calculada (%)'], 29 / 48 * 100);
});

test('partial date ranges do not include monthly summaries and exports beyond a visible page', () => {
  const daily = record('daily', { period: '2026-07-10', percentage: 50, presences: 1, capacity: 2 });
  const monthly = record('legacy-month', {
    kind: 'monthly', period: '2026-07', percentage: 80, reportedPercentage: 80,
    presences: null, capacity: null, startTime: null, endTime: null,
  });
  const partial: OccupancyBackupSelection = { mode: 'range', fromDate: '2026-07-02', toDate: '2026-07-30' };
  assert.deepEqual(selectEffectiveOccupancyRecords([daily, monthly], partial).map((item) => item.id), ['daily']);

  const many = Array.from({ length: 501 }, (_, index) => record(`row-${index}`, {
    period: `2026-07-${String((index % 28) + 1).padStart(2, '0')}`,
  }));
  const workbook = createOccupancyWorkbook(many, july);
  const details = XLSX.utils.sheet_to_json(workbook.Sheets.Lançamentos!, { header: 1 }) as unknown[][];
  assert.equal(details.length, 502);
  assert.equal(details[0]?.[0], 'Modalidade');
  assert.equal(details[0]?.[1], 'Data');
  assert.equal(details[0]?.[3], 'Presenças/Vagas');
  assert.equal(details[0]?.[4], 'Ocupação (%)');
  assert.ok(details[0]?.includes('Horário final'));
  const csv = createOccupancyCsv([record('with-end', { endTime: '07:00' })]);
  assert.ok(csv.includes('Horário final'));
  assert.ok(csv.includes('07:00'));
  assert.ok(csv.startsWith('\uFEFF'));
});

test('the detailed workbook keeps the importer-compatible headers and reopens with end times and counts', async () => {
  const source = record('roundtrip', {
    percentage: 55.555556,
    presences: 10,
    capacity: 18,
    endTime: '07:00',
    notes: 'Aula de teste',
  });
  const workbook = createOccupancyWorkbook([source], july);
  const bytes = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
  const parsed = await parseOccupancySpreadsheet(bytes, 'relatorio-de-ocupacao.xlsx');
  assert.equal(parsed.entries.length, 1, JSON.stringify(parsed.entries.map((entry) => ({
    sourceSheet: entry.sourceSheet, period: entry.period, modalityName: entry.modalityName,
    status: entry.status, reason: entry.reason, startTime: entry.startTime,
  }))));
  assert.equal(parsed.entries[0]?.presences, 10, JSON.stringify(parsed.entries[0]));
  assert.equal(parsed.entries[0]?.capacity, 18);
  assert.equal(parsed.entries[0]?.startTime, '06:00');
  assert.equal(parsed.entries[0]?.endTime, '07:00');
});
