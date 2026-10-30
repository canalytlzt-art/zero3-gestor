import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "xlsx";
import type {
  Sale,
  SalesRefundRecord,
  SalesScoreboard,
} from "@workspace/api-client-react";
import { buildFinancialChartAnalytics } from "../lib/financial-chart-data";
import { parseSalesSpreadsheet, mapSalesImportRow } from "../lib/sales-import";
import {
  createSalesWorkbook,
  summarizeSalesReport,
  type ExportFilters,
} from "../lib/sales-workbook";
import { handleSalesRequest } from "./sales";
import type {
  AuthContext,
  D1Database,
  D1PreparedStatement,
  D1Result,
  WorkerEnv,
} from "./types";

type Row = Record<string, unknown>;

class MemoryStatement implements D1PreparedStatement {
  private values: unknown[] = [];

  constructor(
    private readonly database: MemorySalesD1,
    readonly query: string,
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    this.values = values;
    return this;
  }

  first<T = Record<string, unknown>>(): Promise<T | null> {
    return this.database.first<T>(this.query, this.values);
  }

  all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return this.database.all<T>(this.query, this.values);
  }

  run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return this.database.run<T>(this.query, this.values);
  }

  async raw<T = unknown[]>(): Promise<T[]> {
    const result = await this.all<unknown>();
    return (result.results ?? []) as T[];
  }
}

class MemorySalesD1 implements D1Database {
  readonly sales = new Map<string, Row>();
  readonly histories: Row[] = [];
  readonly refunds: Row[] = [];
  readonly pendingDrafts = new Map<string, Row>();
  readonly batches = new Map<string, string>();
  readonly queries: string[] = [];

