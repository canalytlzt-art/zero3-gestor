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
    { percentage: null }, { percentage: "" }, { percentage: -1 }, { percentage: 100.01 },
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
