import assert from 'node:assert/strict';
import test from 'node:test';
import type { SalesScoreboard } from '@workspace/api-client-react';
import { buildFinancialChartAnalytics } from './financial-chart-data';

const report: SalesScoreboard = {
  totals: { quantity: 6, salesCents: 40000, refundCents: 27000, netCents: 13000 },
  products: [
    { productId: 'a', productName: 'Plano A', modalityId: 'm1', modalityName: 'Pilates', quantity: 2, salesCents: 30000, refundCents: 5000, netCents: 25000 },
    { productId: 'b', productName: 'Plano B', modalityId: 'm1', modalityName: 'Pilates', quantity: 1, salesCents: 10000, refundCents: 20000, netCents: -10000 },
    { productId: 'c', productName: 'Produto sem vínculo', modalityId: null, modalityName: null, quantity: 3, salesCents: 0, refundCents: 2000, netCents: -2000 },
  ],
  months: [
    { month: '2026-10', quantity: 6, salesCents: 40000, refundCents: 27000, netCents: 13000 },
  ],
  days: [
    { date: '2026-10-27', weekday: 2, quantity: 6, salesCents: 40000, refundCents: 27000, netCents: 13000 },
  ],
  weeks: [
    { weekStart: '2026-10-26', quantity: 6, salesCents: 40000, refundCents: 27000, netCents: 13000 },
  ],
};

test('groups modality totals without dropping unclassified sales', () => {
  const result = buildFinancialChartAnalytics(report);
  assert.deepEqual(result.byModality.map(({ name, quantity, salesCents, refundCents, netCents }) => (
    { name, quantity, salesCents, refundCents, netCents }
  )), [
    { name: 'Pilates', quantity: 3, salesCents: 40000, refundCents: 25000, netCents: 15000 },
    { name: 'Não classificado', quantity: 3, salesCents: 0, refundCents: 2000, netCents: -2000 },
  ]);
});

test('keeps unit quantity and reconciles product and monthly aggregates to scoreboard totals', () => {
  const result = buildFinancialChartAnalytics(report);
  assert.equal(result.byProduct.reduce((sum, row) => sum + row.quantity, 0), 6);
  assert.equal(result.reconcilesByProduct, true);
  assert.equal(result.reconcilesByMonth, true);
});

test('share charts use registered sales only and never create negative or zero slices', () => {
  const result = buildFinancialChartAnalytics(report);
  assert.deepEqual(result.salesShareByProduct.map(({ name, salesCents }) => ({ name, salesCents })), [
    { name: 'Plano A', salesCents: 30000 },
    { name: 'Plano B', salesCents: 10000 },
  ]);
  assert.deepEqual(result.salesShareByModality.map(({ name, salesCents }) => ({ name, salesCents })), [
    { name: 'Pilates', salesCents: 40000 },
  ]);
  assert.equal(result.byProduct.find(({ name }) => name === 'Plano B')?.netCents, -10000);
});

test('preserves negative monthly net values for the evolution chart', () => {
  const result = buildFinancialChartAnalytics({
    ...report,
    months: [{ month: '2026-10', quantity: 0, salesCents: 1000, refundCents: 2500, netCents: -1500 }],
  });
  assert.equal(result.months[0]?.netCents, -1500);
});
