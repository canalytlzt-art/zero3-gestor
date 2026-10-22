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
import { buildFinancialChartAnalytics } from '@/lib/financial-chart-data';
import { buildOccupancyChartAnalytics, type OccupancyChartSupportRow } from '@/lib/occupancy-chart-data';
import { formatCents, formatMonthKey, getSaoPauloMonthKey, getSalesGoalComparison, isCompleteCalendarMonthRange, monthKeysBetween } from '@/lib/sales-utils';
import { Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

type PeriodMode = 'day' | 'range' | 'months';
type ViewMode = 'daily' | 'monthly';

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
  return mode === 'monthly' ? formatMonthKey(value) : formatDay(value);
}

function sourceLabel(source: OccupancyChartSupportRow['source']) {
  return source === 'reported' ? 'Percentual informado' : 'Média dos percentuais informados';
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

type FinancialPeriodMode = 'current' | 'single' | 'multiple' | 'range' | 'all';
type ShareBy = 'modality' | 'product';

const financeColors = ['#7655a8', '#a9d75a', '#4d8d7b', '#d18b57', '#8b789b', '#6c9cb5', '#c16e78', '#b3a46b'];

function FinancialCharts({ onOccupancy }: { onOccupancy: () => void }) {
  const currentMonth = getSaoPauloMonthKey();
  const [periodMode, setPeriodMode] = useState<FinancialPeriodMode>('current');
  const [singleMonth, setSingleMonth] = useState(currentMonth);
  const [months, setMonths] = useState<string[]>([currentMonth]);
  const [monthToAdd, setMonthToAdd] = useState(currentMonth);
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [productId, setProductId] = useState('');
  const [modalityId, setModalityId] = useState('');
  const [shareBy, setShareBy] = useState<ShareBy>('modality');

  const invalid = (periodMode === 'single' && !singleMonth)
    || (periodMode === 'multiple' && months.length === 0)
    || (periodMode === 'range' && (!fromDate || !toDate || fromDate > toDate));
  const params = useMemo<GetSalesScoreboardParams>(() => {
    const query: GetSalesScoreboardParams = {};
    if (periodMode === 'current') query.months = [currentMonth];
    if (periodMode === 'single' && singleMonth) query.months = [singleMonth];
    if (periodMode === 'multiple' && months.length) query.months = [...new Set(months)].sort();
    if (periodMode === 'range' && fromDate && toDate && fromDate <= toDate) {
      query.fromDate = fromDate;
      query.toDate = toDate;
    }
    if (productId) query.productId = productId;
    if (modalityId) query.modalityId = modalityId;
    return query;
  }, [periodMode, currentMonth, singleMonth, months, fromDate, toDate, productId, modalityId]);

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
    if (periodMode === 'range') return invalid || !isCompleteCalendarMonthRange(fromDate, toDate) ? [] : monthKeysBetween(fromDate.slice(0, 7), toDate.slice(0, 7));
    return allMonths;
  }, [periodMode, currentMonth, singleMonth, months, invalid, fromDate, toDate, allMonths]);
  const goalMode = periodMode === 'range'
    ? invalid ? 'invalid' : isCompleteCalendarMonthRange(fromDate, toDate) ? 'complete' : 'partial-range'
    : goalMonths.length ? 'complete' : 'invalid';
  const comparison = !productModalityConflict && (productId ? Boolean(selectedProduct) : !modalityId)
    ? getSalesGoalComparison(
      BigInt(report?.totals.netCents ?? 0),
      goalMonths,
      goalMode,
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
    setFromDate('');
    setToDate('');
    setProductId('');
    setModalityId('');
  };
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
              <option value="current">Mês atual</option><option value="single">Um mês</option><option value="multiple">Vários meses</option><option value="range">Intervalo de datas</option><option value="all">Todo o período</option>
            </select>
          </label>
          <div className="min-w-0">
            {periodMode === 'current' && <div className="pt-5 text-xs font-semibold capitalize text-[#5f5967]" data-testid="text-financial-current-month">{formatMonthKey(currentMonth)}</div>}
            {periodMode === 'single' && <label className={labelClass}>Mês<input type="month" className={fieldClass} value={singleMonth} onChange={(event) => setSingleMonth(event.target.value)} data-testid="input-financial-month" /></label>}
            {periodMode === 'multiple' && <div><label className={labelClass}>Adicionar mês</label><div className="flex gap-2"><input type="month" className={fieldClass} value={monthToAdd} onChange={(event) => setMonthToAdd(event.target.value)} data-testid="input-financial-month-add" /><button type="button" onClick={addMonth} className="mt-1.5 h-10 shrink-0 rounded-xl bg-[#ece6f4] px-3 text-xs font-bold text-[#65479c]" data-testid="button-financial-month-add">Adicionar</button></div><div className="mt-2 flex flex-wrap gap-1.5" data-testid="list-financial-months">{months.map((month) => <span key={month} className="rounded-full bg-[#f2edf6] px-2.5 py-1 text-[10px] font-bold capitalize text-[#65479c]" data-testid={`chip-financial-month-${month}`}>{formatMonthKey(month)} <button type="button" aria-label={`Remover ${formatMonthKey(month)}`} onClick={() => setMonths((items) => items.filter((item) => item !== month))} data-testid={`button-financial-month-remove-${month}`}>×</button></span>)}</div></div>}
            {periodMode === 'range' && <div className="grid grid-cols-2 gap-2"><label className={labelClass}>De<input type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} className={fieldClass} data-testid="input-financial-from" /></label><label className={labelClass}>Até<input type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} className={fieldClass} data-testid="input-financial-to" /></label></div>}
            {periodMode === 'all' && <div className="pt-5 text-xs text-[#716879]" data-testid="text-financial-all-time">Todo o histórico registrado</div>}
          </div>
          <label className={labelClass}>Produto
            <select value={productId} onChange={(event) => setProductId(event.target.value)} className={fieldClass} data-testid="select-financial-product"><option value="">Todos os produtos</option>{products.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
          </label>
          <label className={labelClass}>Modalidade
            <select value={modalityId} onChange={(event) => setModalityId(event.target.value)} className={fieldClass} data-testid="select-financial-modality"><option value="">Todas as modalidades</option>{modalities.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
          </label>
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          {invalid ? <p className="flex items-center gap-2 text-xs font-semibold text-[#a24f4d]" role="alert" data-testid="status-financial-invalid-filter"><CircleAlert size={14} />{periodMode === 'range' ? 'Informe um intervalo válido, com data inicial e final.' : 'Selecione ao menos um mês para consultar.'}</p> : productModalityConflict ? <p className="text-xs font-semibold text-[#765c31]" role="status" data-testid="status-financial-scope-conflict">O produto selecionado não está vinculado à modalidade escolhida. A combinação não tem vendas classificadas.</p> : <span className="text-[10px] text-[#837b8b]" data-testid="status-financial-filter-scope">Filtros aplicados diretamente ao Scoreboard oficial.</span>}
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
              <article className={chartBox} data-testid="chart-financial-monthly"><SectionHeading eyebrow="movimento no tempo" title="Vendas, estornos e líquido" detail="Colunas agrupadas · R$" />
                {analytics.months.length ? <ChartContainer role="img" aria-label="Vendas, estornos e líquido por mês, em reais" config={{ salesCents: { label: 'Vendas', color: '#7655a8' }, refundCents: { label: 'Estornos', color: '#d18b57' }, netCents: { label: 'Líquido', color: '#6f9d45' } }} className="h-[310px] w-full"><BarChart data={analytics.months} margin={{ top: 6, right: 8, bottom: 4, left: 6 }}><CartesianGrid vertical={false} stroke="#eee9f1" /><XAxis dataKey="month" tickFormatter={formatMonthKey} tick={{ fill: palette.muted, fontSize: 10 }} axisLine={false} tickLine={false} /><YAxis tickFormatter={(value) => money(Number(value))} tick={{ fill: palette.muted, fontSize: 10 }} axisLine={false} tickLine={false} /><Tooltip labelFormatter={(label) => formatMonthKey(String(label))} formatter={(value, name) => [money(Number(value)), String(name)]} /><Bar dataKey="salesCents" name="Vendas" fill="#7655a8" radius={[4, 4, 0, 0]} /><Bar dataKey="refundCents" name="Estornos" fill="#d18b57" radius={[4, 4, 0, 0]} /><Bar dataKey="netCents" name="Líquido" fill="#6f9d45" radius={[4, 4, 0, 0]} /></BarChart></ChartContainer> : <ChartEmpty title="Sem dados mensais" detail="O Scoreboard não retornou meses com movimentação neste recorte." />}
              </article>
              <article className={chartBox} data-testid="chart-financial-share">
                <div className="flex flex-wrap items-start justify-between gap-2"><SectionHeading eyebrow="composição das vendas" title="Participação no bruto" detail="Somente vendas acima de zero" /><div className="flex rounded-full bg-[#f3f0f5] p-1" role="group" aria-label="Agrupar participação por" data-testid="group-financial-share-mode"><button type="button" aria-pressed={shareBy === 'modality'} onClick={() => setShareBy('modality')} className={`rounded-full px-3 py-1.5 text-[10px] font-bold ${shareBy === 'modality' ? 'bg-[#65479c] text-white' : 'text-[#716879]'}`} data-testid="button-share-by-modality">Modalidade</button><button type="button" aria-pressed={shareBy === 'product'} onClick={() => setShareBy('product')} className={`rounded-full px-3 py-1.5 text-[10px] font-bold ${shareBy === 'product' ? 'bg-[#65479c] text-white' : 'text-[#716879]'}`} data-testid="button-share-by-product">Produto</button></div></div>
                {shareData.length ? <><div className="h-[220px] w-full"><ResponsiveContainer width="100%" height="100%"><PieChart><Pie data={shareData} dataKey="salesCents" nameKey="name" innerRadius="58%" outerRadius="82%" paddingAngle={2} stroke="none">{shareData.map((slice, index) => <Cell key={slice.key} fill={financeColors[index % financeColors.length]} />)}</Pie><Tooltip formatter={(value) => money(Number(value))} labelStyle={{ color: palette.ink }} /></PieChart></ResponsiveContainer></div><div className="flex flex-wrap gap-x-4 gap-y-2" data-testid="legend-financial-share">{shareData.map((slice, index) => <span key={slice.key} className="inline-flex items-center gap-1.5 text-[10px] text-[#62586d]" data-testid={`legend-financial-share-${slice.key}`}><i className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: financeColors[index % financeColors.length] }} />{slice.name}<b>{shareTotal ? ((slice.salesCents / shareTotal) * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) : '0'}%</b></span>)}</div></> : <ChartEmpty title="Sem vendas positivas" detail="A participação considera apenas valores de vendas brutas maiores que zero." />}
              </article>
            </section>
            <article className={chartBox} data-testid="chart-financial-quantity"><SectionHeading eyebrow="volume vendido" title="Unidades por produto" detail="Soma das quantidades registradas, não contagem de vendas" />
              {analytics.byProduct.length ? <ChartContainer role="img" aria-label="Quantidade total de unidades vendidas por produto" config={{ quantity: { label: 'Unidades', color: '#6f9d45' } }} className="h-[300px] w-full"><BarChart data={analytics.byProduct} layout="vertical" margin={{ top: 4, right: 12, bottom: 4, left: 8 }}><CartesianGrid horizontal={false} stroke="#eee9f1" /><XAxis type="number" tickFormatter={(value) => Number(value).toLocaleString('pt-BR')} tick={{ fill: palette.muted, fontSize: 10 }} axisLine={false} tickLine={false} /><YAxis type="category" dataKey="name" width={150} tick={{ fill: palette.ink, fontSize: 10 }} axisLine={false} tickLine={false} /><Tooltip formatter={(value) => [`${Number(value).toLocaleString('pt-BR')} unidades`, 'Quantidade']} labelStyle={{ color: palette.ink }} /><Bar dataKey="quantity" name="Unidades" fill="#6f9d45" radius={[0, 6, 6, 0]} maxBarSize={22} /></BarChart></ChartContainer> : <ChartEmpty title="Sem unidades neste recorte" detail="Não há quantidades registradas por produto." />}
            </article>
            {productModalityConflict ? <p className="rounded-xl bg-[#f6f3f8] px-4 py-3 text-xs text-[#716879]" data-testid="status-financial-goal-unavailable">Meta não comparada: o produto não pertence à modalidade selecionada.</p> : modalityId && !productId ? <p className="rounded-xl bg-[#f6f3f8] px-4 py-3 text-xs text-[#716879]" data-testid="status-financial-goal-unavailable">Meta não exibida: o recorte por modalidade não corresponde a uma meta mensal geral ou por produto.</p> : productId && !selectedProduct ? <p className="rounded-xl bg-[#f6f3f8] px-4 py-3 text-xs text-[#716879]" data-testid="status-financial-goal-unavailable">Meta não exibida: o produto selecionado não está disponível para comparação.</p> : comparison?.status === 'partial-range' ? <p className="rounded-xl bg-[#f6f3f8] px-4 py-3 text-xs text-[#716879]" data-testid="status-financial-goal-partial-range">Meta mensal não aplicada: o intervalo não cobre meses completos.</p> : comparison?.status === 'partial' ? <p className="rounded-xl bg-[#fbf4e7] px-4 py-3 text-xs text-[#765c31]" data-testid="status-financial-goal-partial">Cobertura parcial da meta: configurada para {comparison.configuredGoalCount} de {comparison.monthCount} meses. O combinado não é apresentado.</p> : comparison?.status === 'complete' ? <section className="flex flex-wrap items-center justify-between gap-4 rounded-[22px] border border-[#dfe8d3] bg-[#f5f9ef] px-5 py-4" data-testid="panel-financial-goal-comparison"><div><p className="text-[9px] font-bold uppercase tracking-[.12em] text-[#688646]">meta mensal · cobertura completa</p><p className="mt-1 text-lg font-extrabold text-[#3c4e2e]" data-testid="text-financial-goal-target">{formatCents(comparison.targetCents)} <span className="text-xs font-medium text-[#738064]">de meta</span></p></div><div className="text-right"><p className="text-xs font-semibold text-[#59694b]" data-testid="text-financial-goal-achievement">{(Number(comparison.achievementTenthsPercent) / 10).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}% atingido</p><p className="mt-1 text-[10px] text-[#738064]" data-testid="text-financial-goal-actual">Realizado líquido: {money(analytics.totals.netCents)}</p><p className="mt-1 text-[10px] font-semibold text-[#59694b]" data-testid="text-financial-goal-difference">{BigInt(analytics.totals.netCents) >= comparison.targetCents ? `Excedente: ${formatCents(BigInt(analytics.totals.netCents) - comparison.targetCents)}` : `Falta: ${formatCents(comparison.targetCents - BigInt(analytics.totals.netCents))}`}</p></div></section> : null}
          </>}
    </section>
  );
}

