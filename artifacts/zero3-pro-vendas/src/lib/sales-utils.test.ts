import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildScoreboardQueryParams,
  getSalesGoalComparison,
  isCompleteCalendarMonthRange,
  monthsForYearQuarter,
} from './sales-utils.ts';

test('builds the exact query filters used by the Scoreboard period controls', () => {
  const common = {
    currentMonthKey: '2097-11',
    selectedMonth: '2097-10',
    selectedMonths: ['2097-12', '2097-10', '2097-12'],
    dateFrom: '2097-11-01',
    dateTo: '2097-11-30',
    filterProduct: '',
  };

  assert.deepEqual(buildScoreboardQueryParams({ ...common, periodMode: 'current' }), {
    months: ['2097-11'],
  });
  assert.deepEqual(buildScoreboardQueryParams({
    ...common,
    periodMode: 'current',
    weekdays: [7, 2, 2],
  }), {
    months: ['2097-11'],
    weekdays: [2, 7],
  });
  assert.deepEqual(buildScoreboardQueryParams({ ...common, periodMode: 'single' }), {
    months: ['2097-10'],
  });
  assert.deepEqual(buildScoreboardQueryParams({ ...common, periodMode: 'multiple' }), {
    months: ['2097-10', '2097-12'],
  });
  assert.deepEqual(buildScoreboardQueryParams({
    ...common,
    periodMode: 'quarter',
    selectedYear: '2097',
    selectedQuarter: '4',
    filterProduct: 'product-id',
  }), {
    months: ['2097-10', '2097-11', '2097-12'],
    productId: 'product-id',
  });
  assert.deepEqual(buildScoreboardQueryParams({
    ...common,
    periodMode: 'year',
    selectedYear: '2096',
  }).months, [
    '2096-01', '2096-02', '2096-03', '2096-04', '2096-05', '2096-06',
    '2096-07', '2096-08', '2096-09', '2096-10', '2096-11', '2096-12',
  ]);
  assert.deepEqual(buildScoreboardQueryParams({ ...common, periodMode: 'range' }), {
    fromDate: '2097-11-01',
    toDate: '2097-11-30',
  });
  assert.deepEqual(buildScoreboardQueryParams({
    ...common,
    periodMode: 'range',
    dateFrom: '2097-11-30',
    dateTo: '2097-11-01',
    filterProduct: 'product-id',
  }), { productId: 'product-id' });
  assert.deepEqual(buildScoreboardQueryParams({ ...common, periodMode: 'all' }), {});
});

test('creates calendar months for a year or quarter and rejects invalid selections', () => {
  assert.deepEqual(monthsForYearQuarter('2028', '1'), ['2028-01', '2028-02', '2028-03']);
  assert.equal(monthsForYearQuarter('2028').length, 12);
  assert.deepEqual(monthsForYearQuarter('0000'), []);
  assert.deepEqual(monthsForYearQuarter('2028', '5'), []);
});

test('normalizes sales filters consistently for product, modality and weekday scopes', () => {
  assert.deepEqual(buildScoreboardQueryParams({
    periodMode: 'quarter',
    currentMonthKey: '2026-10',
    selectedMonth: '',
    selectedMonths: [],
    selectedYear: '2026',
    selectedQuarter: '4',
    dateFrom: '',
    dateTo: '',
    filterProduct: 'product-id',
    modalityId: 'modality-id',
    weekdays: [3, 1, 3],
  }), {
    months: ['2026-10', '2026-11', '2026-12'],
    productId: 'product-id',
    weekdays: [1, 3],
    modalityId: 'modality-id',
  });
});

const singleMonth = ['2026-01'];
const twoMonths = ['2026-01', '2026-02'];

function goal(month: string, targetCents: number, productName: string | null = null) {
  return { month, targetCents, productName };
}

function assertHasNoComparisonValues(result: ReturnType<typeof getSalesGoalComparison>) {
  assert.notEqual(result.status, 'complete');
  assert.equal('targetCents' in result, false);
  assert.equal('differenceCents' in result, false);
  assert.equal('achievementTenthsPercent' in result, false);
}

