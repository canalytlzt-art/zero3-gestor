import * as XLSX from 'xlsx';
import type { Product, Sale, SalesRefundRecord } from '@workspace/api-client-react';
import { productNameKey } from './sales-utils';

const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

type ExportFilters = {
  fromDate: string;
  toDate: string;
  productName: string;
  generatedAt: string;
};

type ProductTotals = {
  productId: string;
  productName: string;
  quantity: bigint;
  salesCents: bigint;
  refundsCents: bigint;
};

type MonthTotals = {
  month: string;
  quantity: bigint;
  salesCents: bigint;
  refundsCents: bigint;
};

function moneyForWorkbook(cents: bigint): number {
  if (cents > MAX_SAFE_INTEGER_BIGINT || cents < -MAX_SAFE_INTEGER_BIGINT) {
    throw new Error('O total excede a precisão numérica segura do Excel. Reduza o período do relatório.');
  }
  return Number(cents) / 100;
}

function integerForWorkbook(value: bigint): number {
  if (value > MAX_SAFE_INTEGER_BIGINT) throw new Error('A quantidade excede a precisão numérica segura do Excel.');
  return Number(value);
}

function setCurrencyFormat(worksheet: XLSX.WorkSheet, column: number, lastRow: number, firstRow = 1) {
  for (let row = firstRow; row <= lastRow; row += 1) {
    const address = XLSX.utils.encode_cell({ r: row, c: column });
    const cell = worksheet[address];
    if (cell?.t === 'n') cell.z = '"R$" #,##0.00;[Red]-"R$" #,##0.00';
  }
}

function setTextCells(worksheet: XLSX.WorkSheet, rows: number, columns: number[]) {
  for (let row = 0; row < rows; row += 1) {
    for (const column of columns) {
      const address = XLSX.utils.encode_cell({ r: row, c: column });
      const cell = worksheet[address];
      if (!cell || cell.v === undefined || cell.v === null) continue;
      cell.t = 's';
      cell.v = String(cell.v);
      delete cell.f;
    }
  }
}

function monthKey(date: string) {
  return date.slice(0, 7);
}

