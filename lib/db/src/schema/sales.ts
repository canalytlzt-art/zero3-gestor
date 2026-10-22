import { randomUUID } from "node:crypto";
import { bigint, date, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const salesTable = pgTable("sales", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  saleDate: date("sale_date", { mode: "string" }).notNull(),
  productName: text("product_name").notNull(),
  quantity: integer("quantity").notNull(),
  unitAmountCents: bigint("unit_amount_cents", { mode: "number" }).notNull(),
  totalCents: bigint("total_cents", { mode: "number" }).notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertSaleSchema = createInsertSchema(salesTable).omit({
  id: true,
  createdAt: true,
});
export type InsertSale = z.infer<typeof insertSaleSchema>;
export type Sale = typeof salesTable.$inferSelect;
