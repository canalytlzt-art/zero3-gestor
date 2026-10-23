import assert from 'node:assert/strict';
import test from 'node:test';
import * as XLSX from 'xlsx';
import type { Product, Sale, SalesRefundRecord } from '@workspace/api-client-react';
import { createSalesCsv, createSalesWorkbook, summarizeSalesReport } from './sales-workbook';

const productId = 'product-plan-12';
const octoberSale = {
  id: 'sale-october',
  productId,
  saleDate: '2026-10-05',
  productName: 'Plano 12 aulas',
  quantity: 1,
  unitAmountCents: 100000,
  totalCents: 100000,
  customerName: 'Cliente Outubro',
  notes: null,
  status: 'active',
  createdAt: '2026-10-05T12:00:00.000Z',
} as Sale;

const novemberSale = {
  ...octoberSale,
  id: 'sale-november',
  saleDate: '2026-11-10',
  unitAmountCents: 50000,
  totalCents: 50000,
  customerName: 'Cliente Novembro',
} as Sale;

const refund = {
  id: 'refund-november',
  saleId: octoberSale.id,
  refundDate: '2026-11-20',
  saleDate: octoberSale.saleDate,
  productId,
  productName: octoberSale.productName,
  amountCents: 20000,
  reason: 'Estorno parcial',
  status: 'active',
  saleStatus: 'active',
  totalCents: octoberSale.totalCents,
  createdAt: '2026-11-20T12:00:00.000Z',
} as SalesRefundRecord;

const products = [{ id: productId, name: 'Plano 12 aulas' }] as Product[];
const sales = [octoberSale, novemberSale];
const refunds = [refund];
const generatedAt = '23/10/2026, 12:00:00';

test('multi-month workbook and CSV reconcile sales by sale date and refunds by effective date', () => {
  const filters = {
    selection: { mode: 'months', months: ['2026-10', '2026-11'] } as const,
    productName: '',
    generatedAt,
  };
  const summary = summarizeSalesReport(sales, refunds, products, filters);
  assert.deepEqual(summary, {
    salesCount: 2,
    refundsCount: 1,
    quantity: 2n,
    salesCents: 150000n,
    refundsCents: 20000n,
    netCents: 130000n,
  });

  const workbook = createSalesWorkbook(sales, refunds, products, filters);
  const reopened = XLSX.read(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer' });
  assert.deepEqual(reopened.SheetNames, ['Lançamentos', 'Resumo por plano']);
  const detailRows = XLSX.utils.sheet_to_json(reopened.Sheets['Lançamentos']!, { header: 1 }) as unknown[][];
  assert.equal(detailRows.length, 4);
  assert.equal(detailRows[1]?.[0], 'Estorno');
  assert.equal(detailRows[2]?.[0], 'Venda');
  assert.equal(detailRows[3]?.[0], 'Venda');

  const summaryRows = XLSX.utils.sheet_to_json(reopened.Sheets['Resumo por plano']!, { header: 1, raw: true }) as unknown[][];
  assert.equal(summaryRows.find((row) => row[0] === 'Vendas registradas (R$)')?.[1], 1500);
  assert.equal(summaryRows.find((row) => row[0] === 'Estornos (R$)')?.[1], 200);
  assert.equal(summaryRows.find((row) => row[0] === 'Faturamento após estornos (R$)')?.[1], 1300);
  assert.equal(summaryRows.find((row) => row[0] === 'Total geral')?.[1], 2);
  assert.ok(summaryRows.some((row) => row[0] === '2026-10' && row[3] === 0));
  assert.ok(summaryRows.some((row) => row[0] === '2026-11' && row[3] === 200));

  const csv = createSalesCsv(sales, refunds, products, filters);
  assert.ok(csv.startsWith('\uFEFF'));
  assert.ok(csv.includes('Tipo;ID interno'));
  assert.ok(csv.includes('Estorno;refund-november'));
  assert.ok(csv.includes('Venda;sale-october'));
});

test('inclusive date range and empty selected month preserve zero totals', () => {
  const rangeSummary = summarizeSalesReport(sales, refunds, products, {
    selection: { mode: 'range', fromDate: '2026-11-10', toDate: '2026-11-20' },
    productName: '',
    generatedAt,
  });
  assert.deepEqual(rangeSummary, {
    salesCount: 1,
    refundsCount: 1,
    quantity: 1n,
    salesCents: 50000n,
    refundsCents: 20000n,
    netCents: 30000n,
  });

  const emptyWorkbook = createSalesWorkbook([], [], products, {
    selection: { mode: 'months', months: ['2027-01'] },
    productName: '',
    generatedAt,
  });
  const emptyRows = XLSX.utils.sheet_to_json(emptyWorkbook.Sheets['Resumo por plano']!, { header: 1, raw: true }) as unknown[][];
  assert.ok(emptyRows.some((row) => row[0] === '2027-01' && row[1] === 0 && row[2] === 0 && row[3] === 0));
  assert.deepEqual(summarizeSalesReport([], [], products, {
    selection: { mode: 'months', months: ['2027-01'] },
    productName: '',
    generatedAt,
  }), {
    salesCount: 0,
    refundsCount: 0,
    quantity: 0n,
    salesCents: 0n,
    refundsCents: 0n,
    netCents: 0n,
  });
});
