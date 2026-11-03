import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Download, FileText, Search } from "lucide-react";
import {
  getGetSaleHistoryQueryKey,
  useGetSaleHistory,
} from "@workspace/api-client-react";
import type {
  Sale,
  SalesHistoryEntry,
  SalesRefundRecord,
  SalesScoreboardMonth,
  SalesScoreboardProduct,
} from "@workspace/api-client-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatCents } from "@/lib/sales-utils";
import { buildProductMonthlySalesSummary, paginateSalesHistory, sortAndFilterSalesHistory } from "@/lib/scoreboard-sales-history";
import { buildSalesSectorGroups, classifySaleSector, sumSalesScoreboardProducts } from "@/lib/sales-channel-report";
import { beginDashboardPdf, PdfPrintHeader, PdfPrintTable } from "./dashboard-pdf-tools";

const PAGE_SIZE = 12;

function formatDate(value: string) {
  const date = value.slice(0, 10);
  return new Date(`${date}T12:00:00`).toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function formatGeneratedAt() {
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/Sao_Paulo",
  }).format(new Date());
}

function getActiveRefundTotal(refunds: SalesRefundRecord[]) {
  return refunds.reduce(
    (total, refund) => total + (refund.status === "active" ? refund.amountCents : 0),
    0,
  );
}

function saleStatusLabel(sale: Sale, refundCents: number) {
  if (sale.status === "cancelled") return "Cancelada";
  if (refundCents >= sale.totalCents && refundCents > 0) return "Estornada";
  if (refundCents > 0) return "Estorno parcial";
  return "Ativa";
}

function SaleStatus({ sale, refundCents }: { sale: Sale; refundCents: number }) {
  const isCancelled = sale.status === "cancelled";
  const isRefunded = !isCancelled && refundCents >= sale.totalCents;
  const hasPartialRefund = !isCancelled && refundCents > 0 && refundCents < sale.totalCents;
  const label = isCancelled ? "Cancelada" : isRefunded ? "Estornada" : hasPartialRefund ? "Estorno parcial" : "Ativa";
  const style = isCancelled
    ? "bg-[#f2ecec] text-[#796565]"
    : hasPartialRefund || isRefunded
      ? "bg-[#fff3e3] text-[#835d27]"
      : "bg-[#eff6e5] text-[#55772c]";
  return <span className={`inline-flex whitespace-nowrap rounded-full px-2.5 py-1 text-[10px] font-bold ${style}`}>{label}</span>;
}

