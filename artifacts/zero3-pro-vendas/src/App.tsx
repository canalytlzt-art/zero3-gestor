import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ClerkProvider, Show, SignIn, SignUp, useClerk, useUser } from '@clerk/react';
import { publishableKeyFromHost } from '@clerk/react/internal';
import { ptBR } from '@clerk/localizations';
import { shadcn } from '@clerk/themes';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { ArrowDownRight, ArrowRight, BarChart3, CalendarDays, Check, CircleHelp, ClipboardList, LockKeyhole, LogOut, RefreshCw, Sparkles } from 'lucide-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { getGetAccessStatusQueryKey, getGetSalesGoalsQueryKey, getGetSalesQueryKey, useGetAccessStatus, useGetSales, useGetSalesGoals } from '@workspace/api-client-react';
import type { Sale } from '@workspace/api-client-react';
import NotFound from '@/pages/not-found';
import { Link, Redirect, Route, Switch, useLocation, Router as WouterRouter } from 'wouter';
import SalesManagement from '@/components/sales-management';
import ScoreboardGoals from '@/components/scoreboard-goals';
import { formatCents, formatMonthKey, getSaoPauloMonthKey, isCompleteCalendarMonthRange, monthKeysBetween, normalizeProductName, productNameKey } from '@/lib/sales-utils';

const queryClient = new QueryClient();
const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');
const clerkPubKey = publishableKeyFromHost(window.location.hostname, import.meta.env.VITE_CLERK_PUBLISHABLE_KEY);
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;

function stripBase(path: string) {
  return basePath && path.startsWith(basePath) ? path.slice(basePath.length) || '/' : path;
}

const clerkAppearance = {
  theme: shadcn,
  cssLayerName: 'clerk',
  options: {
    logoPlacement: 'inside' as const,
    logoLinkUrl: basePath || '/',
    logoImageUrl: `${window.location.origin}${basePath}/logo.svg`,
  },
  variables: {
    colorPrimary: '#7656B8',
    colorForeground: '#28243A',
    colorMutedForeground: '#716D7D',
    colorDanger: '#BC4141',
    colorBackground: '#FFFEFC',
    colorInput: '#FBFAF8',
    colorInputForeground: '#28243A',
    colorNeutral: '#E4E0E9',
    fontFamily: "'DM Sans', sans-serif",
    borderRadius: '14px',
  },
  elements: {
    rootBox: 'w-full flex justify-center',
    cardBox: 'bg-[#fffefc] rounded-[24px] w-[440px] max-w-full overflow-hidden shadow-[0_22px_70px_rgba(54,43,76,.12)]',
    card: '!shadow-none !border-0 !bg-transparent !rounded-none',
    footer: '!shadow-none !border-0 !bg-transparent !rounded-none',
    headerTitle: 'text-[#28243a] font-bold tracking-[-0.04em]',
    headerSubtitle: 'text-[#716d7d]',
    socialButtonsBlockButtonText: 'text-[#28243a] font-semibold',
    formFieldLabel: 'text-[#3e394d] font-semibold',
    footerActionLink: 'text-[#6846a9] font-semibold',
    footerActionText: 'text-[#716d7d]',
    dividerText: 'text-[#716d7d]',
    identityPreviewEditButton: 'text-[#6846a9]',
    formFieldSuccessText: 'text-[#4f7b2a]',
    alertText: 'text-[#7f3030]',
    logoBox: 'mb-1',
    logoImage: 'max-h-10',
    socialButtonsBlockButton: 'border-[#e6e1eb] hover:bg-[#f7f4fb]',
    formButtonPrimary: 'bg-[#7656b8] hover:bg-[#6545a6] text-white font-semibold',
    formFieldInput: 'bg-[#fbfaf8] border-[#e4e0e9] text-[#28243a]',
    footerAction: 'mt-5',
    dividerLine: 'bg-[#e8e4ec]',
    alert: 'bg-[#fff3f1] border-[#f1d0ca]',
    otpCodeFieldInput: 'bg-[#fbfaf8] border-[#e4e0e9] text-[#28243a]',
    formFieldRow: 'mb-4',
    main: 'px-8 py-7',
  },
};

function Brand() {
  return (
    <Link href="/" className="wordmark inline-flex items-baseline gap-2 text-[25px] font-extrabold text-[#29253b] no-underline" data-testid="link-brand-home">
      Zero3 <span className="text-[#7656b8]">PRO</span>
      <span className="ml-1 inline-block h-2 w-2 rounded-full bg-[#a8d755]" aria-hidden="true" />
    </Link>
  );
}

