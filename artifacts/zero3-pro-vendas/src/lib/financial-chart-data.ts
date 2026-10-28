import type { SalesScoreboard, SalesScoreboardProduct } from '@workspace/api-client-react';

export interface FinancialChartRow {
  key: string;
  name: string;
  productId: string | null;
  modalityId: string | null;
  quantity: number;
  salesCents: number;
  refundCents: number;
  netCents: number;
}

export interface FinancialMonthRow {
  month: string;
  quantity: number;
  salesCents: number;
  refundCents: number;
  netCents: number;
}

export interface FinancialDayRow {
  date: string;
  weekday: number;
  quantity: number;
  salesCents: number;
  refundCents: number;
  netCents: number;
}

export interface FinancialWeekRow {
  weekStart: string;
  quantity: number;
  salesCents: number;
  refundCents: number;
  netCents: number;
}

export interface FinancialShareRow {
  key: string;
  name: string;
  salesCents: number;
}

function productRowKey(product: SalesScoreboardProduct) {
  return product.productId ?? `unlinked:${product.productName.toLocaleLowerCase('pt-BR')}`;
}

export function buildFinancialChartAnalytics(report: SalesScoreboard) {
  const byProduct: FinancialChartRow[] = report.products.map((product) => ({
    key: productRowKey(product),
    name: product.productName,
    productId: product.productId,
    modalityId: product.modalityId,
    quantity: product.quantity,
    salesCents: product.salesCents,
    refundCents: product.refundCents,
    netCents: product.netCents,
  }));

  const modalityRows = new Map<string, FinancialChartRow>();
  for (const product of byProduct) {
    const key = product.modalityId ?? '__unclassified__';
    const name = product.modalityId ? report.products.find((item) => item.modalityId === product.modalityId)?.modalityName ?? 'Modalidade sem nome' : 'Não classificado';
    const current = modalityRows.get(key) ?? {
      key,
      name,
      productId: null,
      modalityId: product.modalityId,
      quantity: 0,
      salesCents: 0,
      refundCents: 0,
      netCents: 0,
    };
    current.quantity += product.quantity;
    current.salesCents += product.salesCents;
    current.refundCents += product.refundCents;
    current.netCents += product.netCents;
    modalityRows.set(key, current);
  }

  const byModality = [...modalityRows.values()].sort((a, b) => (
    b.salesCents - a.salesCents || a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' })
  ));
  const salesShareByModality: FinancialShareRow[] = byModality
    .filter((row) => row.salesCents > 0)
    .map(({ key, name, salesCents }) => ({ key, name, salesCents }));
  const salesShareByProduct: FinancialShareRow[] = byProduct
    .filter((row) => row.salesCents > 0)
    .map(({ key, name, salesCents }) => ({ key, name, salesCents }));
  const months: FinancialMonthRow[] = report.months.map((month) => ({
    month: month.month,
    quantity: month.quantity,
    salesCents: month.salesCents,
    refundCents: month.refundCents,
    netCents: month.netCents,
  }));
  const days: FinancialDayRow[] = report.days.map((day) => ({
    date: day.date,
    weekday: day.weekday,
    quantity: day.quantity,
    salesCents: day.salesCents,
    refundCents: day.refundCents,
    netCents: day.netCents,
  }));
  const weeks: FinancialWeekRow[] = report.weeks.map((week) => ({
    weekStart: week.weekStart,
    quantity: week.quantity,
    salesCents: week.salesCents,
    refundCents: week.refundCents,
    netCents: week.netCents,
  }));

  const productTotals = byProduct.reduce(
    (total, row) => ({
      quantity: total.quantity + row.quantity,
      salesCents: total.salesCents + row.salesCents,
      refundCents: total.refundCents + row.refundCents,
      netCents: total.netCents + row.netCents,
    }),
    { quantity: 0, salesCents: 0, refundCents: 0, netCents: 0 },
  );
  const monthTotals = months.reduce(
    (total, row) => ({
      quantity: total.quantity + row.quantity,
      salesCents: total.salesCents + row.salesCents,
      refundCents: total.refundCents + row.refundCents,
      netCents: total.netCents + row.netCents,
    }),
    { quantity: 0, salesCents: 0, refundCents: 0, netCents: 0 },
  );
  const matchesTotals = (value: typeof productTotals) => (
    value.quantity === report.totals.quantity
    && value.salesCents === report.totals.salesCents
    && value.refundCents === report.totals.refundCents
    && value.netCents === report.totals.netCents
  );

  return {
    byProduct,
    byModality,
    months,
    days,
    weeks,
    salesShareByModality,
    salesShareByProduct,
    totals: report.totals,
    reconcilesByProduct: matchesTotals(productTotals),
    reconcilesByMonth: matchesTotals(monthTotals),
  };
}
