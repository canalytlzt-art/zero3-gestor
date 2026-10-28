import { sql } from "drizzle-orm";
import { check, integer, numeric, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const occupancyMonthlyGoalsTable = pgTable("occupancy_monthly_goals", {
  month: text("month").notNull(),
  scopeKey: text("scope_key").notNull(),
  modalityId: text("modality_id"),
  modalityName: text("modality_name"),
  aggregatorTargetPresences: integer("aggregator_target_presences"),
  occupancyTargetPercentage: numeric("occupancy_target_percentage"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  primaryKey({ name: "occupancy_monthly_goals_pkey", columns: [table.month, table.scopeKey] }),
  check("occupancy_monthly_goals_month_valid", sql`${table.month} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$' and left(${table.month}, 4) <> '0000'`),
  check("occupancy_monthly_goals_scope_valid", sql`(
    (${table.modalityId} is null and ${table.scopeKey} = 'all' and ${table.modalityName} is null)
    or (${table.modalityId} is not null and ${table.scopeKey} = ${table.modalityId} and ${table.modalityName} is not null and length(btrim(${table.modalityName})) > 0)
  )`),
  check("occupancy_monthly_goals_aggregator_target_valid", sql`${table.aggregatorTargetPresences} is null or ${table.aggregatorTargetPresences} >= 0`),
  check("occupancy_monthly_goals_occupancy_target_valid", sql`${table.occupancyTargetPercentage} is null or (${table.occupancyTargetPercentage} >= 0 and ${table.occupancyTargetPercentage} <> 'NaN'::numeric)`),
  check("occupancy_monthly_goals_target_required", sql`${table.aggregatorTargetPresences} is not null or ${table.occupancyTargetPercentage} is not null`),
  check("occupancy_monthly_goals_notes_valid", sql`${table.notes} is null or length(${table.notes}) <= 1000`),
]);

export const insertOccupancyMonthlyGoalSchema = createInsertSchema(occupancyMonthlyGoalsTable);
export type InsertOccupancyMonthlyGoal = z.infer<typeof insertOccupancyMonthlyGoalSchema>;
export type OccupancyMonthlyGoal = typeof occupancyMonthlyGoalsTable.$inferSelect;
