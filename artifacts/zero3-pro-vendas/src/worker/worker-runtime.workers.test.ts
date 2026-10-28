import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import type { Product, Sale, SalesRefundRecord } from "@workspace/api-client-react";
import { buildFinancialChartAnalytics } from "../lib/financial-chart-data";
import { buildOccupancyChartAnalytics } from "../lib/occupancy-chart-data";
import { createSalesWorkbook } from "../lib/sales-workbook";
import { handleOccupancyRequest } from "./occupancy";
import { handleSalesRequest } from "./sales";
import type { AuthContext, WorkerEnv } from "./types";

const workerEnv = env as unknown as WorkerEnv;
const testOrigin = "https://zero3.test";
const authorizedFixture: AuthContext = {
  userId: "vitest-admin-fixture",
  email: "worker-test@example.invalid",
  authorized: true,
};

function normalizedProductName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("pt-BR");
}

async function callSales(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<{ response: Response; payload: any }> {
  const request = new Request(`${testOrigin}/api${path}`, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  const response = await handleSalesRequest(
    request,
    workerEnv,
    authorizedFixture,
    path.split("?")[0]!,
  );
  expect(response, `${method} ${path} should match a Worker route`).toBeTruthy();
  return { response: response!, payload: response!.status === 204 ? null : await response!.json() };
}

async function callOccupancy(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<{ response: Response; payload: any }> {
  const request = new Request(`${testOrigin}/api${path}`, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  const response = await handleOccupancyRequest(
    request,
    workerEnv,
    authorizedFixture,
    path.split("?")[0]!,
  );
  expect(response, `${method} ${path} should match a Worker route`).toBeTruthy();
  return { response: response!, payload: response!.status === 204 ? null : await response!.json() };
}

async function insertSale(input: {
  id: string;
  saleDate: string;
  productName: string;
  quantity: number;
  unitAmountCents: number;
  customerName: string;
}): Promise<void> {
  const totalCents = input.quantity * input.unitAmountCents;
  const now = "2026-10-26T12:00:00.000Z";
  await workerEnv.DB.prepare(
    `INSERT INTO sales (
      id, product_id, sale_date, product_name, quantity,
      unit_amount_cents, total_cents, customer_name, notes, status,
      cancellation_reason, version, created_by, updated_by, created_at, updated_at
    ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, NULL, 'active', NULL, 1, ?, ?, ?, ?)`,
  )
    .bind(
      input.id,
      input.saleDate,
      input.productName,
      input.quantity,
      input.unitAmountCents,
      totalCents,
      input.customerName,
      authorizedFixture.userId,
      authorizedFixture.userId,
      now,
      now,
    )
    .run();
}

describe("Cloudflare Workers runtime with isolated local D1", () => {
  it("rejects API access without a Clerk session", async () => {
    const response = await SELF.fetch(
      new Request("https://zero3.test/api/access-status", {
        headers: { origin: "https://zero3.test" },
      }),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      code: "session_missing",
    });
  });

  it("queries reconciled sales totals from the local D1 binding", async () => {
    await insertSale({
      id: "10000000-0000-4000-8000-000000000001",
      saleDate: "2026-10-10",
      productName: "Plano 12 aulas",
      quantity: 2,
      unitAmountCents: 12_000,
      customerName: "Cliente de teste",
    });
    await insertSale({
      id: "10000000-0000-4000-8000-000000000002",
      saleDate: "2026-11-02",
      productName: "Aula avulsa",
      quantity: 1,
      unitAmountCents: 7_500,
      customerName: "Cliente de teste",
    });

    const response = await handleSalesRequest(
      new Request(
        "https://zero3.test/api/sales/scoreboard?months=2026-10&months=2026-11",
      ),
      workerEnv,
      authorizedFixture,
      "/sales/scoreboard",
    );

    expect(response?.status).toBe(200);
    const scoreboard = await response!.json() as {
      totals: {
        quantity: number;
        salesCents: number;
        refundCents: number;
        netCents: number;
      };
      months: Array<{
        month: string;
        quantity: number;
        salesCents: number;
        refundCents: number;
        netCents: number;
      }>;
    };
    expect(scoreboard.totals).toEqual({
      quantity: 3,
      salesCents: 31_500,
      refundCents: 0,
      netCents: 31_500,
    });
    expect(scoreboard.months).toEqual([
      {
        month: "2026-10",
        quantity: 2,
        salesCents: 24_000,
        refundCents: 0,
        netCents: 24_000,
      },
      {
        month: "2026-11",
        quantity: 1,
        salesCents: 7_500,
        refundCents: 0,
        netCents: 7_500,
      },
    ]);

    const quarterResponse = await handleSalesRequest(
      new Request(
        "https://zero3.test/api/sales/scoreboard?months=2026-10&months=2026-11&months=2026-12",
      ),
      workerEnv,
      authorizedFixture,
      "/sales/scoreboard",
    );
    expect(quarterResponse?.status).toBe(200);
    const quarterScoreboard = await quarterResponse!.json() as typeof scoreboard;
    expect(quarterScoreboard.totals).toEqual(scoreboard.totals);
    expect(quarterScoreboard.months).toHaveLength(3);
    expect(quarterScoreboard.months[2]).toEqual({
      month: "2026-12",
      quantity: 0,
      salesCents: 0,
      refundCents: 0,
      netCents: 0,
    });
  });

  it("persists the sales, refunds, products, goals, and occupancy Worker routes in D1", async () => {
    const unique = crypto.randomUUID();
    const productName = `Worker route ${unique}`;
    const sale = await callSales("/sales", "POST", {
      saleDate: "2026-12-03",
      productName,
      quantity: 2,
      unitAmountCents: 1_450,
      customerName: "Cliente sintético",
      notes: "Teste D1 local",
      idempotencyKey: crypto.randomUUID(),
    });
    expect(sale.response.status).toBe(201);
    expect(sale.payload).toMatchObject({
      productName,
      quantity: 2,
      unitAmountCents: 1_450,
      totalCents: 2_900,
      customerName: "Cliente sintético",
    });
    expect(sale.payload.productId).toBeTruthy();

    const saleWithNameVariant = await callSales("/sales", "POST", {
      saleDate: "2027-01-03",
      productName: `  ${productName.toLocaleUpperCase("pt-BR").replace(/ /g, "   ")}  `,
      quantity: 1,
      unitAmountCents: 9_876,
      customerName: "Cliente sintético 2",
      notes: null,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(saleWithNameVariant.response.status).toBe(201);
    expect(saleWithNameVariant.payload.productId).toBe(sale.payload.productId);

    const saleId = sale.payload.id as string;
    const products = await callSales("/products");
    expect(products.response.status).toBe(200);
    const matchingProducts = products.payload.filter(
      (product: { name: string }) => normalizedProductName(product.name) === normalizedProductName(productName),
    );
    expect(matchingProducts).toHaveLength(1);
    expect(matchingProducts[0]).toMatchObject({
      id: sale.payload.productId,
      name: productName,
      suggestedPriceCents: 0,
    });

    const sales = await callSales("/sales");
    const history = await callSales("/sales/history");
    expect(sales.response.status).toBe(200);
    expect(history.response.status).toBe(200);
    expect(sales.payload.some((row: { id: string }) => row.id === saleId)).toBe(true);
    expect(history.payload.some((row: { id: string }) => row.id === saleId)).toBe(true);

    const updatedSale = await callSales(`/sales/${saleId}`, "PATCH", {
      saleDate: "2026-12-03",
      productName,
      quantity: 3,
      unitAmountCents: 1_500,
      customerName: "Cliente atualizado",
      notes: "Venda editada no teste D1",
      idempotencyKey: crypto.randomUUID(),
      expectedVersion: sale.payload.version,
    });
    expect(updatedSale.response.status).toBe(200);
    expect(updatedSale.payload).toMatchObject({
      id: saleId,
      quantity: 3,
      unitAmountCents: 1_500,
      totalCents: 4_500,
      customerName: "Cliente atualizado",
      version: 2,
    });
    const editedProductName = `Produto da edição ${unique}`;
    const updatedWithNewProduct = await callSales(`/sales/${saleId}`, "PATCH", {
      saleDate: "2026-12-03",
      productName: editedProductName,
      quantity: 3,
      unitAmountCents: 1_500,
      customerName: "Cliente atualizado",
      notes: "Venda editada no teste D1",
      idempotencyKey: crypto.randomUUID(),
      expectedVersion: updatedSale.payload.version,
    });
    expect(updatedWithNewProduct.response.status).toBe(200);
    expect(updatedWithNewProduct.payload.productName).toBe(editedProductName);
    const editedProduct = (await callSales("/products")).payload.find(
      (product: { name: string }) => product.name === editedProductName,
    );
    expect(editedProduct).toMatchObject({
      id: updatedWithNewProduct.payload.productId,
      suggestedPriceCents: 0,
    });
    const reloadedSales = await callSales("/sales");
    expect(reloadedSales.payload.find((row: { id: string }) => row.id === saleId)).toMatchObject({
      quantity: 3,
      totalCents: 4_500,
      customerName: "Cliente atualizado",
    });

    const refund = await callSales(`/sales/${saleId}/refunds`, "POST", {
      refundDate: "2026-12-04",
      amountCents: 500,
      reason: "Estorno parcial de teste",
      idempotencyKey: crypto.randomUUID(),
    });
    expect(refund.response.status).toBe(201);
    expect(refund.payload.amountCents).toBe(500);
    expect((await callSales("/sales/refund-candidates")).response.status).toBe(200);
    const refunds = await callSales("/sales/refunds");
    expect(refunds.response.status).toBe(200);
    expect(refunds.payload.some((row: { id: string }) => row.id === refund.payload.id)).toBe(true);

    const goal = await callSales("/sales-goals", "PUT", {
      month: "2026-12",
      productName,
      targetCents: 5_000,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(goal.response.status).toBe(200);
    const goals = await callSales("/sales-goals");
    expect(goals.response.status).toBe(200);
    expect(goals.payload.some((row: { productName: string }) => row.productName === productName)).toBe(true);

    const modalityName = `Modalidade ${unique}`;
    const modality = await callOccupancy("/occupancy/modalities", "POST", {
      name: modalityName,
    });
    expect(modality.response.status).toBe(201);
    expect((await callOccupancy("/occupancy/modalities")).response.status).toBe(200);

    const occupancy = await callOccupancy("/occupancy", "POST", {
      kind: "daily",
      period: "2026-12-03",
      modalityId: modality.payload.id,
      modalityName,
      presences: 3,
      capacity: 4,
      startTime: "06:00",
      endTime: "07:00",
      className: "Turma sintética",
    });
    expect(occupancy.response.status).toBe(201);
    expect(occupancy.payload).toMatchObject({
      modalityName,
      presences: 3,
      capacity: 4,
      percentage: 75,
    });
    const occupancyRows = await callOccupancy(
      "/occupancy?fromDate=2026-12-03&toDate=2026-12-03",
    );
    expect(occupancyRows.response.status).toBe(200);
    expect(occupancyRows.payload.some((row: { id: string }) => row.id === occupancy.payload.id)).toBe(true);

    const updatedOccupancy = await callOccupancy(`/occupancy/${occupancy.payload.id}`, "PATCH", {
      kind: "daily",
      period: "2026-12-03",
      modalityId: modality.payload.id,
      modalityName,
      presences: 4,
      capacity: 5,
      startTime: "06:30",
      endTime: "07:30",
      className: "Turma atualizada",
      notes: "Observação persistida no D1 local",
      version: occupancy.payload.version,
    });
    expect(updatedOccupancy.response.status).toBe(200);
    expect(updatedOccupancy.payload).toMatchObject({
      id: occupancy.payload.id,
      presences: 4,
      capacity: 5,
      percentage: 80,
      startTime: "06:30",
      endTime: "07:30",
      className: "Turma atualizada",
      notes: "Observação persistida no D1 local",
      version: 2,
    });
    const reloadedOccupancy = await callOccupancy(
      "/occupancy?fromDate=2026-12-03&toDate=2026-12-03",
    );
    expect(reloadedOccupancy.payload.find((row: { id: string }) => row.id === occupancy.payload.id))
      .toMatchObject({
        presences: 4,
        capacity: 5,
        percentage: 80,
        startTime: "06:30",
        endTime: "07:30",
        notes: "Observação persistida no D1 local",
      });
    const occupancyCharts = buildOccupancyChartAnalytics(reloadedOccupancy.payload, {
      viewMode: "daily",
      fromDate: "2026-12-03",
      toDate: "2026-12-03",
      modalityId: modality.payload.id,
    });
    expect(occupancyCharts.totals).toMatchObject({
      classes: 1,
      measuredClassCount: 1,
      presences: 4,
      capacity: 5,
      percentage: 80,
    });

    const scoreboard = await callSales("/sales/scoreboard?months=2026-12");
    expect(scoreboard.response.status).toBe(200);
    expect(scoreboard.payload.totals).toMatchObject({
      quantity: 3,
      salesCents: 4_500,
      refundCents: 500,
      netCents: 4_000,
    });
    const financialCharts = buildFinancialChartAnalytics(scoreboard.payload);
    expect(financialCharts.reconcilesByProduct).toBe(true);
    expect(financialCharts.reconcilesByMonth).toBe(true);
  });

  it("imports into isolated D1 idempotently and reconciles the dashboard", async () => {
    const unique = crypto.randomUUID();
    const fileHash = unique.replace(/-/g, "").repeat(2);
    const existingProductName = `Produto existente ${unique}`;
    const newProductName = `Plano automático ${unique}`;
    const distinctProductName = `Plano distinto ${unique}`;

    const existingProduct = await callSales("/products", "POST", {
      name: existingProductName,
      suggestedPriceCents: 5_555,
      modalityId: null,
      isActive: true,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(existingProduct.response.status).toBe(201);

    const importBody = {
      fileHash,
      filename: "vendas-d1-sinteticas.xlsx",
      rows: [
        {
          customerName: "Cliente sintético D1",
          saleDate: "2026-09-12",
          totalCents: 1_800,
          productName: `  ${existingProductName.toLocaleUpperCase("pt-BR").replace(/ /g, "   ")}  `,
          sourceSheet: "Setembro",
          sourceRow: 2,
        },
        {
          customerName: "Cliente sintético D1",
          saleDate: "2026-09-12",
          totalCents: 1_250,
          productName: newProductName,
          sourceSheet: "Setembro",
          sourceRow: 3,
        },
        {
          customerName: "Cliente sintético D1",
          saleDate: "2026-09-13",
          totalCents: 3_250,
          productName: `  ${newProductName.toLocaleUpperCase("pt-BR").replace(/ /g, "   ")}  `,
          sourceSheet: "Setembro",
          sourceRow: 4,
        },
        {
          customerName: "Cliente sintético D1",
          saleDate: "2026-09-14",
          totalCents: 700,
          productName: distinctProductName,
          sourceSheet: "Setembro",
          sourceRow: 5,
        },
      ],
    };

    const preview = await callSales(`/sales/import/origins?fileHash=${fileHash}`);
    expect(preview.response.status).toBe(200);
    expect(preview.payload.origins).toEqual([]);
    const productsBeforeConfirmation = await callSales("/products");
    expect(productsBeforeConfirmation.payload.some(
      (product: { name: string }) => normalizedProductName(product.name) === normalizedProductName(newProductName),
    )).toBe(false);

    const firstImport = await callSales("/sales/import", "POST", importBody);
    expect(firstImport.response.status).toBe(201);
    expect(firstImport.payload).toMatchObject({
      importedCount: 4,
      skippedCount: 0,
      replayed: false,
    });
    expect(new Set(firstImport.payload.sales.map((sale: { id: string }) => sale.id)).size).toBe(4);

    const [existingSale, firstNewSale, secondNewSale, distinctSale] = firstImport.payload.sales as Array<{
      id: string;
      productId: string;
      productName: string;
    }>;
    expect(existingSale.productId).toBe(existingProduct.payload.id);
    expect(firstNewSale.productId).toBe(secondNewSale.productId);
    expect(firstNewSale.productName).toBe(newProductName);
    expect(secondNewSale.productName).toBe(newProductName);
    expect(distinctSale.productId).not.toBe(firstNewSale.productId);

    const productsAfterImport = await callSales("/products");
    const importedProducts = productsAfterImport.payload.filter((product: { name: string }) =>
      [existingProductName, newProductName, distinctProductName]
        .some((name) => normalizedProductName(name) === normalizedProductName(product.name)),
    );
    expect(importedProducts).toHaveLength(3);
    expect(importedProducts.find((product: { id: string }) => product.id === existingProduct.payload.id))
      .toMatchObject({ suggestedPriceCents: 5_555, isActive: true });
    expect(importedProducts.filter((product: { name: string }) =>
      normalizedProductName(product.name) !== normalizedProductName(existingProductName),
    ).every((product: { suggestedPriceCents: number }) => product.suggestedPriceCents === 0)).toBe(true);

    const replay = await callSales("/sales/import", "POST", importBody);
    expect(replay.response.status).toBe(200);
    expect(replay.payload).toMatchObject({
      importedCount: 0,
      skippedCount: 4,
      replayed: true,
    });
    expect(replay.payload.sales.map((sale: { id: string }) => sale.id)).toEqual(
      firstImport.payload.sales.map((sale: { id: string }) => sale.id),
    );
    const productsAfterReplay = await callSales("/products");
    expect(productsAfterReplay.payload.filter((product: { name: string }) =>
      normalizedProductName(product.name) === normalizedProductName(newProductName),
    )).toHaveLength(1);

    const refreshedSales = await callSales("/sales");
    expect(refreshedSales.response.status).toBe(200);
    for (const sale of firstImport.payload.sales as Array<{ id: string }>) {
      expect(refreshedSales.payload.some((row: { id: string }) => row.id === sale.id)).toBe(true);
    }
    const salesHistory = await callSales("/sales/history");
    expect(salesHistory.response.status).toBe(200);
    expect(salesHistory.payload.find((sale: { id: string }) => sale.id === firstNewSale.id))
      .toMatchObject({ productId: firstNewSale.productId, productName: newProductName });

    const importedProductRefund = await callSales(`/sales/${firstNewSale.id}/refunds`, "POST", {
      refundDate: "2026-09-15",
      amountCents: 500,
      reason: "Estorno sintético do produto importado",
      idempotencyKey: crypto.randomUUID(),
    });
    expect(importedProductRefund.response.status).toBe(201);

    const scoreboard = await callSales("/sales/scoreboard?months=2026-09");
    expect(scoreboard.response.status).toBe(200);
    expect(scoreboard.payload.totals).toMatchObject({
      quantity: 4,
      salesCents: 7_000,
      refundCents: 500,
      netCents: 6_500,
    });
    const scoreboardProducts = scoreboard.payload.products as Array<{
      productId: string;
      productName: string;
      quantity: number;
      salesCents: number;
      refundCents: number;
      netCents: number;
    }>;
    expect(scoreboardProducts).toHaveLength(3);
    expect(scoreboardProducts.find((product) => product.productId === firstNewSale.productId))
      .toMatchObject({
        productName: newProductName,
        quantity: 2,
        salesCents: 4_500,
        refundCents: 500,
        netCents: 4_000,
      });
    expect(scoreboardProducts.find((product) => product.productId === distinctSale.productId))
      .toMatchObject({ productName: distinctProductName, quantity: 1, salesCents: 700, netCents: 700 });

    const productFilter = await callSales(
      `/sales/scoreboard?months=2026-09&productId=${firstNewSale.productId}`,
    );
    expect(productFilter.response.status).toBe(200);
    expect(productFilter.payload.totals).toMatchObject({
      quantity: 2,
      salesCents: 4_500,
      refundCents: 500,
      netCents: 4_000,
    });

    const customRange = await callSales(
      "/sales/scoreboard?fromDate=2026-09-13&toDate=2026-09-14",
    );
    expect(customRange.response.status).toBe(200);
    expect(customRange.payload.totals).toMatchObject({
      quantity: 2,
      salesCents: 3_950,
      refundCents: 0,
      netCents: 3_950,
    });

    const charts = buildFinancialChartAnalytics(scoreboard.payload);
    expect(charts.reconcilesByProduct).toBe(true);
    expect(charts.reconcilesByMonth).toBe(true);
    expect(charts.byProduct).toHaveLength(3);
    expect(charts.byProduct.reduce((sum, product) => sum + product.quantity, 0)).toBe(4);
    expect(charts.byProduct.reduce((sum, product) => sum + product.netCents, 0)).toBe(6_500);
    expect(charts.salesShareByProduct.reduce((sum, product) => sum + product.salesCents, 0)).toBe(7_000);
    expect(charts.salesShareByProduct.find((product) => product.key === firstNewSale.productId)?.salesCents)
      .toBe(4_500);
    expect((4_500 / 7_000) * 100).toBeCloseTo(64.3, 1);

    const refunds = await callSales("/sales/refunds");
    const workbook = createSalesWorkbook(
      salesHistory.payload as Sale[],
      refunds.payload as SalesRefundRecord[],
      productsAfterImport.payload as Product[],
      {
        selection: { mode: "months", months: ["2026-09"] },
        productName: newProductName,
        generatedAt: "28/10/2026, 09:00:00",
      },
    );
    const exportSummary = XLSX.utils.sheet_to_json(
      workbook.Sheets["Resumo por plano"]!,
      { header: 1, raw: true },
    ) as unknown[][];
    expect(exportSummary.find((row) => row[0] === newProductName)?.slice(1, 5))
      .toEqual([2, 45, 5, 40]);

    const productToManage = importedProducts.find(
      (product: { id: string }) => product.id === firstNewSale.productId,
    );
    const renamedProductName = `Plano revisado ${unique}`;
    const rename = await callSales(`/products/${firstNewSale.productId}`, "PATCH", {
      name: renamedProductName,
      suggestedPriceCents: 0,
      modalityId: null,
      isActive: true,
      expectedVersion: productToManage.version,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(rename.response.status).toBe(200);
    const metricsAfterRename = await callSales(
      `/sales/scoreboard?months=2026-09&productId=${firstNewSale.productId}`,
    );
    expect(metricsAfterRename.payload.products[0]).toMatchObject({
      productName: renamedProductName,
      quantity: 2,
      salesCents: 4_500,
      refundCents: 500,
      netCents: 4_000,
    });

    const deactivation = await callSales(`/products/${firstNewSale.productId}`, "PATCH", {
      name: renamedProductName,
      suggestedPriceCents: 0,
      modalityId: null,
      isActive: false,
      expectedVersion: rename.payload.version,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(deactivation.response.status).toBe(200);
    expect((await callSales("/products")).payload.find(
      (product: { id: string }) => product.id === firstNewSale.productId,
    )).toMatchObject({ isActive: false });
    const metricsAfterDeactivation = await callSales(
      `/sales/scoreboard?months=2026-09&productId=${firstNewSale.productId}`,
    );
    expect(metricsAfterDeactivation.payload.totals).toMatchObject({
      quantity: 2,
      salesCents: 4_500,
      refundCents: 500,
      netCents: 4_000,
    });
  });

  it("stores incomplete import rows as non-financial drafts and confirms them only after completion", async () => {
    const unique = crypto.randomUUID();
    const fileHash = unique.replace(/-/g, "").repeat(2);
    const filename = `pendencias-${unique}.xlsx`;
    const readyProductName = `Venda sem nome ${unique}`;
    const completedProductName = `Produto completado ${unique}`;
    const importBody = {
      fileHash,
      filename,
      rows: [{
        customerName: null,
        saleDate: "2026-12-10",
        totalCents: 2_500,
        productName: readyProductName,
        notes: "Nome do cliente será verificado",
        sourceSheet: "Dezembro",
        sourceRow: 2,
      }],
      pendingRows: [
        {
          customerName: "Cliente sem data",
          saleDate: null,
          saleDateText: "data ausente",
          totalCents: 3_000,
          amountText: null,
          productName: `Produto sem data ${unique}`,
          notes: null,
          sourceSheet: "Dezembro",
          sourceRow: 3,
        },
        {
          customerName: "Cliente sem valor",
          saleDate: "2026-12-12",
          saleDateText: null,
          totalCents: null,
          amountText: "valor a confirmar",
          productName: null,
          notes: "Importado sem valor",
          sourceSheet: "Dezembro",
          sourceRow: 4,
        },
      ],
    };
    const preview = await callSales(`/sales/import/origins?fileHash=${fileHash}`);
    expect(preview.payload.origins).toEqual([]);
    const scoreboardBaseline = (await callSales("/sales/scoreboard?months=2026-12")).payload.totals;

    const imported = await callSales("/sales/import", "POST", importBody);
    expect(imported.response.status, JSON.stringify(imported.payload)).toBe(201);
    expect(imported.payload).toMatchObject({
      importedCount: 1,
      skippedCount: 0,
      pendingCount: 2,
      skippedPendingCount: 0,
      replayed: false,
    });
    expect(imported.payload.sales[0]).toMatchObject({
      customerName: null,
      totalCents: 2_500,
    });
    const readyProduct = (await callSales("/products")).payload.find(
      (product: { name: string }) => product.name === readyProductName,
    );
    expect(readyProduct).toMatchObject({ suggestedPriceCents: 0 });
    const draftProduct = `Produto sem data ${unique}`;
    expect((await callSales("/products")).payload.some(
      (product: { name: string }) => product.name === draftProduct,
    )).toBe(false);

    const pending = (await callSales("/sales/pending")).payload.filter(
      (draft: { sourceFileName: string }) => draft.sourceFileName === filename,
    );
    expect(pending).toHaveLength(2);
    expect(pending.find((draft: { sourceRow: number }) => draft.sourceRow === 3)).toMatchObject({
      status: "pending",
      missingFields: ["saleDate"],
      totalCents: 3_000,
      saleDateText: "data ausente",
    });
    expect(pending.find((draft: { sourceRow: number }) => draft.sourceRow === 4)).toMatchObject({
      status: "pending",
      missingFields: ["totalCents"],
      totalCents: null,
      amountText: "valor a confirmar",
    });

    const scoreboardBeforeCompletion = await callSales(
      `/sales/scoreboard?months=2026-12&productId=${readyProduct.id}`,
    );
    expect(scoreboardBeforeCompletion.payload.totals).toMatchObject({
      quantity: 1,
      salesCents: 2_500,
      refundCents: 0,
      netCents: 2_500,
    });
    const totalAfterImport = (await callSales("/sales/scoreboard?months=2026-12")).payload.totals;
    expect(totalAfterImport.salesCents - scoreboardBaseline.salesCents).toBe(2_500);
    expect(totalAfterImport.quantity - scoreboardBaseline.quantity).toBe(1);
    const salesAfterImport = (await callSales("/sales")).payload;
    expect(salesAfterImport.some((sale: { customerName: string | null }) =>
      sale.customerName === "Cliente sem data" || sale.customerName === "Cliente sem valor",
    )).toBe(false);
    const replay = await callSales("/sales/import", "POST", importBody);
    expect(replay.response.status).toBe(200);
    expect(replay.payload).toMatchObject({
      importedCount: 0,
      pendingCount: 0,
      skippedPendingCount: 2,
      replayed: true,
    });
    expect((await callSales("/sales/pending")).payload.filter(
      (draft: { sourceFileName: string }) => draft.sourceFileName === filename,
    )).toHaveLength(2);

    const completedDraft = pending.find((draft: { sourceRow: number }) => draft.sourceRow === 3);
    const completion = await callSales(`/sales/pending/${completedDraft.id}`, "PATCH", {
      customerName: "Cliente identificado",
      saleDate: "2026-12-11",
      saleDateText: null,
      productName: completedProductName,
      totalCents: 3_000,
      amountText: null,
      notes: "Data confirmada",
      expectedVersion: completedDraft.version,
    });
    expect(completion.response.status).toBe(200);
    expect(completion.payload).toMatchObject({
      status: "completed",
      draft: { status: "completed", missingFields: [] },
      sale: {
        saleDate: "2026-12-11",
        customerName: "Cliente identificado",
        productName: completedProductName,
        totalCents: 3_000,
      },
    });
    const completedProduct = (await callSales("/products")).payload.find(
      (product: { name: string }) => product.name === completedProductName,
    );
    expect(completedProduct).toMatchObject({ suggestedPriceCents: 0 });
    expect((await callSales("/sales/pending")).payload.filter(
      (draft: { sourceFileName: string }) => draft.sourceFileName === filename,
    )).toHaveLength(1);
    const completedScoreboard = await callSales(
      `/sales/scoreboard?months=2026-12&productId=${completedProduct.id}`,
    );
    expect(completedScoreboard.payload.totals).toMatchObject({
      quantity: 1,
      salesCents: 3_000,
      refundCents: 0,
      netCents: 3_000,
    });
    const totalAfterCompletion = (await callSales("/sales/scoreboard?months=2026-12")).payload.totals;
    expect(totalAfterCompletion.salesCents - scoreboardBaseline.salesCents).toBe(5_500);

    const replayAfterCompletion = await callSales("/sales/import", "POST", importBody);
    expect(replayAfterCompletion.response.status).toBe(200);
    expect(replayAfterCompletion.payload).toMatchObject({
      importedCount: 0,
      pendingCount: 0,
      skippedPendingCount: 2,
      replayed: true,
    });
    const totalAfterReplay = (await callSales("/sales/scoreboard?months=2026-12")).payload.totals;
    expect(totalAfterReplay.salesCents).toBe(totalAfterCompletion.salesCents);
  });
});
