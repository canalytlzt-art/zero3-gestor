import type { OccupancyRecord } from '@workspace/api-client-react';
import { getIsoWeekday, getWeekdayName } from './occupancy-calendar';

export type OccupancyChartViewMode = 'daily' | 'monthly' | 'quarterly';

export type OccupancyChartFilters = {
  viewMode: OccupancyChartViewMode;
  selectedMonths?: readonly string[];
  fromDate?: string;
  toDate?: string;
  modalityId?: string;
  startTimes?: readonly string[];
  weekdays?: readonly number[];
};

export type OccupancyChartSource = 'weighted' | 'reported' | 'average';

export type OccupancyChartSupportRow = {
  key: string;
  period: string;
  modalityId: string;
  modalityName: string;
  className: string | null;
  startTime: string | null;
  percentage: number;
  source: OccupancyChartSource;
  recordCount: number;
  presences: number | null;
  capacity: number | null;
};

export type OccupancyChartPoint = {
  period: string;
  modalityId: string;
  modalityName: string;
  percentage: number | null;
  source: OccupancyChartSource | null;
  recordCount: number;
  scopeCount: number;
  presences: number | null;
  capacity: number | null;
};

export type OccupancyModalityComparison = {
  modalityId: string;
  modalityName: string;
  percentage: number;
  source: OccupancyChartSource;
  coveredPeriods: number;
  availablePeriods: number;
};

export type OccupancyDonutData = {
  occupied: number;
  unoccupied: number;
  source: OccupancyChartSource;
  coveredPeriods: number;
  availablePeriods: number;
  presences: number | null;
  capacity: number | null;
} | null;

export type OccupancyChartGroup = {
  key: string;
  label: string;
  percentage: number;
  source: OccupancyChartSource;
  recordCount: number;
  presences: number | null;
  capacity: number | null;
};

export type OccupancyChartTotals = {
  classes: number;
  measuredClassCount: number;
  presences: number | null;
  capacity: number | null;
  percentage: number | null;
  legacyRecordCount: number;
  aggregatorPresences: number | null;
  aggregatorInformedClassCount: number;
  aggregatorSharePercentage: number | null;
  otherPresences: number | null;
};

export type OccupancyAggregatorMonth = {
  month: string;
  totalPresences: number;
  aggregatorPresences: number | null;
  aggregatorInformedClassCount: number;
  measuredClassCount: number;
  sharePercentage: number | null;
};

export type OccupancyChartAnalytics = {
  supportRows: OccupancyChartSupportRow[];
  evolution: OccupancyChartPoint[];
  comparison: OccupancyModalityComparison[];
  donut: OccupancyDonutData;
  totals: OccupancyChartTotals;
  aggregatorsByMonth: OccupancyAggregatorMonth[];
  byHour: OccupancyChartGroup[];
  byWeekday: OccupancyChartGroup[];
};

type ChartRecord = Pick<
  OccupancyRecord,
  'id' | 'kind' | 'period' | 'month' | 'modalityId' | 'modalityName' | 'percentage' | 'className' | 'presences' | 'capacity' | 'aggregatorPresences' | 'startTime'
>;

