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
  startTime: string | null = null,
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
    reportedPercentage: null,
    presences: null,
    capacity: null,
    startTime,
    endTime: null,
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
  assert.equal(analytics.donut, null);
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
  assert.equal(analytics.donut, null);
});

test('monthly analytics keeps real presences and capacity for the complete dashboard', () => {
  const analytics = buildOccupancyChartAnalytics([
    { ...record('oct-measured', 'monthly', '2026-10', 'pilates', 'Pilates', 50), presences: 12, capacity: 20 },
  ], {
    viewMode: 'monthly',
    selectedMonths: ['2026-10'],
    modalityId: 'pilates',
  });

  assert.deepEqual(
    {
      percentage: analytics.evolution[0]?.percentage,
      presences: analytics.evolution[0]?.presences,
      capacity: analytics.evolution[0]?.capacity,
      source: analytics.evolution[0]?.source,
    },
    { percentage: 60, presences: 12, capacity: 20, source: 'weighted' },
  );
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
  assert.equal(analytics.evolution[0].source, 'reported');
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
  assert.equal(analytics.donut, null);
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
  assert.equal(analytics.evolution.filter((point) => point.percentage !== null).length, 2);
  assert.equal(analytics.donut, null);
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

test('legacy donut is limited to one observation in one selected modality and period', () => {
  const single = record('single', 'daily', '2026-10-05', 'pilates', 'Pilates', 75);
  const filters = {
    viewMode: 'daily' as const,
    fromDate: '2026-10-05',
    toDate: '2026-10-05',
    modalityId: 'pilates',
  };

  const oneObservation = buildOccupancyChartAnalytics([single], filters);
  assert.equal(oneObservation.donut?.occupied, 75);
  assert.equal(oneObservation.donut?.source, 'reported');

  const sameModalityOtherClass = record('second-class', 'daily', '2026-10-05', 'pilates', 'Pilates', 45, 'Noite');
  assert.equal(buildOccupancyChartAnalytics([single, sameModalityOtherClass], filters).donut, null);

  const otherModality = record('yoga', 'daily', '2026-10-05', 'yoga', 'Yoga', 65);
  assert.equal(buildOccupancyChartAnalytics([single, otherModality], {
    ...filters,
    modalityId: undefined,
  }).donut, null);
});

test('measured classes use weighted totals across dates and keep legacy percentages separate', () => {
  const analytics = buildOccupancyChartAnalytics([
    { ...record('small', 'daily', '2026-10-01', 'crossfit', 'CrossFit', 50), presences: 1, capacity: 2 },
    { ...record('large', 'daily', '2026-10-02', 'crossfit', 'CrossFit', 90), presences: 9, capacity: 10 },
    record('legacy', 'daily', '2026-10-02', 'crossfit', 'CrossFit', 40, 'legado'),
  ], {
    viewMode: 'daily',
    selectedMonths: ['2026-10'],
    modalityId: 'crossfit',
  });

  assert.equal(analytics.supportRows.length, 3);
  assert.equal(analytics.comparison[0].percentage, (10 / 12) * 100);
  assert.equal(analytics.comparison[0].source, 'weighted');
  assert.equal(analytics.donut?.occupied, (10 / 12) * 100);
  assert.equal(analytics.supportRows.find((row) => row.source === 'reported')?.percentage, 40);
  assert.equal(analytics.supportRows.find((row) => row.source === 'weighted')?.presences, 1);
});

test('quarter-like selected month sets aggregate monthly measured records from total presence and capacity', () => {
  const analytics = buildOccupancyChartAnalytics([
    { ...record('jan', 'daily', '2026-01-10', 'crossfit', 'CrossFit', 50), presences: 1, capacity: 2 },
    { ...record('feb', 'daily', '2026-02-10', 'crossfit', 'CrossFit', 90), presences: 9, capacity: 10 },
  ], {
    viewMode: 'monthly',
    selectedMonths: ['2026-01', '2026-02', '2026-03'],
    modalityId: 'crossfit',
  });

  assert.deepEqual(analytics.evolution.map((point) => point.percentage), [50, 90, null]);
  assert.equal(analytics.donut?.occupied, (10 / 12) * 100);
  assert.equal(analytics.donut?.source, 'weighted');
});

test('monthly legacy percentages remain separate from weighted daily classes in the same scope', () => {
  const analytics = buildOccupancyChartAnalytics([
    { ...record('d1', 'daily', '2026-10-01', 'crossfit', 'CrossFit', 50, 'Manhã'), presences: 1, capacity: 2 },
    { ...record('d2', 'daily', '2026-10-02', 'crossfit', 'CrossFit', 90, 'Manhã'), presences: 9, capacity: 10 },
    record('legacy-month', 'monthly', '2026-10', 'crossfit', 'CrossFit', 75, 'Manhã'),
  ], {
    viewMode: 'monthly',
    selectedMonths: ['2026-10'],
    modalityId: 'crossfit',
  });

  assert.equal(analytics.supportRows.length, 2);
  assert.equal(analytics.supportRows.find((row) => row.source === 'reported')?.percentage, 75);
  assert.equal(analytics.evolution[0].percentage, (10 / 12) * 100);
  assert.equal(analytics.evolution[0].source, 'weighted');
});

test('hour and weekday groupings use weighted counts and retain rates above capacity', () => {
  const records = [
    { ...record('mon-06', 'daily', '2026-10-05', 'crossfit', 'CrossFit', 106, 'Manhã', '06:00'), presences: 19, capacity: 18 },
    { ...record('mon-07-small', 'daily', '2026-10-05', 'crossfit', 'CrossFit', 50, 'Manhã', '07:00'), presences: 1, capacity: 2 },
    { ...record('tue-07-large', 'daily', '2026-10-06', 'crossfit', 'CrossFit', 90, 'Manhã', '07:00'), presences: 9, capacity: 10 },
  ];
  const analytics = buildOccupancyChartAnalytics(records, {
    viewMode: 'daily',
    selectedMonths: ['2026-10'],
    modalityId: 'crossfit',
  });

  assert.deepEqual(analytics.byHour.map((item) => item.label), ['06:00', '07:00']);
  assert.equal(analytics.byHour[0].percentage, (19 / 18) * 100);
  assert.equal(analytics.byHour[1].percentage, (10 / 12) * 100);
  const sixAmRow = analytics.supportRows.find((row) => row.startTime === '06:00' && row.source === 'weighted');
  assert.equal(sixAmRow?.presences, 19);
  assert.equal(sixAmRow?.capacity, 18);
  assert.equal(sixAmRow?.recordCount, 1);
  assert.deepEqual(analytics.byWeekday.map((item) => item.label), ['Segunda', 'Terça']);
  assert.equal(analytics.byWeekday[0].percentage, (20 / 20) * 100);
  assert.equal(analytics.totals.classes, 3);
  assert.equal(analytics.totals.measuredClassCount, 3);
  assert.equal(analytics.totals.presences, 29);
  assert.equal(analytics.totals.capacity, 30);
  assert.equal(analytics.totals.percentage, (29 / 30) * 100);

  const overCapacity = buildOccupancyChartAnalytics(records, {
    viewMode: 'daily',
    selectedMonths: ['2026-10'],
    modalityId: 'crossfit',
    startTimes: ['06:00'],
    weekdays: [1],
  });
  assert.equal(overCapacity.donut?.occupied, (19 / 18) * 100);
  assert.equal(overCapacity.donut?.unoccupied, 0);
  assert.equal(overCapacity.donut?.presences, 19);
  assert.equal(overCapacity.donut?.capacity, 18);
  assert.deepEqual(overCapacity.byHour.map((item) => item.label), ['06:00']);
});

test('quarterly view replaces daily data only for the same class and month', () => {
  const analytics = buildOccupancyChartAnalytics([
    { ...record('jan-daily', 'daily', '2026-01-10', 'crossfit', 'CrossFit', 50, 'Manhã', '06:00'), presences: 1, capacity: 2 },
    { ...record('jan-monthly', 'monthly', '2026-01', 'crossfit', 'CrossFit', 80, 'Manhã'), presences: 8, capacity: 10 },
    { ...record('feb-daily', 'daily', '2026-02-10', 'crossfit', 'CrossFit', 90, 'Manhã', '06:00'), presences: 9, capacity: 10 },
    { ...record('mar-daily', 'daily', '2026-03-10', 'crossfit', 'CrossFit', 80, 'Manhã', '06:00'), presences: 4, capacity: 5 },
  ], {
    viewMode: 'quarterly',
    selectedMonths: ['2026-01', '2026-02', '2026-03'],
    modalityId: 'crossfit',
  });

  assert.deepEqual(analytics.evolution.map((point) => point.period), ['2026-Q1']);
  assert.equal(analytics.evolution[0].percentage, (21 / 25) * 100);
  assert.equal(analytics.totals.classes, 3);
  assert.equal(analytics.totals.measuredClassCount, 3);
  assert.equal(analytics.totals.presences, 21);
  assert.equal(analytics.totals.capacity, 25);
  assert.deepEqual(analytics.supportRows.map((row) => row.period), ['2026-Q1', '2026-Q1']);
});

test('all-modality indicators combine presence and capacity totals instead of averaging rates', () => {
  const analytics = buildOccupancyChartAnalytics([
    { ...record('small', 'daily', '2026-10-05', 'crossfit', 'CrossFit', 50), presences: 1, capacity: 2 },
    { ...record('large', 'daily', '2026-10-05', 'yoga', 'Yoga', 90), presences: 9, capacity: 10 },
  ], { viewMode: 'daily', selectedMonths: ['2026-10'] });

  assert.equal(analytics.totals.percentage, (10 / 12) * 100);
  assert.equal(analytics.donut?.occupied, (10 / 12) * 100);
  assert.equal(analytics.evolution.find((point) => point.period === '2026-10-05')?.percentage, (10 / 12) * 100);
  assert.equal(analytics.comparison.find((item) => item.modalityId === 'crossfit')?.percentage, 50);
  assert.equal(analytics.comparison.find((item) => item.modalityId === 'yoga')?.percentage, 90);
});

test('weekday groups remain calendar-date based across December and January and report real totals', () => {
  const analytics = buildOccupancyChartAnalytics([
    { ...record('dec-31', 'daily', '2026-12-31', 'crossfit', 'CrossFit', 50, 'Noite', '18:00'), presences: 5, capacity: 10 },
    { ...record('jan-01', 'daily', '2027-01-01', 'crossfit', 'CrossFit', 75, 'Noite', '18:00'), presences: 15, capacity: 20 },
    record('legacy-dec', 'monthly', '2026-12', 'crossfit', 'CrossFit', 60, 'Noite'),
  ], {
    viewMode: 'daily',
    selectedMonths: ['2026-12', '2027-01'],
  });

  assert.deepEqual(analytics.byWeekday.map(({ label, recordCount, presences, capacity, percentage }) => ({
    label, recordCount, presences, capacity, percentage,
  })), [
    { label: 'Quinta', recordCount: 1, presences: 5, capacity: 10, percentage: 50 },
    { label: 'Sexta', recordCount: 1, presences: 15, capacity: 20, percentage: 75 },
  ]);
});

test('aggregator metrics preserve unknown coverage and compare month-by-month without counting people', () => {
  const analytics = buildOccupancyChartAnalytics([
    { ...record('oct-a', 'daily', '2026-10-01', 'crossfit', 'CrossFit', 50), presences: 10, capacity: 20, aggregatorPresences: 4 },
    { ...record('oct-b', 'daily', '2026-10-02', 'crossfit', 'CrossFit', 40), presences: 8, capacity: 20, aggregatorPresences: null },
    { ...record('nov-a', 'daily', '2026-11-02', 'crossfit', 'CrossFit', 40), presences: 2, capacity: 5, aggregatorPresences: 1 },
  ], { viewMode: 'daily', selectedMonths: ['2026-10', '2026-11'] });

  assert.equal(analytics.totals.presences, 20);
  assert.equal(analytics.totals.aggregatorPresences, 5);
  assert.equal(analytics.totals.aggregatorInformedClassCount, 2);
  assert.equal(analytics.totals.aggregatorSharePercentage, null);
  assert.equal(analytics.totals.otherPresences, null);
  assert.deepEqual(analytics.aggregatorsByMonth.map((month) => ({
    month: month.month,
    totalPresences: month.totalPresences,
    aggregatorPresences: month.aggregatorPresences,
    sharePercentage: month.sharePercentage,
    coverage: `${month.aggregatorInformedClassCount}/${month.measuredClassCount}`,
  })), [
    { month: '2026-10', totalPresences: 18, aggregatorPresences: 4, sharePercentage: null, coverage: '1/2' },
    { month: '2026-11', totalPresences: 2, aggregatorPresences: 1, sharePercentage: 50, coverage: '1/1' },
  ]);
});
