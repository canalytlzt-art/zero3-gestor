import assert from "node:assert/strict";
import test from "node:test";
import type { Sale, SalesRefundRecord } from "@workspace/api-client-react";
import {
  buildProductMonthlySalesSummary,
  filterSalesForScoreboard,
  paginateSalesHistory,
  sortAndFilterSalesHistory,
} from "./scoreboard-sales-history";

function sale(overrides: Partial<Sale> & Pick<Sale, "id" | "saleDate" | "productName" | "customerName" | "totalCents">): Sale {
  return {
    productId: "product-a",
    modalityId: null,
    modalityOverride: false,
    quantity: 1,
    unitAmountCents: overrides.totalCents,
    notes: null,
    status: "active",
    cancellationReason: null,
    version: 1,
    createdAt: `${overrides.saleDate}T12:00:00.000Z`,
    updatedAt: `${overrides.saleDate}T12:00:00.000Z`,
    ...overrides,
  };
}

const fixtures = [
  sale({ id: "a", saleDate: "2026-10-02", productName: "Plano A", customerName: "Ana", totalCents: 1000 }),
  sale({ id: "b", saleDate: "2026-10-02", productName: "Plano A", customerName: "Bruna", totalCents: 3000 }),
  sale({ id: "c", saleDate: "2026-11-03", productName: "Plano B", customerName: "Caio", totalCents: 2000, productId: "product-b" }),
  sale({ id: "d", saleDate: "2026-10-04", productName: "Plano A", customerName: null, totalCents: 4000, status: "cancelled", cancellationReason: "Duplicidade" }),
];

test("Scoreboard scope returns each sale once and respects period, product and weekday", () => {
  const rows = filterSalesForScoreboard(
    [...fixtures, fixtures[0]!],
    {
      months: ["2026-10"],
      productId: "product-a",
      weekdays: [5],
      weekdayForDate: () => 5,
    },
  );
  assert.deepEqual(rows.map(({ id }) => id).sort(), ["a", "b", "d"]);
});

test("history search, status filter and sorting preserve one row per sale", () => {
  const active = sortAndFilterSalesHistory([...fixtures, fixtures[0]!], {
    search: "ana",
    status: "active",
    sort: "date-newest",
  });
  assert.deepEqual(active.map(({ id }) => id), ["a"]);

  const cancelled = sortAndFilterSalesHistory(fixtures, { status: "cancelled" });
  assert.deepEqual(cancelled.map(({ id }) => id), ["d"]);

  const byAmount = sortAndFilterSalesHistory(fixtures, { status: "all", sort: "amount-high" });
  assert.deepEqual(byAmount.map(({ id }) => id), ["d", "b", "c", "a"]);
});

test("pagination clamps invalid pages and reports stable page counts", () => {
  assert.deepEqual(paginateSalesHistory([1, 2, 3, 4, 5], 8, 2), {
    rows: [5],
    page: 3,
    pageCount: 3,
    total: 5,
  });
  assert.deepEqual(paginateSalesHistory([], 0, 10), {
    rows: [],
    page: 1,
    pageCount: 1,
    total: 0,
  });
});

test("product monthly history separates sale dates from refund dates and excludes cancelled sales", () => {
  const refunds: SalesRefundRecord[] = [
    {
      id: "refund-active",
      saleId: "a",
      refundDate: "2026-11-04",
      amountCents: 200,
      reason: "Estorno parcial",
      status: "active",
      voidReason: null,
      version: 1,
      createdAt: "2026-11-04T12:00:00.000Z",
      updatedAt: "2026-11-04T12:00:00.000Z",
      saleDate: "2026-10-02",
      productId: "product-a",
      productName: "Plano A",
      quantity: 1,
      unitAmountCents: 1000,
      totalCents: 1000,
      saleStatus: "active",
    },
    {
      id: "refund-cancelled",
      saleId: "d",
      refundDate: "2026-11-05",
      amountCents: 700,
      reason: "Registro anterior incompatível",
      status: "active",
      voidReason: null,
      version: 1,
      createdAt: "2026-11-05T12:00:00.000Z",
      updatedAt: "2026-11-05T12:00:00.000Z",
      saleDate: "2026-10-04",
      productId: "product-a",
      productName: "Plano A",
      quantity: 1,
      unitAmountCents: 4000,
      totalCents: 4000,
      saleStatus: "cancelled",
    },
  ];

  const monthly = buildProductMonthlySalesSummary(
    fixtures,
    refunds,
    {
      productId: "product-a",
      productName: "Plano A",
      modalityId: null,
      modalityName: null,
      saleCount: 2,
      quantity: 2,
      salesCents: 4000,
      refundCents: 200,
      netCents: 3800,
    },
    ["2026-10", "2026-11"],
    (date) => date.startsWith("2026-10") || date.startsWith("2026-11"),
  );

  assert.deepEqual(monthly, [
    { month: "2026-10", saleCount: 2, quantity: 2, salesCents: 4000, refundCents: 0, netCents: 4000 },
    { month: "2026-11", saleCount: 0, quantity: 0, salesCents: 0, refundCents: 200, netCents: -200 },
  ]);
});