function Landing() {
  return (
    <main className="min-h-[100dvh] overflow-hidden bg-[#f7f5f1] text-[#29253b]">
      <header className="mx-auto flex max-w-[1240px] items-center justify-between px-6 py-6 md:px-10">
        <Brand />
        <Link href="/sign-in" className="rounded-full border border-[#e1dce7] px-5 py-2.5 text-sm font-semibold text-[#514a61] transition hover:bg-white" data-testid="link-sign-in">
          Entrar
        </Link>
      </header>

      <section className="relative mx-auto grid max-w-[1240px] items-center gap-12 px-6 pb-20 pt-12 md:grid-cols-[1.05fr_.95fr] md:px-10 md:pb-28 md:pt-20">
        <div className="page-enter relative z-10">
          <div className="eyebrow mb-7 inline-flex items-center gap-2 rounded-full border border-[#e4dfeb] bg-white/70 px-3.5 py-2 text-[10px] font-bold text-[#716a80]">
            <span className="h-1.5 w-1.5 rounded-full bg-[#9dcf4a]" /> ferramenta privada da equipe
          </div>
          <h1 className="max-w-[690px] font-[family-name:var(--app-font-serif)] text-[clamp(3.2rem,7.1vw,6.8rem)] font-extrabold leading-[.97] tracking-[-.075em]">
            Venda boa é venda <span className="relative z-0 whitespace-nowrap text-[#7656b8]">registrada<span className="absolute -bottom-1 left-0 -z-10 h-[18%] w-full rounded-sm bg-[#c9eb8c]" /></span>.
          </h1>
          <p className="mt-8 max-w-[470px] text-[17px] leading-8 text-[#6d6878]">
            Um lugar direto ao ponto para acompanhar o ritmo das vendas do time. Sem ruído, sem planilha perdida.
          </p>
          <div className="mt-9 flex flex-wrap items-center gap-3">
            <Link href="/sign-up" className="inline-flex items-center gap-3 rounded-full bg-[#7656b8] px-6 py-3.5 text-sm font-bold text-white shadow-[0_8px_20px_rgba(91,62,145,.18)] transition hover:-translate-y-0.5 hover:bg-[#6848a9]" data-testid="link-create-account">
              Acessar o Zero3 PRO <ArrowRight size={16} />
            </Link>
            <span className="inline-flex items-center gap-2 px-2 text-xs font-medium text-[#777282]"><LockKeyhole size={14} /> Acesso somente para convidados</span>
          </div>
        </div>

        <div className="page-enter relative mx-auto w-full max-w-[500px] md:justify-self-end" style={{ animationDelay: '100ms' }}>
          <div className="absolute -right-12 -top-10 h-52 w-52 rounded-full bg-[#d9efb7] opacity-75 blur-[1px]" />
          <div className="absolute -bottom-12 -left-9 h-40 w-40 rounded-full bg-[#e6ddf5]" />
          <div className="relative rotate-[1.5deg] rounded-[28px] border border-white/80 bg-[#fcfbf9] p-5 shadow-[0_32px_85px_rgba(46,37,64,.13)] md:p-7">
            <div className="flex items-center justify-between border-b border-[#eeebf0] pb-5">
              <div><p className="eyebrow text-[9px] font-bold text-[#8b8596]">visão do time</p><p className="mt-1 font-bold tracking-tight">Um dia de cada vez.</p></div>
              <div className="grid h-10 w-10 place-items-center rounded-2xl bg-[#eee8f7] text-[#7656b8]"><BarChart3 size={19} /></div>
            </div>
            <div className="mt-6 rounded-[20px] bg-[#eee9f6] p-5">
              <div className="flex items-start justify-between">
                <div><span className="text-xs font-semibold text-[#716a80]">Vendas registradas</span><p className="mt-3 font-[family-name:var(--app-font-serif)] text-5xl font-extrabold tracking-[-.07em] text-[#342a49]">—</p></div>
                <span className="rounded-full bg-white px-3 py-1.5 text-[10px] font-bold text-[#766d83]">comece por aqui</span>
              </div>
              <div className="mt-6 flex h-[62px] items-end gap-2">
                {[27, 43, 34, 61, 48, 78, 55, 92, 69, 100, 63, 82].map((height, index) => <span key={index} className={`flex-1 rounded-t-md ${index === 9 ? 'bg-[#9ac94b]' : 'bg-[#b8a8d5]'}`} style={{ height: `${height}%` }} />)}
              </div>
              <div className="mt-2 flex justify-between text-[9px] font-semibold text-[#938ba0]"><span>SEG</span><span>TER</span><span>QUA</span><span>QUI</span><span>SEX</span></div>
            </div>
            <div className="mt-4 flex items-center gap-3 rounded-[17px] border border-[#efedf0] bg-white p-4">
              <span className="grid h-9 w-9 place-items-center rounded-xl bg-[#eff6e5] text-[#6e9d31]"><Check size={17} /></span>
              <div><p className="text-xs font-bold">Rotina mais clara</p><p className="mt-1 text-[10px] text-[#8b8594]">Tudo da equipe em um só lugar</p></div>
              <ArrowDownRight className="ml-auto text-[#aaa3b4]" size={17} />
            </div>
          </div>
          <div className="absolute -right-3 top-[46%] grid h-12 w-12 place-items-center rounded-2xl bg-[#a8d755] text-[#33451b] shadow-lg shadow-[#8cbe47]/20"><Sparkles size={19} /></div>
        </div>
      </section>

      <section className="border-y border-[#e9e5e9] bg-[#f0edf3]">
        <div className="mx-auto flex max-w-[1240px] flex-col gap-6 px-6 py-8 md:flex-row md:items-center md:justify-between md:px-10">
          <div className="eyebrow text-[10px] font-bold text-[#827b8e]">feito para o dia a dia</div>
          <p className="max-w-[720px] text-[18px] leading-7 tracking-[-.025em] text-[#554e63] md:text-right">Menos tempo organizando números. Mais atenção ao que move a equipe.</p>
        </div>
      </section>
      <footer className="mx-auto flex max-w-[1240px] items-center justify-between px-6 py-8 text-xs text-[#8b8594] md:px-10">
        <Brand />
        <span>Seu espaço de vendas, com acesso privado.</span>
      </footer>
    </main>
  );
}

