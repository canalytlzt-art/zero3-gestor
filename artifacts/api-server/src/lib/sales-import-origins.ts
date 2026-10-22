import { db, salesHistoryTable, salesImportBatchesTable } from "@workspace/db";
import { and, eq, or, sql } from "drizzle-orm";

/** Audit origins survive edits/cancellations and new backups; legacy batches are joined too. */
export async function getSalesImportOrigins(database: Pick<typeof db, "select">, fileHash: string) {
  const history = await database.select({
    saleId: salesHistoryTable.entityId,
    data: salesHistoryTable.afterData,
  }).from(salesHistoryTable).leftJoin(salesImportBatchesTable,
    sql`${salesHistoryTable.afterData}->>'importBatchId' = ${salesImportBatchesTable.id}::text`,
  ).where(and(
    eq(salesHistoryTable.entityType, "sale"),
    eq(salesHistoryTable.operation, "import"),
    or(
      sql`${salesHistoryTable.afterData}->>'sourceFileHash' = ${fileHash}`,
      eq(salesImportBatchesTable.fileHash, fileHash),
    ),
  ));
  const origins = new Map<string, { sourceSheet: string; sourceRow: number; saleId: string }>();
  for (const { saleId, data } of history) {
    if (typeof data?.sourceSheet !== "string" || !Number.isInteger(data.sourceRow) || Number(data.sourceRow) < 1) continue;
    const sourceRow = Number(data.sourceRow);
    origins.set(`${data.sourceSheet}:${sourceRow}`, { sourceSheet: data.sourceSheet, sourceRow, saleId });
  }
  return origins;
}
