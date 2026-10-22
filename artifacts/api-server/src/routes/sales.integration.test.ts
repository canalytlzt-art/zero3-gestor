import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { after, before, test } from "node:test";
import express from "express";
import { and, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import * as dbSchema from "@workspace/db/schema";
import {
  db,
  idempotencyKeysTable,
  pool,
  productsTable,
  salesGoalsTable,
  salesHistoryTable,
  salesTable,
} from "@workspace/db";
import { createSalesRouter } from "./sales";

const createdGoalIds: string[] = [];
const createdSaleIds: string[] = [];
const createdProductIds: string[] = [];
const createdIdempotencyKeys: string[] = [];
const testSchemaName = `zero3_goal_test_${randomUUID().replaceAll("-", "")}`;
const PgPool = pool.constructor as new (
  options: typeof pool.options,
) => typeof pool;
let testPool: typeof pool | undefined;
let testDatabase: typeof db | undefined;

before(async () => {
  await pool.query(`CREATE SCHEMA "${testSchemaName}"`);
  testPool = new PgPool({
    ...pool.options,
    options: `-c search_path=${testSchemaName}`,
  });
  testDatabase = drizzle(testPool, { schema: dbSchema });
  await testPool.query(`
    CREATE TABLE products (
      id uuid PRIMARY KEY,
      name text NOT NULL,
      normalized_name text NOT NULL UNIQUE,
      suggested_price_cents bigint NOT NULL DEFAULT 0,
      is_active boolean NOT NULL DEFAULT true,
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE sales (
      id uuid PRIMARY KEY,
      product_id uuid REFERENCES products(id) ON DELETE RESTRICT,
      sale_date date NOT NULL,
      product_name text NOT NULL,
      quantity integer NOT NULL,
      unit_amount_cents bigint NOT NULL,
      total_cents bigint NOT NULL,
      customer_name text,
      notes text,
      status text NOT NULL DEFAULT 'active',
      cancellation_reason text,
      version integer NOT NULL DEFAULT 1,
      created_by text,
      updated_by text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE sales_goals (
      id uuid PRIMARY KEY,
      month text NOT NULL,
      scope_key text NOT NULL,
      product_id uuid REFERENCES products(id) ON DELETE RESTRICT,
      product_name text,
      target_cents bigint NOT NULL,
      version integer NOT NULL DEFAULT 1,
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (month, scope_key)
    );
    CREATE TABLE sales_history (
      id uuid PRIMARY KEY,
      entity_type text NOT NULL,
      entity_id uuid NOT NULL,
      operation text NOT NULL,
      actor_id text NOT NULL,
      before_data jsonb,
      after_data jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE sales_import_batches (
      id uuid PRIMARY KEY,
      actor_id text NOT NULL,
      source text NOT NULL,
      file_hash text NOT NULL,
      status text NOT NULL DEFAULT 'previewed',
      row_count integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      completed_at timestamptz
    );
    CREATE TABLE sales_refunds (
      id uuid PRIMARY KEY,
      sale_id uuid NOT NULL REFERENCES sales(id) ON DELETE RESTRICT,
      refund_date date NOT NULL,
      amount_cents bigint NOT NULL,
      reason text NOT NULL,
      status text NOT NULL DEFAULT 'active',
      void_reason text,
      version integer NOT NULL DEFAULT 1,
      created_by text,
      updated_by text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE idempotency_keys (
      id uuid PRIMARY KEY,
      actor_id text NOT NULL,
      operation text NOT NULL,
      key text NOT NULL,
      request_hash text NOT NULL,
      response_payload jsonb,
      resource_id uuid,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (actor_id, operation, key)
    );
  `);
});

after(async () => {
  if (!testDatabase) {
    if (testPool) await testPool.end();
    await pool.query(`DROP SCHEMA IF EXISTS "${testSchemaName}" CASCADE`);
    await pool.end();
    return;
  }
  const entityIds = [...createdGoalIds, ...createdSaleIds];
  if (entityIds.length) {
    await testDatabase
      .delete(salesHistoryTable)
      .where(
        and(
          inArray(salesHistoryTable.entityId, entityIds),
          inArray(salesHistoryTable.entityType, ["goal", "sale"]),
        ),
      );
  }
  if (createdGoalIds.length) {
    await testDatabase
      .delete(salesGoalsTable)
      .where(inArray(salesGoalsTable.id, createdGoalIds));
  }
  if (createdSaleIds.length) {
    await testDatabase
      .delete(salesTable)
      .where(inArray(salesTable.id, createdSaleIds));
  }
  if (createdProductIds.length) {
    await testDatabase
      .delete(productsTable)
      .where(inArray(productsTable.id, createdProductIds));
  }
  if (createdIdempotencyKeys.length) {
    await testDatabase
      .delete(idempotencyKeysTable)
      .where(inArray(idempotencyKeysTable.key, createdIdempotencyKeys));
  }
  await testPool?.end();
  await pool.query(`DROP SCHEMA IF EXISTS "${testSchemaName}" CASCADE`);
  await pool.end();
});

function getTestDatabase(): typeof db {
  assert.ok(testDatabase);
  return testDatabase;
}

async function withSalesApi(
  database: typeof db,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use(
    "/api",
    createSalesRouter({
      database,
      getUserId: (req) => req.header("x-test-user") ?? null,
      isAuthorized: async (req) => req.header("x-test-authorized") === "true",
    }),
  );
  app.use(
    (
      _error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res.status(500).json({ error: "Internal server error" });
    },
  );

  const server = await new Promise<Server>((resolve) => {
    const listeningServer = app.listen(0, "127.0.0.1", () =>
      resolve(listeningServer),
    );
  });
  const address = server.address() as AddressInfo;

  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function headers(
  auth: "authorized" | "unauthorized" | "anonymous" = "authorized",
) {
  if (auth === "anonymous") return { "content-type": "application/json" };
  return {
    "content-type": "application/json",
    "x-test-user": auth === "authorized" ? "integration-user" : "blocked-user",
    "x-test-authorized": String(auth === "authorized"),
  };
}

async function apiRequest(
  baseUrl: string,
  path: string,
  options: {
    method?: string;
    body?: unknown;
    auth?: "authorized" | "unauthorized" | "anonymous";
  } = {},
): Promise<Response> {
  return fetch(`${baseUrl}/api${path}`, {
    method: options.method ?? "GET",
    headers: headers(options.auth),
    ...(options.body === undefined
      ? {}
      : { body: JSON.stringify(options.body) }),
  });
}

async function recordSale(
  baseUrl: string,
  productName: string,
  saleDate: string,
): Promise<string> {
  const idempotencyKey = randomUUID();
  createdIdempotencyKeys.push(idempotencyKey);
  const response = await apiRequest(baseUrl, "/sales", {
    method: "POST",
    body: {
      saleDate,
      productName,
      quantity: 1,
      unitAmountCents: 5000,
      notes: null,
      idempotencyKey,
    },
  });
  assert.equal(response.status, 201);
  const sale = (await response.json()) as {
    id: string;
    productId: string;
  };
  createdSaleIds.push(sale.id);
  createdProductIds.push(sale.productId);
  return sale.id;
}

async function saveGoal(
  baseUrl: string,
  month: string,
  productName: string,
  targetCents: number,
): Promise<{
  id: string;
  month: string;
  productName: string | null;
  productId: string | null;
  targetCents: number;
  version: number;
}> {
  const idempotencyKey = randomUUID();
  createdIdempotencyKeys.push(idempotencyKey);
  const response = await apiRequest(baseUrl, "/sales-goals", {
    method: "PUT",
    body: { month, productName, targetCents, idempotencyKey },
  });
  assert.equal(response.status, 200);
  const goal = (await response.json()) as {
    id: string;
    month: string;
    productName: string | null;
    productId: string | null;
    targetCents: number;
    version: number;
  };
  if (!createdGoalIds.includes(goal.id)) createdGoalIds.push(goal.id);
  return goal;
}

function databaseThatFailsGoalReads(database: typeof db): typeof db {
  return new Proxy(database, {
    get(target, property) {
      if (property === "select") {
        return (...args: unknown[]) => {
          const select = Reflect.get(target, property, target) as (
            ...values: unknown[]
          ) => object;
          const query = Reflect.apply(select, target, args);
          return new Proxy(query, {
            get(queryTarget, queryProperty) {
              if (queryProperty === "from") {
                return (table: unknown) => {
                  if (table === salesGoalsTable) {
                    throw new Error("Simulated monthly-goal query failure");
                  }
                  const from = Reflect.get(
                    queryTarget,
                    queryProperty,
                    queryTarget,
                  ) as (value: unknown) => unknown;
                  return Reflect.apply(from, queryTarget, [table]);
                };
              }
              return Reflect.get(queryTarget, queryProperty, queryTarget);
            },
          });
        };
      }

      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as typeof db;
}

test("imports customer, date, and exact total without creating a product or deduplicating legitimate equal sales", async () => {
  const fileHash = randomUUID().replaceAll("-", "").repeat(2);
  createdIdempotencyKeys.push(fileHash);
  const productCountBefore = Number(
    (await testPool!.query("SELECT count(*)::text AS count FROM products")).rows[0]?.count ?? 0,
  );
  const rows = [
    {
      customerName: "Cliente de teste",
      saleDate: "2098-11-15",
      totalCents: 123456,
      sourceSheet: "Vendas",
      sourceRow: 8,
    },
    {
      customerName: "Cliente de teste",
      saleDate: "2098-11-15",
      totalCents: 123456,
      sourceSheet: "Vendas",
      sourceRow: 9,
    },
  ];
  const requestBody = {
    fileHash,
    filename: "vendas-teste.xlsx",
    rows,
  };

  await withSalesApi(getTestDatabase(), async (baseUrl) => {
    const response = await apiRequest(baseUrl, "/sales/import", {
      method: "POST",
      body: requestBody,
    });
    assert.equal(response.status, 201);
    const imported = (await response.json()) as {
      batchId: string;
      replayed: boolean;
      importedCount: number;
      sales: Array<{
        id: string;
        productId: string | null;
        productName: string;
        customerName: string | null;
        quantity: number;
        unitAmountCents: number;
        totalCents: number;
      }>;
    };
    assert.equal(imported.importedCount, 2);
    assert.equal(imported.replayed, false);
    assert.equal(imported.sales[0].id === imported.sales[1].id, false);
    for (const sale of imported.sales) {
      createdSaleIds.push(sale.id);
      assert.equal(sale.productId, null);
      assert.equal(sale.productName, "Não categorizado");
      assert.equal(sale.customerName, "Cliente de teste");
      assert.equal(sale.quantity, 1);
      assert.equal(sale.unitAmountCents, 123456);
      assert.equal(sale.totalCents, 123456);
    }

    const replay = await apiRequest(baseUrl, "/sales/import", {
      method: "POST",
      body: requestBody,
    });
    assert.equal(replay.status, 200);
    const replayed = (await replay.json()) as typeof imported;
    assert.equal(replayed.replayed, true);
    assert.equal(replayed.importedCount, 2);
    assert.deepEqual(
      replayed.sales.map(({ id }) => id),
      imported.sales.map(({ id }) => id),
    );

    const scoreboardResponse = await apiRequest(
      baseUrl,
      "/sales/scoreboard?fromDate=2098-11-01&toDate=2098-11-30",
    );
    assert.equal(scoreboardResponse.status, 200);
    const scoreboard = (await scoreboardResponse.json()) as {
      totals: { quantity: number; salesCents: number };
      products: Array<{
        productId: string | null;
        productName: string;
        quantity: number;
        salesCents: number;
      }>;
    };
    assert.equal(scoreboard.totals.quantity, 2);
    assert.equal(scoreboard.totals.salesCents, 246912);
    assert.deepEqual(
      scoreboard.products.map(({ productId, productName, quantity, salesCents }) => ({
        productId,
        productName,
        quantity,
        salesCents,
      })),
      [{
        productId: null,
        productName: "Não categorizado",
        quantity: 2,
        salesCents: 246912,
      }],
    );

    const historyResponse = await apiRequest(
      baseUrl,
      `/sales/${imported.sales[0].id}/history`,
    );
    assert.equal(historyResponse.status, 200);
    const history = (await historyResponse.json()) as Array<{
      afterData: Record<string, unknown> | null;
    }>;
    assert.equal(history[0]?.afterData?.sourceSheet, "Vendas");
    assert.equal(history[0]?.afterData?.sourceRow, 8);
    assert.equal(
      history[0]?.afterData?.sourceFileName,
      "vendas-teste.xlsx",
    );
  });

  const productCountAfter = Number(
    (await testPool!.query("SELECT count(*)::text AS count FROM products")).rows[0]?.count ?? 0,
  );
  assert.equal(productCountAfter, productCountBefore);
});

test("monthly goals persist by month and plan, enforce access, and don't block sales", async () => {
  const suffix = randomUUID();
  const planA = `Plano integração A ${suffix}`;
  const planB = `Plano integração B ${suffix}`;

  await withSalesApi(getTestDatabase(), async (baseUrl) => {
    await recordSale(baseUrl, planA, "2098-11-05");
    await recordSale(baseUrl, planA, "2098-12-05");
    await recordSale(baseUrl, planB, "2098-11-06");

    const first = await saveGoal(baseUrl, "2098-11", planA, 125000);
    const updated = await saveGoal(baseUrl, "2098-11", planA, 185000);
    assert.equal(
      updated.id,
      first.id,
      "saving the same month and plan updates the existing goal",
    );
    assert.equal(updated.targetCents, 185000);
    assert.equal(updated.version, first.version + 1);

    const nextMonth = await saveGoal(baseUrl, "2098-12", planA, 220000);
    const otherPlan = await saveGoal(baseUrl, "2098-11", planB, 275000);
    assert.notEqual(nextMonth.id, updated.id);
    assert.notEqual(otherPlan.id, updated.id);

    const blockedRead = await apiRequest(baseUrl, "/sales-goals", {
      auth: "unauthorized",
    });
    assert.equal(
      blockedRead.status,
      403,
      "an authenticated but unauthorized user cannot read goals",
    );
    const blockedWrite = await apiRequest(baseUrl, "/sales-goals", {
      method: "PUT",
      auth: "unauthorized",
      body: {
        month: "2098-11",
        productName: planA,
        targetCents: 999999,
        idempotencyKey: randomUUID(),
      },
    });
    assert.equal(
      blockedWrite.status,
      403,
      "an authenticated but unauthorized user cannot change goals",
    );
    const anonymousRead = await apiRequest(baseUrl, "/sales-goals", {
      auth: "anonymous",
    });
    assert.equal(
      anonymousRead.status,
      401,
      "an anonymous user cannot read goals",
    );
    const anonymousWrite = await apiRequest(baseUrl, "/sales-goals", {
      method: "PUT",
      auth: "anonymous",
      body: {
        month: "2098-11",
        productName: planA,
        targetCents: 999999,
        idempotencyKey: randomUUID(),
      },
    });
    assert.equal(
      anonymousWrite.status,
      401,
      "an anonymous user cannot change goals",
    );

    // A new GET models the Scoreboard's refetch-on-mount after a page reload.
    const reloadedScoreboard = await apiRequest(baseUrl, "/sales-goals");
    assert.equal(reloadedScoreboard.status, 200);
    const persisted = (await reloadedScoreboard.json()) as Array<{
      id: string;
      month: string;
      productName: string | null;
      productId: string | null;
      targetCents: number;
      version: number;
    }>;
    const savedA = persisted.find((goal) => goal.id === updated.id);
    assert.deepEqual(
      savedA && {
        month: savedA.month,
        productName: savedA.productName,
        productId: savedA.productId,
        targetCents: savedA.targetCents,
        version: savedA.version,
      },
      {
        month: "2098-11",
        productName: planA,
        productId: updated.productId,
        targetCents: 185000,
        version: updated.version,
      },
    );
    assert.equal(
      persisted.find((goal) => goal.id === nextMonth.id)?.targetCents,
      220000,
    );
    assert.equal(
      persisted.find((goal) => goal.id === otherPlan.id)?.targetCents,
      275000,
    );
  });

  await withSalesApi(
    databaseThatFailsGoalReads(getTestDatabase()),
    async (baseUrl) => {
      const failedGoalsRead = await apiRequest(baseUrl, "/sales-goals");
      assert.equal(
        failedGoalsRead.status,
        500,
        "the test database simulates a failed goal lookup",
      );

      const saleId = await recordSale(
        baseUrl,
        `Plano venda independente ${suffix}`,
        "2098-12-20",
      );
      assert.ok(saleId, "sale creation still succeeds when goal lookup fails");
    },
  );
});
