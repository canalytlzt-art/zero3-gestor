import { randomUUID } from "node:crypto";
import { createInsertSchema } from "drizzle-zod";
import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const occupancyHistoryTable = pgTable("occupancy_history", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  entityType: text("entity_type").notNull(),
  entityId: uuid("entity_id").notNull(),
  operation: text("operation").notNull(),
  actorId: text("actor_id").notNull(),
  beforeData: jsonb("before_data"),
  afterData: jsonb("after_data"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export const insertOccupancyHistorySchema = createInsertSchema(occupancyHistoryTable).omit({ id: true, createdAt: true });
