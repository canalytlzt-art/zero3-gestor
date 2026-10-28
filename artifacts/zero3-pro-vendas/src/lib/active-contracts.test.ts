import assert from 'node:assert/strict';
import test from 'node:test';
import type { ActiveContractsMonth } from '@workspace/api-client-react';
import { buildActiveContractPeriodRows } from './active-contracts';

function contract(month: string, activeCount: number, targetCount: number | null): ActiveContractsMonth {
  return {
    month,
    activeCount,
    targetCount,
    notes: null,
    createdAt: `${month}-01T00:00:00.000Z`,
    updatedAt: `${month}-01T00:00:00.000Z`,
  };
}

test('calculates monthly contract difference, attainment, and change from the prior recorded month', () => {
  const rows = buildActiveContractPeriodRows(
    ['2026-09', '2026-10'],
    [contract('2026-09', 137, 160), contract('2026-10', 145, 160)],
  );

  assert.equal(rows[1].difference, -15);
  assert.equal(rows[1].attainment, 90.625);
  assert.equal(rows[1].changeFromPrevious, 8);
});

test('leaves months without balances unreported instead of filling them with zero', () => {
  const rows = buildActiveContractPeriodRows(
    ['2026-10', '2026-11'],
    [contract('2026-10', 145, 160)],
  );

  assert.equal(rows[1].record, null);
  assert.equal(rows[1].difference, null);
  assert.equal(rows[1].attainment, null);
  assert.equal(rows[1].changeFromPrevious, null);
});

test('does not divide by zero when a target is zero', () => {
  const [row] = buildActiveContractPeriodRows(
    ['2026-10'],
    [contract('2026-10', 145, 0)],
  );

  assert.equal(row.difference, 145);
  assert.equal(row.attainment, null);
});
