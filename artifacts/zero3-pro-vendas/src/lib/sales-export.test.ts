import assert from 'node:assert/strict';
import test from 'node:test';
import { parseMonthlySalesBackup } from './sales-export';

const emptyPeriodBackup = {
  format: 'zero3-pro-financial-backup',
  schemaVersion: 3,
  module: 'sales',
  origin: 'zero3-pro-financial-database',
  generatedAt: '2026-10-23T15:00:00.000Z',
  period: '2026-10',
  selection: { mode: 'months', months: ['2026-10'], productName: null },
  partial: true,
  currency: 'BRL',
  businessTimezone: 'America/Sao_Paulo',
  counts: {
    periodSales: 0,
    periodRefunds: 0,
    periodGoals: 0,
    dependencySales: 0,
    dependencyRefunds: 0,
    products: 0,
    histories: 0,
    totalRecords: 0,
  },
  totals: { salesCents: 0, refundsCents: 0, netCents: 0, quantity: 0 },
  products: [],
  sales: [],
  refunds: [],
  goals: [],
  histories: [],
};

test('opens a serialized v3 financial backup and rejects inconsistent counts', () => {
  const fileContents = JSON.stringify(emptyPeriodBackup);
  const parsed = parseMonthlySalesBackup(JSON.parse(fileContents));
  assert.equal('schemaVersion' in parsed && parsed.schemaVersion, 3);
  assert.deepEqual(parsed.selection, emptyPeriodBackup.selection);

  assert.throws(() => parseMonthlySalesBackup({
    ...emptyPeriodBackup,
    counts: { ...emptyPeriodBackup.counts, totalRecords: 1 },
  }), /quantidade total/i);
});

