import { db, salesHistoryTable, salesImportBatchesTable } from "@workspace/db";
import { and, asc, eq, or, sql } from "drizzle-orm";

/** Audit origins survive edits/cancellations and new backups; legacy batches are joined too. */
export async function getSalesImportOrigins(database: Pick<typeof db, "select">, fileHash: string) {
  const history = await database.select({
    entityType: salesHistoryTable.entityType,
    operation: salesHistoryTable.operation,
    entityId: salesHistoryTable.entityId,
    saleId: salesHistoryTable.entityId,
    data: salesHistoryTable.afterData,
    createdAt: salesHistoryTable.createdAt,
  }).from(salesHistoryTable).leftJoin(salesImportBatchesTable,
    sql`${salesHistoryTable.afterData}->>'importBatchId' = ${salesImportBatchesTable.id}::text`,
  ).where(and(
    or(
      eq(salesHistoryTable.entityType, "sale"),
      eq(salesHistoryTable.entityType, "sales-pending-draft"),
    ),
    or(
      sql`${salesHistoryTable.afterData}->>'sourceFileHash' = ${fileHash}`,
      eq(salesImportBatchesTable.fileHash, fileHash),
    ),
  )).orderBy(asc(salesHistoryTable.createdAt), asc(salesHistoryTable.id));
  const origins = new Map<string, {
    sourceSheet: string;
    sourceRow: number;
    state: "sale" | "pending";
    saleId: string | null;
    draftId: string | null;
  }>();
  const draftHistory = history.filter(({ entityType }) => entityType === "sales-pending-draft");
  for (const { entityType, entityId, saleId, data } of history) {
    if (entityType !== "sale") continue;
    if (typeof data?.sourceSheet !== "string" || !Number.isInteger(data.sourceRow) || Number(data.sourceRow) < 1) continue;
    const sourceRow = Number(data.sourceRow);
    origins.set(`${data.sourceSheet}:${sourceRow}`, {
      sourceSheet: data.sourceSheet,
      sourceRow,
      state: "sale",
      saleId,
      draftId: null,
    });
  }
  for (const { entityId, operation, data } of draftHistory) {
    if (typeof data?.sourceSheet !== "string" || !Number.isInteger(data.sourceRow) || Number(data.sourceRow) < 1) continue;
    const sourceRow = Number(data.sourceRow);
    const completed = operation === "completed" && typeof data.linkedSaleId === "string";
    origins.set(`${data.sourceSheet}:${sourceRow}`, {
      sourceSheet: data.sourceSheet,
      sourceRow,
      state: completed ? "sale" : "pending",
      saleId: completed ? data.linkedSaleId as string : null,
      draftId: completed ? null : entityId,
    });
  }
  return origins;
}
