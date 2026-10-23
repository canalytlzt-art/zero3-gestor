import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import express from "express";
import { drizzle } from "drizzle-orm/node-postgres";
import { pool, type db } from "@workspace/db";
import * as schema from "@workspace/db/schema";
import type {
  OccupancyBackup,
  OccupancyBackupRestorePreview,
  OccupancyRecord,
} from "@workspace/api-zod";
import { createOccupancyRouter } from "./occupancy";

const schemaName = `occupancy_backup_test_${randomUUID().replaceAll("-", "")}`;
const PgPool = pool.constructor as new (options: typeof pool.options) => typeof pool;
let testPool: typeof pool;
let targetPool: typeof pool;
let database: typeof db;
let targetDatabase: typeof db;
const servers: Server[] = [];
let base: string;
let targetBase: string;

async function makeServer(dbConnection: typeof db) {
  const app = express();
  app.use(express.json({ limit: "12mb" }));
  app.use("/api", createOccupancyRouter({
    database: dbConnection,
    getUserId: () => "isolated-occupancy-backup-tester",
    isAuthorized: async () => true,
  }));
  const http = await new Promise<Server>((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  servers.push(http);
  return `http://127.0.0.1:${(http.address() as AddressInfo).port}/api`;
}

async function call<T = unknown>(origin: string, path: string, method = "GET", data?: unknown) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: data === undefined ? undefined : { "Content-Type": "application/json" },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  return { status: response.status, body: (response.status === 204 ? undefined : await response.json()) as T };
}

const dayRecord = (period: string, className: string, startTime: string, presences: number, capacity: number) => ({
  kind: "daily",
  period,
  modalityName: "Funcional",
  percentage: 0,
  className,
  startTime,
  presences,
  capacity,
});

before(async () => {
  await pool.query(`CREATE SCHEMA "${schemaName}"`);
  testPool = new PgPool({ ...pool.options, options: `-c search_path=${schemaName}` });
  database = drizzle(testPool, { schema });
  const ddl = await readFile(new URL("../../../../lib/db/scripts/occupancy-schema.sql", import.meta.url), "utf8");
  await testPool.query(ddl);
  base = await makeServer(database);

  const restoreSchema = `${schemaName}_empty`;
  await pool.query(`CREATE SCHEMA "${restoreSchema}"`);
  targetPool = new PgPool({ ...pool.options, options: `-c search_path=${restoreSchema}` });
  targetDatabase = drizzle(targetPool, { schema });
  await targetPool.query(ddl);
  targetBase = await makeServer(targetDatabase);
});

after(async () => {
  for (const http of servers) await new Promise<void>((resolve) => http.close(() => resolve()));
  await testPool?.end();
  await targetPool?.end();
  await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
  await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}_empty" CASCADE`);
});