function SalesHistoryTable({
  sales,
  refundsBySale,
  onSelect,
  testId,
}: {
  sales: Sale[];
  refundsBySale: Map<string, SalesRefundRecord[]>;
  onSelect: (sale: Sale) => void;
  testId: string;
}) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<"active" | "cancelled" | "all">("active");
  const [sort, setSort] = useState<"date-newest" | "date-oldest" | "product" | "customer" | "amount-high" | "amount-low">("date-newest");
  const [page, setPage] = useState(1);
  const filtered = useMemo(
    () => sortAndFilterSalesHistory(sales, { search, status, sort }),
    [sales, search, status, sort],
  );
  const pageData = useMemo(() => paginateSalesHistory(filtered, page, PAGE_SIZE), [filtered, page]);

  useEffect(() => {
    setPage(1);
  }, [search, status, sort, sales]);

  useEffect(() => {
    if (page !== pageData.page) setPage(pageData.page);
  }, [page, pageData.page]);

  return (
    <div className="min-w-0" data-testid={testId}>
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_190px_190px]">
        <label className="relative block">
          <span className="sr-only">Buscar vendas por cliente, produto ou data</span>
          <Search size={14} aria-hidden="true" className="absolute left-3 top-1/2 -translate-y-1/2 text-[#928b9a]" />
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Buscar cliente, produto ou data"
            className="h-10 w-full rounded-xl border border-[#e7e2ea] bg-white pl-9 pr-3 text-xs text-[#40374e] outline-none focus:border-[#9477bf]"
            data-testid={`${testId}-search`}
          />
        </label>
        <label className="sr-only" htmlFor={`${testId}-status`}>Filtrar situação das vendas</label>
        <select
          id={`${testId}-status`}
          value={status}
          onChange={(event) => setStatus(event.target.value as typeof status)}
          className="h-10 w-full rounded-xl border border-[#e7e2ea] bg-white px-3 text-xs font-semibold text-[#5d5668] outline-none focus:border-[#9477bf]"
          data-testid={`${testId}-status`}
        >
          <option value="active">Vendas ativas</option>
          <option value="cancelled">Canceladas</option>
          <option value="all">Todas as situações</option>
        </select>
        <label className="sr-only" htmlFor={`${testId}-sort`}>Ordenar histórico de vendas</label>
        <select
          id={`${testId}-sort`}
          value={sort}
          onChange={(event) => setSort(event.target.value as typeof sort)}
          className="h-10 w-full rounded-xl border border-[#e7e2ea] bg-white px-3 text-xs font-semibold text-[#5d5668] outline-none focus:border-[#9477bf]"
          data-testid={`${testId}-sort`}
        >
          <option value="date-newest">Data: mais recente</option>
          <option value="date-oldest">Data: mais antiga</option>
          <option value="product">Produto: A–Z</option>
          <option value="customer">Cliente: A–Z</option>
          <option value="amount-high">Valor: maior primeiro</option>
          <option value="amount-low">Valor: menor primeiro</option>
        </select>
      </div>

      <div className="mt-3 overflow-x-auto rounded-xl border border-[#eeeaf0]">
        <table className="w-full min-w-[800px] border-collapse text-left text-xs">
          <thead>
            <tr className="bg-[#f8f6f9] text-[9px] font-bold uppercase tracking-[.08em] text-[#817b89]">
              <th className="px-3 py-3">Data</th>
              <th className="px-3 py-3">Setor / modalidade</th>
              <th className="px-3 py-3">Plano / produto</th>
              <th className="px-3 py-3">Cliente</th>
              <th className="px-3 py-3 text-right">Quantidade</th>
              <th className="px-3 py-3 text-right">Valor da venda</th>
              <th className="px-3 py-3">Situação</th>
              <th className="px-3 py-3 text-right">Detalhes</th>
            </tr>
          </thead>
          <tbody>
            {pageData.rows.map((sale) => (
              <tr key={sale.id} className="border-t border-[#f0edf1]" data-testid={`${testId}-row-${sale.id}`}>
                <td className="whitespace-nowrap px-3 py-3 font-medium text-[#5f5967]">{formatDate(sale.saleDate)}</td>
                <td className="max-w-[180px] truncate px-3 py-3 text-[#6d6676]">{classifySaleSector(sale).label}</td>
                <td className="max-w-[220px] truncate px-3 py-3 font-semibold text-[#40374e]" title={sale.productName}>{sale.productName}</td>
                <td className="max-w-[180px] truncate px-3 py-3 text-[#6d6676]" title={sale.customerName ?? ""}>{sale.customerName || "Não informado"}</td>
                <td className="whitespace-nowrap px-3 py-3 text-right tabular-nums text-[#5f5967]">{sale.quantity.toLocaleString("pt-BR")}</td>
                <td className="whitespace-nowrap px-3 py-3 text-right font-bold tabular-nums text-[#40374e]">{formatCents(sale.totalCents)}</td>
                <td className="px-3 py-3"><SaleStatus sale={sale} refundCents={getActiveRefundTotal(refundsBySale.get(sale.id) ?? [])} /></td>
                <td className="px-3 py-3 text-right">
                  <button
                    type="button"
                    onClick={() => onSelect(sale)}
                    className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-[#e6dfeb] px-2.5 text-[10px] font-bold text-[#65479c] transition hover:bg-[#f3eff8]"
                    aria-label={`Abrir detalhes da venda ${sale.productName}`}
                    data-testid={`${testId}-details-${sale.id}`}
                  >
                    <FileText size={12} aria-hidden="true" /> Abrir
                  </button>
                </td>
              </tr>
            ))}
            {!pageData.rows.length && (
              <tr><td colSpan={8} className="px-4 py-8 text-center text-xs text-[#827b8b]" data-testid={`${testId}-empty`}>Nenhuma venda encontrada com estes filtros.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-3 flex flex-col gap-2 text-[10px] text-[#827b8b] sm:flex-row sm:items-center sm:justify-between">
        <span data-testid={`${testId}-count`}>{pageData.total} {pageData.total === 1 ? "venda" : "vendas"} · página {pageData.page} de {pageData.pageCount}</span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={pageData.page <= 1}
            onClick={() => setPage((value) => Math.max(1, value - 1))}
            className="inline-flex h-8 items-center gap-1 rounded-lg border border-[#e7e2ea] px-2.5 font-bold text-[#65479c] disabled:cursor-not-allowed disabled:opacity-40"
            data-testid={`${testId}-previous`}
          ><ChevronLeft size={13} /> Anterior</button>
          <button
            type="button"
            disabled={pageData.page >= pageData.pageCount}
            onClick={() => setPage((value) => Math.min(pageData.pageCount, value + 1))}
            className="inline-flex h-8 items-center gap-1 rounded-lg border border-[#e7e2ea] px-2.5 font-bold text-[#65479c] disabled:cursor-not-allowed disabled:opacity-40"
            data-testid={`${testId}-next`}
          >Próxima <ChevronRight size={13} /></button>
        </div>
      </div>
    </div>
  );
}

function SaleDetailsDialog({
  sale,
  refunds,
  onClose,
}: {
  sale: Sale | null;
  refunds: SalesRefundRecord[];
  onClose: () => void;
}) {
  const { data: history, isLoading, isError, refetch } = useGetSaleHistory(sale?.id ?? "", {
    query: {
      queryKey: getGetSaleHistoryQueryKey(sale?.id ?? ""),
      enabled: Boolean(sale),
      refetchOnMount: "always",
    },
  });

  if (!sale) return null;
  const activeRefunds = refunds.filter((refund) => refund.status === "active");
  const operationLabels: Record<string, string> = {
    create: "Venda registrada",
    import: "Venda importada",
    update: "Venda editada",
    cancel: "Venda cancelada",
    restore: "Restaurada do backup",
    "restore-update": "Dados do backup restaurados",
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[calc(100dvh-1.5rem)] w-[calc(100vw-1.5rem)] max-w-xl overflow-y-auto border-[#e7e1e9] bg-[#fffefc] p-4 sm:rounded-[24px] sm:p-6">
        <DialogHeader className="text-left">
          <DialogTitle className="text-lg font-extrabold tracking-[-.035em] text-[#332d40]">Detalhes da venda</DialogTitle>
          <DialogDescription className="text-xs leading-5 text-[#827b8b]">A ficha e o histórico de alterações ficam nesta tela; seus filtros permanecem preservados.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 rounded-2xl bg-[#f8f6fa] p-4 sm:grid-cols-2" data-testid={`scoreboard-sale-detail-${sale.id}`}>
          <div><p className="text-[9px] font-bold uppercase tracking-[.08em] text-[#81798b]">Produto</p><p className="mt-1 break-words text-sm font-extrabold text-[#40374e]">{sale.productName}</p></div>
          <div><p className="text-[9px] font-bold uppercase tracking-[.08em] text-[#81798b]">Setor / modalidade atual</p><p className="mt-1 break-words text-sm font-semibold text-[#40374e]">{classifySaleSector(sale).label}</p></div>
          <div><p className="text-[9px] font-bold uppercase tracking-[.08em] text-[#81798b]">Cliente</p><p className="mt-1 break-words text-sm font-semibold text-[#5d4a78]">{sale.customerName || "Não informado"}</p></div>
          <div><p className="text-[9px] font-bold uppercase tracking-[.08em] text-[#81798b]">Data da venda</p><p className="mt-1 text-sm font-semibold text-[#40374e]">{formatDate(sale.saleDate)}</p></div>
          <div><p className="text-[9px] font-bold uppercase tracking-[.08em] text-[#81798b]">Situação</p><div className="mt-1"><SaleStatus sale={sale} refundCents={getActiveRefundTotal(refunds)} /></div></div>
          <div><p className="text-[9px] font-bold uppercase tracking-[.08em] text-[#81798b]">Quantidade</p><p className="mt-1 text-sm font-semibold text-[#40374e]">{sale.quantity.toLocaleString("pt-BR")} un.</p></div>
          <div><p className="text-[9px] font-bold uppercase tracking-[.08em] text-[#81798b]">Valor unitário</p><p className="mt-1 text-sm font-semibold text-[#40374e]">{formatCents(sale.unitAmountCents)}</p></div>
          <div><p className="text-[9px] font-bold uppercase tracking-[.08em] text-[#81798b]">Total da venda</p><p className="mt-1 text-sm font-extrabold text-[#40374e]">{formatCents(sale.totalCents)}</p></div>
          <div><p className="text-[9px] font-bold uppercase tracking-[.08em] text-[#81798b]">Estornos ativos</p><p className="mt-1 text-sm font-semibold text-[#9a625b]">{formatCents(getActiveRefundTotal(refunds))}</p></div>
          {sale.notes && <div className="sm:col-span-2"><p className="text-[9px] font-bold uppercase tracking-[.08em] text-[#81798b]">Observação</p><p className="mt-1 break-words text-xs leading-5 text-[#5f5967]">{sale.notes}</p></div>}
          {sale.cancellationReason && <div className="sm:col-span-2"><p className="text-[9px] font-bold uppercase tracking-[.08em] text-[#81798b]">Motivo do cancelamento</p><p className="mt-1 break-words text-xs leading-5 text-[#9a625b]">{sale.cancellationReason}</p></div>}
        </div>
        <section aria-labelledby={`refunds-${sale.id}`}>
          <h3 id={`refunds-${sale.id}`} className="text-xs font-extrabold text-[#40374e]">Estornos vinculados</h3>
          {activeRefunds.length ? <ul className="mt-2 space-y-2" data-testid={`list-sale-refunds-${sale.id}`}>
            {activeRefunds.map((refund) => (
              <li key={refund.id} className="flex flex-col gap-1 rounded-xl border border-[#eeeaf0] px-3.5 py-3 text-xs sm:flex-row sm:items-start sm:justify-between">
                <div><p className="font-bold text-[#40374e]">{formatDate(refund.refundDate)} · {formatCents(refund.amountCents)}</p><p className="mt-1 break-words text-[10px] leading-4 text-[#817b89]">{refund.reason}</p></div>
                <span className="text-[10px] font-bold text-[#835d27]">Ativo</span>
              </li>
            ))}
          </ul> : <p className="mt-2 rounded-xl border border-dashed border-[#ded7e7] px-3 py-4 text-center text-[11px] text-[#827b8b]" data-testid={`status-sale-refunds-empty-${sale.id}`}>Nenhum estorno ativo vinculado.</p>}
        </section>
        <section aria-labelledby={`sale-audit-${sale.id}`}>
          <h3 id={`sale-audit-${sale.id}`} className="text-xs font-extrabold text-[#40374e]">Histórico de alterações</h3>
          {isLoading ? <div className="mt-2 skeleton h-16 rounded-xl" role="status" data-testid="status-scoreboard-sale-audit-loading" />
            : isError ? <div className="mt-2 rounded-xl border border-dashed border-[#ded7e7] p-4 text-center text-xs text-[#817b89]" role="alert"><p>Não foi possível carregar o histórico de auditoria.</p><button type="button" onClick={() => void refetch()} className="mt-2 font-bold text-[#6848a9] underline">Tentar novamente</button></div>
              : history?.length ? <ol className="mt-2 max-h-48 space-y-2 overflow-y-auto" data-testid={`list-scoreboard-sale-audit-${sale.id}`}>
                {history.map((entry: SalesHistoryEntry) => (
                  <li key={entry.id} className="rounded-xl border border-[#eeeaf0] px-3.5 py-3">
                    <div className="flex flex-wrap items-start justify-between gap-2"><p className="text-xs font-bold text-[#40374e]">{operationLabels[entry.operation] ?? "Registro atualizado"}</p><time className="text-[10px] text-[#8a8491]" dateTime={entry.createdAt}>{new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Sao_Paulo" }).format(new Date(entry.createdAt))}</time></div>
                    <p className="mt-1.5 text-[9px] text-[#9a94a0]">Equipe autorizada</p>
                  </li>
                ))}
              </ol> : <p className="mt-2 rounded-xl border border-dashed border-[#ded7e7] px-3 py-4 text-center text-[11px] text-[#827b8b]">Nenhuma alteração registrada.</p>}
        </section>
        <DialogFooter><button type="button" onClick={onClose} className="h-10 w-full rounded-xl border border-[#e3dfe7] px-4 text-sm font-bold text-[#716a79] hover:bg-[#f8f6fa] sm:w-auto" data-testid="button-close-scoreboard-sale-detail">Fechar</button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ScoreboardSalesHistory({
  sales,
  periodRefunds,
  isLoading,
  isError,
  pdfDisabled,
  onRetry,
  refunds,
  productSummaries,
  totals,
  months,
  periodMonthKeys,
  periodLabel,
  filterLabel,
  rangeFrom,
  rangeTo,
  weekdays,
  weekdayForDate,
  selectedProduct,
  onProductDialogClose,
}: {
  sales: Sale[];
  periodRefunds: SalesRefundRecord[];
  isLoading: boolean;
  isError: boolean;
  pdfDisabled: boolean;
  onRetry: () => void;
  refunds: SalesRefundRecord[];
  productSummaries: SalesScoreboardProduct[];
  totals: { saleCount: number; quantity: number; salesCents: number; refundCents: number; netCents: number };
  months: SalesScoreboardMonth[];
  periodMonthKeys: string[];
  periodLabel: string;
  filterLabel: string;
  rangeFrom?: string;
  rangeTo?: string;
  weekdays: number[];
  weekdayForDate: (date: string) => number | null;
  selectedProduct: SalesScoreboardProduct | null;
  onProductDialogClose: () => void;
}) {
  const [selectedSale, setSelectedSale] = useState<Sale | null>(null);
  const [includeHistory, setIncludeHistory] = useState(false);
  const [includeMonthlyHistory, setIncludeMonthlyHistory] = useState(false);
  const [includeCustomerNames, setIncludeCustomerNames] = useState(false);

  const refundsBySale = useMemo(() => {
    const map = new Map<string, SalesRefundRecord[]>();
    for (const refund of refunds) {
      map.set(refund.saleId, [...(map.get(refund.saleId) ?? []), refund]);
    }
    return map;
  }, [refunds]);
  const selectedProductSales = useMemo(
    () => selectedProduct
      ? sales.filter((sale) => selectedProduct.productId
        ? (sale.resolvedProductId ?? sale.productId) === selectedProduct.productId
        : sale.productId === null && sale.productName === selectedProduct.productName)
      : [],
    [sales, selectedProduct],
  );
  const selectedProductRows = useMemo(
    () => selectedProduct
      ? productSummaries.filter((product) => selectedProduct.productId
        ? product.productId === selectedProduct.productId
        : product.productId === null && product.productName === selectedProduct.productName)
      : [],
    [productSummaries, selectedProduct],
  );
  const selectedProductTotals = useMemo(
    () => sumSalesScoreboardProducts(selectedProductRows),
    [selectedProductRows],
  );
  const selectedProductChannelGroups = useMemo(
    () => buildSalesSectorGroups(selectedProductRows),
    [selectedProductRows],
  );
  const matchesSelectedPeriod = (date: string) => (
    (!rangeFrom || date >= rangeFrom)
    && (!rangeTo || date <= rangeTo)
    && (!weekdays.length || weekdays.includes(weekdayForDate(date) ?? 0))
  );
  const productMonthlyHistory = useMemo(
    () => selectedProduct
      ? buildProductMonthlySalesSummary(sales, periodRefunds, selectedProduct, periodMonthKeys, matchesSelectedPeriod)
      : [],
    [sales, periodRefunds, selectedProduct, periodMonthKeys, rangeFrom, rangeTo, weekdays, weekdayForDate],
  );
  const distinctProductCount = new Set(productSummaries.map((product) => (
    product.productId
      ?? product.productName.trim().replace(/\s+/g, " ").toLocaleLowerCase("pt-BR")
  ))).size;
  const summaryRows = [
    ["Vendas registradas", totals.saleCount.toLocaleString("pt-BR")],
    ["Unidades vendidas", totals.quantity.toLocaleString("pt-BR")],
    ["Faturamento bruto", formatCents(totals.salesCents)],
    ["Estornos", formatCents(totals.refundCents)],
    ["Faturamento líquido", formatCents(totals.netCents)],
    ["Produtos com movimentação", distinctProductCount.toLocaleString("pt-BR")],
  ];
  const salesSectorGroups = useMemo(() => buildSalesSectorGroups(productSummaries), [productSummaries]);
  const monthRows = months.map((month) => [
    month.month,
    month.saleCount.toLocaleString("pt-BR"),
    month.quantity.toLocaleString("pt-BR"),
    formatCents(month.salesCents),
    formatCents(month.refundCents),
    formatCents(month.netCents),
  ]);
  const historyRows = sales.map((sale) => [
    formatDate(sale.saleDate),
    classifySaleSector(sale).label,
    sale.productName,
    ...(includeCustomerNames ? [sale.customerName || "Não informado"] : []),
    sale.quantity.toLocaleString("pt-BR"),
    formatCents(sale.totalCents),
    saleStatusLabel(sale, getActiveRefundTotal(refundsBySale.get(sale.id) ?? [])),
  ]);
  const productHistoryRows = selectedProductSales.map((sale) => [
    formatDate(sale.saleDate),
    classifySaleSector(sale).label,
    sale.productName,
    ...(includeCustomerNames ? [sale.customerName || "Não informado"] : []),
    sale.quantity.toLocaleString("pt-BR"),
    formatCents(sale.totalCents),
    saleStatusLabel(sale, getActiveRefundTotal(refundsBySale.get(sale.id) ?? [])),
  ]);
  const headerFilters = `${filterLabel} · ${distinctProductCount} ${distinctProductCount === 1 ? "produto" : "produtos"}`;
  const activeSaleCount = sales.filter((sale) => sale.status === "active").length;
  const activeSaleCents = sales.reduce(
    (sum, sale) => sum + (sale.status === "active" ? sale.totalCents : 0),
    0,
  );
  const activeProductSaleCount = selectedProductSales.filter((sale) => sale.status === "active").length;
  const activeProductSaleCents = selectedProductSales.reduce(
    (sum, sale) => sum + (sale.status === "active" ? sale.totalCents : 0),
    0,
  );
  const productChannelLabels = [...new Set(selectedProductChannelGroups
    .filter((group) => group.products.length > 0)
    .map((group) => group.label))];

  return (
    <>
      <section className="overflow-hidden rounded-[22px] border border-[#e7e1e9] bg-[#fffefc]" aria-labelledby="scoreboard-sales-history-heading" data-testid="scoreboard-sales-history">
        <div className="flex flex-col gap-3 border-b border-[#ece7ee] px-4 py-4 sm:px-5 xl:flex-row xl:items-end xl:justify-between">
          <div>
            <p className="eyebrow text-[9px] font-bold text-[#8a8491]">movimentações do período</p>
            <h2 id="scoreboard-sales-history-heading" className="mt-1 text-base font-extrabold tracking-[-.035em] text-[#332d40]">Histórico de Vendas do Período</h2>
            <p className="mt-1 text-[10px] text-[#837b8b]">{periodLabel} · Cada venda aparece em uma única linha.</p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
            <label className="inline-flex items-center gap-2 text-[10px] font-semibold text-[#6b6474]" data-pdf-hide-on-export>
              <input type="checkbox" checked={includeMonthlyHistory} onChange={(event) => setIncludeMonthlyHistory(event.target.checked)} className="accent-[#7656b8]" data-testid="checkbox-scoreboard-pdf-monthly-history" />
              Incluir histórico mensal
            </label>
            <label className="inline-flex items-center gap-2 text-[10px] font-semibold text-[#6b6474]" data-pdf-hide-on-export>
              <input type="checkbox" checked={includeHistory} onChange={(event) => setIncludeHistory(event.target.checked)} className="accent-[#7656b8]" data-testid="checkbox-scoreboard-pdf-history" />
              Incluir lista de vendas no PDF
            </label>
            {includeHistory && <label className="inline-flex items-center gap-2 text-[10px] font-semibold text-[#6b6474]" data-pdf-hide-on-export>
              <input type="checkbox" checked={includeCustomerNames} onChange={(event) => setIncludeCustomerNames(event.target.checked)} className="accent-[#7656b8]" data-testid="checkbox-scoreboard-pdf-customer-names" />
              Incluir nomes de clientes (opcional)
            </label>}
            <button
              type="button"
              onClick={() => void beginDashboardPdf("scoreboard", "Relatorio-Scoreboard", periodLabel, { includeDetails: includeHistory })}
              disabled={pdfDisabled || isLoading || isError}
              className="dashboard-pdf-hide inline-flex h-9 items-center justify-center gap-2 rounded-lg bg-[#7656b8] px-3 text-[11px] font-bold text-white transition hover:bg-[#6748a7] disabled:cursor-not-allowed disabled:opacity-50"
              data-testid="button-scoreboard-download-pdf"
            ><Download size={13} aria-hidden="true" /> Baixar Ficha de Vendas (PDF)</button>
          </div>
        </div>
        <div className="p-4 sm:p-5">
          {isLoading ? <div className="skeleton h-40 rounded-xl" role="status" aria-label="Carregando histórico de vendas" data-testid="scoreboard-history-loading" />
            : isError ? <div className="rounded-xl border border-dashed border-[#ded7e7] p-5 text-center text-xs text-[#817b89]" role="alert" data-testid="scoreboard-history-error"><p>Não foi possível carregar o histórico de vendas.</p><button type="button" onClick={onRetry} className="mt-2 font-bold text-[#6848a9] underline">Tentar novamente</button></div>
              : <SalesHistoryTable
                sales={sales}
                refundsBySale={refundsBySale}
                onSelect={setSelectedSale}
                testId="scoreboard-history"
              />}
        </div>
      </section>

      <section className="pdf-report-root dashboard-pdf-only" data-pdf-panel="scoreboard" aria-label="Relatório PDF do Scoreboard">
        <PdfPrintHeader title="Scoreboard — Histórico de Vendas" period={periodLabel} filters={headerFilters} />
        <p className="mt-2 text-[9pt] text-[#77717f]">Gerado em {formatGeneratedAt()}</p>
        <h2 className="mt-4 text-[12pt] font-extrabold text-[#40374e]">Resumo do período</h2>
        <PdfPrintTable headers={["Indicador", "Resultado"]} rows={summaryRows} />
        {salesSectorGroups.map((group) => (
          <section key={group.key} className="dashboard-pdf-channel-section">
            <h2 className="mt-5 text-[12pt] font-extrabold text-[#40374e]">{group.label}</h2>
            <PdfPrintTable
              headers={["Produto", "Vendas", "Unidades", "Bruto", "Estornos", "Líquido"]}
              rows={group.products.map((product) => [
                product.productName,
                product.saleCount.toLocaleString("pt-BR"),
                product.quantity.toLocaleString("pt-BR"),
                formatCents(product.salesCents),
                formatCents(product.refundCents),
                formatCents(product.netCents),
              ])}
              summary={[
                "Subtotal",
                group.totals.saleCount.toLocaleString("pt-BR"),
                group.totals.quantity.toLocaleString("pt-BR"),
                formatCents(group.totals.salesCents),
                formatCents(group.totals.refundCents),
                formatCents(group.totals.netCents),
              ]}
            />
          </section>
        ))}
        <h2 className="mt-5 text-[12pt] font-extrabold text-[#40374e]">Total geral consolidado</h2>
        <PdfPrintTable
          headers={["Vendas", "Unidades", "Faturamento bruto", "Estornos", "Faturamento líquido"]}
          rows={[[totals.saleCount.toLocaleString("pt-BR"), totals.quantity.toLocaleString("pt-BR"), formatCents(totals.salesCents), formatCents(totals.refundCents), formatCents(totals.netCents)]]}
        />
        {includeMonthlyHistory && months.length > 0 && <>
          <h2 className="mt-5 text-[12pt] font-extrabold text-[#40374e]">Resumo mensal</h2>
          <PdfPrintTable headers={["Mês / ano", "Vendas", "Quantidade", "Vendas brutas", "Estornos", "Líquido"]} rows={monthRows} />
        </>}
        <div className="dashboard-pdf-appendix" data-pdf-appendix="scoreboard">
          <h2 className="mt-5 text-[12pt] font-extrabold text-[#40374e]">Detalhamento das vendas</h2>
          <PdfPrintTable
            headers={["Data", "Setor / modalidade", "Produto", ...(includeCustomerNames ? ["Cliente"] : []), "Quantidade", "Valor bruto", "Situação"]}
            rows={historyRows}
            summary={includeCustomerNames
              ? ["Vendas ativas", "", "", "", activeSaleCount.toLocaleString("pt-BR"), formatCents(activeSaleCents), ""]
              : ["Vendas ativas", "", "", activeSaleCount.toLocaleString("pt-BR"), formatCents(activeSaleCents), ""]}
          />
        </div>
      </section>

      {selectedProduct && <>
        <Dialog open onOpenChange={(open) => { if (!open) onProductDialogClose(); }}>
          <DialogContent className="max-h-[calc(100dvh-1.5rem)] w-[calc(100vw-1.5rem)] max-w-5xl overflow-y-auto border-[#e7e1e9] bg-[#fffefc] p-4 sm:rounded-[24px] sm:p-6" data-testid="dialog-scoreboard-product-details">
            <DialogHeader className="text-left">
              <DialogTitle className="text-lg font-extrabold tracking-[-.035em] text-[#332d40]">Detalhes de {selectedProduct.productName}</DialogTitle>
              <DialogDescription className="text-xs leading-5 text-[#827b8b]">Vendas do produto no mesmo período e com os mesmos filtros do Scoreboard: {periodLabel}.</DialogDescription>
            </DialogHeader>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6" data-testid="scoreboard-product-detail-summary">
              {[
                ["Vendas", selectedProductTotals.saleCount.toLocaleString("pt-BR")],
                ["Unidades", selectedProductTotals.quantity.toLocaleString("pt-BR")],
                ["Bruto", formatCents(selectedProductTotals.salesCents)],
                ["Estornos", formatCents(selectedProductTotals.refundCents)],
                ["Líquido", formatCents(selectedProductTotals.netCents)],
                ["Período", periodLabel],
              ].map(([label, value]) => <article key={label} className="min-w-0 rounded-xl bg-[#f8f6fa] px-3 py-3"><p className="text-[9px] font-bold uppercase tracking-[.08em] text-[#81798b]">{label}</p><p className="mt-1 break-words text-xs font-extrabold text-[#40374e]">{value}</p></article>)}
            </div>
            <p className="rounded-xl bg-[#f8f5fb] px-3.5 py-2.5 text-[10px] text-[#716879]" data-testid="scoreboard-product-detail-channel">
              Setor / modalidade no período: {productChannelLabels.length ? productChannelLabels.join(", ") : "Sem dados classificados"}
              {selectedProduct.modalityName ? ` · Classificação atual do produto: ${selectedProduct.modalityName}` : ""}
            </p>
            <section>
              <h3 className="mb-2 text-xs font-extrabold text-[#40374e]">Histórico do produto no período</h3>
              {isLoading ? <div className="skeleton h-40 rounded-xl" role="status" aria-label="Carregando vendas do produto" />
                : isError ? <div className="rounded-xl border border-dashed border-[#ded7e7] p-5 text-center text-xs text-[#817b89]" role="alert"><p>Não foi possível carregar as vendas deste produto.</p><button type="button" onClick={onRetry} className="mt-2 font-bold text-[#6848a9] underline">Tentar novamente</button></div>
                  : <SalesHistoryTable sales={selectedProductSales} refundsBySale={refundsBySale} onSelect={setSelectedSale} testId="scoreboard-product-history" />}
            </section>
            <DialogFooter className="flex-col gap-2 sm:flex-row">
              <button
                type="button"
                onClick={() => void beginDashboardPdf("scoreboard-product", `Ficha-${selectedProduct.productName}`, periodLabel, { includeDetails: includeHistory })}
                disabled={pdfDisabled || isLoading || isError}
                className="dashboard-pdf-hide inline-flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-[#7656b8] px-4 text-sm font-bold text-white hover:bg-[#6748a7] disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
                data-testid="button-scoreboard-product-pdf"
              ><Download size={14} aria-hidden="true" /> Baixar Ficha de Vendas (PDF)</button>
              <button type="button" onClick={onProductDialogClose} className="h-10 w-full rounded-xl border border-[#e3dfe7] px-4 text-sm font-bold text-[#716a79] hover:bg-[#f8f6fa] sm:w-auto" data-testid="button-close-scoreboard-product-details">Fechar</button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        <section className="pdf-report-root dashboard-pdf-only" data-pdf-panel="scoreboard-product" aria-label={`PDF de ${selectedProduct.productName}`}>
          <PdfPrintHeader title={`Ficha de vendas — ${selectedProduct.productName}`} period={periodLabel} filters={`${filterLabel} · Produto: ${selectedProduct.productName}`} />
          <p className="mt-2 text-[9pt] text-[#77717f]">Gerado em {formatGeneratedAt()}</p>
          <h2 className="mt-4 text-[12pt] font-extrabold text-[#40374e]">Resumo do produto</h2>
          <PdfPrintTable
            headers={["Setor / modalidade", "Vendas", "Unidades", "Faturamento bruto", "Estornos", "Faturamento líquido"]}
            rows={selectedProductChannelGroups
              .filter((group) => group.products.length > 0)
              .map((group) => [
                group.label,
                group.totals.saleCount.toLocaleString("pt-BR"),
                group.totals.quantity.toLocaleString("pt-BR"),
                formatCents(group.totals.salesCents),
                formatCents(group.totals.refundCents),
                formatCents(group.totals.netCents),
              ])}
            summary={["Total do produto", selectedProductTotals.saleCount.toLocaleString("pt-BR"), selectedProductTotals.quantity.toLocaleString("pt-BR"), formatCents(selectedProductTotals.salesCents), formatCents(selectedProductTotals.refundCents), formatCents(selectedProductTotals.netCents)]}
          />
          {includeMonthlyHistory && <>
            <h2 className="mt-5 text-[12pt] font-extrabold text-[#40374e]">Histórico mensal do produto</h2>
            <PdfPrintTable
              headers={["Mês / ano", "Vendas", "Unidades", "Faturamento bruto", "Estornos", "Faturamento líquido"]}
              rows={productMonthlyHistory.map((month) => [
                month.month,
                month.saleCount.toLocaleString("pt-BR"),
                month.quantity.toLocaleString("pt-BR"),
                formatCents(month.salesCents),
                formatCents(month.refundCents),
                formatCents(month.netCents),
              ])}
              summary={["Total", selectedProductTotals.saleCount.toLocaleString("pt-BR"), selectedProductTotals.quantity.toLocaleString("pt-BR"), formatCents(selectedProductTotals.salesCents), formatCents(selectedProductTotals.refundCents), formatCents(selectedProductTotals.netCents)]}
            />
          </>}
          <div className="dashboard-pdf-appendix" data-pdf-appendix="scoreboard-product">
            <h2 className="mt-5 text-[12pt] font-extrabold text-[#40374e]">Histórico de vendas</h2>
            <PdfPrintTable
              headers={["Data", "Canal", "Produto", ...(includeCustomerNames ? ["Cliente"] : []), "Quantidade", "Valor bruto", "Situação"]}
              rows={productHistoryRows}
              summary={includeCustomerNames
                ? ["Vendas ativas", "", "", "", activeProductSaleCount.toLocaleString("pt-BR"), formatCents(activeProductSaleCents), ""]
                : ["Vendas ativas", "", "", activeProductSaleCount.toLocaleString("pt-BR"), formatCents(activeProductSaleCents), ""]}
            />
          </div>
        </section>
      </>}

      <SaleDetailsDialog
        sale={selectedSale}
        refunds={selectedSale ? refundsBySale.get(selectedSale.id) ?? [] : []}
        onClose={() => setSelectedSale(null)}
      />
    </>
  );
}
