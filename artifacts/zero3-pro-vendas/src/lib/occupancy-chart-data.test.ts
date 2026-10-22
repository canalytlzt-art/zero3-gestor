import assert from 'node:assert/strict';
import test from 'node:test';
import type { OccupancyRecord } from '@workspace/api-client-react';
import { buildOccupancyChartAnalytics } from './occupancy-chart-data';

function record(
  id: string,
  kind: 'daily' | 'monthly',
  period: string,
  modalityId: string,
  modalityName: string,
  percentage: number,
  className: string | null = null,
): OccupancyRecord {
  const month = kind === 'daily' ? period.slice(0, 7) : period;
  return {
    id,
    kind,
    period,
    month,
    modalityId,
    modalityName,
    percentage,
    className,
    notes: null,
    sourceFileHash: null,
    sourceSheet: null,
    sourceCell: null,
    sourceCells: null,
    version: 1,
    createdAt: '2026-10-01T12:00:00.000Z',
    updatedAt: '2026-10-01T12:00:00.000Z',
  };
}

test('daily view uses only daily values and averages independent class scopes', () => {
  const analytics = buildOccupancyChartAnalytics([
    record('m', 'monthly', '2026-10', 'pilates', 'Pilates', 90, 'Noite'),
    record('d1', 'daily', '2026-10-05', 'pilates', 'Pilates', 70, 'Manhã'),
    record('d2', 'daily', '2026-10-05', 'pilates', 'Pilates', 80, 'Noite'),
    record('yoga', 'daily', '2026-10-05', 'yoga', 'Yoga', 40),
  ], {
    viewMode: 'daily',
    fromDate: '2026-10-05',
    toDate: '2026-10-05',
    modalityId: 'pilates',
  });

  assert.equal(analytics.evolution.length, 1);
  assert.equal(analytics.evolution[0].percentage, 75);
  assert.equal(analytics.evolution[0].source, 'average');
  assert.equal(analytics.donut?.occupied, 75);
  assert.equal(analytics.donut?.unoccupied, 25);
  assert.equal(analytics.comparison.find((item) => item.modalityId === 'yoga')?.percentage, 40);
});

test('monthly view prefers each class consolidated value and averages daily-only scopes', () => {
  const analytics = buildOccupancyChartAnalytics([
    record('daily-a1', 'daily', '2026-10-01', 'pilates', 'Pilates', 50, 'Manhã'),
    record('daily-a2', 'daily', '2026-10-02', 'pilates', 'Pilates', 70, 'Manhã'),
    record('monthly-a', 'monthly', '2026-10', 'pilates', 'Pilates', 80, 'Manhã'),
    record('daily-b', 'daily', '2026-10-01', 'pilates', 'Pilates', 60, 'Noite'),
  ], {
    viewMode: 'monthly',
    selectedMonths: ['2026-10'],
    modalityId: 'pilates',
  });

  assert.equal(analytics.supportRows.length, 2);
  assert.deepEqual(analytics.supportRows.map((row) => row.percentage), [80, 60]);
  assert.equal(analytics.evolution[0].percentage, 70);
  assert.equal(analytics.evolution[0].source, 'average');
  assert.equal(analytics.donut?.occupied, 70);
});

test('partial-month interval ignores monthly records and uses only daily entries', () => {
  const analytics = buildOccupancyChartAnalytics([
    record('monthly', 'monthly', '2026-10', 'pilates', 'Pilates', 95),
    record('daily', 'daily', '2026-10-10', 'pilates', 'Pilates', 55),
  ], {
    viewMode: 'monthly',
    fromDate: '2026-10-10',
    toDate: '2026-10-20',
    modalityId: 'pilates',
  });

  assert.equal(analytics.evolution.length, 1);
  assert.equal(analytics.evolution[0].percentage, 55);
  assert.equal(analytics.evolution[0].source, 'average');
});

test('multi-month indicators average available month results and never fill missing months with zero', () => {
  const analytics = buildOccupancyChartAnalytics([
    record('oct', 'monthly', '2026-10', 'pilates', 'Pilates', 60),
    record('dec', 'monthly', '2026-12', 'pilates', 'Pilates', 80),
  ], {
    viewMode: 'monthly',
    selectedMonths: ['2026-10', '2026-11', '2026-12'],
    modalityId: 'pilates',
  });

  assert.deepEqual(analytics.evolution.map((point) => point.percentage), [60, null, 80]);
  assert.equal(analytics.donut?.occupied, 70);
  assert.equal(analytics.donut?.coveredPeriods, 2);
  assert.equal(analytics.donut?.availablePeriods, 3);
});

test('daily evolution leaves missing dates null instead of turning them into zero-percent bars', () => {
  const analytics = buildOccupancyChartAnalytics([
    record('d1', 'daily', '2026-10-01', 'pilates', 'Pilates', 50),
    record('d2', 'daily', '2026-10-03', 'pilates', 'Pilates', 70),
  ], {
    viewMode: 'daily',
    selectedMonths: ['2026-10'],
    modalityId: 'pilates',
  });

  assert.equal(analytics.evolution.length, 31);
  assert.equal(analytics.evolution[0].percentage, 50);
  assert.equal(analytics.evolution[1].percentage, null);
  assert.equal(analytics.evolution[2].percentage, 70);
  assert.equal(analytics.donut?.coveredPeriods, 2);
  assert.equal(analytics.donut?.availablePeriods, 31);
});

test('modality comparison keeps independent modalities separate and reports period coverage', () => {
  const analytics = buildOccupancyChartAnalytics([
    record('a1', 'monthly', '2026-09', 'pilates', 'Pilates', 40),
    record('a2', 'monthly', '2026-10', 'pilates', 'Pilates', 80),
    record('b1', 'monthly', '2026-10', 'yoga', 'Yoga', 25),
  ], { viewMode: 'monthly', selectedMonths: ['2026-09', '2026-10'] });

  assert.equal(analytics.comparison.find((item) => item.modalityId === 'pilates')?.percentage, 60);
  assert.equal(analytics.comparison.find((item) => item.modalityId === 'pilates')?.coveredPeriods, 2);
  assert.equal(analytics.comparison.find((item) => item.modalityId === 'yoga')?.percentage, 25);
  assert.equal(analytics.comparison.find((item) => item.modalityId === 'yoga')?.coveredPeriods, 1);
});