test("period backup applies date, quarter, time, weekday and modality filters with weighted and legacy values", async () => {
  const first = await call<OccupancyRecord>(base, "/occupancy", "POST", dayRecord("2026-07-01", "Ponderada", "06:00", 1, 2));
  const second = await call<OccupancyRecord>(base, "/occupancy", "POST", dayRecord("2026-07-03", "Ponderada", "06:00", 9, 10));
  const zero = await call<OccupancyRecord>(base, "/occupancy", "POST", dayRecord("2026-07-31", "Zero", "07:00", 0, 18));
  const over = await call<OccupancyRecord>(base, "/occupancy", "POST", dayRecord("2026-07-31", "Acima", "07:00", 19, 18));
  const legacy = await call<OccupancyRecord>(base, "/occupancy", "POST", {
    kind: "monthly", period: "2026-07", modalityName: "Funcional", percentage: 72.5, className: "Legado",
  });
  for (const response of [first, second, zero, over, legacy]) assert.equal(response.status, 201);
  assert.equal(zero.body.percentage, 0);
  assert.equal(over.body.percentage, 105.555556);

  const weighted = await call<OccupancyBackup>(base, "/occupancy/backup/period", "POST", {
    mode: "months", months: ["2026-07"], className: "Ponderada",
  });
  assert.equal(weighted.status, 200);
  assert.equal(weighted.body.counts.records, 2);
  assert.equal(weighted.body.summary.presences, 10);
  assert.equal(weighted.body.summary.capacity, 12);
  assert.ok(Math.abs((weighted.body.summary.weightedPercentage ?? 0) - 83.333333) < 0.00001);

  const quarter = await call<OccupancyBackup>(base, "/occupancy/backup/period", "POST", {
    mode: "quarter", year: 2026, quarter: 3, startTimes: ["06:00"], weekdays: [3],
  });
  assert.equal(quarter.status, 200);
  assert.equal(quarter.body.counts.records, 1);
  assert.equal(quarter.body.records[0]?.record.period, "2026-07-01");

  const inclusiveRange = await call<OccupancyBackup>(base, "/occupancy/backup/period", "POST", {
    mode: "range", fromDate: "2026-07-01", toDate: "2026-07-31",
  });
  assert.equal(inclusiveRange.status, 200);
  assert.equal(inclusiveRange.body.counts.records, 5);
  assert.equal(inclusiveRange.body.records.some(({ record }) => record.kind === "monthly"), true);

  const partialRange = await call<OccupancyBackup>(base, "/occupancy/backup/period", "POST", {
    mode: "range", fromDate: "2026-07-02", toDate: "2026-07-31",
  });
  assert.equal(partialRange.status, 200);
  assert.equal(partialRange.body.records.some(({ record }) => record.kind === "monthly"), false);
  assert.equal(partialRange.body.records.some(({ record }) => record.period === "2026-07-03"), true);

  const empty = await call<OccupancyBackup>(base, "/occupancy/backup/period", "POST", {
    mode: "months", months: ["2026-08"],
  });
  assert.equal(empty.status, 200);
  assert.equal(empty.body.counts.records, 0);
  assert.equal(empty.body.records.length, 0);
});

