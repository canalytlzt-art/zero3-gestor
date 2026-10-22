import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { bigint, check, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { productsTable } from "./products";

export const salesGoalsTable = pgTable("sales_goals", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  month: text("month").notNull(),
  scopeKey: text("scope_key").notNull(),
  productId: uuid("product_id").references(() => productsTable.id, { onDelete: "restrict" }),
  productName: text("product_name"),
  targetCents: bigint("target_cents", { mode: "number" }).notNull(),
  version: integer("version").notNull().default(1),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => ({
  monthScopeUnique: uniqueIndex("sales_goals_month_scope_unique").on(table.month, table.scopeKey),
  productMonthIndex: index("sales_goals_product_month_idx").on(table.productId, table.month),
  targetPositive: check("sales_goals_target_positive", sql`${table.targetCents} > 0`),
  targetSafeInteger: check("sales_goals_target_safe_integer", sql`${table.targetCents} <= 9007199254740991`),
  versionPositive: check("sales_goals_version_positive", sql`${table.version} > 0`),
  productScopeConsistent: check(
    "sales_goals_product_scope_consistent",
    sql`(${table.productId} is null and ${table.productName} is null and ${table.scopeKey} = 'all-plans')
      or (${table.productId} is not null and ${table.productName} is not null and ${table.scopeKey} = 'product:' || ${table.productId})`,
  ),
}));

export const insertSalesGoalSchema = createInsertSchema(salesGoalsTable).omit({
  id: true,
  productId: true,
  version: true,
  updatedAt: true,
});

export type InsertSalesGoal = z.infer<typeof insertSalesGoalSchema>;
export type SalesGoal = typeof salesGoalsTable.$inferSelect;