function ScoreboardContent() {
  const { data: sales, isLoading, isFetching, isError, refetch } = useGetSales({
    query: { queryKey: getGetSalesQueryKey(), refetchOnMount: 'always' },
  });
  const {
    data: salesGoals,
    isLoading: isGoalsLoading,
    isFetching: isGoalsFetching,
    isError: isGoalsError,
    refetch: refetchSalesGoals,
  } = useGetSalesGoals({
    query: { queryKey: getGetSalesGoalsQueryKey(), refetchOnMount: 'always' },
  });
  const currentMonthKey = getSaoPauloMonthKey();
  const [periodMode, setPeriodMode] = useState<'current' | 'single' | 'multiple' | 'range' | 'all'>('current');
  const [selectedMonth, setSelectedMonth] = useState(currentMonthKey);
  const [selectedMonths, setSelectedMonths] = useState<string[]>([currentMonthKey]);
  const [monthToAdd, setMonthToAdd] = useState(currentMonthKey);
  const [filterProduct, setFilterProduct] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const allMonthKeys = useMemo(() => {
    const monthKeys = (sales ?? []).map((sale) => sale.saleDate.slice(0, 7));
    monthKeys.push(currentMonthKey);
    monthKeys.sort();
    return monthKeysBetween(monthKeys[0], monthKeys[monthKeys.length - 1]);
  }, [sales, currentMonthKey]);
  const invalidRange = periodMode === 'range' && (!dateFrom || !dateTo || dateFrom > dateTo);
  const periodMonthKeys = useMemo(() => {
    switch (periodMode) {
      case 'current':
        return [currentMonthKey];
      case 'single':
        return selectedMonth ? [selectedMonth] : [];
      case 'multiple':
        return [...new Set(selectedMonths)].sort();
      case 'range':
        return invalidRange ? [] : monthKeysBetween(dateFrom.slice(0, 7), dateTo.slice(0, 7));
      case 'all':
        return allMonthKeys;
    }
  }, [periodMode, currentMonthKey, selectedMonth, selectedMonths, invalidRange, dateFrom, dateTo, allMonthKeys]);
  const goalComparisonMode = periodMode === 'range'
    ? invalidRange
      ? 'invalid'
      : isCompleteCalendarMonthRange(dateFrom, dateTo)
        ? 'complete'
        : 'partial-range'
    : periodMonthKeys.length > 0
      ? 'complete'
      : 'invalid';
  const selectedMonthSet = useMemo(() => new Set(periodMonthKeys), [periodMonthKeys]);
  const products = useMemo(() => {
    const names = new Map<string, string>();
    for (const sale of sales ?? []) {
      const name = normalizeProductName(sale.productName);
      const key = productNameKey(name);
      if (name && !names.has(key)) names.set(key, name);
    }
    return [...names.entries()]
      .map(([key, name]) => ({ key, name }))
      .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' }));
  }, [sales]);
  const filteredSales = useMemo(() => (sales ?? []).filter((sale) => {
    const monthKey = sale.saleDate.slice(0, 7);
    const periodMatches = periodMode === 'all'
      || (periodMode === 'range'
        ? !invalidRange && sale.saleDate >= dateFrom && sale.saleDate <= dateTo
        : selectedMonthSet.has(monthKey));
    const productMatches = !filterProduct || productNameKey(sale.productName) === filterProduct;
    return periodMatches && productMatches;
  }), [sales, periodMode, invalidRange, dateFrom, dateTo, selectedMonthSet, filterProduct]);
  const report = useMemo(() => {
    const productGroups = new Map<string, { name: string; quantity: bigint; revenueCents: bigint }>();
    const monthGroups = new Map<string, { quantity: bigint; revenueCents: bigint }>();
    let revenueCents = 0n;
    let quantity = 0n;

    for (const sale of filteredSales) {
      const amount = BigInt(sale.totalCents);
      const normalizedName = normalizeProductName(sale.productName);
      const productKey = productNameKey(normalizedName);
      const product = productGroups.get(productKey) ?? { name: normalizedName, quantity: 0n, revenueCents: 0n };
      product.quantity += BigInt(sale.quantity);
      product.revenueCents += amount;
      productGroups.set(productKey, product);

      const month = sale.saleDate.slice(0, 7);
      const monthly = monthGroups.get(month) ?? { quantity: 0n, revenueCents: 0n };
      monthly.quantity += BigInt(sale.quantity);
      monthly.revenueCents += amount;
      monthGroups.set(month, monthly);

      quantity += BigInt(sale.quantity);
      revenueCents += amount;
    }

    return {
      quantity,
      revenueCents,
      products: [...productGroups.values()].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' })),
      months: periodMonthKeys.map((month) => [
        month,
        monthGroups.get(month) ?? { quantity: 0n, revenueCents: 0n },
      ] as const),
    };
  }, [filteredSales, periodMonthKeys]);
  const invalidMonthSelection = periodMode === 'single' && !selectedMonth;
  const selectedProductName = filterProduct
    ? products.find((product) => product.key === filterProduct)?.name ?? filterProduct
    : null;
  const isRefreshing = isFetching || isGoalsFetching;
  const refreshScoreboard = () => {
    void Promise.all([refetch(), refetchSalesGoals()]);
  };
  const changePeriodMode = (mode: 'current' | 'single' | 'multiple' | 'range' | 'all') => {
    setPeriodMode(mode);
    if (mode === 'range') {
      setSelectedMonth('');
      setSelectedMonths([]);
    } else {
      setDateFrom('');
      setDateTo('');
      if (mode === 'single' && !selectedMonth) setSelectedMonth(currentMonthKey);
      if (mode === 'multiple' && selectedMonths.length === 0) setSelectedMonths([currentMonthKey]);
    }
    if (mode === 'multiple') setMonthToAdd(currentMonthKey);
  };
  const addSelectedMonth = () => {
    if (!monthToAdd || monthKeysBetween(monthToAdd, monthToAdd).length === 0) return;
    setSelectedMonths((months) => [...new Set([...months, monthToAdd])].sort());
  };
  const clearFilters = () => {
    setPeriodMode('all');
    setSelectedMonth(currentMonthKey);
    setSelectedMonths([currentMonthKey]);
    setMonthToAdd(currentMonthKey);
    setDateFrom('');
    setDateTo('');
    setFilterProduct('');
  };

  if (isLoading) return <div className="space-y-4"><div className="skeleton h-44 rounded-[26px]" /><div className="skeleton h-52 rounded-[26px]" /></div>;
  if (isError) return <div className="grid min-h-[360px] place-items-center rounded-[26px] border border-dashed border-[#ded8e5] bg-white p-6 text-center" data-testid="status-scoreboard-error"><div><CircleHelp className="mx-auto text-[#ad6254]" size={25} /><p className="mt-4 font-bold">O relatório não carregou</p><p className="mt-1 text-sm text-[#827b8b]">Não foi possível consultar as vendas persistidas. Tente atualizar a base.</p><button onClick={refreshScoreboard} className="mt-4 inline-flex items-center gap-2 rounded-full bg-[#7656b8] px-4 py-2.5 text-xs font-bold text-white" data-testid="button-refresh-scoreboard-error"><RefreshCw size={13} /> Atualizar</button></div></div>;

  return (
    <div className="space-y-5" data-testid="report-scoreboard">
      <section className="rounded-[24px] border border-[#e7e1e9] bg-[#fffefc] p-4 shadow-[0_8px_28px_rgba(47,39,62,.035)] sm:p-6" aria-label="Filtros do relatório">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="eyebrow text-[9px] font-bold text-[#8a8491]">relatório de vendas</p>
            <h2 className="mt-1 text-lg font-extrabold tracking-[-.04em] text-[#332d40]">Resultado consolidado</h2>
            <p className="mt-1 text-xs text-[#827b8b]">Valores calculados a partir dos lançamentos persistidos.</p>
          </div>
          <button
            type="button"
            onClick={refreshScoreboard}
            disabled={isRefreshing}
            aria-busy={isRefreshing}
            className="inline-flex h-10 items-center justify-center gap-2 self-start rounded-xl border border-[#ded7e7] bg-white px-4 text-xs font-bold text-[#5d4a78] transition hover:bg-[#f7f4fa] disabled:cursor-wait disabled:opacity-65 lg:self-auto"
            data-testid="button-refresh-scoreboard"
          >
            <RefreshCw size={14} className={isRefreshing ? 'animate-spin' : ''} />
            {isRefreshing ? 'Atualizando…' : 'Atualizar'}
          </button>
        </div>
        <div className="mt-5 grid gap-3 border-t border-[#efebf0] pt-4 sm:grid-cols-2 xl:grid-cols-[minmax(170px,.8fr)_minmax(260px,1.5fr)_minmax(200px,1fr)_auto] xl:items-end">
          <label className="block text-[10px] font-bold uppercase tracking-[.1em] text-[#817b89]">Período
            <select value={periodMode} onChange={(event) => changePeriodMode(event.target.value as typeof periodMode)} data-testid="select-scoreboard-period-mode" className="mt-1.5 h-10 w-full rounded-lg border border-[#e7e2ea] bg-[#fffefc] px-3 text-xs font-medium normal-case tracking-normal text-[#443d50] outline-none focus:border-[#9477bf]">
              <option value="current">Mês atual</option>
              <option value="single">Mês específico</option>
              <option value="multiple">Vários meses</option>
              <option value="range">Intervalo personalizado</option>
              <option value="all">Todos os meses</option>
            </select>
          </label>

          <div className="min-w-0" data-testid="controls-scoreboard-period">
            {periodMode === 'current' && (
              <div className="flex h-10 items-center rounded-lg border border-[#e7e2ea] bg-[#f8f6f9] px-3 text-xs font-semibold text-[#5f5967]" data-testid="text-scoreboard-current-month">
                {formatMonthKey(currentMonthKey)}
              </div>
            )}
            {periodMode === 'single' && (
              <label className="block text-[10px] font-bold uppercase tracking-[.1em] text-[#817b89]">Mês específico
                <input type="month" value={selectedMonth} onChange={(event) => setSelectedMonth(event.target.value)} data-testid="input-scoreboard-month" className="mt-1.5 h-10 w-full rounded-lg border border-[#e7e2ea] bg-[#fffefc] px-3 text-xs font-medium normal-case tracking-normal text-[#443d50] outline-none focus:border-[#9477bf]" />
              </label>
            )}
            {periodMode === 'multiple' && (
              <div className="space-y-2">
                <div className="flex items-end gap-2">
                  <label className="block min-w-0 flex-1 text-[10px] font-bold uppercase tracking-[.1em] text-[#817b89]">Adicionar mês
                    <input type="month" value={monthToAdd} onChange={(event) => setMonthToAdd(event.target.value)} data-testid="input-scoreboard-month-to-add" className="mt-1.5 h-10 w-full rounded-lg border border-[#e7e2ea] bg-[#fffefc] px-3 text-xs font-medium normal-case tracking-normal text-[#443d50] outline-none focus:border-[#9477bf]" />
                  </label>
                  <button type="button" onClick={addSelectedMonth} disabled={!monthToAdd || selectedMonths.includes(monthToAdd)} className="h-10 shrink-0 rounded-lg bg-[#7656b8] px-3 text-xs font-bold text-white transition hover:bg-[#6748a7] disabled:cursor-not-allowed disabled:opacity-50" data-testid="button-add-scoreboard-month">Adicionar</button>
                </div>
                <div className="flex min-h-7 flex-wrap gap-1.5" aria-label="Meses selecionados" data-testid="list-scoreboard-selected-months">
                  {selectedMonths.map((month) => (
                    <span key={month} className="inline-flex items-center gap-1 rounded-full bg-[#eee8f7] py-1 pl-2.5 pr-1 text-[10px] font-semibold text-[#5d4a78]" data-testid={`chip-scoreboard-month-${month}`}>
                      {formatMonthKey(month)}
                      <button type="button" onClick={() => setSelectedMonths((months) => months.filter((item) => item !== month))} aria-label={`Remover ${formatMonthKey(month)}`} className="grid h-5 w-5 place-items-center rounded-full text-[#7656b8] hover:bg-white" data-testid={`button-remove-scoreboard-month-${month}`}>×</button>
                    </span>
                  ))}
                  {selectedMonths.length === 0 && <span className="self-center text-[10px] text-[#8a8491]">Selecione ao menos um mês.</span>}
                </div>
              </div>
            )}
            {periodMode === 'range' && (
              <div className="grid grid-cols-2 gap-2">
                <label className="block text-[10px] font-bold uppercase tracking-[.1em] text-[#817b89]">Data inicial
                  <input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} data-testid="filter-scoreboard-date-from" className="mt-1.5 h-10 w-full rounded-lg border border-[#e7e2ea] bg-[#fffefc] px-2 text-xs font-medium normal-case tracking-normal text-[#443d50] outline-none focus:border-[#9477bf]" />
                </label>
                <label className="block text-[10px] font-bold uppercase tracking-[.1em] text-[#817b89]">Data final
                  <input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} data-testid="filter-scoreboard-date-to" className="mt-1.5 h-10 w-full rounded-lg border border-[#e7e2ea] bg-[#fffefc] px-2 text-xs font-medium normal-case tracking-normal text-[#443d50] outline-none focus:border-[#9477bf]" />
                </label>
              </div>
            )}
            {periodMode === 'all' && (
              <div className="flex h-10 items-center rounded-lg border border-[#e7e2ea] bg-[#f8f6f9] px-3 text-[10px] font-medium text-[#6d6676]" data-testid="text-scoreboard-all-months">
                {allMonthKeys.length ? `${formatMonthKey(allMonthKeys[0])} a ${formatMonthKey(allMonthKeys[allMonthKeys.length - 1])}` : 'Todos os meses'}
              </div>
            )}
          </div>

          <label className="block text-[10px] font-bold uppercase tracking-[.1em] text-[#817b89]">Plano ou produto
            <select value={filterProduct} onChange={(event) => setFilterProduct(event.target.value)} data-testid="filter-scoreboard-product" className="mt-1.5 h-10 w-full rounded-lg border border-[#e7e2ea] bg-[#fffefc] px-3 text-xs font-medium normal-case tracking-normal text-[#443d50] outline-none focus:border-[#9477bf]">
              <option value="">Todos os produtos</option>
              {products.map(({ key, name }) => <option key={key} value={key}>{name}</option>)}
            </select>
          </label>
          <button type="button" onClick={clearFilters} className="h-10 rounded-lg px-3 text-xs font-semibold text-[#766d83] transition hover:bg-[#f6f3f8] xl:whitespace-nowrap" data-testid="button-clear-scoreboard-filters">Limpar filtros</button>
        </div>
        {invalidRange && <p className="mt-3 text-xs font-semibold text-[#a24f45]" role="alert" data-testid="status-scoreboard-date-range">{!dateFrom || !dateTo ? 'Informe as datas inicial e final para consultar o intervalo.' : 'A data inicial deve ser anterior ou igual à data final.'}</p>}
        {invalidMonthSelection && <p className="mt-3 text-xs font-semibold text-[#a24f45]" role="alert" data-testid="status-scoreboard-month">Selecione o mês que deseja consultar.</p>}
      </section>

      <section className="grid gap-3 sm:grid-cols-2" aria-label="Resumo do período">
        <div className="relative overflow-hidden rounded-[22px] bg-[#302842] px-5 py-5 text-white sm:px-6">
          <span className="absolute -right-5 -top-12 h-36 w-36 rounded-full border-[22px] border-white/[.05]" aria-hidden="true" />
          <p className="relative text-[10px] font-bold uppercase tracking-[.13em] text-[#c8bfd4]">Receita total</p>
          <p className="relative mt-2 font-[family-name:var(--app-font-serif)] text-[clamp(1.8rem,4vw,2.65rem)] font-extrabold leading-none tracking-[-.06em]" data-testid="text-scoreboard-revenue">{formatCents(report.revenueCents)}</p>
          <p className="relative mt-3 text-[11px] text-[#c8bfd4]">Soma exata dos valores dos lançamentos filtrados</p>
        </div>
        <div className="rounded-[22px] border border-[#e6e1e9] bg-[#f0edf4] px-5 py-5 sm:px-6">
          <p className="text-[10px] font-bold uppercase tracking-[.13em] text-[#777080]">Planos/produtos vendidos</p>
          <p className="mt-2 font-[family-name:var(--app-font-serif)] text-[clamp(1.8rem,4vw,2.65rem)] font-extrabold leading-none tracking-[-.06em] text-[#392f4b]" data-testid="text-scoreboard-quantity">{report.quantity.toLocaleString('pt-BR')}</p>
          <p className="mt-3 text-[11px] text-[#777080]">Unidades no período, somando a quantidade de cada venda</p>
        </div>
      </section>

      <ScoreboardGoals
        actualRevenueCents={report.revenueCents}
        monthKeys={periodMonthKeys}
        comparisonMode={goalComparisonMode}
        selectedProductName={selectedProductName}
        products={products}
        goals={salesGoals ?? []}
        isLoading={isGoalsLoading}
        isError={isGoalsError}
        onRetry={() => { void refetchSalesGoals(); }}
      />

      {filteredSales.length === 0 && !invalidRange && !invalidMonthSelection && !(periodMode === 'multiple' && selectedMonths.length === 0) && (
        <section className="flex items-start gap-3 rounded-[18px] border border-dashed border-[#dcd5e2] bg-[#fbf9fc] px-4 py-4" data-testid="status-scoreboard-empty">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-[#eee8f7] text-[#7656b8]"><ClipboardList size={17} /></span>
          <div>
            <p className="text-sm font-bold text-[#40374e]">{(sales ?? []).length ? 'Nenhum lançamento neste recorte' : 'Ainda não há vendas registradas'}</p>
            <p className="mt-1 text-xs leading-5 text-[#827b8b]">{(sales ?? []).length ? 'Altere ou limpe os filtros para consultar outros resultados.' : 'Quando a equipe registrar vendas, os totais e as tabelas serão preenchidos aqui.'}</p>
          </div>
        </section>
      )}

      <div className="grid gap-5 xl:grid-cols-[1.15fr_.85fr]">
        <section className="overflow-hidden rounded-[22px] border border-[#e7e1e9] bg-[#fffefc]" aria-labelledby="scoreboard-products-heading" data-testid="table-scoreboard-products">
          <div className="flex items-end justify-between border-b border-[#ece7ee] px-4 py-4 sm:px-5">
            <div><p className="eyebrow text-[9px] font-bold text-[#8a8491]">por produto</p><h2 id="scoreboard-products-heading" className="mt-1 text-base font-extrabold tracking-[-.035em] text-[#332d40]">Vendas por produto</h2></div>
            <span className="text-[10px] font-semibold text-[#8a8491]" data-testid="text-scoreboard-product-groups">{report.products.length} {report.products.length === 1 ? 'produto' : 'produtos'}</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[540px] border-collapse text-left text-xs">
              <thead><tr className="bg-[#f8f6f9] text-[9px] font-bold uppercase tracking-[.1em] text-[#817b89]"><th className="px-4 py-3 sm:px-5">Produto</th><th className="px-4 py-3 text-right">Quantidade</th><th className="px-4 py-3 text-right sm:px-5">Receita</th></tr></thead>
              <tbody>
                {report.products.map((product) => <tr key={productNameKey(product.name)} className="border-t border-[#f0edf1]" data-testid={`row-scoreboard-product-${productNameKey(product.name)}`}><th scope="row" className="max-w-[260px] truncate px-4 py-3.5 font-semibold text-[#494253] sm:px-5">{product.name}</th><td className="px-4 py-3.5 text-right font-medium tabular-nums text-[#5f5967]">{product.quantity.toLocaleString('pt-BR')}</td><td className="px-4 py-3.5 text-right font-bold tabular-nums text-[#463954] sm:px-5">{formatCents(product.revenueCents)}</td></tr>)}
              </tbody>
              <tfoot><tr className="border-t border-[#e5dfea] bg-[#f6f3f8] font-extrabold text-[#3e354b]" data-testid="row-scoreboard-products-total"><th scope="row" className="px-4 py-3.5 sm:px-5">Total</th><td className="px-4 py-3.5 text-right tabular-nums" data-testid="text-scoreboard-product-quantity-total">{report.quantity.toLocaleString('pt-BR')}</td><td className="px-4 py-3.5 text-right tabular-nums sm:px-5" data-testid="text-scoreboard-product-revenue-total">{formatCents(report.products.reduce((sum, product) => sum + product.revenueCents, 0n))}</td></tr></tfoot>
            </table>
          </div>
        </section>

        <section className="overflow-hidden rounded-[22px] border border-[#e7e1e9] bg-[#fffefc]" aria-labelledby="scoreboard-months-heading" data-testid="table-scoreboard-months">
          <div className="border-b border-[#ece7ee] px-4 py-4 sm:px-5">
            <p className="eyebrow text-[9px] font-bold text-[#8a8491]">evolução mensal</p><h2 id="scoreboard-months-heading" className="mt-1 text-base font-extrabold tracking-[-.035em] text-[#332d40]">Resumo por mês</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[470px] border-collapse text-left text-xs">
              <thead><tr className="bg-[#f8f6f9] text-[9px] font-bold uppercase tracking-[.1em] text-[#817b89]"><th className="px-4 py-3 sm:px-5">Mês / ano</th><th className="px-4 py-3 text-right">Quantidade</th><th className="px-4 py-3 text-right sm:px-5">Receita</th></tr></thead>
              <tbody>
                {report.months.map(([month, values]) => {
                  const monthLabel = formatMonthKey(month);
                  return <tr key={month} className="border-t border-[#f0edf1]" data-testid={`row-scoreboard-month-${month}`}><th scope="row" className="px-4 py-3.5 font-semibold capitalize text-[#494253] sm:px-5">{monthLabel}</th><td className="px-4 py-3.5 text-right font-medium tabular-nums text-[#5f5967]">{values.quantity.toLocaleString('pt-BR')}</td><td className="px-4 py-3.5 text-right font-bold tabular-nums text-[#463954] sm:px-5">{formatCents(values.revenueCents)}</td></tr>;
                })}
              </tbody>
              <tfoot><tr className="border-t border-[#e5dfea] bg-[#f6f3f8] font-extrabold text-[#3e354b]" data-testid="row-scoreboard-months-total"><th scope="row" className="px-4 py-3.5 sm:px-5">Total</th><td className="px-4 py-3.5 text-right tabular-nums" data-testid="text-scoreboard-month-quantity-total">{report.months.reduce((sum, [, values]) => sum + values.quantity, 0n).toLocaleString('pt-BR')}</td><td className="px-4 py-3.5 text-right tabular-nums sm:px-5" data-testid="text-scoreboard-month-revenue-total">{formatCents(report.months.reduce((sum, [, values]) => sum + values.revenueCents, 0n))}</td></tr></tfoot>
            </table>
          </div>
        </section>
      </div>

      <div className="flex flex-col gap-1 border-t border-[#e8e3ea] pt-3 text-[10px] text-[#8b8591] sm:flex-row sm:items-center sm:justify-between" data-testid="status-scoreboard-audit">
        <span>Totais conciliados pelo mesmo conjunto filtrado: receita e unidades.</span>
        <span className="inline-flex items-center gap-1.5"><LockKeyhole size={12} /> Visível somente para pessoas autorizadas</span>
      </div>
    </div>
  );
}

