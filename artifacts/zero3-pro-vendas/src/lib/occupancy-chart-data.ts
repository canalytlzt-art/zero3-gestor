import type { OccupancyRecord } from '@workspace/api-client-react';

export type OccupancyChartViewMode = 'daily' | 'monthly';

export type OccupancyChartFilters = {
  viewMode: OccupancyChartViewMode;
  selectedMonths?: readonly string[];
  fromDate?: string;
  toDate?: string;
  modalityId?: string;
};

export type OccupancyChartSource = 'reported' | 'average';

export type OccupancyChartSupportRow = {
  key: string;
  period: string;
  modalityId: string;
  modalityName: string;
  className: string | null;
  percentage: number;
  source: OccupancyChartSource;
  recordCount: number;
};

export type OccupancyChartPoint = {
  period: string;
  modalityId: string;
  modalityName: string;
  percentage: number | null;
  source: OccupancyChartSource | null;
  recordCount: number;
  scopeCount: number;
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
} | null;

export type OccupancyChartAnalytics = {
  supportRows: OccupancyChartSupportRow[];
  evolution: OccupancyChartPoint[];
  comparison: OccupancyModalityComparison[];
  donut: OccupancyDonutData;
};

type ChartRecord = Pick<
  OccupancyRecord,
  'id' | 'kind' | 'period' | 'month' | 'modalityId' | 'modalityName' | 'percentage' | 'className'
>;

type ScopeGroup = {
  period: string;
  modalityId: string;
  modalityName: string;
  className: string | null;
  monthly: ChartRecord[];
  daily: ChartRecord[];
};

