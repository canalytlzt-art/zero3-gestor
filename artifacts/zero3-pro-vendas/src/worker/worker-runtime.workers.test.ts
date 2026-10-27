import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
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

    const saleId = sale.payload.id as string;
    const products = await callSales("/products");
    expect(products.response.status).toBe(200);
    expect(products.payload.some((product: { name: string }) => product.name === productName)).toBe(true);

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

    const scoreboard = await callSales("/sales/scoreboard?months=2026-12");
    expect(scoreboard.response.status).toBe(200);
    expect(scoreboard.payload.totals).toMatchObject({
      quantity: 3,
      salesCents: 4_500,
      refundCents: 500,
      netCents: 4_000,
    });
  });
});
