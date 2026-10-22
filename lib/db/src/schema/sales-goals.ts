import { randomUUID } from "node:crypto";
import { bigint, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const salesGoalsTable = pgTable("sales_goals", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  month: text("month").notNull(),
  scopeKey: text("scope_key").notNull(),
  productName: text("product_name"),
  targetCents: bigint("target_cents", { mode: "number" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => ({
  monthScopeUnique: uniqueIndex("sales_goals_month_scope_unique").on(table.month, table.scopeKey),
}));

export const insertSalesGoalSchema = createInsertSchema(salesGoalsTable).omit({
  id: true,
  updatedAt: true,
});

export type InsertSalesGoal = z.infer<typeof insertSalesGoalSchema>;
export type SalesGoal = typeof salesGoalsTable.$inferSelect;
