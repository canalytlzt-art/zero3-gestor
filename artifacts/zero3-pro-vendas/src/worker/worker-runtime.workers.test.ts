import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { handleSalesRequest } from "./sales";
import type { AuthContext, WorkerEnv } from "./types";

const workerEnv = env as unknown as WorkerEnv;
const authorizedFixture: AuthContext = {
  userId: "vitest-admin-fixture",
  email: "worker-test@example.invalid",
  authorized: true,
};

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
      id: "vitest-sale-october",
      saleDate: "2026-10-10",
      productName: "Plano 12 aulas",
      quantity: 2,
      unitAmountCents: 12_000,
      customerName: "Cliente de teste",
    });
    await insertSale({
      id: "vitest-sale-november",
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
  });
});
