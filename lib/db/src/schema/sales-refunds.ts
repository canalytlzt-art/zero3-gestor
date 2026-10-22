import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { bigint, check, date, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { salesTable } from "./sales";

export const salesRefundsTable = pgTable("sales_refunds", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  saleId: uuid("sale_id").notNull().references(() => salesTable.id, { onDelete: "restrict" }),
  refundDate: date("refund_date", { mode: "string" }).notNull(),
  amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
  reason: text("reason").notNull(),
  status: text("status").$type<"active" | "voided">().notNull().default("active"),
  voidReason: text("void_reason"),
  version: integer("version").notNull().default(1),
  createdBy: text("created_by"),
  updatedBy: text("updated_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => ({
  saleStatusIndex: index("sales_refunds_sale_status_idx").on(table.saleId, table.status),
  dateStatusIndex: index("sales_refunds_date_status_idx").on(table.refundDate, table.status),
  amountPositive: check("sales_refunds_amount_positive", sql`${table.amountCents} > 0`),
  amountSafeInteger: check("sales_refunds_amount_safe_integer", sql`${table.amountCents} <= 9007199254740991`),
  statusValid: check("sales_refunds_status_valid", sql`${table.status} in ('active', 'voided')`),
  reasonNotBlank: check("sales_refunds_reason_not_blank", sql`length(btrim(${table.reason})) > 0`),
  voidReasonConsistent: check("sales_refunds_void_reason_consistent", sql`(${table.status} = 'active' and ${table.voidReason} is null) or (${table.status} = 'voided' and length(btrim(coalesce(${table.voidReason}, ''))) > 0)`),
  versionPositive: check("sales_refunds_version_positive", sql`${table.version} > 0`),
}));

export type SalesRefund = typeof salesRefundsTable.$inferSelect;
export type InsertSalesRefund = typeof salesRefundsTable.$inferInsert;