  prepare(query: string): D1PreparedStatement {
    this.queries.push(query);
    return new MemoryStatement(this, query);
  }

  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    const results: D1Result<T>[] = [];
    for (const statement of statements) results.push(await statement.run<T>());
    return results;
  }

  async exec(): Promise<D1Result> {
    return { success: true };
  }

  async first<T>(query: string, values: unknown[]): Promise<T | null> {
    const normalized = query.replace(/\s+/g, " ").trim().toLowerCase();
    if (normalized.startsWith("select id from sales_import_batches")) {
      const id = this.batches.get(String(values[0]));
      return id ? ({ id } as T) : null;
    }
    throw new Error(`Unexpected synthetic D1 first() query: ${normalized}`);
  }

  async all<T>(query: string, values: unknown[]): Promise<D1Result<T>> {
    const normalized = query.replace(/\s+/g, " ").trim().toLowerCase();
    let results: Row[];

    if (normalized.startsWith("select source_sheet, source_row, state, sale_id, draft_id from (")) {
      const fileHash = String(values[0]);
      const draftOrigins = [...this.pendingDrafts.values()]
        .filter((draft) => draft.source_file_hash === fileHash)
        .map((draft) => ({
          source_sheet: draft.source_sheet,
          source_row: draft.source_row,
          state: draft.status === "completed" ? "sale" : "pending",
          sale_id: draft.linked_sale_id ?? null,
          draft_id: draft.status === "pending" ? draft.id : null,
        }));
      const draftSourceKeys = new Set(draftOrigins.map((draft) => `${draft.source_sheet}:${draft.source_row}`));
      const saleOrigins = this.histories.flatMap((history) => {
        const afterData = JSON.parse(String(history.after_data)) as Row;
        const key = `${afterData.sourceSheet}:${afterData.sourceRow}`;
        return afterData.sourceFileHash === fileHash && !draftSourceKeys.has(key)
          ? [{
              source_sheet: afterData.sourceSheet,
              source_row: afterData.sourceRow,
              state: "sale",
              sale_id: history.entity_id,
              draft_id: null,
            }]
          : [];
      });
      results = [...draftOrigins, ...saleOrigins];
    } else if (normalized === "select id from occupancy_modalities") {
      results = [];
    } else if (normalized.startsWith("select * from sales_pending_drafts where status='pending'")) {
      results = [...this.pendingDrafts.values()].filter((draft) => draft.status === "pending");
    } else if (normalized.startsWith("select * from sales where id in")) {
      const ids = new Set(values.map(String));
      results = [...this.sales.values()].filter((sale) => ids.has(String(sale.id)));
    } else if (normalized.includes("from sales s left join products p on p.id=s.product_id")) {
      assert.match(normalized, /where s\.status='active'/);
      results = [...this.sales.values()]
        .filter((sale) => sale.status === "active")
        .map((sale) => ({
          ...sale,
          current_product_name: null,
          modality_id: null,
          modality_name: null,
        }));
    } else if (normalized.includes("from sales_refunds r join sales s on s.id=r.sale_id")) {
      assert.match(normalized, /where r\.status='active'/);
      results = this.refunds.filter((refund) => refund.status === "active");
    } else {
      throw new Error(`Unexpected synthetic D1 all() query: ${normalized}`);
    }

    return { success: true, results: results as T[] };
  }

  async run<T>(query: string, values: unknown[]): Promise<D1Result<T>> {
    const normalized = query.replace(/\s+/g, " ").trim().toLowerCase();
    if (normalized.startsWith("insert into sales_import_batches")) {
      const [id, , fileHash] = values;
      this.batches.set(String(fileHash), String(id));
    } else if (normalized.startsWith("insert into sales_pending_drafts")) {
      const [
        id, customerName, saleDate, saleDateText, productName, totalCents,
        amountText, notes, fileHash, fileName, sourceSheet, sourceRow,
        createdBy, updatedBy, createdAt, updatedAt,
      ] = values;
      const existing = [...this.pendingDrafts.values()].some((draft) =>
        draft.source_file_hash === fileHash
        && draft.source_sheet === sourceSheet
        && draft.source_row === sourceRow);
      if (!existing) this.pendingDrafts.set(String(id), {
        id, status: "pending", customer_name: customerName, sale_date: saleDate,
        sale_date_text: saleDateText, product_name: productName,
        total_cents: totalCents, amount_text: amountText, notes,
        source_file_hash: fileHash, source_file_name: fileName,
        source_sheet: sourceSheet, source_row: sourceRow, linked_sale_id: null,
        version: 1, created_by: createdBy, updated_by: updatedBy,
        created_at: createdAt, updated_at: updatedAt,
      });
    } else if (normalized.startsWith("insert into sales_history")) {
      const [
        id,
        actorId,
        batchId,
        fileHash,
        filename,
        sourceSheet,
        sourceRow,
        createdAt,
        saleId,
      ] = values;
      const sale = this.sales.get(String(saleId));
      if (sale) {
        this.histories.push({
          id,
          entity_type: "sale",
          entity_id: saleId,
          operation: "import",
          actor_id: actorId,
          after_data: JSON.stringify({
            ...sale,
            importBatchId: batchId,
            sourceFileHash: fileHash,
            sourceFileName: filename,
            sourceSheet,
            sourceRow,
          }),
          created_at: createdAt,
        });
      }
    } else if (normalized.startsWith("insert into sales ")) {
      const [
        id,
        saleDate,
        productName,
        unitAmountCents,
        totalCents,
        modalityId,
        modalityOverride,
        customerName,
        notes,
        createdBy,
        updatedBy,
        createdAt,
        updatedAt,
      ] = values;
      this.sales.set(String(id), {
        id,
        product_id: null,
        sale_date: saleDate,
        product_name: productName,
        quantity: 1,
        unit_amount_cents: unitAmountCents,
        total_cents: totalCents,
        modality_id: modalityId,
        modality_override: modalityOverride,
        customer_name: customerName,
        notes,
        status: "active",
        cancellation_reason: null,
        version: 1,
        created_by: createdBy,
        updated_by: updatedBy,
        created_at: createdAt,
        updated_at: updatedAt,
      });
    } else if (!normalized.startsWith("update sales_import_batches")) {
      throw new Error(`Unexpected synthetic D1 run() query: ${normalized}`);
    }

    return { success: true, meta: { changes: 1 } };
  }
}

const actor: AuthContext = {
  userId: "synthetic-admin",
  email: "admin@example.invalid",
  authorized: true,
};

function envFor(database: MemorySalesD1): WorkerEnv {
  return { DB: database } as unknown as WorkerEnv;
}

