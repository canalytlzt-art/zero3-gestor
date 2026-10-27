import assert from 'node:assert/strict';
import test from 'node:test';
import {
  changeOccupancyPeriod,
  clearOccupancyFilters,
  occupancyQueryParams,
  updateOccupancyFilters,
  updateOccupancyYear,
} from './occupancy-filter-store';

test('combines date ranges, weekdays, time, class and modality without UTC date conversion', () => {
  clearOccupancyFilters();
  updateOccupancyFilters({
    periodMode: 'range',
    fromDate: '2026-12-29',
    toDate: '2027-01-03',
    modalityId: 'modality-1',
    className: 'Noite',
    weekdays: [2, 5],
    startTimes: ['18:00'],
  });
  assert.deepEqual(occupancyQueryParams({
    periodMode: 'range',
    day: '',
    fromDate: '2026-12-29',
    toDate: '2027-01-03',
    months: [],
    year: '',
    quarter: '',
    modalityId: 'modality-1',
    className: 'Noite',
    weekdays: [5, 2],
    startTimes: ['18:00'],
    viewMode: 'daily',
  }), {
    kind: 'all',
    fromDate: '2026-12-29',
    toDate: '2027-01-03',
    modalityId: 'modality-1',
    className: 'Noite',
    startTimes: '18:00',
    weekdays: '2,5',
  });
});

test('combines an exact date with its selected weekday and time filter', () => {
  assert.deepEqual(occupancyQueryParams({
    periodMode: 'day',
    day: '2027-01-01',
    fromDate: '',
    toDate: '',
    months: [],
    year: '',
    quarter: '',
    modalityId: '',
    className: '',
    weekdays: [5],
    startTimes: ['08:30'],
    viewMode: 'daily',
  }), {
    kind: 'all',
    fromDate: '2027-01-01',
    toDate: '2027-01-01',
    startTimes: '08:30',
    weekdays: '5',
  });
});

test('choosing a custom date range clears month/year selections and keeps monthly selection behavior', () => {
  clearOccupancyFilters();
  updateOccupancyFilters({ months: ['2026-10'], year: '2026', quarter: '4' });
  changeOccupancyPeriod('range');
  updateOccupancyFilters({ fromDate: '2026-10-01', toDate: '2026-10-31' });
  assert.deepEqual(occupancyQueryParams({
    periodMode: 'range',
    day: '',
    fromDate: '2026-10-01',
    toDate: '2026-10-31',
    months: [],
    year: '',
    quarter: '',
    modalityId: '',
    className: '',
    weekdays: [],
    startTimes: [],
    viewMode: 'daily',
  }), { kind: 'all', fromDate: '2026-10-01', toDate: '2026-10-31' });

  updateOccupancyFilters({ periodMode: 'months', months: ['2027-01'] });
  updateOccupancyYear('2027');
  assert.deepEqual(occupancyQueryParams({
    periodMode: 'months',
    day: '',
    fromDate: '',
    toDate: '',
    months: ['2027-01'],
    year: '2027',
    quarter: '',
    modalityId: '',
    className: '',
    weekdays: [],
    startTimes: [],
    viewMode: 'monthly',
  }), { kind: 'all', months: '2027-01', year: 2027 });
  clearOccupancyFilters();
});
