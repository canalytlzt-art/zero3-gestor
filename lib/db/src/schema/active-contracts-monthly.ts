import { sql } from "drizzle-orm";
import { check, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const activeContractsMonthlyTable = pgTable("active_contracts_monthly", {
  month: text("month").primaryKey(),
  activeCount: integer("active_count").notNull(),
  targetCount: integer("target_count"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  check("active_contracts_monthly_month_valid", sql`${table.month} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$' and left(${table.month}, 4) <> '0000'`),
  check("active_contracts_monthly_active_count_valid", sql`${table.activeCount} >= 0`),
  check("active_contracts_monthly_target_count_valid", sql`${table.targetCount} is null or ${table.targetCount} >= 0`),
  check("active_contracts_monthly_notes_valid", sql`${table.notes} is null or length(${table.notes}) <= 1000`),
]);

export const insertActiveContractsMonthlySchema = createInsertSchema(activeContractsMonthlyTable).omit({
  createdAt: true,
  updatedAt: true,
});

export type InsertActiveContractsMonthly = z.infer<typeof insertActiveContractsMonthlySchema>;
export type ActiveContractsMonthly = typeof activeContractsMonthlyTable.$inferSelect;