async function requestWorkerSales(
  database: MemorySalesD1,
  path: string,
  body?: unknown,
): Promise<Response> {
  const response = await handleSalesRequest(
    new Request(`https://zero3.test${path}`, {
      method: body === undefined ? "GET" : "POST",
      ...(body === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
    }),
    envFor(database),
    actor,
    path.split("?")[0]!,
  );
  assert.ok(response, `Expected Worker route for ${path}`);
  return response;
}

test("synthetic workbook import reconciles through Worker, Scoreboard, charts, and export", async () => {
  const source = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(source, XLSX.utils.aoa_to_sheet([
    ["Nome do cliente", "Data de início", "Valor da venda"],
    ["Cliente A", "31/10/2026", "R$ 100,00"],
    ["Cliente A", "31/10/2026", "R$ 100,00"],
  ]), "Outubro");
  XLSX.utils.book_append_sheet(source, XLSX.utils.aoa_to_sheet([
    ["Nome do cliente", "Data de início", "Valor da venda"],
    ["Cliente B", "01/11/2026", "R$ 75,05"],
  ]), "Novembro");

  const bytes = XLSX.write(source, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  const parsed = await parseSalesSpreadsheet(bytes, "vendas-sinteticas.xlsx");
  const rows = parsed.sheets.flatMap((sheet) =>
    sheet.rows.flatMap((row) => {
      const result = mapSalesImportRow(sheet, row);
      return result.value ? [result.value] : [];
    }),
  );
  assert.equal(rows.length, 3);
  assert.equal(rows.reduce((sum, row) => sum + row.totalCents, 0), 27_505);
  assert.deepEqual([...new Set(rows.map((row) => row.sourceSheet))], ["Outubro", "Novembro"]);

  const database = new MemorySalesD1();
  const importBody = {
    fileHash: "a".repeat(64),
    filename: "vendas-sinteticas.xlsx",
    rows: rows.map((row) => ({
      customerName: row.customerName,
      saleDate: row.saleDate,
      totalCents: row.totalCents,
      productName: row.productName,
      sourceSheet: row.sourceSheet,
      sourceRow: row.sourceRow,
    })),
  };
  const importResponse = await requestWorkerSales(database, "/sales/import", importBody);
  assert.equal(importResponse.status, 201);
  const imported = await importResponse.json() as {
    importedCount: number;
    skippedCount: number;
    replayed: boolean;
    sales: Sale[];
  };
  assert.equal(imported.importedCount, 3);
  assert.equal(imported.skippedCount, 0);
  assert.equal(imported.replayed, false);
  assert.equal(new Set(imported.sales.map((sale) => sale.id)).size, 3,
    "legitimate sales with identical dates, names, and amounts retain distinct IDs");
  assert.ok(imported.sales.every((sale) => sale.productId === null));

  const replayResponse = await requestWorkerSales(database, "/sales/import", importBody);
  assert.equal(replayResponse.status, 200);
  const replay = await replayResponse.json() as typeof imported;
  assert.equal(replay.importedCount, 0);
  assert.equal(replay.skippedCount, 3);
  assert.equal(replay.replayed, true);
  assert.deepEqual(
    replay.sales.map((sale) => sale.id),
    imported.sales.map((sale) => sale.id),
  );

  const octoberSale = imported.sales.find((sale) => sale.saleDate === "2026-10-31")!;
  const multiUnitSale = imported.sales.find((sale) => sale.saleDate === "2026-10-31" && sale.id !== octoberSale.id)!;
  const storedMultiUnitSale = database.sales.get(multiUnitSale.id)!;
  database.sales.set(multiUnitSale.id, { ...storedMultiUnitSale, quantity: 2, total_cents: 20_000 });
  database.refunds.push({
    id: "synthetic-refund-1",
    sale_id: octoberSale.id,
    refund_date: "2026-11-05",
    amount_cents: 2_000,
    reason: "Estorno sintético",
    status: "active",
    void_reason: null,
    version: 1,
    created_by: actor.userId,
    updated_by: actor.userId,
    created_at: "2026-11-05T12:00:00.000Z",
    updated_at: "2026-11-05T12:00:00.000Z",
    product_id: null,
    product_name: "Não categorizado",
    current_product_name: null,
    modality_id: null,
    modality_name: null,
    sale_date: octoberSale.saleDate,
    quantity: octoberSale.quantity,
    unit_amount_cents: octoberSale.unitAmountCents,
    total_cents: octoberSale.totalCents,
    sale_status: "active",
  });

  const scoreboardResponse = await requestWorkerSales(
    database,
    "/sales/scoreboard?months=2026-10&months=2026-11",
  );
  assert.equal(scoreboardResponse.status, 200);
  const scoreboard = await scoreboardResponse.json() as SalesScoreboard;
  assert.deepEqual(scoreboard.totals, {
    saleCount: 3,
    quantity: 4,
    salesCents: 37_505,
    refundCents: 2_000,
    netCents: 35_505,
  });
  assert.deepEqual(scoreboard.months, [
    { month: "2026-10", saleCount: 2, quantity: 3, salesCents: 30_000, refundCents: 0, netCents: 30_000 },
    { month: "2026-11", saleCount: 1, quantity: 1, salesCents: 7_505, refundCents: 2_000, netCents: 5_505 },
  ]);
  assert.deepEqual(scoreboard.days, [
    { date: "2026-10-31", weekday: 6, saleCount: 2, quantity: 3, salesCents: 30_000, refundCents: 0, netCents: 30_000 },
    { date: "2026-11-01", weekday: 7, saleCount: 1, quantity: 1, salesCents: 7_505, refundCents: 0, netCents: 7_505 },
    { date: "2026-11-05", weekday: 4, saleCount: 0, quantity: 0, salesCents: 0, refundCents: 2_000, netCents: -2_000 },
  ]);
  assert.deepEqual(scoreboard.weeks, [
    { weekStart: "2026-10-26", saleCount: 3, quantity: 4, salesCents: 37_505, refundCents: 0, netCents: 37_505 },
    { weekStart: "2026-11-02", saleCount: 0, quantity: 0, salesCents: 0, refundCents: 2_000, netCents: -2_000 },
  ]);

  const charts = buildFinancialChartAnalytics(scoreboard);
  assert.equal(charts.reconcilesByProduct, true);
  assert.equal(charts.reconcilesByMonth, true);
  assert.equal(charts.days.reduce((sum, row) => sum + row.quantity, 0), scoreboard.totals.quantity);
  assert.equal(charts.months.reduce((sum, row) => sum + row.saleCount, 0), scoreboard.totals.saleCount);
  assert.equal(charts.weeks.reduce((sum, row) => sum + row.netCents, 0), scoreboard.totals.netCents);
  assert.equal(charts.byProduct.reduce((sum, row) => sum + row.saleCount, 0), 3);
  assert.equal(charts.byProduct[0]?.quantity, 4);
  assert.equal(charts.byProduct[0]?.netCents, 35_505);

  const weekdayResponse = await requestWorkerSales(
    database,
    "/sales/scoreboard?months=2026-10&weekdays=6",
  );
  assert.equal(weekdayResponse.status, 200);
  const saturdayScoreboard = await weekdayResponse.json() as SalesScoreboard;
  assert.deepEqual(saturdayScoreboard.totals, {
    saleCount: 2,
    quantity: 3,
    salesCents: 30_000,
    refundCents: 0,
    netCents: 30_000,
  });
  assert.deepEqual(saturdayScoreboard.days.map(({ date, weekday }) => ({ date, weekday })), [
    { date: "2026-10-31", weekday: 6 },
  ]);

  const thursdayRefundResponse = await requestWorkerSales(
    database,
    "/sales/scoreboard?fromDate=2026-10-31&toDate=2026-11-05&weekdays=4",
  );
  assert.equal(thursdayRefundResponse.status, 200);
  const thursdayScoreboard = await thursdayRefundResponse.json() as SalesScoreboard;
  assert.deepEqual(thursdayScoreboard.totals, {
    saleCount: 0,
    quantity: 0,
    salesCents: 0,
    refundCents: 2_000,
    netCents: -2_000,
  });

  const refund = {
    id: "synthetic-refund-1",
    saleId: octoberSale.id,
    refundDate: "2026-11-05",
    saleDate: octoberSale.saleDate,
    productId: null,
    productName: "Não categorizado",
    amountCents: 2_000,
    reason: "Estorno sintético",
    status: "active",
    saleStatus: "active",
    totalCents: octoberSale.totalCents,
    createdAt: "2026-11-05T12:00:00.000Z",
  } as SalesRefundRecord;
  const filters: ExportFilters = {
    selection: { mode: "months", months: ["2026-10", "2026-11"] },
    productName: "",
    generatedAt: "2026-11-06T12:00:00.000Z",
  };
  assert.deepEqual(
    summarizeSalesReport(imported.sales, [refund], [], filters),
    {
      salesCount: 3,
      refundsCount: 1,
      quantity: 3n,
      salesCents: 27_505n,
      refundsCents: 2_000n,
      netCents: 25_505n,
    },
  );

  const workbook = createSalesWorkbook(imported.sales, [refund], [], filters);
  const reopened = XLSX.read(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }), {
    type: "buffer",
  });
  const summaryRows = XLSX.utils.sheet_to_json(
    reopened.Sheets["Resumo por plano"]!,
    { header: 1, raw: true },
  ) as unknown[][];
  assert.equal(summaryRows.find((row) => row[0] === "Vendas registradas (R$)")?.[1], 275.05);
  assert.equal(summaryRows.find((row) => row[0] === "Estornos (R$)")?.[1], 20);
  assert.equal(summaryRows.find((row) => row[0] === "Faturamento após estornos (R$)")?.[1], 255.05);
});

test("Worker rejects impossible raw calendar dates before Zod can normalize them", async () => {
  const database = new MemorySalesD1();
  const response = await requestWorkerSales(database, "/sales/import", {
    fileHash: "b".repeat(64),
    filename: "datas-sinteticas.xlsx",
    rows: [{
      customerName: "Cliente Sintético",
      saleDate: "2026-02-31",
      totalCents: 1_000,
      sourceSheet: "Vendas",
      sourceRow: 2,
    }],
  });

  assert.equal(response.status, 400);
  assert.match((await response.json() as { error: string }).error, /Data da venda inválida/);
  assert.equal(database.sales.size, 0);
  assert.equal(database.queries.length, 0, "invalid input fails before any database operation");
});
