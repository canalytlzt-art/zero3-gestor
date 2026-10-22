import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { db, pool, productsTable, salesTable, salesRefundsTable, salesGoalsTable, salesHistoryTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import {
  analyzeMonthlyBackupRestore, applyMonthlyBackupRestore, buildMonthlySalesBackup,
  monthlyBackupV2RuntimeSchema, RestoreBlockedError,
} from "../src/routes/sales";
import { createSalesWorkbook } from "../../zero3-pro-vendas/src/lib/sales-workbook";
import { parseMonthlySalesBackup } from "../../zero3-pro-vendas/src/lib/sales-export";

if (process.env.NODE_ENV === "production") throw new Error("Verification is forbidden in production.");
const XLSX = createRequire(new URL("../../zero3-pro-vendas/package.json", import.meta.url))("xlsx");
const done = new Error("ROLLBACK_TEST_ONLY");
const passed: string[] = [];
const check = (name: string) => passed.push(name);
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const baseline = await db.execute(sql`select count(*)::text as count, coalesce(sum(total_cents),0)::text as total from public.sales`);

try {
  await db.transaction(async (tx) => {
    // Private transaction-local tables shadow public tables. No fixture enters shared records.
    for (const table of ["products", "sales", "sales_refunds", "sales_goals", "sales_history"]) {
      await tx.execute(sql.raw(`create temporary table ${table} (like public.${table} including all) on commit drop`));
    }
    const productIds = [randomUUID(), randomUUID(), randomUUID()];
    const saleIds = Array.from({ length: 6 }, () => randomUUID());
    const refundIds = Array.from({ length: 4 }, () => randomUUID());
    const names = ["Plano 12 aulas", "Plano 8 aulas", "Aula avulsa"];
    await tx.insert(productsTable).values(names.map((name, i) => ({
      id: productIds[i], name, normalizedName: name.toLocaleLowerCase("pt-BR"),
      suggestedPriceCents: [30000, 22000, 6000][i],
    })));
    const dates = ["2026-10-05", "2026-10-12", "2026-10-20", "2026-11-02", "2026-11-07", "2026-11-10"];
    await tx.insert(salesTable).values(dates.map((saleDate, i) => ({
      id: saleIds[i], productId: productIds[i % 3], productName: names[i % 3], saleDate,
      quantity: [2, 3, 1, 3, 1, 2][i], unitAmountCents: [30000, 22000, 6000][i % 3],
      totalCents: [60000, 66000, 6000, 90000, 22000, 12000][i],
      customerName: i === 3 ? "Ana Exemplo" : null,
      notes: i === 3 ? '=HYPERLINK("https://example.invalid")' : null,
    })));
    await tx.insert(salesRefundsTable).values([
      { id: refundIds[0], saleId: saleIds[0], refundDate: "2026-10-21", amountCents: 10000, reason: "Parcial" },
      { id: refundIds[1], saleId: saleIds[1], refundDate: "2026-11-15", amountCents: 66000, reason: "+literal text" },
      { id: refundIds[2], saleId: saleIds[3], refundDate: "2026-11-16", amountCents: 20000, reason: "Parcial" },
      { id: refundIds[3], saleId: saleIds[1], refundDate: "2026-10-20", amountCents: 10000, reason: "Anulado", status: "voided", voidReason: "Correção" },
    ]);
    await tx.insert(salesGoalsTable).values({
      id: randomUUID(), month: "2026-11", scopeKey: "all-plans", productId: null, productName: null, targetCents: 100000,
    });
    await tx.insert(salesHistoryTable).values({
      id: randomUUID(), entityType: "sale", entityId: saleIds[1], operation: "create",
      actorId: "isolated-test", beforeData: null, afterData: { totalCents: 66000 },
    });

    const sourceSales = clone(await tx.select().from(salesTable));
    const sourceProducts = clone(await tx.select().from(productsTable));
    const sourceRefunds = clone(await tx.select().from(salesRefundsTable)).map((refund) => {
      const sale = sourceSales.find(({ id }) => id === refund.saleId)!;
      return { ...refund, saleDate: sale.saleDate, productId: sale.productId, productName: sale.productName,
        quantity: sale.quantity, unitAmountCents: sale.unitAmountCents, totalCents: sale.totalCents, saleStatus: sale.status };
    });
    const backup = monthlyBackupV2RuntimeSchema.parse(await buildMonthlySalesBackup("2026-11", tx));
    parseMonthlySalesBackup(backup);
    assert.equal(backup.counts.periodSales, 3);
    assert.equal(backup.counts.periodRefunds, 2);
    assert.equal(backup.counts.dependencySales, 1);
    assert.equal(backup.counts.dependencyRefunds, 1);
    assert.equal(backup.sales.find(({ record }) => record.id === saleIds[1])?.record.saleDate, "2026-10-12");
    assert.equal(backup.sales.find(({ record }) => record.id === saleIds[3])?.record.customerName, "Ana Exemplo");
    assert.equal(backup.refunds.find(({ record }) => record.id === refundIds[3])?.record.status, "voided");
    assert.equal(backup.histories.length, 1);
    check("November backup preserves October sale, voided dependency, IDs, and history");

    const exportFilters = { fromDate: "2026-11-01", toDate: "2026-11-30", productName: "", generatedAt: "isolated test" };
    const workbook = createSalesWorkbook(sourceSales as never, sourceRefunds as never, sourceProducts as never, exportFilters);
    const bytes = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
    assert.equal(bytes.subarray(0, 2).toString(), "PK");
    const opened = XLSX.read(bytes, { type: "buffer", cellFormula: true });
    assert.deepEqual(opened.SheetNames, ["Lançamentos", "Resumo por plano"]);
    const detail = XLSX.utils.sheet_to_json(opened.Sheets["Lançamentos"], { header: 1, raw: true }) as unknown[][];
    assert.equal(detail.length, 6); // Three November sales plus two active November refunds.
    assert.equal(detail.find((row) => row[1] === saleIds[3])?.[14], "Ana Exemplo");
    assert.equal(detail.find((row) => row[1] === refundIds[2])?.[14], "Ana Exemplo");
    const octoberRefund = detail.find((row) => row[1] === refundIds[1])!;
    assert.equal(octoberRefund[10], 0);
    assert.equal(octoberRefund[11], 660);
    assert.equal(octoberRefund[12], -660);
    assert.equal(octoberRefund[8] ?? "", "");
    const summary = XLSX.utils.sheet_to_json(opened.Sheets["Resumo por plano"], { header: 1, raw: true }) as unknown[][];
    assert.equal(summary.find((row) => row[0] === "Faturamento após estornos (R$)")?.[1], 380);
    assert.equal(summary.find((row) => row[0] === "Quantidade vendida")?.[1], 6);
    for (const sheet of Object.values(opened.Sheets) as Array<Record<string, { f?: string; t?: string; v?: unknown }>>) {
      for (const [address, cell] of Object.entries(sheet)) if (!address.startsWith("!")) assert.equal(cell.f, undefined);
    }
    assert.equal(opened.Sheets["Resumo por plano"].B9.t, "n");
    const specific = createSalesWorkbook(sourceSales as never, sourceRefunds as never, sourceProducts as never, { ...exportFilters, productName: names[1] });
    assert.equal(specific.Sheets["Resumo por plano"].B9.v, -440);
    const renamedProducts = sourceProducts.map((product) => product.id === productIds[1] ? { ...product, name: "Oito aulas Premium" } : product);
    const renamed = createSalesWorkbook(sourceSales as never, sourceRefunds as never, renamedProducts as never, { ...exportFilters, productName: "Oito aulas Premium" });
    assert.equal(renamed.Sheets["Resumo por plano"].B9.v, -440);
    const empty = createSalesWorkbook(sourceSales as never, sourceRefunds as never, sourceProducts as never, { ...exportFilters, fromDate: "2026-12-01", toDate: "2026-12-31" });
    assert.equal(empty.Sheets["Lançamentos"]["!ref"], "A1:O1");
    assert.equal(empty.Sheets["Resumo por plano"].B9.v, 0);
    check("real XLSX round-trip: numeric money, literal text, refund dates, negative net, and empty period");

    await tx.execute(sql`truncate pg_temp.sales_history, pg_temp.sales_refunds, pg_temp.sales_goals, pg_temp.sales, pg_temp.products`);
    const preview = await analyzeMonthlyBackupRestore(tx, backup as never);
    assert.deepEqual(preview.preview.dependencyMonths, ["2026-10"]);
    assert.equal(preview.preview.blocked, false);
    const restored = await applyMonthlyBackupRestore(tx, backup as never, "isolated-test");
    assert.equal(restored.inserted.sales, 4);
    assert.equal(restored.inserted.refunds, 3);
    const [restoredNamedSale] = await tx.select().from(salesTable).where(eq(salesTable.id, saleIds[3]));
    assert.equal(restoredNamedSale.customerName, "Ana Exemplo");
    const totals = await tx.execute(sql`
      select
      (select sum(total_cents) from sales where status='active' and sale_date between '2026-11-01' and '2026-11-30')::text as sales,
      (select sum(amount_cents) from sales_refunds where status='active' and refund_date between '2026-11-01' and '2026-11-30')::text as refunds`);
    assert.equal(Number(totals.rows[0].sales) - Number(totals.rows[0].refunds), 38000);
    const repeat = await applyMonthlyBackupRestore(tx, backup as never, "isolated-test");
    assert.equal(Object.values(repeat.inserted).reduce((sum, count) => sum + count, 0), 0);
    assert.equal(repeat.identical.sales, 4);
    check("restore into empty isolated tables preserves November net R$ 380; repeat creates no duplicate");

    const legacyWithoutName = clone(backup);
    for (const sale of legacyWithoutName.sales) delete sale.record.customerName;
    const legacyRecord = clone(legacyWithoutName.sales.find(({ record }) => record.id === saleIds[4])!.record);
    const legacyNewSaleId = randomUUID();
    legacyRecord.id = legacyNewSaleId;
    legacyWithoutName.sales.push({ scope: "period", record: legacyRecord });
    legacyWithoutName.counts.periodSales += 1;
    legacyWithoutName.counts.totalRecords += 1;
    monthlyBackupV2RuntimeSchema.parse(legacyWithoutName);
    const legacyRollback = new Error("ROLLBACK_LEGACY_BACKUP_CASE");
    try {
      await tx.transaction(async (nested) => {
        const restoredLegacy = await applyMonthlyBackupRestore(nested, legacyWithoutName as never, "isolated-test");
        assert.equal(restoredLegacy.inserted.sales, 1);
        const [sale] = await nested.select().from(salesTable).where(eq(salesTable.id, legacyNewSaleId));
        assert.equal(sale.customerName, null);
        throw legacyRollback;
      });
    } catch (error) {
      if (error !== legacyRollback) throw error;
    }
    check("legacy V2 backup without customer name restores with a null name");

    const duplicateFields = clone(backup);
    const original = duplicateFields.sales.find(({ record }) => record.id === saleIds[4])!;
    duplicateFields.sales.push(
      { scope: "period", record: { ...original.record, id: randomUUID() } },
      { scope: "period", record: { ...original.record, id: randomUUID() } },
    );
    duplicateFields.counts.periodSales += 2;
    duplicateFields.counts.totalRecords += 2;
    monthlyBackupV2RuntimeSchema.parse(duplicateFields);
    const duplicateCaseRollback = new Error("ROLLBACK_DUPLICATE_CASE");
    try {
      await tx.transaction(async (nested) => {
        const restoredDuplicates = await applyMonthlyBackupRestore(nested, duplicateFields as never, "isolated-test");
        assert.equal(restoredDuplicates.inserted.sales, 2);
        throw duplicateCaseRollback;
      });
    } catch (error) {
      if (error !== duplicateCaseRollback) throw error;
    }
    check("legitimate sales with identical date/product/value and different IDs both survive restoration");

    await tx.update(salesTable).set({ unitAmountCents: 35000, totalCents: 105000, version: 2 }).where(eq(salesTable.id, saleIds[3]));
    const stale = await applyMonthlyBackupRestore(tx, backup as never, "isolated-test");
    assert.ok(stale.conflicts.some(({ id }) => id === saleIds[3]));
    const [kept] = await tx.select().from(salesTable).where(eq(salesTable.id, saleIds[3]));
    assert.equal(kept.totalCents, 105000);
    check("old backup reports conflict and does not overwrite newer sale");
    await tx.update(salesTable).set({ unitAmountCents: 30000, totalCents: 90000, version: 1 }).where(eq(salesTable.id, saleIds[3]));

    await tx.insert(salesRefundsTable).values({ id: randomUUID(), saleId: saleIds[3], refundDate: "2026-11-18", amountCents: 50000, reason: "Existing current refund" });
    const conflicting = clone(backup);
    conflicting.refunds.push({ scope: "period", record: { ...clone(backup.refunds.find(({ record }) => record.id === refundIds[2])!.record), id: randomUUID(), amountCents: 40000 } });
    conflicting.counts.periodRefunds += 1;
    conflicting.counts.totalRecords += 1;
    monthlyBackupV2RuntimeSchema.parse(conflicting);
    assert.equal((await analyzeMonthlyBackupRestore(tx, conflicting as never)).preview.blocked, true);
    await assert.rejects(() => applyMonthlyBackupRestore(tx, conflicting as never, "isolated-test"), RestoreBlockedError);
    const bad = clone(backup);
    bad.sales[0].record.totalCents += 1;
    assert.equal(monthlyBackupV2RuntimeSchema.safeParse(bad).success, false);
    check("invalid totals and combined refund overflow block restoration");

    const newProductId = randomUUID();
    const invalidSql = clone(backup);
    invalidSql.products = [{ scope: "dependency", record: { ...backup.products[0].record, id: newProductId, name: "Atomic test", normalizedName: "atomic test" } }];
    invalidSql.sales = [{ scope: "period", record: { ...backup.sales.find(({ scope }) => scope === "period")!.record, id: randomUUID(), productId: newProductId, quantity: 0, totalCents: 0 } }];
    invalidSql.refunds = [];
    invalidSql.goals = [];
    invalidSql.histories = [];
    await assert.rejects(() => tx.transaction((nested) => applyMonthlyBackupRestore(nested, invalidSql as never, "isolated-test")));
    assert.equal((await tx.select().from(productsTable).where(eq(productsTable.id, newProductId))).length, 0);
    check("SQL failure rolls back preceding inserts atomically");

    const emptyBackup = await buildMonthlySalesBackup("2035-01", tx);
    assert.equal(emptyBackup.counts.totalRecords, 0);
    check("empty month creates no fictitious records");
    throw done;
  });
} catch (error) {
  if (error !== done) throw error;
} finally {
  const after = await db.execute(sql`select count(*)::text as count, coalesce(sum(total_cents),0)::text as total from public.sales`);
  assert.deepEqual(after.rows, baseline.rows, "Shared real sales changed during isolated verification");
  await pool.end();
}
console.log(JSON.stringify({ environment: "development; temporary tables + rollback; public records unchanged", passed }, null, 2));