function Workspace() {
  const [location, setLocation] = useLocation();
  const isScoreboard = location.endsWith('/scoreboard');
  const { user } = useUser();
  const { signOut } = useClerk();
  const name = user?.firstName || 'Equipe';
  const initial = name.slice(0, 1).toLocaleUpperCase('pt-BR');
  const changeTab = (tab: 'sales' | 'scoreboard') => setLocation(tab === 'sales' ? '/' : '/scoreboard');

  return (
    <div className="app-shell">
      <header className="sticky top-0 z-20 border-b border-[#eae6eb] bg-[#f9f7f4]/95 backdrop-blur-md">
        <div className="mx-auto flex h-[72px] max-w-[1440px] items-center justify-between px-4 sm:px-7 lg:px-10">
          <div className="flex items-center gap-8">
            <Brand />
            <nav className="hidden items-center gap-1 sm:flex" aria-label="Navegação principal">
              <button onClick={() => changeTab('sales')} className={`rounded-full px-4 py-2 text-[13px] font-semibold transition ${!isScoreboard ? 'bg-[#ece6f4] text-[#65479c]' : 'text-[#77717f] hover:bg-white'}`} aria-current={!isScoreboard ? 'page' : undefined} data-testid="tab-lancamentos">Lançamentos</button>
              <button onClick={() => changeTab('scoreboard')} className={`rounded-full px-4 py-2 text-[13px] font-semibold transition ${isScoreboard ? 'bg-[#ece6f4] text-[#65479c]' : 'text-[#77717f] hover:bg-white'}`} aria-current={isScoreboard ? 'page' : undefined} data-testid="tab-scoreboard">Scoreboard</button>
            </nav>
          </div>
          <div className="flex items-center gap-3">
            <div className="hidden text-right sm:block"><p className="text-xs font-bold text-[#464151]" data-testid="text-user-name">{name}</p><p className="mt-0.5 text-[10px] text-[#918b98]">Acesso da equipe</p></div>
            <div className="grid h-9 w-9 place-items-center rounded-full bg-[#d7eaa9] text-xs font-extrabold text-[#45552d]" aria-label={`Perfil de ${name}`}>{initial}</div>
            <button onClick={() => void signOut({ redirectUrl: basePath || '/' })} aria-label="Sair da conta" title="Sair da conta" className="grid h-9 w-9 place-items-center rounded-full text-[#807a88] transition hover:bg-white hover:text-[#5e4a7c]" data-testid="button-sign-out"><LogOut size={16} /></button>
          </div>
        </div>
        <nav className="flex border-t border-[#ece8ed] px-3 py-2 sm:hidden" aria-label="Navegação principal">
          <button onClick={() => changeTab('sales')} className={`flex-1 rounded-xl py-2.5 text-xs font-bold ${!isScoreboard ? 'bg-[#ece6f4] text-[#65479c]' : 'text-[#77717f]'}`} data-testid="tab-lancamentos-mobile">Lançamentos</button>
          <button onClick={() => changeTab('scoreboard')} className={`flex-1 rounded-xl py-2.5 text-xs font-bold ${isScoreboard ? 'bg-[#ece6f4] text-[#65479c]' : 'text-[#77717f]'}`} data-testid="tab-scoreboard-mobile">Scoreboard</button>
        </nav>
      </header>
      <main className="mx-auto max-w-[1440px] px-4 pb-12 pt-8 sm:px-7 md:pt-10 lg:px-10">
        <div className="page-enter">
          <div className="mb-7 flex flex-col justify-between gap-4 md:mb-8 md:flex-row md:items-end">
            <div>
              <p className="eyebrow text-[9px] font-bold text-[#8a8491]">zero3 pro <span className="mx-1 text-[#b2abb8]">/</span> {isScoreboard ? 'visão do time' : 'rotina comercial'}</p>
              <h1 className="mt-2 font-[family-name:var(--app-font-serif)] text-[clamp(2.3rem,4vw,3.4rem)] font-extrabold leading-none tracking-[-.075em] text-[#2f2a3d]">{isScoreboard ? 'Scoreboard' : 'Lançamentos'}<span className="ml-2 text-[#a9d75a]">.</span></h1>
            </div>
            <div className="flex items-center gap-2 text-xs font-medium text-[#7f7987]"><CalendarDays size={15} className="text-[#8c73b4]" /> Acompanhe o ritmo do time</div>
          </div>
          {isScoreboard ? <ScoreboardContent /> : <SalesManagement />}
        </div>
      </main>
    </div>
  );
}