function average(values: number[]) {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function classKey(value: string | null) {
  return (value ?? '').trim().normalize('NFKC').toLocaleLowerCase('pt-BR');
}

function monthOf(date: string) {
  return date.slice(0, 7);
}

function quarterOfMonth(month: string) {
  const quarter = Math.floor((Number(month.slice(5, 7)) - 1) / 3) + 1;
  return `${month.slice(0, 4)}-Q${quarter}`;
}

function bucketPeriod(record: ChartRecord, viewMode: OccupancyChartViewMode) {
  if (viewMode === 'daily') return record.period;
  if (viewMode === 'quarterly') return quarterOfMonth(record.month);
  return record.month;
}

function isCompleteMonthRange(fromDate?: string, toDate?: string) {
  if (!fromDate || !toDate || fromDate > toDate) return false;
  const first = `${monthOf(fromDate)}-01`;
  const month = monthOf(toDate);
  const lastDay = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
  return fromDate === first && toDate === `${month}-${String(lastDay).padStart(2, '0')}`;
}

function availablePeriodCount(filters: OccupancyChartFilters, fallback: number) {
  if (filters.startTimes?.length || filters.weekdays?.length) return fallback;
  const selectedMonths = [...new Set(filters.selectedMonths ?? [])];
  if (filters.viewMode === 'quarterly') {
    const months = selectedMonths.length
      ? selectedMonths
      : filters.fromDate && filters.toDate && filters.fromDate <= filters.toDate
        ? monthKeysBetweenDates(filters.fromDate, filters.toDate)
        : [];
    return months.length ? new Set(months.map(quarterOfMonth)).size : fallback;
  }
  if (selectedMonths.length) {
    if (filters.viewMode === 'monthly') return selectedMonths.length;
    return selectedMonths.reduce((count, month) => {
      const [year, monthNumber] = month.split('-').map(Number);
      return count + new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
    }, 0);
  }
  if (filters.fromDate && filters.toDate && filters.fromDate <= filters.toDate) {
    if (filters.viewMode === 'monthly') {
      const [fromYear, fromMonth] = filters.fromDate.slice(0, 7).split('-').map(Number);
      const [toYear, toMonth] = filters.toDate.slice(0, 7).split('-').map(Number);
      return (toYear - fromYear) * 12 + toMonth - fromMonth + 1;
    }
    return Math.floor((Date.parse(`${filters.toDate}T00:00:00Z`) - Date.parse(`${filters.fromDate}T00:00:00Z`)) / 86_400_000) + 1;
  }
  return fallback;
}

function expectedPeriods(filters: OccupancyChartFilters) {
  if (filters.startTimes?.length || filters.weekdays?.length) return [];
  const months = [...new Set(filters.selectedMonths ?? [])].sort();
  if (filters.viewMode === 'quarterly') {
    const candidateMonths = months.length
      ? months
      : filters.fromDate && filters.toDate && filters.fromDate <= filters.toDate
        ? monthKeysBetweenDates(filters.fromDate, filters.toDate)
        : [];
    return [...new Set(candidateMonths.map(quarterOfMonth))].sort();
  }
  if (filters.viewMode === 'monthly') {
    if (months.length) return months;
    if (!filters.fromDate || !filters.toDate || filters.fromDate > filters.toDate) return [];
    const first = monthOf(filters.fromDate);
    const last = monthOf(filters.toDate);
    const [startYear, startMonth] = first.split('-').map(Number);
    const [endYear, endMonth] = last.split('-').map(Number);
    const total = (endYear - startYear) * 12 + endMonth - startMonth + 1;
    if (total > 240) return [];
    return Array.from({ length: total }, (_, index) => {
      const date = new Date(Date.UTC(startYear, startMonth - 1 + index, 1));
      return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
    });
  }

  const days: string[] = [];
  if (months.length) {
    const totalDays = months.reduce((count, month) => {
      const [year, monthNumber] = month.split('-').map(Number);
      return count + new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
    }, 0);
    if (totalDays > 366) return [];
    for (const month of months) {
      const [year, monthNumber] = month.split('-').map(Number);
      const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
      for (let day = 1; day <= lastDay; day += 1) {
        days.push(`${month}-${String(day).padStart(2, '0')}`);
      }
    }
    return days;
  }

  if (!filters.fromDate || !filters.toDate || filters.fromDate > filters.toDate) return [];
  const firstTime = Date.parse(`${filters.fromDate}T00:00:00Z`);
  const lastTime = Date.parse(`${filters.toDate}T00:00:00Z`);
  const totalDays = Math.floor((lastTime - firstTime) / 86_400_000) + 1;
  if (totalDays > 366) return [];
  for (let index = 0; index < totalDays; index += 1) {
    days.push(new Date(firstTime + index * 86_400_000).toISOString().slice(0, 10));
  }
  return days;
}

function monthKeysBetweenDates(fromDate: string, toDate: string) {
  const first = monthOf(fromDate);
  const last = monthOf(toDate);
  const [startYear, startMonth] = first.split('-').map(Number);
  const [endYear, endMonth] = last.split('-').map(Number);
  const total = (endYear - startYear) * 12 + endMonth - startMonth + 1;
  if (total <= 0 || total > 240) return [];
  return Array.from({ length: total }, (_, index) => {
    const date = new Date(Date.UTC(startYear, startMonth - 1 + index, 1));
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  });
}

function isInSelectedPeriod(record: ChartRecord, filters: OccupancyChartFilters) {
  const selectedMonths = new Set(filters.selectedMonths ?? []);
  if (selectedMonths.size) return selectedMonths.has(record.month);

  if (filters.fromDate && filters.toDate) {
    if (record.kind === 'daily') return record.period >= filters.fromDate && record.period <= filters.toDate;
    return isCompleteMonthRange(filters.fromDate, filters.toDate)
      && record.month >= monthOf(filters.fromDate)
      && record.month <= monthOf(filters.toDate);
  }

  return true;
}

function isMeasured(record: ChartRecord) {
  return record.presences !== null && record.presences !== undefined
    && record.capacity !== null && record.capacity !== undefined;
}

function measuredTotals(records: ChartRecord[]) {
  return records.reduce((totals, record) => ({
    presences: totals.presences + (record.presences ?? 0),
    capacity: totals.capacity + (record.capacity ?? 0),
  }), { presences: 0, capacity: 0 });
}

function stableUnique(records: ChartRecord[]) {
  const seen = new Set<string>();
  return records.filter((record) => {
    if (seen.has(record.id)) return false;
    seen.add(record.id);
    return true;
  });
}

function summarizeRecords(records: ChartRecord[], key: string, label: string): OccupancyChartGroup | null {
  const measured = records.filter(isMeasured);
  if (measured.length) {
    const totals = measuredTotals(measured);
    return {
      key,
      label,
      percentage: totals.capacity > 0 ? (totals.presences / totals.capacity) * 100 : 0,
      source: 'weighted',
      recordCount: measured.length,
      presences: totals.presences,
      capacity: totals.capacity,
    };
  }
  if (!records.length) return null;
  return {
    key,
    label,
    percentage: average(records.map((record) => record.percentage)),
    source: records.length === 1 ? 'reported' : 'average',
    recordCount: records.length,
    presences: null,
    capacity: null,
  };
}

function combinePointsByPeriod(points: OccupancyChartPoint[]) {
  const groups = new Map<string, OccupancyChartPoint[]>();
  for (const point of points) {
    const group = groups.get(point.period) ?? [];
    group.push(point);
    groups.set(point.period, group);
  }

  return [...groups.entries()].map(([period, periodPoints]) => {
    const measured = periodPoints.filter((point) =>
      point.source === 'weighted' && point.presences !== null && point.capacity !== null,
    );
    if (measured.length) {
      const presences = measured.reduce((total, point) => total + (point.presences ?? 0), 0);
      const capacity = measured.reduce((total, point) => total + (point.capacity ?? 0), 0);
      return {
        period,
        modalityId: 'all',
        modalityName: 'Todas as modalidades',
        percentage: capacity > 0 ? (presences / capacity) * 100 : null,
        source: 'weighted' as const,
        recordCount: measured.reduce((total, point) => total + point.recordCount, 0),
        scopeCount: measured.length,
        presences,
        capacity,
      };
    }
    const percentageValues = periodPoints
      .map((point) => point.percentage)
      .filter((value): value is number => value !== null);
    return {
      period,
      modalityId: 'all',
      modalityName: 'Todas as modalidades',
      percentage: percentageValues.length ? average(percentageValues) : null,
      source: percentageValues.length > 1 ? 'average' as const : periodPoints[0]?.source ?? null,
      recordCount: periodPoints.reduce((total, point) => total + point.recordCount, 0),
      scopeCount: percentageValues.length,
      presences: null,
      capacity: null,
    };
  }).sort((a, b) => a.period.localeCompare(b.period));
}

/**
 * Monthly values are chosen per class and month before monthly/quarterly
 * aggregation, avoiding duplicated totals where daily details also exist.
 * Percent-only rows remain separate and never enter measured denominators.
 */
export function buildOccupancyChartAnalytics(
  records: readonly ChartRecord[],
  filters: OccupancyChartFilters,
): OccupancyChartAnalytics {
  const monthlyAllowed = Boolean(filters.selectedMonths?.length)
    || isCompleteMonthRange(filters.fromDate, filters.toDate)
    || (!filters.fromDate && !filters.toDate);
  const relevant = stableUnique(records.filter((record) => {
    if (!isInSelectedPeriod(record, filters)) return false;
    if (filters.startTimes?.length && (!record.startTime || !filters.startTimes.includes(record.startTime))) return false;
    if (filters.weekdays?.length) {
      if (record.kind !== 'daily') return false;
      const weekday = getIsoWeekday(record.period);
      if (weekday === null || !filters.weekdays.includes(weekday)) return false;
    }
    if (filters.startTimes?.length && record.kind !== 'daily') return false;
    if (record.kind === 'daily' && getIsoWeekday(record.period) === null) return false;
    if (record.kind === 'monthly' && !monthlyAllowed) return false;
    return true;
  }));

  const selectedRecords: ChartRecord[] = [];
  let classCount = 0;
  let measuredClassCount = 0;
  if (filters.viewMode === 'daily') {
    selectedRecords.push(...relevant.filter((record) => record.kind === 'daily'));
    classCount = selectedRecords.length;
    measuredClassCount = selectedRecords.filter(isMeasured).length;
  } else {
    const monthScopes = new Map<string, { daily: ChartRecord[]; monthly: ChartRecord[] }>();
    for (const record of relevant) {
      const key = JSON.stringify([record.month, record.modalityId, classKey(record.className)]);
      const group = monthScopes.get(key) ?? { daily: [], monthly: [] };
      if (record.kind === 'monthly') group.monthly.push(record);
      else group.daily.push(record);
      monthScopes.set(key, group);
    }
    for (const group of monthScopes.values()) {
      const monthlyMeasured = group.monthly.filter(isMeasured);
      const monthlyLegacy = group.monthly.filter((record) => !isMeasured(record));
      const dailyMeasured = group.daily.filter(isMeasured);
      const dailyLegacy = group.daily.filter((record) => !isMeasured(record));
      const selectedMonthlyMeasured = monthlyMeasured.length ? monthlyMeasured : [];
      const selectedDailyMeasured = monthlyMeasured.length ? [] : dailyMeasured;
      const selectedLegacy = monthlyLegacy.length ? monthlyLegacy : dailyLegacy;
      selectedRecords.push(...selectedMonthlyMeasured, ...selectedDailyMeasured, ...selectedLegacy);
      classCount += group.daily.length || selectedMonthlyMeasured.length + selectedLegacy.length;
      measuredClassCount += dailyMeasured.length || monthlyMeasured.length;
    }
  }

  const scopes = new Map<string, { period: string; modalityId: string; modalityName: string; className: string | null; startTime: string | null; records: ChartRecord[] }>();
  for (const record of selectedRecords) {
    const period = bucketPeriod(record, filters.viewMode);
    const key = JSON.stringify([period, record.modalityId, classKey(record.className), record.startTime]);
    const group = scopes.get(key) ?? {
      period,
      modalityId: record.modalityId,
      modalityName: record.modalityName,
      className: record.className,
      startTime: record.startTime,
      records: [],
    };
    group.records.push(record);
    scopes.set(key, group);
  }

  const supportRows: OccupancyChartSupportRow[] = [];
  for (const [key, group] of scopes) {
    const measured = group.records.filter(isMeasured);
    if (measured.length) {
      const totals = measuredTotals(measured);
      supportRows.push({
        key: `${key}:weighted`,
        period: group.period,
        modalityId: group.modalityId,
        modalityName: group.modalityName,
        className: group.className,
        startTime: group.startTime,
        percentage: totals.capacity > 0 ? (totals.presences / totals.capacity) * 100 : 0,
        source: 'weighted',
        recordCount: measured.length,
        presences: totals.presences,
        capacity: totals.capacity,
      });
    }
    const legacy = group.records.filter((record) => !isMeasured(record));
    if (legacy.length) {
      supportRows.push({
        key: `${key}:reported`,
        period: group.period,
        modalityId: group.modalityId,
        modalityName: group.modalityName,
        className: group.className,
        startTime: group.startTime,
        percentage: average(legacy.map((record) => record.percentage)),
        source: legacy.length === 1 ? 'reported' : 'average',
        recordCount: legacy.length,
        presences: null,
        capacity: null,
      });
    }
  }

  supportRows.sort((a, b) =>
    a.period.localeCompare(b.period)
    || a.modalityName.localeCompare(b.modalityName, 'pt-BR', { sensitivity: 'base' })
    || (a.className ?? '').localeCompare(b.className ?? '', 'pt-BR', { sensitivity: 'base' })
    || (a.startTime ?? '').localeCompare(b.startTime ?? ''),
  );

  const pointsByScope = new Map<string, OccupancyChartSupportRow[]>();
  for (const row of supportRows) {
    const key = JSON.stringify([row.period, row.modalityId]);
    const group = pointsByScope.get(key) ?? [];
    group.push(row);
    pointsByScope.set(key, group);
  }

  const points: OccupancyChartPoint[] = [...pointsByScope.entries()]
    .map(([key, rows]) => {
      const [period, modalityId] = JSON.parse(key) as [string, string];
      const measuredRows = rows.filter((row) => row.source === 'weighted' && row.presences !== null && row.capacity !== null);
      if (measuredRows.length) {
        const presences = measuredRows.reduce((total, row) => total + (row.presences ?? 0), 0);
        const capacity = measuredRows.reduce((total, row) => total + (row.capacity ?? 0), 0);
        return {
          period,
          modalityId,
          modalityName: rows[0].modalityName,
          percentage: capacity > 0 ? (presences / capacity) * 100 : null,
          source: 'weighted' as const,
          recordCount: measuredRows.reduce((count, row) => count + row.recordCount, 0),
          scopeCount: measuredRows.length,
          presences,
          capacity,
        };
      }
      return {
        period,
        modalityId,
        modalityName: rows[0].modalityName,
        percentage: average(rows.map((row) => row.percentage)),
        source: rows.length > 1 ? 'average' as const : rows[0].source,
        recordCount: rows.reduce((count, row) => count + row.recordCount, 0),
        scopeCount: rows.length,
        presences: null,
        capacity: null,
      };
    })
    .sort((a, b) => a.period.localeCompare(b.period));

  const modalityPointGroups = new Map<string, { modalityName: string; points: OccupancyChartPoint[] }>();
  for (const point of points) {
    const group = modalityPointGroups.get(point.modalityId) ?? { modalityName: point.modalityName, points: [] };
    group.points.push(point);
    modalityPointGroups.set(point.modalityId, group);
  }

  const comparison: OccupancyModalityComparison[] = [...modalityPointGroups.entries()]
    .map(([modalityId, group]) => {
      const values = group.points.filter((point): point is OccupancyChartPoint & { percentage: number } => point.percentage !== null);
      const measured = values.filter((point) => point.source === 'weighted' && point.presences !== null && point.capacity !== null);
      if (measured.length) {
        const presences = measured.reduce((total, point) => total + (point.presences ?? 0), 0);
        const capacity = measured.reduce((total, point) => total + (point.capacity ?? 0), 0);
        return {
          modalityId,
          modalityName: group.modalityName,
          percentage: capacity > 0 ? (presences / capacity) * 100 : 0,
          source: 'weighted' as const,
          coveredPeriods: measured.length,
          availablePeriods: availablePeriodCount(filters, measured.length),
        };
      }
      return {
        modalityId,
        modalityName: group.modalityName,
        percentage: average(values.map((point) => point.percentage)),
        source: values.length > 1 ? 'average' as const : values[0]?.source ?? 'reported',
        coveredPeriods: values.length,
        availablePeriods: availablePeriodCount(filters, values.length),
      };
    })
    .sort((a, b) => a.modalityName.localeCompare(b.modalityName, 'pt-BR', { sensitivity: 'base' }));

  const selectedPoints = filters.modalityId
    ? points.filter((point) => point.modalityId === filters.modalityId)
    : combinePointsByPeriod(points);
  const selectedModalityName = selectedPoints[0]?.modalityName
    ?? supportRows.find((row) => row.modalityId === filters.modalityId)?.modalityName
    ?? comparison.find((row) => row.modalityId === filters.modalityId)?.modalityName
    ?? 'Todas as modalidades';
  const pointsByPeriod = new Map(selectedPoints.map((point) => [point.period, point]));
  const expected = expectedPeriods(filters);
  const evolution: OccupancyChartPoint[] = expected.length
    ? expected.map((period) => pointsByPeriod.get(period) ?? {
      period,
      modalityId: filters.modalityId ?? 'all',
      modalityName: selectedModalityName,
      percentage: null,
      source: null,
      recordCount: 0,
      scopeCount: 0,
      presences: null,
      capacity: null,
    })
    : selectedPoints;
  const donutPoints = filters.modalityId
    ? points.filter((point) => point.modalityId === filters.modalityId)
    : combinePointsByPeriod(points);
  const measuredDonutPoints = donutPoints.filter((point) =>
    point.source === 'weighted' && point.presences !== null && point.capacity !== null,
  );
  const legacyDonutValues = donutPoints
    .filter((point) => point.source !== 'weighted' && point.percentage !== null)
    .map((point) => point.percentage as number);
  const donutPresences = measuredDonutPoints.reduce((total, point) => total + (point.presences ?? 0), 0);
  const donutCapacity = measuredDonutPoints.reduce((total, point) => total + (point.capacity ?? 0), 0);
  const donutCoveredPeriods = new Set(donutPoints.filter((point) => point.percentage !== null).map((point) => point.period)).size;
  const donutAvailablePeriods = availablePeriodCount(filters, donutCoveredPeriods);
  const legacySupportRows = filters.modalityId
    ? supportRows.filter((row) => row.modalityId === filters.modalityId && row.source !== 'weighted')
    : [];
  const singleLegacyDonutIsValid = filters.viewMode !== 'quarterly'
    && legacyDonutValues.length === 1
    && legacySupportRows.length === 1
    && legacySupportRows[0]?.recordCount === 1
    && donutCoveredPeriods === donutAvailablePeriods;
  const donutValue = measuredDonutPoints.length
    ? donutCapacity > 0 ? (donutPresences / donutCapacity) * 100 : 0
    : singleLegacyDonutIsValid ? legacyDonutValues[0] ?? null : null;
  const donutSource = measuredDonutPoints.length ? 'weighted' as const : 'reported' as const;
  const donut: OccupancyDonutData = donutValue === null ? null : {
    occupied: donutValue,
    unoccupied: Math.max(0, 100 - donutValue),
    source: donutSource,
    coveredPeriods: donutCoveredPeriods,
    availablePeriods: donutAvailablePeriods,
    presences: measuredDonutPoints.length ? donutPresences : null,
    capacity: measuredDonutPoints.length ? donutCapacity : null,
  };

  const measuredRows = supportRows.filter((row) => row.source === 'weighted' && row.presences !== null && row.capacity !== null);
  const totalPresences = measuredRows.reduce((total, row) => total + (row.presences ?? 0), 0);
  const totalCapacity = measuredRows.reduce((total, row) => total + (row.capacity ?? 0), 0);
  const selectedMeasured = selectedRecords.filter((record) => record.presences !== null && record.capacity !== null);
  const aggregatorInformed = selectedMeasured.filter((record) => record.aggregatorPresences != null);
  const aggregatorTotal = aggregatorInformed.reduce((total, record) => total + (record.aggregatorPresences ?? 0), 0);
  const completeAggregatorCoverage = selectedMeasured.length > 0 && aggregatorInformed.length === selectedMeasured.length;
  const aggregatorsByMonthMap = new Map<string, ChartRecord[]>();
  for (const record of selectedMeasured) {
    const group = aggregatorsByMonthMap.get(record.month) ?? [];
    group.push(record);
    aggregatorsByMonthMap.set(record.month, group);
  }
  const aggregatorsByMonth: OccupancyAggregatorMonth[] = [...aggregatorsByMonthMap.entries()]
    .sort(([monthA], [monthB]) => monthA.localeCompare(monthB))
    .map(([month, monthRecords]) => {
      const informed = monthRecords.filter((record) => record.aggregatorPresences != null);
      const totalPresencesForMonth = monthRecords.reduce((sum, record) => sum + (record.presences ?? 0), 0);
      const aggregatorPresences = informed.length
        ? informed.reduce((sum, record) => sum + (record.aggregatorPresences ?? 0), 0)
        : null;
      const complete = informed.length > 0 && informed.length === monthRecords.length;
      return {
        month,
        totalPresences: totalPresencesForMonth,
        aggregatorPresences,
        aggregatorInformedClassCount: informed.length,
        measuredClassCount: monthRecords.length,
        sharePercentage: complete
          ? totalPresencesForMonth > 0 ? (aggregatorPresences ?? 0) / totalPresencesForMonth * 100 : 0
          : null,
      };
    });
  const totals: OccupancyChartTotals = {
    classes: classCount,
    measuredClassCount,
    presences: measuredRows.length ? totalPresences : null,
    capacity: measuredRows.length ? totalCapacity : null,
    percentage: measuredRows.length && totalCapacity > 0 ? (totalPresences / totalCapacity) * 100 : null,
    legacyRecordCount: selectedRecords.filter((record) => !isMeasured(record)).length,
    aggregatorPresences: aggregatorInformed.length ? aggregatorTotal : null,
    aggregatorInformedClassCount: aggregatorInformed.length,
    aggregatorSharePercentage: completeAggregatorCoverage
      ? totalPresences > 0 ? aggregatorTotal / totalPresences * 100 : 0
      : null,
    otherPresences: completeAggregatorCoverage ? totalPresences - aggregatorTotal : null,
  };

  const dailyRecords = relevant.filter((record) => record.kind === 'daily');
  const recordsByHour = new Map<string, ChartRecord[]>();
  const recordsByWeekday = new Map<number, ChartRecord[]>();
  for (const record of dailyRecords) {
    if (record.startTime) {
      const time = record.startTime.slice(0, 5);
      const group = recordsByHour.get(time) ?? [];
      group.push(record);
      recordsByHour.set(time, group);
    }
    const weekday = getIsoWeekday(record.period);
    if (weekday === null) continue;
    const group = recordsByWeekday.get(weekday) ?? [];
    group.push(record);
    recordsByWeekday.set(weekday, group);
  }
  const byHour = [...recordsByHour.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([time, groupedRecords]) => summarizeRecords(groupedRecords, time, time))
    .filter((group): group is OccupancyChartGroup => group !== null);
  const byWeekday = [...recordsByWeekday.entries()]
    .sort(([a], [b]) => a - b)
    .map(([weekday, groupedRecords]) => summarizeRecords(groupedRecords, String(weekday), getWeekdayName(groupedRecords[0]?.period ?? '', 'short') ?? String(weekday)))
    .filter((group): group is OccupancyChartGroup => group !== null);

  return { supportRows, evolution, comparison, donut, totals, aggregatorsByMonth, byHour, byWeekday };
}
