import { randomUUID } from "node:crypto";
import pg from "pg";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set before backfilling product links.");
}
if (process.env.NODE_ENV === "production") {
  throw new Error("This backfill is for the development database only; do not run it in production.");
}

const { Client } = pg;
const client = new Client({ connectionString: process.env.DATABASE_URL });

function normalizeName(value) {
  return value.trim().replace(/\s+/g, " ");
}

function nameKey(value) {
  return normalizeName(value).toLocaleLowerCase("pt-BR");
}

async function ensureProduct(name, suggestedPriceCents) {
  const normalized = normalizeName(name);
  const key = nameKey(normalized);
  if (!normalized || !key) {
    throw new Error("A legacy sale or goal has a blank product name.");
  }

  const existing = await client.query(
    "SELECT id, name FROM products WHERE normalized_name = $1 LIMIT 1",
    [key],
  );
  if (existing.rows[0]) return existing.rows[0];

  await client.query(
    `INSERT INTO products (id, name, normalized_name, suggested_price_cents)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (normalized_name) DO NOTHING`,
    [randomUUID(), normalized, key, suggestedPriceCents],
  );
  const insertedOrConcurrent = await client.query(
    "SELECT id, name FROM products WHERE normalized_name = $1 LIMIT 1",
    [key],
  );
  if (!insertedOrConcurrent.rows[0]) {
    throw new Error("Could not create a product for a legacy name.");
  }
  return insertedOrConcurrent.rows[0];
}

await client.connect();
try {
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(5062, 1)");
  await client.query("LOCK TABLE sales IN SHARE ROW EXCLUSIVE MODE");
  await client.query("LOCK TABLE sales_goals IN SHARE ROW EXCLUSIVE MODE");
  await client.query("LOCK TABLE products IN SHARE ROW EXCLUSIVE MODE");

  const before = await client.query(`
    SELECT
      (SELECT count(*)::bigint FROM sales) AS sale_count,
      (SELECT coalesce(sum(quantity), 0)::bigint FROM sales) AS quantity_sum,
      (SELECT coalesce(sum(total_cents), 0)::numeric FROM sales) AS total_cents,
      (SELECT count(*)::bigint FROM sales_goals) AS goal_count
  `);

  const unlinkedSales = await client.query(`
    SELECT id, product_name, unit_amount_cents
    FROM sales
    WHERE product_id IS NULL
    ORDER BY created_at, id
  `);
  for (const sale of unlinkedSales.rows) {
    const product = await ensureProduct(sale.product_name, sale.unit_amount_cents);
    await client.query(
      "UPDATE sales SET product_id = $1, updated_at = COALESCE(updated_at, created_at) WHERE id = $2",
      [product.id, sale.id],
    );
  }

  const unlinkedGoals = await client.query(`
    SELECT id, month, product_name
    FROM sales_goals
    WHERE product_name IS NOT NULL AND product_id IS NULL
    ORDER BY month, id
  `);
  for (const goal of unlinkedGoals.rows) {
    const product = await ensureProduct(goal.product_name, 0);
    await client.query(
      `UPDATE sales_goals
       SET product_id = $1, scope_key = $2, product_name = $3,
           version = GREATEST(version, 1), updated_at = COALESCE(updated_at, now())
       WHERE id = $4`,
      [product.id, `product:${product.id}`, normalizeName(goal.product_name), goal.id],
    );
  }

  const remaining = await client.query(`
    SELECT
      (SELECT count(*)::bigint FROM sales WHERE product_id IS NULL) AS unlinked_sales,
      (SELECT count(*)::bigint FROM sales_goals WHERE product_name IS NOT NULL AND product_id IS NULL) AS unlinked_plan_goals
  `);
  if (Number(remaining.rows[0].unlinked_sales) !== 0
    || Number(remaining.rows[0].unlinked_plan_goals) !== 0) {
    throw new Error("Product backfill left records without stable product links.");
  }

  const after = await client.query(`
    SELECT
      (SELECT count(*)::bigint FROM sales) AS sale_count,
      (SELECT coalesce(sum(quantity), 0)::bigint FROM sales) AS quantity_sum,
      (SELECT coalesce(sum(total_cents), 0)::numeric FROM sales) AS total_cents,
      (SELECT count(*)::bigint FROM sales_goals) AS goal_count
  `);
  if (JSON.stringify(before.rows[0]) !== JSON.stringify(after.rows[0])) {
    throw new Error("Sale or goal counts/sums changed during the product backfill.");
  }

  await client.query("COMMIT");
  console.log(JSON.stringify({
    linkedSales: unlinkedSales.rowCount ?? 0,
    linkedPlanGoals: unlinkedGoals.rowCount ?? 0,
    salesAndGoalTotalsPreserved: true,
  }));
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  await client.end();
}
