import { CalendarDays, CircleAlert, RefreshCw, UsersRound } from 'lucide-react';
import {
  getGetActiveContractsQueryKey,
  useGetActiveContracts,
} from '@workspace/api-client-react';
import { ChartContainer } from '@/components/ui/chart';
import { DownloadPdfButton, PdfPrintHeader, PdfPrintTable } from '@/components/dashboard-pdf-tools';
import { formatMonthKey } from '@/lib/sales-utils';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

const panelClass = 'rounded-[22px] border border-[#e9e4eb] bg-[#fffefc] p-4 shadow-[0_14px_35px_-30px_rgba(55,40,72,.28)] sm:p-5';

function count(value: number | null | undefined) {
  return value == null ? '—' : value.toLocaleString('pt-BR');
}

function monthDifference(current: number, previous: number) {
  const difference = current - previous;
  return `${difference > 0 ? '+' : ''}${difference.toLocaleString('pt-BR')}`;
}

function formatDateTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(date);
}

function errorText(error: unknown) {
  return error && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
    ? error.message
    : 'Confira a conexão e tente atualizar novamente.';
}

export default function ActiveContractsDashboard({
  onOccupancy,
  onFinancial,
  onComplete,
}: {
  onOccupancy: () => void;
  onFinancial: () => void;
  onComplete: () => void;
}) {
  const queryKey = getGetActiveContractsQueryKey();
  const contractsQuery = useGetActiveContracts({
    query: { queryKey, refetchOnMount: 'always' },
  });
  const records = [...(contractsQuery.data ?? [])].sort((left, right) => left.month.localeCompare(right.month));
  const latest = records.at(-1);
  const previous = records.at(-2);
  const targetDifference = latest?.targetCount == null ? null : latest.activeCount - latest.targetCount;
  const achievement = latest?.targetCount && latest.targetCount > 0
    ? latest.activeCount / latest.targetCount * 100
    : null;
  const chartRecords = records.slice(-24);

  return (
    <section className="pdf-report-root space-y-5" aria-label="Painel de contratos ativos" data-testid="page-active-contracts-dashboard">
      <div data-pdf-hide-on-export className="flex flex-col justify-between gap-4 rounded-[22px] border border-[#e9e4eb] bg-[#fffefc] p-4 shadow-[0_14px_35px_-30px_rgba(55,40,72,.28)] sm:flex-row sm:items-center sm:px-6">
        <div>
          <p className="text-[9px] font-bold uppercase tracking-[.14em] text-[#8a8491]">zero3 pro <span className="mx-1 text-[#b2abb8]">/</span> painel de gestão</p>
          <h1 className="mt-1 font-[family-name:var(--app-font-serif)] text-3xl font-extrabold leading-none tracking-[-.07em] text-[#342d40] sm:text-[2.6rem]">Contratos ativos<span className="ml-1 text-[#a9d75a]">.</span></h1>
          <p className="mt-2 text-xs text-[#837b8b]">Saldos mensais informados pela administração, independentes das vendas.</p>
        </div>
        <nav className="flex flex-wrap items-center gap-1 self-start rounded-full bg-[#f5f2f6] p-1 sm:self-auto" aria-label="Painéis de gestão">
          <button type="button" onClick={onOccupancy} className="rounded-full px-3 py-2 text-xs font-semibold text-[#716879] transition hover:bg-white hover:text-[#65479c]" data-testid="switch-contracts-occupancy">Check-in</button>
          <button type="button" onClick={onFinancial} className="rounded-full px-3 py-2 text-xs font-semibold text-[#716879] transition hover:bg-white hover:text-[#65479c]" data-testid="switch-contracts-financial">Faturamento</button>
          <span className="rounded-full bg-[#ece6f4] px-3 py-2 text-xs font-bold text-[#65479c]" aria-current="page" data-testid="switch-contracts-active">Contratos ativos</span>
          <button type="button" onClick={onComplete} className="rounded-full px-3 py-2 text-xs font-semibold text-[#716879] transition hover:bg-white hover:text-[#65479c]" data-testid="switch-contracts-complete">Completa</button>
        </nav>
      </div>

      {contractsQuery.isLoading ? (
        <div className="grid gap-3 sm:grid-cols-3" aria-label="Carregando contratos ativos" data-testid="loading-active-contracts-dashboard">
          {[0, 1, 2].map((item) => <div key={item} className="h-28 animate-pulse rounded-2xl border border-[#e9e4eb] bg-[#fffefc]" />)}
        </div>
      ) : contractsQuery.isError ? (
        <div className="rounded-[22px] border border-[#ecd5d4] bg-[#fff9f8] p-6" role="alert" data-testid="error-active-contracts-dashboard">
          <div className="flex items-start gap-3"><CircleAlert size={18} className="mt-0.5 text-[#ad5955]" /><div>
            <h2 className="text-sm font-extrabold text-[#673d3c]">Não foi possível carregar os contratos ativos</h2>
            <p className="mt-1 text-xs leading-5 text-[#806462]">{errorText(contractsQuery.error)}</p>
            <button type="button" onClick={() => void contractsQuery.refetch()} className="mt-4 inline-flex items-center gap-2 rounded-full bg-[#65479c] px-4 py-2 text-xs font-bold text-white" data-testid="button-retry-active-contracts"><RefreshCw size={13} /> Tentar novamente</button>
          </div></div>
        </div>
      ) : !records.length ? (
        <div className={`${panelClass} border-dashed py-14 text-center`} data-testid="empty-active-contracts-dashboard">
          <span className="mx-auto grid h-11 w-11 place-items-center rounded-full bg-[#ece6f4] text-[#7655a8]"><CalendarDays size={19} /></span>
          <h2 className="mt-4 text-base font-extrabold text-[#443d50]">Nenhum saldo mensal cadastrado</h2>
          <p className="mx-auto mt-1 max-w-md text-xs leading-5 text-[#837b8b]">Cadastre os contratos ativos em Lançamentos. Meses sem registro permanecem sem valor; não são tratados como zero.</p>
        </div>
      ) : (
        <>
          <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Indicadores de contratos ativos" data-testid="summary-active-contracts" data-pdf-hide-on-export>
            <article className="rounded-[20px] border border-[#e9e4eb] bg-[#fffefc] p-4" data-testid="metric-active-contracts-latest">
              <p className="text-[9px] font-bold uppercase tracking-[.12em] text-[#8a8491]">Último saldo registrado</p>
              <p className="mt-2 text-2xl font-extrabold tabular-nums tracking-[-.04em] text-[#342d40]">{count(latest?.activeCount)}</p>
              <p className="mt-1 text-[10px] capitalize text-[#837b8b]">{latest ? formatMonthKey(latest.month) : 'Sem mês registrado'}</p>
            </article>
            <article className="rounded-[20px] border border-[#e9e4eb] bg-[#fffefc] p-4" data-testid="metric-active-contracts-change">
              <p className="text-[9px] font-bold uppercase tracking-[.12em] text-[#8a8491]">Variação do último registro</p>
              <p className="mt-2 text-2xl font-extrabold tabular-nums tracking-[-.04em] text-[#342d40]">{latest && previous ? monthDifference(latest.activeCount, previous.activeCount) : '—'}</p>
              <p className="mt-1 text-[10px] text-[#837b8b]">{previous ? `Comparado a ${formatMonthKey(previous.month)}` : 'É necessário ter dois meses registrados'}</p>
            </article>
            <article className="rounded-[20px] border border-[#e9e4eb] bg-[#fffefc] p-4" data-testid="metric-active-contracts-target">
              <p className="text-[9px] font-bold uppercase tracking-[.12em] text-[#8a8491]">Meta do último mês</p>
              <p className="mt-2 text-2xl font-extrabold tabular-nums tracking-[-.04em] text-[#342d40]">{latest?.targetCount == null ? 'Não definida' : count(latest.targetCount)}</p>
              <p className="mt-1 text-[10px] text-[#837b8b]">Contratos previstos para o mês</p>
            </article>
            <article className="rounded-[20px] border border-[#e0d7ed] bg-[#f8f5fb] p-4" data-testid="metric-active-contracts-achievement">
              <p className="text-[9px] font-bold uppercase tracking-[.12em] text-[#806aa0]">Atingimento da meta</p>
              <p className="mt-2 text-2xl font-extrabold tabular-nums tracking-[-.04em] text-[#65479c]">{achievement == null ? '—' : `${achievement.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`}</p>
              <p className="mt-1 text-[10px] text-[#837b8b]">{targetDifference == null ? 'Meta não definida ou igual a zero' : targetDifference >= 0 ? `${count(targetDifference)} acima da meta` : `Faltam ${count(Math.abs(targetDifference))} contratos`}</p>
            </article>
          </section>

          <section className={panelClass} data-testid="chart-active-contracts-monthly" data-pdf-panel="contracts-monthly">
            <PdfPrintHeader title="Contratos ativos e meta" period="Histórico mensal registrado" filters="Exibição do gráfico: até 24 meses; sem valores presumidos para meses sem cadastro" />
            <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
              <div><p className="text-[9px] font-bold uppercase tracking-[.15em] text-[#8c73b4]">evolução mensal</p><h2 className="mt-1 font-[family-name:var(--app-font-serif)] text-xl font-extrabold tracking-[-.045em] text-[#342d40]">Contratos ativos e meta</h2><p className="mt-1 text-[10px] text-[#837b8b]">{chartRecords.length} meses com registro · sem valores presumidos</p></div>
              <DownloadPdfButton scope="contracts-monthly" title="Contratos ativos e meta" period="Histórico mensal" compact disabled={contractsQuery.isFetching || contractsQuery.isError} />
            </div>
            <ChartContainer role="img" aria-label="Gráfico de barras mensais de contratos ativos comparados à meta" config={{ activeCount: { label: 'Contratos ativos', color: '#7655a8' }, targetCount: { label: 'Meta', color: '#a9d75a' } }} className="dashboard-pdf-chart h-[310px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartRecords} margin={{ top: 8, right: 12, bottom: 36, left: 4 }} barGap={4}>
                  <CartesianGrid vertical={false} stroke="#eee9f1" />
                  <XAxis dataKey="month" interval="preserveStartEnd" angle={-25} textAnchor="end" height={58} tickFormatter={(value) => formatMonthKey(String(value))} tick={{ fill: '#837b8b', fontSize: 10 }} axisLine={false} tickLine={false} />
                  <YAxis allowDecimals={false} width={48} tick={{ fill: '#837b8b', fontSize: 10 }} axisLine={false} tickLine={false} />
                  <Tooltip labelFormatter={(value) => formatMonthKey(String(value))} formatter={(value, name) => [count(Number(value)), String(name)]} />
                  <Legend wrapperStyle={{ fontSize: 11, paddingTop: 6 }} />
                  <Bar dataKey="activeCount" name="Contratos ativos" fill="#7655a8" radius={[5, 5, 0, 0]} maxBarSize={34} />
                  <Bar dataKey="targetCount" name="Meta" fill="#a9d75a" radius={[5, 5, 0, 0]} maxBarSize={34} />
                </BarChart>
              </ResponsiveContainer>
            </ChartContainer>
            {records.length > 24 && <p className="mt-2 text-[10px] text-[#837b8b]" data-testid="status-active-contracts-chart-window">O gráfico mostra os 24 meses mais recentes; a tabela abaixo mantém todo o histórico.</p>}
            <PdfPrintTable
              headers={['Mês', 'Contratos ativos', 'Meta', 'Diferença', 'Atingimento']}
              rows={chartRecords.map((record) => {
                const difference = record.targetCount == null ? null : record.activeCount - record.targetCount;
                const percentage = record.targetCount != null && record.targetCount > 0 ? record.activeCount / record.targetCount * 100 : null;
                return [formatMonthKey(record.month), count(record.activeCount), count(record.targetCount), difference == null ? '—' : monthDifference(difference, 0), percentage == null ? '—' : `${percentage.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`];
              })}
            />
          </section>

          <section className={panelClass} data-testid="table-active-contracts-history" data-pdf-hide-on-export>
            <div className="mb-3 flex items-center gap-2"><UsersRound size={16} className="text-[#7655a8]" /><h2 className="text-sm font-extrabold text-[#443d50]">Comparativo mensal</h2></div>
            <div className="overflow-x-auto rounded-xl border border-[#eeeaf1]">
              <table className="w-full min-w-[760px] border-collapse text-left text-xs">
                <thead className="bg-[#f8f5fb] text-[9px] uppercase tracking-[.08em] text-[#817b89]">
                  <tr><th className="px-3 py-2.5">Mês/ano</th><th className="px-3 py-2.5">Contratos ativos</th><th className="px-3 py-2.5">Meta</th><th className="px-3 py-2.5">Diferença</th><th className="px-3 py-2.5">Atingimento</th><th className="px-3 py-2.5">Observações</th><th className="px-3 py-2.5">Atualizado</th></tr>
                </thead>
                <tbody className="divide-y divide-[#f0edf1] bg-white">
                  {[...records].reverse().map((record, index, descending) => {
                    const prior = descending[index + 1];
                    const difference = record.targetCount == null ? null : record.activeCount - record.targetCount;
                    const percentage = record.targetCount != null && record.targetCount > 0 ? record.activeCount / record.targetCount * 100 : null;
                    return <tr key={record.month} data-testid={`row-active-contracts-dashboard-${record.month}`}>
                      <td className="whitespace-nowrap px-3 py-3 font-bold capitalize text-[#4b4357]">{formatMonthKey(record.month)}</td>
                      <td className="px-3 py-3 font-extrabold tabular-nums text-[#342d40]">{count(record.activeCount)}{prior ? <span className="ml-1.5 text-[9px] font-medium text-[#837b8b]">({monthDifference(record.activeCount, prior.activeCount)} vs. mês anterior registrado)</span> : null}</td>
                      <td className="px-3 py-3 tabular-nums text-[#716879]">{record.targetCount == null ? 'Não definida' : count(record.targetCount)}</td>
                      <td className="px-3 py-3 tabular-nums text-[#716879]">{difference == null ? '—' : monthDifference(difference, 0)}</td>
                      <td className="px-3 py-3 tabular-nums text-[#65479c]">{percentage == null ? '—' : `${percentage.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`}</td>
                      <td className="max-w-56 truncate px-3 py-3 text-[#837b8b]" title={record.notes ?? undefined}>{record.notes || '—'}</td>
                      <td className="whitespace-nowrap px-3 py-3 text-[10px] text-[#837b8b]">{formatDateTime(record.updatedAt)}</td>
                    </tr>;
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </section>
  );
}