test("backup includes more than a visible page; restore is idempotent and handles confirmed conflicts", async () => {
  const bulkModality = await call<OccupancyRecord>(base, "/occupancy", "POST", dayRecord("2026-08-01", "Seed", "06:00", 0, 18));
  const modalityId = bulkModality.body.modalityId;
  await testPool.query(`
    INSERT INTO occupancy_records
      (id, modality_id, kind, date, month, percentage, presences, capacity, start_time, class_name, scope_key, created_by, updated_by)
    SELECT gen_random_uuid(), $1, 'daily', ('2026-08-01'::date + ((n - 1) % 25)), '2026-08',
      '0', 0, 18, '06:00', 'turma-' || n, 'turma-' || n, 'tester', 'tester'
    FROM generate_series(1, 501) AS n
  `, [modalityId]);
  const allAugust = await call<OccupancyRecord[]>(base, "/occupancy?months=2026-08&kind=all");
  assert.ok(allAugust.body.length >= 502, `received ${allAugust.body.length} occupancy records`);
  const largeBackup = await call<OccupancyBackup>(base, "/occupancy/backup/period", "POST", {
    mode: "months", months: ["2026-08"],
  });
  assert.ok(largeBackup.body.counts.records >= 502);

  const source = await call<OccupancyBackup>(base, "/occupancy/backup/period", "POST", {
    mode: "months", months: ["2026-07"], className: "Ponderada",
  });
  assert.equal(source.body.counts.records, 2);

  const preview = await call<OccupancyBackupRestorePreview>(targetBase, "/occupancy/backup/restore/preview", "POST", { backup: source.body });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.counts.recordsToInsert, 2);
  assert.equal(preview.body.counts.conflicts, 0);
  const restored = await call(targetBase, "/occupancy/backup/restore", "POST", { backup: source.body, actions: [] });
  assert.equal(restored.status, 200);
  assert.equal((restored.body as { insertedRecords: number }).insertedRecords, 2);

  const repeated = await call<OccupancyBackupRestorePreview>(targetBase, "/occupancy/backup/restore/preview", "POST", { backup: source.body });
  assert.equal(repeated.body.counts.recordsIdentical, 2);
  const repeatedRestore = await call(targetBase, "/occupancy/backup/restore", "POST", { backup: source.body, actions: [] });
  assert.equal((repeatedRestore.body as { identicalRecords: number }).identicalRecords, 2);
  const classRows = await call<OccupancyRecord[]>(targetBase, "/occupancy?months=2026-07&className=Ponderada");
  assert.equal(classRows.body.length, 2);
  const outside = await call<OccupancyRecord>(targetBase, "/occupancy", "POST", dayRecord("2026-08-10", "Fora do backup", "10:00", 3, 6));
  assert.equal(outside.status, 201);
  const outsideRows = await call<OccupancyRecord[]>(targetBase, "/occupancy?months=2026-08&className=Fora%20do%20backup");
  assert.equal(outsideRows.body.length, 1);

  const naturalConflict = JSON.parse(JSON.stringify(source.body)) as OccupancyBackup;
  const conflictRecord = naturalConflict.records[0]!.record;
  conflictRecord.id = randomUUID();
  const naturalPreview = await call<OccupancyBackupRestorePreview>(targetBase, "/occupancy/backup/restore/preview", "POST", { backup: naturalConflict });
  const conflict = naturalPreview.body.conflicts.find((item) => item.backupId === conflictRecord.id);
  assert.equal(conflict?.conflictKind, "natural-key");
  assert.ok(conflict?.options.includes("keep-both"));
  const keepBoth = await call(targetBase, "/occupancy/backup/restore", "POST", {
    backup: naturalConflict,
    actions: [{ entityType: "record", backupId: conflictRecord.id, action: "keep-both" }],
  });
  assert.equal(keepBoth.status, 200);
  assert.equal((keepBoth.body as { keptDistinct: number }).keptDistinct, 1);
  const both = await call<OccupancyRecord[]>(targetBase, "/occupancy?months=2026-07&className=Ponderada");
  assert.equal(both.body.length, 3);

  const updatedBackup = JSON.parse(JSON.stringify(source.body)) as OccupancyBackup;
  const updatedRecord = updatedBackup.records[1]!.record;
  updatedRecord.presences = 8;
  updatedRecord.percentage = 80;
  updatedBackup.summary.presences = 9;
  updatedBackup.summary.weightedPercentage = 75;
  const updatePreview = await call<OccupancyBackupRestorePreview>(targetBase, "/occupancy/backup/restore/preview", "POST", { backup: updatedBackup });
  assert.equal(updatePreview.body.conflicts.find((item) => item.backupId === updatedRecord.id)?.conflictKind, "id");
  const updateResult = await call<{ updatedRecords: number }>(targetBase, "/occupancy/backup/restore", "POST", {
    backup: updatedBackup,
    actions: [{ entityType: "record", backupId: updatedRecord.id, action: "update" }],
  });
  assert.equal(updateResult.status, 200);
  assert.equal(updateResult.body.updatedRecords, 1);
  const updatedRows = await call<OccupancyRecord[]>(targetBase, "/occupancy?months=2026-07&className=Ponderada");
  assert.equal(updatedRows.body.find((item) => item.id === updatedRecord.id)?.presences, 8);

  const invalid = JSON.parse(JSON.stringify(source.body)) as Record<string, unknown>;
  (invalid.records as Array<{ record: { createdAt: unknown } }>)[0]!.record.createdAt = 1_800_000_000_000;
  const invalidResponse = await call(targetBase, "/occupancy/backup/restore/preview", "POST", { backup: invalid });
  assert.equal(invalidResponse.status, 400);
  const stillThere = await call<OccupancyRecord[]>(targetBase, "/occupancy?months=2026-07&className=Ponderada");
  assert.equal(stillThere.body.length, 3);
});
