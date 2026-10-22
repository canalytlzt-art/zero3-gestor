import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export type HistorySnapshot = Record<string, unknown>;

export const salesHistoryTable = pgTable("sales_history", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  entityType: text("entity_type").notNull(),
  entityId: uuid("entity_id").notNull(),
  operation: text("operation").notNull(),
  actorId: text("actor_id").notNull(),
  beforeData: jsonb("before_data").$type<HistorySnapshot | null>(),
  afterData: jsonb("after_data").$type<HistorySnapshot | null>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  entityHistoryIndex: index("sales_history_entity_idx").on(table.entityType, table.entityId, table.createdAt),
  createdAtIndex: index("sales_history_created_at_idx").on(table.createdAt),
  entityTypeNotBlank: check("sales_history_entity_type_not_blank", sql`length(btrim(${table.entityType})) > 0`),
  operationNotBlank: check("sales_history_operation_not_blank", sql`length(btrim(${table.operation})) > 0`),
}));

export type SalesHistoryRecord = typeof salesHistoryTable.$inferSelect;
export type InsertSalesHistoryRecord = typeof salesHistoryTable.$inferInsert;