function HomeRedirect() {
  const { isLoaded } = useUser();
  if (!isLoaded) return <AuthLoading />;
  return <><Show when="signed-in"><AccessGate /></Show><Show when="signed-out"><Landing /></Show></>;
}

function AccessGate() {
  const { data, isLoading, isError, refetch } = useGetAccessStatus({
    query: { queryKey: getGetAccessStatusQueryKey() },
  });

  if (isLoading) return <AuthLoading />;
  if (isError) {
    return (
      <main className="grid min-h-[100dvh] place-items-center bg-[#f7f5f1] px-5">
        <div className="max-w-sm rounded-[24px] border border-[#e9e4ec] bg-white p-7 text-center shadow-sm">
          <CircleHelp className="mx-auto text-[#ad6254]" size={26} />
          <h1 className="mt-4 text-lg font-bold text-[#302842]">Não foi possível validar seu acesso</h1>
          <p className="mt-2 text-sm leading-6 text-[#827b8b]">Confira sua conexão e tente novamente.</p>
          <button onClick={() => void refetch()} className="mt-5 rounded-full bg-[#7656b8] px-5 py-2.5 text-sm font-bold text-white" data-testid="button-retry-access">Tentar novamente</button>
        </div>
      </main>
    );
  }
  if (!data?.authorized) return <AccessDenied />;
  return <Workspace />;
}

