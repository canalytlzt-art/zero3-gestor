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
    `INSERT INTO sales (id, product_id, sale_date, product_name, quantity, unit_amount_cents, total_cents)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [saleId, productId, saleDate, "Schema Verification", 2, 1234, 2468],
  );
  const validSale = await client.query(
    "SELECT quantity, unit_amount_cents, total_cents FROM sales WHERE id = $1",
    [saleId],
  );
  if (
    Number(validSale.rows[0]?.quantity) !== 2
    || Number(validSale.rows[0]?.unit_amount_cents) !== 1234
    || Number(validSale.rows[0]?.total_cents) !== 2468
  ) {
    throw new Error("Cents or calculated sale total did not persist exactly.");
  }
  passed.push("exact cents and calculated total");

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

  await client.query("ROLLBACK");
  console.log(JSON.stringify({ passed }));
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  await client.end();
}
