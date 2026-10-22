import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export const salesImportBatchesTable = pgTable("sales_import_batches", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  actorId: text("actor_id").notNull(),
  source: text("source").notNull(),
  fileHash: text("file_hash").notNull(),
  status: text("status").$type<"previewed" | "completed" | "failed">().notNull().default("previewed"),
  rowCount: integer("row_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, (table) => ({
  actorFileUnique: uniqueIndex("sales_import_actor_file_unique").on(table.actorId, table.source, table.fileHash),
  actorCreatedAtIndex: index("sales_import_actor_created_at_idx").on(table.actorId, table.createdAt),
  fileHashSha256: check("sales_import_file_hash_sha256", sql`${table.fileHash} ~ '^[a-f0-9]{64}$'`),
  rowCountNonNegative: check("sales_import_row_count_non_negative", sql`${table.rowCount} >= 0`),
  statusValid: check("sales_import_status_valid", sql`${table.status} in ('previewed', 'completed', 'failed')`),
  sourceNotBlank: check("sales_import_source_not_blank", sql`length(btrim(${table.source})) > 0`),
}));

export type SalesImportBatch = typeof salesImportBatchesTable.$inferSelect;
export type InsertSalesImportBatch = typeof salesImportBatchesTable.$inferInsert;
