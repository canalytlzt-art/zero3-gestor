import type { Sale, SalesRefundRecord, SalesScoreboardProduct } from "@workspace/api-client-react";

export type SalesHistoryStatusFilter = "active" | "cancelled" | "all";
export type SalesHistorySort =
  | "date-newest"
  | "date-oldest"
  | "product"
  | "customer"
  | "amount-high"
  | "amount-low";

export interface ScoreboardSalesScope {
  months: string[];
  fromDate?: string;
  toDate?: string;
  productId?: string;
  weekdays?: number[];
  weekdayForDate: (date: string) => number | null;
}

export interface ProductMonthlySalesSummary {
  month: string;
  saleCount: number;
  quantity: number;
  salesCents: number;
  refundCents: number;
  netCents: number;
}

export function buildProductMonthlySalesSummary(
  sales: Sale[],
  refunds: SalesRefundRecord[],
  product: SalesScoreboardProduct,
  monthKeys: string[],
  dateMatches: (date: string) => boolean,
): ProductMonthlySalesSummary[] {
  const monthTotals = new Map<string, ProductMonthlySalesSummary>();
  for (const month of [...new Set(monthKeys)].sort()) {
    monthTotals.set(month, { month, saleCount: 0, quantity: 0, salesCents: 0, refundCents: 0, netCents: 0 });
  }
  const isProduct = (row: { productId: string | null; productName: string }) =>
    product.productId !== null
      ? row.productId === product.productId
      : row.productId === null && row.productName === product.productName;

  for (const sale of sales) {
    const month = sale.saleDate.slice(0, 7);
    if (sale.status !== "active" || !isProduct(sale) || !dateMatches(sale.saleDate.slice(0, 10))) continue;
    const summary = monthTotals.get(month);
    if (!summary) continue;
    summary.saleCount += 1;
    summary.quantity += sale.quantity;
    summary.salesCents += sale.totalCents;
  }

  for (const refund of refunds) {
    const month = refund.refundDate.slice(0, 7);
    if (
      refund.status !== "active"
      || refund.saleStatus !== "active"
      || !isProduct(refund)
      || !dateMatches(refund.refundDate.slice(0, 10))
    ) continue;
    const summary = monthTotals.get(month);
    if (summary) summary.refundCents += refund.amountCents;
  }

  return [...monthTotals.values()].map((summary) => ({
    ...summary,
    netCents: summary.salesCents - summary.refundCents,
  }));
}

function normalizedSearch(value: string) {
  return value.trim().toLocaleLowerCase("pt-BR");
}

export function filterSalesForScoreboard(
  sales: Sale[],
  scope: ScoreboardSalesScope,
): Sale[] {
  const uniqueSales = new Map<string, Sale>();

  for (const sale of sales) {
    const date = sale.saleDate.slice(0, 10);
    if (scope.fromDate && date < scope.fromDate) continue;
    if (scope.toDate && date > scope.toDate) continue;
    if (!scope.fromDate && !scope.toDate && !scope.months.includes(date.slice(0, 7))) continue;
    if (scope.productId && sale.productId !== scope.productId) continue;
    if (scope.weekdays?.length) {
      const weekday = scope.weekdayForDate(date);
      if (weekday === null || !scope.weekdays.includes(weekday)) continue;
    }
    uniqueSales.set(sale.id, sale);
  }

  return [...uniqueSales.values()].sort(
    (a, b) => b.saleDate.localeCompare(a.saleDate) || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
  );
}

export function sortAndFilterSalesHistory(
  sales: Sale[],
  options: {
    search?: string;
    status?: SalesHistoryStatusFilter;
    sort?: SalesHistorySort;
  } = {},
): Sale[] {
  const search = normalizedSearch(options.search ?? "");
  const status = options.status ?? "active";
  const uniqueSales = new Map(sales.map((sale) => [sale.id, sale]));
  const filtered = [...uniqueSales.values()].filter((sale) => {
    if (status !== "all" && sale.status !== status) return false;
    if (!search) return true;
    return [
      sale.productName,
      sale.customerName ?? "",
      sale.saleDate,
      sale.status === "cancelled" ? "cancelada" : "ativa",
    ].some((value) => normalizedSearch(value).includes(search));
  });

  const sort = options.sort ?? "date-newest";
  const compareText = (left: string, right: string) =>
    left.localeCompare(right, "pt-BR", { sensitivity: "base" }) || left.localeCompare(right);

  return filtered.sort((a, b) => {
    switch (sort) {
      case "date-oldest":
        return a.saleDate.localeCompare(b.saleDate) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
      case "product":
        return compareText(a.productName, b.productName) || b.saleDate.localeCompare(a.saleDate) || a.id.localeCompare(b.id);
      case "customer":
        return compareText(a.customerName ?? "", b.customerName ?? "") || b.saleDate.localeCompare(a.saleDate) || a.id.localeCompare(b.id);
      case "amount-high":
        return b.totalCents - a.totalCents || b.saleDate.localeCompare(a.saleDate) || a.id.localeCompare(b.id);
      case "amount-low":
        return a.totalCents - b.totalCents || b.saleDate.localeCompare(a.saleDate) || a.id.localeCompare(b.id);
      case "date-newest":
      default:
        return b.saleDate.localeCompare(a.saleDate) || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id);
    }
  });
}

export function paginateSalesHistory<T>(
  sales: T[],
  page: number,
  pageSize: number,
) {
  const safeSize = Math.max(1, Math.floor(pageSize));
  const pageCount = Math.max(1, Math.ceil(sales.length / safeSize));
  const safePage = Math.min(pageCount, Math.max(1, Math.floor(page)));
  const start = (safePage - 1) * safeSize;
  return {
    rows: sales.slice(start, start + safeSize),
    page: safePage,
    pageCount,
    total: sales.length,
  };
}
