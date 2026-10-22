import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { check, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export const occupancyModalitiesTable = pgTable("occupancy_modalities", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  name: text("name").notNull(),
  normalizedName: text("normalized_name").notNull(),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("occupancy_modalities_name_unique").on(t.normalizedName),
  check("occupancy_modalities_name_valid", sql`length(btrim(${t.name})) between 1 and 120 and length(btrim(${t.normalizedName})) > 0`),
  check("occupancy_modalities_version_valid", sql`${t.version} > 0`),
]);
export const insertOccupancyModalitySchema = createInsertSchema(occupancyModalitiesTable).omit({ id: true, createdAt: true, updatedAt: true });
export type OccupancyModalityRow = typeof occupancyModalitiesTable.$inferSelect;
