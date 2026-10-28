import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { productsTable } from "./products";
import { occupancyModalitiesTable } from "./occupancy-modalities";

export const salesTable = pgTable(
  "sales",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    productId: uuid("product_id").references(() => productsTable.id, {
      onDelete: "restrict",
    }),
    modalityId: uuid("modality_id").references(() => occupancyModalitiesTable.id, {
      onDelete: "set null",
    }),
    modalityOverride: boolean("modality_override").notNull().default(false),
    saleDate: date("sale_date", { mode: "string" }).notNull(),
    productName: text("product_name").notNull(),
    quantity: integer("quantity").notNull(),
    unitAmountCents: bigint("unit_amount_cents", { mode: "number" }).notNull(),
    totalCents: bigint("total_cents", { mode: "number" }).notNull(),
    customerName: text("customer_name"),
    notes: text("notes"),
    status: text("status")
      .$type<"active" | "cancelled">()
      .notNull()
      .default("active"),
    cancellationReason: text("cancellation_reason"),
    version: integer("version").notNull().default(1),
    createdBy: text("created_by"),
    updatedBy: text("updated_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    saleDateStatusIndex: index("sales_date_status_idx").on(
      table.saleDate,
      table.status,
    ),
    productStatusIndex: index("sales_product_status_idx").on(
      table.productId,
      table.status,
    ),
    modalityStatusIndex: index("sales_modality_status_idx").on(
      table.modalityId,
      table.status,
    ),
    quantityPositive: check(
      "sales_quantity_positive",
      sql`${table.quantity} > 0`,
    ),
    unitAmountNonNegative: check(
      "sales_unit_amount_non_negative",
      sql`${table.unitAmountCents} >= 0`,
    ),
    unitAmountSafeInteger: check(
      "sales_unit_amount_safe_integer",
      sql`${table.unitAmountCents} <= 9007199254740991`,
    ),
    totalNonNegative: check(
      "sales_total_non_negative",
      sql`${table.totalCents} >= 0`,
    ),
    totalSafeInteger: check(
      "sales_total_safe_integer",
      sql`${table.totalCents} <= 9007199254740991`,
    ),
    totalMatchesQuantity: check(
      "sales_total_matches_quantity",
      sql`${table.totalCents} = ${table.quantity} * ${table.unitAmountCents}`,
    ),
    statusValid: check(
      "sales_status_valid",
      sql`${table.status} in ('active', 'cancelled')`,
    ),
    cancellationReasonConsistent: check(
      "sales_cancellation_reason_consistent",
      sql`(${table.status} = 'active' and ${table.cancellationReason} is null) or (${table.status} = 'cancelled' and length(btrim(coalesce(${table.cancellationReason}, ''))) > 0)`,
    ),
    versionPositive: check("sales_version_positive", sql`${table.version} > 0`),
  }),
);

export const insertSaleSchema = createInsertSchema(salesTable).omit({
  id: true,
  createdAt: true,
});
export type InsertSale = z.infer<typeof insertSaleSchema>;
export type Sale = typeof salesTable.$inferSelect;
