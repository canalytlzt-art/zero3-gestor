import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { bigint, boolean, check, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { occupancyModalitiesTable } from "./occupancy-modalities";

export const productsTable = pgTable("products", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  name: text("name").notNull(),
  normalizedName: text("normalized_name").notNull(),
  modalityId: uuid("modality_id").references(() => occupancyModalitiesTable.id, { onDelete: "set null" }),
  suggestedPriceCents: bigint("suggested_price_cents", { mode: "number" }).notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => ({
  normalizedNameUnique: uniqueIndex("products_normalized_name_unique").on(table.normalizedName),
  activeNameIndex: index("products_active_name_idx").on(table.isActive, table.normalizedName),
  modalityIndex: index("products_modality_id_idx").on(table.modalityId),
  priceNonNegative: check("products_price_non_negative", sql`${table.suggestedPriceCents} >= 0`),
  priceSafeInteger: check("products_price_safe_integer", sql`${table.suggestedPriceCents} <= 9007199254740991`),
  versionPositive: check("products_version_positive", sql`${table.version} > 0`),
  nameNotBlank: check("products_name_not_blank", sql`length(btrim(${table.name})) > 0`),
  normalizedNameNotBlank: check("products_normalized_name_not_blank", sql`length(btrim(${table.normalizedName})) > 0`),
}));

export type Product = typeof productsTable.$inferSelect;
export type InsertProduct = typeof productsTable.$inferInsert;
