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
import type { OccupancyRecord, OccupancyModality } from "@workspace/api-zod";
import { createOccupancyRouter } from "./occupancy";

const testSchema = `occupancy_test_${randomUUID().replaceAll("-", "")}`;
const PgPool = pool.constructor as new (options: typeof pool.options) => typeof pool;
let testPool: typeof pool;
let database: typeof db;
const servers: Server[] = [];
let base: string;
async function server(auth: "allowed" | "denied" | "anonymous" = "allowed") {
  const app = express();
  app.use(express.json());
  app.use("/api", createOccupancyRouter({
    database,
    getUserId: () => auth === "anonymous" ? null : "isolated-occupancy-tester",
    isAuthorized: async () => auth === "allowed",
  }));
  const http = await new Promise<Server>((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  servers.push(http);
  return `http://127.0.0.1:${(http.address() as AddressInfo).port}/api`;
}
before(async () => {
  await pool.query(`CREATE SCHEMA "${testSchema}"`);
  testPool = new PgPool({ ...pool.options, options: `-c search_path=${testSchema}` });
  database = drizzle(testPool, { schema });
  await testPool.query(await readFile(new URL("../../../../lib/db/scripts/occupancy-schema.sql", import.meta.url), "utf8"));
  await testPool.query(`
    CREATE TABLE products (
      id uuid PRIMARY KEY,
      name text NOT NULL,
      normalized_name text NOT NULL,
      modality_id uuid REFERENCES occupancy_modalities(id) ON DELETE SET NULL,
      version integer NOT NULL DEFAULT 1,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  base = await server();
});
after(async () => {
  for (const http of servers) await new Promise<void>((resolve) => http.close(() => resolve()));
  await testPool?.end();
  await pool.query(`DROP SCHEMA IF EXISTS "${testSchema}" CASCADE`);
  await pool.end();
});
async function call<T = OccupancyRecord>(path: string, method = "GET", data?: unknown, origin = base) {
  const response = await fetch(`${origin}${path}`, {
    method, headers: data === undefined ? undefined : { "Content-Type": "application/json" },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  return { status: response.status, body: (response.status === 204 ? undefined : await response.json()) as T };
}
const record = (extra: Record<string, unknown> = {}) => ({
  kind: "daily", period: "2026-01-02", modalityName: "Pilates", percentage: 0, ...extra,
});

test("access and strict manual validation preserve zero, decimals and actual calendar dates", async () => {
  assert.equal((await call("/occupancy", "GET", undefined, await server("anonymous"))).status, 401);
  assert.equal((await call("/occupancy", "GET", undefined, await server("denied"))).status, 403);
  for (const extra of [
    { percentage: null }, { percentage: "" }, { percentage: -1 }, { percentage: undefined },
    { period: "2026-02-30" }, { period: "0000-01-01" }, { modalityName: "   " },
    { kind: "monthly", period: "2026-13" },
  ]) assert.equal((await call("/occupancy", "POST", record(extra))).status, 400);
  const zero = await call("/occupancy", "POST", record());
  assert.equal(zero.status, 201);
  assert.equal(zero.body.percentage, 0);
  assert.equal(zero.body.period, "2026-01-02");
  const hundred = await call("/occupancy", "POST", record({ period: "2026-01-03", percentage: 100, modalityName: " PILATES " }));
  assert.equal(hundred.status, 201);
  assert.equal(hundred.body.modalityId, zero.body.modalityId);
  const monthly = await call("/occupancy", "POST", record({ kind: "monthly", period: "2026-01", percentage: 75.125 }));
  assert.equal(monthly.status, 201);
  assert.equal(monthly.body.percentage, 75.125);
  const raw = await testPool.query("SELECT kind,date,month FROM occupancy_records ORDER BY kind");
  assert.equal(raw.rowCount, 3);
  assert.equal(raw.rows.filter((r) => r.kind === "monthly" && r.date === null).length, 1);
});

test("manual class entries calculate occupancy from counts, accept overcapacity and distinguish start times", async () => {
  const measured = await call("/occupancy", "POST", record({
    period: "2026-01-04", percentage: 50, presences: 21, capacity: 18,
    startTime: "06:00", endTime: "07:00", className: "Turma A",
  }));
  assert.equal(measured.status, 201);
  assert.equal(measured.body.percentage, 116.666667);
  assert.equal(measured.body.reportedPercentage, 50);
  assert.equal(measured.body.presences, 21);
  assert.equal(measured.body.capacity, 18);
  assert.equal(measured.body.startTime, "06:00");
  assert.equal(measured.body.endTime, "07:00");

  const edited = await call(`/occupancy/${measured.body.id}`, "PATCH", {
    kind: "daily", period: "2026-01-04", modalityId: measured.body.modalityId, modalityName: "Pilates",
    presences: 9, capacity: 18, startTime: "06:00", endTime: "07:00",
    reportedPercentage: measured.body.reportedPercentage, className: "Turma A", notes: null,
    version: measured.body.version,
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.percentage, 50);
  assert.equal(edited.body.reportedPercentage, 50);
  assert.equal(edited.body.presences, 9);

  const zero = await call("/occupancy", "POST", record({
    period: "2026-01-05", percentage: undefined, presences: 0, capacity: 18, startTime: "06:00",
  }));
  assert.equal(zero.status, 201);
  assert.equal(zero.body.percentage, 0);
  assert.equal(zero.body.endTime, null);

  for (const extra of [
    { percentage: undefined, presences: 2.5, capacity: 18, startTime: "06:00" },
    { percentage: undefined, presences: 2, capacity: 0, startTime: "06:00" },
    { percentage: undefined, presences: 2, startTime: "06:00" },
    { percentage: undefined, presences: 2, capacity: 18 },
    { percentage: undefined, presences: 2, capacity: 18, startTime: "25:00" },
    { percentage: undefined, presences: 2, capacity: 18, startTime: "06:00", endTime: "bad" },
  ]) assert.equal((await call("/occupancy", "POST", record(extra))).status, 400);

  const first = await call("/occupancy", "POST", record({
    period: "2026-01-06", percentage: undefined, presences: 10, capacity: 18, startTime: "06:00",
  }));
  const differentTime = await call("/occupancy", "POST", record({
    period: "2026-01-06", percentage: undefined, presences: 12, capacity: 18, startTime: "08:00",
  }));
  const duplicateTime = await call("/occupancy", "POST", record({
    period: "2026-01-06", percentage: undefined, presences: 11, capacity: 18, startTime: "08:00",
  }));
  assert.equal(first.status, 201);
  assert.equal(differentTime.status, 201);
  assert.equal(duplicateTime.status, 409);
  await testPool.query("DELETE FROM occupancy_records WHERE date BETWEEN DATE '2026-01-04' AND DATE '2026-01-06'");
});

test("filters include endpoints, selected months and scope without applying full month to partial range", async () => {
  await call("/occupancy", "POST", record({ period: "2026-02-05", percentage: 60, className: " Turma   07h " }));
  await call("/occupancy", "POST", record({ period: "2026-03-05", percentage: 80, className: "Turma 07h" }));
  const partial = await call<OccupancyRecord[]>("/occupancy?fromDate=2026-01-02&toDate=2026-01-03");
  assert.equal(partial.body.length, 2);
  assert.deepEqual(partial.body.map((r: { percentage: number }) => r.percentage).sort((a: number, b: number) => a - b), [0, 100]);
  const whole = await call<OccupancyRecord[]>("/occupancy?fromDate=2026-01-01&toDate=2026-01-31");
  assert.equal(whole.body.length, 3);
  assert.equal(whole.body.filter((r: { kind: string }) => r.kind === "monthly").length, 1);
  const selected = await call<OccupancyRecord[]>("/occupancy?months=2026-01,2026-03&kind=daily");
  assert.equal(selected.body.length, 3);
  assert.equal(selected.body.some((r: { month: string }) => r.month === "2026-02"), false);
  const scope = await call<OccupancyRecord[]>("/occupancy?className=turma%2007h");
  assert.equal(scope.body.length, 2);
  const modalityId = scope.body[0].modalityId;
  assert.equal((await call<OccupancyRecord[]>(`/occupancy?modalityId=${modalityId}&kind=monthly`)).body.length, 1);
  for (const query of [
    "?fromDate=2026-01-01", "?fromDate=2026-02-30&toDate=2026-03-01",
    "?months=2026-01&fromDate=2026-01-01&toDate=2026-01-31", "?months=", "?modalityId=invalid",
  ]) assert.equal((await call(`/occupancy${query}`)).status, 400);
});

test("year, calendar quarter, selected hours and weekdays combine without losing range endpoints", async () => {
  const created = [];
  for (const entry of [
    { period: "2026-07-06", startTime: "06:00", presences: 1, capacity: 2 },
    { period: "2026-07-07", startTime: "06:00", presences: 9, capacity: 10 },
    { period: "2026-09-30", startTime: "07:00", presences: 5, capacity: 10 },
    { period: "2026-10-01", startTime: "06:00", presences: 7, capacity: 10 },
    { period: "2025-07-07", startTime: "06:00", presences: 4, capacity: 10 },
  ]) {
    const response = await call("/occupancy", "POST", record({
      ...entry, percentage: undefined, modalityName: "Filtros Tarefa 4", className: "Aula de teste",
    }));
    assert.equal(response.status, 201);
    created.push(response.body);
  }
  const modalityId = created[0].modalityId;
  const combined = await call<OccupancyRecord[]>(
    `/occupancy?year=2026&quarter=3&startTimes=06:00&weekdays=1,2&modalityId=${modalityId}`,
  );
  assert.deepEqual(combined.body.map((row) => row.period).sort(), ["2026-07-06", "2026-07-07"]);
  const selectedHours = await call<OccupancyRecord[]>(
    `/occupancy?year=2026&quarter=3&startTimes=06:00,07:00&weekdays=1,2,3&modalityId=${modalityId}`,
  );
  assert.deepEqual(selectedHours.body.map((row) => row.period).sort(), ["2026-07-06", "2026-07-07", "2026-09-30"]);

  const monthsAndQuarter = await call<OccupancyRecord[]>(
    `/occupancy?months=2026-07,2026-09,2026-10&year=2026&quarter=3&modalityId=${modalityId}`,
  );
  assert.deepEqual(monthsAndQuarter.body.map((row) => row.period).sort(), ["2026-07-06", "2026-07-07", "2026-09-30"]);

  const inclusiveRange = await call<OccupancyRecord[]>(
    `/occupancy?fromDate=2026-07-06&toDate=2026-07-07&startTimes=06:00&modalityId=${modalityId}`,
  );
  assert.deepEqual(inclusiveRange.body.map((row) => row.period).sort(), ["2026-07-06", "2026-07-07"]);

  for (const query of [
    `?fromDate=2026-07-06&toDate=2026-07-07&year=2026&modalityId=${modalityId}`,
    `?year=2026&quarter=3&startTimes=25:00&modalityId=${modalityId}`,
    `?year=2026&weekdays=0&modalityId=${modalityId}`,
    `?kind=monthly&weekdays=1&modalityId=${modalityId}`,
  ]) assert.equal((await call(`/occupancy${query}`)).status, 400);

  await testPool.query("DELETE FROM occupancy_records WHERE modality_id = $1", [modalityId]);
  await testPool.query("DELETE FROM occupancy_modalities WHERE id = $1", [modalityId]);
});

test("modality rename preserves IDs and links; edit/delete are versioned and audit remains", async () => {
  const modalities = await call<OccupancyModality[]>("/occupancy/modalities");
  assert.equal(modalities.body.length, 1);
  const modality = modalities.body[0];
  assert.equal((await call("/occupancy/modalities", "POST", { name: " pilates " })).status, 409);
  const renamed = await call<OccupancyModality>(`/occupancy/modalities/${modality.id}`, "PATCH", { name: "Pilates Solo", version: modality.version });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.id, modality.id);
  assert.equal((await call(`/occupancy/modalities/${modality.id}`, "PATCH", { name: "Outra", version: modality.version })).status, 409);
  const rows = (await call<OccupancyRecord[]>("/occupancy")).body;
  assert.equal(rows.length, 5);
  assert.equal(rows.every((r: { modalityName: string; modalityId: string }) => r.modalityName === "Pilates Solo" && r.modalityId === modality.id), true);
  const old = rows.find((r: { period: string }) => r.period === "2026-01-02");
  assert.ok(old);
  // An edit opened before a rename must keep its ID, not recreate the stale name.
  const input = record({ modalityId: modality.id, modalityName: "Pilates", percentage: 60.5, notes: "Conferido", version: old.version });
  const edited = await call(`/occupancy/${old.id}`, "PATCH", input);
  assert.equal(edited.status, 200);
  assert.equal(edited.body.percentage, 60.5);
  assert.equal(edited.body.modalityName, "Pilates Solo");
  assert.equal((await call<OccupancyModality[]>("/occupancy/modalities")).body.length, 1);
  assert.equal((await call(`/occupancy/${old.id}`, "PATCH", input)).status, 409);
  assert.equal((await call(`/occupancy/${old.id}`, "DELETE", { version: old.version })).status, 409);
  const cleared = await call(`/occupancy/${old.id}`, "PATCH", { ...input, percentage: 0, notes: null, className: null, version: edited.body.version });
  assert.equal(cleared.body.notes, null);
  assert.equal(cleared.body.percentage, 0);
  assert.equal((await call(`/occupancy/${old.id}`, "DELETE", { version: cleared.body.version })).status, 204);
  assert.equal((await call<OccupancyRecord[]>("/occupancy")).body.some((r: { id: string }) => r.id === old.id), false);
  const audit = await testPool.query("SELECT operation FROM occupancy_history WHERE entity_id=$1 ORDER BY created_at", [old.id]);
  assert.deepEqual(audit.rows.map((r) => r.operation), ["create", "update", "update", "delete"]);
  assert.equal((await testPool.query("SELECT deleted_at FROM occupancy_records WHERE id=$1", [old.id])).rows[0].deleted_at !== null, true);
});

test("concurrent duplicates do not sum or overwrite, including blank and normalized class scopes", async () => {
  const modality = (await call<OccupancyModality[]>("/occupancy/modalities")).body[0];
  const input = record({ period: "2026-04-05", modalityId: modality.id, modalityName: modality.name, percentage: 70 });
  const pair = await Promise.all([call("/occupancy", "POST", input), call("/occupancy", "POST", input)]);
  assert.deepEqual(pair.map((r) => r.status).sort(), [201, 409]);
  assert.equal((await call<OccupancyRecord[]>("/occupancy?months=2026-04")).body.length, 1);
  assert.equal((await call("/occupancy", "POST", { ...input, className: "Turma 8h" })).status, 201);
  assert.equal((await call("/occupancy", "POST", { ...input, className: " TURMA   8H " })).status, 409);
  const rows = await call<OccupancyRecord[]>("/occupancy?months=2026-04");
  assert.equal(rows.body.length, 2);
  assert.equal(rows.body.every((r: { percentage: number }) => r.percentage === 70), true);
});

test("occupancy imports preview without side effects, are idempotent, and require versioned consent to update", async () => {
  const fileHash = "a".repeat(64);
  const entry = {
    index: 0, sourceSheet: "Matrículas", sourceCell: "C2",
    sourceCells: { period: "A2", modality: "B2", percentage: "C2" },
    kind: "daily", period: "2026-09-01", modalityName: "Import Pilates",
    percentage: 75.25, className: "18h",
  };
  const countModality = async () => Number((await testPool.query(
    "SELECT count(*)::int AS count FROM occupancy_modalities WHERE normalized_name=$1", ["import pilates"],
  )).rows[0].count);
  assert.equal((await call("/occupancy/import/preview", "POST", { fileHash, entries: [entry] }, await server("anonymous"))).status, 401);
  const preview = await call<{ rows: Array<{ status: string }> }>("/occupancy/import/preview", "POST", { fileHash, entries: [entry] });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.rows[0].status, "new");
  assert.equal(await countModality(), 0, "preview must not create a modality");

  const imported = await call<{ rows: Array<{ status: string; id: string | null }> }>("/occupancy/import", "POST", { fileHash, entries: [{ record: entry }] });
  assert.equal(imported.body.rows[0].status, "inserted");
  const id = imported.body.rows[0].id!;
  const sameFile = await call<{ rows: Array<{ status: string; id: string | null }> }>("/occupancy/import", "POST", { fileHash, entries: [{ record: entry }] });
  assert.deepEqual(sameFile.body.rows[0], { index: 0, status: "already_imported", id, message: "Já importado; mantido sem duplicação." });
  assert.equal((await call<OccupancyRecord[]>("/occupancy?months=2026-09")).body.length, 1);

  const changedEntry = { ...entry, percentage: 80 };
  const changedPreview = await call<{ rows: Array<{ status: string; existingRecord: OccupancyRecord }> }>("/occupancy/import/preview", "POST", { fileHash, entries: [changedEntry] });
  assert.equal(changedPreview.body.rows[0].status, "conflict");
  const noConsent = await call<{ rows: Array<{ status: string }> }>("/occupancy/import", "POST", { fileHash, entries: [{ record: changedEntry }] });
  assert.equal(noConsent.body.rows[0].status, "conflict");
  const updated = await call<{ rows: Array<{ status: string; id: string | null }> }>("/occupancy/import", "POST", {
    fileHash,
    entries: [{ record: changedEntry, existingRecordId: id, expectedVersion: changedPreview.body.rows[0].existingRecord.version }],
  });
  assert.equal(updated.body.rows[0].status, "updated");
  assert.equal(updated.body.rows[0].id, id);
  const stale = await call<{ rows: Array<{ status: string }> }>("/occupancy/import", "POST", {
    fileHash,
    entries: [{ record: { ...entry, percentage: 60 }, existingRecordId: id, expectedVersion: 1 }],
  });
  assert.equal(stale.body.rows[0].status, "conflict");
  assert.equal((await call<OccupancyRecord[]>(`/occupancy?months=2026-09`)).body[0].percentage, 80);

  const otherHash = "b".repeat(64);
  const sameScope = { ...entry, index: 1, sourceSheet: "Outra", sourceCell: "D9", sourceCells: { period: "A9", modality: "B9", percentage: "D9" }, percentage: 90 };
  const naturalConflict = await call<{ rows: Array<{ status: string; existingRecord: OccupancyRecord }> }>("/occupancy/import/preview", "POST", { fileHash: otherHash, entries: [sameScope] });
  assert.equal(naturalConflict.body.rows[0].status, "conflict");
  assert.equal(naturalConflict.body.rows[0].existingRecord.id, id);
  const withoutUpdate = await call<{ rows: Array<{ status: string }> }>("/occupancy/import", "POST", { fileHash: otherHash, entries: [{ record: sameScope }] });
  assert.equal(withoutUpdate.body.rows[0].status, "conflict");
  const authorizedUpdate = await call<{ rows: Array<{ status: string }> }>("/occupancy/import", "POST", {
    fileHash: otherHash,
    entries: [{ record: sameScope, existingRecordId: id, expectedVersion: naturalConflict.body.rows[0].existingRecord.version }],
  });
  assert.equal(authorizedUpdate.body.rows[0].status, "updated");
  assert.equal((await call<OccupancyRecord[]>("/occupancy?months=2026-09")).body[0].percentage, 90);

  const audit = await testPool.query("SELECT operation FROM occupancy_history WHERE entity_id=$1 ORDER BY created_at", [id]);
  assert.deepEqual(audit.rows.map((row) => row.operation), ["import_create", "import_update", "import_update"]);
  const source = await testPool.query("SELECT source_file_hash,source_sheet,source_cell,source_cells FROM occupancy_records WHERE id=$1", [id]);
  assert.deepEqual(source.rows[0], { source_file_hash: otherHash, source_sheet: "Outra", source_cell: "D9", source_cells: sameScope.sourceCells });
});

test("imports measured classes, keeps distinct same-time classes only after confirmation, and preserves source idempotency", async () => {
  const fileHash = "e".repeat(64);
  const entry = {
    index: 0, sourceSheet: "Aulas", sourceCell: "D2",
    sourceCells: { period: "B2", modality: "A2", startTime: "C2", presences: "D2", capacity: "E2", percentage: "F2" },
    kind: "daily", period: "2026-10-22", modalityName: "Import CrossFit",
    startTime: "06:00", endTime: "07:00", presences: 10, capacity: 18,
    percentage: 55.555556, reportedPercentage: 56,
  };
  const preview = await call<{ rows: Array<{ status: string }> }>("/occupancy/import/preview", "POST", { fileHash, entries: [entry] });
  assert.equal(preview.body.rows[0].status, "new");
  const imported = await call<{ rows: Array<{ status: string; id: string | null }> }>("/occupancy/import", "POST", {
    fileHash, entries: [{ record: entry }],
  });
  assert.equal(imported.body.rows[0].status, "inserted");
  const id = imported.body.rows[0].id!;
  const stored = (await call<OccupancyRecord[]>("/occupancy?fromDate=2026-10-22&toDate=2026-10-22")).body[0];
  assert.equal(stored.presences, 10);
  assert.equal(stored.capacity, 18);
  assert.equal(stored.startTime, "06:00");
  assert.equal(stored.endTime, "07:00");
  assert.equal(stored.percentage, 55.555556);
  assert.equal(stored.reportedPercentage, 56);

  const otherHash = "f".repeat(64);
  const differentClass = {
    ...entry, index: 1, sourceSheet: "Reposição", sourceCell: "D9",
    sourceCells: { period: "B9", modality: "A9", startTime: "C9", presences: "D9", capacity: "E9", percentage: "F9" },
    presences: 12, percentage: 66.666667, reportedPercentage: 67,
  };
  const conflict = await call<{ rows: Array<{ status: string; existingRecord: OccupancyRecord }> }>("/occupancy/import/preview", "POST", {
    fileHash: otherHash, entries: [differentClass],
  });
  assert.equal(conflict.body.rows[0].status, "conflict");
  assert.equal(conflict.body.rows[0].existingRecord.id, id);
  const refused = await call<{ rows: Array<{ status: string }> }>("/occupancy/import", "POST", {
    fileHash: otherHash, entries: [{ record: differentClass }],
  });
  assert.equal(refused.body.rows[0].status, "conflict");
  const kept = await call<{ rows: Array<{ status: string; id: string | null }> }>("/occupancy/import", "POST", {
    fileHash: otherHash,
    entries: [{
      record: differentClass, existingRecordId: id,
      expectedVersion: conflict.body.rows[0].existingRecord.version, keepBothConfirmed: true,
    }],
  });
  assert.equal(kept.body.rows[0].status, "inserted");
  assert.notEqual(kept.body.rows[0].id, id);
  const repeated = await call<{ rows: Array<{ status: string; id: string | null }> }>("/occupancy/import", "POST", {
    fileHash: otherHash, entries: [{ record: differentClass, keepBothConfirmed: true }],
  });
  assert.equal(repeated.body.rows[0].status, "already_imported");
  const records = (await call<OccupancyRecord[]>("/occupancy?fromDate=2026-10-22&toDate=2026-10-22")).body;
  assert.equal(records.length, 2);
  assert.deepEqual(records.map((row) => row.presences).sort(), [10, 12]);

  const batchHash = "9".repeat(64);
  const batchFirst = {
    ...entry, index: 2, sourceSheet: "Lote", sourceCell: "D20",
    sourceCells: { period: "B20", modality: "A20", startTime: "C20", presences: "D20", capacity: "E20" },
    period: "2026-10-23", modalityName: "Import Batch CrossFit", startTime: "07:00",
    endTime: null, presences: 9, capacity: 18, percentage: undefined, reportedPercentage: undefined,
  };
  const batchSecond = {
    ...batchFirst, index: 3, sourceCell: "D21",
    sourceCells: { period: "B21", modality: "A21", startTime: "C21", presences: "D21", capacity: "E21" },
    presences: 10,
  };
  const batch = await call<{ rows: Array<{ status: string }> }>("/occupancy/import", "POST", {
    fileHash: batchHash, entries: [{ record: batchFirst }, { record: batchSecond, keepBothConfirmed: true }],
  });
  assert.deepEqual(batch.body.rows.map((row) => row.status), ["inserted", "inserted"]);
  assert.equal((await call<OccupancyRecord[]>("/occupancy?fromDate=2026-10-23&toDate=2026-10-23")).body.length, 2);
});

test("occupancy import is safe under simultaneous retries and repeated rows in one batch", async () => {
  const fileHash = "c".repeat(64);
  const entry = {
    index: 0, sourceSheet: "Presença", sourceCell: "C2",
    sourceCells: { period: "A2", modality: "B2", percentage: "C2" },
    kind: "daily", period: "2026-08-08", modalityName: "Import Pilates Retry",
    percentage: 0, className: null,
  };
  const request = { fileHash, entries: [{ record: entry }] };
  const pair = await Promise.all([
    call<{ rows: Array<{ status: string }> }>("/occupancy/import", "POST", request),
    call<{ rows: Array<{ status: string }> }>("/occupancy/import", "POST", request),
  ]);
  assert.deepEqual(pair.map((result) => result.body.rows[0].status).sort(), ["already_imported", "inserted"]);
  const duplicated = await call<{ rows: Array<{ status: string }> }>("/occupancy/import", "POST", {
    fileHash: "d".repeat(64), entries: [
      { record: { ...entry, index: 1, period: "2026-08-09", sourceCell: "C3", sourceCells: { period: "A3", modality: "B3", percentage: "C3" } } },
      { record: { ...entry, index: 2, period: "2026-08-09", sourceCell: "C3", sourceCells: { period: "A3", modality: "B3", percentage: "C3" } } },
    ],
  });
  assert.deepEqual(duplicated.body.rows.map((row) => row.status), ["inserted", "duplicate_in_batch"]);
  assert.equal((await call<OccupancyRecord[]>("/occupancy?months=2026-08")).body.length, 2);
});

test("modality deletion requires the current version, removes linked classes, and unlinks products with audit", async () => {
  const modality = await call<OccupancyModality>("/occupancy/modalities", "POST", { name: "Modalidade para excluir" });
  assert.equal(modality.status, 201);
  const active = await call<OccupancyRecord>("/occupancy", "POST", record({
    period: "2026-11-01", modalityId: modality.body.id, modalityName: modality.body.name,
  }));
  const archived = await call<OccupancyRecord>("/occupancy", "POST", record({
    period: "2026-11-02", modalityId: modality.body.id, modalityName: modality.body.name,
  }));
  assert.equal(active.status, 201);
  assert.equal(archived.status, 201);
  await call(`/occupancy/${archived.body.id}`, "DELETE", { version: archived.body.version });

  const productId = randomUUID();
  await testPool.query(
    "INSERT INTO products (id, name, normalized_name, modality_id) VALUES ($1, $2, $3, $4)",
    [productId, "Produto vinculado", "produto vinculado", modality.body.id],
  );

  const stale = await call(`/occupancy/modalities/${modality.body.id}`, "DELETE", { version: modality.body.version + 1 });
  assert.equal(stale.status, 409);
  assert.equal((await testPool.query("SELECT count(*)::int AS count FROM occupancy_records WHERE modality_id=$1", [modality.body.id])).rows[0].count, 2);
  assert.equal((await testPool.query("SELECT modality_id FROM products WHERE id=$1", [productId])).rows[0].modality_id, modality.body.id);

  const deleted = await call<{ modalityId: string; deletedRecords: number; unlinkedProducts: number }>(
    `/occupancy/modalities/${modality.body.id}`, "DELETE", { version: modality.body.version },
  );
  assert.equal(deleted.status, 200);
  assert.deepEqual(deleted.body, { modalityId: modality.body.id, deletedRecords: 2, unlinkedProducts: 1 });
  assert.equal((await call<OccupancyModality[]>("/occupancy/modalities")).body.some((row) => row.id === modality.body.id), false);
  assert.equal((await testPool.query("SELECT count(*)::int AS count FROM occupancy_records WHERE modality_id=$1", [modality.body.id])).rows[0].count, 0);
  const product = (await testPool.query("SELECT modality_id, version FROM products WHERE id=$1", [productId])).rows[0];
  assert.equal(product.modality_id, null);
  assert.equal(product.version, 2);
  const modalityAudit = (await testPool.query(
    "SELECT before_data FROM occupancy_history WHERE entity_type='modality' AND entity_id=$1 AND operation='delete'",
    [modality.body.id],
  )).rows[0];
  assert.equal(modalityAudit.before_data.deletedRecords, 2);
  assert.deepEqual(modalityAudit.before_data.unlinkedProductIds, [productId]);
  const recordAudits = await testPool.query(
    "SELECT count(*)::int AS count FROM occupancy_history WHERE entity_type='record' AND entity_id = ANY($1::uuid[]) AND operation='delete'",
    [[active.body.id, archived.body.id]],
  );
  assert.equal(recordAudits.rows[0].count, 3);
});