test('does not calculate target or attainment when the selected scope has no goals', () => {
  const result = getSalesGoalComparison(12_000n, singleMonth, 'complete', null, []);

  assert.equal(result.status, 'none');
  assert.equal(result.configuredGoalCount, 0);
  assertHasNoComparisonValues(result);
});

test('compares a single month when that month has a goal', () => {
  const result = getSalesGoalComparison(
    8_500n,
    singleMonth,
    'complete',
    null,
    [goal('2026-01', 10_000)],
  );

  assert.equal(result.status, 'complete');
  if (result.status !== 'complete') return;
  assert.equal(result.targetCents, 10_000n);
  assert.equal(result.differenceCents, 1_500n);
  assert.equal(result.attainment, 'below');
});

test('sums goals across multiple months only with complete coverage', () => {
  const result = getSalesGoalComparison(
    45_000n,
    twoMonths,
    'complete',
    null,
    [goal('2026-01', 10_000), goal('2026-02', 20_000)],
  );

  assert.equal(result.status, 'complete');
  if (result.status !== 'complete') return;
  assert.equal(result.configuredGoalCount, 2);
  assert.equal(result.targetCents, 30_000n);
  assert.equal(result.achievementTenthsPercent, 1_500n);
  assert.equal(result.attainment, 'above');
});

test('does not expose a sum or percentage when any selected month is missing a goal', () => {
  const result = getSalesGoalComparison(
    25_000n,
    twoMonths,
    'complete',
    null,
    [goal('2026-01', 10_000)],
  );

  assert.equal(result.status, 'partial');
  assert.equal(result.configuredGoalCount, 1);
  assert.equal(result.monthCount, 2);
  assertHasNoComparisonValues(result);
});

test('matches plan goals separately from general goals', () => {
  const goals = [
    goal('2026-01', 90_000),
    goal('2026-02', 90_000),
    goal('2026-01', 10_000, 'Plano Alpha'),
    goal('2026-02', 20_000, ' plano   alpha '),
  ];

  const planResult = getSalesGoalComparison(30_000n, twoMonths, 'complete', 'Plano Alpha', goals);
  const generalResult = getSalesGoalComparison(180_000n, twoMonths, 'complete', null, goals);

  assert.equal(planResult.status, 'complete');
  if (planResult.status === 'complete') assert.equal(planResult.targetCents, 30_000n);
  assert.equal(generalResult.status, 'complete');
  if (generalResult.status === 'complete') assert.equal(generalResult.targetCents, 180_000n);
});

test('distinguishes below, equal, and above target values', () => {
  const goals = [goal('2026-01', 10_000)];
  const compare = (actual: bigint) => getSalesGoalComparison(
    actual,
    singleMonth,
    'complete',
    null,
    goals,
  );

  const below = compare(9_000n);
  const equal = compare(10_000n);
  const above = compare(11_000n);

  assert.equal(below.status === 'complete' && below.attainment, 'below');
  assert.equal(equal.status === 'complete' && equal.attainment, 'equal');
  assert.equal(above.status === 'complete' && above.attainment, 'above');
  assert.equal(below.status === 'complete' && below.differenceCents, 1_000n);
  assert.equal(equal.status === 'complete' && equal.differenceCents, 0n);
  assert.equal(above.status === 'complete' && above.differenceCents, 1_000n);
});

test('does not compare monthly goals for an interval containing a partial month', () => {
  assert.equal(isCompleteCalendarMonthRange('2026-01-01', '2026-02-28'), true);
  assert.equal(isCompleteCalendarMonthRange('2026-01-15', '2026-02-28'), false);

  const result = getSalesGoalComparison(
    20_000n,
    twoMonths,
    'partial-range',
    null,
    [goal('2026-01', 10_000), goal('2026-02', 20_000)],
  );

  assert.equal(result.status, 'partial-range');
  assert.equal(result.configuredGoalCount, 2);
  assertHasNoComparisonValues(result);
});
