import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { check, date, index, integer, jsonb, numeric, pgTable, text, time, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { occupancyModalitiesTable } from "./occupancy-modalities";

export const occupancyRecordsTable = pgTable("occupancy_records", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  modalityId: uuid("modality_id").notNull().references(() => occupancyModalitiesTable.id, { onDelete: "restrict" }),
  kind: text("kind").$type<"daily" | "monthly">().notNull(),
  date: date("date", { mode: "string" }),
  month: text("month").notNull(),
  percentage: numeric("percentage").notNull(),
  reportedPercentage: numeric("reported_percentage"),
  presences: integer("presences"),
  capacity: integer("capacity"),
  startTime: time("start_time"),
  endTime: time("end_time"),
  className: text("class_name"),
  scopeKey: text("scope_key").notNull().default(""),
  notes: text("notes"),
  sourceFileHash: text("source_file_hash"),
  sourceSheet: text("source_sheet"),
  sourceCell: text("source_cell"),
  sourceCells: jsonb("source_cells").$type<Record<string, string> | null>(),
  version: integer("version").notNull().default(1),
  createdBy: text("created_by").notNull(),
  updatedBy: text("updated_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("occupancy_records_scope_unique").on(
    t.modalityId,
    t.kind,
    t.month,
    sql`coalesce(${t.date}, '0001-01-01'::date)`,
    t.scopeKey,
    sql`coalesce(${t.startTime}, '00:00:00'::time)`,
  ).where(sql`${t.deletedAt} is null`),
  uniqueIndex("occupancy_records_source_cell_unique").on(t.sourceFileHash, t.sourceSheet, t.sourceCell).where(sql`${t.deletedAt} is null and ${t.sourceFileHash} is not null`),
  index("occupancy_records_month_idx").on(t.month, t.modalityId),
  check("occupancy_percentage_valid", sql`${t.percentage} >= 0 and ${t.percentage} <> 'NaN'::numeric`),
  check("occupancy_reported_percentage_valid", sql`${t.reportedPercentage} is null or (${t.reportedPercentage} >= 0 and ${t.reportedPercentage} <> 'NaN'::numeric)`),
  check("occupancy_measurements_valid", sql`(
    (${t.presences} is null and ${t.capacity} is null and ${t.startTime} is null and ${t.endTime} is null)
    or (${t.kind} = 'daily' and ${t.date} is not null and ${t.presences} is not null and ${t.presences} >= 0
      and ${t.capacity} is not null and ${t.capacity} > 0 and ${t.startTime} is not null)
  ) and (${t.reportedPercentage} is null or (${t.presences} is not null and ${t.capacity} is not null))`),
  check("occupancy_period_valid", sql`${t.month} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$' and left(${t.month}, 4) <> '0000' and ((${t.kind} = 'daily' and ${t.date} is not null and ${t.month} = to_char(${t.date}, 'YYYY-MM')) or (${t.kind} = 'monthly' and ${t.date} is null))`),
  check("occupancy_record_version_valid", sql`${t.version} > 0`),
  check("occupancy_record_text_valid", sql`coalesce(length(${t.className}), 0) <= 120 and coalesce(length(${t.notes}), 0) <= 1000`),
  check("occupancy_record_source_valid", sql`(${t.sourceFileHash} is null and ${t.sourceSheet} is null and ${t.sourceCell} is null and ${t.sourceCells} is null) or (${t.sourceFileHash} ~ '^[a-f0-9]{64}$' and length(btrim(${t.sourceSheet})) between 1 and 120 and ${t.sourceCell} ~ '^[A-Z]{1,4}[1-9][0-9]*$' and jsonb_typeof(${t.sourceCells}) = 'object')`),
]);
export const insertOccupancyRecordSchema = createInsertSchema(occupancyRecordsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type OccupancyRecordRow = typeof occupancyRecordsTable.$inferSelect;