function AccessDenied() {
  const { signOut } = useClerk();
  return (
    <main className="grid min-h-[100dvh] place-items-center bg-[#f7f5f1] px-5">
      <div className="max-w-sm rounded-[24px] border border-[#e9e4ec] bg-white p-7 text-center shadow-sm" data-testid="status-access-denied">
        <LockKeyhole className="mx-auto text-[#7656b8]" size={27} />
        <h1 className="mt-4 text-lg font-bold text-[#302842]">Acesso não autorizado</h1>
        <p className="mt-2 text-sm leading-6 text-[#827b8b]">Esta conta não está na lista de acesso do Zero3 PRO. Fale com o responsável pelo aplicativo.</p>
        <button onClick={() => void signOut({ redirectUrl: basePath || '/' })} className="mt-5 rounded-full border border-[#ded8e5] px-5 py-2.5 text-sm font-bold text-[#5c506f] hover:bg-[#f8f6fa]" data-testid="button-sign-out-unauthorized">Sair da conta</button>
      </div>
    </main>
  );
}

function AuthLoading() {
  return <main className="grid min-h-[100dvh] place-items-center bg-[#f7f5f1] px-5">
    <div className="w-full max-w-[260px] text-center">
      <Brand />
      <div className="mx-auto mt-8 h-2 w-32 overflow-hidden rounded-full bg-[#e7e1ed]"><div className="h-full w-1/2 animate-pulse rounded-full bg-[#a8d755]" /></div>
      <p className="mt-4 text-xs font-medium text-[#817b89]">Preparando seu espaço…</p>
    </div>
  </main>;
}

