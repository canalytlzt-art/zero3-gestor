import * as XLSX from 'xlsx';
import type { Sale } from '@workspace/api-client-react';
import { formatCents, productNameKey } from './sales-utils';

const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

function moneyForWorkbook(cents: bigint): number | string {
  if (cents > 999_999_999_999_999n) return formatCents(cents);
  return Number(cents) / 100;
}

function integerForWorkbook(value: bigint): number | string {
  return value > MAX_SAFE_INTEGER_BIGINT ? value.toString() : Number(value);
}

function setCurrencyFormat(worksheet: XLSX.WorkSheet, column: number, lastRow: number) {
  for (let row = 1; row <= lastRow; row += 1) {
    const address = XLSX.utils.encode_cell({ r: row, c: column });
    const cell = worksheet[address];
    if (cell?.t === 'n') cell.z = '"R$" #,##0.00';
  }
}

export function createSalesWorkbook(sales: Sale[]): XLSX.WorkBook {
  const workbook = XLSX.utils.book_new();
  const launchRows: (string | number)[][] = [
    ['Data', 'Plano/produto', 'Quantidade', 'Valor unitário (R$)', 'Total (R$)', 'Observação'],
    ...sales.map((sale) => [
      sale.saleDate.split('-').reverse().join('/'),
      sale.productName,
      sale.quantity,
      moneyForWorkbook(BigInt(sale.unitAmountCents)),
      moneyForWorkbook(BigInt(sale.totalCents)),
      sale.notes ?? '',
    ]),
  ];
  const launches = XLSX.utils.aoa_to_sheet(launchRows);
  launches['!cols'] = [{ wch: 14 }, { wch: 30 }, { wch: 14 }, { wch: 21 }, { wch: 18 }, { wch: 42 }];
  launches['!autofilter'] = { ref: `A1:F${Math.max(1, launchRows.length)}` };
  setCurrencyFormat(launches, 3, launchRows.length - 1);
  setCurrencyFormat(launches, 4, launchRows.length - 1);
  XLSX.utils.book_append_sheet(workbook, launches, 'Lançamentos');

  const byProduct = new Map<string, { name: string; quantity: bigint; revenueCents: bigint }>();
  let totalQuantity = 0n;
  let totalRevenueCents = 0n;
  for (const sale of sales) {
    const key = productNameKey(sale.productName);
    const current = byProduct.get(key) ?? { name: sale.productName, quantity: 0n, revenueCents: 0n };
    current.quantity += BigInt(sale.quantity);
    current.revenueCents += BigInt(sale.totalCents);
    byProduct.set(key, current);
    totalQuantity += BigInt(sale.quantity);
    totalRevenueCents += BigInt(sale.totalCents);
  }

  const summaryRows: (string | number)[][] = [
    ['Plano/produto', 'Quantidade', 'Faturamento (R$)'],
    ...[...byProduct.values()]
      .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))
      .map((product) => [
        product.name,
        integerForWorkbook(product.quantity),
        moneyForWorkbook(product.revenueCents),
      ]),
    ['Total geral', integerForWorkbook(totalQuantity), moneyForWorkbook(totalRevenueCents)],
  ];
  const summary = XLSX.utils.aoa_to_sheet(summaryRows);
  summary['!cols'] = [{ wch: 30 }, { wch: 16 }, { wch: 22 }];
  setCurrencyFormat(summary, 2, summaryRows.length - 1);
  XLSX.utils.book_append_sheet(workbook, summary, 'Resumo por plano');

  workbook.Props = {
    Title: 'Relatório de vendas Zero3 PRO',
    Subject: 'Lançamentos e resumo por plano dos filtros selecionados',
    Author: 'Zero3 PRO',
  };
  return workbook;
}

export function downloadSalesWorkbook(sales: Sale[], filename: string) {
  XLSX.writeFile(createSalesWorkbook(sales), filename, { compression: true });
}
