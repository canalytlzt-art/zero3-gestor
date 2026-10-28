import { useMemo, useState } from 'react';
import { CalendarDays, ChartNoAxesCombined, ChevronDown, CircleAlert, Clock3, RefreshCw, SlidersHorizontal, WalletCards } from 'lucide-react';
import {
  getGetProductsQueryKey,
  getGetSalesGoalsQueryKey,
  getGetSalesScoreboardQueryKey,
  getGetOccupancyModalitiesQueryKey,
  getGetOccupancyRecordsQueryKey,
  useGetProducts,
  useGetSalesGoals,
  useGetSalesScoreboard,
  useGetOccupancyModalities,
  useGetOccupancyRecords,
} from '@workspace/api-client-react';
import type { GetOccupancyRecordsParams, GetSalesScoreboardParams, OccupancyModality } from '@workspace/api-client-react';
import { ChartContainer } from '@/components/ui/chart';
import { PurpleSelect } from '@/components/ui/purple-select';
import { buildFinancialChartAnalytics } from '@/lib/financial-chart-data';
import { buildOccupancyChartAnalytics, type OccupancyChartSupportRow } from '@/lib/occupancy-chart-data';
import { getWeekdayName, getWeekdayNameForIsoDay } from '@/lib/occupancy-calendar';
import { formatCents, formatMonthKey, getSaoPauloMonthKey, getSalesGoalComparison, isCompleteCalendarMonthRange, monthKeysBetween, monthsForYearQuarter } from '@/lib/sales-utils';
import {
  changeOccupancyPeriod,
  clearOccupancyFilters,
  currentOccupancyMonth,
  occupancyFilterProblem,
  occupancyFilterSummary,
  occupancyAnalyticsMonths,
  occupancyQueryParams,
  updateOccupancyFilters,
  updateOccupancyQuarter,
  updateOccupancyYear,
  useOccupancyFilterState,
  type OccupancyChartViewMode,
  type OccupancyPeriodMode,
} from '@/lib/occupancy-filter-store';
import { Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

type ViewMode = OccupancyChartViewMode;

const palette = {
  ink: '#342d40',
  muted: '#837b8b',
  purple: '#7655a8',
  palePurple: '#ece6f4',
  border: '#e9e4eb',
  surface: '#fffefc',
};

const fieldClass = 'mt-1.5 h-10 w-full rounded-xl border border-[#e7e2ea] bg-[#fffefc] px-3 text-sm font-medium text-[#443d50] outline-none transition focus:border-[#9477bf] focus:ring-2 focus:ring-[#9477bf]/15';
const labelClass = 'block text-[10px] font-bold uppercase tracking-[.1em] text-[#817b89]';

function formatPercent(value: number | null | undefined) {
  return value == null ? '—' : `${value.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;
}

function formatDay(value: string) {
  const [year, month, day] = value.split('-');
  return year && month && day ? `${day}/${month}/${year}` : value;
}

function periodLabel(value: string, mode: ViewMode) {
  if (mode === 'monthly') return formatMonthKey(value);
  if (mode === 'quarterly') {
    const [year, quarter] = value.split('-Q');
    return `${quarter}º tri · ${year}`;
  }
  return formatDay(value);
}

function financialPeriodLabel(value: string, mode: FinancialTimelineMode) {
  if (mode === 'monthly') return formatMonthKey(value);
  const formatted = formatDay(value);
  return mode === 'weekly' ? `Sem. ${formatted.slice(0, 5)}` : formatted;
}

function formatCount(value: number | null) {
  return value == null ? '—' : value.toLocaleString('pt-BR');
}

function percentAxisMax(values: Array<number | null | undefined>) {
  const max = Math.max(100, ...values.filter((value): value is number => value != null));
  return Math.ceil(max / 10) * 10;
}

function percentAxisTicks(max: number) {
  return [...new Set([0, 25, 50, 75, 100, max])].filter((tick) => tick <= max);
}

function sourceLabel(source: OccupancyChartSupportRow['source']) {
  if (source === 'weighted') return 'Presenças ÷ vagas';
  return source === 'reported' ? 'Percentual legado informado' : 'Média de percentuais legados';
}

function formatError(error: unknown) {
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return error.message;
  return 'Não foi possível carregar os dados de ocupação. Tente atualizar novamente.';
}

function SectionHeading({ eyebrow, title, detail }: { eyebrow: string; title: string; detail: string }) {
  return (
    <div className="mb-5">
      <p className="text-[9px] font-bold uppercase tracking-[.15em] text-[#8c73b4]">{eyebrow}</p>
      <div className="mt-1 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="font-[family-name:var(--app-font-serif)] text-xl font-extrabold tracking-[-.045em] text-[#342d40]">{title}</h2>
        <p className="text-xs text-[#837b8b]">{detail}</p>
      </div>
    </div>
  );
}

function ChartEmpty({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="flex min-h-[220px] flex-col items-center justify-center rounded-2xl border border-dashed border-[#ded7e4] bg-[#fbf9fc] px-5 text-center" data-testid="empty-occupancy-chart">
      <span className="grid h-10 w-10 place-items-center rounded-full bg-[#ece6f4] text-[#7655a8]"><ChartNoAxesCombined size={18} /></span>
      <p className="mt-3 text-sm font-bold text-[#4b4357]">{title}</p>
      <p className="mt-1 max-w-xs text-xs leading-5 text-[#837b8b]">{detail}</p>
    </div>
  );
}

function CoverageNote({ covered, available }: { covered: number; available: number }) {
  if (available <= 0 || covered >= available) return null;
  return (
    <p className="mt-3 flex items-start gap-2 rounded-xl bg-[#fbf4e7] px-3 py-2.5 text-xs leading-5 text-[#765c31]" data-testid="status-partial-coverage">
      <CircleAlert size={15} className="mt-0.5 shrink-0" />
      Cobertura parcial: há dados em {covered} de {available} períodos selecionados. Períodos sem registro permanecem sem valor.
    </p>
  );
}

type FinancialPeriodMode = 'current' | 'single' | 'multiple' | 'quarter' | 'year' | 'range' | 'all';
type FinancialTimelineMode = 'daily' | 'weekly' | 'monthly';
type ShareBy = 'modality' | 'product';

const financeColors = ['#7655a8', '#a9d75a', '#4d8d7b', '#d18b57', '#8b789b', '#6c9cb5', '#c16e78', '#b3a46b'];

function FinancialCharts({ onOccupancy }: { onOccupancy: () => void }) {
  const currentMonth = getSaoPauloMonthKey();
  const [periodMode, setPeriodMode] = useState<FinancialPeriodMode>('current');
  const [singleMonth, setSingleMonth] = useState(currentMonth);
  const [months, setMonths] = useState<string[]>([currentMonth]);
  const [monthToAdd, setMonthToAdd] = useState(currentMonth);
  const [selectedYear, setSelectedYear] = useState(currentMonth.slice(0, 4));
  const [selectedQuarter, setSelectedQuarter] = useState(String(Math.ceil(Number(currentMonth.slice(5, 7)) / 3)));
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [productId, setProductId] = useState('');
  const [modalityId, setModalityId] = useState('');
  const [shareBy, setShareBy] = useState<ShareBy>('modality');
  const [weekdays, setWeekdays] = useState<number[]>([]);
  const [timelineMode, setTimelineMode] = useState<FinancialTimelineMode>('monthly');

  const invalid = (periodMode === 'single' && !singleMonth)
    || (periodMode === 'multiple' && months.length === 0)
    || ((periodMode === 'quarter' || periodMode === 'year')
      && monthsForYearQuarter(selectedYear, periodMode === 'quarter' ? selectedQuarter : undefined).length === 0)
    || (periodMode === 'range' && (!fromDate || !toDate || fromDate > toDate));
  const params = useMemo<GetSalesScoreboardParams>(() => {
    const query: GetSalesScoreboardParams = {};
    if (periodMode === 'current') query.months = [currentMonth];
    if (periodMode === 'single' && singleMonth) query.months = [singleMonth];
    if (periodMode === 'multiple' && months.length) query.months = [...new Set(months)].sort();
    if (periodMode === 'quarter') query.months = monthsForYearQuarter(selectedYear, selectedQuarter);
    if (periodMode === 'year') query.months = monthsForYearQuarter(selectedYear);
    if (periodMode === 'range' && fromDate && toDate && fromDate <= toDate) {
      query.fromDate = fromDate;
      query.toDate = toDate;
    }
    if (productId) query.productId = productId;
    if (modalityId) query.modalityId = modalityId;
    if (weekdays.length) query.weekdays = [...weekdays].sort((a, b) => a - b);
    return query;
  }, [periodMode, currentMonth, singleMonth, months, selectedYear, selectedQuarter, fromDate, toDate, productId, modalityId, weekdays]);

  const scoreboard = useGetSalesScoreboard(params, {
    query: {
      queryKey: getGetSalesScoreboardQueryKey(params),
      enabled: !invalid,
      refetchOnMount: 'always',
      refetchOnWindowFocus: true,
      staleTime: 20_000,
    },
  });
  const productsQuery = useGetProducts({
    query: { queryKey: getGetProductsQueryKey(), refetchOnMount: 'always', refetchOnWindowFocus: true, staleTime: 20_000 },
  });
  const modalitiesQuery = useGetOccupancyModalities({
    query: { queryKey: getGetOccupancyModalitiesQueryKey(), refetchOnMount: 'always', refetchOnWindowFocus: true, staleTime: 20_000 },
  });
  const goalsQuery = useGetSalesGoals({
    query: { queryKey: getGetSalesGoalsQueryKey(), refetchOnMount: 'always', refetchOnWindowFocus: true, staleTime: 20_000 },
  });
  const products = productsQuery.data ?? [];
  const modalities = useMemo(() => [...(modalitiesQuery.data ?? [])].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')), [modalitiesQuery.data]);
  const report = scoreboard.data;
  const analytics = useMemo(() => report ? buildFinancialChartAnalytics(report) : null, [report]);
  const selectedProduct = products.find((item) => item.id === productId);
  const productModalityConflict = Boolean(productId && modalityId && selectedProduct && selectedProduct.modalityId !== modalityId);
  const shareData = shareBy === 'modality' ? analytics?.salesShareByModality ?? [] : analytics?.salesShareByProduct ?? [];
  const shareTotal = shareData.reduce((sum, item) => sum + item.salesCents, 0);
  const allMonths = useMemo(() => {
    const rowMonths = report?.months.map((row) => row.month) ?? [];
    const scopeGoals = (goalsQuery.data ?? []).filter((goal) => productId ? goal.productId === productId : goal.productId === null);
    return [...new Set([...rowMonths, ...scopeGoals.map((goal) => goal.month)])].sort();
  }, [report?.months, goalsQuery.data, productId]);
  const goalMonths = useMemo(() => {
    if (periodMode === 'current') return [currentMonth];
    if (periodMode === 'single') return singleMonth ? [singleMonth] : [];
    if (periodMode === 'multiple') return [...new Set(months)].sort();
    if (periodMode === 'quarter') return monthsForYearQuarter(selectedYear, selectedQuarter);
    if (periodMode === 'year') return monthsForYearQuarter(selectedYear);
    if (periodMode === 'range') return invalid || !isCompleteCalendarMonthRange(fromDate, toDate) ? [] : monthKeysBetween(fromDate.slice(0, 7), toDate.slice(0, 7));
    return allMonths;
  }, [periodMode, currentMonth, singleMonth, months, selectedYear, selectedQuarter, invalid, fromDate, toDate, allMonths]);
  const goalMode = periodMode === 'range'
    ? invalid ? 'invalid' : isCompleteCalendarMonthRange(fromDate, toDate) ? 'complete' : 'partial-range'
    : goalMonths.length ? 'complete' : 'invalid';
  const comparison = !productModalityConflict && (productId ? Boolean(selectedProduct) : !modalityId)
    ? getSalesGoalComparison(
      BigInt(report?.totals.netCents ?? 0),
      goalMonths,
      invalid ? 'invalid' : weekdays.length ? 'partial-range' : goalMode,
      productId ? selectedProduct!.name : null,
      goalsQuery.data ?? [],
    )
    : null;
  const refreshing = scoreboard.isFetching || productsQuery.isFetching || modalitiesQuery.isFetching || goalsQuery.isFetching;
  const refresh = () => void Promise.all([scoreboard.refetch(), productsQuery.refetch(), modalitiesQuery.refetch(), goalsQuery.refetch()]);
  const addMonth = () => {
    if (monthKeysBetween(monthToAdd, monthToAdd).length) setMonths((current) => [...new Set([...current, monthToAdd])].sort());
  };
  const clearFilters = () => {
    setPeriodMode('all');
    setSingleMonth(currentMonth);
    setMonths([currentMonth]);
    setSelectedYear(currentMonth.slice(0, 4));
    setSelectedQuarter(String(Math.ceil(Number(currentMonth.slice(5, 7)) / 3)));
    setFromDate('');
    setToDate('');
    setProductId('');
    setModalityId('');
    setWeekdays([]);
  };
  const timelineRows = useMemo(() => {
    if (!analytics) return [];
    if (timelineMode === 'daily') return analytics.days.map((row) => ({ ...row, periodKey: row.date }));
    if (timelineMode === 'weekly') return analytics.weeks.map((row) => ({ ...row, periodKey: row.weekStart }));
    return analytics.months.map((row) => ({ ...row, periodKey: row.month }));
  }, [analytics, timelineMode]);
  const chartBox = 'rounded-[22px] border border-[#e9e4eb] bg-[#fffefc] p-4 shadow-[0_14px_35px_-30px_rgba(55,40,72,.28)] sm:p-5';
  const money = (value: number) => value < 0 ? `−${formatCents(Math.abs(value))}` : formatCents(value);

  return (
    <section className="space-y-5" aria-label="Gráficos financeiros" data-testid="page-financial-charts">
      <div className="flex flex-col justify-between gap-4 rounded-[22px] border border-[#e9e4eb] bg-[#fffefc] p-4 shadow-[0_14px_35px_-30px_rgba(55,40,72,.28)] sm:flex-row sm:items-center sm:px-6">
        <div>
          <p className="text-[9px] font-bold uppercase tracking-[.14em] text-[#8a8491]">zero3 pro <span className="mx-1 text-[#b2abb8]">/</span> gráficos</p>
          <h1 className="mt-1 font-[family-name:var(--app-font-serif)] text-3xl font-extrabold leading-none tracking-[-.07em] text-[#342d40] sm:text-[2.6rem]">Faturamento<span className="ml-1 text-[#a9d75a]">.</span></h1>
          <p className="mt-2 text-xs text-[#837b8b]">Leitura financeira baseada nas vendas e nos estornos registrados.</p>
        </div>
        <div className="flex items-center gap-2 self-start rounded-full bg-[#f5f2f6] p-1 sm:self-auto" aria-label="Área de gráficos">
          <button type="button" onClick={onOccupancy} className="rounded-full px-4 py-2 text-xs font-semibold text-[#766d83] hover:bg-white" data-testid="switch-graficos-ocupacao">Ocupação</button>
          <span className="rounded-full bg-[#ece6f4] px-4 py-2 text-xs font-bold text-[#65479c]" aria-current="page" data-testid="switch-graficos-faturamento">Faturamento</span>
        </div>
      </div>

      <section className={chartBox} data-testid="panel-financial-filters">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2"><SlidersHorizontal size={15} className="text-[#8c73b4]" /><h2 className="text-sm font-extrabold text-[#443d50]">Recorte do Scoreboard</h2></div>
          <button type="button" onClick={refresh} disabled={refreshing} className="inline-flex h-9 items-center gap-2 rounded-full border border-[#e7e2ea] px-3 text-xs font-bold text-[#62586d] transition hover:bg-[#f7f3f9] disabled:opacity-60" data-testid="button-refresh-financial-charts">
            <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />{refreshing ? 'Atualizando…' : 'Atualizar'}
          </button>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-[1fr_1.25fr_1fr_1fr]">
          <label className={labelClass}>Período
            <select value={periodMode} onChange={(event) => setPeriodMode(event.target.value as FinancialPeriodMode)} className={fieldClass} data-testid="select-financial-period">
              <option value="current">Mês atual</option><option value="single">Um mês</option><option value="multiple">Vários meses</option><option value="quarter">Trimestre</option><option value="year">Ano</option><option value="range">Intervalo de datas</option><option value="all">Todo o período</option>
            </select>
          </label>
          <div className="min-w-0">
            {periodMode === 'current' && <div className="pt-5 text-xs font-semibold capitalize text-[#5f5967]" data-testid="text-financial-current-month">{formatMonthKey(currentMonth)}</div>}
            {periodMode === 'single' && <label className={labelClass}>Mês<input type="month" className={fieldClass} value={singleMonth} onChange={(event) => setSingleMonth(event.target.value)} data-testid="input-financial-month" /></label>}
            {periodMode === 'multiple' && <div><label className={labelClass}>Adicionar mês</label><div className="flex gap-2"><input type="month" className={fieldClass} value={monthToAdd} onChange={(event) => setMonthToAdd(event.target.value)} data-testid="input-financial-month-add" /><button type="button" onClick={addMonth} className="mt-1.5 h-10 shrink-0 rounded-xl bg-[#ece6f4] px-3 text-xs font-bold text-[#65479c]" data-testid="button-financial-month-add">Adicionar</button></div><div className="mt-2 flex flex-wrap gap-1.5" data-testid="list-financial-months">{months.map((month) => <span key={month} className="rounded-full bg-[#f2edf6] px-2.5 py-1 text-[10px] font-bold capitalize text-[#65479c]" data-testid={`chip-financial-month-${month}`}>{formatMonthKey(month)} <button type="button" aria-label={`Remover ${formatMonthKey(month)}`} onClick={() => setMonths((items) => items.filter((item) => item !== month))} data-testid={`button-financial-month-remove-${month}`}>×</button></span>)}</div></div>}
            {(periodMode === 'quarter' || periodMode === 'year') && <div className={`grid gap-2 ${periodMode === 'quarter' ? 'grid-cols-2' : 'grid-cols-1'}`}><label className={labelClass}>Ano<input type="number" min="1000" max="9999" step="1" value={selectedYear} onChange={(event) => setSelectedYear(event.target.value)} className={fieldClass} data-testid="input-financial-year" /></label>{periodMode === 'quarter' && <label className={labelClass}>Trimestre<select value={selectedQuarter} onChange={(event) => setSelectedQuarter(event.target.value)} className={fieldClass} data-testid="select-financial-quarter"><option value="1">1º trimestre</option><option value="2">2º trimestre</option><option value="3">3º trimestre</option><option value="4">4º trimestre</option></select></label>}</div>}
            {periodMode === 'range' && <div className="grid grid-cols-2 gap-2"><label className={labelClass}>De<input type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} className={fieldClass} data-testid="input-financial-from" /></label><label className={labelClass}>Até<input type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} className={fieldClass} data-testid="input-financial-to" /></label></div>}
            {periodMode === 'all' && <div className="pt-5 text-xs text-[#716879]" data-testid="text-financial-all-time">Todo o histórico registrado</div>}
          </div>
          <label className={labelClass}>Produto
            <PurpleSelect
              value={productId || '__all_products__'}
              onValueChange={(value) => setProductId(value === '__all_products__' ? '' : value)}
              className="mt-1.5 rounded-xl"
              testId="select-financial-product"
              options={[
                { value: '__all_products__', label: 'Todos os produtos' },
                ...products.map((item) => ({ value: item.id, label: item.name })),
              ]}
            />
          </label>
          <label className={labelClass}>Modalidade
            <PurpleSelect
              value={modalityId || '__all_modalities__'}
              onValueChange={(value) => setModalityId(value === '__all_modalities__' ? '' : value)}
              className="mt-1.5 rounded-xl"
              testId="select-financial-modality"
              options={[
                { value: '__all_modalities__', label: 'Todas as modalidades' },
                ...modalities.map((item) => ({ value: item.id, label: item.name })),
              ]}
            />
          </label>
        </div>
        <fieldset className="mt-4 border-t border-[#efebf0] pt-3">
          <legend className={labelClass}>Dia da semana da movimentação</legend>
          <div className="mt-2 flex flex-wrap gap-1.5" data-testid="filters-financial-weekdays">
            {[1, 2, 3, 4, 5, 6, 7].map((weekday) => {
              const selected = weekdays.includes(weekday);
              return <label key={weekday} className={`inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1.5 text-[11px] font-bold ${selected ? 'border-[#7656b8] bg-[#eee8f7] text-[#5d4a78]' : 'border-[#e7e2ea] bg-white text-[#746c7e]'}`}>
                <input type="checkbox" checked={selected} onChange={() => setWeekdays((current) => selected ? current.filter((item) => item !== weekday) : [...current, weekday].sort())} className="accent-[#7656b8]" data-testid={`filter-financial-weekday-${weekday}`} />
                {getWeekdayNameForIsoDay(weekday)}
              </label>;
            })}
          </div>
          {weekdays.length > 0 && <p className="mt-2 text-[10px] leading-4 text-[#827b8b]" role="status" data-testid="status-financial-weekday-filter">Vendas são consideradas pela data da venda; estornos, pela data efetiva do estorno. A comparação com metas mensais não se aplica a este recorte.</p>}
        </fieldset>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          {invalid ? <p className="flex items-center gap-2 text-xs font-semibold text-[#a24f4d]" role="alert" data-testid="status-financial-invalid-filter"><CircleAlert size={14} />{periodMode === 'range' ? 'Informe um intervalo válido, com data inicial e final.' : periodMode === 'quarter' || periodMode === 'year' ? 'Informe um ano válido entre 1000 e 9999.' : 'Selecione ao menos um mês para consultar.'}</p> : productModalityConflict ? <p className="text-xs font-semibold text-[#765c31]" role="status" data-testid="status-financial-scope-conflict">O produto selecionado não está vinculado à modalidade escolhida. A combinação não tem vendas classificadas.</p> : <span className="text-[10px] text-[#837b8b]" data-testid="status-financial-filter-scope">Filtros aplicados diretamente ao Scoreboard oficial.</span>}
          <button type="button" onClick={clearFilters} className="rounded-lg px-3 py-2 text-xs font-semibold text-[#766d83] hover:bg-[#f6f3f8]" data-testid="button-financial-clear-filters">Limpar filtros</button>
        </div>
      </section>

      {scoreboard.isLoading || productsQuery.isLoading || modalitiesQuery.isLoading || goalsQuery.isLoading ? <div className="grid gap-5 lg:grid-cols-2" aria-label="Carregando dados financeiros" data-testid="loading-financial-charts">{[0, 1, 2, 3].map((item) => <div key={item} className="h-[300px] animate-pulse rounded-[22px] border border-[#e9e4eb] bg-[#fffefc] p-5"><div className="h-4 w-36 rounded bg-[#eee9f1]" /><div className="mt-7 h-56 rounded-2xl bg-[#f5f2f6]" /></div>)}</div>
        : (scoreboard.isError || productsQuery.isError || modalitiesQuery.isError || goalsQuery.isError) ? <div className="rounded-[22px] border border-[#ecd5d4] bg-[#fff9f8] p-6" role="alert" data-testid="error-financial-charts"><p className="font-bold text-[#673d3c]">Não foi possível carregar os dados financeiros.</p><p className="mt-1 text-xs text-[#806462]">Confira a conexão com o Scoreboard e tente novamente.</p><button type="button" onClick={refresh} className="mt-4 rounded-full bg-[#65479c] px-4 py-2 text-xs font-bold text-white" data-testid="button-retry-financial-charts">Tentar novamente</button></div>
          : !invalid && analytics && <>
            {!analytics.reconcilesByProduct || !analytics.reconcilesByMonth ? <p className="flex items-start gap-2 rounded-xl border border-[#ecd7aa] bg-[#fff8e9] px-4 py-3 text-xs leading-5 text-[#765c31]" role="status" data-testid="warning-financial-reconciliation"><CircleAlert size={15} className="mt-0.5 shrink-0" />Os agrupamentos por produto ou mês não reconciliam com os totais oficiais deste recorte. Os totais do Scoreboard permanecem como referência.</p> : null}
            <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Totais financeiros do período" data-testid="summary-financial-totals">
              {[['Vendas registradas', money(analytics.totals.salesCents), 'bruto'], ['Estornos', money(analytics.totals.refundCents), 'estornos'], ['Líquido após estornos', money(analytics.totals.netCents), 'líquido'], ['Unidades vendidas', analytics.totals.quantity.toLocaleString('pt-BR'), 'unidades']].map(([label, value, id]) => <article key={id} className="rounded-2xl border border-[#e9e4eb] bg-[#fffefc] px-4 py-4" data-testid={`metric-financial-${id}`}><p className="text-[10px] font-bold uppercase tracking-[.09em] text-[#837b8b]">{label}</p><p className="mt-2 text-xl font-extrabold tracking-[-.04em] tabular-nums text-[#342d40]" data-testid={`text-financial-${id}`}>{value}</p></article>)}
            </section>
            <section className="grid gap-5 xl:grid-cols-2">
              <article className={chartBox} data-testid="chart-financial-modality"><SectionHeading eyebrow="vendas brutas" title="Por modalidade" detail="R$ registrados no período" />
                {analytics.byModality.length ? <ChartContainer role="img" aria-label="Colunas de vendas brutas por modalidade, em reais" config={{ sales: { label: 'Vendas brutas', color: '#7655a8' } }} className="h-[300px] w-full"><BarChart data={analytics.byModality} margin={{ top: 8, right: 12, bottom: 8, left: 8 }}><CartesianGrid vertical={false} stroke="#eee9f1" /><XAxis dataKey="name" interval="preserveStartEnd" tick={{ fill: palette.ink, fontSize: 10 }} axisLine={false} tickLine={false} /><YAxis tickFormatter={(value) => money(Number(value))} tick={{ fill: palette.muted, fontSize: 10 }} axisLine={false} tickLine={false} /><Tooltip formatter={(value) => money(Number(value))} labelStyle={{ color: palette.ink }} /><Bar dataKey="salesCents" name="Vendas brutas" fill="#7655a8" radius={[6, 6, 0, 0]} maxBarSize={42} /></BarChart></ChartContainer> : <ChartEmpty title="Sem vendas neste recorte" detail="Não há vendas brutas registradas por modalidade." />}
              </article>
              <article className={chartBox} data-testid="chart-financial-product"><SectionHeading eyebrow="vendas brutas" title="Por produto" detail="R$ registrados no período" />
                {analytics.byProduct.length ? <ChartContainer role="img" aria-label="Colunas de vendas brutas por produto, em reais" config={{ sales: { label: 'Vendas brutas', color: '#7655a8' } }} className="h-[300px] w-full"><BarChart data={analytics.byProduct} margin={{ top: 8, right: 12, bottom: 70, left: 8 }}><CartesianGrid vertical={false} stroke="#eee9f1" /><XAxis dataKey="name" interval="preserveStartEnd" angle={-32} textAnchor="end" height={78} tick={{ fill: palette.ink, fontSize: 10 }} axisLine={false} tickLine={false} /><YAxis tickFormatter={(value) => money(Number(value))} tick={{ fill: palette.muted, fontSize: 10 }} axisLine={false} tickLine={false} /><Tooltip formatter={(value) => money(Number(value))} labelStyle={{ color: palette.ink }} /><Bar dataKey="salesCents" name="Vendas brutas" fill="#7655a8" radius={[6, 6, 0, 0]} maxBarSize={42} /></BarChart></ChartContainer> : <ChartEmpty title="Sem vendas neste recorte" detail="Não há produtos com vendas registradas." />}
              </article>
            </section>
            <section className="grid gap-5 xl:grid-cols-[1.25fr_.75fr]">
              <article className={chartBox} data-testid="chart-financial-monthly">
                <SectionHeading eyebrow="movimento no tempo" title="Vendas, estornos e líquido" detail="Colunas agrupadas · R$" />
                <div className="mb-3 flex flex-wrap gap-1 rounded-full bg-[#f3f0f5] p-1" role="group" aria-label="Granularidade da evolução financeira" data-testid="group-financial-timeline">
                  {(['daily', 'weekly', 'monthly'] as const).map((mode) => <button key={mode} type="button" aria-pressed={timelineMode === mode} onClick={() => setTimelineMode(mode)} className={`rounded-full px-3 py-1.5 text-[10px] font-bold ${timelineMode === mode ? 'bg-[#65479c] text-white' : 'text-[#716879]'}`} data-testid={`button-financial-timeline-${mode}`}>{mode === 'daily' ? 'Diária' : mode === 'weekly' ? 'Semanal' : 'Mensal'}</button>)}
                </div>
                {timelineRows.length ? <ChartContainer role="img" aria-label={`Vendas, estornos e líquido por período ${timelineMode === 'daily' ? 'diário' : timelineMode === 'weekly' ? 'semanal' : 'mensal'}, em reais`} config={{ salesCents: { label: 'Vendas', color: '#7655a8' }, refundCents: { label: 'Estornos', color: '#d18b57' }, netCents: { label: 'Líquido', color: '#6f9d45' } }} className="h-[310px] w-full"><BarChart data={timelineRows} margin={{ top: 6, right: 8, bottom: 4, left: 6 }}><CartesianGrid vertical={false} stroke="#eee9f1" /><XAxis dataKey="periodKey" interval="preserveStartEnd" tickFormatter={(value) => financialPeriodLabel(String(value), timelineMode)} tick={{ fill: palette.muted, fontSize: 10 }} axisLine={false} tickLine={false} /><YAxis tickFormatter={(value) => money(Number(value))} tick={{ fill: palette.muted, fontSize: 10 }} axisLine={false} tickLine={false} /><Tooltip labelFormatter={(label) => financialPeriodLabel(String(label), timelineMode)} formatter={(value, name) => [money(Number(value)), String(name)]} /><Bar dataKey="salesCents" name="Vendas" fill="#7655a8" radius={[4, 4, 0, 0]} /><Bar dataKey="refundCents" name="Estornos" fill="#d18b57" radius={[4, 4, 0, 0]} /><Bar dataKey="netCents" name="Líquido" fill="#6f9d45" radius={[4, 4, 0, 0]} /></BarChart></ChartContainer> : <ChartEmpty title={`Sem dados ${timelineMode === 'daily' ? 'diários' : timelineMode === 'weekly' ? 'semanais' : 'mensais'}`} detail="O Scoreboard não retornou movimentações nesta granularidade e neste recorte." />}
              </article>
              <article className={chartBox} data-testid="chart-financial-share">
                <div className="flex flex-wrap items-start justify-between gap-2"><SectionHeading eyebrow="composição das vendas" title="Participação no bruto" detail="Somente vendas acima de zero" /><div className="flex rounded-full bg-[#f3f0f5] p-1" role="group" aria-label="Agrupar participação por" data-testid="group-financial-share-mode"><button type="button" aria-pressed={shareBy === 'modality'} onClick={() => setShareBy('modality')} className={`rounded-full px-3 py-1.5 text-[10px] font-bold ${shareBy === 'modality' ? 'bg-[#65479c] text-white' : 'text-[#716879]'}`} data-testid="button-share-by-modality">Modalidade</button><button type="button" aria-pressed={shareBy === 'product'} onClick={() => setShareBy('product')} className={`rounded-full px-3 py-1.5 text-[10px] font-bold ${shareBy === 'product' ? 'bg-[#65479c] text-white' : 'text-[#716879]'}`} data-testid="button-share-by-product">Produto</button></div></div>
                {shareData.length ? <><div className="h-[220px] w-full"><ResponsiveContainer width="100%" height="100%"><PieChart><Pie data={shareData} dataKey="salesCents" nameKey="name" innerRadius="58%" outerRadius="82%" paddingAngle={2} stroke="none">{shareData.map((slice, index) => <Cell key={slice.key} fill={financeColors[index % financeColors.length]} />)}</Pie><Tooltip formatter={(value) => money(Number(value))} labelStyle={{ color: palette.ink }} /></PieChart></ResponsiveContainer></div><div className="flex flex-wrap gap-x-4 gap-y-2" data-testid="legend-financial-share">{shareData.map((slice, index) => <span key={slice.key} className="inline-flex items-center gap-1.5 text-[10px] text-[#62586d]" data-testid={`legend-financial-share-${slice.key}`}><i className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: financeColors[index % financeColors.length] }} />{slice.name}<b>{shareTotal ? ((slice.salesCents / shareTotal) * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) : '0'}%</b></span>)}</div></> : <ChartEmpty title="Sem vendas positivas" detail="A participação considera apenas valores de vendas brutas maiores que zero." />}
              </article>
            </section>
            <article className={chartBox} data-testid="chart-financial-quantity"><SectionHeading eyebrow="volume vendido" title="Unidades por produto" detail="Soma das quantidades registradas, não contagem de vendas" />
              {analytics.byProduct.length ? <ChartContainer role="img" aria-label="Quantidade total de unidades vendidas por produto" config={{ quantity: { label: 'Unidades', color: '#6f9d45' } }} className="h-[300px] w-full"><BarChart data={analytics.byProduct} layout="vertical" margin={{ top: 4, right: 12, bottom: 4, left: 8 }}><CartesianGrid horizontal={false} stroke="#eee9f1" /><XAxis type="number" tickFormatter={(value) => Number(value).toLocaleString('pt-BR')} tick={{ fill: palette.muted, fontSize: 10 }} axisLine={false} tickLine={false} /><YAxis type="category" dataKey="name" width={150} tick={{ fill: palette.ink, fontSize: 10 }} axisLine={false} tickLine={false} /><Tooltip formatter={(value) => [`${Number(value).toLocaleString('pt-BR')} unidades`, 'Quantidade']} labelStyle={{ color: palette.ink }} /><Bar dataKey="quantity" name="Unidades" fill="#6f9d45" radius={[0, 6, 6, 0]} maxBarSize={22} /></BarChart></ChartContainer> : <ChartEmpty title="Sem unidades neste recorte" detail="Não há quantidades registradas por produto." />}
            </article>
            {productModalityConflict ? <p className="rounded-xl bg-[#f6f3f8] px-4 py-3 text-xs text-[#716879]" data-testid="status-financial-goal-unavailable">Meta não comparada: o produto não pertence à modalidade selecionada.</p> : modalityId && !productId ? <p className="rounded-xl bg-[#f6f3f8] px-4 py-3 text-xs text-[#716879]" data-testid="status-financial-goal-unavailable">Meta não exibida: o recorte por modalidade não corresponde a uma meta mensal geral ou por produto.</p> : productId && !selectedProduct ? <p className="rounded-xl bg-[#f6f3f8] px-4 py-3 text-xs text-[#716879]" data-testid="status-financial-goal-unavailable">Meta não exibida: o produto selecionado não está disponível para comparação.</p> : comparison?.status === 'partial-range' ? <p className="rounded-xl bg-[#f6f3f8] px-4 py-3 text-xs text-[#716879]" data-testid="status-financial-goal-partial-range">Meta mensal não aplicada: o recorte contém parte de meses ou filtra dias da semana.</p> : comparison?.status === 'partial' ? <p className="rounded-xl bg-[#fbf4e7] px-4 py-3 text-xs text-[#765c31]" data-testid="status-financial-goal-partial">Cobertura parcial da meta: configurada para {comparison.configuredGoalCount} de {comparison.monthCount} meses. O combinado não é apresentado.</p> : comparison?.status === 'complete' ? <section className="flex flex-wrap items-center justify-between gap-4 rounded-[22px] border border-[#dfe8d3] bg-[#f5f9ef] px-5 py-4" data-testid="panel-financial-goal-comparison"><div><p className="text-[9px] font-bold uppercase tracking-[.12em] text-[#688646]">meta mensal · cobertura completa</p><p className="mt-1 text-lg font-extrabold text-[#3c4e2e]" data-testid="text-financial-goal-target">{formatCents(comparison.targetCents)} <span className="text-xs font-medium text-[#738064]">de meta</span></p></div><div className="text-right"><p className="text-xs font-semibold text-[#59694b]" data-testid="text-financial-goal-achievement">{(Number(comparison.achievementTenthsPercent) / 10).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}% atingido</p><p className="mt-1 text-[10px] text-[#738064]" data-testid="text-financial-goal-actual">Realizado líquido: {money(analytics.totals.netCents)}</p><p className="mt-1 text-[10px] font-semibold text-[#59694b]" data-testid="text-financial-goal-difference">{BigInt(analytics.totals.netCents) >= comparison.targetCents ? `Excedente: ${formatCents(BigInt(analytics.totals.netCents) - comparison.targetCents)}` : `Falta: ${formatCents(comparison.targetCents - BigInt(analytics.totals.netCents))}`}</p></div></section> : null}
          </>}
    </section>
  );
}

export default function OccupancyChartsPage() {
  const [activeTab, setActiveTab] = useState<'occupancy' | 'financial'>('occupancy');
  const filters = useOccupancyFilterState();
  const [monthToAdd, setMonthToAdd] = useState(currentOccupancyMonth());
  const viewMode = filters.viewMode;
  const setViewMode = (next: ViewMode) => updateOccupancyFilters({ viewMode: next });

  const filterProblem = occupancyFilterProblem(filters);
  const filterInvalid = Boolean(filterProblem);

  const params = useMemo<GetOccupancyRecordsParams>(() => occupancyQueryParams(filters), [filters]);

  const modalitiesQuery = useGetOccupancyModalities({
    query: {
      queryKey: getGetOccupancyModalitiesQueryKey(),
      refetchOnMount: 'always',
      refetchOnWindowFocus: true,
      staleTime: 20_000,
    },
  });
  const filterOptionsQuery = useGetOccupancyRecords({ kind: 'all' }, {
    query: {
      queryKey: getGetOccupancyRecordsQueryKey({ kind: 'all' }),
      refetchOnMount: 'always',
      refetchOnWindowFocus: true,
      staleTime: 20_000,
    },
  });
  const recordsQuery = useGetOccupancyRecords(params, {
    query: {
      queryKey: getGetOccupancyRecordsQueryKey(params),
      enabled: !filterInvalid,
      refetchOnMount: 'always',
      refetchOnWindowFocus: true,
      staleTime: 20_000,
    },
  });
  const modalities = useMemo(
    () => [...(modalitiesQuery.data ?? [])].sort((a: OccupancyModality, b: OccupancyModality) => a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' })),
    [modalitiesQuery.data],
  );
  const filterOptions = filterOptionsQuery.data ?? [];
  const startTimeOptions = useMemo(() => [...new Set(filterOptions.map((record) => record.startTime).filter((value): value is string => Boolean(value)))].sort(), [filterOptions]);
  const yearOptions = useMemo(() => [...new Set([currentOccupancyMonth().slice(0, 4), ...filterOptions.map((record) => record.month.slice(0, 4))])].sort().reverse(), [filterOptions]);
  const analyticsMonths = useMemo(
    () => occupancyAnalyticsMonths(filters),
    [filters.periodMode, filters.months, filters.year, filters.quarter],
  );

  const analyticsFilters = useMemo(() => ({
    viewMode,
    ...(analyticsMonths ? { selectedMonths: analyticsMonths } : {}),
    ...(filters.periodMode === 'day' && filters.day ? { fromDate: filters.day, toDate: filters.day } : {}),
    ...(filters.periodMode === 'range' && filters.fromDate && filters.toDate && filters.fromDate <= filters.toDate ? { fromDate: filters.fromDate, toDate: filters.toDate } : {}),
    modalityId: filters.modalityId || undefined,
    startTimes: filters.startTimes,
    weekdays: filters.weekdays,
  }), [viewMode, analyticsMonths, filters.periodMode, filters.day, filters.fromDate, filters.toDate, filters.modalityId, filters.startTimes, filters.weekdays]);
  const analytics = useMemo(
    () => buildOccupancyChartAnalytics(filterInvalid ? [] : recordsQuery.data ?? [], analyticsFilters),
    [filterInvalid, recordsQuery.data, analyticsFilters],
  );

  const refresh = () => {
    void Promise.all([modalitiesQuery.refetch(), filterOptionsQuery.refetch(), ...(filterInvalid ? [] : [recordsQuery.refetch()])]);
  };
  const isRefreshing = modalitiesQuery.isFetching || recordsQuery.isFetching || filterOptionsQuery.isFetching;
  const selectedModality = modalities.find((item) => item.id === filters.modalityId);
  const donutData = analytics.donut
    ? [
      { name: 'Ocupada', value: Math.min(100, Math.max(0, analytics.donut.occupied)), fill: palette.purple },
      { name: 'Complemento', value: Math.max(0, 100 - Math.min(100, Math.max(0, analytics.donut.occupied))), fill: '#e6e0eb' },
    ]
    : [];
  const comparisonData = analytics.comparison.map((item) => ({
    ...item,
    label: item.modalityName,
  }));
  const evolutionData = analytics.evolution
    .map((point) => ({ ...point, label: periodLabel(point.period, viewMode), value: point.percentage }));
  const supportRows = analytics.supportRows;
  const comparisonMax = percentAxisMax(comparisonData.map((item) => item.percentage));
  const evolutionMax = percentAxisMax(evolutionData.map((item) => item.value));
  const hourMax = percentAxisMax(analytics.byHour.map((item) => item.percentage));
  const weekdayMax = percentAxisMax(analytics.byWeekday.map((item) => item.percentage));
  const anyError = modalitiesQuery.isError || recordsQuery.isError || filterOptionsQuery.isError;
  const initialLoading = modalitiesQuery.isLoading || filterOptionsQuery.isLoading || (!filterInvalid && recordsQuery.isLoading);
  const hasContent = analytics.supportRows.length > 0;

  const addMonth = () => {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(monthToAdd) || filters.months.includes(monthToAdd)) return;
    updateOccupancyFilters({ months: [...filters.months, monthToAdd].sort() });
  };

  if (activeTab === 'financial') {
    return <FinancialCharts onOccupancy={() => setActiveTab('occupancy')} />;
  }

  return (
    <section className="space-y-5" aria-label="Gráficos de ocupação" data-testid="page-occupancy-charts">
      <div className="flex flex-col justify-between gap-4 rounded-[22px] border border-[#e9e4eb] bg-[#fffefc] p-4 shadow-[0_14px_35px_-30px_rgba(55,40,72,.28)] sm:flex-row sm:items-center sm:px-6">
        <div>
          <p className="text-[9px] font-bold uppercase tracking-[.14em] text-[#8a8491]">zero3 pro <span className="mx-1 text-[#b2abb8]">/</span> gráficos</p>
          <h1 className="mt-1 font-[family-name:var(--app-font-serif)] text-3xl font-extrabold leading-none tracking-[-.07em] text-[#342d40] sm:text-[2.6rem]">Ocupação<span className="ml-1 text-[#a9d75a]">.</span></h1>
          <p className="mt-2 text-xs text-[#837b8b]">Percentuais registrados por período, turma e modalidade.</p>
        </div>
        <div className="flex items-center gap-2 self-start rounded-full bg-[#f5f2f6] p-1 sm:self-auto" aria-label="Área de gráficos">
          <span className="rounded-full bg-[#ece6f4] px-4 py-2 text-xs font-bold text-[#65479c]" aria-current="page" data-testid="switch-graficos-ocupacao">Ocupação</span>
          <button type="button" onClick={() => setActiveTab('financial')} className="flex items-center gap-2 rounded-full px-3 py-2 text-xs font-semibold text-[#716879] transition hover:bg-white hover:text-[#65479c]" aria-label="Abrir gráficos de faturamento" data-testid="switch-graficos-faturamento">
            Faturamento
          </button>
        </div>
      </div>

      <div className="rounded-[22px] border border-[#e9e4eb] bg-[#fffefc] p-4 shadow-[0_14px_35px_-30px_rgba(55,40,72,.28)] sm:p-5" data-testid="panel-occupancy-filters">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2"><SlidersHorizontal size={15} className="text-[#8c73b4]" /><h2 className="text-sm font-extrabold text-[#443d50]">Filtros do gráfico</h2></div>
          <div className="flex gap-2">
            <button type="button" onClick={clearOccupancyFilters} className="h-9 rounded-full px-3 text-xs font-bold text-[#62586d] transition hover:bg-[#f7f3f9]" data-testid="button-clear-occupancy-chart-filters">Limpar filtros</button>
            <button type="button" onClick={refresh} disabled={isRefreshing} className="inline-flex h-9 items-center gap-2 rounded-full border border-[#e7e2ea] px-3 text-xs font-bold text-[#62586d] transition hover:bg-[#f7f3f9] disabled:cursor-wait disabled:opacity-60" data-testid="button-refresh-occupancy-charts">
              <RefreshCw size={13} className={isRefreshing ? 'animate-spin' : ''} /> Atualizar
            </button>
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-6">
          <div>
            <label className={labelClass} htmlFor="occupancy-period-mode">Período</label>
            <div className="relative">
              <select id="occupancy-period-mode" className={fieldClass} value={filters.periodMode} onChange={(event) => changeOccupancyPeriod(event.target.value as OccupancyPeriodMode)} data-testid="select-occupancy-period-mode">
                <option value="all">Todo o histórico</option><option value="day">Um dia</option><option value="range">Intervalo</option><option value="months">Mês ou meses</option>
              </select><ChevronDown size={14} className="pointer-events-none absolute right-3 top-4 text-[#857a90]" />
            </div>
          </div>
          <div>
            <label className={labelClass} htmlFor="occupancy-chart-year">Ano</label>
            <select id="occupancy-chart-year" className={fieldClass} value={filters.year} onChange={(event) => updateOccupancyYear(event.target.value)} data-testid="select-occupancy-chart-year" disabled={filters.periodMode === 'day' || filters.periodMode === 'range'}>
              <option value="">Todos os anos</option>{yearOptions.map((year) => <option key={year} value={year}>{year}</option>)}
            </select>
          </div>
          <div>
            <label className={labelClass} htmlFor="occupancy-chart-quarter">Trimestre</label>
            <select id="occupancy-chart-quarter" className={fieldClass} value={filters.quarter} onChange={(event) => updateOccupancyQuarter(event.target.value)} data-testid="select-occupancy-chart-quarter" disabled={filters.periodMode === 'day' || filters.periodMode === 'range'}>
              <option value="">Todos os trimestres</option><option value="1">1º · jan–mar</option><option value="2">2º · abr–jun</option><option value="3">3º · jul–set</option><option value="4">4º · out–dez</option>
            </select>
          </div>
          {filters.periodMode === 'day' && <div>
            <label className={labelClass} htmlFor="occupancy-chart-day">Dia</label>
            <input id="occupancy-chart-day" type="date" className={fieldClass} value={filters.day} onChange={(event) => updateOccupancyFilters({ day: event.target.value })} data-testid="input-occupancy-chart-day" />
          </div>}
          {filters.periodMode === 'range' && <>
            <div><label className={labelClass} htmlFor="occupancy-chart-from">De</label><input id="occupancy-chart-from" type="date" className={fieldClass} value={filters.fromDate} onChange={(event) => updateOccupancyFilters({ fromDate: event.target.value })} data-testid="input-occupancy-chart-from" /></div>
            <div><label className={labelClass} htmlFor="occupancy-chart-to">Até</label><input id="occupancy-chart-to" type="date" className={fieldClass} value={filters.toDate} onChange={(event) => updateOccupancyFilters({ toDate: event.target.value })} data-testid="input-occupancy-chart-to" /></div>
          </>}
          {filters.periodMode === 'months' && <div className="sm:col-span-2">
            <label className={labelClass} htmlFor="occupancy-chart-month">Meses selecionados</label>
            <div className="flex gap-2">
              <input id="occupancy-chart-month" type="month" className={fieldClass} value={monthToAdd} onChange={(event) => setMonthToAdd(event.target.value)} data-testid="input-occupancy-chart-month" />
              <button type="button" onClick={addMonth} disabled={!monthToAdd || filters.months.includes(monthToAdd)} className="mt-1.5 h-10 shrink-0 rounded-xl bg-[#ece6f4] px-4 text-xs font-bold text-[#65479c] transition hover:bg-[#e4daef] disabled:cursor-not-allowed disabled:opacity-50" data-testid="button-add-occupancy-month">Adicionar</button>
            </div>
            <div className="mt-2 flex min-h-7 flex-wrap gap-1.5" data-testid="list-occupancy-chart-months">
              {filters.months.map((month) => <span key={month} className="inline-flex items-center gap-2 rounded-full bg-[#f2edf6] px-3 py-1 text-[11px] font-bold capitalize text-[#65479c]" data-testid={`chip-occupancy-chart-month-${month}`}>
                {formatMonthKey(month)}<button type="button" aria-label={`Remover ${formatMonthKey(month)}`} onClick={() => updateOccupancyFilters({ months: filters.months.filter((item) => item !== month) })} className="text-[#8a73ad] hover:text-[#46335f]" data-testid={`button-remove-occupancy-month-${month}`}>×</button>
              </span>)}
              {filters.months.length === 0 && <span className="py-1 text-xs text-[#908897]">Adicione ao menos um mês.</span>}
            </div>
          </div>}
          <div>
            <label className={labelClass} htmlFor="occupancy-chart-modality">Modalidade</label>
            <PurpleSelect
              value={filters.modalityId || '__all_modalities__'}
              onValueChange={(value) => updateOccupancyFilters({ modalityId: value === '__all_modalities__' ? '' : value })}
              className="mt-1.5 rounded-xl"
              testId="select-occupancy-chart-modality"
              options={[
                { value: '__all_modalities__', label: 'Todas as modalidades' },
                ...modalities.map((modality) => ({ value: modality.id, label: modality.name })),
              ]}
            />
          </div>
          <div>
            <label className={labelClass} htmlFor="occupancy-chart-class">Turma / horário <span className="font-medium normal-case tracking-normal">(opcional)</span></label>
            <input id="occupancy-chart-class" type="search" maxLength={120} className={fieldClass} placeholder="Todas as turmas" value={filters.className} onChange={(event) => updateOccupancyFilters({ className: event.target.value })} data-testid="input-occupancy-chart-class" />
          </div>
        </div>
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <fieldset><legend className={labelClass}>Horário inicial</legend><div className="mt-1.5 flex flex-wrap gap-1.5" data-testid="filters-occupancy-chart-times">
            {startTimeOptions.map((time) => {
              const selected = filters.startTimes.includes(time);
              return <label key={time} className={`inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1.5 text-[11px] font-bold tabular-nums ${selected ? 'border-[#7656b8] bg-[#eee8f7] text-[#5d4a78]' : 'border-[#e7e2ea] bg-white text-[#746c7e]'}`}>
                <input type="checkbox" checked={selected} onChange={() => updateOccupancyFilters({ startTimes: selected ? filters.startTimes.filter((item) => item !== time) : [...filters.startTimes, time].sort() })} className="accent-[#7656b8]" data-testid={`filter-occupancy-chart-time-${time.replace(':', '')}`} />{time}
              </label>;
            })}
            {!startTimeOptions.length && <span className="text-xs text-[#908897]">Os horários aparecem após cadastrar aulas.</span>}
          </div></fieldset>
          <fieldset><legend className={labelClass}>Dia da semana</legend><div className="mt-1.5 flex flex-wrap gap-1.5" data-testid="filters-occupancy-chart-weekdays">
            {['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'].map((day, index) => {
              const weekday = index + 1;
              const selected = filters.weekdays.includes(weekday);
              return <label key={day} className={`inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1.5 text-[11px] font-bold ${selected ? 'border-[#7656b8] bg-[#eee8f7] text-[#5d4a78]' : 'border-[#e7e2ea] bg-white text-[#746c7e]'}`}>
                <input type="checkbox" checked={selected} onChange={() => updateOccupancyFilters({ weekdays: selected ? filters.weekdays.filter((item) => item !== weekday) : [...filters.weekdays, weekday].sort() })} className="accent-[#7656b8]" data-testid={`filter-occupancy-chart-weekday-${weekday}`} />{day}
              </label>;
            })}
          </div></fieldset>
        </div>
        {(filters.startTimes.length > 0 || filters.weekdays.length > 0) && <p className="mt-3 text-[10px] leading-4 text-[#8a8491]" role="status" data-testid="status-occupancy-chart-daily-only-filter">Horário e dia da semana filtram aulas diárias; registros mensais legados não têm esses dados.</p>}
        <p className="mt-3 text-[10px] font-semibold text-[#766d83]" data-testid="text-occupancy-chart-applied-filters">Recorte aplicado: {occupancyFilterSummary(filters)}{filters.modalityId ? ` · ${modalities.find((modality) => modality.id === filters.modalityId)?.name ?? 'Modalidade'}` : ''}{filters.className.trim() ? ` · Turma ${filters.className.trim()}` : ''}</p>
        {filterProblem && <p className="mt-3 flex items-center gap-2 text-xs font-semibold text-[#a24f4d]" role="alert" data-testid="status-invalid-occupancy-filter"><CircleAlert size={14} />{filterProblem}</p>}
      </div>

      {initialLoading ? <div className="grid gap-5 lg:grid-cols-2" aria-label="Carregando gráficos de ocupação" data-testid="loading-occupancy-charts">
        {[0, 1, 2].map((item) => <div key={item} className="min-h-[310px] animate-pulse rounded-[22px] border border-[#e9e4eb] bg-[#fffefc] p-5"><div className="h-3 w-24 rounded bg-[#eee9f1]" /><div className="mt-4 h-5 w-40 rounded bg-[#eee9f1]" /><div className="mt-8 h-48 rounded-2xl bg-[#f5f2f6]" /></div>)}
      </div> : anyError ? <div className="rounded-[22px] border border-[#ecd5d4] bg-[#fff9f8] p-6" role="alert" data-testid="error-occupancy-charts">
        <div className="flex items-start gap-3"><CircleAlert size={18} className="mt-0.5 text-[#ad5955]" /><div><h2 className="text-sm font-extrabold text-[#673d3c]">Não foi possível montar os gráficos</h2>
          <p className="mt-1 text-xs leading-5 text-[#806462]">{formatError(recordsQuery.error ?? filterOptionsQuery.error ?? modalitiesQuery.error)}</p>
          <button type="button" onClick={refresh} className="mt-4 rounded-full bg-[#65479c] px-4 py-2 text-xs font-bold text-white hover:bg-[#583d89]" data-testid="button-retry-occupancy-charts">Tentar novamente</button>
        </div></div>
      </div> : filterInvalid ? null : !hasContent ? <div className="rounded-[22px] border border-dashed border-[#ded7e4] bg-[#fbf9fc] px-6 py-12 text-center" data-testid="empty-occupancy-records">
        <span className="mx-auto grid h-11 w-11 place-items-center rounded-full bg-[#ece6f4] text-[#7655a8]"><CalendarDays size={19} /></span>
        <h2 className="mt-4 text-base font-extrabold text-[#443d50]">Nenhum percentual neste recorte</h2>
        <p className="mx-auto mt-1 max-w-md text-xs leading-5 text-[#837b8b]">Ajuste o período ou a turma. Os gráficos exibem apenas percentuais persistidos, sem completar dias ou meses ausentes.</p>
      </div> : <>
        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Indicadores de ocupação" data-testid="occupancy-indicators">
          <article className="rounded-[20px] border border-[#e9e4eb] bg-[#fffefc] p-4 shadow-[0_10px_28px_-28px_rgba(55,40,72,.3)]" data-testid="metric-occupancy-classes">
            <p className="text-[9px] font-bold uppercase tracking-[.12em] text-[#8a8491]">Aulas registradas</p>
            <p className="mt-2 font-[family-name:var(--app-font-serif)] text-2xl font-extrabold tabular-nums tracking-[-.05em] text-[#342d40]">{formatCount(analytics.totals.classes)}</p>
            <p className="mt-1 text-[10px] text-[#837b8b]">No recorte aplicado</p>
          </article>
          <article className="rounded-[20px] border border-[#e9e4eb] bg-[#fffefc] p-4 shadow-[0_10px_28px_-28px_rgba(55,40,72,.3)]" data-testid="metric-occupancy-presences">
            <p className="text-[9px] font-bold uppercase tracking-[.12em] text-[#8a8491]">Total de presenças</p>
            <p className="mt-2 font-[family-name:var(--app-font-serif)] text-2xl font-extrabold tabular-nums tracking-[-.05em] text-[#342d40]">{formatCount(analytics.totals.presences)}</p>
            <p className="mt-1 text-[10px] text-[#837b8b]">Soma das aulas medidas</p>
          </article>
          <article className="rounded-[20px] border border-[#e9e4eb] bg-[#fffefc] p-4 shadow-[0_10px_28px_-28px_rgba(55,40,72,.3)]" data-testid="metric-occupancy-capacity">
            <p className="text-[9px] font-bold uppercase tracking-[.12em] text-[#8a8491]">Vagas ofertadas</p>
            <p className="mt-2 font-[family-name:var(--app-font-serif)] text-2xl font-extrabold tabular-nums tracking-[-.05em] text-[#342d40]">{formatCount(analytics.totals.capacity)}</p>
            <p className="mt-1 text-[10px] text-[#837b8b]">Capacidade total das aulas medidas</p>
          </article>
          <article className="rounded-[20px] border border-[#e0d7ed] bg-[#f8f5fb] p-4 shadow-[0_10px_28px_-28px_rgba(55,40,72,.3)]" data-testid="metric-occupancy-rate">
            <p className="text-[9px] font-bold uppercase tracking-[.12em] text-[#806aa0]">Ocupação calculada</p>
            <p className="mt-2 font-[family-name:var(--app-font-serif)] text-2xl font-extrabold tabular-nums tracking-[-.05em] text-[#65479c]">{formatPercent(analytics.totals.percentage)}</p>
            <p className="mt-1 text-[10px] text-[#837b8b]">{analytics.totals.percentage == null ? 'Sem base de presenças e vagas' : `${formatCount(analytics.totals.presences)} de ${formatCount(analytics.totals.capacity)} presenças/vagas`}</p>
          </article>
        </section>
        {analytics.totals.legacyRecordCount > 0 && <p className="rounded-xl bg-[#f6f3f8] px-4 py-2.5 text-[10px] leading-4 text-[#716879]" role="status" data-testid="status-occupancy-legacy-count">{formatCount(analytics.totals.legacyRecordCount)} registro(s) legado(s) sem presenças/vagas permanecem fora do cálculo ponderado.</p>}
        <div className="grid gap-5 lg:grid-cols-[.9fr_1.1fr]">
          <section className="rounded-[22px] border border-[#e9e4eb] bg-[#fffefc] p-4 shadow-[0_14px_35px_-30px_rgba(55,40,72,.28)] sm:p-5" data-testid="card-occupancy-donut">
            <SectionHeading eyebrow="ocupação calculada" title="Ocupação e capacidade restante" detail={selectedModality?.name ?? 'Todas as modalidades'} />
            {analytics.donut ? <>
              <div className="mb-2 flex flex-wrap items-end justify-between gap-3 rounded-2xl bg-[#f8f5fb] px-4 py-3">
                <div><p className="text-[9px] font-bold uppercase tracking-[.12em] text-[#806aa0]">Taxa real</p><p className="mt-1 font-[family-name:var(--app-font-serif)] text-3xl font-extrabold tracking-[-.06em] text-[#65479c]" data-testid="text-occupancy-donut-real-rate">{formatPercent(analytics.donut.occupied)}</p></div>
                {analytics.donut.occupied > 100 && <p className="max-w-[230px] text-right text-[10px] font-semibold leading-4 text-[#765c31]" data-testid="text-occupancy-capacity-exceeded">{analytics.donut.presences != null && analytics.donut.capacity != null ? `Excedente: ${formatCount(analytics.donut.presences - analytics.donut.capacity)} presença(s) acima das vagas` : `Ocupação acima da capacidade em ${formatPercent(analytics.donut.occupied - 100)} p.p.`}</p>}
              </div>
              <div className="relative mx-auto h-[220px] max-w-[360px]" role="img" aria-label={`${selectedModality?.name ?? 'Todas as modalidades'}: ${formatPercent(analytics.donut.occupied)} de ocupação real e ${formatPercent(analytics.donut.unoccupied)} de complemento visual`}>
                <ChartContainer config={{ occupied: { label: 'Ocupada', color: palette.purple }, unoccupied: { label: 'Complemento', color: '#e6e0eb' } }} className="h-full w-full">
                  <PieChart>
                    <Pie data={donutData} dataKey="value" nameKey="name" innerRadius="65%" outerRadius="88%" paddingAngle={2} stroke="none">
                      {donutData.map((entry) => <Cell key={entry.name} fill={entry.fill} />)}
                    </Pie>
                  <Tooltip formatter={(value, name) => [String(name) === 'Ocupada' ? formatPercent(analytics.donut?.occupied) : formatPercent(Number(value)), String(name)]} />
                  </PieChart>
                </ChartContainer>
              </div>
              <div className="mt-1 flex flex-wrap justify-center gap-x-6 gap-y-2 text-xs">
                <span className="inline-flex items-center gap-2 text-[#62586d]"><i className="h-2.5 w-2.5 rounded-sm bg-[#7655a8]" />Ocupada <b>{formatPercent(analytics.donut.occupied)}</b></span>
                <span className="inline-flex items-center gap-2 text-[#62586d]"><i className="h-2.5 w-2.5 rounded-sm bg-[#e6e0eb]" />Complemento <b>{formatPercent(analytics.donut.unoccupied)}</b></span>
              </div>
              <p className="mt-3 text-center text-[10px] text-[#837b8b]" data-testid="text-occupancy-donut-source">
                {sourceLabel(analytics.donut.source)}
              </p>
              <CoverageNote covered={analytics.donut.coveredPeriods} available={analytics.donut.availablePeriods} />
            </> : <ChartEmpty title="Sem base para calcular" detail="A rosca exige contagens agregáveis ou uma única observação percentual numa modalidade e período definidos." />}
          </section>

          <section className="rounded-[22px] border border-[#e9e4eb] bg-[#fffefc] p-4 shadow-[0_14px_35px_-30px_rgba(55,40,72,.28)] sm:p-5" data-testid="card-occupancy-comparison">
            <SectionHeading eyebrow="mesmo período selecionado" title="Comparativo por modalidade" detail={comparisonMax > 100 ? `Escala até ${formatPercent(comparisonMax)}` : 'Escala de 0 a 100%'} />
            {comparisonData.length ? <ChartContainer role="img" aria-label={`Percentuais de ocupação comparados por modalidade, escala de zero a ${formatPercent(comparisonMax)}`} config={{ percentage: { label: 'Ocupação', color: palette.purple } }} className="h-[270px] w-full">
              <BarChart data={comparisonData} margin={{ top: 8, right: 10, bottom: 38, left: 0 }}>
                <CartesianGrid vertical={false} stroke="#eee9f1" />
                <XAxis dataKey="label" interval={0} angle={-20} textAnchor="end" height={62} tick={{ fill: palette.ink, fontSize: 10 }} tickLine={false} axisLine={false} />
                <YAxis type="number" domain={[0, comparisonMax]} ticks={percentAxisTicks(comparisonMax)} tickFormatter={(value) => `${value}%`} tick={{ fill: palette.muted, fontSize: 10 }} tickLine={false} axisLine={false} />
                <Tooltip formatter={(value) => value == null ? 'Sem dados' : formatPercent(Number(value))} labelStyle={{ color: palette.ink }} />
                <Bar dataKey="percentage" name="Ocupação" radius={[6, 6, 0, 0]} maxBarSize={34} fill={palette.purple} />
              </BarChart>
            </ChartContainer> : <ChartEmpty title="Sem comparação disponível" detail="Não há modalidades com percentuais registrados neste recorte." />}
            <p className="mt-1 text-[10px] leading-4 text-[#837b8b]" data-testid="text-comparison-coverage">Aulas com presenças e vagas são ponderadas pelos totais; percentuais legados permanecem separados. Períodos sem registro não contam como 0%.</p>
          </section>
        </div>

        <section className="grid gap-5 lg:grid-cols-2" aria-label="Ocupação por horário e dia da semana">
          <article className="rounded-[22px] border border-[#e9e4eb] bg-[#fffefc] p-4 shadow-[0_14px_35px_-30px_rgba(55,40,72,.28)] sm:p-5" data-testid="card-occupancy-by-hour">
            <SectionHeading eyebrow="horário inicial · ordem cronológica" title="Ocupação por horário" detail="Aulas diárias com horário registrado" />
            {analytics.byHour.length ? <>
              <ChartContainer role="img" aria-label="Ocupação calculada por horário inicial, em ordem cronológica" config={{ percentage: { label: 'Ocupação', color: palette.purple } }} className="h-[270px] w-full">
                <BarChart data={analytics.byHour} margin={{ top: 10, right: 12, bottom: 4, left: -18 }}>
                  <CartesianGrid vertical={false} stroke="#eee9f1" />
                  <XAxis dataKey="label" tick={{ fill: palette.ink, fontSize: 10 }} tickLine={false} axisLine={false} />
                  <YAxis type="number" domain={[0, hourMax]} ticks={percentAxisTicks(hourMax)} tickFormatter={(value) => `${value}%`} tick={{ fill: palette.muted, fontSize: 10 }} tickLine={false} axisLine={false} />
                  <Tooltip formatter={(value) => value == null ? 'Sem dados' : formatPercent(Number(value))} labelStyle={{ color: palette.ink }} />
                  <Bar dataKey="percentage" name="Ocupação" radius={[6, 6, 0, 0]} maxBarSize={38} fill={palette.purple} />
                </BarChart>
              </ChartContainer>
              <p className="mt-1 text-[10px] leading-4 text-[#837b8b]">Só entram aulas diárias com horário de início. Resumos mensais não são atribuídos a um horário; percentuais legados não se misturam às medições.</p>
            </> : <ChartEmpty title="Sem aulas com horário inicial" detail="Não há registros diários com horário no recorte atual." />}
          </article>

          <article className="rounded-[22px] border border-[#e9e4eb] bg-[#fffefc] p-4 shadow-[0_14px_35px_-30px_rgba(55,40,72,.28)] sm:p-5" data-testid="card-occupancy-by-weekday">
            <SectionHeading eyebrow="segunda a domingo" title="Ocupação por dia da semana" detail="Aulas diárias do recorte aplicado" />
            {analytics.byWeekday.length ? <>
              <ChartContainer role="img" aria-label="Ocupação calculada por dia da semana, de segunda a domingo" config={{ percentage: { label: 'Ocupação', color: palette.purple } }} className="h-[270px] w-full">
                <BarChart data={analytics.byWeekday} margin={{ top: 10, right: 12, bottom: 4, left: -18 }}>
                  <CartesianGrid vertical={false} stroke="#eee9f1" />
                  <XAxis dataKey="label" tick={{ fill: palette.ink, fontSize: 10 }} tickLine={false} axisLine={false} />
                  <YAxis type="number" domain={[0, weekdayMax]} ticks={percentAxisTicks(weekdayMax)} tickFormatter={(value) => `${value}%`} tick={{ fill: palette.muted, fontSize: 10 }} tickLine={false} axisLine={false} />
                  <Tooltip formatter={(value) => value == null ? 'Sem dados' : formatPercent(Number(value))} labelStyle={{ color: palette.ink }} />
                  <Bar dataKey="percentage" name="Ocupação" radius={[6, 6, 0, 0]} maxBarSize={38} fill={palette.purple} />
                </BarChart>
              </ChartContainer>
              <div className="mt-3 overflow-x-auto rounded-xl border border-[#eee9f1]" data-testid="table-occupancy-weekday-details">
                <table className="w-full min-w-[440px] text-left text-[10px]">
                  <thead className="bg-[#faf8fb] text-[9px] uppercase tracking-[.08em] text-[#837b8b]">
                    <tr><th className="px-3 py-2">Dia</th><th className="px-3 py-2 text-right">Aulas</th><th className="px-3 py-2 text-right">Presenças</th><th className="px-3 py-2 text-right">Vagas</th><th className="px-3 py-2 text-right">Ocupação</th></tr>
                  </thead>
                  <tbody className="divide-y divide-[#f0edf1]">
                    {analytics.byWeekday.map((group) => <tr key={group.key} data-testid={`row-occupancy-weekday-${group.key}`}>
                      <th scope="row" className="px-3 py-2 font-semibold text-[#51465f]">{group.label}</th>
                      <td className="px-3 py-2 text-right tabular-nums">{formatCount(group.recordCount)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatCount(group.presences)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatCount(group.capacity)}</td>
                      <td className="px-3 py-2 text-right font-bold tabular-nums">{formatPercent(group.percentage)}</td>
                    </tr>)}
                  </tbody>
                </table>
              </div>
              <p className="mt-1 text-[10px] leading-4 text-[#837b8b]">Dias sem registros não são convertidos em ocupação zero.</p>
            </> : <ChartEmpty title="Sem aulas diárias no recorte" detail="A comparação por dia da semana precisa de registros com data diária." />}
          </article>
        </section>

        <section className="rounded-[22px] border border-[#e9e4eb] bg-[#fffefc] p-4 shadow-[0_14px_35px_-30px_rgba(55,40,72,.28)] sm:p-5" data-testid="card-occupancy-evolution">
          <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
            <SectionHeading eyebrow="histórico do recorte" title="Evolução da ocupação" detail={selectedModality?.name ?? 'Todas as modalidades'} />
            <div className="flex w-fit rounded-full bg-[#f3f0f5] p-1" role="group" aria-label="Granularidade da evolução">
              <button type="button" aria-pressed={viewMode === 'daily'} onClick={() => setViewMode('daily')} className={`rounded-full px-4 py-2 text-xs font-bold transition ${viewMode === 'daily' ? 'bg-[#65479c] text-white shadow-sm' : 'text-[#716879] hover:bg-white'}`} data-testid="button-view-daily">Diária</button>
              <button type="button" aria-pressed={viewMode === 'monthly'} onClick={() => setViewMode('monthly')} className={`rounded-full px-4 py-2 text-xs font-bold transition ${viewMode === 'monthly' ? 'bg-[#65479c] text-white shadow-sm' : 'text-[#716879] hover:bg-white'}`} data-testid="button-view-monthly">Mensal</button>
              <button type="button" aria-pressed={viewMode === 'quarterly'} onClick={() => setViewMode('quarterly')} className={`rounded-full px-4 py-2 text-xs font-bold transition ${viewMode === 'quarterly' ? 'bg-[#65479c] text-white shadow-sm' : 'text-[#716879] hover:bg-white'}`} data-testid="button-view-quarterly">Trimestral</button>
            </div>
          </div>
          {evolutionData.some((point) => point.value !== null) ? <>
            <ChartContainer role="img" aria-label={`Evolução ${viewMode === 'daily' ? 'diária' : viewMode === 'monthly' ? 'mensal' : 'trimestral'} de ocupação para ${selectedModality?.name ?? 'todas as modalidades'}`} config={{ value: { label: 'Ocupação', color: palette.purple } }} className="h-[270px] w-full">
              <BarChart data={evolutionData} margin={{ top: 8, right: 12, bottom: 5, left: -18 }}>
                <CartesianGrid vertical={false} stroke="#eee9f1" />
                <XAxis dataKey="label" tick={{ fill: palette.muted, fontSize: 10 }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
                <YAxis type="number" domain={[0, evolutionMax]} ticks={percentAxisTicks(evolutionMax)} tickFormatter={(value) => `${value}%`} tick={{ fill: palette.muted, fontSize: 10 }} tickLine={false} axisLine={false} />
                <Tooltip formatter={(value) => value == null ? 'Sem dados' : formatPercent(Number(value))} labelStyle={{ color: palette.ink }} />
                <Bar dataKey="value" name="Ocupação" radius={[5, 5, 0, 0]} maxBarSize={34} fill={palette.purple} />
              </BarChart>
            </ChartContainer>
            <CoverageNote
              covered={analytics.evolution.filter((point) => point.percentage !== null).length}
              available={analytics.evolution.length}
            />
          </> : <ChartEmpty title="Sem dados de evolução" detail="Não há percentuais registrados para o período e os filtros selecionados." />}
        </section>

        <section className="overflow-hidden rounded-[22px] border border-[#e9e4eb] bg-[#fffefc] shadow-[0_14px_35px_-30px_rgba(55,40,72,.28)]" data-testid="card-occupancy-support-table">
          <div className="flex flex-wrap items-end justify-between gap-3 border-b border-[#eee9f1] px-4 py-4 sm:px-5">
            <div><p className="text-[9px] font-bold uppercase tracking-[.15em] text-[#8c73b4]">rastreabilidade</p><h2 className="mt-1 font-[family-name:var(--app-font-serif)] text-xl font-extrabold tracking-[-.045em] text-[#342d40]">Dados que compõem a leitura</h2></div>
            <p className="text-[10px] text-[#837b8b]" data-testid="text-support-row-count">{supportRows.length} {supportRows.length === 1 ? 'linha' : 'linhas'} · sem soma de percentuais</p>
          </div>
          {supportRows.length ? <div className="overflow-x-auto">
            <table className="w-full min-w-[1080px] border-collapse text-left text-xs">
              <thead><tr className="bg-[#faf8fb] text-[9px] font-bold uppercase tracking-[.1em] text-[#837b8b]">
                <th scope="col" className="px-5 py-3">Período</th><th scope="col" className="px-5 py-3">Modalidade</th><th scope="col" className="px-5 py-3">Turma</th><th scope="col" className="px-5 py-3">Horário</th><th scope="col" className="px-5 py-3 text-right">Presenças</th><th scope="col" className="px-5 py-3 text-right">Vagas</th><th scope="col" className="px-5 py-3 text-right">Aulas</th><th scope="col" className="px-5 py-3 text-right">Taxa usada</th><th scope="col" className="px-5 py-3">Base</th>
              </tr></thead>
              <tbody>{supportRows.map((row) => <tr key={row.key} className="border-t border-[#f0edf1] hover:bg-[#fcfafc]" data-testid={`row-occupancy-chart-${row.key}`}>
                <td className="whitespace-nowrap px-5 py-3 font-semibold capitalize text-[#4b4357]">{periodLabel(row.period, viewMode)}{viewMode === 'daily' && getWeekdayName(row.period) && <span className="ml-1 font-medium text-[#7656b8]">· {getWeekdayName(row.period)}</span>}</td>
                <td className="px-5 py-3 font-semibold text-[#4b4357]">{row.modalityName}</td>
                <td className="px-5 py-3 text-[#716879]">{row.className || '—'}</td>
                <td className="whitespace-nowrap px-5 py-3 tabular-nums text-[#716879]">{row.startTime ?? '—'}</td>
                <td className="px-5 py-3 text-right tabular-nums text-[#4b4357]">{formatCount(row.presences)}</td>
                <td className="px-5 py-3 text-right tabular-nums text-[#4b4357]">{formatCount(row.capacity)}</td>
                <td className="px-5 py-3 text-right tabular-nums text-[#4b4357]">{formatCount(row.recordCount)}</td>
                <td className="px-5 py-3 text-right font-extrabold tabular-nums text-[#65479c]">{formatPercent(row.percentage)}</td>
                <td className="px-5 py-3 text-[#716879]">{sourceLabel(row.source)}</td>
              </tr>)}</tbody>
            </table>
          </div> : <div className="px-5 py-8 text-center text-xs text-[#837b8b]">Sem linhas para o período selecionado.</div>}
          <div className="border-t border-[#eee9f1] px-4 py-3 sm:px-5">
            <p className="flex items-start gap-2 text-[10px] leading-5 text-[#837b8b]"><Clock3 size={13} className="mt-0.5 shrink-0 text-[#8c73b4]" />Aulas medidas são consolidadas pela soma das presenças dividida pela soma das vagas. Registros legados não entram nesse cálculo e períodos sem dados não são tratados como 0%.</p>
          </div>
        </section>
      </>}
    </section>
  );
}