function SignInPage() {
  return <main className="flex min-h-[100dvh] flex-col items-center justify-center bg-[#f7f5f1] px-4 py-10"><div className="mb-7 text-center"><Brand /><p className="mt-3 text-sm text-[#77717f]">Entre para acompanhar o ritmo das vendas.</p></div><SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} /></main>;
}

function SignUpPage() {
  return <main className="flex min-h-[100dvh] flex-col items-center justify-center bg-[#f7f5f1] px-4 py-10"><div className="mb-7 text-center"><Brand /><p className="mt-3 text-sm text-[#77717f]">Acesso privado para a equipe Zero3.</p></div><SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} /></main>;
}

function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const cache = useQueryClient();
  const prevUserIdRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const unsubscribe = addListener(({ user }) => {
      const userId = user?.id ?? null;
      if (prevUserIdRef.current !== undefined && prevUserIdRef.current !== userId) cache.clear();
      prevUserIdRef.current = userId;
    });
    return unsubscribe;
  }, [addListener, cache]);
  return null;
}

function Router() {
  return <Switch>
    <Route path="/" component={HomeRedirect} />
    <Route path="/scoreboard"><ProtectedWorkspace /></Route>
    <Route path="/sign-in/*?" component={SignInPage} />
    <Route path="/sign-up/*?" component={SignUpPage} />
    <Route component={NotFound} />
  </Switch>;
}

