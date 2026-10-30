import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  getGetActiveContractsQueryKey,
  getGetOccupancyModalitiesQueryKey,
  getGetOccupancyMonthlyGoalsQueryKey,
  getGetOccupancyRecordsQueryKey,
  getGetProductsQueryKey,
  getGetSalesGoalsQueryKey,
  getGetSalesScoreboardQueryKey,
  type GetOccupancyRecordsParams,
  type GetSalesScoreboardParams,
  useGetActiveContracts,
  useGetOccupancyModalities,
  useGetOccupancyMonthlyGoals,
  useGetOccupancyRecords,
  useGetProducts,
  useGetSalesGoals,
  useGetSalesScoreboard,
  useUpsertOccupancyMonthlyGoal,
} from '@workspace/api-client-react';
import {
  CalendarDays, ChevronDown, CircleAlert, Download, Moon, RefreshCw, Sun,
} from 'lucide-react';
import {
  Bar, BarChart, CartesianGrid, Cell, ComposedChart, Legend, Line, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { ChartContainer } from '@/components/ui/chart';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { beginDashboardPdf, DownloadPdfButton, PdfPrintHeader, PdfPrintTable } from '@/components/dashboard-pdf-tools';
import { buildFinancialChartAnalytics } from '@/lib/financial-chart-data';
import { buildOccupancyChartAnalytics } from '@/lib/occupancy-chart-data';
import { buildActiveContractPeriodRows } from '@/lib/active-contracts';
import { buildScoreboardQueryParams, formatCents, formatMonthKey, getSaoPauloMonthKey, getSalesGoalComparison, monthsForYearQuarter } from '@/lib/sales-utils';
import { occupancyAnalyticsMonths, occupancyQueryParams, type OccupancyFilterState } from '@/lib/occupancy-filter-store';

type PeriodMode = 'month' | 'year' | 'quarter' | 'range';
type Props = { onOccupancy: () => void; onFinancial: () => void; onContracts: () => void };

const palette = { purple: '#7655a8', lime: '#a9d75a', ink: '#342d40', muted: '#837b8b', cream: '#fffefc', orange: '#d18b57', green: '#6f9d45' };
const intervalOptions = [{ label: '5 minutos', value: 300_000 }, { label: '15 minutos', value: 900_000 }, { label: '1 hora', value: 3_600_000 }];
const panel = 'min-w-0 rounded-[22px] border border-[#e9e4eb] bg-[#fffefc] p-4 shadow-[0_14px_35px_-30px_rgba(55,40,72,.28)] sm:p-5';
const appBasePath = import.meta.env.BASE_URL.replace(/\/$/, '');

function monthLabel(value: string) { return formatMonthKey(value); }
function count(value: number | null | undefined) { return value == null ? '—' : value.toLocaleString('pt-BR'); }
function money(value: number) { return formatCents(Math.round(value)); }
function percentage(value: number | null | undefined) {
  return value == null ? 'Não informado' : `${value.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%`;
}
function reportCount(value: number | null | undefined) {
  return value == null ? 'Não informado' : count(value);
}
function errorMessage(error: unknown) {
  return error && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
    ? error.message : 'Confira a conexão e tente atualizar novamente.';
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

function ReportTable({
  headers,
  rows,
  summary,
  emptyMessage = 'Sem dados no período',
}: {
  headers: string[];
  rows: string[][];
  summary?: string[];
  emptyMessage?: string;
}) {
  return (
    <div className="dashboard-pdf-table">
      <table>
        <thead><tr>{headers.map((header) => <th key={header} scope="col">{header}</th>)}</tr></thead>
        <tbody>
          {rows.length
            ? rows.map((row, rowIndex) => <tr key={`${row[0]}-${rowIndex}`}>{row.map((cell, cellIndex) => <td key={`${cellIndex}-${cell}`}>{cell}</td>)}</tr>)
            : <tr><td colSpan={headers.length} className="dashboard-pdf-empty">{emptyMessage}</td></tr>}
        </tbody>
        {summary && <tfoot><tr>{summary.map((cell, cellIndex) => <td key={`${cellIndex}-${cell}`}><strong>{cell}</strong></td>)}</tr></tfoot>}
      </table>
    </div>
  );
}

function ReportPageHeading({
  basePath,
  periodLabel,
  filters,
  lastRefresh,
  partial,
}: {
  basePath: string;
  periodLabel: string;
  filters: string;
  lastRefresh: string | null;
  partial: boolean;
}) {
  return (
    <header className="dashboard-pdf-only dashboard-pdf-page-heading">
      <img src={`${basePath}/logo.svg`} alt="Zero3 PRO" />
      <div className="dashboard-pdf-page-title">
        <p>RELATÓRIO EXECUTIVO · INDICADORES DE GESTÃO</p>
        <h1>Painel Completo</h1>
        <span>Período: {periodLabel}</span>
        <span>{filters}</span>
        {partial && <strong>Relatório parcial: um ou mais indicadores não puderam ser atualizados.</strong>}
      </div>
      <div className="dashboard-pdf-page-updated">Dados apresentados no painel<br />{lastRefresh ? `Atualizados em ${lastRefresh}` : 'sem atualização registrada'}</div>
    </header>
  );
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
  const [productId, setProductId] = useState('');
  const [aggregatorDisplay, setAggregatorDisplay] = useState<'quantity' | 'share'>('quantity');
  const [weekday, setWeekday] = useState('');
  const [startTime, setStartTime] = useState('');
  const [dark, setDark] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [interval, setInterval] = useState(300_000);
  const [includePdfDetails, setIncludePdfDetails] = useState(true);
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
  const salesParams = useMemo<GetSalesScoreboardParams>(() => buildScoreboardQueryParams({
    periodMode: mode === 'range' ? 'range' : 'multiple',
    currentMonthKey: nowMonth,
    selectedMonth: month,
    selectedMonths,
    selectedYear: year,
    selectedQuarter: quarter,
    dateFrom: fromDate,
    dateTo: toDate,
    filterProduct: productId,
    weekdays: weekday ? [Number(weekday)] : [],
    modalityId,
  }), [mode, nowMonth, month, selectedMonths, year, quarter, fromDate, toDate, productId, weekday, modalityId]);
  const occupancyFilterState = useMemo<OccupancyFilterState>(() => ({
    periodMode: mode === 'range' ? 'range' : 'months',
    day: '',
    fromDate,
    toDate,
    months: selectedMonths,
    year: mode === 'year' || mode === 'quarter' ? year : '',
    quarter: mode === 'quarter' ? quarter : '',
    modalityId,
    className: '',
    startTimes: startTime ? [startTime] : [],
    weekdays: weekday ? [Number(weekday)] : [],
    viewMode: mode === 'range' ? 'daily' : 'monthly',
  }), [mode, fromDate, toDate, selectedMonths, year, quarter, modalityId, startTime, weekday]);
  const occupancyParams = useMemo<GetOccupancyRecordsParams>(
    () => occupancyQueryParams(occupancyFilterState, 'all'),
    [occupancyFilterState],
  );

  const salesQuery = useGetSalesScoreboard(salesParams, { query: { queryKey: getGetSalesScoreboardQueryKey(salesParams), enabled: !invalid, staleTime: 300_000 } });
  const productsQuery = useGetProducts({ query: { queryKey: getGetProductsQueryKey(), staleTime: 300_000 } });
  const goalsQuery = useGetSalesGoals({ query: { queryKey: getGetSalesGoalsQueryKey(), staleTime: 300_000 } });
  const contractsQuery = useGetActiveContracts({ query: { queryKey: getGetActiveContractsQueryKey(), staleTime: 300_000, refetchOnMount: 'always', refetchOnWindowFocus: true } });
  const occupancyGoalsQuery = useGetOccupancyMonthlyGoals(undefined, { query: { queryKey: getGetOccupancyMonthlyGoalsQueryKey(), staleTime: 300_000 } });
  const occupancyQuery = useGetOccupancyRecords(occupancyParams, { query: { queryKey: getGetOccupancyRecordsQueryKey(occupancyParams), enabled: !invalid, staleTime: 300_000 } });
  const modalityQuery = useGetOccupancyModalities({ query: { queryKey: getGetOccupancyModalitiesQueryKey(), staleTime: 300_000 } });
  const filterOptionsQuery = useGetOccupancyRecords({ kind: 'all' }, { query: { queryKey: getGetOccupancyRecordsQueryKey({ kind: 'all' }), staleTime: 300_000 } });

  const finance = useMemo(() => salesQuery.data ? buildFinancialChartAnalytics(salesQuery.data) : null, [salesQuery.data]);
  const productOptions = productsQuery.data ?? [];
  const modalities = [...(modalityQuery.data ?? [])].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  const selectedProductForGoal = productOptions.find((item) => item.id === productId);
  const selectedProductNameForGoal = selectedProductForGoal?.name ?? null;
  const selectedProductModalityId = selectedProductForGoal?.modalityId ?? null;
  const revenueGoalScopeValid = !weekday && (!productId || Boolean(selectedProductForGoal))
    && (!modalityId || Boolean(productId && selectedProductModalityId === modalityId));
  const periodEndMonth = selectedMonths.at(-1) ?? '';
  const contractRows = useMemo(() => buildActiveContractPeriodRows(selectedMonths, contractsQuery.data ?? []), [contractsQuery.data, selectedMonths]);
  const contracts = contractRows.flatMap((row) => row.record ? [row.record] : []);
  const contractLastMonth = contractRows.at(-1) ?? null;
  const contractMonthsNotInformed = selectedMonths.filter((selectedMonth) => !contracts.some((record) => record.month === selectedMonth));
  const goals = useMemo(() => (goalsQuery.data ?? []).filter((goal) => (
    goal.productId === (productId || null)
    && (Boolean(productId) || goal.productName === null)
    && selectedMonths.includes(goal.month)
  )), [goalsQuery.data, selectedMonths, productId]);
  const contractChart = contractRows.map(({ month: contractMonth, record }) => ({
    month: contractMonth,
    activeCount: record?.activeCount ?? null,
    targetCount: record?.targetCount ?? null,
  }));
  const revenueChart = (finance?.months ?? []).map((row) => ({
    ...row,
    targetCents: !revenueGoalScopeValid || (mode === 'range' && !completeMonthInRange(row.month, fromDate, toDate))
      ? null
      : goals.find((goal) => goal.month === row.month)?.targetCents ?? null,
  }));

  const occupancySelectedMonths = useMemo(
    () => occupancyAnalyticsMonths(occupancyFilterState),
    [occupancyFilterState],
  );
  const occupancyFilters = useMemo(() => ({
    viewMode: occupancyFilterState.viewMode,
    ...(occupancySelectedMonths ? { selectedMonths: occupancySelectedMonths } : {}),
    ...(occupancyFilterState.periodMode === 'range' ? { fromDate, toDate } : {}),
    modalityId: occupancyFilterState.modalityId || undefined,
    weekdays: occupancyFilterState.weekdays,
    startTimes: occupancyFilterState.startTimes,
  }), [occupancyFilterState, occupancySelectedMonths, fromDate, toDate]);
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
  const estimatedAggregatorMonths = new Set((occupancyQuery.data ?? [])
    .filter((record) => record.aggregatorSource === 'monthly_estimated' && selectedMonths.includes(record.month))
    .map((record) => record.month));
  const monthlyGoalRows = occupancyGoalsQuery.data ?? [];
  const goalForMonth = (selectedMonth: string) => {
    if (mode === 'range' && !completeMonthInRange(selectedMonth, fromDate, toDate)) return null;
    return monthlyGoalRows.find((goal) => goal.month === selectedMonth && goal.modalityId === (modalityId || null)) ?? null;
  };
  const aggregatorChartRows = aggregatorRows.map((row) => ({
    ...row,
    aggregatorTargetPresences: row.measuredClassCount > 0 && row.aggregatorInformedClassCount === row.measuredClassCount
      ? goalForMonth(row.month)?.aggregatorTargetPresences ?? null
      : null,
  }));
  const aggregatorDisplayRows = selectedMonths.map((selectedMonth) => aggregatorChartRows.find((row) => row.month === selectedMonth) ?? ({
    month: selectedMonth,
    totalPresences: null,
    aggregatorPresences: null,
    aggregatorInformedClassCount: 0,
    measuredClassCount: 0,
    sharePercentage: null,
    aggregatorTargetPresences: null,
  }));
  const aggregatorPeriodSummary = {
    totalPresences: occupancy.totals.presences,
    aggregatorPresences: occupancy.totals.aggregatorPresences,
    otherPresences: occupancy.totals.otherPresences,
    sharePercentage: occupancy.totals.aggregatorSharePercentage,
    otherSharePercentage: occupancy.totals.aggregatorSharePercentage == null
      ? null
      : occupancy.totals.presences === 0 ? 0 : 100 - occupancy.totals.aggregatorSharePercentage,
    complete: occupancy.totals.aggregatorSharePercentage != null,
  };
  const aggregatorEmptyMessage = (occupancyQuery.data?.length ?? 0) > 0
    ? 'Existem registros no período, mas sem contagens completas de presenças para calcular a participação. Os demais check-ins permanecem desconhecidos.'
    : mode === 'range' || weekday || startTime
      ? 'Sem dados por aula para este recorte. Resumos mensais não são distribuídos por intervalo, dia da semana ou horário.'
      : 'Sem dados no período';
  const aggregatorDonutRows = aggregatorPeriodSummary.sharePercentage == null
    || aggregatorPeriodSummary.totalPresences == null
    || aggregatorPeriodSummary.totalPresences === 0
    || aggregatorPeriodSummary.otherPresences == null
    ? []
    : [
      { name: 'Agregadores', value: aggregatorPeriodSummary.aggregatorPresences ?? 0 },
      { name: 'Demais presenças', value: aggregatorPeriodSummary.otherPresences },
    ];
  const aggregatorModalityComparison = useMemo(() => modalities.map((modality) => {
    const analytics = buildOccupancyChartAnalytics(filterOptionsQuery.data ?? [], {
      ...occupancyFilters,
      modalityId: modality.id,
    });
    return {
      id: modality.id,
      name: modality.name,
      totalPresences: analytics.totals.presences,
      aggregatorPresences: analytics.totals.aggregatorPresences,
      otherPresences: analytics.totals.otherPresences,
      share: analytics.totals.aggregatorSharePercentage,
      otherShare: analytics.totals.aggregatorSharePercentage == null
        ? null
        : analytics.totals.presences === 0 ? 0 : 100 - analytics.totals.aggregatorSharePercentage,
      coverageComplete: analytics.totals.aggregatorSharePercentage != null,
      hasMeasuredData: analytics.totals.measuredClassCount > 0,
    };
  }).filter((row) => row.hasMeasuredData), [modalities, filterOptionsQuery.data, occupancyFilters]);
  const maxAggregatorTotal = Math.max(1, ...aggregatorDisplayRows.map((row) => row.totalPresences ?? 0));
  const maxModalityPresences = Math.max(1, ...aggregatorModalityComparison.map((row) => row.totalPresences ?? 0));
  const occupancyChartRows = monthBuckets.map((row) => ({
    ...row,
    occupancyTargetPercentage: goalForMonth(row.month)?.occupancyTargetPercentage ?? null,
  }));
  const occupancyModalityRows = occupancy.comparison.filter((row) => row.coveredPeriods > 0);
  const maxOccupancyModalityPercentage = Math.max(1, ...occupancyModalityRows.map((row) => row.percentage));
  const revenueActual = finance?.totals.netCents ?? 0;
  const partialRevenueRange = mode === 'range'
    && selectedMonths.some((selectedMonth) => !completeMonthInRange(selectedMonth, fromDate, toDate));
  const revenueGoalComparisonMode = !revenueGoalScopeValid || invalid
    ? 'invalid'
    : partialRevenueRange ? 'partial-range' : 'complete';
  const revenueGoalComparison = useMemo(() => getSalesGoalComparison(
    BigInt(Math.round(revenueActual)),
    selectedMonths,
    revenueGoalComparisonMode,
    productId ? selectedProductNameForGoal : null,
    goals,
  ), [revenueActual, selectedMonths, revenueGoalComparisonMode, productId, selectedProductNameForGoal, goals]);
  const revenueGoalsComplete = revenueGoalComparison.status === 'complete';
  const revenueGoalTotal = revenueGoalsComplete && revenueGoalComparison.status === 'complete'
    ? Number(revenueGoalComparison.targetCents)
    : 0;
  const revenueGoalLabel = productId ? 'Meta do produto' : 'Meta geral';
  const hasAnyRevenueGoal = revenueGoalComparison.configuredGoalCount > 0;
  const revenueGoalSummary = goalsQuery.isError
    ? 'Indisponível'
    : revenueGoalComparison.status === 'invalid' || revenueGoalComparison.status === 'partial-range'
      ? 'Não comparada'
      : revenueGoalsComplete
        ? money(revenueGoalTotal)
        : revenueGoalComparison.status === 'partial' ? 'Cobertura parcial' : 'Não definida';
  const revenueProgress = revenueGoalTotal > 0 ? Math.min(100, Math.max(0, revenueActual / revenueGoalTotal * 100)) : null;
  const revenueDonutRows = revenueProgress == null ? [] : [
    { name: 'Realizado', value: revenueProgress },
    { name: 'Falta para a meta', value: 100 - revenueProgress },
  ];
  const filterOptions = filterOptionsQuery.data ?? [];
  const selectedModalityName = modalities.find((item) => item.id === modalityId)?.name ?? (modalityId ? 'Modalidade selecionada' : 'Todas as modalidades');
  const weekdayName = weekday ? ['Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado', 'Domingo'][Number(weekday) - 1] ?? 'Todos os dias' : 'Todos os dias';
  const selectedProductName = selectedProductNameForGoal ?? (productId ? 'Produto selecionado' : 'Todos os produtos');
  const printFilters = `Check-in e Agregadores: modalidade ${selectedModalityName}; dia ${weekdayName}; horário ${startTime ? startTime.slice(0, 5) : 'todos'}. Faturamento: ${selectedProductName}; dia ${weekdayName}${modalityId ? `; modalidade ${selectedModalityName} apenas em vendas com vínculo explícito` : ''}. Contratos usam somente o período global. Meta mensal não se compara a recortes parciais por dia da semana ou modalidade. Agregadores: “estimativa” identifica valor estimado; cobertura incompleta permanece desconhecida.`;
  const contractReportRows = contractRows.map(({ month, record, difference, attainment, changeFromPrevious }) => {
    if (!record) return [monthLabel(month), 'Sem dados cadastrados', '—', '—', '—', '—'];
    return [
      monthLabel(month),
      count(record.activeCount),
      record.targetCount == null ? 'Não definida' : count(record.targetCount),
      difference == null ? '—' : `${difference > 0 ? '+' : ''}${count(difference)}`,
      attainment == null ? '—' : `${attainment.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`,
      changeFromPrevious == null ? '—' : `${changeFromPrevious > 0 ? '+' : ''}${count(changeFromPrevious)}`,
    ];
  });
  const aggregatorReportRows = selectedMonths.map((selectedMonth) => {
    const row = aggregatorChartRows.find((item) => item.month === selectedMonth);
    if (!row) return [monthLabel(selectedMonth), 'Sem dados no período', '—', '—', '—', '—', '—'];
    const savedTarget = goalForMonth(selectedMonth)?.aggregatorTargetPresences ?? null;
    const coverageComplete = row.measuredClassCount > 0 && row.aggregatorInformedClassCount === row.measuredClassCount;
    const otherPresences = coverageComplete && row.aggregatorPresences != null ? row.totalPresences - row.aggregatorPresences : null;
    const otherSharePercentage = row.sharePercentage == null
      ? null
      : row.totalPresences === 0 ? 0 : 100 - row.sharePercentage;
    const target = occupancyGoalsQuery.isError
      ? 'Dados indisponíveis'
      : row.aggregatorTargetPresences == null
        ? savedTarget == null ? 'Meta não definida' : 'Não comparada'
      : count(row.aggregatorTargetPresences);
    const attainment = coverageComplete && row.aggregatorPresences != null && row.aggregatorTargetPresences != null && row.aggregatorTargetPresences > 0
      ? `${(row.aggregatorPresences / row.aggregatorTargetPresences * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`
      : savedTarget != null && !coverageComplete ? 'Cobertura incompleta' : '—';
    return [
      `${monthLabel(selectedMonth)}${estimatedAggregatorMonths.has(selectedMonth) ? ' · estimativa' : ''}`,
      reportCount(row.aggregatorPresences),
      count(row.totalPresences),
      otherPresences == null ? 'Desconhecido' : count(otherPresences),
      percentage(row.sharePercentage),
      percentage(otherSharePercentage),
      target,
      attainment,
    ];
  });
  const occupancyReportRows = selectedMonths.map((selectedMonth) => {
    const row = occupancyChartRows.find((item) => item.month === selectedMonth);
    if (!row) return [monthLabel(selectedMonth), 'Sem dados no período', '—', '—', '—', '—'];
    const attainment = row.percentage != null && row.occupancyTargetPercentage != null && row.occupancyTargetPercentage > 0
      ? `${(row.percentage / row.occupancyTargetPercentage * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`
      : '—';
    return [
      monthLabel(selectedMonth),
      reportCount(row.presences),
      reportCount(row.capacity),
      percentage(row.percentage),
      occupancyGoalsQuery.isError ? 'Dados indisponíveis' : row.occupancyTargetPercentage == null ? 'Meta não definida' : percentage(row.occupancyTargetPercentage),
      attainment,
    ];
  });
  const revenueReportRows = selectedMonths.map((selectedMonth) => {
    const row = revenueChart.find((item) => item.month === selectedMonth);
    if (!row) return [monthLabel(selectedMonth), 'Sem movimentação', '—', '—', '—', '—', '—', '—'];
    const attainment = row.targetCents != null && row.targetCents > 0
      ? `${(row.netCents / row.targetCents * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`
      : '—';
    return [
      monthLabel(selectedMonth),
      count(row.saleCount),
      count(row.quantity),
      money(row.salesCents),
      money(row.refundCents),
      money(row.netCents),
      goalsQuery.isError ? 'Dados indisponíveis' : row.targetCents == null ? modalityId ? 'Não comparada para modalidade' : 'Meta não definida' : money(row.targetCents),
      attainment,
    ];
  });
  const revenueProductReportRows = (finance?.byProduct ?? []).map((row) => [
    row.modalityName ? `${row.name} · ${row.modalityName}` : row.name,
    count(row.saleCount),
    count(row.quantity),
    money(row.salesCents),
    money(row.refundCents),
    money(row.netCents),
  ]);
  const goalReportRows = selectedMonths.flatMap((selectedMonth) => {
    const contract = contractRows.find((row) => row.month === selectedMonth);
    const activeValue = contract?.record?.activeCount ?? null;
    const contractTarget = contract?.record?.targetCount ?? null;
    const contractAchievement = activeValue != null && contractTarget != null && contractTarget > 0
      ? `${(activeValue / contractTarget * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`
      : '—';

    const aggregator = aggregatorChartRows.find((row) => row.month === selectedMonth);
    const aggregatorGoal = goalForMonth(selectedMonth)?.aggregatorTargetPresences ?? null;
    const aggregatorCoverage = Boolean(aggregator && aggregator.measuredClassCount > 0
      && aggregator.aggregatorInformedClassCount === aggregator.measuredClassCount);
    const aggregatorActual = aggregatorCoverage ? aggregator?.aggregatorPresences ?? null : null;
    const aggregatorAchievement = aggregatorActual != null && aggregatorGoal != null && aggregatorGoal > 0
      ? `${(aggregatorActual / aggregatorGoal * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`
      : aggregatorGoal != null && !aggregatorCoverage ? 'Cobertura incompleta' : '—';

    const occupancyMonth = occupancyChartRows.find((row) => row.month === selectedMonth);
    const occupancyGoal = occupancyMonth?.occupancyTargetPercentage ?? null;
    const occupancyActual = occupancyMonth?.percentage ?? null;
    const occupancyAchievement = occupancyActual != null && occupancyGoal != null && occupancyGoal > 0
      ? `${(occupancyActual / occupancyGoal * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`
      : '—';

    const revenueMonth = revenueChart.find((row) => row.month === selectedMonth);
    const revenueGoal = revenueMonth?.targetCents ?? null;
    const revenueActualMonth = revenueMonth?.netCents ?? null;
    const revenueAchievement = revenueActualMonth != null && revenueGoal != null && revenueGoal > 0
      ? `${(revenueActualMonth / revenueGoal * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`
      : '—';

    const signedCountDifference = (actual: number | null, target: number | null) => actual == null || target == null
      ? '—'
      : `${actual - target > 0 ? '+' : ''}${count(actual - target)}`;
    const signedMoneyDifference = (actual: number | null, target: number | null) => actual == null || target == null
      ? '—'
      : money(actual - target);
    const signedPercentageDifference = (actual: number | null, target: number | null) => actual == null || target == null
      ? '—'
      : `${(actual - target > 0 ? '+' : '')}${(actual - target).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} p.p.`;

    return [
      [monthLabel(selectedMonth), 'Contratos ativos', reportCount(activeValue), count(contractTarget), signedCountDifference(activeValue, contractTarget), contractAchievement],
      [monthLabel(selectedMonth), 'Agregadores', reportCount(aggregatorActual), count(aggregatorGoal), signedCountDifference(aggregatorActual, aggregatorGoal), aggregatorAchievement],
      [monthLabel(selectedMonth), 'Ocupação', percentage(occupancyActual), percentage(occupancyGoal), signedPercentageDifference(occupancyActual, occupancyGoal), occupancyAchievement],
      [monthLabel(selectedMonth), 'Faturamento líquido', revenueActualMonth == null ? 'Sem movimentação' : money(revenueActualMonth), revenueGoal == null ? 'Não comparada' : money(revenueGoal), signedMoneyDifference(revenueActualMonth, revenueGoal), revenueAchievement],
    ];
  });
  const revenueAttainment = revenueGoalsComplete && revenueGoalComparison.status === 'complete'
    && revenueGoalComparison.targetCents > 0n
    ? `${(Number(revenueGoalComparison.achievementTenthsPercent) / 10).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`
    : 'Não comparado';
  const startTimes = [...new Set(filterOptions.map((item) => item.startTime).filter((item): item is string => Boolean(item)))].sort();
  const queries = [salesQuery, productsQuery, goalsQuery, contractsQuery, occupancyGoalsQuery, occupancyQuery, modalityQuery, filterOptionsQuery];
  const refreshing = queries.some((query) => query.isFetching);
  const allError = queries.some((query) => query.isError);
  const initialLoading = queries.some((query) => query.isLoading);
  const updatedAt = Math.max(...queries.map((query) => query.dataUpdatedAt || 0));

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
    salesQuery.refetch(), productsQuery.refetch(), goalsQuery.refetch(), contractsQuery.refetch(), occupancyGoalsQuery.refetch(), occupancyQuery.refetch(), modalityQuery.refetch(), filterOptionsQuery.refetch(),
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
  const downloadPdf = () => beginDashboardPdf(
    'complete-full',
    'Relatorio-completo',
    periodLabel,
    { includeDetails: includePdfDetails },
  );
  const theme = dark ? 'bg-[#292333] text-[#f6f0fb]' : 'bg-[#f8f6f2] text-[#342d40]';
  const cardTheme = dark ? 'bg-[#332c3d] border-[#493f55]' : 'bg-[#fffefc] border-[#e9e4eb]';
  const axis = dark ? '#c6bacf' : '#837b8b';
  const grid = dark ? '#4a4054' : '#eee9f1';

  return (
    <section className={`pdf-report-root min-h-[100dvh] space-y-4 rounded-[26px] p-3 transition-colors sm:p-5 ${theme}`} aria-label="Painel completo de gestão" data-testid="page-complete-management-dashboard">
      <header className={`dashboard-pdf-toolbar flex flex-col justify-between gap-4 rounded-[22px] border p-4 shadow-[0_14px_35px_-30px_rgba(55,40,72,.28)] sm:flex-row sm:items-center sm:px-6 ${cardTheme}`}>
        <div>
          <p className="text-[9px] font-bold uppercase tracking-[.14em] text-[#8a8491]">zero3 pro <span className="mx-1 text-[#b2abb8]">/</span> gestão completa</p>
          <h1 className="mt-1 font-[family-name:var(--app-font-serif)] text-3xl font-extrabold leading-none tracking-[-.07em] sm:text-[2.6rem]">Completa<span className="ml-1 text-[#a9d75a]">.</span></h1>
          <p className="mt-2 text-xs text-[#837b8b]">Vendas, contratos, ocupação e presenças agregadoras em um só painel.</p>
          {lastRefresh && <p className="mt-2 text-[10px] text-[#837b8b]" role="status" data-testid="text-dashboard-last-refresh">Atualizado em {lastRefresh}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2 print:hidden">
          <nav className="flex items-center gap-1 rounded-full bg-[#f5f2f6] p-1" aria-label="Painéis relacionados">
            <span className="rounded-full bg-[#ece6f4] px-3 py-2 text-xs font-bold text-[#65479c]" aria-current="page">Completa</span>
            <button type="button" onClick={onOccupancy} className="rounded-full px-3 py-2 text-xs font-semibold text-[#716879] hover:bg-white" data-testid="button-open-occupancy">Check-in</button>
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
          <label className="inline-flex min-h-9 cursor-pointer items-center gap-2 rounded-xl border border-[#e9e4eb] bg-[#fffefc] px-3 text-[10px] font-bold text-[#65479c]" data-testid="label-include-pdf-details">
            <input type="checkbox" checked={includePdfDetails} onChange={(event) => setIncludePdfDetails(event.target.checked)} className="h-4 w-4 accent-[#7655a8]" data-testid="input-include-pdf-details" />
            Incluir detalhamento
          </label>
          <DownloadPdfButton scope="complete-goals" title="Metas dos indicadores" period={periodLabel} compact disabled={refreshing || invalid || allError} />
          <button type="button" onClick={downloadPdf} disabled={refreshing || invalid} className="inline-flex h-9 items-center justify-center gap-2 rounded-xl bg-[#7655a8] px-3 text-xs font-bold text-white transition hover:bg-[#65479c] disabled:cursor-not-allowed disabled:opacity-50" aria-label="Baixar relatório completo em PDF" data-testid="button-download-dashboard-pdf"><Download size={14} /> Baixar relatório completo (PDF)</button>
          <button type="button" onClick={() => { setDark((value) => { document.documentElement.classList.toggle('zero3-dashboard-dark', !value); return !value; }); }} className="grid h-9 w-9 place-items-center rounded-xl border border-[#e9e4eb] bg-[#f8f5fb] text-[#716879]" aria-label={dark ? 'Ativar tema claro' : 'Ativar tema escuro'} data-testid="button-toggle-dashboard-theme">{dark ? <Sun size={15} /> : <Moon size={15} />}</button>
        </div>
      </header>

      <section className={`dashboard-pdf-hide rounded-[22px] border p-4 sm:p-5 ${cardTheme}`} aria-label="Filtros globais">
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
          <p className="mb-2 text-[9px] font-bold uppercase tracking-[.13em] text-[#8a8491]">Check-in e Agregadores · modalidade também filtra faturamento apenas quando há vínculo explícito</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <label className="text-[10px] font-bold text-[#837b8b]">Modalidade<select value={modalityId} onChange={(event) => setModalityId(event.target.value)} className="mt-1 h-10 w-full rounded-xl border border-[#e9e4eb] bg-[#fffefc] px-3 text-xs font-semibold text-[#443d50]" data-testid="select-dashboard-modality"><option value="">Todas as modalidades</option>{modalities.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
            <label className="text-[10px] font-bold text-[#837b8b]">Dia da semana<select value={weekday} onChange={(event) => setWeekday(event.target.value)} className="mt-1 h-10 w-full rounded-xl border border-[#e9e4eb] bg-[#fffefc] px-3 text-xs font-semibold text-[#443d50]" data-testid="select-dashboard-weekday"><option value="">Todos os dias</option>{['Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado', 'Domingo'].map((label, index) => <option key={label} value={index + 1}>{label}</option>)}</select><span className="mt-1 block font-normal">Filtra vendas pela data e check-ins pela data da aula.</span></label>
            <label className="text-[10px] font-bold text-[#837b8b]">Horário inicial (somente Check-in)<select value={startTime} onChange={(event) => setStartTime(event.target.value)} className="mt-1 h-10 w-full rounded-xl border border-[#e9e4eb] bg-[#fffefc] px-3 text-xs font-semibold text-[#443d50]" data-testid="select-dashboard-start-time"><option value="">Todos os horários</option>{startTimes.map((value) => <option key={value} value={value}>{value.slice(0, 5)}</option>)}</select></label>
          </div>
        </div>
        {allError && <div className="mt-3 flex items-center gap-2 rounded-xl border border-[#ecd5d4] bg-[#fff9f8] p-3 text-xs text-[#806462]" role="status" data-testid="status-partial-dashboard-error"><CircleAlert size={15} /> Parte dos indicadores pode estar indisponível. Atualize para tentar novamente.</div>}
      </section>

      {invalid ? <div className={`${panel} text-center text-sm text-[#837b8b]`}>Revise o período selecionado para consultar os indicadores.</div> : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2" data-testid="grid-complete-management-charts">
          <div className="dashboard-print-page-group" data-pdf-page="commercial">
          <ReportPageHeading basePath={appBasePath} periodLabel={periodLabel} filters={printFilters} lastRefresh={lastRefresh} partial={allError} />
          <section className={`${panel} ${dark ? 'bg-[#332c3d] border-[#493f55]' : ''}`} data-testid="chart-complete-contracts" data-pdf-panel="complete-contracts">
            <PdfPrintHeader title="Contratos ativos" period={periodLabel} filters={printFilters} />
            <div className="mb-3 flex items-start justify-between gap-2"><div><p className="text-[9px] font-bold uppercase tracking-[.14em] text-[#8c73b4]">base ativa</p><h2 className="mt-1 font-[family-name:var(--app-font-serif)] text-xl font-extrabold tracking-[-.045em]">Contratos ativos</h2><p className="mt-1 text-[10px] text-[#837b8b]">Comparação mensal entre o saldo informado e a meta cadastrada.</p></div><DownloadPdfButton scope="complete-contracts" title="Contratos ativos" period={periodLabel} compact disabled={refreshing || contractsQuery.isError} /></div>
            {!contractsQuery.isLoading && !contractsQuery.isError && contractLastMonth?.record && <div className="dashboard-pdf-full-hide rounded-xl border border-[#e4dced] bg-[#f8f5fb] px-3 py-3" data-testid="summary-contracts-last-month">
              <p className="text-[9px] font-bold uppercase tracking-wide text-[#806aa0]">{mode === 'quarter' ? 'Saldo no encerramento do trimestre' : 'Saldo no fim do período'} · {monthLabel(contractLastMonth.month)}</p>
              <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div><p className="text-[9px] text-[#837b8b]">Contratos ativos</p><p className="text-lg font-extrabold tabular-nums text-[#65479c]">{count(contractLastMonth.record.activeCount)}</p></div>
                <div><p className="text-[9px] text-[#837b8b]">Meta</p><p className="text-lg font-extrabold tabular-nums">{count(contractLastMonth.record.targetCount)}</p></div>
                <div><p className="text-[9px] text-[#837b8b]">Diferença para a meta</p><p className="text-lg font-extrabold tabular-nums">{contractLastMonth.difference == null ? '—' : `${contractLastMonth.difference > 0 ? '+' : ''}${count(contractLastMonth.difference)}`}</p></div>
                <div><p className="text-[9px] text-[#837b8b]">Atingimento</p><p className="text-lg font-extrabold tabular-nums">{percentage(contractLastMonth.attainment)}</p></div>
              </div>
              <p className="mt-2 text-[9px] text-[#837b8b]">Variação vs. mês anterior: <b className="tabular-nums">{contractLastMonth.changeFromPrevious == null ? '—' : `${contractLastMonth.changeFromPrevious > 0 ? '+' : ''}${count(contractLastMonth.changeFromPrevious)}`}</b>. Contratos são saldos mensais; não some os meses do trimestre.</p>
            </div>}
             {contractsQuery.isLoading ? <div className="h-[280px] animate-pulse rounded-2xl bg-[#f1edf4]" /> : contractsQuery.isError ? <ChartEmpty text={`Não foi possível carregar contratos. ${errorMessage(contractsQuery.error)}`} /> : contractChart.some((row) => row.activeCount != null || row.targetCount != null) ? <ChartContainer role="img" aria-label="Barras horizontais agrupadas de contratos ativos e meta mensal; saldos não são somados" config={{ activeCount: { label: 'Contratos ativos', color: palette.purple }, targetCount: { label: 'Meta mensal', color: palette.lime } }} className="dashboard-pdf-chart h-[310px] w-full"><ResponsiveContainer width="100%" height="100%"><BarChart data={contractChart} layout="vertical" margin={{ left: 4, right: 12, top: 6, bottom: 6 }}><CartesianGrid horizontal={false} stroke={grid} /><XAxis type="number" allowDecimals={false} tick={{ fill: axis, fontSize: 10 }} axisLine={false} tickLine={false} /><YAxis type="category" dataKey="month" width={90} tickFormatter={monthLabel} tick={{ fill: axis, fontSize: 10 }} axisLine={false} tickLine={false} /><Tooltip labelFormatter={(value) => monthLabel(String(value))} formatter={(value, name) => [count(value == null ? null : Number(value)), String(name)]} /><Legend wrapperStyle={{ fontSize: 10 }} /><Bar dataKey="activeCount" name="Contratos ativos" fill={palette.purple} radius={[0, 5, 5, 0]} maxBarSize={10} /><Bar dataKey="targetCount" name="Meta mensal" fill={palette.lime} radius={[0, 5, 5, 0]} maxBarSize={10} /></BarChart></ResponsiveContainer></ChartContainer> : <ChartEmpty text="Sem dados no período" />}
             {!contractsQuery.isLoading && !contractsQuery.isError && contractChart.some((row) => row.activeCount != null || row.targetCount != null) && <div className="dashboard-pdf-full-hide overflow-x-auto rounded-xl border border-[#eeeaf1]">
                <table className="w-full min-w-[470px] text-left text-[10px]" data-testid="table-contract-monthly-snapshots">
                  <thead className="bg-[#f8f5fb] text-[#716879]"><tr><th className="px-3 py-2 font-bold">Mês</th><th className="px-3 py-2 font-bold">Saldo ativo</th><th className="px-3 py-2 font-bold">Meta</th><th className="px-3 py-2 font-bold">Atingimento</th><th className="px-3 py-2 font-bold">Variação vs mês anterior</th></tr></thead>
                  <tbody>{contractRows.map((row) => <tr key={row.month} className="border-t border-[#eeeaf1]"><th scope="row" className="px-3 py-2 font-semibold">{monthLabel(row.month)}</th><td className="px-3 py-2 tabular-nums">{count(row.record?.activeCount)}</td><td className="px-3 py-2 tabular-nums">{count(row.record?.targetCount)}</td><td className="px-3 py-2 tabular-nums">{percentage(row.attainment)}</td><td className="px-3 py-2 tabular-nums">{row.changeFromPrevious == null ? '—' : `${row.changeFromPrevious > 0 ? '+' : ''}${count(row.changeFromPrevious)}`}</td></tr>)}</tbody>
               </table>
             </div>}
              {!contractsQuery.isLoading && !contractsQuery.isError && contractMonthsNotInformed.length > 0 && <div className="dashboard-pdf-full-hide mt-3 max-h-24 overflow-y-auto rounded-xl border border-dashed border-[#ded7e4] bg-[#fbf9fc] px-3 py-2.5" data-testid="status-contracts-uninformed"><p className="text-[10px] font-bold text-[#716879]">Sem dados cadastrados em {contractMonthsNotInformed.length} mês(es):</p><p className="mt-1 text-[10px] leading-4 text-[#837b8b]">{contractMonthsNotInformed.map(monthLabel).join(' · ')}</p></div>}
             <div className="dashboard-pdf-full-hide mt-2 rounded-xl bg-[#f8f5fb] px-3 py-2">
              <p className="text-[10px] text-[#716879]">Atingimento mensal das metas salvas</p>
              {contracts.some((record) => record.targetCount != null) ? <div className="mt-2 flex flex-wrap gap-2">{contracts.filter((record) => record.targetCount != null).map((record) => {
                const attainment = record.targetCount && record.targetCount > 0 ? record.activeCount / record.targetCount * 100 : null;
                return <span key={record.month} className="rounded-full border border-[#e9e4eb] bg-[#fffefc] px-2.5 py-1 text-[10px] font-semibold text-[#65479c]" data-testid={`text-contract-attainment-${record.month}`}>{monthLabel(record.month)} · {attainment == null ? '—' : `${attainment.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`}</span>;
              })}</div> : <p className="mt-1 text-[10px] font-bold text-[#65479c]">Meta não definida</p>}
            </div>
            <ReportTable
              headers={['Mês', 'Contratos ativos', 'Meta', 'Diferença vs meta', 'Atingimento', 'Variação vs mês anterior']}
              rows={contractsQuery.isError ? [] : contractReportRows}
              emptyMessage={contractsQuery.isError ? 'Dados de contratos indisponíveis nesta exportação.' : 'Sem dados cadastrados no período'}
            />
          </section>

          <section className={`${panel} ${dark ? 'bg-[#332c3d] border-[#493f55]' : ''}`} data-testid="chart-complete-aggregators" data-pdf-panel="complete-aggregators">
            <PdfPrintHeader title="Agregadores" period={periodLabel} filters={printFilters} />
            <div className="mb-3 flex items-start justify-between gap-2"><div><p className="text-[9px] font-bold uppercase tracking-[.14em] text-[#8c73b4]">check-ins via plataformas</p><h2 className="mt-1 font-[family-name:var(--app-font-serif)] text-xl font-extrabold tracking-[-.045em]">Agregadores</h2><p className="mt-1 text-[10px] text-[#837b8b]">Presenças em aulas, não pessoas únicas.</p></div><DownloadPdfButton scope="complete-aggregators" title="Agregadores" period={periodLabel} compact disabled={refreshing || occupancyQuery.isError} /></div>
              {occupancyQuery.isLoading ? <div className="h-[280px] animate-pulse rounded-2xl bg-[#f1edf4]" /> : occupancyQuery.isError ? <ChartEmpty text={`Não foi possível carregar as presenças. ${errorMessage(occupancyQuery.error)}`} /> : aggregatorRows.length ? <div className="grid gap-4">
                <div className="dashboard-pdf-full-hide grid grid-cols-2 gap-2 rounded-xl border border-[#eeeaf1] bg-[#fbf9fc] p-3 sm:grid-cols-5" aria-label="Resumo de presenças de agregadores">
                 <div><p className="text-[9px] font-bold uppercase tracking-wide text-[#837b8b]">Presenças totais</p><p className="mt-1 text-lg font-extrabold tabular-nums">{reportCount(aggregatorPeriodSummary.totalPresences)}</p></div>
                 <div><p className="text-[9px] font-bold uppercase tracking-wide text-[#837b8b]">Agregadores{aggregatorPeriodSummary.complete ? '' : ' informados'}</p><p className="mt-1 text-lg font-extrabold tabular-nums text-[#7655a8]">{reportCount(aggregatorPeriodSummary.aggregatorPresences)}</p></div>
                 <div><p className="text-[9px] font-bold uppercase tracking-wide text-[#837b8b]">Demais presenças</p><p className="mt-1 text-lg font-extrabold tabular-nums text-[#648d38]">{reportCount(aggregatorPeriodSummary.otherPresences)}</p></div>
                  <div><p className="text-[9px] font-bold uppercase tracking-wide text-[#837b8b]">Agregadores %</p><p className="mt-1 text-lg font-extrabold tabular-nums">{percentage(aggregatorPeriodSummary.sharePercentage)}</p></div>
                  <div><p className="text-[9px] font-bold uppercase tracking-wide text-[#837b8b]">Demais %</p><p className="mt-1 text-lg font-extrabold tabular-nums">{percentage(aggregatorPeriodSummary.otherSharePercentage)}</p></div>
               </div>
                <p className="text-[9px] text-[#837b8b]">Participação = agregadores ÷ presenças totais. Atingimento = agregadores ÷ meta mensal; são percentuais diferentes.</p>
               <div className="dashboard-pdf-full-hide flex flex-wrap items-center justify-between gap-2">
                 <div className="inline-flex rounded-lg border border-[#e8e2ec] bg-[#f8f5fb] p-1" role="group" aria-label="Unidade das barras de agregadores">
                   <button type="button" onClick={() => setAggregatorDisplay('quantity')} aria-pressed={aggregatorDisplay === 'quantity'} className={`rounded-md px-2.5 py-1.5 text-[10px] font-bold ${aggregatorDisplay === 'quantity' ? 'bg-white text-[#65479c] shadow-sm' : 'text-[#837b8b]'}`} data-testid="button-aggregators-quantity">Quantidade</button>
                   <button type="button" onClick={() => setAggregatorDisplay('share')} aria-pressed={aggregatorDisplay === 'share'} className={`rounded-md px-2.5 py-1.5 text-[10px] font-bold ${aggregatorDisplay === 'share' ? 'bg-white text-[#65479c] shadow-sm' : 'text-[#837b8b]'}`} data-testid="button-aggregators-share">Participação %</button>
                 </div>
                 <span className="text-[10px] text-[#716879]">{aggregatorDisplay === 'quantity' ? 'Presenças' : 'Proporção das presenças'}</span>
               </div>
               <div className="dashboard-pdf-chart min-w-0" role="img" aria-label="Barras mensais empilhadas de agregadores e demais presenças, com valores e percentuais apresentados">
                 <div className="space-y-3">
                   {aggregatorDisplayRows.map((row) => {
                     const total = row.totalPresences;
                     const agg = row.aggregatorPresences;
                     const covered = row.measuredClassCount > 0 && row.aggregatorInformedClassCount === row.measuredClassCount && agg != null;
                     const other = covered && total != null ? total - agg : null;
                      const knownShare = total != null && total > 0 && agg != null ? agg / total * 100 : null;
                      const barWidth = aggregatorDisplay === 'quantity'
                        ? total == null ? 0 : total / maxAggregatorTotal * 100
                        : total == null || total === 0 ? 0 : 100;
                      const aggWidth = covered && row.sharePercentage != null
                        ? row.sharePercentage
                        : knownShare ?? 0;
                      const otherWidth = covered && row.sharePercentage != null
                        ? 100 - row.sharePercentage
                        : Math.max(0, 100 - aggWidth);
                     const goal = row.aggregatorTargetPresences;
                     const attainment = covered && goal != null && goal > 0 ? (agg ?? 0) / goal * 100 : null;
                     return <div key={row.month} className="rounded-xl border border-[#eeeaf1] bg-white px-3 py-2.5" data-testid={`row-aggregators-month-${row.month}`}>
                       <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-[10px]"><strong className="min-w-[5rem] text-[#51465f]">{monthLabel(row.month)}{estimatedAggregatorMonths.has(row.month) && <span className="ml-1 font-medium text-[#837b8b]">· estimativa</span>}</strong>
                         <span className="tabular-nums text-[#51465f]">Total <b>{reportCount(total)}</b></span>
                         <span className="tabular-nums text-[#7655a8]">Agregadores <b>{reportCount(agg)}</b></span>
                         <span className="tabular-nums text-[#648d38]">Demais <b>{reportCount(other)}</b></span>
                         <span className="tabular-nums text-[#51465f]">Participação <b>{percentage(row.sharePercentage)}</b></span>
                       </div>
                        <div className="mt-2 h-3 rounded-full bg-[#f3f0f5]" aria-hidden="true">
                          <div className="flex h-full overflow-hidden rounded-full" style={{ width: `${Math.max(0, Math.min(100, barWidth))}%` }}>
                            <span className="bg-[#9c80c2]" style={{ width: `${Math.max(0, Math.min(100, aggWidth))}%` }} />
                            {covered
                              ? <span className="bg-[#a9d75a]" style={{ width: `${Math.max(0, Math.min(100, otherWidth))}%` }} />
                              : <span className="flex-1 bg-[repeating-linear-gradient(135deg,#e7e2eb_0,#e7e2eb_3px,#f5f2f6_3px,#f5f2f6_6px)]" />}
                          </div>
                        </div>
                       <div className="mt-1.5 flex flex-wrap justify-between gap-2 text-[9px] text-[#837b8b]">
                         <span>{covered ? `Agregadores ${percentage(row.sharePercentage)} · demais ${percentage(other != null && total ? other / total * 100 : 0)}` : row.measuredClassCount ? 'Cobertura incompleta: demais presenças e participação desconhecidas' : 'Sem dados no período'}</span>
                         <span>{goal == null ? (goalForMonth(row.month)?.aggregatorTargetPresences != null ? 'Meta não comparada · cobertura incompleta' : 'Meta não definida') : `Meta ${count(goal)} · ${attainment == null ? 'sem comparação' : `${attainment.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}% atingida`}`}</span>
                       </div>
                     </div>;
                   })}
                 </div>
               </div>
                {aggregatorDonutRows.length > 0
                  ? <div className="dashboard-pdf-full-hide flex flex-wrap items-center gap-3 rounded-xl border border-[#eeeaf1] px-3 py-2" data-testid="chart-aggregator-share-donut">
                    <div className="dashboard-pdf-donut h-[96px] w-[104px] shrink-0">
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Pie data={aggregatorDonutRows} dataKey="value" nameKey="name" innerRadius={25} outerRadius={41} paddingAngle={2} stroke="none" isAnimationActive={false}>
                            {aggregatorDonutRows.map((row, index) => <Cell key={row.name} fill={index === 0 ? palette.purple : palette.lime} />)}
                          </Pie>
                          <Tooltip formatter={(value) => [count(Number(value)), 'Presenças']} />
                        </PieChart>
                      </ResponsiveContainer>
                    </div>
                     <div className="text-[10px] text-[#716879]">
                       <p className="font-bold">Participação nas presenças</p>
                       <p className="mt-2 flex items-center gap-2"><i className="h-2.5 w-2.5 rounded-full bg-[#9c80c2]" />Agregadores</p>
                       <p className="mt-1 flex items-center gap-2"><i className="h-2.5 w-2.5 rounded-full bg-[#a9d75a]" />Demais presenças</p>
                    </div>
                  </div>
                  : <p className="dashboard-pdf-full-hide rounded-xl bg-[#fbfafc] px-3 py-2 text-[10px] text-[#837b8b]">Rosca de participação indisponível: cobertura incompleta ou nenhum check-in no período.</p>}
               {aggregatorModalityComparison.length > 0 && <div className="dashboard-pdf-full-hide rounded-xl border border-[#eeeaf1] p-3" data-testid="list-aggregators-modality-comparison">
                 <h3 className="text-[10px] font-extrabold text-[#51465f]">Comparação por modalidade</h3>
                 <p className="mt-1 text-[9px] text-[#837b8b]">Barras separadas; participação somente com cobertura completa.</p>
                  <div className="mt-3 space-y-3">{aggregatorModalityComparison.map((item) => <div key={item.id} className="grid gap-1.5 sm:grid-cols-[7rem_1fr] sm:items-center">
                   <span className="truncate text-[10px] font-semibold" title={item.name}>{item.name}</span>
                    <div className="grid gap-1">
                       <div className="flex items-center gap-2 text-[9px]"><span className="w-20 shrink-0 text-[#51465f]">Total</span><span className="h-2 flex-1 overflow-hidden rounded-full bg-[#eeeaf1]"><i className="block h-full rounded-full bg-[#bcb3c7]" style={{ width: `${Math.min(100, item.totalPresences == null ? 0 : item.totalPresences / maxModalityPresences * 100)}%` }} /></span><b className="min-w-12 text-right tabular-nums">{reportCount(item.totalPresences)}</b></div>
                       <div className="flex items-center gap-2 text-[9px]"><span className="w-20 shrink-0 text-[#7655a8]">{item.coverageComplete ? 'Agregadores' : 'Agreg. informados'}</span><span className="h-2 flex-1 overflow-hidden rounded-full bg-[#eeeaf1]"><i className="block h-full rounded-full bg-[#9c80c2]" style={{ width: `${Math.min(100, item.aggregatorPresences == null ? 0 : item.aggregatorPresences / maxModalityPresences * 100)}%` }} /></span><b className="min-w-12 text-right tabular-nums">{reportCount(item.aggregatorPresences)}</b></div>
                       <div className="flex items-center gap-2 text-[9px]"><span className="w-20 shrink-0 text-[#648d38]">Demais</span><span className="h-2 flex-1 overflow-hidden rounded-full bg-[#eeeaf1]">{item.coverageComplete ? <i className="block h-full rounded-full bg-[#a9d75a]" style={{ width: `${Math.min(100, item.otherPresences == null ? 0 : item.otherPresences / maxModalityPresences * 100)}%` }} /> : <i className="block h-full rounded-full bg-[repeating-linear-gradient(135deg,#e7e2eb_0,#e7e2eb_3px,#f5f2f6_3px,#f5f2f6_6px)]" />}</span><b className="min-w-12 text-right tabular-nums">{reportCount(item.otherPresences)}</b></div>
                       <p className="text-right text-[9px] tabular-nums text-[#716879]">{item.coverageComplete ? `Agregadores ${percentage(item.share)} · demais ${percentage(item.otherShare)}` : 'Participação desconhecida · cobertura incompleta'}</p>
                   </div>
                 </div>)}</div>
               </div>}
                <p className="text-[9px] text-[#837b8b]">{mode === 'quarter' ? 'Resumo do trimestre' : 'Resumo do período'} = soma dos meses com dados; meses sem dados permanecem desconhecidos. Metas não são somadas. Cobertura parcial mantém “demais presenças” e participação como desconhecidas.</p>
               {estimatedAggregatorMonths.size > 0 && <p className="text-[9px] text-[#837b8b]" data-testid="note-aggregator-estimate">Estimativa mensal sinalizada nos meses correspondentes.</p>}
              </div> : <ChartEmpty text={aggregatorEmptyMessage} />}
            <ReportTable
              headers={['Mês', 'Agregadores', 'Presenças totais', 'Demais presenças', 'Agregadores %', 'Demais %', 'Meta', 'Atingimento']}
              rows={occupancyQuery.isError ? [] : aggregatorReportRows}
              emptyMessage={occupancyQuery.isError ? 'Dados de check-in indisponíveis nesta exportação.' : 'Sem dados no período'}
              summary={occupancyQuery.isError || occupancyGoalsQuery.isError ? undefined : [
                mode === 'quarter' ? 'Total do trimestre' : 'Total do período',
                reportCount(aggregatorPeriodSummary.aggregatorPresences),
                reportCount(aggregatorPeriodSummary.totalPresences),
                aggregatorPeriodSummary.otherPresences == null ? 'Desconhecido' : count(aggregatorPeriodSummary.otherPresences),
                percentage(aggregatorPeriodSummary.sharePercentage),
                percentage(aggregatorPeriodSummary.otherSharePercentage),
                'Metas mensais',
                aggregatorPeriodSummary.sharePercentage == null ? 'Cobertura incompleta' : 'Não somar metas',
              ]}
            />
          </section>
          </div>

          <div className="dashboard-print-page-group" data-pdf-page="operations">
          <ReportPageHeading basePath={appBasePath} periodLabel={periodLabel} filters={printFilters} lastRefresh={lastRefresh} partial={allError} />
          <section className={`${panel} ${dark ? 'bg-[#332c3d] border-[#493f55]' : ''}`} data-testid="chart-complete-occupancy" data-pdf-panel="complete-occupancy">
            <PdfPrintHeader title="Check-in e Ocupação" period={periodLabel} filters={printFilters} />
            <div className="mb-3 flex items-start justify-between gap-2"><div><p className="text-[9px] font-bold uppercase tracking-[.14em] text-[#8c73b4]">check-ins e utilização das aulas</p><h2 className="mt-1 font-[family-name:var(--app-font-serif)] text-xl font-extrabold tracking-[-.045em]">Check-in e Ocupação</h2><p className="mt-1 text-[10px] text-[#837b8b]">Presenças, capacidade e taxa de ocupação por mês.</p></div><DownloadPdfButton scope="complete-occupancy" title="Check-in e Ocupação" period={periodLabel} compact disabled={refreshing || occupancyQuery.isError} /></div>
            {!occupancyQuery.isLoading && !occupancyQuery.isError && occupancy.totals.classes > 0 && <div className="dashboard-pdf-full-hide grid grid-cols-2 gap-2 rounded-xl border border-[#eeeaf1] bg-[#fbf9fc] p-3 sm:grid-cols-4" data-testid="summary-checkin">
              <div><p className="text-[9px] font-bold uppercase tracking-wide text-[#837b8b]">Ocupação ponderada</p><p className="mt-1 text-lg font-extrabold tabular-nums">{percentage(occupancy.totals.percentage)}</p><p className="text-[9px] text-[#837b8b]">presenças ÷ capacidade</p></div>
              <div><p className="text-[9px] font-bold uppercase tracking-wide text-[#837b8b]">Presenças</p><p className="mt-1 text-lg font-extrabold tabular-nums">{reportCount(occupancy.totals.presences)}</p></div>
              <div><p className="text-[9px] font-bold uppercase tracking-wide text-[#837b8b]">Capacidade</p><p className="mt-1 text-lg font-extrabold tabular-nums">{reportCount(occupancy.totals.capacity)}</p></div>
              <div><p className="text-[9px] font-bold uppercase tracking-wide text-[#837b8b]">Aulas</p><p className="mt-1 text-lg font-extrabold tabular-nums">{count(occupancy.totals.classes)}</p></div>
            </div>}
            {occupancyQuery.isLoading ? <div className="h-[280px] animate-pulse rounded-2xl bg-[#f1edf4]" /> : occupancyQuery.isError ? <ChartEmpty text={`Não foi possível carregar ocupação. ${errorMessage(occupancyQuery.error)}`} /> : occupancyChartRows.some((row) => row.percentage != null || row.presences != null || row.capacity != null) ? <ChartContainer role="img" aria-label="Check-ins mensais, capacidade, taxa de ocupação e meta" config={{ presences: { label: 'Presenças', color: palette.purple }, capacity: { label: 'Capacidade', color: palette.lime }, percentage: { label: 'Taxa de ocupação', color: palette.purple }, occupancyTargetPercentage: { label: 'Meta de ocupação', color: palette.orange } }} className="dashboard-pdf-chart h-[300px] w-full"><ResponsiveContainer width="100%" height="100%"><ComposedChart data={occupancyChartRows} margin={{ top: 8, right: 8, bottom: 8, left: 3 }}><CartesianGrid vertical={false} stroke={grid} /><XAxis dataKey="month" tickFormatter={monthLabel} tick={{ fill: axis, fontSize: 10 }} axisLine={false} tickLine={false} /><YAxis yAxisId="count" allowDecimals={false} tick={{ fill: axis, fontSize: 9 }} axisLine={false} tickLine={false} /><YAxis yAxisId="rate" orientation="right" domain={[0, 'auto']} tickFormatter={(value) => `${Number(value).toLocaleString('pt-BR')}%`} tick={{ fill: axis, fontSize: 9 }} axisLine={false} tickLine={false} /><Tooltip labelFormatter={(value) => monthLabel(String(value))} formatter={(value, name) => [value == null ? 'Não informado' : name === 'Taxa de ocupação' || name === 'Meta de ocupação' ? `${Number(value).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%` : count(Number(value)), String(name)]} /><Legend wrapperStyle={{ fontSize: 9 }} /><Bar yAxisId="count" dataKey="presences" name="Presenças" fill={palette.purple} radius={[4, 4, 0, 0]} maxBarSize={22} /><Bar yAxisId="count" dataKey="capacity" name="Capacidade" fill={palette.lime} radius={[4, 4, 0, 0]} maxBarSize={22} /><Line yAxisId="rate" dataKey="percentage" name="Taxa de ocupação" stroke={palette.purple} strokeWidth={2} connectNulls={false} dot={false} /><Line yAxisId="rate" dataKey="occupancyTargetPercentage" name="Meta de ocupação" stroke={palette.orange} strokeWidth={2} strokeDasharray="5 4" connectNulls={false} dot={false} /></ComposedChart></ResponsiveContainer></ChartContainer> : <ChartEmpty text="Sem dados no período. Não há check-ins com informações de presenças ou ocupação." />}
             {!occupancyQuery.isLoading && !occupancyQuery.isError && occupancyChartRows.some((row) => row.percentage != null || row.presences != null || row.capacity != null) && <div className="dashboard-pdf-full-hide overflow-x-auto rounded-xl border border-[#eeeaf1]" data-testid="table-checkin-monthly">
               <table className="w-full min-w-[520px] text-left text-[10px]">
                 <thead className="bg-[#f8f5fb] text-[#716879]"><tr><th className="px-3 py-2 font-bold">Mês</th><th className="px-3 py-2 font-bold">Aulas</th><th className="px-3 py-2 font-bold">Presenças</th><th className="px-3 py-2 font-bold">Capacidade</th><th className="px-3 py-2 font-bold">Ocupação</th><th className="px-3 py-2 font-bold">Meta / atingimento</th></tr></thead>
                 <tbody>{occupancyChartRows.map((row) => {
                   const classes = occupancy.evolution.filter((point) => dateMonth(point.period) === row.month).reduce((sum, point) => sum + point.recordCount, 0);
                   const attainment = row.percentage != null && row.occupancyTargetPercentage != null && row.occupancyTargetPercentage > 0 ? row.percentage / row.occupancyTargetPercentage * 100 : null;
                   return <tr key={row.month} className="border-t border-[#eeeaf1]"><th scope="row" className="px-3 py-2 font-semibold">{monthLabel(row.month)}</th><td className="px-3 py-2 tabular-nums">{count(classes || null)}</td><td className="px-3 py-2 tabular-nums">{reportCount(row.presences)}</td><td className="px-3 py-2 tabular-nums">{reportCount(row.capacity)}</td><td className="px-3 py-2 tabular-nums">{percentage(row.percentage)}</td><td className="px-3 py-2 tabular-nums">{row.occupancyTargetPercentage == null ? 'Meta não definida' : `${percentage(row.occupancyTargetPercentage)} · ${attainment == null ? 'sem comparação' : `${attainment.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`}`}</td></tr>;
                 })}</tbody>
               </table>
             </div>}
              {!occupancyQuery.isLoading && !occupancyQuery.isError && occupancyModalityRows.length > 0 && <div className="dashboard-pdf-full-hide rounded-xl border border-[#eeeaf1] p-3" data-testid="chart-occupancy-by-modality">
                <h3 className="text-[10px] font-extrabold text-[#51465f]">Ocupação por modalidade</h3>
                <p className="mt-1 text-[9px] text-[#837b8b]">Taxas ponderadas por presenças e capacidade quando disponíveis; taxas históricas informadas permanecem separadas.</p>
                <div className="mt-3 space-y-2.5">{occupancyModalityRows.map((row) => <div key={row.modalityId} className="grid grid-cols-[minmax(5rem,8rem)_1fr_auto] items-center gap-2 text-[10px]">
                  <span className="truncate font-semibold" title={row.modalityName}>{row.modalityName}</span>
                  <span className="h-2 overflow-hidden rounded-full bg-[#eeeaf1]" aria-hidden="true"><i className="block h-full rounded-full bg-[#9c80c2]" style={{ width: `${Math.max(0, Math.min(100, row.percentage / maxOccupancyModalityPercentage * 100))}%` }} /></span>
                  <span className="min-w-[4.5rem] text-right font-bold tabular-nums">{percentage(row.percentage)}</span>
                </div>)}</div>
              </div>}
             {occupancyChartRows.some((row) => row.occupancyTargetPercentage != null) && <div className="dashboard-pdf-full-hide flex flex-wrap gap-2">{occupancyChartRows.filter((row) => row.occupancyTargetPercentage != null).map((row) => {
              const attainment = row.percentage != null && row.occupancyTargetPercentage! > 0
                ? row.percentage / row.occupancyTargetPercentage! * 100
                : null;
              return <span key={row.month} className="rounded-full border border-[#e9e4eb] bg-[#fffefc] px-2.5 py-1 text-[10px] text-[#65479c]" data-testid={`text-occupancy-goal-${row.month}`}>{monthLabel(row.month)} · {attainment == null ? 'sem comparação' : `${attainment.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}% da meta`}</span>;
            })}</div>}
             <p className="dashboard-pdf-full-hide mt-2 rounded-xl bg-[#f8f5fb] px-3 py-2 text-[10px] text-[#716879]">{modalityId ? 'Meta da modalidade selecionada' : 'Meta geral'}: {occupancyChartRows.some((row) => row.occupancyTargetPercentage != null) ? 'metas salvas por mês' : 'Meta não definida'}{mode === 'range' && ' · Metas mensais não se aplicam aos meses parcialmente filtrados.'}</p>
            <ReportTable
              headers={['Mês', 'Presenças', 'Capacidade', 'Ocupação', 'Meta', 'Atingimento']}
              rows={occupancyQuery.isError ? [] : occupancyReportRows}
              emptyMessage={occupancyQuery.isError ? 'Dados de check-in indisponíveis nesta exportação.' : 'Sem dados no período'}
              summary={occupancyQuery.isError || occupancyGoalsQuery.isError ? undefined : [
                'Total do período',
                reportCount(occupancy.totals.presences),
                reportCount(occupancy.totals.capacity),
                percentage(occupancy.totals.percentage),
                'Metas mensais',
                'Comparação por mês',
              ]}
            />
          </section>

          <section className={`${panel} ${dark ? 'bg-[#332c3d] border-[#493f55]' : ''}`} data-testid="chart-complete-revenue" data-pdf-panel="complete-revenue">
            <PdfPrintHeader title="Faturamento e meta" period={periodLabel} filters={printFilters} />
             <div className="mb-3 flex items-start justify-between gap-2"><div><p className="text-[9px] font-bold uppercase tracking-[.14em] text-[#8c73b4]">scoreboard oficial</p><h2 className="mt-1 font-[family-name:var(--app-font-serif)] text-xl font-extrabold tracking-[-.045em]">Faturamento e meta</h2><p className="mt-1 text-[10px] text-[#837b8b]">Vendas são transações; unidades, bruto, estornos e líquido são apresentados separadamente.</p></div><DownloadPdfButton scope="complete-revenue" title="Faturamento e meta" period={periodLabel} compact disabled={refreshing || salesQuery.isError} /></div>
             <div className="dashboard-pdf-hide mb-3 grid gap-3 rounded-xl border border-[#eeeaf1] bg-[#fbf9fc] p-3 sm:grid-cols-[minmax(0,1fr)_minmax(180px,.7fr)] sm:items-end" data-testid="filters-complete-revenue">
               <p className="text-[10px] leading-relaxed text-[#716879]">Este filtro altera apenas o Faturamento. A modalidade restringe vendas com vínculo explícito; não redistribui vendas sem vínculo.</p>
               <label className="text-[10px] font-bold text-[#837b8b]">Produto / plano
                  <select value={productId} onChange={(event) => setProductId(event.target.value)} className="mt-1 h-10 w-full rounded-xl border border-[#e9e4eb] bg-[#fffefc] px-3 text-xs font-semibold text-[#443d50]" data-testid="select-dashboard-product"><option value="">Todos os produtos</option>{productOptions.map((item) => <option key={item.id} value={item.id}>{item.name}{item.isActive ? '' : ' · inativo'}</option>)}</select>
               </label>
             </div>
             {finance && !salesQuery.isError && <div className="dashboard-pdf-full-hide mb-3 grid grid-cols-2 gap-2 rounded-xl border border-[#eeeaf1] bg-[#fbf9fc] p-3 sm:grid-cols-3" data-testid="summary-revenue">
                <div><p className="text-[9px] font-bold uppercase tracking-wide text-[#837b8b]">Vendas</p><p className="mt-1 text-lg font-extrabold tabular-nums">{count(finance.totals.saleCount)}</p><p className="text-[9px] text-[#837b8b]">{count(finance.totals.quantity)} unidades vendidas</p></div>
               <div><p className="text-[9px] font-bold uppercase tracking-wide text-[#837b8b]">Bruto</p><p className="mt-1 text-lg font-extrabold tabular-nums">{money(finance.totals.salesCents)}</p></div>
               <div><p className="text-[9px] font-bold uppercase tracking-wide text-[#837b8b]">Estornos</p><p className="mt-1 text-lg font-extrabold tabular-nums">{money(finance.totals.refundCents)}</p></div>
               <div><p className="text-[9px] font-bold uppercase tracking-wide text-[#837b8b]">Líquido</p><p className="mt-1 text-lg font-extrabold tabular-nums">{money(finance.totals.netCents)}</p></div>
                <div><p className="text-[9px] font-bold uppercase tracking-wide text-[#837b8b]">{revenueGoalLabel}</p><p className="mt-1 text-lg font-extrabold tabular-nums">{revenueGoalSummary}</p></div>
               <div><p className="text-[9px] font-bold uppercase tracking-wide text-[#837b8b]">Atingimento</p><p className="mt-1 text-lg font-extrabold tabular-nums">{revenueAttainment}</p></div>
             </div>}
              {salesQuery.isLoading ? <div className="h-[280px] animate-pulse rounded-2xl bg-[#f1edf4]" /> : salesQuery.isError ? <ChartEmpty text={`Não foi possível carregar o Scoreboard. ${errorMessage(salesQuery.error)}`} /> : revenueChart.length ? <ChartContainer role="img" aria-label={`Barras horizontais mensais de valores em reais: faturamento bruto, estornos, líquido e ${revenueGoalLabel.toLocaleLowerCase('pt-BR')}`} config={{ salesCents: { label: 'Faturamento bruto', color: palette.purple }, refundCents: { label: 'Estornos', color: palette.orange }, netCents: { label: 'Líquido', color: palette.green }, targetCents: { label: revenueGoalLabel, color: palette.lime } }} className="dashboard-pdf-chart h-[360px] w-full"><ResponsiveContainer width="100%" height="100%"><BarChart data={revenueChart} layout="vertical" margin={{ top: 8, right: 12, bottom: 8, left: 6 }}><CartesianGrid horizontal={false} stroke={grid} /><XAxis type="number" tickFormatter={(value) => money(Number(value))} tick={{ fill: axis, fontSize: 9 }} axisLine={false} tickLine={false} /><YAxis type="category" dataKey="month" width={84} tickFormatter={monthLabel} tick={{ fill: axis, fontSize: 10 }} axisLine={false} tickLine={false} /><Tooltip labelFormatter={(value) => monthLabel(String(value))} formatter={(value, name) => [money(Number(value)), String(name)]} /><Legend wrapperStyle={{ fontSize: 9 }} /><Bar dataKey="salesCents" name="Faturamento bruto" fill={palette.purple} radius={[0, 4, 4, 0]} maxBarSize={7} /><Bar dataKey="refundCents" name="Estornos" fill={palette.orange} radius={[0, 4, 4, 0]} maxBarSize={7} /><Bar dataKey="netCents" name="Líquido" fill={palette.green} radius={[0, 4, 4, 0]} maxBarSize={7} /><Bar dataKey="targetCents" name={revenueGoalLabel} fill={palette.lime} radius={[0, 4, 4, 0]} maxBarSize={7} /></BarChart></ResponsiveContainer></ChartContainer> : <ChartEmpty text="Sem dados no período" />}
             {!salesQuery.isLoading && !salesQuery.isError && revenueChart.length > 0 && <div className="dashboard-pdf-full-hide overflow-x-auto rounded-xl border border-[#eeeaf1]" data-testid="table-revenue-monthly">
                <table className="w-full min-w-[700px] text-left text-[10px]">
                  <thead className="bg-[#f8f5fb] text-[#716879]"><tr><th className="px-3 py-2 font-bold">Mês</th><th className="px-3 py-2 font-bold">Vendas</th><th className="px-3 py-2 font-bold">Unidades</th><th className="px-3 py-2 font-bold">Bruto</th><th className="px-3 py-2 font-bold">Estornos</th><th className="px-3 py-2 font-bold">Líquido</th><th className="px-3 py-2 font-bold">Meta</th><th className="px-3 py-2 font-bold">Atingimento</th></tr></thead>
                 <tbody>{revenueChart.map((row) => {
                   const attainment = row.targetCents != null && row.targetCents > 0 ? row.netCents / row.targetCents * 100 : null;
                    return <tr key={row.month} className="border-t border-[#eeeaf1]"><th scope="row" className="px-3 py-2 font-semibold">{monthLabel(row.month)}</th><td className="px-3 py-2 tabular-nums">{count(row.saleCount)}</td><td className="px-3 py-2 tabular-nums">{count(row.quantity)}</td><td className="px-3 py-2 tabular-nums">{money(row.salesCents)}</td><td className="px-3 py-2 tabular-nums">{money(row.refundCents)}</td><td className="px-3 py-2 tabular-nums">{money(row.netCents)}</td><td className="px-3 py-2 tabular-nums">{row.targetCents == null ? (modalityId ? 'Não comparada' : 'Não definida') : money(row.targetCents)}</td><td className="px-3 py-2 tabular-nums">{percentage(attainment)}</td></tr>;
                 })}</tbody>
               </table>
             </div>}
              {!salesQuery.isLoading && !salesQuery.isError && <details className="dashboard-pdf-full-hide rounded-xl border border-[#eeeaf1] px-3 py-2" data-testid="details-revenue-products">
                <summary className="cursor-pointer text-[10px] font-bold text-[#65479c]">Detalhar vendas e faturamento por produto</summary>
                {revenueProductReportRows.length > 0 ? <div className="mt-2 overflow-x-auto rounded-lg border border-[#eeeaf1]">
                  <table className="w-full min-w-[650px] text-left text-[9px]" data-testid="table-revenue-products">
                    <thead className="bg-[#f8f5fb] text-[#716879]"><tr><th className="px-2.5 py-2 font-bold">Plano/produto</th><th className="px-2.5 py-2 font-bold">Vendas</th><th className="px-2.5 py-2 font-bold">Unidades</th><th className="px-2.5 py-2 font-bold">Bruto</th><th className="px-2.5 py-2 font-bold">Estornos</th><th className="px-2.5 py-2 font-bold">Líquido</th></tr></thead>
                    <tbody>{revenueProductReportRows.map((row, index) => <tr key={`${row[0]}-${index}`} className="border-t border-[#eeeaf1]">{row.map((value, cellIndex) => <td key={cellIndex} className={`px-2.5 py-2 ${cellIndex ? 'tabular-nums' : 'font-semibold'}`}>{value}</td>)}</tr>)}</tbody>
                  </table>
                </div> : <p className="mt-2 text-[10px] text-[#837b8b]">Sem dados de produtos no período.</p>}
              </details>}
            {revenueDonutRows.length > 0 && <div className="mt-2 flex flex-wrap items-center gap-3 rounded-xl border border-[#eeeaf1] px-3 py-2"><div className="dashboard-pdf-donut h-[96px] w-[104px] shrink-0"><ResponsiveContainer width="100%" height="100%"><PieChart><Pie data={revenueDonutRows} dataKey="value" nameKey="name" innerRadius={25} outerRadius={41} paddingAngle={2} stroke="none" isAnimationActive={false}>{revenueDonutRows.map((row, index) => <Cell key={row.name} fill={index === 0 ? palette.purple : palette.lime} />)}</Pie><Tooltip formatter={(value) => [`${Number(value).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`, 'Meta']} /></PieChart></ResponsiveContainer></div><div className="text-[10px] text-[#716879]"><p className="font-bold">Líquido comparado à meta</p><p className="mt-1">{revenueActual >= revenueGoalTotal ? `Excedente: ${money(revenueActual - revenueGoalTotal)}` : `Falta: ${money(revenueGoalTotal - revenueActual)}`}</p><p className="mt-1 flex items-center gap-2"><i className="h-2.5 w-2.5 rounded-full bg-[#7655a8]" />Realizado</p><p className="mt-1 flex items-center gap-2"><i className="h-2.5 w-2.5 rounded-full bg-[#a9d75a]" />Parte restante da meta</p></div></div>}
            {!revenueDonutRows.length && <p className="mt-2 rounded-xl bg-[#f8f5fb] px-3 py-2 text-[10px] text-[#716879]">{weekday ? 'Meta mensal não comparada: o faturamento está filtrado por dia da semana.' : !revenueGoalScopeValid ? 'Meta não comparada: modalidade sem vínculo explícito com o produto selecionado.' : partialRevenueRange ? 'Meta mensal não comparada: o intervalo contém meses parciais.' : hasAnyRevenueGoal ? `Cobertura incompleta de ${revenueGoalLabel.toLocaleLowerCase('pt-BR')} neste recorte.` : `${revenueGoalLabel} não definida para todos os meses deste recorte.`}</p>}
             <p className="dashboard-pdf-full-hide mt-2 rounded-xl bg-[#f8f5fb] px-3 py-2 text-[10px] text-[#716879]">Metas exibidas somente quando há meta geral salva para o mês. {mode === 'range' ? `No intervalo personalizado, o faturamento usa as datas exatas; os valores mensais abrangem ${periodEndMonth ? 'os meses sobrepostos' : 'o período'}.` : 'Vendas, estornos e líquido permanecem medidas independentes.'}</p>
             <ReportTable
               headers={['Mês', 'Vendas', 'Unidades', 'Faturamento bruto', 'Estornos', 'Líquido', revenueGoalLabel, 'Atingimento']}
              rows={salesQuery.isError ? [] : revenueReportRows}
              emptyMessage={salesQuery.isError ? 'Dados do Scoreboard indisponíveis nesta exportação.' : 'Sem dados no período'}
              summary={salesQuery.isError || !finance || goalsQuery.isError ? undefined : [
                'Total do período',
                 count(finance.totals.saleCount),
                count(finance.totals.quantity),
                money(finance.totals.salesCents),
                money(finance.totals.refundCents),
                money(revenueActual),
                revenueGoalSummary,
                revenueAttainment,
              ]}
            />
             <ReportTable
               headers={['Plano/produto', 'Vendas', 'Unidades', 'Bruto', 'Estornos', 'Líquido']}
               rows={salesQuery.isError ? [] : revenueProductReportRows}
               emptyMessage={salesQuery.isError ? 'Dados do Scoreboard indisponíveis nesta exportação.' : 'Sem produtos no período'}
             />
          </section>
          </div>
        </div>
      )}
      <section className="dashboard-pdf-appendix" aria-label="Detalhamento numérico dos indicadores">
        <PdfPrintHeader title="Detalhamento numérico" period={periodLabel} filters={printFilters} />
        <div className="dashboard-pdf-appendix-tables">
          <section className="dashboard-pdf-appendix-card">
            <h2>Contratos ativos</h2>
            <ReportTable
              headers={['Mês', 'Contratos ativos', 'Meta', 'Diferença vs meta', 'Atingimento', 'Variação vs mês anterior']}
              rows={contractsQuery.isError ? [] : contractReportRows}
              emptyMessage={contractsQuery.isError ? 'Dados de contratos indisponíveis nesta exportação.' : 'Sem dados cadastrados no período'}
            />
          </section>
          <section className="dashboard-pdf-appendix-card">
            <h2>Agregadores</h2>
            <ReportTable
              headers={['Mês', 'Agregadores', 'Presenças totais', 'Demais presenças', 'Agregadores %', 'Demais %', 'Meta', 'Atingimento']}
              rows={occupancyQuery.isError ? [] : aggregatorReportRows}
              emptyMessage={occupancyQuery.isError ? 'Dados de check-in indisponíveis nesta exportação.' : aggregatorEmptyMessage}
              summary={occupancyQuery.isError || occupancyGoalsQuery.isError ? undefined : [
                mode === 'quarter' ? 'Total do trimestre' : 'Total do período',
                reportCount(aggregatorPeriodSummary.aggregatorPresences),
                reportCount(aggregatorPeriodSummary.totalPresences),
                aggregatorPeriodSummary.otherPresences == null ? 'Desconhecido' : count(aggregatorPeriodSummary.otherPresences),
                percentage(aggregatorPeriodSummary.sharePercentage),
                percentage(aggregatorPeriodSummary.otherSharePercentage),
                'Metas mensais',
                aggregatorPeriodSummary.sharePercentage == null ? 'Cobertura incompleta' : 'Não somar metas',
              ]}
            />
          </section>
          <section className="dashboard-pdf-appendix-card">
            <h2>Check-in e Ocupação</h2>
            <ReportTable
              headers={['Mês', 'Presenças', 'Capacidade', 'Ocupação', 'Meta', 'Atingimento']}
              rows={occupancyQuery.isError ? [] : occupancyReportRows}
              emptyMessage={occupancyQuery.isError ? 'Dados de check-in indisponíveis nesta exportação.' : 'Sem dados no período'}
              summary={occupancyQuery.isError || occupancyGoalsQuery.isError ? undefined : [
                'Total do período',
                reportCount(occupancy.totals.presences),
                reportCount(occupancy.totals.capacity),
                percentage(occupancy.totals.percentage),
                'Metas mensais',
                'Comparação por mês',
              ]}
            />
          </section>
          <section className="dashboard-pdf-appendix-card">
            <h2>Faturamento</h2>
            <ReportTable
              headers={['Mês', 'Vendas', 'Unidades', 'Faturamento bruto', 'Estornos', 'Líquido', revenueGoalLabel, 'Atingimento']}
              rows={salesQuery.isError ? [] : revenueReportRows}
              emptyMessage={salesQuery.isError ? 'Dados do Scoreboard indisponíveis nesta exportação.' : 'Sem dados no período'}
              summary={salesQuery.isError || !finance || goalsQuery.isError ? undefined : [
                'Total do período',
                count(finance.totals.saleCount),
                count(finance.totals.quantity),
                money(finance.totals.salesCents),
                money(finance.totals.refundCents),
                money(revenueActual),
                revenueGoalsComplete ? money(revenueGoalTotal) : 'Meta não comparada',
                revenueAttainment,
              ]}
            />
          </section>
        </div>
      </section>
      <section className="dashboard-pdf-goals" data-pdf-panel="complete-goals" aria-label="Relatório de metas dos indicadores">
        <PdfPrintHeader title="Metas dos indicadores" period={periodLabel} filters={printFilters} />
        <div className="dashboard-pdf-goals-content">
          <h2>Realizado, metas e atingimento</h2>
          <PdfPrintTable
            headers={['Mês', 'Indicador', 'Realizado', 'Meta', 'Diferença', 'Atingimento']}
            rows={goalReportRows}
          />
        </div>
      </section>
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
      <style>{`.zero3-dashboard-dark { color-scheme: dark; }`}</style>
    </section>
  );
}