function monthsBetween(start: string, end: string): string[] {
  if (!start || !end || start.slice(0, 7) > end.slice(0, 7)) return [];
  const cursor = new Date(`${start.slice(0, 7)}-01T00:00:00.000Z`);
  const last = end.slice(0, 7);
  const months: string[] = [];
  while (cursor.toISOString().slice(0, 7) <= last) {
    months.push(cursor.toISOString().slice(0, 7));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return months;
}

function selected(saleDate: string, productId: string, name: string, filters: ExportFilters, productIds: Set<string>) {
  return (!filters.fromDate || saleDate >= filters.fromDate)
    && (!filters.toDate || saleDate <= filters.toDate)
    && (!filters.productName || (productIds.size > 0 ? productIds.has(productId) : productNameKey(name) === productNameKey(filters.productName)));
}

export function createSalesWorkbook(
  sales: Sale[],
  refunds: SalesRefundRecord[],
  products: Product[],
  filters: ExportFilters,
): XLSX.WorkBook {
  const currentNames = new Map(products.map((product) => [product.id, product.name]));
  const selectedProductIds = new Set([
    ...products.filter((product) => productNameKey(product.name) === productNameKey(filters.productName)).map(({ id }) => id),
    ...sales.filter((sale) => productNameKey(sale.productName) === productNameKey(filters.productName)).map(({ productId }) => productId),
  ]);
  const activeSales = sales.filter((sale) => sale.status === 'active' && selected(sale.saleDate, sale.productId, sale.productName, filters, selectedProductIds));
  const activeRefunds = refunds.filter((refund) => refund.status === 'active'
    && refund.saleStatus === 'active'
    && selected(refund.refundDate, refund.productId, refund.productName, filters, selectedProductIds));

  const workbook = XLSX.utils.book_new();
  const launchRows: (string | number | null)[][] = [
    ['Tipo', 'ID interno', 'Data da movimentação', 'Venda original', 'Data da venda original', 'ID do produto', 'Nome atual', 'Nome na venda', 'Quantidade', 'Valor unitário (R$)', 'Vendas (R$)', 'Estornos (R$)', 'Impacto após estornos (R$)', 'Observação/motivo'],
    ...activeSales.map((sale) => [
      'Venda',
      sale.id,
      sale.saleDate.split('-').reverse().join('/'),
      sale.id,
      sale.saleDate.split('-').reverse().join('/'),
      sale.productId,
      currentNames.get(sale.productId) ?? sale.productName,
      sale.productName,
      sale.quantity,
      moneyForWorkbook(BigInt(sale.unitAmountCents)),
      moneyForWorkbook(BigInt(sale.totalCents)),
      0,
      moneyForWorkbook(BigInt(sale.totalCents)),
      sale.notes ?? '',
    ]),
    ...activeRefunds.map((refund) => [
      'Estorno',
      refund.id,
      refund.refundDate.split('-').reverse().join('/'),
      refund.saleId,
      refund.saleDate.split('-').reverse().join('/'),
      refund.productId,
      currentNames.get(refund.productId) ?? refund.productName,
      refund.productName,
      null,
      null,
      0,
      moneyForWorkbook(BigInt(refund.amountCents)),
      moneyForWorkbook(-BigInt(refund.amountCents)),
      refund.reason,
    ]),
  ];
  launchRows.splice(1, launchRows.length - 1, ...launchRows.slice(1).sort((a, b) => {
    const firstDate = String(a[2] ?? '').split('/').reverse().join('-');
    const secondDate = String(b[2] ?? '').split('/').reverse().join('-');
    return secondDate.localeCompare(firstDate) || String(a[1]).localeCompare(String(b[1]));
  }));
  const launches = XLSX.utils.aoa_to_sheet(launchRows);
  launches['!cols'] = [{ wch: 13 }, { wch: 38 }, { wch: 18 }, { wch: 38 }, { wch: 18 }, { wch: 38 }, { wch: 28 }, { wch: 28 }, { wch: 13 }, { wch: 19 }, { wch: 17 }, { wch: 17 }, { wch: 24 }, { wch: 42 }];
  launches['!autofilter'] = { ref: `A1:N${Math.max(1, launchRows.length)}` };
  setCurrencyFormat(launches, 9, launchRows.length - 1);
  setCurrencyFormat(launches, 10, launchRows.length - 1);
  setCurrencyFormat(launches, 11, launchRows.length - 1);
  setCurrencyFormat(launches, 12, launchRows.length - 1);
  setTextCells(launches, launchRows.length, [0, 1, 2, 3, 4, 5, 6, 7, 13]);
  XLSX.utils.book_append_sheet(workbook, launches, 'Lançamentos');

  const byProduct = new Map<string, ProductTotals>();
  const byMonth = new Map<string, MonthTotals>();
  for (const sale of activeSales) {
    const currentName = currentNames.get(sale.productId) ?? sale.productName;
    const product = byProduct.get(sale.productId) ?? { productId: sale.productId, productName: currentName, quantity: 0n, salesCents: 0n, refundsCents: 0n };
    product.quantity += BigInt(sale.quantity);
    product.salesCents += BigInt(sale.totalCents);
    byProduct.set(sale.productId, product);
    const month = monthKey(sale.saleDate);
    const monthly = byMonth.get(month) ?? { month, quantity: 0n, salesCents: 0n, refundsCents: 0n };
    monthly.quantity += BigInt(sale.quantity);
    monthly.salesCents += BigInt(sale.totalCents);
    byMonth.set(month, monthly);
  }
  for (const refund of activeRefunds) {
    const currentName = currentNames.get(refund.productId) ?? refund.productName;
    const product = byProduct.get(refund.productId) ?? { productId: refund.productId, productName: currentName, quantity: 0n, salesCents: 0n, refundsCents: 0n };
    product.refundsCents += BigInt(refund.amountCents);
    byProduct.set(refund.productId, product);
    const month = monthKey(refund.refundDate);
    const monthly = byMonth.get(month) ?? { month, quantity: 0n, salesCents: 0n, refundsCents: 0n };
    monthly.refundsCents += BigInt(refund.amountCents);
    byMonth.set(month, monthly);
  }

  const totalQuantity = activeSales.reduce((total, sale) => total + BigInt(sale.quantity), 0n);
  const totalSalesCents = activeSales.reduce((total, sale) => total + BigInt(sale.totalCents), 0n);
  const totalRefundsCents = activeRefunds.reduce((total, refund) => total + BigInt(refund.amountCents), 0n);
  const startMonth = filters.fromDate || [...activeSales.map((sale) => sale.saleDate), ...activeRefunds.map((refund) => refund.refundDate)].sort()[0] || '';
  const endMonth = filters.toDate || [...activeSales.map((sale) => sale.saleDate), ...activeRefunds.map((refund) => refund.refundDate)].sort().at(-1) || '';
  for (const month of monthsBetween(startMonth, endMonth)) {
    if (!byMonth.has(month)) byMonth.set(month, { month, quantity: 0n, salesCents: 0n, refundsCents: 0n });
  }

  const summaryRows: (string | number | null)[][] = [
    ['Resumo do período'],
    ['Período', filters.fromDate || filters.toDate ? `${filters.fromDate || 'sem início'} a ${filters.toDate || 'sem fim'}` : 'Todas as datas'],
    ['Plano/produto', filters.productName || 'Todos os planos'],
    ['Gerado em', filters.generatedAt],
    [],
    ['Indicador', 'Valor'],
    ['Vendas registradas (R$)', moneyForWorkbook(totalSalesCents)],
    ['Estornos (R$)', moneyForWorkbook(totalRefundsCents)],
    ['Faturamento após estornos (R$)', moneyForWorkbook(totalSalesCents - totalRefundsCents)],
    ['Quantidade vendida', integerForWorkbook(totalQuantity)],
    [],
    ['Resumo por plano'],
    ['Plano/produto', 'Quantidade vendida', 'Vendas (R$)', 'Estornos (R$)', 'Após estornos (R$)'],
    ...[...byProduct.values()].sort((a, b) => a.productName.localeCompare(b.productName, 'pt-BR')).map((product) => [
      product.productName,
      integerForWorkbook(product.quantity),
      moneyForWorkbook(product.salesCents),
      moneyForWorkbook(product.refundsCents),
      moneyForWorkbook(product.salesCents - product.refundsCents),
    ]),
    ['Total geral', integerForWorkbook(totalQuantity), moneyForWorkbook(totalSalesCents), moneyForWorkbook(totalRefundsCents), moneyForWorkbook(totalSalesCents - totalRefundsCents)],
    [],
    ['Resumo mensal'],
    ['Mês/ano', 'Quantidade vendida', 'Vendas (R$)', 'Estornos (R$)', 'Após estornos (R$)'],
    ...[...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month)).map((month) => [
      month.month,
      integerForWorkbook(month.quantity),
      moneyForWorkbook(month.salesCents),
      moneyForWorkbook(month.refundsCents),
      moneyForWorkbook(month.salesCents - month.refundsCents),
    ]),
    ['Total geral', integerForWorkbook(totalQuantity), moneyForWorkbook(totalSalesCents), moneyForWorkbook(totalRefundsCents), moneyForWorkbook(totalSalesCents - totalRefundsCents)],
  ];
  const summary = XLSX.utils.aoa_to_sheet(summaryRows);
  summary['!cols'] = [{ wch: 30 }, { wch: 25 }, { wch: 22 }, { wch: 20 }, { wch: 23 }];
  const headerRows = summaryRows
    .map((row, index) => row[0] === 'Plano/produto' || row[0] === 'Mês/ano' ? index : -1)
    .filter((index) => index >= 0);
  const moneyColumns = [1, 2, 3, 4];
  for (const headerRow of headerRows) {
    for (let row = headerRow + 1; row < summaryRows.length; row += 1) {
      if (!summaryRows[row][0] && summaryRows[row].every((cell) => cell === null || cell === undefined || cell === '')) break;
      for (const column of moneyColumns.slice(1)) setCurrencyFormat(summary, column, row, row);
    }
  }
  const numericRows = new Set<number>();
  summaryRows.forEach((row, index) => { if (row[0] && ['Vendas registradas (R$)', 'Estornos (R$)', 'Faturamento após estornos (R$)'].includes(String(row[0]))) numericRows.add(index); });
  for (const row of numericRows) setCurrencyFormat(summary, 1, row, row);
  const summaryHeaderCells = summaryRows.length;
  setTextCells(summary, summaryHeaderCells, [0]);
  for (const row of [1, 2, 3, 5]) {
    const cell = summary[XLSX.utils.encode_cell({ r: row, c: 1 })];
    if (cell) {
      cell.t = 's';
      cell.v = String(cell.v);
      delete cell.f;
    }
  }
  XLSX.utils.book_append_sheet(workbook, summary, 'Resumo por plano');

  workbook.Props = {
    Title: 'Relatório de vendas Zero3 PRO',
    Subject: 'Vendas, estornos e resumo conciliado dos filtros selecionados',
    Author: 'Zero3 PRO',
  };
  return workbook;
}

export function downloadSalesWorkbook(sales: Sale[], refunds: SalesRefundRecord[], products: Product[], filters: ExportFilters, filename: string) {
  XLSX.writeFile(createSalesWorkbook(sales, refunds, products, filters), filename, { compression: true });
}