function ProtectedWorkspace() {
  const { isLoaded } = useUser();
  if (!isLoaded) return <AuthLoading />;
  return <><Show when="signed-in"><AccessGate /></Show><Show when="signed-out"><Redirect to="/" /></Show></>;
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function ClerkProviderWithRoutes() {
  const [, setLocation] = useLocation();
  return <ClerkProvider
    publishableKey={clerkPubKey}
    proxyUrl={clerkProxyUrl}
    appearance={clerkAppearance}
    signInUrl={`${basePath}/sign-in`}
    signUpUrl={`${basePath}/sign-up`}
    localization={{
      ...ptBR,
      signIn: { ...ptBR.signIn, start: { ...ptBR.signIn?.start, title: 'Bem-vindo de volta', subtitle: 'Entre para acessar seu espaço de vendas.' } },
      signUp: { ...ptBR.signUp, start: { ...ptBR.signUp?.start, title: 'Acesso à equipe', subtitle: 'Crie sua conta para entrar no Zero3 PRO.' } },
    }}
    routerPush={(to) => setLocation(stripBase(to))}
    routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
  >
    <ClerkQueryClientCacheInvalidator />
    <RoutedErrorBoundary><Router /></RoutedErrorBoundary>
  </ClerkProvider>;
}

function App() {
  if (!clerkPubKey) throw new Error('Missing VITE_CLERK_PUBLISHABLE_KEY in .env file');
  return <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <WouterRouter base={basePath}><ClerkProviderWithRoutes /></WouterRouter>
      <Toaster />
    </TooltipProvider>
  </QueryClientProvider>;
}

export default App;