function average(values: number[]) {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function classKey(value: string | null) {
  return (value ?? '').trim().normalize('NFKC').toLocaleLowerCase('pt-BR');
}

function monthOf(date: string) {
  return date.slice(0, 7);
}

function isCompleteMonthRange(fromDate?: string, toDate?: string) {
  if (!fromDate || !toDate || fromDate > toDate) return false;
  const first = `${monthOf(fromDate)}-01`;
  const month = monthOf(toDate);
  const lastDay = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
  return fromDate === first && toDate === `${month}-${String(lastDay).padStart(2, '0')}`;
}

function availablePeriodCount(filters: OccupancyChartFilters, fallback: number) {
  const selectedMonths = [...new Set(filters.selectedMonths ?? [])];
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
  const months = [...new Set(filters.selectedMonths ?? [])].sort();
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

function sourceLabelOrder(a: OccupancyChartSource, b: OccupancyChartSource): OccupancyChartSource {
  return a === 'average' || b === 'average' ? 'average' : 'reported';
}

function stableUnique(records: ChartRecord[]) {
  const seen = new Set<string>();
  return records.filter((record) => {
    if (seen.has(record.id)) return false;
    seen.add(record.id);
    return true;
  });
}

/**
 * Consolidates persisted occupancy percentages without ever adding rates.
 * Monthly reported values replace daily details within the same modality/class
 * scope; where no monthly value exists, daily values use an arithmetic mean.
 */
export function buildOccupancyChartAnalytics(
  records: readonly ChartRecord[],
  filters: OccupancyChartFilters,
): OccupancyChartAnalytics {
  const monthlyAllowed = filters.selectedMonths?.length
    ? true
    : isCompleteMonthRange(filters.fromDate, filters.toDate);
  const relevant = stableUnique(records.filter((record) => {
    if (!isInSelectedPeriod(record, filters)) return false;
    if (record.kind === 'monthly' && !monthlyAllowed) return false;
    return true;
  }));

  const scopes = new Map<string, ScopeGroup>();
  for (const record of relevant) {
    const period = filters.viewMode === 'daily' ? record.period : record.month;
    const key = JSON.stringify([period, record.modalityId, classKey(record.className)]);
    let group = scopes.get(key);
    if (!group) {
      group = {
        period,
        modalityId: record.modalityId,
        modalityName: record.modalityName,
        className: record.className,
        monthly: [],
        daily: [],
      };
      scopes.set(key, group);
    }
    if (record.kind === 'monthly') group.monthly.push(record);
    else group.daily.push(record);
  }

  const supportRows: OccupancyChartSupportRow[] = [];
  for (const [key, group] of scopes) {
    if (filters.viewMode === 'daily') {
      if (!group.daily.length) continue;
      const daily = group.daily;
      supportRows.push({
        key,
        period: group.period,
        modalityId: group.modalityId,
        modalityName: group.modalityName,
        className: group.className,
        percentage: average(daily.map((record) => record.percentage)),
        source: daily.length === 1 ? 'reported' : 'average',
        recordCount: daily.length,
      });
      continue;
    }

    if (group.monthly.length) {
      const monthly = group.monthly;
      supportRows.push({
        key,
        period: group.period,
        modalityId: group.modalityId,
        modalityName: group.modalityName,
        className: group.className,
        percentage: average(monthly.map((record) => record.percentage)),
        source: monthly.length === 1 ? 'reported' : 'average',
        recordCount: monthly.length,
      });
    } else if (group.daily.length) {
      supportRows.push({
        key,
        period: group.period,
        modalityId: group.modalityId,
        modalityName: group.modalityName,
        className: group.className,
        percentage: average(group.daily.map((record) => record.percentage)),
        source: 'average',
        recordCount: group.daily.length,
      });
    }
  }

  supportRows.sort((a, b) =>
    a.period.localeCompare(b.period)
    || a.modalityName.localeCompare(b.modalityName, 'pt-BR', { sensitivity: 'base' })
    || (a.className ?? '').localeCompare(b.className ?? '', 'pt-BR', { sensitivity: 'base' }),
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
      const sources = rows.map((row) => row.source);
      return {
        period,
        modalityId,
        modalityName: rows[0].modalityName,
        percentage: average(rows.map((row) => row.percentage)),
        source: rows.length > 1 ? 'average' : sources.reduce(sourceLabelOrder, 'reported'),
        recordCount: rows.reduce((count, row) => count + row.recordCount, 0),
        scopeCount: rows.length,
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
      return {
        modalityId,
        modalityName: group.modalityName,
        percentage: average(values.map((point) => point.percentage)),
        source: values.length > 1
          ? 'average'
          : values.reduce<OccupancyChartSource>((source, point) => sourceLabelOrder(source, point.source ?? 'reported'), 'reported'),
        coveredPeriods: values.length,
        availablePeriods: availablePeriodCount(filters, values.length),
      };
    })
    .sort((a, b) => a.modalityName.localeCompare(b.modalityName, 'pt-BR', { sensitivity: 'base' }));

  const selectedPoints = filters.modalityId
    ? points.filter((point) => point.modalityId === filters.modalityId)
    : [];
  const selectedModalityName = selectedPoints[0]?.modalityName
    ?? supportRows.find((row) => row.modalityId === filters.modalityId)?.modalityName
    ?? comparison.find((row) => row.modalityId === filters.modalityId)?.modalityName
    ?? '';
  const pointsByPeriod = new Map(selectedPoints.map((point) => [point.period, point]));
  const expected = expectedPeriods(filters);
  const evolution: OccupancyChartPoint[] = expected.length && filters.modalityId
    ? expected.map((period) => pointsByPeriod.get(period) ?? {
      period,
      modalityId: filters.modalityId!,
      modalityName: selectedModalityName,
      percentage: null,
      source: null,
      recordCount: 0,
      scopeCount: 0,
    })
    : selectedPoints;
  const selectedSummary = comparison.find((item) => item.modalityId === filters.modalityId);
  const donut: OccupancyDonutData = selectedSummary
    ? {
      occupied: selectedSummary.percentage,
      unoccupied: 100 - selectedSummary.percentage,
      source: selectedSummary.source,
      coveredPeriods: selectedSummary.coveredPeriods,
      availablePeriods: selectedSummary.availablePeriods,
    }
    : null;

  return { supportRows, evolution, comparison, donut };
}
