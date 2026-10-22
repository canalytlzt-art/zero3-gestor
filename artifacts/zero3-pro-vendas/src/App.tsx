import { useEffect, useRef, type ReactNode } from 'react';
import { ClerkProvider, Show, SignIn, SignUp, useClerk, useUser } from '@clerk/react';
import { publishableKeyFromHost } from '@clerk/react/internal';
import { shadcn } from '@clerk/themes';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { ArrowDownRight, ArrowRight, BarChart3, CalendarDays, Check, CircleHelp, ClipboardList, LockKeyhole, LogOut, Plus, RefreshCw, Sparkles, Trophy } from 'lucide-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { getGetSalesQueryKey, useGetSales } from '@workspace/api-client-react';
import type { Sale } from '@workspace/api-client-react';
import NotFound from '@/pages/not-found';
import { Link, Redirect, Route, Switch, useLocation, Router as WouterRouter } from 'wouter';

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

function LoadingBlocks() {
  return (
    <div className="space-y-4" aria-label="Carregando vendas" data-testid="status-sales-loading">
      <div className="skeleton h-28 rounded-3xl" />
      <div className="skeleton h-16 rounded-2xl" />
      <div className="skeleton h-16 rounded-2xl" />
    </div>
  );
}

function SalesContent() {
  const { data: sales, isLoading, isError, refetch } = useGetSales({ query: { queryKey: getGetSalesQueryKey() } });

  return (
    <>
      <section className="grid gap-5 lg:grid-cols-[1fr_1.18fr]">
        <div className="rounded-[24px] border border-[#e9e4ec] bg-white p-5 shadow-[0_7px_28px_rgba(47,38,63,.035)] md:p-6">
          <div className="mb-5 flex items-center justify-between">
            <div><p className="eyebrow text-[9px] font-bold text-[#8b8494]">novo registro</p><h2 className="mt-1 text-lg font-bold tracking-[-.035em]">Lançar uma venda</h2></div>
            <span className="rounded-full bg-[#f1edf7] px-3 py-1.5 text-[10px] font-bold text-[#7257a4]">em breve</span>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <PlaceholderField label="Data da venda" icon={<CalendarDays size={14} />} />
            <PlaceholderField label="Produto" />
            <PlaceholderField label="Quantidade" />
            <PlaceholderField label="Valor unitário" />
          </div>
          <div className="mt-3 rounded-xl border border-dashed border-[#e2dde7] bg-[#faf9fb] px-4 py-3">
            <p className="text-[10px] font-bold uppercase tracking-[.12em] text-[#9690a0]">Observações</p>
            <p className="mt-1.5 text-xs text-[#b0aab7]">Campo opcional para detalhes da venda</p>
          </div>
          <button type="button" disabled className="mt-4 inline-flex w-full cursor-not-allowed items-center justify-center gap-2 rounded-xl bg-[#e9e5ee] px-4 py-3 text-sm font-bold text-[#9a94a2]" data-testid="button-sale-submit-disabled">
            <Plus size={16} /> Registrar venda
          </button>
          <p className="mt-3 text-center text-[10px] text-[#a09aa8]">O formulário será ativado na próxima etapa.</p>
        </div>

        <div className="rounded-[24px] border border-[#e9e4ec] bg-white p-5 shadow-[0_7px_28px_rgba(47,38,63,.035)] md:p-6">
          <div className="mb-5 flex items-center justify-between">
            <div><p className="eyebrow text-[9px] font-bold text-[#8b8494]">histórico</p><h2 className="mt-1 text-lg font-bold tracking-[-.035em]">Vendas recentes</h2></div>
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-[#f1edf7] text-[#7656b8]"><ClipboardList size={17} /></span>
          </div>
          {isLoading ? <LoadingBlocks /> : isError ? (
            <div className="grid min-h-[220px] place-items-center rounded-2xl border border-dashed border-[#e6e1ea] bg-[#fbfafc] p-6 text-center" data-testid="status-sales-error">
              <div><div className="mx-auto grid h-11 w-11 place-items-center rounded-2xl bg-[#f5e9e6] text-[#a6584b]"><CircleHelp size={19} /></div><p className="mt-4 font-bold">Não foi possível carregar</p><p className="mt-1 text-sm text-[#827b8b]">Confira sua conexão e tente novamente.</p><button onClick={() => void refetch()} className="mt-4 inline-flex items-center gap-2 rounded-full border border-[#ded8e5] bg-white px-4 py-2 text-xs font-bold text-[#5c506f] hover:bg-[#f8f6fa]" data-testid="button-retry-sales"><RefreshCw size={13} /> Tentar novamente</button></div>
            </div>
          ) : sales?.length ? (
            <div className="space-y-2">
              {sales.map((sale) => <SaleRow sale={sale} key={sale.id} />)}
            </div>
          ) : (
            <div className="grid min-h-[220px] place-items-center rounded-2xl border border-dashed border-[#e6e1ea] bg-[#fbfafc] p-6 text-center" data-testid="status-sales-empty">
              <div>
                <div className="relative mx-auto grid h-14 w-14 place-items-center rounded-[19px] bg-[#f0ebf7] text-[#7656b8]">
                  <ClipboardList size={22} /><span className="absolute -right-1 -top-1 h-3 w-3 rounded-full border-2 border-[#fbfafc] bg-[#a8d755]" />
                </div>
                <h3 className="mt-4 font-bold tracking-[-.02em]">Seu histórico começa aqui</h3>
                <p className="mx-auto mt-1.5 max-w-[270px] text-xs leading-5 text-[#85808e]">Quando a equipe registrar vendas, cada lançamento aparecerá neste espaço.</p>
              </div>
            </div>
          )}
        </div>
      </section>
      <div className="mt-5 flex items-center gap-3 rounded-2xl border border-[#e7e3e8] bg-[#f1eef3] px-4 py-3.5 text-xs text-[#746d7b]">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-white text-[#7656b8]"><LockKeyhole size={15} /></span>
        <span>Este espaço é privado e acessível apenas à equipe autorizada.</span>
        <span className="ml-auto hidden text-[10px] font-semibold text-[#9993a0] md:block">DADOS PERSISTIDOS</span>
      </div>
    </>
  );
}

function PlaceholderField({ label, icon }: { label: string; icon?: ReactNode }) {
  return <div className="rounded-xl border border-[#e8e4eb] bg-[#fbfafc] px-3.5 py-3">
    <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[.1em] text-[#898392]">{icon}{label}</div>
    <div className="mt-2 h-3 w-2/3 rounded-full bg-[#efedf1]" />
  </div>;
}

function SaleRow({ sale }: { sale: Sale }) {
  const date = new Date(`${sale.saleDate}T12:00:00`).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });
  const amount = (sale.totalCents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  return <div className="flex items-center gap-3 rounded-2xl border border-[#f0edf2] px-3.5 py-3" data-testid={`row-sale-${sale.id}`}>
    <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#f0ebf7] text-[#7656b8]"><CalendarDays size={16} /></div>
    <div className="min-w-0 flex-1"><p className="truncate text-sm font-bold text-[#353044]">{sale.productName}</p><p className="mt-1 text-[11px] text-[#8d8794]">{date} <span className="mx-1">·</span>{sale.quantity} un.</p></div>
    <span className="whitespace-nowrap text-sm font-bold tracking-[-.02em] text-[#403650]">{amount}</span>
  </div>;
}

function ScoreboardContent() {
  const { data: sales, isLoading, isError, refetch } = useGetSales({ query: { queryKey: getGetSalesQueryKey() } });
  if (isLoading) return <div className="space-y-4"><div className="skeleton h-44 rounded-[26px]" /><div className="skeleton h-52 rounded-[26px]" /></div>;
  if (isError) return <div className="grid min-h-[360px] place-items-center rounded-[26px] border border-dashed border-[#ded8e5] bg-white p-6 text-center" data-testid="status-scoreboard-error"><div><CircleHelp className="mx-auto text-[#ad6254]" size={25} /><p className="mt-4 font-bold">O placar não carregou</p><p className="mt-1 text-sm text-[#827b8b]">Tente buscar os dados novamente.</p><button onClick={() => void refetch()} className="mt-4 inline-flex items-center gap-2 rounded-full bg-[#7656b8] px-4 py-2.5 text-xs font-bold text-white" data-testid="button-retry-scoreboard"><RefreshCw size={13} /> Tentar novamente</button></div></div>;

  return (
    <div className="grid gap-5 lg:grid-cols-[.9fr_1.1fr]">
      <section className="relative overflow-hidden rounded-[26px] bg-[#302842] p-6 text-white md:p-8">
        <span className="absolute -right-8 -top-12 h-56 w-56 rounded-full border-[34px] border-white/[.045]" />
        <span className="absolute -bottom-20 right-24 h-44 w-44 rounded-full bg-[#a6d451]/10" />
        <div className="relative">
          <p className="eyebrow text-[9px] font-bold text-[#c7bdd8]">placar da equipe</p>
          <h2 className="mt-6 max-w-[430px] font-[family-name:var(--app-font-serif)] text-4xl font-bold leading-[1.05] tracking-[-.06em] md:text-[52px]">Toda conquista começa com um primeiro passo.</h2>
          <p className="mt-4 max-w-[340px] text-sm leading-6 text-[#c8c1d2]">O placar vai reunir o progresso da equipe assim que os lançamentos começarem.</p>
          <div className="mt-8 inline-flex items-center gap-2 rounded-full bg-white/10 px-3.5 py-2 text-[11px] font-semibold text-[#e7e2ed]"><span className="h-1.5 w-1.5 rounded-full bg-[#b4e46c]" /> {sales?.length ? 'Dados recebidos' : 'Aguardando primeiro lançamento'}</div>
        </div>
      </section>
      <section className="rounded-[26px] border border-[#e9e4ec] bg-white p-6 md:p-8" data-testid="status-scoreboard-empty">
        <div className="flex items-center justify-between">
          <div><p className="eyebrow text-[9px] font-bold text-[#8b8494]">ranking</p><h2 className="mt-1 text-xl font-bold tracking-[-.04em]">Destaques do time</h2></div>
          <span className="grid h-10 w-10 place-items-center rounded-[14px] bg-[#eff6e5] text-[#769f3e]"><Trophy size={18} /></span>
        </div>
        <div className="mt-7 flex min-h-[210px] flex-col items-center justify-center rounded-[20px] bg-[#f8f7f9] px-5 text-center">
          <div className="relative grid h-[58px] w-[58px] place-items-center rounded-[20px] bg-[#eae4f3] text-[#7656b8]">
            <Trophy size={24} /><span className="absolute -right-1 -top-1 h-3.5 w-3.5 rounded-full border-[3px] border-[#f8f7f9] bg-[#acd957]" />
          </div>
          <p className="mt-4 font-bold tracking-[-.02em]">{sales?.length ? 'O placar está sendo preparado' : 'Ainda não há posições'}</p>
          <p className="mt-1.5 max-w-[310px] text-xs leading-5 text-[#898391]">{sales?.length ? 'Os destaques aparecem aqui quando o placar da equipe estiver disponível.' : 'Assim que as primeiras vendas forem registradas, os destaques aparecem por aqui.'}</p>
        </div>
        <div className="mt-4 flex items-center gap-2 text-[11px] text-[#938c99]"><LockKeyhole size={13} /> Visível somente para pessoas autorizadas</div>
      </section>
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
          {isScoreboard ? <ScoreboardContent /> : <SalesContent />}
        </div>
      </main>
    </div>
  );
}

function HomeRedirect() {
  const { isLoaded } = useUser();
  if (!isLoaded) return <AuthLoading />;
  return <><Show when="signed-in"><Workspace /></Show><Show when="signed-out"><Landing /></Show></>;
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
  return <><Show when="signed-in"><Workspace /></Show><Show when="signed-out"><Redirect to="/" /></Show></>;
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
      signIn: { start: { title: 'Bem-vindo de volta', subtitle: 'Entre para acessar seu espaço de vendas.' } },
      signUp: { start: { title: 'Acesso à equipe', subtitle: 'Crie sua conta para entrar no Zero3 PRO.' } },
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
