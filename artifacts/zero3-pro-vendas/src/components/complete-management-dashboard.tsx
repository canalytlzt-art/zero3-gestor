import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  getGetActiveContractsQueryKey,
  getGetOccupancyModalitiesQueryKey,
  getGetOccupancyMonthlyGoalsQueryKey,
  getGetOccupancyRecordsQueryKey,
  getGetSalesGoalsQueryKey,
  getGetSalesScoreboardQueryKey,
  type GetOccupancyRecordsParams,
  type GetSalesScoreboardParams,
  useGetActiveContracts,
  useGetOccupancyModalities,
  useGetOccupancyMonthlyGoals,
  useGetOccupancyRecords,
  useGetSalesGoals,
  useGetSalesScoreboard,
  useUpsertOccupancyMonthlyGoal,
} from '@workspace/api-client-react';
import {
  CalendarDays, ChevronDown, CircleAlert, Download, Moon, Printer, RefreshCw, Sun,
} from 'lucide-react';
import {
  Bar, BarChart, CartesianGrid, Cell, ComposedChart, Legend, Line, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { ChartContainer } from '@/components/ui/chart';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { buildFinancialChartAnalytics } from '@/lib/financial-chart-data';
import { buildOccupancyChartAnalytics } from '@/lib/occupancy-chart-data';
import { formatCents, formatMonthKey, getSaoPauloMonthKey, monthsForYearQuarter } from '@/lib/sales-utils';

type PeriodMode = 'month' | 'year' | 'quarter' | 'range';
type Props = { onOccupancy: () => void; onFinancial: () => void; onContracts: () => void };

const palette = { purple: '#7655a8', lime: '#a9d75a', ink: '#342d40', muted: '#837b8b', cream: '#fffefc', orange: '#d18b57', green: '#6f9d45' };
const intervalOptions = [{ label: '5 minutos', value: 300_000 }, { label: '15 minutos', value: 900_000 }, { label: '1 hora', value: 3_600_000 }];
const panel = 'min-w-0 rounded-[22px] border border-[#e9e4eb] bg-[#fffefc] p-4 shadow-[0_14px_35px_-30px_rgba(55,40,72,.28)] sm:p-5';

function monthLabel(value: string) { return formatMonthKey(value); }
function count(value: number | null | undefined) { return value == null ? '—' : value.toLocaleString('pt-BR'); }
function money(value: number) { return formatCents(Math.round(value)); }
function errorMessage(error: unknown) {
  return error && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
    ? error.message : 'Confira a conexão e tente atualizar novamente.';
}
function downloadCsv(filename: string, rows: Record<string, string | number | null>[]) {
  if (!rows.length) return;
  const headers = Object.keys(rows[0]);
  const quote = (value: unknown) => `"${String(value ?? '').replaceAll('"', '""')}"`;
  const csv = [headers.map(quote).join(';'), ...rows.map((row) => headers.map((header) => quote(row[header])).join(';'))].join('\r\n');
  const url = URL.createObjectURL(new Blob(['\ufeff', csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url; link.download = filename; link.click(); URL.revokeObjectURL(url);
}
function dateMonth(value: string) { return value.slice(0, 7); }
function completeMonthInRange(month: string, from: string, to: string) {
  const [year, monthNumber] = month.split('-').map(Number);
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
  return Boolean(from && to && from <= `${month}-01` && to >= lastDay);
}
function monthRange(from: string, to: string) {
  if (!from || !to || from > to) return [];
  const [fy, fm] = from.slice(0, 7).split('-').map(Number);
  const [ty, tm] = to.slice(0, 7).split('-').map(Number);
  return Array.from({ length: Math.min(241, (ty - fy) * 12 + tm - fm + 1) }, (_, i) => {
    const d = new Date(Date.UTC(fy, fm - 1 + i, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  });
}
function toSaoPauloDate(date: Date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}
function dateText(value: string) {
  if (!value) return '';
  const [year, month, day] = value.split('-').map(Number);
  return new Intl.DateTimeFormat('pt-BR').format(new Date(year, month - 1, day));
}

function ChartEmpty({ text }: { text: string }) {
  return <div className="grid h-[280px] place-items-center rounded-2xl border border-dashed border-[#e9e4eb] bg-[#fbfafc] px-6 text-center text-xs text-[#837b8b]">{text}</div>;
}

function ExportButton({ rows, filename, dark }: { rows: Record<string, string | number | null>[]; filename: string; dark: boolean }) {
  return <button type="button" onClick={() => downloadCsv(filename, rows)} disabled={!rows.length} aria-label={`Exportar ${filename} em CSV`} data-testid={`button-export-${filename.replace('.csv', '')}`} className="grid h-9 w-9 place-items-center rounded-xl border border-[#e9e4eb] text-[#716879] transition hover:bg-[#f8f5fb] disabled:opacity-40" style={dark ? { borderColor: '#493f55', color: '#d8cdea' } : undefined}><Download size={15} /></button>;
}

export default function CompleteManagementDashboard({ onOccupancy, onFinancial, onContracts }: Props) {
  const nowMonth = getSaoPauloMonthKey();
  const [mode, setMode] = useState<PeriodMode>('year');
  const [year, setYear] = useState(nowMonth.slice(0, 4));
  const [month, setMonth] = useState(nowMonth);
  const [quarter, setQuarter] = useState(String(Math.ceil(Number(nowMonth.slice(5, 7)) / 3)));
  const [fromDate, setFromDate] = useState(`${nowMonth}-01`);
  const [toDate, setToDate] = useState(toSaoPauloDate(new Date()));
  const [modalityId, setModalityId] = useState('');
  const [weekday, setWeekday] = useState('');
  const [startTime, setStartTime] = useState('');
  const [dark, setDark] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [interval, setInterval] = useState(300_000);
  const [menuOpen, setMenuOpen] = useState(false);
  const [spinning, setSpinning] = useState(false);
  const [goalDialogOpen, setGoalDialogOpen] = useState(false);
  const [goalMonth, setGoalMonth] = useState(nowMonth);
  const [goalModalityId, setGoalModalityId] = useState('');
  const [aggregatorGoalDraft, setAggregatorGoalDraft] = useState('');
  const [occupancyGoalDraft, setOccupancyGoalDraft] = useState('');
  const [goalNotesDraft, setGoalNotesDraft] = useState('');
  const menuRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();
  const saveGoalMutation = useUpsertOccupancyMonthlyGoal();

  const selectedMonths = useMemo(() => {
    if (mode === 'month') return month ? [month] : [];
    if (mode === 'quarter') return monthsForYearQuarter(year, quarter);
    if (mode === 'year') return monthsForYearQuarter(year);
    return monthRange(fromDate, toDate);
  }, [mode, month, year, quarter, fromDate, toDate]);
  const invalid = selectedMonths.length === 0 || (mode === 'range' && (!fromDate || !toDate || fromDate > toDate));
  const salesParams = useMemo<GetSalesScoreboardParams>(() => mode === 'range'
    ? { fromDate, toDate }
    : { months: selectedMonths }, [mode, fromDate, toDate, selectedMonths]);
  const occupancyParams = useMemo<GetOccupancyRecordsParams>(() => {
    const params: GetOccupancyRecordsParams = { kind: 'all' };
    if (mode === 'range') { params.fromDate = fromDate; params.toDate = toDate; }
    else params.months = selectedMonths.join(',');
    if (modalityId) params.modalityId = modalityId;
    if (weekday) params.weekdays = weekday;
    if (startTime) params.startTimes = startTime;
    return params;
  }, [mode, fromDate, toDate, selectedMonths, modalityId, weekday, startTime]);

  const salesQuery = useGetSalesScoreboard(salesParams, { query: { queryKey: getGetSalesScoreboardQueryKey(salesParams), enabled: !invalid, staleTime: 300_000 } });
  const goalsQuery = useGetSalesGoals({ query: { queryKey: getGetSalesGoalsQueryKey(), staleTime: 300_000 } });
  const contractsQuery = useGetActiveContracts({ query: { queryKey: getGetActiveContractsQueryKey(), staleTime: 300_000 } });
  const occupancyGoalsQuery = useGetOccupancyMonthlyGoals(undefined, { query: { queryKey: getGetOccupancyMonthlyGoalsQueryKey(), staleTime: 300_000 } });
  const occupancyQuery = useGetOccupancyRecords(occupancyParams, { query: { queryKey: getGetOccupancyRecordsQueryKey(occupancyParams), enabled: !invalid, staleTime: 300_000 } });
  const modalityQuery = useGetOccupancyModalities({ query: { queryKey: getGetOccupancyModalitiesQueryKey(), staleTime: 300_000 } });
  const filterOptionsQuery = useGetOccupancyRecords({ kind: 'all' }, { query: { queryKey: getGetOccupancyRecordsQueryKey({ kind: 'all' }), staleTime: 300_000 } });

  const finance = useMemo(() => salesQuery.data ? buildFinancialChartAnalytics(salesQuery.data) : null, [salesQuery.data]);
  const periodEndMonth = selectedMonths.at(-1) ?? '';
  const contracts = useMemo(() => (contractsQuery.data ?? []).filter((row) => selectedMonths.includes(row.month)).sort((a, b) => a.month.localeCompare(b.month)), [contractsQuery.data, selectedMonths]);
  const goals = useMemo(() => (goalsQuery.data ?? []).filter((goal) => goal.productName === null && selectedMonths.includes(goal.month)), [goalsQuery.data, selectedMonths]);
  const contractChart = contracts.map((record) => ({ month: record.month, activeCount: record.activeCount, targetCount: record.targetCount }));
  const revenueChart = (finance?.months ?? []).map((row) => ({
    ...row,
    targetCents: mode === 'range' && !completeMonthInRange(row.month, fromDate, toDate)
      ? null
      : goals.find((goal) => goal.month === row.month)?.targetCents ?? null,
  }));

  const occupancyFilters = useMemo(() => ({
    viewMode: mode === 'range' ? 'daily' as const : 'monthly' as const,
    ...(mode === 'range' ? { fromDate, toDate } : { selectedMonths }),
    modalityId: modalityId || undefined,
    weekdays: weekday ? [Number(weekday)] : [],
    startTimes: startTime ? [startTime] : [],
  }), [mode, fromDate, toDate, selectedMonths, modalityId, weekday, startTime]);
  const occupancy = useMemo(() => buildOccupancyChartAnalytics(occupancyQuery.data ?? [], occupancyFilters), [occupancyQuery.data, occupancyFilters]);
  const monthBuckets = useMemo(() => {
    if (mode !== 'range') return occupancy.evolution.map((point) => ({ month: point.period, percentage: point.percentage, presences: point.presences, capacity: point.capacity }));
    const groups = new Map<string, { presences: number; capacity: number; hasMeasured: boolean; legacy: number[] }>();
    for (const row of occupancy.supportRows) {
      const key = dateMonth(row.period);
      const group = groups.get(key) ?? { presences: 0, capacity: 0, hasMeasured: false, legacy: [] };
      if (row.source === 'weighted' && row.presences != null && row.capacity != null) {
        group.presences += row.presences; group.capacity += row.capacity; group.hasMeasured = true;
      } else group.legacy.push(row.percentage);
      groups.set(key, group);
    }
    return [...groups.entries()].map(([key, item]) => ({
      month: key,
      percentage: item.hasMeasured ? (item.capacity ? item.presences / item.capacity * 100 : 0) : item.legacy.length ? item.legacy.reduce((a, b) => a + b, 0) / item.legacy.length : null,
      presences: item.hasMeasured ? item.presences : null,
      capacity: item.hasMeasured ? item.capacity : null,
    })).sort((a, b) => a.month.localeCompare(b.month));
  }, [mode, occupancy.evolution, occupancy.supportRows]);
  const aggregatorRows = occupancy.aggregatorsByMonth;
  const monthlyGoalRows = occupancyGoalsQuery.data ?? [];
  const goalForMonth = (selectedMonth: string) => {
    if (mode === 'range' && !completeMonthInRange(selectedMonth, fromDate, toDate)) return null;
    return monthlyGoalRows.find((goal) => goal.month === selectedMonth && goal.modalityId === (modalityId || null)) ?? null;
  };
  const aggregatorChartRows = aggregatorRows.map((row) => ({
    ...row,
    aggregatorTargetPresences: goalForMonth(row.month)?.aggregatorTargetPresences ?? null,
  }));
  const occupancyChartRows = monthBuckets.map((row) => ({
    ...row,
    occupancyTargetPercentage: goalForMonth(row.month)?.occupancyTargetPercentage ?? null,
  }));
  const donutRows = occupancy.totals.aggregatorSharePercentage == null ? [] : [
    { name: 'Agregadores', value: occupancy.totals.aggregatorPresences ?? 0 },
    { name: 'Outras presenças', value: occupancy.totals.otherPresences ?? 0 },
  ];
  const revenueGoalsComplete = selectedMonths.length > 0
    && selectedMonths.every((selectedMonth) => goals.some((goal) => goal.month === selectedMonth))
    && (mode !== 'range' || selectedMonths.every((selectedMonth) => completeMonthInRange(selectedMonth, fromDate, toDate)));
  const revenueGoalTotal = revenueGoalsComplete
    ? selectedMonths.reduce((total, selectedMonth) => total + (goals.find((goal) => goal.month === selectedMonth)?.targetCents ?? 0), 0)
    : 0;
  const revenueActual = finance?.totals.netCents ?? 0;
  const revenueProgress = revenueGoalTotal > 0 ? Math.min(100, Math.max(0, revenueActual / revenueGoalTotal * 100)) : null;
  const revenueDonutRows = revenueProgress == null ? [] : [
    { name: 'Realizado', value: revenueProgress },
    { name: 'Falta para a meta', value: 100 - revenueProgress },
  ];
  const filterOptions = filterOptionsQuery.data ?? [];
  const modalities = [...(modalityQuery.data ?? [])].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  const startTimes = [...new Set(filterOptions.map((item) => item.startTime).filter((item): item is string => Boolean(item)))].sort();
  const refreshing = [salesQuery, goalsQuery, contractsQuery, occupancyGoalsQuery, occupancyQuery, modalityQuery, filterOptionsQuery].some((query) => query.isFetching);
  const allError = [salesQuery, goalsQuery, contractsQuery, occupancyGoalsQuery, occupancyQuery, modalityQuery, filterOptionsQuery].some((query) => query.isError);
  const initialLoading = [salesQuery, goalsQuery, contractsQuery, occupancyGoalsQuery, occupancyQuery, modalityQuery, filterOptionsQuery].some((query) => query.isLoading);
  const updatedAt = Math.max(...[salesQuery, goalsQuery, contractsQuery, occupancyGoalsQuery, occupancyQuery, modalityQuery, filterOptionsQuery].map((query) => query.dataUpdatedAt || 0));

  useEffect(() => {
    if (refreshing) {
      setSpinning(true);
      return undefined;
    }
    const timeout = window.setTimeout(() => setSpinning(false), 600);
    return () => window.clearTimeout(timeout);
  }, [refreshing]);
  useEffect(() => {
    if (!autoRefresh) return;
    const timer = window.setInterval(() => void queryClient.invalidateQueries(), Math.max(300_000, interval));
    return () => window.clearInterval(timer);
  }, [autoRefresh, interval, queryClient]);
  useEffect(() => {
    const clickOutside = (event: MouseEvent) => { if (menuRef.current && !menuRef.current.contains(event.target as Node)) setMenuOpen(false); };
    document.addEventListener('mousedown', clickOutside);
    return () => document.removeEventListener('mousedown', clickOutside);
  }, []);
  useEffect(() => () => { document.documentElement.classList.remove('zero3-dashboard-dark'); }, []);

  const refresh = () => void Promise.all([
    salesQuery.refetch(), goalsQuery.refetch(), contractsQuery.refetch(), occupancyGoalsQuery.refetch(), occupancyQuery.refetch(), modalityQuery.refetch(), filterOptionsQuery.refetch(),
  ]);
  const loadGoalDraft = (selectedMonth: string, selectedModalityId: string) => {
    const record = monthlyGoalRows.find((goal) => goal.month === selectedMonth && goal.modalityId === (selectedModalityId || null));
    setAggregatorGoalDraft(record?.aggregatorTargetPresences == null ? '' : String(record.aggregatorTargetPresences));
    setOccupancyGoalDraft(record?.occupancyTargetPercentage == null ? '' : String(record.occupancyTargetPercentage));
    setGoalNotesDraft(record?.notes ?? '');
  };
  const openGoalDialog = () => {
    const selectedMonth = mode === 'month' ? month : nowMonth;
    setGoalMonth(selectedMonth);
    setGoalModalityId(modalityId);
    loadGoalDraft(selectedMonth, modalityId);
    setGoalDialogOpen(true);
  };
  const canSaveGoal = (() => {
    if (aggregatorGoalDraft === '' && occupancyGoalDraft === '') return false;
    if (aggregatorGoalDraft !== '') {
      const value = Number(aggregatorGoalDraft);
      if (!Number.isInteger(value) || value < 0 || value > 2_147_483_647) return false;
    }
    if (occupancyGoalDraft !== '') {
      const value = Number(occupancyGoalDraft);
      if (!Number.isFinite(value) || value < 0) return false;
    }
    return true;
  })();
  const saveGoal = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSaveGoal) return;
    const aggregatorTargetPresences = aggregatorGoalDraft === '' ? null : Number(aggregatorGoalDraft);
    const occupancyTargetPercentage = occupancyGoalDraft === '' ? null : Number(occupancyGoalDraft);
    try {
      await saveGoalMutation.mutateAsync({
        month: goalMonth,
        data: {
          modalityId: goalModalityId || null,
          aggregatorTargetPresences,
          occupancyTargetPercentage,
          notes: goalNotesDraft.trim() || null,
        },
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getGetOccupancyMonthlyGoalsQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getGetOccupancyRecordsQueryKey() }),
      ]);
      setGoalDialogOpen(false);
    } catch {
      // The mutation error is shown in the dialog without exposing request details.
    }
  };
  const lastRefresh = updatedAt ? new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(updatedAt)) : null;
  const periodLabel = mode === 'range' ? `Recorte exato: ${dateText(fromDate)} a ${dateText(toDate)} · saldos mensais consideram meses sobrepostos` : mode === 'month' ? monthLabel(month) : mode === 'quarter' ? `${quarter}º trimestre de ${year}` : `Ano ${year}`;
  const theme = dark ? 'bg-[#292333] text-[#f6f0fb]' : 'bg-[#f8f6f2] text-[#342d40]';
  const cardTheme = dark ? 'bg-[#332c3d] border-[#493f55]' : 'bg-[#fffefc] border-[#e9e4eb]';
  const axis = dark ? '#c6bacf' : '#837b8b';
  const grid = dark ? '#4a4054' : '#eee9f1';

  return (
    <section className={`min-h-[100dvh] space-y-4 rounded-[26px] p-3 transition-colors sm:p-5 ${theme}`} aria-label="Painel completo de gestão" data-testid="page-complete-management-dashboard">
      <header className={`flex flex-col justify-between gap-4 rounded-[22px] border p-4 shadow-[0_14px_35px_-30px_rgba(55,40,72,.28)] sm:flex-row sm:items-center sm:px-6 ${cardTheme}`}>
        <div>
          <p className="text-[9px] font-bold uppercase tracking-[.14em] text-[#8a8491]">zero3 pro <span className="mx-1 text-[#b2abb8]">/</span> gestão completa</p>
          <h1 className="mt-1 font-[family-name:var(--app-font-serif)] text-3xl font-extrabold leading-none tracking-[-.07em] sm:text-[2.6rem]">Completa<span className="ml-1 text-[#a9d75a]">.</span></h1>
          <p className="mt-2 text-xs text-[#837b8b]">Vendas, contratos, ocupação e presenças agregadoras em um só painel.</p>
          {lastRefresh && <p className="mt-2 text-[10px] text-[#837b8b]" role="status" data-testid="text-dashboard-last-refresh">Atualizado em {lastRefresh}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2 print:hidden">
          <nav className="flex items-center gap-1 rounded-full bg-[#f5f2f6] p-1" aria-label="Painéis relacionados">
            <span className="rounded-full bg-[#ece6f4] px-3 py-2 text-xs font-bold text-[#65479c]" aria-current="page">Completa</span>
            <button type="button" onClick={onOccupancy} className="rounded-full px-3 py-2 text-xs font-semibold text-[#716879] hover:bg-white" data-testid="button-open-occupancy">Ocupação</button>
            <button type="button" onClick={onFinancial} className="rounded-full px-3 py-2 text-xs font-semibold text-[#716879] hover:bg-white" data-testid="button-open-financial">Faturamento</button>
            <button type="button" onClick={onContracts} className="rounded-full px-3 py-2 text-xs font-semibold text-[#716879] hover:bg-white" data-testid="button-open-contracts">Contratos</button>
          </nav>
          <div className="relative" ref={menuRef}>
            <div className="flex h-9 overflow-hidden rounded-xl border border-[#e9e4eb] bg-[#f8f5fb] text-xs text-[#594d68]">
              <button type="button" onClick={refresh} disabled={refreshing} className="flex items-center gap-2 px-3 font-bold disabled:opacity-50" aria-label="Atualizar painel" data-testid="button-refresh-management"><RefreshCw size={14} className={spinning ? 'animate-spin' : ''} /> Atualizar</button>
              <span className="my-2 w-px bg-[#e1dce6]" />
              <button type="button" onClick={() => setMenuOpen((open) => !open)} aria-expanded={menuOpen} aria-label="Opções de atualização automática" className="px-2" data-testid="button-refresh-options"><ChevronDown size={15} /></button>
            </div>
            {menuOpen && <div className="absolute right-0 z-20 mt-2 w-64 rounded-2xl border border-[#e9e4eb] bg-[#fffefc] p-4 text-[#443d50] shadow-xl">
              <label className="flex cursor-pointer items-center justify-between gap-3 text-xs font-bold"><span>Atualização automática</span><input type="checkbox" checked={autoRefresh} onChange={(event) => setAutoRefresh(event.target.checked)} className="h-4 w-4 accent-[#7655a8]" data-testid="input-auto-refresh" /></label>
              <label className="mt-4 block text-[10px] font-bold uppercase tracking-wide text-[#837b8b]" htmlFor="refresh-interval">Intervalo (mínimo 5 min)</label>
              <select id="refresh-interval" disabled={!autoRefresh} value={interval} onChange={(event) => setInterval(Math.max(300_000, Number(event.target.value)))} className="mt-1 h-9 w-full rounded-lg border border-[#e9e4eb] bg-white px-2 text-xs disabled:opacity-50" data-testid="select-refresh-interval">{intervalOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
            </div>}
          </div>
          <button type="button" onClick={() => { saveGoalMutation.reset(); openGoalDialog(); }} className="h-9 rounded-xl border border-[#e9e4eb] bg-[#f8f5fb] px-3 text-xs font-bold text-[#65479c] transition hover:bg-[#f1ebf7]" data-testid="button-set-occupancy-goals">Definir metas mensais</button>
          <button type="button" onClick={() => window.print()} className="grid h-9 w-9 place-items-center rounded-xl border border-[#e9e4eb] bg-[#f8f5fb] text-[#716879]" aria-label="Imprimir ou salvar como PDF" data-testid="button-print-dashboard"><Printer size={15} /></button>
          <button type="button" onClick={() => { setDark((value) => { document.documentElement.classList.toggle('zero3-dashboard-dark', !value); return !value; }); }} className="grid h-9 w-9 place-items-center rounded-xl border border-[#e9e4eb] bg-[#f8f5fb] text-[#716879]" aria-label={dark ? 'Ativar tema claro' : 'Ativar tema escuro'} data-testid="button-toggle-dashboard-theme">{dark ? <Sun size={15} /> : <Moon size={15} />}</button>
        </div>
      </header>

      <section className={`rounded-[22px] border p-4 sm:p-5 ${cardTheme}`} aria-label="Filtros globais">
        <div className="mb-3 flex items-center gap-2"><CalendarDays size={15} className="text-[#7655a8]" /><h2 className="text-xs font-extrabold">Período de análise</h2><span className="ml-auto text-[10px] text-[#837b8b]">{periodLabel}</span></div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="text-[10px] font-bold text-[#837b8b]">Visão temporal<select value={mode} onChange={(event) => setMode(event.target.value as PeriodMode)} className="mt-1 h-10 w-full rounded-xl border border-[#e9e4eb] bg-[#fffefc] px-3 text-xs font-semibold text-[#443d50]" data-testid="select-period-mode"><option value="year">Ano</option><option value="quarter">Trimestre</option><option value="month">Mês</option><option value="range">Intervalo personalizado</option></select></label>
          {(mode === 'year' || mode === 'quarter') && <label className="text-[10px] font-bold text-[#837b8b]">Ano<select value={year} onChange={(event) => setYear(event.target.value)} className="mt-1 h-10 w-full rounded-xl border border-[#e9e4eb] bg-[#fffefc] px-3 text-xs font-semibold text-[#443d50]" data-testid="select-dashboard-year">{Array.from({ length: 8 }, (_, index) => String(Number(nowMonth.slice(0, 4)) - index)).map((value) => <option key={value}>{value}</option>)}</select></label>}
          {mode === 'quarter' && <label className="text-[10px] font-bold text-[#837b8b]">Trimestre<select value={quarter} onChange={(event) => setQuarter(event.target.value)} className="mt-1 h-10 w-full rounded-xl border border-[#e9e4eb] bg-[#fffefc] px-3 text-xs font-semibold text-[#443d50]" data-testid="select-dashboard-quarter">{[1, 2, 3, 4].map((value) => <option key={value} value={value}>{value}º trimestre</option>)}</select></label>}
          {mode === 'month' && <label className="text-[10px] font-bold text-[#837b8b]">Mês<input type="month" value={month} onChange={(event) => setMonth(event.target.value)} className="mt-1 h-10 w-full rounded-xl border border-[#e9e4eb] bg-[#fffefc] px-3 text-xs font-semibold text-[#443d50]" data-testid="input-dashboard-month" /></label>}
          {mode === 'range' && <><label className="text-[10px] font-bold text-[#837b8b]">Data inicial<input type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} className="mt-1 h-10 w-full rounded-xl border border-[#e9e4eb] bg-[#fffefc] px-3 text-xs font-semibold text-[#443d50]" data-testid="input-dashboard-date-from" /></label><label className="text-[10px] font-bold text-[#837b8b]">Data final (inclusiva)<input type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} className="mt-1 h-10 w-full rounded-xl border border-[#e9e4eb] bg-[#fffefc] px-3 text-xs font-semibold text-[#443d50]" data-testid="input-dashboard-date-to" /></label></>}
        </div>
        {mode === 'range' && fromDate > toDate && <p className="mt-2 text-xs text-[#ad5955]" role="alert">A data inicial deve ser anterior ou igual à data final.</p>}
        <div className="mt-4 border-t border-[#eeeaf1] pt-3">
          <p className="mb-2 text-[9px] font-bold uppercase tracking-[.13em] text-[#8a8491]">Filtros exclusivos de ocupação e agregadores</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <label className="text-[10px] font-bold text-[#837b8b]">Modalidade<select value={modalityId} onChange={(event) => setModalityId(event.target.value)} className="mt-1 h-10 w-full rounded-xl border border-[#e9e4eb] bg-[#fffefc] px-3 text-xs font-semibold text-[#443d50]" data-testid="select-dashboard-modality"><option value="">Todas as modalidades</option>{modalities.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
            <label className="text-[10px] font-bold text-[#837b8b]">Dia da semana<select value={weekday} onChange={(event) => setWeekday(event.target.value)} className="mt-1 h-10 w-full rounded-xl border border-[#e9e4eb] bg-[#fffefc] px-3 text-xs font-semibold text-[#443d50]" data-testid="select-dashboard-weekday"><option value="">Todos os dias</option>{['Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado', 'Domingo'].map((label, index) => <option key={label} value={index + 1}>{label}</option>)}</select></label>
            <label className="text-[10px] font-bold text-[#837b8b]">Horário inicial<select value={startTime} onChange={(event) => setStartTime(event.target.value)} className="mt-1 h-10 w-full rounded-xl border border-[#e9e4eb] bg-[#fffefc] px-3 text-xs font-semibold text-[#443d50]" data-testid="select-dashboard-start-time"><option value="">Todos os horários</option>{startTimes.map((value) => <option key={value} value={value}>{value.slice(0, 5)}</option>)}</select></label>
          </div>
        </div>
        {allError && <div className="mt-3 flex items-center gap-2 rounded-xl border border-[#ecd5d4] bg-[#fff9f8] p-3 text-xs text-[#806462]" role="status" data-testid="status-partial-dashboard-error"><CircleAlert size={15} /> Parte dos indicadores pode estar indisponível. Atualize para tentar novamente.</div>}
      </section>

      {invalid ? <div className={`${panel} text-center text-sm text-[#837b8b]`}>Revise o período selecionado para consultar os indicadores.</div> : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2" data-testid="grid-complete-management-charts">
          <section className={`${panel} ${dark ? 'bg-[#332c3d] border-[#493f55]' : ''}`} data-testid="chart-complete-contracts">
            <div className="mb-3 flex items-start justify-between gap-2"><div><p className="text-[9px] font-bold uppercase tracking-[.14em] text-[#8c73b4]">base ativa</p><h2 className="mt-1 font-[family-name:var(--app-font-serif)] text-xl font-extrabold tracking-[-.045em]">Contratos e meta</h2><p className="mt-1 text-[10px] text-[#837b8b]">Comparação de saldos mensais salvos; meses sem registro não são exibidos.</p></div><ExportButton rows={contracts.map((row) => ({ mes: row.month, contratosAtivos: row.activeCount, meta: row.targetCount }))} filename="contratos-e-meta.csv" dark={dark} /></div>
            {contractsQuery.isLoading ? <div className="h-[280px] animate-pulse rounded-2xl bg-[#f1edf4]" /> : contractsQuery.isError ? <ChartEmpty text={`Não foi possível carregar contratos. ${errorMessage(contractsQuery.error)}`} /> : contractChart.length ? <ChartContainer role="img" aria-label="Barras horizontais agrupadas de contratos ativos e meta mensal" config={{ activeCount: { label: 'Contratos ativos', color: palette.purple }, targetCount: { label: 'Meta salva', color: palette.lime } }} className="h-[310px] w-full"><ResponsiveContainer width="100%" height="100%"><BarChart data={contractChart} layout="vertical" margin={{ left: 4, right: 12, top: 6, bottom: 6 }}><CartesianGrid horizontal={false} stroke={grid} /><XAxis type="number" allowDecimals={false} tick={{ fill: axis, fontSize: 10 }} axisLine={false} tickLine={false} /><YAxis type="category" dataKey="month" width={90} tickFormatter={monthLabel} tick={{ fill: axis, fontSize: 10 }} axisLine={false} tickLine={false} /><Tooltip labelFormatter={(value) => monthLabel(String(value))} formatter={(value, name) => [count(Number(value)), String(name)]} /><Legend wrapperStyle={{ fontSize: 10 }} /><Bar dataKey="activeCount" name="Contratos ativos" fill={palette.purple} radius={[0, 5, 5, 0]} maxBarSize={10} /><Bar dataKey="targetCount" name="Meta salva" fill={palette.lime} radius={[0, 5, 5, 0]} maxBarSize={10} /></BarChart></ResponsiveContainer></ChartContainer> : <ChartEmpty text="Nenhum saldo de contratos ativo registrado neste período." />}
            <div className="mt-2 rounded-xl bg-[#f8f5fb] px-3 py-2">
              <p className="text-[10px] text-[#716879]">Atingimento mensal das metas salvas</p>
              {contracts.some((record) => record.targetCount != null) ? <div className="mt-2 flex flex-wrap gap-2">{contracts.filter((record) => record.targetCount != null).map((record) => {
                const attainment = record.targetCount && record.targetCount > 0 ? record.activeCount / record.targetCount * 100 : null;
                return <span key={record.month} className="rounded-full border border-[#e9e4eb] bg-[#fffefc] px-2.5 py-1 text-[10px] font-semibold text-[#65479c]" data-testid={`text-contract-attainment-${record.month}`}>{monthLabel(record.month)} · {attainment == null ? '—' : `${attainment.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`}</span>;
              })}</div> : <p className="mt-1 text-[10px] font-bold text-[#65479c]">Meta não definida</p>}
            </div>
          </section>

          <section className={`${panel} ${dark ? 'bg-[#332c3d] border-[#493f55]' : ''}`} data-testid="chart-complete-aggregators">
            <div className="mb-3 flex items-start justify-between gap-2"><div><p className="text-[9px] font-bold uppercase tracking-[.14em] text-[#8c73b4]">check-ins via plataformas</p><h2 className="mt-1 font-[family-name:var(--app-font-serif)] text-xl font-extrabold tracking-[-.045em]">Presenças agregadoras</h2><p className="mt-1 text-[10px] text-[#837b8b]">São presenças em aulas, não pessoas únicas.</p></div><ExportButton rows={aggregatorChartRows.map((row) => ({ mes: row.month, presencasAgregadorasInformadas: row.aggregatorPresences, metaMensal: row.aggregatorTargetPresences, totalPresencas: row.totalPresences, coberturaAulas: `${row.aggregatorInformedClassCount}/${row.measuredClassCount}`, participacaoPercentual: row.sharePercentage }))} filename="presencas-agregadoras.csv" dark={dark} /></div>
            {occupancyQuery.isLoading ? <div className="h-[280px] animate-pulse rounded-2xl bg-[#f1edf4]" /> : occupancyQuery.isError ? <ChartEmpty text={`Não foi possível carregar as presenças. ${errorMessage(occupancyQuery.error)}`} /> : aggregatorRows.length ? <div className="grid gap-2">
              <div className="h-[230px] min-w-0"><ChartContainer role="img" aria-label="Barras horizontais de presenças agregadoras e meta mensal" config={{ aggregatorPresences: { label: 'Agregadores', color: palette.purple }, totalPresences: { label: 'Total de presenças', color: palette.lime }, aggregatorTargetPresences: { label: 'Meta mensal', color: palette.orange } }} className="h-full w-full"><ResponsiveContainer width="100%" height="100%"><ComposedChart data={aggregatorChartRows} layout="vertical" margin={{ top: 5, right: 8, bottom: 2, left: 5 }}><CartesianGrid horizontal={false} stroke={grid} /><XAxis type="number" allowDecimals={false} tick={{ fill: axis, fontSize: 9 }} axisLine={false} tickLine={false} /><YAxis type="category" dataKey="month" width={84} tickFormatter={monthLabel} tick={{ fill: axis, fontSize: 9 }} axisLine={false} tickLine={false} /><Tooltip labelFormatter={(value) => monthLabel(String(value))} formatter={(value, name) => [count(Number(value)), String(name)]} /><Legend wrapperStyle={{ fontSize: 9 }} /><Bar dataKey="aggregatorPresences" name="Presenças agregadoras informadas" fill={palette.purple} radius={[0, 4, 4, 0]} maxBarSize={9} /><Bar dataKey="aggregatorTargetPresences" name="Meta mensal" fill={palette.orange} radius={[0, 4, 4, 0]} maxBarSize={9} /><Line dataKey="totalPresences" name="Presenças totais" stroke={palette.lime} strokeWidth={2} dot={{ r: 2 }} connectNulls={false} /></ComposedChart></ResponsiveContainer></ChartContainer></div>
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-[#f8f5fb] px-3 py-2 text-[10px]"><span className="font-bold text-[#65479c]">{modalityId ? 'Meta da modalidade selecionada' : 'Meta geral'}: {aggregatorChartRows.some((row) => row.aggregatorTargetPresences != null) ? 'metas salvas por mês' : 'Meta não definida'}</span><span className="text-[#716879]">Participação total: {occupancy.totals.aggregatorSharePercentage == null ? 'cobertura incompleta' : `${occupancy.totals.aggregatorSharePercentage.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`}</span></div>
              {aggregatorChartRows.some((row) => row.aggregatorTargetPresences != null) && <div className="flex flex-wrap gap-2">{aggregatorChartRows.filter((row) => row.aggregatorTargetPresences != null).map((row) => {
                const completeCoverage = row.measuredClassCount > 0 && row.aggregatorInformedClassCount === row.measuredClassCount;
                const achievement = completeCoverage && row.aggregatorTargetPresences! > 0
                  ? (row.aggregatorPresences ?? 0) / row.aggregatorTargetPresences! * 100
                  : null;
                return <span key={row.month} className="rounded-full border border-[#e9e4eb] bg-[#fffefc] px-2.5 py-1 text-[10px] text-[#65479c]" data-testid={`text-aggregator-goal-${row.month}`}>{monthLabel(row.month)} · {achievement == null ? 'cobertura insuficiente para comparar' : `${achievement.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}% da meta`}</span>;
              })}</div>}
              {donutRows.length ? <div className="flex items-center gap-3 rounded-xl border border-[#eeeaf1] px-3 py-2"><div className="h-[82px] w-[96px] shrink-0"><ResponsiveContainer width="100%" height="100%"><PieChart><Pie data={donutRows} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={23} outerRadius={37} paddingAngle={2} cornerRadius={2} stroke="none" isAnimationActive={false}>{donutRows.map((_, index) => <Cell key={donutRows[index].name} fill={index === 0 ? palette.purple : palette.lime} />)}</Pie><Tooltip formatter={(value) => [count(Number(value)), 'Presenças']} /></PieChart></ResponsiveContainer></div><div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-[#716879]">{donutRows.map((row, index) => <span key={row.name} className="flex items-center gap-1.5"><i className={`h-2 w-2 rounded-sm ${index ? 'bg-[#a9d75a]' : 'bg-[#7655a8]'}`} />{row.name}: <b>{count(row.value)}</b></span>)}</div></div> : <p className="rounded-xl bg-[#fbfafc] px-3 py-2 text-[10px] text-[#837b8b]">A comparação agregadores × demais presenças exige cobertura informada em todas as aulas medidas.</p>}
            </div> : <ChartEmpty text="Nenhuma presença medida neste período." />}
          </section>

          <section className={`${panel} ${dark ? 'bg-[#332c3d] border-[#493f55]' : ''}`} data-testid="chart-complete-occupancy">
            <div className="mb-3 flex items-start justify-between gap-2"><div><p className="text-[9px] font-bold uppercase tracking-[.14em] text-[#8c73b4]">utilização das aulas</p><h2 className="mt-1 font-[family-name:var(--app-font-serif)] text-xl font-extrabold tracking-[-.045em]">Ocupação mensal</h2><p className="mt-1 text-[10px] text-[#837b8b]">{mode === 'range' ? 'Atendimentos diários no intervalo exato, agrupados por mês.' : 'Deduplicação diária/mensal aplicada por aula antes da comparação.'}</p></div><ExportButton rows={occupancyChartRows.map((row) => ({ mes: row.month, ocupacaoPercentual: row.percentage, metaOcupacaoPercentual: row.occupancyTargetPercentage, presencas: row.presences, capacidade: row.capacity }))} filename="ocupacao-mensal.csv" dark={dark} /></div>
            {occupancyQuery.isLoading ? <div className="h-[280px] animate-pulse rounded-2xl bg-[#f1edf4]" /> : occupancyQuery.isError ? <ChartEmpty text={`Não foi possível carregar ocupação. ${errorMessage(occupancyQuery.error)}`} /> : occupancyChartRows.length ? <ChartContainer role="img" aria-label="Colunas de ocupação mensal comparadas à meta" config={{ percentage: { label: 'Ocupação', color: palette.purple }, occupancyTargetPercentage: { label: 'Meta mensal', color: palette.orange } }} className="h-[280px] w-full"><ResponsiveContainer width="100%" height="100%"><ComposedChart data={occupancyChartRows} margin={{ top: 8, right: 8, bottom: 8, left: 3 }}><CartesianGrid vertical={false} stroke={grid} /><XAxis dataKey="month" tickFormatter={monthLabel} tick={{ fill: axis, fontSize: 10 }} axisLine={false} tickLine={false} /><YAxis domain={[0, 'auto']} tickFormatter={(value) => `${Number(value).toLocaleString('pt-BR')}%`} tick={{ fill: axis, fontSize: 10 }} axisLine={false} tickLine={false} /><Tooltip labelFormatter={(value) => monthLabel(String(value))} formatter={(value, name) => [`${Number(value).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`, String(name)]} /><Legend wrapperStyle={{ fontSize: 10 }} /><Bar dataKey="percentage" name="Ocupação" fill={palette.purple} radius={[5, 5, 0, 0]} maxBarSize={34} /><Line dataKey="occupancyTargetPercentage" name="Meta mensal" stroke={palette.orange} strokeWidth={2} strokeDasharray="5 4" connectNulls={false} dot={false} /></ComposedChart></ResponsiveContainer></ChartContainer> : <ChartEmpty text="Nenhum registro de ocupação no recorte; meses sem registros não são tratados como zero." />}
            {occupancyChartRows.some((row) => row.occupancyTargetPercentage != null) && <div className="flex flex-wrap gap-2">{occupancyChartRows.filter((row) => row.occupancyTargetPercentage != null).map((row) => {
              const attainment = row.percentage != null && row.occupancyTargetPercentage! > 0
                ? row.percentage / row.occupancyTargetPercentage! * 100
                : null;
              return <span key={row.month} className="rounded-full border border-[#e9e4eb] bg-[#fffefc] px-2.5 py-1 text-[10px] text-[#65479c]" data-testid={`text-occupancy-goal-${row.month}`}>{monthLabel(row.month)} · {attainment == null ? 'sem comparação' : `${attainment.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}% da meta`}</span>;
            })}</div>}
            <p className="mt-2 rounded-xl bg-[#f8f5fb] px-3 py-2 text-[10px] text-[#716879]">{modalityId ? 'Meta da modalidade selecionada' : 'Meta geral'}: {occupancyChartRows.some((row) => row.occupancyTargetPercentage != null) ? 'metas salvas por mês' : 'Meta não definida'}{mode === 'range' && ' · Metas mensais não se aplicam aos meses parcialmente filtrados.'}</p>
          </section>

          <section className={`${panel} ${dark ? 'bg-[#332c3d] border-[#493f55]' : ''}`} data-testid="chart-complete-revenue">
            <div className="mb-3 flex items-start justify-between gap-2"><div><p className="text-[9px] font-bold uppercase tracking-[.14em] text-[#8c73b4]">scoreboard oficial</p><h2 className="mt-1 font-[family-name:var(--app-font-serif)] text-xl font-extrabold tracking-[-.045em]">Vendas, estornos e líquido</h2><p className="mt-1 text-[10px] text-[#837b8b]">Valores conforme os totais calculados pelo Scoreboard.</p></div><ExportButton rows={revenueChart.map((row) => ({ mes: row.month, vendasCentavos: row.salesCents, estornosCentavos: row.refundCents, liquidoCentavos: row.netCents, metaGeralCentavos: row.targetCents }))} filename="vendas-estornos-liquido.csv" dark={dark} /></div>
            {salesQuery.isLoading ? <div className="h-[280px] animate-pulse rounded-2xl bg-[#f1edf4]" /> : salesQuery.isError ? <ChartEmpty text={`Não foi possível carregar o Scoreboard. ${errorMessage(salesQuery.error)}`} /> : revenueChart.length ? <ChartContainer role="img" aria-label="Barras horizontais mensais de vendas, estornos, líquido e meta geral em reais" config={{ salesCents: { label: 'Vendas', color: palette.purple }, refundCents: { label: 'Estornos', color: palette.orange }, netCents: { label: 'Líquido', color: palette.green }, targetCents: { label: 'Meta geral', color: palette.lime } }} className="h-[360px] w-full"><ResponsiveContainer width="100%" height="100%"><BarChart data={revenueChart} layout="vertical" margin={{ top: 8, right: 12, bottom: 8, left: 6 }}><CartesianGrid horizontal={false} stroke={grid} /><XAxis type="number" tickFormatter={(value) => money(Number(value))} tick={{ fill: axis, fontSize: 9 }} axisLine={false} tickLine={false} /><YAxis type="category" dataKey="month" width={84} tickFormatter={monthLabel} tick={{ fill: axis, fontSize: 10 }} axisLine={false} tickLine={false} /><Tooltip labelFormatter={(value) => monthLabel(String(value))} formatter={(value, name) => [money(Number(value)), String(name)]} /><Legend wrapperStyle={{ fontSize: 9 }} /><Bar dataKey="salesCents" name="Vendas brutas" fill={palette.purple} radius={[0, 4, 4, 0]} maxBarSize={7} /><Bar dataKey="refundCents" name="Estornos" fill={palette.orange} radius={[0, 4, 4, 0]} maxBarSize={7} /><Bar dataKey="netCents" name="Líquido" fill={palette.green} radius={[0, 4, 4, 0]} maxBarSize={7} /><Bar dataKey="targetCents" name="Meta geral" fill={palette.lime} radius={[0, 4, 4, 0]} maxBarSize={7} /></BarChart></ResponsiveContainer></ChartContainer> : <ChartEmpty text="O Scoreboard não retornou vendas neste período." />}
            {revenueDonutRows.length > 0 && <div className="mt-2 flex flex-wrap items-center gap-3 rounded-xl border border-[#eeeaf1] px-3 py-2"><div className="h-[96px] w-[104px] shrink-0"><ResponsiveContainer width="100%" height="100%"><PieChart><Pie data={revenueDonutRows} dataKey="value" nameKey="name" innerRadius={25} outerRadius={41} paddingAngle={2} stroke="none" isAnimationActive={false}>{revenueDonutRows.map((row, index) => <Cell key={row.name} fill={index === 0 ? palette.purple : palette.lime} />)}</Pie><Tooltip formatter={(value) => [`${Number(value).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`, 'Meta']} /></PieChart></ResponsiveContainer></div><div className="text-[10px] text-[#716879]"><p className="font-bold text-[#65479c]">Atingimento da meta geral: {(revenueActual / revenueGoalTotal * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%</p><p className="mt-1">Realizado líquido: {money(revenueActual)} · Meta: {money(revenueGoalTotal)}</p><p className="mt-1">{revenueActual >= revenueGoalTotal ? `Excedente: ${money(revenueActual - revenueGoalTotal)}` : `Falta: ${money(revenueGoalTotal - revenueActual)}`}</p></div></div>}
            {!revenueDonutRows.length && <p className="mt-2 rounded-xl bg-[#f8f5fb] px-3 py-2 text-[10px] text-[#716879]">{mode === 'range' && !revenueGoalsComplete ? 'Meta mensal não comparada: o período inclui meses parciais ou sem meta geral cadastrada.' : 'Meta geral não definida para todos os meses deste recorte.'}</p>}
            <p className="mt-2 rounded-xl bg-[#f8f5fb] px-3 py-2 text-[10px] text-[#716879]">Metas exibidas somente quando há meta geral salva para o mês. {mode === 'range' ? `No intervalo personalizado, o faturamento usa as datas exatas; os valores mensais abrangem ${periodEndMonth ? 'os meses sobrepostos' : 'o período'}.` : 'Vendas, estornos e líquido permanecem medidas independentes.'}</p>
          </section>
        </div>
      )}
      <Dialog open={goalDialogOpen} onOpenChange={setGoalDialogOpen}>
        <DialogContent className="max-h-[90dvh] max-w-xl overflow-y-auto rounded-[24px]">
          <DialogHeader>
        <DialogTitle>Metas mensais de ocupação e agregadores</DialogTitle>
            <DialogDescription>Cadastre uma meta opcional de agregadores e/ou de ocupação. Ela fica separada dos registros reais das aulas.</DialogDescription>
          </DialogHeader>
          <form onSubmit={(event) => { void saveGoal(event); }} className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-xs font-bold text-[#716879]">Mês<input type="month" value={goalMonth} onChange={(event) => { const value = event.target.value; setGoalMonth(value); loadGoalDraft(value, goalModalityId); }} required className="mt-1 h-10 w-full rounded-xl border border-[#e9e4eb] bg-white px-3 text-sm text-[#443d50]" data-testid="input-monthly-goal-month" /></label>
              <label className="text-xs font-bold text-[#716879]">Escopo<select value={goalModalityId} onChange={(event) => { const value = event.target.value; setGoalModalityId(value); loadGoalDraft(goalMonth, value); }} className="mt-1 h-10 w-full rounded-xl border border-[#e9e4eb] bg-white px-3 text-sm text-[#443d50]" data-testid="select-monthly-goal-scope"><option value="">Todas as modalidades</option>{modalities.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-xs font-bold text-[#716879]">Meta de presenças agregadoras<input type="number" min="0" max="2147483647" step="1" value={aggregatorGoalDraft} onChange={(event) => setAggregatorGoalDraft(event.target.value)} placeholder="Opcional" className="mt-1 h-10 w-full rounded-xl border border-[#e9e4eb] bg-white px-3 text-sm text-[#443d50]" data-testid="input-monthly-aggregator-goal" /></label>
              <label className="text-xs font-bold text-[#716879]">Meta de ocupação (%)<input type="number" min="0" step="0.1" value={occupancyGoalDraft} onChange={(event) => setOccupancyGoalDraft(event.target.value)} placeholder="Opcional" className="mt-1 h-10 w-full rounded-xl border border-[#e9e4eb] bg-white px-3 text-sm text-[#443d50]" data-testid="input-monthly-occupancy-goal" /></label>
            </div>
            <label className="block text-xs font-bold text-[#716879]">Observação opcional<textarea value={goalNotesDraft} onChange={(event) => setGoalNotesDraft(event.target.value)} maxLength={1000} rows={3} className="mt-1 w-full rounded-xl border border-[#e9e4eb] bg-white px-3 py-2 text-sm text-[#443d50]" data-testid="input-monthly-goal-notes" /></label>
            <p className="text-[11px] leading-relaxed text-[#837b8b]">Metas gerais e por modalidade são independentes. Ao filtrar uma modalidade, o painel compara apenas a meta dessa modalidade. Presenças agregadoras são check-ins, não alunos únicos.</p>
            {saveGoalMutation.isError && <p className="rounded-xl bg-[#fff4f1] px-3 py-2 text-xs text-[#875447]" role="alert" data-testid="status-save-monthly-goal-error">{errorMessage(saveGoalMutation.error)}</p>}
            <DialogFooter className="gap-2">
              <button type="button" onClick={() => setGoalDialogOpen(false)} className="h-10 rounded-xl border border-[#e3dfe7] px-4 text-sm font-bold text-[#716a79] hover:bg-[#f8f6fa]" data-testid="button-cancel-monthly-goal">Cancelar</button>
              <button type="submit" disabled={!canSaveGoal || saveGoalMutation.isPending} className="h-10 rounded-xl bg-[#65479c] px-5 text-sm font-bold text-white hover:bg-[#563a89] disabled:cursor-not-allowed disabled:opacity-50" data-testid="button-save-monthly-goal">{saveGoalMutation.isPending ? 'Salvando…' : 'Salvar meta'}</button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      {initialLoading && <p className="sr-only" role="status">Carregando dados reais do painel.</p>}
      {allError && <button type="button" onClick={refresh} className="rounded-full bg-[#65479c] px-4 py-2 text-xs font-bold text-white print:hidden" data-testid="button-retry-management">Tentar atualizar novamente</button>}
      <style>{`.zero3-dashboard-dark { color-scheme: dark; } @media print { [data-testid="page-complete-management-dashboard"] { background: #fff !important; color: #342d40 !important; } }`}</style>
    </section>
  );
}
