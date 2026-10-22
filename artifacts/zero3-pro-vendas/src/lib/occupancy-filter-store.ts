import { useSyncExternalStore } from 'react';
import type { GetOccupancyRecordsParams } from '@workspace/api-client-react';
import { formatMonthKey, getSaoPauloMonthKey } from '@/lib/sales-utils';

export type OccupancyPeriodMode = 'all' | 'day' | 'range' | 'months';
export type OccupancyChartViewMode = 'daily' | 'monthly' | 'quarterly';

export type OccupancyFilterState = {
  periodMode: OccupancyPeriodMode;
  day: string;
  fromDate: string;
  toDate: string;
  months: string[];
  year: string;
  quarter: string;
  modalityId: string;
  className: string;
  startTimes: string[];
  weekdays: number[];
  viewMode: OccupancyChartViewMode;
};

const initialState: OccupancyFilterState = {
  periodMode: 'all',
  day: '',
  fromDate: '',
  toDate: '',
  months: [],
  year: '',
  quarter: '',
  modalityId: '',
  className: '',
  startTimes: [],
  weekdays: [],
  viewMode: 'daily',
};

let snapshot = initialState;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  return snapshot;
}

export function useOccupancyFilterState() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function updateOccupancyFilters(patch: Partial<OccupancyFilterState>) {
  snapshot = { ...snapshot, ...patch };
  listeners.forEach((listener) => listener());
}

export function changeOccupancyPeriod(mode: OccupancyPeriodMode) {
  const common = {
    periodMode: mode,
    day: '',
    fromDate: '',
    toDate: '',
  };
  if (mode === 'day' || mode === 'range') {
    updateOccupancyFilters({ ...common, months: [], year: '', quarter: '' });
  } else {
    updateOccupancyFilters({
      ...common,
      ...(mode === 'months' && snapshot.months.length === 0 ? { months: [getSaoPauloMonthKey()] } : {}),
    });
  }
}

export function updateOccupancyYear(year: string) {
  updateOccupancyFilters({
    year,
    ...(snapshot.periodMode === 'day' || snapshot.periodMode === 'range'
      ? { periodMode: 'all' as const, day: '', fromDate: '', toDate: '' }
      : {}),
  });
}

export function updateOccupancyQuarter(quarter: string) {
  updateOccupancyFilters({
    quarter,
    ...(snapshot.periodMode === 'day' || snapshot.periodMode === 'range'
      ? { periodMode: 'all' as const, day: '', fromDate: '', toDate: '' }
      : {}),
  });
}

export function clearOccupancyFilters() {
  snapshot = { ...initialState };
  listeners.forEach((listener) => listener());
}

export function occupancyFilterProblem(filters: OccupancyFilterState): string | null {
  if (filters.periodMode === 'day' && !filters.day) return 'Escolha o dia que deseja consultar.';
  if (filters.periodMode === 'range' && (!filters.fromDate || !filters.toDate)) return 'Informe as datas inicial e final do intervalo.';
  if (filters.periodMode === 'range' && filters.fromDate > filters.toDate) return 'A data inicial deve ser anterior ou igual à final.';
  if (filters.periodMode === 'months' && !filters.months.length) return 'Selecione ao menos um mês.';
  return null;
}

export function occupancyFilterSummary(filters: OccupancyFilterState) {
  const parts: string[] = [];
  if (filters.periodMode === 'day' && filters.day) parts.push(`Dia ${filters.day}`);
  else if (filters.periodMode === 'range' && filters.fromDate && filters.toDate) parts.push(`${filters.fromDate} a ${filters.toDate}`);
  else if (filters.periodMode === 'months') parts.push(filters.months.map(formatMonthKey).join(', '));
  else parts.push('Todo o histórico');
  if (filters.year) parts.push(`Ano ${filters.year}`);
  if (filters.quarter) parts.push(`${filters.quarter}º trimestre`);
  if (filters.startTimes.length) parts.push(`Horários ${[...filters.startTimes].sort().join(', ')}`);
  if (filters.weekdays.length) {
    const labels = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'];
    parts.push(filters.weekdays.map((day) => labels[day - 1]).join(', '));
  }
  return parts.filter(Boolean).join(' · ');
}

export function occupancyAnalyticsMonths(filters: OccupancyFilterState): string[] | undefined {
  let candidates: string[] | null = null;
  if (filters.periodMode === 'months') candidates = [...filters.months];
  else if (filters.periodMode !== 'day' && filters.periodMode !== 'range' && filters.year && filters.quarter) {
    const firstMonth = (Number(filters.quarter) - 1) * 3 + 1;
    candidates = Array.from({ length: 3 }, (_, index) => `${filters.year}-${String(firstMonth + index).padStart(2, '0')}`);
  } else if (filters.periodMode !== 'day' && filters.periodMode !== 'range' && filters.year) {
    candidates = Array.from({ length: 12 }, (_, index) => `${filters.year}-${String(index + 1).padStart(2, '0')}`);
  }
  if (!candidates) return undefined;
  return candidates.filter((month) =>
    (!filters.year || month.startsWith(`${filters.year}-`))
    && (!filters.quarter || Math.floor((Number(month.slice(5, 7)) - 1) / 3) + 1 === Number(filters.quarter)),
  );
}

export function occupancyQueryParams(
  filters: OccupancyFilterState,
  kind: 'all' | 'daily' | 'monthly' = 'all',
  className = filters.className,
): GetOccupancyRecordsParams {
  const params: GetOccupancyRecordsParams = { kind };
  if (filters.periodMode === 'day' && filters.day) {
    params.fromDate = filters.day;
    params.toDate = filters.day;
  } else if (filters.periodMode === 'range' && filters.fromDate && filters.toDate && filters.fromDate <= filters.toDate) {
    params.fromDate = filters.fromDate;
    params.toDate = filters.toDate;
  } else if (filters.periodMode === 'months' && filters.months.length) {
    params.months = [...filters.months].sort().join(',');
  }
  if (filters.periodMode !== 'range' && filters.periodMode !== 'day') {
    if (filters.year) params.year = Number(filters.year);
    if (filters.quarter) params.quarter = Number(filters.quarter);
  }
  if (filters.modalityId) params.modalityId = filters.modalityId;
  if (className.trim()) params.className = className.trim();
  if (filters.startTimes.length) params.startTimes = [...filters.startTimes].sort().join(',');
  if (filters.weekdays.length) params.weekdays = [...filters.weekdays].sort((a, b) => a - b).join(',');
  return params;
}

export function currentOccupancyMonth() {
  return getSaoPauloMonthKey();
}
