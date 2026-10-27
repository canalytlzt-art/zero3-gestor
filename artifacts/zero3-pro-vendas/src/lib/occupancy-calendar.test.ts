import assert from 'node:assert/strict';
import test from 'node:test';
import { getIsoWeekday, getWeekdayName, isValidCalendarDate } from './occupancy-calendar';

test('uses ISO weekdays from calendar dates without timezone conversion', () => {
  assert.equal(getIsoWeekday('2026-10-27'), 2);
  assert.equal(getWeekdayName('2026-10-27'), 'terça-feira');
  assert.equal(getIsoWeekday('2026-10-31'), 6);
  assert.equal(getWeekdayName('2026-11-01', 'short'), 'Domingo');
});

test('keeps dates correct across month, year, leap-year and early-year boundaries', () => {
  assert.equal(getIsoWeekday('2026-12-31'), 4);
  assert.equal(getIsoWeekday('2027-01-01'), 5);
  assert.equal(getIsoWeekday('2024-02-29'), 4);
  assert.equal(getIsoWeekday('0026-01-01'), 4);
  assert.equal(getIsoWeekday('2025-02-29'), null);
  assert.equal(getIsoWeekday('2026-13-01'), null);
  assert.equal(getIsoWeekday('2026-10'), null);
});

test('validates Gregorian calendar dates exactly', () => {
  assert.equal(isValidCalendarDate(2000, 2, 29), true);
  assert.equal(isValidCalendarDate(1900, 2, 29), false);
  assert.equal(isValidCalendarDate(2026, 4, 31), false);
  assert.equal(isValidCalendarDate(2026, 4, 30), true);
});