export default function OccupancyChartsPage() {
  const [activeTab, setActiveTab] = useState<'occupancy' | 'financial'>('occupancy');
  const [periodMode, setPeriodMode] = useState<PeriodMode>('months');
  const [day, setDay] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [months, setMonths] = useState<string[]>([getSaoPauloMonthKey()]);
  const [monthToAdd, setMonthToAdd] = useState(getSaoPauloMonthKey());
  const [modalityId, setModalityId] = useState('');
  const [className, setClassName] = useState('');
  const [viewMode, setViewMode] = useState<ViewMode>('daily');

  const filterProblem = periodMode === 'day' && !day
    ? 'Escolha o dia que deseja consultar.'
    : periodMode === 'range' && (!fromDate || !toDate)
      ? 'Informe a data inicial e final do intervalo.'
      : periodMode === 'range' && fromDate > toDate
        ? 'A data inicial deve ser anterior ou igual à data final.'
        : periodMode === 'months' && months.length === 0
          ? 'Selecione ao menos um mês.'
          : null;
  const filterInvalid = Boolean(filterProblem);

  const params = useMemo<GetOccupancyRecordsParams>(() => {
    const query: GetOccupancyRecordsParams = { kind: 'all' };
    if (periodMode === 'day' && day) {
      query.fromDate = day;
      query.toDate = day;
    } else if (periodMode === 'range' && fromDate && toDate && fromDate <= toDate) {
      query.fromDate = fromDate;
      query.toDate = toDate;
    } else if (periodMode === 'months' && months.length) {
      query.months = [...months].sort().join(',');
    }
    if (className.trim()) query.className = className.trim();
    return query;
  }, [periodMode, day, fromDate, toDate, months, className]);

  const modalitiesQuery = useGetOccupancyModalities({
    query: {
      queryKey: getGetOccupancyModalitiesQueryKey(),
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

  const analyticsFilters = useMemo(() => ({
    viewMode,
    ...(periodMode === 'months' ? { selectedMonths: months } : {}),
    ...(periodMode === 'day' && day ? { fromDate: day, toDate: day } : {}),
    ...(periodMode === 'range' && fromDate && toDate && fromDate <= toDate ? { fromDate, toDate } : {}),
    modalityId: modalityId || undefined,
  }), [viewMode, periodMode, months, day, fromDate, toDate, modalityId]);
  const analytics = useMemo(
    () => buildOccupancyChartAnalytics(filterInvalid ? [] : recordsQuery.data ?? [], analyticsFilters),
    [filterInvalid, recordsQuery.data, analyticsFilters],
  );

  const refresh = () => {
    void Promise.all([modalitiesQuery.refetch(), ...(filterInvalid ? [] : [recordsQuery.refetch()])]);
  };
  const isRefreshing = modalitiesQuery.isFetching || recordsQuery.isFetching;
  const selectedModality = modalities.find((item) => item.id === modalityId);
  const donutData = analytics.donut
    ? [
      { name: 'Ocupada', value: analytics.donut.occupied, fill: palette.purple },
      { name: 'Complemento', value: analytics.donut.unoccupied, fill: '#e6e0eb' },
    ]
    : [];
  const comparisonData = analytics.comparison.map((item) => ({
    ...item,
    label: item.modalityName,
  }));
  const evolutionData = analytics.evolution
    .map((point) => ({ ...point, label: periodLabel(point.period, viewMode), value: point.percentage }));
  const supportRows = analytics.supportRows;
  const anyError = modalitiesQuery.isError || recordsQuery.isError;
  const initialLoading = modalitiesQuery.isLoading || (!filterInvalid && recordsQuery.isLoading);
  const hasContent = analytics.supportRows.length > 0;

  const addMonth = () => {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(monthToAdd) || months.includes(monthToAdd)) return;
    setMonths((current) => [...current, monthToAdd].sort());
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
          <button type="button" onClick={refresh} disabled={isRefreshing} className="inline-flex h-9 items-center gap-2 rounded-full border border-[#e7e2ea] px-3 text-xs font-bold text-[#62586d] transition hover:bg-[#f7f3f9] disabled:cursor-wait disabled:opacity-60" data-testid="button-refresh-occupancy-charts">
            <RefreshCw size={13} className={isRefreshing ? 'animate-spin' : ''} /> Atualizar
          </button>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
          <div>
            <label className={labelClass} htmlFor="occupancy-period-mode">Período</label>
            <div className="relative">
              <select id="occupancy-period-mode" className={fieldClass} value={periodMode} onChange={(event) => setPeriodMode(event.target.value as PeriodMode)} data-testid="select-occupancy-period-mode">
                <option value="day">Um dia</option><option value="range">Intervalo</option><option value="months">Mês ou meses</option>
              </select><ChevronDown size={14} className="pointer-events-none absolute right-3 top-4 text-[#857a90]" />
            </div>
          </div>
          {periodMode === 'day' && <div>
            <label className={labelClass} htmlFor="occupancy-chart-day">Dia</label>
            <input id="occupancy-chart-day" type="date" className={fieldClass} value={day} onChange={(event) => setDay(event.target.value)} data-testid="input-occupancy-chart-day" />
          </div>}
          {periodMode === 'range' && <>
            <div><label className={labelClass} htmlFor="occupancy-chart-from">De</label><input id="occupancy-chart-from" type="date" className={fieldClass} value={fromDate} onChange={(event) => setFromDate(event.target.value)} data-testid="input-occupancy-chart-from" /></div>
            <div><label className={labelClass} htmlFor="occupancy-chart-to">Até</label><input id="occupancy-chart-to" type="date" className={fieldClass} value={toDate} onChange={(event) => setToDate(event.target.value)} data-testid="input-occupancy-chart-to" /></div>
          </>}
          {periodMode === 'months' && <div className="sm:col-span-2">
            <label className={labelClass} htmlFor="occupancy-chart-month">Meses selecionados</label>
            <div className="flex gap-2">
              <input id="occupancy-chart-month" type="month" className={fieldClass} value={monthToAdd} onChange={(event) => setMonthToAdd(event.target.value)} data-testid="input-occupancy-chart-month" />
              <button type="button" onClick={addMonth} disabled={!monthToAdd || months.includes(monthToAdd)} className="mt-1.5 h-10 shrink-0 rounded-xl bg-[#ece6f4] px-4 text-xs font-bold text-[#65479c] transition hover:bg-[#e4daef] disabled:cursor-not-allowed disabled:opacity-50" data-testid="button-add-occupancy-month">Adicionar</button>
            </div>
            <div className="mt-2 flex min-h-7 flex-wrap gap-1.5" data-testid="list-occupancy-chart-months">
              {months.map((month) => <span key={month} className="inline-flex items-center gap-2 rounded-full bg-[#f2edf6] px-3 py-1 text-[11px] font-bold capitalize text-[#65479c]" data-testid={`chip-occupancy-chart-month-${month}`}>
                {formatMonthKey(month)}<button type="button" aria-label={`Remover ${formatMonthKey(month)}`} onClick={() => setMonths((current) => current.filter((item) => item !== month))} className="text-[#8a73ad] hover:text-[#46335f]" data-testid={`button-remove-occupancy-month-${month}`}>×</button>
              </span>)}
              {months.length === 0 && <span className="py-1 text-xs text-[#908897]">Adicione ao menos um mês.</span>}
            </div>
          </div>}
          <div>
            <label className={labelClass} htmlFor="occupancy-chart-modality">Modalidade</label>
            <div className="relative">
              <select id="occupancy-chart-modality" className={fieldClass} value={modalityId} onChange={(event) => setModalityId(event.target.value)} data-testid="select-occupancy-chart-modality">
                <option value="">Selecione uma modalidade</option>{modalities.map((modality) => <option key={modality.id} value={modality.id}>{modality.name}</option>)}
              </select><ChevronDown size={14} className="pointer-events-none absolute right-3 top-4 text-[#857a90]" />
            </div>
          </div>
          <div>
            <label className={labelClass} htmlFor="occupancy-chart-class">Turma / horário <span className="font-medium normal-case tracking-normal">(opcional)</span></label>
            <input id="occupancy-chart-class" type="search" maxLength={120} className={fieldClass} placeholder="Todas as turmas" value={className} onChange={(event) => setClassName(event.target.value)} data-testid="input-occupancy-chart-class" />
          </div>
        </div>
        {filterProblem && <p className="mt-3 flex items-center gap-2 text-xs font-semibold text-[#a24f4d]" role="alert" data-testid="status-invalid-occupancy-filter"><CircleAlert size={14} />{filterProblem}</p>}
      </div>

      {initialLoading ? <div className="grid gap-5 lg:grid-cols-2" aria-label="Carregando gráficos de ocupação" data-testid="loading-occupancy-charts">
        {[0, 1, 2].map((item) => <div key={item} className="min-h-[310px] animate-pulse rounded-[22px] border border-[#e9e4eb] bg-[#fffefc] p-5"><div className="h-3 w-24 rounded bg-[#eee9f1]" /><div className="mt-4 h-5 w-40 rounded bg-[#eee9f1]" /><div className="mt-8 h-48 rounded-2xl bg-[#f5f2f6]" /></div>)}
      </div> : anyError ? <div className="rounded-[22px] border border-[#ecd5d4] bg-[#fff9f8] p-6" role="alert" data-testid="error-occupancy-charts">
        <div className="flex items-start gap-3"><CircleAlert size={18} className="mt-0.5 text-[#ad5955]" /><div><h2 className="text-sm font-extrabold text-[#673d3c]">Não foi possível montar os gráficos</h2>
          <p className="mt-1 text-xs leading-5 text-[#806462]">{formatError(recordsQuery.error ?? modalitiesQuery.error)}</p>
          <button type="button" onClick={refresh} className="mt-4 rounded-full bg-[#65479c] px-4 py-2 text-xs font-bold text-white hover:bg-[#583d89]" data-testid="button-retry-occupancy-charts">Tentar novamente</button>
        </div></div>
      </div> : filterInvalid ? null : !hasContent ? <div className="rounded-[22px] border border-dashed border-[#ded7e4] bg-[#fbf9fc] px-6 py-12 text-center" data-testid="empty-occupancy-records">
        <span className="mx-auto grid h-11 w-11 place-items-center rounded-full bg-[#ece6f4] text-[#7655a8]"><CalendarDays size={19} /></span>
        <h2 className="mt-4 text-base font-extrabold text-[#443d50]">Nenhum percentual neste recorte</h2>
        <p className="mx-auto mt-1 max-w-md text-xs leading-5 text-[#837b8b]">Ajuste o período ou a turma. Os gráficos exibem apenas percentuais persistidos, sem completar dias ou meses ausentes.</p>
      </div> : <>
        <div className="grid gap-5 lg:grid-cols-[.9fr_1.1fr]">
          <section className="rounded-[22px] border border-[#e9e4eb] bg-[#fffefc] p-4 shadow-[0_14px_35px_-30px_rgba(55,40,72,.28)] sm:p-5" data-testid="card-occupancy-donut">
            <SectionHeading eyebrow="ocupação escolhida" title="Ocupação e capacidade restante" detail={selectedModality?.name ?? 'Selecione uma modalidade'} />
            {analytics.donut ? <>
              <div className="relative mx-auto h-[220px] max-w-[360px]" role="img" aria-label={`${selectedModality?.name ?? 'Modalidade'}: ${formatPercent(analytics.donut.occupied)} ocupada e ${formatPercent(analytics.donut.unoccupied)} de complemento`}>
                <ChartContainer config={{ occupied: { label: 'Ocupada', color: palette.purple }, unoccupied: { label: 'Complemento', color: '#e6e0eb' } }} className="h-full w-full">
                  <PieChart>
                    <Pie data={donutData} dataKey="value" nameKey="name" innerRadius="65%" outerRadius="88%" paddingAngle={2} stroke="none">
                      {donutData.map((entry) => <Cell key={entry.name} fill={entry.fill} />)}
                    </Pie>
                    <Tooltip formatter={(value) => formatPercent(Number(value))} />
                  </PieChart>
                </ChartContainer>
              </div>
              <div className="mt-1 flex flex-wrap justify-center gap-x-6 gap-y-2 text-xs">
                <span className="inline-flex items-center gap-2 text-[#62586d]"><i className="h-2.5 w-2.5 rounded-sm bg-[#7655a8]" />Ocupada <b>{formatPercent(analytics.donut.occupied)}</b></span>
                <span className="inline-flex items-center gap-2 text-[#62586d]"><i className="h-2.5 w-2.5 rounded-sm bg-[#e6e0eb]" />Complemento <b>{formatPercent(analytics.donut.unoccupied)}</b></span>
              </div>
              <p className="mt-3 text-center text-[10px] text-[#837b8b]" data-testid="text-occupancy-donut-source">
                {sourceLabel(analytics.donut.source)}{analytics.donut.coveredPeriods > 1 ? ' · média simples dos períodos com dados' : ''}
              </p>
              <CoverageNote covered={analytics.donut.coveredPeriods} available={analytics.donut.availablePeriods} />
            </> : <ChartEmpty title="Escolha uma modalidade" detail="O anel representa uma única modalidade e o complemento até 100%." />}
          </section>

          <section className="rounded-[22px] border border-[#e9e4eb] bg-[#fffefc] p-4 shadow-[0_14px_35px_-30px_rgba(55,40,72,.28)] sm:p-5" data-testid="card-occupancy-comparison">
            <SectionHeading eyebrow="mesmo período selecionado" title="Comparativo por modalidade" detail="Escala fixa de 0 a 100%" />
            {comparisonData.length ? <ChartContainer role="img" aria-label="Percentuais de ocupação comparados por modalidade, escala de zero a cem por cento" config={{ percentage: { label: 'Ocupação', color: palette.purple } }} className="h-[270px] w-full">
              <BarChart data={comparisonData} margin={{ top: 8, right: 10, bottom: 38, left: 0 }}>
                <CartesianGrid vertical={false} stroke="#eee9f1" />
                <XAxis dataKey="label" interval={0} angle={-20} textAnchor="end" height={62} tick={{ fill: palette.ink, fontSize: 10 }} tickLine={false} axisLine={false} />
                <YAxis type="number" domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} tickFormatter={(value) => `${value}%`} tick={{ fill: palette.muted, fontSize: 10 }} tickLine={false} axisLine={false} />
                <Tooltip formatter={(value) => value == null ? 'Sem dados' : formatPercent(Number(value))} labelStyle={{ color: palette.ink }} />
                <Bar dataKey="percentage" name="Ocupação" radius={[6, 6, 0, 0]} maxBarSize={34} fill={palette.purple} />
              </BarChart>
            </ChartContainer> : <ChartEmpty title="Sem comparação disponível" detail="Não há modalidades com percentuais registrados neste recorte." />}
            <p className="mt-1 text-[10px] leading-4 text-[#837b8b]" data-testid="text-comparison-coverage">Os resultados são comparados por média simples dos percentuais com dados, sem ponderação por capacidade. Períodos sem registro não contam como 0%.</p>
          </section>
        </div>

        <section className="rounded-[22px] border border-[#e9e4eb] bg-[#fffefc] p-4 shadow-[0_14px_35px_-30px_rgba(55,40,72,.28)] sm:p-5" data-testid="card-occupancy-evolution">
          <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
            <SectionHeading eyebrow="histórico da modalidade" title="Evolução da ocupação" detail={selectedModality?.name ?? 'Selecione uma modalidade'} />
            <div className="flex w-fit rounded-full bg-[#f3f0f5] p-1" role="group" aria-label="Granularidade da evolução">
              <button type="button" aria-pressed={viewMode === 'daily'} onClick={() => setViewMode('daily')} className={`rounded-full px-4 py-2 text-xs font-bold transition ${viewMode === 'daily' ? 'bg-[#65479c] text-white shadow-sm' : 'text-[#716879] hover:bg-white'}`} data-testid="button-view-daily">Diária</button>
              <button type="button" aria-pressed={viewMode === 'monthly'} onClick={() => setViewMode('monthly')} className={`rounded-full px-4 py-2 text-xs font-bold transition ${viewMode === 'monthly' ? 'bg-[#65479c] text-white shadow-sm' : 'text-[#716879] hover:bg-white'}`} data-testid="button-view-monthly">Mensal</button>
            </div>
          </div>
          {evolutionData.some((point) => point.value !== null) && modalityId ? <>
            <ChartContainer role="img" aria-label={`Evolução ${viewMode === 'daily' ? 'diária' : 'mensal'} de ocupação para ${selectedModality?.name ?? 'modalidade selecionada'}`} config={{ value: { label: 'Ocupação', color: palette.purple } }} className="h-[270px] w-full">
              <BarChart data={evolutionData} margin={{ top: 8, right: 12, bottom: 5, left: -18 }}>
                <CartesianGrid vertical={false} stroke="#eee9f1" />
                <XAxis dataKey="label" tick={{ fill: palette.muted, fontSize: 10 }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
                <YAxis domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} tickFormatter={(value) => `${value}%`} tick={{ fill: palette.muted, fontSize: 10 }} tickLine={false} axisLine={false} />
                <Tooltip formatter={(value) => value == null ? 'Sem dados' : formatPercent(Number(value))} labelStyle={{ color: palette.ink }} />
                <Bar dataKey="value" name="Ocupação" radius={[5, 5, 0, 0]} maxBarSize={34} fill={palette.purple} />
              </BarChart>
            </ChartContainer>
            <CoverageNote covered={analytics.donut?.coveredPeriods ?? 0} available={analytics.donut?.availablePeriods ?? 0} />
          </> : <ChartEmpty title={modalityId ? 'Sem dados de evolução' : 'Selecione uma modalidade'} detail={modalityId ? 'Não há percentuais registrados para esta modalidade no recorte atual.' : 'A evolução acompanha somente a modalidade escolhida.'} />}
        </section>

        <section className="overflow-hidden rounded-[22px] border border-[#e9e4eb] bg-[#fffefc] shadow-[0_14px_35px_-30px_rgba(55,40,72,.28)]" data-testid="card-occupancy-support-table">
          <div className="flex flex-wrap items-end justify-between gap-3 border-b border-[#eee9f1] px-4 py-4 sm:px-5">
            <div><p className="text-[9px] font-bold uppercase tracking-[.15em] text-[#8c73b4]">rastreabilidade</p><h2 className="mt-1 font-[family-name:var(--app-font-serif)] text-xl font-extrabold tracking-[-.045em] text-[#342d40]">Dados que compõem a leitura</h2></div>
            <p className="text-[10px] text-[#837b8b]" data-testid="text-support-row-count">{supportRows.length} {supportRows.length === 1 ? 'linha' : 'linhas'} · sem soma de percentuais</p>
          </div>
          {supportRows.length ? <div className="overflow-x-auto">
            <table className="w-full min-w-[700px] border-collapse text-left text-xs">
              <thead><tr className="bg-[#faf8fb] text-[9px] font-bold uppercase tracking-[.1em] text-[#837b8b]">
                <th scope="col" className="px-5 py-3">Período</th><th scope="col" className="px-5 py-3">Modalidade</th><th scope="col" className="px-5 py-3">Turma / horário</th><th scope="col" className="px-5 py-3 text-right">Percentual</th><th scope="col" className="px-5 py-3">Fonte</th>
              </tr></thead>
              <tbody>{supportRows.map((row) => <tr key={row.key} className="border-t border-[#f0edf1] hover:bg-[#fcfafc]" data-testid={`row-occupancy-chart-${row.key}`}>
                <td className="whitespace-nowrap px-5 py-3 font-semibold capitalize text-[#4b4357]">{periodLabel(row.period, viewMode)}</td>
                <td className="px-5 py-3 font-semibold text-[#4b4357]">{row.modalityName}</td>
                <td className="px-5 py-3 text-[#716879]">{row.className || 'Sem turma/horário'}</td>
                <td className="px-5 py-3 text-right font-extrabold tabular-nums text-[#65479c]">{formatPercent(row.percentage)}</td>
                <td className="px-5 py-3 text-[#716879]">{sourceLabel(row.source)}</td>
              </tr>)}</tbody>
            </table>
          </div> : <div className="px-5 py-8 text-center text-xs text-[#837b8b]">Sem linhas para o período selecionado.</div>}
          <div className="border-t border-[#eee9f1] px-4 py-3 sm:px-5">
            <p className="flex items-start gap-2 text-[10px] leading-5 text-[#837b8b]"><Clock3 size={13} className="mt-0.5 shrink-0 text-[#8c73b4]" />Percentuais repetidos no período são consolidados por média aritmética simples. Períodos sem dados não são interpolados nem tratados como 0%.</p>
          </div>
        </section>
      </>}
    </section>
  );
}
