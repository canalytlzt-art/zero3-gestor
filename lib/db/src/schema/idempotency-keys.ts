import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export const idempotencyKeysTable = pgTable("idempotency_keys", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  actorId: text("actor_id").notNull(),
  operation: text("operation").notNull(),
  key: text("key").notNull(),
  requestHash: text("request_hash").notNull(),
  responsePayload: jsonb("response_payload").$type<Record<string, unknown> | null>(),
  resourceId: uuid("resource_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  actorOperationKeyUnique: uniqueIndex("idempotency_actor_operation_key_unique")
    .on(table.actorId, table.operation, table.key),
  actorCreatedAtIndex: index("idempotency_actor_created_at_idx").on(table.actorId, table.createdAt),
  actorNotBlank: check("idempotency_actor_not_blank", sql`length(btrim(${table.actorId})) > 0`),
  operationNotBlank: check("idempotency_operation_not_blank", sql`length(btrim(${table.operation})) > 0`),
  keyNotBlank: check("idempotency_key_not_blank", sql`length(btrim(${table.key})) > 0`),
  requestHashSha256: check("idempotency_request_hash_sha256", sql`${table.requestHash} ~ '^[a-f0-9]{64}$'`),
}));

export type IdempotencyKey = typeof idempotencyKeysTable.$inferSelect;
export type InsertIdempotencyKey = typeof idempotencyKeysTable.$inferInsert;
