import { randomUUID } from "node:crypto";
import pg from "pg";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set before verifying the sales schema.");
}
if (process.env.NODE_ENV === "production") {
  throw new Error("Schema verification is restricted to a non-production database.");
}

const { Client } = pg;
const client = new Client({ connectionString: process.env.DATABASE_URL });
const passed = [];
let savepointNumber = 0;

async function expectFailure(label, operation) {
  const savepoint = `sales_schema_case_${++savepointNumber}`;
  await client.query(`SAVEPOINT ${savepoint}`);
  let failed = false;
  try {
    await operation();
  } catch {
    failed = true;
  }
  await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
  await client.query(`RELEASE SAVEPOINT ${savepoint}`);
  if (!failed) throw new Error(`Expected database constraint failure: ${label}`);
  passed.push(label);
}

await client.connect();
try {
  await client.query("BEGIN");
  const productId = randomUUID();
  const saleId = randomUUID();
  const saleDate = "2026-10-22";
  await client.query(
    `INSERT INTO products (id, name, normalized_name, suggested_price_cents)
     VALUES ($1, $2, $3, $4)`,
    [productId, "Schema Verification", "schema verification", 1234],
  );

  await client.query(
    `INSERT INTO sales (id, product_id, sale_date, product_name, quantity, unit_amount_cents, total_cents, customer_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [saleId, productId, saleDate, "Schema Verification", 2, 1234, 2468, "Ana Teste"],
  );
  const validSale = await client.query(
    "SELECT quantity, unit_amount_cents, total_cents, customer_name FROM sales WHERE id = $1",
    [saleId],
  );
  if (
    Number(validSale.rows[0]?.quantity) !== 2
    || Number(validSale.rows[0]?.unit_amount_cents) !== 1234
    || Number(validSale.rows[0]?.total_cents) !== 2468
    || validSale.rows[0]?.customer_name !== "Ana Teste"
  ) {
    throw new Error("Sale amount or customer name did not persist exactly.");
  }
  passed.push("exact cents and calculated total");
  passed.push("customer name persistence");

  await expectFailure("positive quantity constraint", () => client.query(
    `INSERT INTO sales (id, product_id, sale_date, product_name, quantity, unit_amount_cents, total_cents)
     VALUES ($1, $2, $3, $4, 0, 1234, 0)`,
    [randomUUID(), productId, saleDate, "Invalid quantity"],
  ));
  await expectFailure("calendar date constraint", () => client.query(
    `INSERT INTO sales (id, product_id, sale_date, product_name, quantity, unit_amount_cents, total_cents)
     VALUES ($1, $2, '2026-02-30', $3, 1, 100, 100)`,
    [randomUUID(), productId, "Invalid date"],
  ));
  await expectFailure("product foreign key constraint", () => client.query(
    `INSERT INTO sales (id, product_id, sale_date, product_name, quantity, unit_amount_cents, total_cents)
     VALUES ($1, $2, $3, $4, 1, 100, 100)`,
    [randomUUID(), randomUUID(), saleDate, "Missing product"],
  ));
  await expectFailure("sale total consistency constraint", () => client.query(
    `INSERT INTO sales (id, product_id, sale_date, product_name, quantity, unit_amount_cents, total_cents)
     VALUES ($1, $2, $3, $4, 2, 1234, 2467)`,
    [randomUUID(), productId, saleDate, "Wrong total"],
  ));

  const goalId = randomUUID();
  await client.query(
    `INSERT INTO sales_goals (id, month, scope_key, product_id, product_name, target_cents)
     VALUES ($1, '2026-10', $2, $3, $4, 123456)`,
    [goalId, `product:${productId}`, productId, "Schema Verification"],
  );
  await expectFailure("goal product and scope consistency", () => client.query(
    `INSERT INTO sales_goals (id, month, scope_key, product_id, product_name, target_cents)
     VALUES ($1, '2026-10', 'all-plans', $2, $3, 100)`,
    [randomUUID(), productId, "Invalid general goal"],
  ));

  await client.query(
    `INSERT INTO sales_refunds (id, sale_id, refund_date, amount_cents, reason)
     VALUES ($1, $2, $3, 300, 'Schema verification')`,
    [randomUUID(), saleId, saleDate],
  );
  await expectFailure("positive refund amount constraint", () => client.query(
    `INSERT INTO sales_refunds (id, sale_id, refund_date, amount_cents, reason)
     VALUES ($1, $2, $3, 0, 'Invalid refund')`,
    [randomUUID(), saleId, saleDate],
  ));

  const idempotencyKey = randomUUID();
  const idempotencyId = randomUUID();
  const requestHash = "a".repeat(64);
  await client.query(
    `INSERT INTO idempotency_keys (id, actor_id, operation, key, request_hash, response_payload, resource_id)
     VALUES ($1, 'schema-test-actor', 'sale-create', $2, $3, $4::jsonb, $5)`,
    [idempotencyId, idempotencyKey, requestHash, JSON.stringify({ id: saleId }), saleId],
  );
  await expectFailure("persistent idempotency key uniqueness", () => client.query(
    `INSERT INTO idempotency_keys (id, actor_id, operation, key, request_hash, response_payload)
     VALUES ($1, 'schema-test-actor', 'sale-create', $2, $3, '{}'::jsonb)`,
    [randomUUID(), idempotencyKey, requestHash],
  ));

  const scoreboardProducts = [
    { name: "Scoreboard Plan 12", normalized: "scoreboard plan 12" },
    { name: "Scoreboard Plan 8", normalized: "scoreboard plan 8" },
    { name: "Scoreboard Aula avulsa", normalized: "scoreboard aula avulsa" },
  ].map((product) => ({ ...product, id: randomUUID() }));
  for (const product of scoreboardProducts) {
    await client.query(
      `INSERT INTO products (id, name, normalized_name, suggested_price_cents)
       VALUES ($1, $2, $3, 0)`,
      [product.id, product.name, product.normalized],
    );
  }
  const scoreboardSales = [
    { product: 0, date: "2026-10-05", quantity: 2, unit: 24000, total: 48000 },
    { product: 0, date: "2026-11-05", quantity: 3, unit: 34000, total: 102000 },
    { product: 1, date: "2026-10-12", quantity: 3, unit: 22000, total: 66000 },
    { product: 1, date: "2026-11-21", quantity: 1, unit: 22000, total: 22000 },
    { product: 2, date: "2026-10-13", quantity: 3, unit: 6000, total: 18000 },
  ].map((sale) => ({ ...sale, id: randomUUID() }));
  for (const sale of scoreboardSales) {
    const product = scoreboardProducts[sale.product];
    await client.query(
      `INSERT INTO sales (id, product_id, sale_date, product_name, quantity, unit_amount_cents, total_cents)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [sale.id, product.id, sale.date, product.name, sale.quantity, sale.unit, sale.total],
    );
  }
  const scoreboardRefunds = [
    { sale: 0, date: "2026-10-12", amount: 30000 },
    { sale: 2, date: "2026-11-15", amount: 66000 },
  ];
  for (const refund of scoreboardRefunds) {
    await client.query(
      `INSERT INTO sales_refunds (id, sale_id, refund_date, amount_cents, reason)
       VALUES ($1, $2, $3, $4, 'Scoreboard verification')`,
      [randomUUID(), scoreboardSales[refund.sale].id, refund.date, refund.amount],
    );
  }

  const periodSales = await client.query(
    `SELECT s.product_id, p.name AS product_name, to_char(s.sale_date, 'YYYY-MM') AS month,
            sum(s.quantity)::text AS quantity, sum(s.total_cents)::text AS sales_cents
     FROM sales s
     JOIN products p ON p.id = s.product_id
     WHERE s.status = 'active' AND s.product_id = ANY($1::uuid[])
       AND s.sale_date BETWEEN $2::date AND $3::date
     GROUP BY s.product_id, p.name, to_char(s.sale_date, 'YYYY-MM')`,
    [scoreboardProducts.map((product) => product.id), "2026-10-01", "2026-11-30"],
  );
  const periodRefunds = await client.query(
    `SELECT s.product_id, p.name AS product_name, to_char(r.refund_date, 'YYYY-MM') AS month,
            sum(r.amount_cents)::text AS refund_cents
     FROM sales_refunds r
     JOIN sales s ON s.id = r.sale_id
     JOIN products p ON p.id = s.product_id
     WHERE r.status = 'active' AND s.product_id = ANY($1::uuid[])
       AND r.refund_date BETWEEN $2::date AND $3::date
     GROUP BY s.product_id, p.name, to_char(r.refund_date, 'YYYY-MM')`,
    [scoreboardProducts.map((product) => product.id), "2026-10-01", "2026-11-30"],
  );
  const productTotals = new Map();
  const monthTotals = new Map();
  const addAggregate = (map, key, values) => {
    const aggregate = map.get(key) ?? { quantity: 0, sales: 0, refunds: 0 };
    aggregate.quantity += values.quantity ?? 0;
    aggregate.sales += values.sales ?? 0;
    aggregate.refunds += values.refunds ?? 0;
    map.set(key, aggregate);
  };
  for (const row of periodSales.rows) {
    const values = { quantity: Number(row.quantity), sales: Number(row.sales_cents) };
    addAggregate(productTotals, row.product_id, values);
    addAggregate(monthTotals, row.month, values);
  }
  for (const row of periodRefunds.rows) {
    const values = { refunds: Number(row.refund_cents) };
    addAggregate(productTotals, row.product_id, values);
    addAggregate(monthTotals, row.month, values);
  }
  const periodTotals = [...productTotals.values()].reduce((total, row) => ({
    quantity: total.quantity + row.quantity,
    sales: total.sales + row.sales,
    refunds: total.refunds + row.refunds,
  }), { quantity: 0, sales: 0, refunds: 0 });
  if (
    periodTotals.quantity !== 12
    || periodTotals.sales !== 256000
    || periodTotals.refunds !== 96000
    || periodTotals.sales - periodTotals.refunds !== 160000
    || productTotals.get(scoreboardProducts[0].id)?.sales !== 150000
    || productTotals.get(scoreboardProducts[0].id)?.refunds !== 30000
    || productTotals.get(scoreboardProducts[1].id)?.sales !== 88000
    || productTotals.get(scoreboardProducts[1].id)?.refunds !== 66000
    || productTotals.get(scoreboardProducts[2].id)?.sales !== 18000
  ) {
    throw new Error("October–November product aggregates did not reconcile.");
  }
  passed.push("separate sales and refunds reconcile by product for October–November");
  if (
    monthTotals.get("2026-10")?.quantity !== 8
    || monthTotals.get("2026-10")?.sales !== 132000
    || monthTotals.get("2026-10")?.refunds !== 30000
    || monthTotals.get("2026-11")?.quantity !== 4
    || monthTotals.get("2026-11")?.sales !== 124000
    || monthTotals.get("2026-11")?.refunds !== 66000
  ) {
    throw new Error("Monthly sales and refund aggregates did not reconcile.");
  }
  passed.push("monthly aggregates use sale dates and refund dates separately");

  const refundsOnlyDate = await client.query(
    `SELECT coalesce(sum(s.quantity), 0)::text AS quantity,
            coalesce(sum(s.total_cents), 0)::text AS sales_cents
     FROM sales s
     WHERE s.status = 'active' AND s.product_id = $1 AND s.sale_date = $2::date`,
    [scoreboardProducts[1].id, "2026-11-15"],
  );
  const refundsOnlyDateRefunds = await client.query(
    `SELECT coalesce(sum(r.amount_cents), 0)::text AS refund_cents
     FROM sales_refunds r
     JOIN sales s ON s.id = r.sale_id
     WHERE r.status = 'active' AND s.product_id = $1 AND r.refund_date = $2::date`,
    [scoreboardProducts[1].id, "2026-11-15"],
  );
  if (
    Number(refundsOnlyDate.rows[0]?.quantity) !== 0
    || Number(refundsOnlyDate.rows[0]?.sales_cents) !== 0
    || Number(refundsOnlyDateRefunds.rows[0]?.refund_cents) !== 66000
  ) {
    throw new Error("A refund without a sale on its movement date was not retained.");
  }
  passed.push("refund-only date retains negative-net product movement");

  await client.query("ROLLBACK");
  console.log(JSON.stringify({ passed }));
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  await client.end();
}
