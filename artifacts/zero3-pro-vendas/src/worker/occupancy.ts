import {
  CreateOccupancyModalityBody,
  CreateOccupancyRecordBody,
  DeleteOccupancyModalityBody,
  DeleteOccupancyModalityParams,
  DeleteOccupancyModalityResponse,
  DeleteOccupancyRecordBody,
  DeleteOccupancyRecordParams,
  CommitOccupancyImportBody,
  CommitOccupancyImportResponse,
  CreateOccupancyBackupBody,
  CreateOccupancyBackupResponse,
  GetOccupancyModalitiesResponse,
  GetOccupancyMonthlyGoalsQueryParams,
  GetOccupancyMonthlyGoalsResponse,
  GetOccupancyMonthlyAggregatorAdjustmentsQueryParams,
  GetOccupancyMonthlyAggregatorAdjustmentsResponse,
  GetOccupancyRecordsQueryParams,
  GetOccupancyRecordsResponse,
  PreviewOccupancyImportBody,
  PreviewOccupancyImportResponse,
  PreviewOccupancyBackupRestoreBody,
  PreviewOccupancyBackupRestoreResponse,
  RestoreOccupancyBackupBody,
  RestoreOccupancyBackupResponse,
  UpsertOccupancyMonthlyGoalBody,
  UpsertOccupancyMonthlyGoalParams,
  UpsertOccupancyMonthlyGoalResponse,
  PreviewOccupancyMonthlyAggregatorAdjustmentBody,
  PreviewOccupancyMonthlyAggregatorAdjustmentResponse,
  SaveOccupancyMonthlyAggregatorAdjustmentParams,
  SaveOccupancyMonthlyAggregatorAdjustmentBody,
  SaveOccupancyMonthlyAggregatorAdjustmentResponse,
  UndoOccupancyMonthlyAggregatorAdjustmentParams,
  UndoOccupancyMonthlyAggregatorAdjustmentBody,
  UpdateOccupancyModalityBody,
  UpdateOccupancyModalityParams,
  UpdateOccupancyRecordBody,
  UpdateOccupancyRecordParams,
} from "@workspace/api-zod";
import { ApiFailure } from "./idempotency";
import { apiError, json, readJson } from "./http";
import type { AuthContext, D1Database, WorkerEnv } from "./types";
import { getIsoWeekday } from "../lib/occupancy-calendar";

type Row = Record<string, unknown>;
const nowIso = () => new Date().toISOString();
const cleanText = (value: string) => value.trim().replace(/\s+/g, " ");
const keyOf = (value: string) => cleanText(value).toLocaleLowerCase("pt-BR");

function parse<T>(
  schema: {
    safeParse(value: unknown):
      | { success: true; data: T }
      | { success: false; error: { message: string } };
  },
  value: unknown,
): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiFailure(400, result.error.message);
  return result.data;
}

const all = async <T extends Row>(statement: ReturnType<D1Database["prepare"]>) => {
  const result = await statement.all<T>();
  return result.results ?? [];
};

function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00.000Z`);
  return !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === value;
}

function validMonth(value: string) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value) && !value.startsWith("0000");
}

function recordOut(row: Row) {
  let sourceCells: Record<string, string> | null = null;
  if (typeof row.source_cells === "string") {
    try {
      sourceCells = JSON.parse(row.source_cells) as Record<string, string>;
    } catch {
      sourceCells = null;
    }
  }
  const kind = String(row.kind);
  return {
    id: String(row.id),
    kind,
    period: kind === "daily" ? String(row.date) : String(row.month),
    month: String(row.month),
    modalityId: String(row.modality_id),
    modalityName: String(row.modality_name),
    percentage: Number(row.percentage),
    reportedPercentage:
      row.reported_percentage === null || row.reported_percentage === undefined
        ? null
        : Number(row.reported_percentage),
    presences: row.presences === null ? null : Number(row.presences),
    capacity: row.capacity === null ? null : Number(row.capacity),
    aggregatorPresences: row.aggregator_presences === null || row.aggregator_presences === undefined
      ? null
      : Number(row.aggregator_presences),
    aggregatorSource: row.aggregator_presences === null || row.aggregator_presences === undefined
      ? null
      : row.aggregator_origin === "monthly_estimated" ? "monthly_estimated" : "recorded",
    startTime: row.start_time ? String(row.start_time).slice(0, 5) : null,
    endTime: row.end_time ? String(row.end_time).slice(0, 5) : null,
    className: row.class_name === null ? null : String(row.class_name),
    notes: row.notes === null ? null : String(row.notes),
    sourceFileHash: row.source_file_hash === null ? null : String(row.source_file_hash),
    sourceSheet: row.source_sheet === null ? null : String(row.source_sheet),
    sourceCell: row.source_cell === null ? null : String(row.source_cell),
    sourceCells,
    version: Number(row.version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function validateImportOrigin(entry: {
  sourceSheet: string;
  sourceCell: string;
  sourceCells: Record<string, string>;
  percentage?: number;
  reportedPercentage?: number | null;
  presences?: number;
  capacity?: number;
  aggregatorPresences?: number | null;
  startTime?: string;
}) {
  const cells = entry.sourceCells;
  const measured = entry.presences !== undefined || entry.capacity !== undefined;
  const sourceValid = measured
    ? Boolean(cells.presences && cells.capacity && cells.startTime) &&
      cells.presences === entry.sourceCell &&
      (entry.aggregatorPresences == null || Boolean(cells.aggregatorPresences)) &&
      (entry.reportedPercentage === undefined || Boolean(cells.percentage))
    : entry.percentage !== undefined &&
      Boolean(cells.percentage) &&
      cells.percentage === entry.sourceCell;
  if (
    !entry.sourceSheet.trim() ||
    Object.keys(cells).length < 2 ||
    Object.keys(cells).length > 9 ||
    !cells.period ||
    !cells.modality ||
    !sourceValid
  ) {
    throw new ApiFailure(
      400,
      "A origem deve identificar aba, período, modalidade e os campos de ocupação correspondentes.",
    );
  }
}

function sameImportedRecord(
  existing: ReturnType<typeof recordOut>,
  entry: {
    kind: string;
    period: string;
    modalityName: string;
    className?: string | null;
  },
  values: ReturnType<typeof recordValues>,
) {
  return (
    existing.kind === entry.kind &&
    existing.period === entry.period &&
    keyOf(existing.modalityName) === keyOf(entry.modalityName) &&
    Number(existing.percentage) === Number(values.percentage) &&
    existing.presences === values.presences &&
    existing.capacity === values.capacity &&
    existing.aggregatorPresences === values.aggregatorPresences &&
    existing.startTime === (values.startTime?.slice(0, 5) ?? null) &&
    existing.endTime === (values.endTime?.slice(0, 5) ?? null) &&
    existing.reportedPercentage ===
      (values.reportedPercentage === null ? null : Number(values.reportedPercentage)) &&
    keyOf(existing.className ?? "") === keyOf(entry.className ?? "")
  );
}

async function writeHistory(
  db: D1Database,
  entityType: string,
  entityId: string,
  operation: string,
  actorId: string,
  before: unknown,
  after: unknown,
) {
  await db
    .prepare(
      `INSERT INTO occupancy_history
        (id, entity_type, entity_id, operation, actor_id, before_data, after_data, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      entityType,
      entityId,
      operation,
      actorId,
      before === null ? null : JSON.stringify(before),
      after === null ? null : JSON.stringify(after),
      nowIso(),
    )
    .run();
}

async function resolveModality(
  db: D1Database,
  actorId: string,
  modalityId: string | undefined,
  modalityName: string,
): Promise<{ id: string; name: string }> {
  if (modalityId) {
    const found = await db
      .prepare("SELECT id, name FROM occupancy_modalities WHERE id=?")
      .bind(modalityId)
      .first<{ id: string; name: string }>();
    if (!found) throw new ApiFailure(404, "Modalidade não encontrada.");
    return found;
  }
  const name = cleanText(modalityName);
  if (!name) throw new ApiFailure(400, "Informe a modalidade.");
  const normalizedName = keyOf(name);
  const existing = await db
    .prepare("SELECT id, name FROM occupancy_modalities WHERE normalized_name=?")
    .bind(normalizedName)
    .first<{ id: string; name: string }>();
  if (existing) return existing;

  const modality = {
    id: crypto.randomUUID(),
    name,
    normalizedName,
    version: 1,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  const result = await db
    .prepare(
      `INSERT INTO occupancy_modalities
        (id, name, normalized_name, version, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?) ON CONFLICT(normalized_name) DO NOTHING`,
    )
    .bind(
      modality.id,
      modality.name,
      modality.normalizedName,
      modality.createdAt,
      modality.updatedAt,
    )
    .run();
  if (Number(result.meta?.changes ?? 0) === 1) {
    await writeHistory(db, "modality", modality.id, "create", actorId, null, modality);
    return { id: modality.id, name: modality.name };
  }
  const raced = await db
    .prepare("SELECT id, name FROM occupancy_modalities WHERE normalized_name=?")
    .bind(normalizedName)
    .first<{ id: string; name: string }>();
  if (!raced) throw new ApiFailure(409, "A modalidade mudou; atualize e tente novamente.");
  return raced;
}

function recordValues(input: {
  kind: string;
  period: string;
  modalityName: string;
  percentage?: number;
  reportedPercentage?: number;
  presences?: number;
  capacity?: number;
  aggregatorPresences?: number | null;
  startTime?: string;
  endTime?: string | null;
  className?: string | null;
  notes?: string | null;
}) {
  const daily = input.kind === "daily";
  if (daily ? !validDate(input.period) : !validMonth(input.period)) {
    throw new ApiFailure(400, daily ? "Informe uma data válida." : "Informe mês e ano válidos.");
  }
  const measured =
    input.presences !== undefined ||
    input.capacity !== undefined ||
    input.startTime !== undefined ||
    input.endTime != null ||
    (input.aggregatorPresences !== undefined && input.aggregatorPresences !== null);
  let percentage: number;
  let reportedPercentage: number | null = null;
  if (measured) {
    if (
      !daily ||
      !Number.isSafeInteger(input.presences) ||
      Number(input.presences) < 0 ||
      !Number.isSafeInteger(input.capacity) ||
      Number(input.capacity) <= 0 ||
      !input.startTime ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.startTime) ||
      (input.endTime != null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.endTime))
    ) {
      throw new ApiFailure(
        400,
        "Informe data, horário inicial, presenças e capacidade válidos.",
      );
    }
    if (input.aggregatorPresences !== undefined && input.aggregatorPresences !== null
      && (!Number.isSafeInteger(input.aggregatorPresences) || input.aggregatorPresences < 0
        || input.aggregatorPresences > Number(input.presences))) {
      throw new ApiFailure(400, "Agregadores deve ser um número inteiro entre zero e o total de presenças.");
    }
    percentage = Number(((Number(input.presences) / Number(input.capacity)) * 100).toFixed(6));
    const reported = input.reportedPercentage ?? input.percentage;
    if (reported !== undefined) {
      if (!Number.isFinite(reported) || reported < 0) {
        throw new ApiFailure(400, "O percentual informado deve ser igual ou maior que zero.");
      }
      reportedPercentage = reported;
    }
  } else {
    if (input.aggregatorPresences !== undefined && input.aggregatorPresences !== null) {
      throw new ApiFailure(400, "Informe presenças e capacidade para cadastrar agregadores.");
    }
    if (input.percentage === undefined || !Number.isFinite(input.percentage) || input.percentage < 0) {
      throw new ApiFailure(400, "Informe presenças/capacidade ou um percentual válido.");
    }
    percentage = input.percentage;
  }
  const className = input.className ? cleanText(input.className) || null : null;
  return {
    kind: input.kind,
    date: daily ? input.period : null,
    month: input.period.slice(0, 7),
    percentage: String(percentage),
    reportedPercentage: reportedPercentage === null ? null : String(reportedPercentage),
    presences: measured ? input.presences! : null,
    capacity: measured ? input.capacity! : null,
    aggregatorPresences: measured ? input.aggregatorPresences ?? null : null,
    startTime: measured ? `${input.startTime}:00` : null,
    endTime: measured && input.endTime ? `${input.endTime}:00` : null,
    className,
    scopeKey: className ? keyOf(className) : "",
    notes: input.notes?.trim() || null,
  };
}

async function modalityRoutes(
  request: Request,
  env: WorkerEnv,
  actor: AuthContext,
  path: string,
): Promise<Response | null> {
  if (path === "/occupancy/modalities" && request.method === "GET") {
    const rows = await all(
      env.DB.prepare("SELECT id, name, version FROM occupancy_modalities ORDER BY normalized_name"),
    );
    return json(GetOccupancyModalitiesResponse.parse(rows));
  }
  if (path === "/occupancy/modalities" && request.method === "POST") {
    const input = parse(CreateOccupancyModalityBody, await readJson(request));
    const name = cleanText(input.name);
    const id = crypto.randomUUID();
    const now = nowIso();
    const result = await env.DB
      .prepare(
        `INSERT INTO occupancy_modalities
          (id, name, normalized_name, version, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?) ON CONFLICT(normalized_name) DO NOTHING`,
      )
      .bind(id, name, keyOf(name), now, now)
      .run();
    if (Number(result.meta?.changes ?? 0) === 0) {
      throw new ApiFailure(409, "Já existe uma modalidade com esse nome.");
    }
    const row = { id, name, version: 1 };
    await writeHistory(env.DB, "modality", id, "create", actor.userId, null, row);
    return json(row, 201);
  }
  const id = /^\/occupancy\/modalities\/([0-9a-f-]+)$/i.exec(path)?.[1];
  if (!id) return null;
  if (request.method === "PATCH") {
    const input = parse(UpdateOccupancyModalityBody, await readJson(request));
    const current = await env.DB
      .prepare("SELECT * FROM occupancy_modalities WHERE id=?")
      .bind(id)
      .first<Row>();
    if (!current) throw new ApiFailure(404, "Modalidade não encontrada.");
    if (Number(current.version) !== input.version) {
      throw new ApiFailure(409, "A modalidade foi alterada. Atualize antes de renomear.");
    }
    const name = cleanText(input.name);
    const now = nowIso();
    const result = await env.DB.batch([
      env.DB
        .prepare(
          `UPDATE occupancy_modalities SET name=?, normalized_name=?, version=version+1, updated_at=?
           WHERE id=? AND version=?`,
        )
        .bind(name, keyOf(name), now, id, input.version),
      env.DB
        .prepare(
          `INSERT INTO occupancy_history
            (id, entity_type, entity_id, operation, actor_id, before_data, after_data, created_at)
           SELECT ?, 'modality', id, 'rename', ?, ?, json_object('id', id, 'name', name,
             'version', version), ? FROM occupancy_modalities
           WHERE id=? AND version=? AND updated_at=?`,
        )
        .bind(crypto.randomUUID(), actor.userId, JSON.stringify(current), now, id, input.version + 1, now),
    ]);
    if (Number(result[0]?.meta?.changes ?? 0) === 0) {
      throw new ApiFailure(409, "A modalidade foi alterada. Atualize antes de renomear.");
    }
    const updated = await env.DB
      .prepare("SELECT id, name, version FROM occupancy_modalities WHERE id=?")
      .bind(id)
      .first<Row>();
    return json(updated);
  }
  if (request.method === "DELETE") {
    parse(DeleteOccupancyModalityParams, { id });
    const input = parse(DeleteOccupancyModalityBody, await readJson(request));
    const modality = await env.DB
      .prepare("SELECT * FROM occupancy_modalities WHERE id=?")
      .bind(id)
      .first<Row>();
    if (!modality) throw new ApiFailure(404, "Modalidade não encontrada.");
    if (Number(modality.version) !== input.version) {
      throw new ApiFailure(409, "A modalidade foi alterada. Atualize antes de excluir.");
    }
    const records = await all(
      env.DB.prepare("SELECT * FROM occupancy_records WHERE modality_id=?").bind(id),
    );
    const products = await all(
      env.DB.prepare("SELECT * FROM products WHERE modality_id=?").bind(id),
    );
    const now = nowIso();
    const statements = [
      env.DB
        .prepare(
          `INSERT INTO occupancy_history
            (id, entity_type, entity_id, operation, actor_id, before_data, after_data, created_at)
           SELECT lower(hex(randomblob(16))), 'record', id, 'delete', ?, json_object(
             'id', id, 'modalityId', modality_id, 'kind', kind, 'date', date,
             'month', month, 'percentage', percentage, 'version', version), NULL, ?
           FROM occupancy_records WHERE modality_id=?`,
        )
        .bind(actor.userId, now, id),
      env.DB
        .prepare(
          `INSERT INTO sales_history
            (id, entity_type, entity_id, operation, actor_id, before_data, after_data, created_at)
           SELECT lower(hex(randomblob(16))), 'product', id, 'unlink-modality', ?,
             json_object('id', id, 'modalityId', modality_id, 'version', version),
             json_object('id', id, 'modalityId', NULL, 'version', version+1), ?
           FROM products WHERE modality_id=?`,
        )
        .bind(actor.userId, now, id),
      env.DB
        .prepare(
          "UPDATE products SET modality_id=NULL, version=version+1, updated_at=? WHERE modality_id=?",
        )
        .bind(now, id),
      env.DB
        .prepare(
          `INSERT INTO occupancy_history
            (id, entity_type, entity_id, operation, actor_id, before_data, after_data, created_at)
           VALUES (?, 'modality', ?, 'delete', ?, ?, NULL, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          id,
          actor.userId,
          JSON.stringify({
            ...modality,
            deletedRecords: records.length,
            unlinkedProductIds: products.map((product) => product.id),
          }),
          now,
        ),
      env.DB.prepare("DELETE FROM occupancy_records WHERE modality_id=?").bind(id),
      env.DB
        .prepare("DELETE FROM occupancy_modalities WHERE id=? AND version=?")
        .bind(id, input.version),
    ];
    const result = await env.DB.batch(statements);
    if (Number(result.at(-1)?.meta?.changes ?? 0) === 0) {
      throw new ApiFailure(409, "A modalidade foi alterada. Atualize antes de excluir.");
    }
    return json(
      DeleteOccupancyModalityResponse.parse({
        modalityId: id,
        deletedRecords: records.length,
        unlinkedProducts: products.length,
      }),
    );
  }
  return null;
}

function monthlyGoalOut(row: Row) {
  return {
    month: String(row.month),
    modalityId: row.modality_id == null ? null : String(row.modality_id),
    modalityName: row.modality_name == null ? null : String(row.modality_name),
    aggregatorTargetPresences: row.aggregator_target_presences == null ? null : Number(row.aggregator_target_presences),
    occupancyTargetPercentage: row.occupancy_target_percentage == null ? null : Number(row.occupancy_target_percentage),
    notes: row.notes == null ? null : String(row.notes),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

async function monthlyGoalRoutes(
  request: Request,
  env: WorkerEnv,
  path: string,
): Promise<Response | null> {
  if (path === "/occupancy/monthly-goals" && request.method === "GET") {
    const url = new URL(request.url);
    const input = parse(GetOccupancyMonthlyGoalsQueryParams, Object.fromEntries(url.searchParams));
    if (input.fromMonth && !validMonth(input.fromMonth) || input.toMonth && !validMonth(input.toMonth)) {
      throw new ApiFailure(400, "Selecione meses válidos.");
    }
    if (input.fromMonth && input.toMonth && input.fromMonth > input.toMonth) {
      throw new ApiFailure(400, "O mês inicial deve ser anterior ou igual ao mês final.");
    }
    const filters: string[] = [];
    const values: string[] = [];
    if (input.fromMonth) { filters.push("month >= ?"); values.push(input.fromMonth); }
    if (input.toMonth) { filters.push("month <= ?"); values.push(input.toMonth); }
    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    const rows = await all(
      env.DB.prepare(
        `SELECT month, modality_id, modality_name, aggregator_target_presences,
                occupancy_target_percentage, notes, created_at, updated_at
         FROM occupancy_monthly_goals ${where}
         ORDER BY month ASC, scope_key ASC`,
      ).bind(...values),
    );
    return json(GetOccupancyMonthlyGoalsResponse.parse(rows.map(monthlyGoalOut)));
  }

  const rawMonth = /^\/occupancy\/monthly-goals\/([^/]+)$/.exec(path)?.[1];
  if (rawMonth && request.method === "PUT") {
    const { month } = parse(UpsertOccupancyMonthlyGoalParams, { month: rawMonth });
    const input = parse(UpsertOccupancyMonthlyGoalBody, await readJson(request));
    if (input.aggregatorTargetPresences === null && input.occupancyTargetPercentage === null) {
      throw new ApiFailure(400, "Informe ao menos uma meta mensal.");
    }
    let modalityName: string | null = null;
    if (input.modalityId) {
      const modality = await env.DB
        .prepare("SELECT name FROM occupancy_modalities WHERE id=?")
        .bind(input.modalityId)
        .first<{ name: string }>();
      if (!modality) throw new ApiFailure(404, "Modalidade não encontrada.");
      modalityName = cleanText(modality.name);
    }
    const scopeKey = input.modalityId ?? "all";
    const now = nowIso();
    const row = await env.DB.prepare(
      `INSERT INTO occupancy_monthly_goals (
         month, scope_key, modality_id, modality_name, aggregator_target_presences,
         occupancy_target_percentage, notes, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(month, scope_key) DO UPDATE SET
         modality_id=excluded.modality_id,
         modality_name=excluded.modality_name,
         aggregator_target_presences=excluded.aggregator_target_presences,
         occupancy_target_percentage=excluded.occupancy_target_percentage,
         notes=excluded.notes,
         updated_at=excluded.updated_at
       RETURNING month, modality_id, modality_name, aggregator_target_presences,
                 occupancy_target_percentage, notes, created_at, updated_at`,
    ).bind(
      month,
      scopeKey,
      input.modalityId,
      modalityName,
      input.aggregatorTargetPresences,
      input.occupancyTargetPercentage,
      input.notes?.trim() || null,
      now,
      now,
    ).first<Row>();
    if (!row) throw new ApiFailure(500, "Não foi possível salvar a meta mensal.");
    return json(UpsertOccupancyMonthlyGoalResponse.parse(monthlyGoalOut(row)));
  }
  return null;
}

type MonthlyAggregatorRecord = Row & {
  id: string;
  modality_id: string;
  modality_name: string;
  date: string;
  presences: number;
  aggregator_presences: number | null;
  aggregator_adjustment_id: string | null;
  version: number;
};

type MonthlyAggregatorPreviewInput = {
  month: string;
  modalityId: string | null;
  targetPresences: number;
};

type MonthlyAggregatorSnapshotRow = {
  id: string;
  version: number;
  presences: number;
  aggregatorPresences: number | null;
  aggregatorAdjustmentId: string | null;
};

function distributeProportionally(
  rows: readonly MonthlyAggregatorRecord[],
  target: number,
) {
  const totalWeight = rows.reduce((sum, row) => sum + Number(row.presences), 0);
  if (rows.length === 0) return new Map<string, number>();
  if (target === 0 || totalWeight === 0) {
    return new Map(rows.map((row) => [row.id, 0]));
  }

  const parts = rows.map((row) => {
    const exact = target * Number(row.presences) / totalWeight;
    const floor = Math.floor(exact);
    return { id: row.id, value: floor, remainder: exact - floor };
  });
  let residue = target - parts.reduce((sum, part) => sum + part.value, 0);
  const ranked = [...parts].sort((a, b) => b.remainder - a.remainder || a.id.localeCompare(b.id));
  for (let index = 0; residue > 0; index = (index + 1) % ranked.length) {
    const part = ranked[index]!;
    const row = rows.find((candidate) => candidate.id === part.id)!;
    if (part.value >= Number(row.presences)) continue;
    part.value += 1;
    residue -= 1;
  }
  return new Map(parts.map((part) => [part.id, part.value]));
}

async function digestSnapshot(value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function adjustmentOut(row: Row) {
  return {
    id: String(row.id),
    month: String(row.month),
    scopeKey: String(row.scope_key),
    modalityId: row.modality_id == null ? null : String(row.modality_id),
    modalityName: row.modality_name == null ? null : String(row.modality_name),
    targetPresences: Number(row.target_presences),
    version: Number(row.version),
    active: row.deleted_at == null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    deletedAt: row.deleted_at == null ? null : String(row.deleted_at),
  };
}

async function getMonthlyAggregatorRows(
  env: WorkerEnv,
  month: string,
  modalityId: string | null,
) {
  return all<MonthlyAggregatorRecord>(
    env.DB.prepare(
      `SELECT r.*, m.name AS modality_name
       FROM occupancy_records r
       JOIN occupancy_modalities m ON m.id=r.modality_id
       WHERE r.month=? AND r.kind='daily' AND r.presences IS NOT NULL
         AND r.deleted_at IS NULL AND (? IS NULL OR r.modality_id=?)
       ORDER BY r.date ASC, r.start_time ASC, r.id ASC`,
    ).bind(month, modalityId, modalityId),
  );
}

async function buildMonthlyAggregatorPreview(
  env: WorkerEnv,
  input: MonthlyAggregatorPreviewInput,
  requestedAdjustmentId?: string,
) {
  if (!validMonth(input.month)) throw new ApiFailure(400, "Selecione um mês válido.");
  if (!Number.isSafeInteger(input.targetPresences) || input.targetPresences < 0 || input.targetPresences > 2_147_483_647) {
    throw new ApiFailure(400, "Informe um total mensal inteiro e igual ou maior que zero.");
  }
  let modalityName: string | null = null;
  if (input.modalityId) {
    const modality = await env.DB.prepare("SELECT name FROM occupancy_modalities WHERE id=?")
      .bind(input.modalityId).first<{ name: string }>();
    if (!modality) throw new ApiFailure(404, "Modalidade não encontrada.");
    modalityName = String(modality.name);
  }
  const scopeKey = input.modalityId ?? "all";
  const current = await env.DB.prepare(
    "SELECT * FROM occupancy_aggregator_adjustments WHERE month=? AND scope_key=?",
  ).bind(input.month, scopeKey).first<Row>();
  const overlap = await env.DB.prepare(
    `SELECT id FROM occupancy_aggregator_adjustments
     WHERE month=? AND deleted_at IS NULL AND scope_key<>?
       AND (?='all' OR scope_key='all') LIMIT 1`,
  ).bind(input.month, scopeKey, scopeKey).first<{ id: string }>();
  const records = await getMonthlyAggregatorRows(env, input.month, input.modalityId);
  const adjustmentId = current
    ? String(current.id)
    : requestedAdjustmentId ?? crypto.randomUUID();
  const totalPresences = records.reduce((sum, row) => sum + Number(row.presences), 0);
  const recordedRows = records.filter((row) =>
    row.aggregator_presences != null && row.aggregator_adjustment_id !== adjustmentId
  );
  const recordedAggregatorPresences = recordedRows.reduce(
    (sum, row) => sum + Number(row.aggregator_presences ?? 0),
    0,
  );
  const previousEstimatedPresences = records
    .filter((row) => row.aggregator_adjustment_id === adjustmentId)
    .reduce((sum, row) => sum + Number(row.aggregator_presences ?? 0), 0);
  const candidates = records.filter((row) =>
    row.aggregator_presences == null || row.aggregator_adjustment_id === adjustmentId
  );
  const remainingToDistribute = input.targetPresences - recordedAggregatorPresences;
  const candidateCapacity = candidates.reduce((sum, row) => sum + Number(row.presences), 0);
  const canSave = !overlap
    && records.length > 0
    && remainingToDistribute >= 0
    && remainingToDistribute <= candidateCapacity;
  const allocations = canSave
    ? distributeProportionally(candidates, remainingToDistribute)
    : new Map<string, number>();
  let message = "Prévia pronta. As presenças manuais serão preservadas.";
  if (overlap) {
    message = "Já existe um ajuste geral ou de modalidade que abrange estas aulas. Desfaça-o antes de criar outro.";
  } else if (records.length === 0) {
    message = "Não há aulas diárias com presenças registradas neste mês e recorte.";
  } else if (remainingToDistribute < 0) {
    message = "O total informado é menor que os agregadores já registrados. Nenhum valor foi alterado.";
  } else if (remainingToDistribute > candidateCapacity) {
    message = "Não há presenças sem classificação suficientes para distribuir esse total.";
  }
  const snapshotRows: MonthlyAggregatorSnapshotRow[] = records.map((row) => ({
    id: String(row.id),
    version: Number(row.version),
    presences: Number(row.presences),
    aggregatorPresences: row.aggregator_presences == null ? null : Number(row.aggregator_presences),
    aggregatorAdjustmentId: row.aggregator_adjustment_id == null
      ? null
      : String(row.aggregator_adjustment_id),
  }));
  const snapshotToken = await digestSnapshot({
    month: input.month,
    scopeKey,
    targetPresences: input.targetPresences,
    adjustmentId,
    expectedVersion: current ? Number(current.version) : 0,
    adjustmentUpdatedAt: current?.updated_at ?? null,
    rows: snapshotRows,
  });
  const preview = PreviewOccupancyMonthlyAggregatorAdjustmentResponse.parse({
    month: input.month,
    modalityId: input.modalityId,
    modalityName,
    targetPresences: input.targetPresences,
    totalPresences,
    recordedAggregatorPresences,
    previousEstimatedPresences,
    remainingToDistribute,
    otherPresences: canSave ? totalPresences - input.targetPresences : null,
    measuredClassCount: records.length,
    candidateClassCount: candidates.length,
    canSave,
    message,
    expectedVersion: current ? Number(current.version) : 0,
    adjustmentId,
    snapshotToken,
    allocations: candidates.map((row) => ({
      recordId: String(row.id),
      date: String(row.date),
      modalityName: String(row.modality_name),
      startTime: row.start_time == null ? null : String(row.start_time).slice(0, 5),
      className: row.class_name == null ? null : String(row.class_name),
      presences: Number(row.presences),
      previousAggregatorPresences: row.aggregator_presences == null
        ? null
        : Number(row.aggregator_presences),
      assignedAggregatorPresences: allocations.get(String(row.id)) ?? 0,
    })),
  });
  return {
    preview,
    scopeKey,
    current,
    records,
    candidates,
    snapshotRows,
    modalityName,
  };
}

function monthlyAggregatorRouteError(error: unknown): never {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("occupancy_aggregator_adjustment_scope_overlap")) {
    throw new ApiFailure(409, "Há outro ajuste mensal ativo que abrange estas aulas. Atualize a base e tente novamente.");
  }
  throw error;
}

async function monthlyAggregatorAdjustmentRoutes(
  request: Request,
  env: WorkerEnv,
  actor: AuthContext,
  path: string,
) {
  if (path === "/occupancy/monthly-aggregator-adjustments" && request.method === "GET") {
    const url = new URL(request.url);
    const input = parse(
      GetOccupancyMonthlyAggregatorAdjustmentsQueryParams,
      Object.fromEntries(url.searchParams),
    );
    const rows = await all(
      env.DB.prepare(
        `SELECT * FROM occupancy_aggregator_adjustments
         WHERE month=? ORDER BY scope_key ASC`,
      ).bind(input.month),
    );
    return json(GetOccupancyMonthlyAggregatorAdjustmentsResponse.parse(rows.map(adjustmentOut)));
  }

  if (path === "/occupancy/monthly-aggregator-adjustments/preview" && request.method === "POST") {
    const input = parse(PreviewOccupancyMonthlyAggregatorAdjustmentBody, await readJson(request));
    const result = await buildMonthlyAggregatorPreview(env, input);
    return json(result.preview);
  }

  const monthPath = /^\/occupancy\/monthly-aggregator-adjustments\/(\d{4}-(?:0[1-9]|1[0-2]))$/.exec(path)?.[1];
  if (monthPath && request.method === "PUT") {
    const { month } = parse(SaveOccupancyMonthlyAggregatorAdjustmentParams, { month: monthPath });
    const input = parse(SaveOccupancyMonthlyAggregatorAdjustmentBody, await readJson(request));
    if (input.month !== month) throw new ApiFailure(400, "O mês do ajuste não corresponde à rota.");
    const result = await buildMonthlyAggregatorPreview(env, input, input.adjustmentId);
    if (
      !result.preview.canSave ||
      result.preview.snapshotToken !== input.snapshotToken ||
      result.preview.expectedVersion !== input.expectedVersion ||
      result.preview.adjustmentId !== input.adjustmentId
    ) {
      throw new ApiFailure(409, result.preview.canSave
        ? "Os check-ins mudaram desde a prévia. Atualize a prévia antes de salvar."
        : result.preview.message);
    }
    const now = nowIso();
    const operationToken = crypto.randomUUID();
    const scopeKey = input.modalityId ?? "all";
    const snapshotJson = JSON.stringify(result.snapshotRows);
    const allocations = result.preview.allocations.map((allocation) => ({
      id: allocation.recordId,
      version: result.records.find((row) => String(row.id) === allocation.recordId)!.version,
      assigned: allocation.assignedAggregatorPresences,
      historyId: crypto.randomUUID(),
      beforeData: JSON.stringify({
        id: allocation.recordId,
        aggregatorPresences: allocation.previousAggregatorPresences,
        aggregatorSource: allocation.previousAggregatorPresences === null ? null : "recorded",
        adjustmentId: result.records.find((row) => String(row.id) === allocation.recordId)?.aggregator_adjustment_id ?? null,
      }),
    }));
    const allocationsJson = JSON.stringify(allocations);
    const batch = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO occupancy_aggregator_adjustments
          (id, month, scope_key, modality_id, modality_name, target_presences,
           version, created_by, updated_by, created_at, updated_at, operation_token, deleted_by, deleted_at)
         SELECT ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, NULL, NULL
         WHERE
           (SELECT COUNT(*) FROM occupancy_records
            WHERE month=? AND kind='daily' AND presences IS NOT NULL AND deleted_at IS NULL
              AND (? IS NULL OR modality_id=?)) = ?
           AND NOT EXISTS (
             SELECT 1 FROM json_each(?) snapshot
             LEFT JOIN occupancy_records r ON r.id=json_extract(snapshot.value, '$.id')
             WHERE r.id IS NULL OR r.deleted_at IS NOT NULL
               OR r.version IS NOT json_extract(snapshot.value, '$.version')
               OR r.presences IS NOT json_extract(snapshot.value, '$.presences')
               OR r.aggregator_presences IS NOT json_extract(snapshot.value, '$.aggregatorPresences')
               OR coalesce(r.aggregator_adjustment_id, '') <>
                  coalesce(json_extract(snapshot.value, '$.aggregatorAdjustmentId'), '')
           )
         ON CONFLICT(month, scope_key) DO UPDATE SET
           modality_id=excluded.modality_id,
           modality_name=excluded.modality_name,
           target_presences=excluded.target_presences,
           version=occupancy_aggregator_adjustments.version+1,
           updated_by=excluded.updated_by,
           updated_at=excluded.updated_at,
           operation_token=excluded.operation_token,
           deleted_by=NULL,
           deleted_at=NULL
         WHERE occupancy_aggregator_adjustments.version=?`,
      ).bind(
        input.adjustmentId,
        month,
        scopeKey,
        input.modalityId,
        result.modalityName,
        input.targetPresences,
        actor.userId,
        actor.userId,
        now,
        now,
        operationToken,
        month,
        input.modalityId,
        input.modalityId,
        result.snapshotRows.length,
        snapshotJson,
        input.expectedVersion,
      ),
      env.DB.prepare(
        `UPDATE occupancy_records
         SET aggregator_presences=json_extract(allocation.value, '$.assigned'),
             aggregator_origin='monthly_estimated',
             aggregator_adjustment_id=?,
             version=version+1, updated_by=?, updated_at=?
         FROM json_each(?) allocation
         WHERE occupancy_records.id=json_extract(allocation.value, '$.id')
           AND occupancy_records.version=json_extract(allocation.value, '$.version')
           AND EXISTS (
             SELECT 1 FROM occupancy_aggregator_adjustments
             WHERE id=? AND operation_token=? AND deleted_at IS NULL
           )`,
      ).bind(input.adjustmentId, actor.userId, now, allocationsJson, input.adjustmentId, operationToken),
      env.DB.prepare(
        `INSERT INTO occupancy_history
          (id, entity_type, entity_id, operation, actor_id, before_data, after_data, created_at)
         SELECT json_extract(allocation.value, '$.historyId'),
                'record', r.id, 'monthly_aggregator_adjustment', ?,
                json_extract(allocation.value, '$.beforeData'),
                json_object('id', r.id, 'aggregatorPresences', r.aggregator_presences,
                  'aggregatorSource', 'monthly_estimated', 'adjustmentId', ?,
                  'version', r.version),
                ?
         FROM json_each(?) allocation
         JOIN occupancy_records r ON r.id=json_extract(allocation.value, '$.id')
         WHERE r.aggregator_adjustment_id=? AND r.updated_at=?
           AND EXISTS (SELECT 1 FROM occupancy_aggregator_adjustments a
                       WHERE a.id=? AND a.operation_token=?)`,
      ).bind(actor.userId, input.adjustmentId, now, allocationsJson, input.adjustmentId, now, input.adjustmentId, operationToken),
      env.DB.prepare(
        `INSERT INTO occupancy_history
          (id, entity_type, entity_id, operation, actor_id, before_data, after_data, created_at)
         SELECT ?, 'aggregator_adjustment', id, ? , ?, ?, json_object(
           'id', id, 'month', month, 'scopeKey', scope_key,
           'targetPresences', target_presences, 'version', version,
           'deletedAt', deleted_at), ?
         FROM occupancy_aggregator_adjustments WHERE id=? AND operation_token=?`,
      ).bind(
        crypto.randomUUID(),
        result.current ? "update" : "create",
        actor.userId,
        result.current ? JSON.stringify(adjustmentOut(result.current)) : null,
        now,
        input.adjustmentId,
        operationToken,
      ),
    ]);
    if (Number(batch[0]?.meta?.changes ?? 0) !== 1) {
      throw new ApiFailure(409, "Os check-ins ou o ajuste mudaram durante a gravação. Atualize a prévia e tente novamente.");
    }
    if (Number(batch[1]?.meta?.changes ?? 0) !== allocations.length) {
      throw new ApiFailure(409, "Nem todos os valores estimados foram gravados. Atualize a base antes de continuar.");
    }
    const saved = await env.DB.prepare(
      "SELECT * FROM occupancy_aggregator_adjustments WHERE id=?",
    ).bind(input.adjustmentId).first<Row>();
    if (!saved) throw new ApiFailure(500, "O ajuste mensal não foi encontrado após salvar.");
    return json(SaveOccupancyMonthlyAggregatorAdjustmentResponse.parse(adjustmentOut(saved)));
  }

  const adjustmentId = /^\/occupancy\/monthly-aggregator-adjustments\/([0-9a-f-]{36})$/i.exec(path)?.[1];
  if (adjustmentId && request.method === "DELETE") {
    const { id } = parse(UndoOccupancyMonthlyAggregatorAdjustmentParams, { id: adjustmentId });
    const input = parse(UndoOccupancyMonthlyAggregatorAdjustmentBody, await readJson(request));
    const current = await env.DB.prepare(
      "SELECT * FROM occupancy_aggregator_adjustments WHERE id=? AND deleted_at IS NULL",
    ).bind(id).first<Row>();
    if (!current) throw new ApiFailure(404, "Ajuste mensal ativo não encontrado.");
    if (Number(current.version) !== input.expectedVersion) {
      throw new ApiFailure(409, "O ajuste foi atualizado. Atualize a base antes de desfazê-lo.");
    }
    const rows = await all<MonthlyAggregatorRecord>(
      env.DB.prepare(
        `SELECT * FROM occupancy_records
         WHERE aggregator_adjustment_id=? AND deleted_at IS NULL ORDER BY id`,
      ).bind(id),
    );
    const snapshots = rows.map((row) => ({
      id: String(row.id),
      version: Number(row.version),
      aggregatorPresences: row.aggregator_presences == null ? null : Number(row.aggregator_presences),
    }));
    const snapshotsJson = JSON.stringify(snapshots);
    const now = nowIso();
    const operationToken = crypto.randomUUID();
    const batch = await env.DB.batch([
      env.DB.prepare(
        `UPDATE occupancy_aggregator_adjustments
         SET deleted_by=?, deleted_at=?, updated_by=?, updated_at=?, operation_token=?, version=version+1
         WHERE id=? AND version=? AND deleted_at IS NULL
           AND (SELECT COUNT(*) FROM occupancy_records
                WHERE aggregator_adjustment_id=? AND deleted_at IS NULL)=?
           AND NOT EXISTS (
             SELECT 1 FROM json_each(?) snapshot
             LEFT JOIN occupancy_records r ON r.id=json_extract(snapshot.value, '$.id')
             WHERE r.id IS NULL OR r.deleted_at IS NOT NULL
               OR r.version IS NOT json_extract(snapshot.value, '$.version')
               OR r.aggregator_presences IS NOT json_extract(snapshot.value, '$.aggregatorPresences')
               OR r.aggregator_adjustment_id IS NOT ?
           )`,
      ).bind(actor.userId, now, actor.userId, now, operationToken, id, input.expectedVersion, id, snapshots.length, snapshotsJson, id),
      env.DB.prepare(
        `UPDATE occupancy_records
         SET aggregator_presences=NULL, aggregator_origin=NULL, aggregator_adjustment_id=NULL,
             version=version+1, updated_by=?, updated_at=?
         WHERE aggregator_adjustment_id=? AND version IN (
           SELECT json_extract(snapshot.value, '$.version') FROM json_each(?) snapshot
           WHERE json_extract(snapshot.value, '$.id')=occupancy_records.id
         )
           AND EXISTS (
             SELECT 1 FROM occupancy_aggregator_adjustments
             WHERE id=? AND operation_token=? AND deleted_at IS NOT NULL
           )`,
      ).bind(actor.userId, now, id, snapshotsJson, id, operationToken),
      env.DB.prepare(
        `INSERT INTO occupancy_history
          (id, entity_type, entity_id, operation, actor_id, before_data, after_data, created_at)
         SELECT json_extract(snapshot.value, '$.historyId'),
                'record', r.id, 'undo_monthly_aggregator_adjustment', ?,
                json_extract(snapshot.value, '$.beforeData'),
                json_object('id', r.id, 'aggregatorPresences', NULL,
                  'aggregatorSource', NULL, 'adjustmentId', NULL, 'version', r.version),
                ?
         FROM json_each(?) snapshot
         JOIN occupancy_records r ON r.id=json_extract(snapshot.value, '$.id')
         WHERE r.updated_at=? AND r.aggregator_adjustment_id IS NULL
           AND EXISTS (SELECT 1 FROM occupancy_aggregator_adjustments a
                       WHERE a.id=? AND a.operation_token=?)`,
      ).bind(
        actor.userId,
        now,
        JSON.stringify(rows.map((row) => ({
          id: String(row.id),
          historyId: crypto.randomUUID(),
          beforeData: JSON.stringify({
            id: row.id,
            aggregatorPresences: row.aggregator_presences,
            aggregatorSource: "monthly_estimated",
            adjustmentId: id,
          }),
        }))),
        now,
        id,
        operationToken,
      ),
      env.DB.prepare(
        `INSERT INTO occupancy_history
          (id, entity_type, entity_id, operation, actor_id, before_data, after_data, created_at)
         SELECT ?, 'aggregator_adjustment', id, 'undo', ?, ?, json_object(
           'id', id, 'month', month, 'scopeKey', scope_key, 'targetPresences', target_presences,
           'version', version, 'deletedAt', deleted_at), ?
         FROM occupancy_aggregator_adjustments WHERE id=? AND operation_token=?`,
      ).bind(crypto.randomUUID(), actor.userId, JSON.stringify(adjustmentOut(current)), now, id, operationToken),
    ]);
    if (Number(batch[0]?.meta?.changes ?? 0) !== 1) {
      throw new ApiFailure(409, "As aulas do ajuste mudaram durante a operação. Atualize a base e tente novamente.");
    }
    if (Number(batch[1]?.meta?.changes ?? 0) !== rows.length) {
      throw new ApiFailure(409, "Nem todas as estimativas foram desfeitas. Atualize a base antes de continuar.");
    }
    return new Response(null, { status: 204 });
  }
  return null;
}

async function listRecords(request: Request, env: WorkerEnv) {
  const url = new URL(request.url);
  const input = parse(GetOccupancyRecordsQueryParams, Object.fromEntries(url.searchParams));
  const records = await all(
    env.DB.prepare(
      `SELECT r.*, m.name AS modality_name
       FROM occupancy_records r
       JOIN occupancy_modalities m ON m.id=r.modality_id
       WHERE r.deleted_at IS NULL
       ORDER BY r.month DESC, r.date DESC, m.name ASC`,
    ),
  );
  if (
    (input.months !== undefined && (input.fromDate || input.toDate)) ||
    (input.fromDate !== undefined && input.year !== undefined) ||
    (input.fromDate !== undefined && input.quarter !== undefined)
  ) {
    throw new ApiFailure(400, "Escolha meses/ano/trimestre ou intervalo personalizado, não ambos.");
  }
  const months = input.months ? input.months.split(",").map((item) => item.trim()) : [];
  if (months.some((month) => !validMonth(month))) throw new ApiFailure(400, "Selecione meses válidos.");
  const fromDate = input.fromDate;
  const toDate = input.toDate;
  if (Boolean(fromDate) !== Boolean(toDate) || (fromDate && (!validDate(fromDate) || !validDate(toDate!) || fromDate > toDate!))) {
    throw new ApiFailure(400, "Informe um intervalo válido com início e fim.");
  }
  const startTimes = input.startTimes?.split(",").map((item) => item.trim()) ?? [];
  const weekdays = input.weekdays?.split(",").map(Number) ?? [];
  const matching = records.filter((row) => {
    const month = String(row.month);
    const date = row.date === null ? null : String(row.date);
    const kind = String(row.kind);
    if (months.length && !months.includes(month)) return false;
    if (input.year && Number(month.slice(0, 4)) !== input.year) return false;
    if (input.quarter && Math.ceil(Number(month.slice(5, 7)) / 3) !== input.quarter) return false;
    if (input.modalityId && row.modality_id !== input.modalityId) return false;
    if (input.kind && input.kind !== "all" && kind !== input.kind) return false;
    if (input.className !== undefined) {
      const scope = keyOf(input.className);
      if (row.scope_key !== scope && !String(row.scope_key).startsWith(`${scope}::`)) return false;
    }
    if (fromDate && toDate) {
      if (kind === "daily") {
        if (!date || date < fromDate || date > toDate) return false;
      } else {
        const lastDay = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0))
          .toISOString()
          .slice(0, 10);
        if (`${month}-01` < fromDate || lastDay > toDate) return false;
      }
    }
    if (startTimes.length || weekdays.length) {
      if (kind !== "daily" || !date) return false;
      if (startTimes.length && !startTimes.includes(String(row.start_time).slice(0, 5))) return false;
      if (weekdays.length) {
        const isoDay = getIsoWeekday(date);
        if (isoDay === null) return false;
        if (!weekdays.includes(isoDay)) return false;
      }
    }
    return true;
  });
  return json(GetOccupancyRecordsResponse.parse(matching.map(recordOut)));
}

async function findRecordBySource(
  db: D1Database,
  fileHash: string,
  sourceSheet: string,
  sourceCell: string,
) {
  return db
    .prepare(
      `SELECT r.*, m.name AS modality_name FROM occupancy_records r
       JOIN occupancy_modalities m ON m.id=r.modality_id
       WHERE r.source_file_hash=? AND r.source_sheet=? AND r.source_cell=?
         AND r.deleted_at IS NULL LIMIT 1`,
    )
    .bind(fileHash, sourceSheet, sourceCell)
    .first<Row>();
}

async function findScopeRecord(
  db: D1Database,
  modalityId: string,
  values: ReturnType<typeof recordValues>,
) {
  const rows = await all(
    db.prepare(
      `SELECT r.*, m.name AS modality_name FROM occupancy_records r
       JOIN occupancy_modalities m ON m.id=r.modality_id
       WHERE r.modality_id=? AND r.kind=? AND r.month=? AND r.deleted_at IS NULL`,
    ).bind(modalityId, values.kind, values.month),
  );
  return (
    rows.find(
      (row) =>
        (row.scope_key === values.scopeKey ||
          String(row.scope_key).startsWith(`${values.scopeKey}::`)) &&
        (values.kind === "daily" ? row.date === values.date : row.date === null) &&
        (row.start_time === null
          ? values.startTime === null
          : String(row.start_time).slice(0, 5) === values.startTime?.slice(0, 5)),
    ) ?? null
  );
}

async function previewOccupancyImport(request: Request, env: WorkerEnv): Promise<Response> {
  const input = parse(PreviewOccupancyImportBody, await readJson(request));
  const seenSources = new Set<string>();
  const rows = [];
  for (const entry of input.entries) {
    validateImportOrigin(entry);
    const values = recordValues(entry);
    const sourceKey = `${entry.sourceSheet}\u0000${entry.sourceCell}`;
    if (seenSources.has(sourceKey)) {
      rows.push({
        index: entry.index,
        status: "duplicate_in_file" as const,
        message: "Esta célula já aparece na prévia deste lote.",
        existingRecord: null,
      });
      continue;
    }
    seenSources.add(sourceKey);
    const sourceMatch = await findRecordBySource(
      env.DB,
      input.fileHash,
      entry.sourceSheet,
      entry.sourceCell,
    );
    if (sourceMatch) {
      const existing = recordOut(sourceMatch);
      const same = sameImportedRecord(existing, entry, values);
      rows.push({
        index: entry.index,
        status: same ? ("already_imported" as const) : ("conflict" as const),
        message: same
          ? "Esta célula deste arquivo já foi importada e não será duplicada."
          : "Esta célula já existe, mas os dados mudaram desde a importação anterior.",
        existingRecord: existing,
      });
      continue;
    }

    const modality = await env.DB
      .prepare("SELECT id FROM occupancy_modalities WHERE normalized_name=?")
      .bind(keyOf(entry.modalityName))
      .first<{ id: string }>();
    const scopeMatch = modality
      ? await findScopeRecord(env.DB, modality.id, values)
      : null;
    if (scopeMatch) {
      rows.push({
        index: entry.index,
        status: "conflict" as const,
        message:
          "Já existe um registro para esta modalidade, período, turma e horário. Confira a versão atual antes de autorizar a atualização.",
        existingRecord: recordOut(scopeMatch),
      });
    } else {
      rows.push({
        index: entry.index,
        status: "new" as const,
        message: "Novo registro. Ainda não foi gravado.",
        existingRecord: null,
      });
    }
  }
  return json(PreviewOccupancyImportResponse.parse({ rows }));
}

async function commitOccupancyImport(
  request: Request,
  env: WorkerEnv,
  actor: AuthContext,
): Promise<Response> {
  const input = parse(CommitOccupancyImportBody, await readJson(request));
  const output: Array<{
    index: number;
    status: "inserted" | "updated" | "already_imported" | "conflict" | "duplicate_in_batch";
    id: string | null;
    message: string;
  }> = [];
  const seenSources = new Set<string>();
  const seenNatural = new Set<string>();
  let inserted = 0;
  let updated = 0;
  let alreadyImported = 0;
  let conflicts = 0;

  for (const item of input.entries) {
    const entry = item.record;
    validateImportOrigin(entry);
    const values = recordValues(entry);
    const sourceKey = `${entry.sourceSheet}\u0000${entry.sourceCell}`;
    const naturalKey = [
      keyOf(entry.modalityName),
      entry.kind,
      values.month,
      values.date ?? "",
      values.scopeKey,
      values.startTime ?? "",
    ].join("\u0000");
    const duplicateNatural = seenNatural.has(naturalKey);
    if (seenSources.has(sourceKey) || (duplicateNatural && !item.keepBothConfirmed)) {
      output.push({
        index: entry.index,
        status: "duplicate_in_batch",
        id: null,
        message: "Escopo ou célula repetidos neste lote; nenhum dado foi somado.",
      });
      conflicts += 1;
      continue;
    }
    seenSources.add(sourceKey);
    if (!duplicateNatural || item.keepBothConfirmed) seenNatural.add(naturalKey);

    const sourceMatch = await findRecordBySource(
      env.DB,
      input.fileHash,
      entry.sourceSheet,
      entry.sourceCell,
    );
    if (sourceMatch) {
      const existing = recordOut(sourceMatch);
      const same = sameImportedRecord(existing, entry, values);
      if (same) {
        output.push({
          index: entry.index,
          status: "already_imported",
          id: existing.id,
          message: "Já importado; mantido sem duplicação.",
        });
        alreadyImported += 1;
        continue;
      }
      if (item.keepBothConfirmed) {
        output.push({
          index: entry.index,
          status: "conflict",
          id: existing.id,
          message: "Esta célula já foi importada com outros dados. Atualize o registro em vez de manter ambos.",
        });
        conflicts += 1;
        continue;
      }
      if (
        item.existingRecordId !== existing.id ||
        item.expectedVersion !== Number(sourceMatch.version)
      ) {
        output.push({
          index: entry.index,
          status: "conflict",
          id: existing.id,
          message: "A origem já existe com dados diferentes. Confirme a versão exibida na prévia.",
        });
        conflicts += 1;
        continue;
      }
    }

    const explicitUpdate =
      Boolean(item.existingRecordId) || item.expectedVersion !== undefined;
    if (explicitUpdate && !item.keepBothConfirmed) {
      if (!item.existingRecordId || item.expectedVersion === undefined) {
        output.push({
          index: entry.index,
          status: "conflict",
          id: null,
          message: "A atualização exige o registro e a versão exibidos na prévia.",
        });
        conflicts += 1;
        continue;
      }
      const target = await env.DB
        .prepare(
          `SELECT r.*, m.name AS modality_name FROM occupancy_records r
           JOIN occupancy_modalities m ON m.id=r.modality_id
           WHERE r.id=? AND r.deleted_at IS NULL`,
        )
        .bind(item.existingRecordId)
        .first<Row>();
      const sameScope =
        target &&
        keyOf(String(target.modality_name)) === keyOf(entry.modalityName) &&
        target.kind === entry.kind &&
        target.month === values.month &&
        target.date === values.date &&
        (target.scope_key === values.scopeKey ||
          String(target.scope_key).startsWith(`${values.scopeKey}::`)) &&
        (target.start_time === null
          ? values.startTime === null
          : String(target.start_time).slice(0, 5) === values.startTime?.slice(0, 5));
      const sameSource =
        target &&
        target.source_file_hash === input.fileHash &&
        target.source_sheet === entry.sourceSheet &&
        target.source_cell === entry.sourceCell;
      if (
        !target ||
        Number(target.version) !== item.expectedVersion ||
        (!sameScope && !sameSource)
      ) {
        output.push({
          index: entry.index,
          status: "conflict",
          id: target ? String(target.id) : null,
          message: "O registro mudou desde a prévia ou não corresponde a este conflito.",
        });
        conflicts += 1;
        continue;
      }
      const modality = await resolveModality(env.DB, actor.userId, entry.modalityId, entry.modalityName);
      const now = nowIso();
      const result = await env.DB.batch([
        env.DB.prepare(
          `UPDATE occupancy_records SET modality_id=?, kind=?, date=?, month=?, percentage=?,
             reported_percentage=?, presences=?, capacity=?, aggregator_presences=?, aggregator_origin=NULL,
             aggregator_adjustment_id=NULL, start_time=?, end_time=?, class_name=?,
             scope_key=?, notes=?, source_file_hash=?, source_sheet=?, source_cell=?, source_cells=?,
             version=version+1, updated_by=?, updated_at=?
           WHERE id=? AND version=? AND deleted_at IS NULL`,
        ).bind(
          modality.id,
          values.kind,
          values.date,
          values.month,
          values.percentage,
          values.reportedPercentage,
          values.presences,
          values.capacity,
          values.aggregatorPresences,
          values.startTime,
          values.endTime,
          values.className,
          values.scopeKey,
          values.notes,
          input.fileHash,
          entry.sourceSheet,
          entry.sourceCell,
          JSON.stringify(entry.sourceCells),
          actor.userId,
          now,
          String(target.id),
          item.expectedVersion,
        ),
        env.DB.prepare(
          `INSERT INTO occupancy_history
            (id, entity_type, entity_id, operation, actor_id, before_data, after_data, created_at)
           SELECT ?, 'record', id, 'import_update', ?, ?, json_object('id', id, 'kind', kind,
             'date', date, 'month', month, 'modalityId', modality_id, 'percentage', percentage,
             'version', version, 'updatedAt', updated_at), ?
           FROM occupancy_records WHERE id=? AND version=? AND updated_at=? AND deleted_at IS NULL`,
        ).bind(
          crypto.randomUUID(),
          actor.userId,
          JSON.stringify(target),
          now,
          String(target.id),
          item.expectedVersion + 1,
          now,
        ),
      ]);
      if (Number(result[0]?.meta?.changes ?? 0) !== 1) {
        output.push({
          index: entry.index,
          status: "conflict",
          id: String(target.id),
          message: "O registro mudou durante a atualização; nenhuma alteração foi aplicada.",
        });
        conflicts += 1;
        continue;
      }
      output.push({
        index: entry.index,
        status: "updated",
        id: String(target.id),
        message: "Registro atualizado com a versão conferida.",
      });
      updated += 1;
      continue;
    }

    const modality = await resolveModality(env.DB, actor.userId, entry.modalityId, entry.modalityName);
    const scopeMatch = await findScopeRecord(env.DB, modality.id, values);
    if (scopeMatch && !item.keepBothConfirmed) {
      output.push({
        index: entry.index,
        status: "conflict",
        id: String(scopeMatch.id),
        message: "Já existe um registro neste escopo. Confirme a versão para atualizar ou selecione Manter ambos.",
      });
      conflicts += 1;
      continue;
    }
    if (
      scopeMatch &&
      item.keepBothConfirmed &&
      item.existingRecordId &&
      (item.expectedVersion === undefined ||
        item.existingRecordId !== String(scopeMatch.id) ||
        item.expectedVersion !== Number(scopeMatch.version))
    ) {
      output.push({
        index: entry.index,
        status: "conflict",
        id: String(scopeMatch.id),
        message: "O registro comparado mudou desde a prévia.",
      });
      conflicts += 1;
      continue;
    }

    const id = crypto.randomUUID();
    const now = nowIso();
    const scopeKey = scopeMatch
      ? `${values.scopeKey}::import:${input.fileHash.slice(0, 20)}:${encodeURIComponent(entry.sourceSheet)}:${entry.sourceCell}`
      : values.scopeKey;
    try {
      const result = await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO occupancy_records
            (id, modality_id, kind, date, month, percentage, reported_percentage, presences,
             capacity, aggregator_presences, start_time, end_time, class_name, scope_key, notes, source_file_hash,
             source_sheet, source_cell, source_cells, version, created_by, updated_by,
             created_at, updated_at, deleted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, NULL)`,
        ).bind(
          id,
          modality.id,
          values.kind,
          values.date,
          values.month,
          values.percentage,
          values.reportedPercentage,
          values.presences,
          values.capacity,
          values.aggregatorPresences,
          values.startTime,
          values.endTime,
          values.className,
          scopeKey,
          values.notes,
          input.fileHash,
          entry.sourceSheet,
          entry.sourceCell,
          JSON.stringify(entry.sourceCells),
          actor.userId,
          actor.userId,
          now,
          now,
        ),
        env.DB.prepare(
          `INSERT INTO occupancy_history
            (id, entity_type, entity_id, operation, actor_id, before_data, after_data, created_at)
           SELECT ?, 'record', id, 'import', ?, NULL, json_object('id', id, 'kind', kind,
             'date', date, 'month', month, 'modalityId', modality_id, 'percentage', percentage,
             'version', version, 'updatedAt', updated_at), ?
           FROM occupancy_records WHERE id=?`,
        ).bind(crypto.randomUUID(), actor.userId, now, id),
      ]);
      if (Number(result[0]?.meta?.changes ?? 0) !== 1) throw new Error("Import insert was not applied.");
      output.push({
        index: entry.index,
        status: "inserted",
        id,
        message: scopeMatch ? "Registro adicional salvo no escopo confirmado." : "Novo registro salvo.",
      });
      inserted += 1;
    } catch {
      output.push({
        index: entry.index,
        status: "conflict",
        id: null,
        message: "A gravação conflitou com outra importação ou com os dados atuais.",
      });
      conflicts += 1;
    }
  }

  return json(
    CommitOccupancyImportResponse.parse({
      rows: output,
      inserted,
      updated,
      alreadyImported,
      conflicts,
    }),
  );
}

type OccupancyBackupSelection = {
  mode: "months" | "quarter" | "range" | "all";
  months?: string[];
  year?: number;
  quarter?: number;
  fromDate?: string;
  toDate?: string;
  modalityId?: string | null;
  startTimes?: string[];
  weekdays?: number[];
  className?: string | null;
};

async function allOccupancyRecords(env: WorkerEnv) {
  return all(
    env.DB.prepare(
      `SELECT r.*, m.name AS modality_name FROM occupancy_records r
       JOIN occupancy_modalities m ON m.id=r.modality_id
       WHERE r.deleted_at IS NULL ORDER BY r.month, r.date, m.normalized_name`,
    ),
  );
}

function backupMatches(row: Row, selection: OccupancyBackupSelection) {
  const month = String(row.month);
  const kind = String(row.kind);
  const date = row.date === null ? null : String(row.date);
  if (selection.mode === "months" && !selection.months?.includes(month)) return false;
  if (
    selection.mode === "quarter" &&
    (Number(month.slice(0, 4)) !== selection.year ||
      Math.ceil(Number(month.slice(5, 7)) / 3) !== selection.quarter)
  ) {
    return false;
  }
  if (selection.modalityId && row.modality_id !== selection.modalityId) return false;
  if (selection.className) {
    const base = keyOf(selection.className);
    if (row.scope_key !== base && !String(row.scope_key).startsWith(`${base}::`)) return false;
  }
  if (selection.mode === "range") {
    if (!selection.fromDate || !selection.toDate) return false;
    if (kind === "daily") {
      if (!date || date < selection.fromDate || date > selection.toDate) return false;
    } else {
      const [year, monthNumber] = month.split("-").map(Number);
      const monthEnd = new Date(Date.UTC(year!, monthNumber!, 0)).toISOString().slice(0, 10);
      if (`${month}-01` < selection.fromDate || monthEnd > selection.toDate) return false;
    }
  }
  if (selection.startTimes?.length || selection.weekdays?.length) {
    if (kind !== "daily" || !date) return false;
    if (
      selection.startTimes?.length &&
      !selection.startTimes.includes(String(row.start_time).slice(0, 5))
    ) {
      return false;
    }
    if (selection.weekdays?.length) {
      const weekday = getIsoWeekday(date);
      if (weekday === null) return false;
      if (!selection.weekdays.includes(weekday)) return false;
    }
  }
  return true;
}

function completeMonthsInRange(fromDate: string, toDate: string): string[] {
  const months: string[] = [];
  let [year, month] = fromDate.slice(0, 7).split("-").map(Number);
  const [endYear, endMonth] = toDate.slice(0, 7).split("-").map(Number);
  while (year! < endYear! || (year === endYear && month! <= endMonth!)) {
    const key = `${year}-${String(month).padStart(2, "0")}`;
    const monthEnd = new Date(Date.UTC(year!, month!, 0)).toISOString().slice(0, 10);
    if (`${key}-01` >= fromDate && monthEnd <= toDate) months.push(key);
    month! += 1;
    if (month === 13) {
      year! += 1;
      month = 1;
    }
  }
  return months;
}

async function selectedOccupancyBackupRows(
  env: WorkerEnv,
  selection: OccupancyBackupSelection,
): Promise<Row[]> {
  const clauses = ["r.deleted_at IS NULL"];
  const values: unknown[] = [];
  if (selection.mode === "months" && selection.months?.length) {
    clauses.push(`r.month IN (${selection.months.map(() => "?").join(",")})`);
    values.push(...selection.months);
  } else if (selection.mode === "quarter" && selection.year && selection.quarter) {
    const firstMonth = (selection.quarter - 1) * 3 + 1;
    const lastMonth = firstMonth + 2;
    clauses.push("r.month BETWEEN ? AND ?");
    values.push(
      `${selection.year}-${String(firstMonth).padStart(2, "0")}`,
      `${selection.year}-${String(lastMonth).padStart(2, "0")}`,
    );
  } else if (selection.mode === "range" && selection.fromDate && selection.toDate) {
    const fullMonths = completeMonthsInRange(selection.fromDate, selection.toDate);
    const monthlyClause = fullMonths.length
      ? ` OR (r.kind = 'monthly' AND r.month IN (${fullMonths.map(() => "?").join(",")}))`
      : "";
    clauses.push(`((r.kind = 'daily' AND r.date BETWEEN ? AND ?)${monthlyClause})`);
    values.push(selection.fromDate, selection.toDate, ...fullMonths);
  }

  if (selection.modalityId) {
    clauses.push("r.modality_id = ?");
    values.push(selection.modalityId);
  }
  if (selection.className) {
    const scope = keyOf(selection.className);
    clauses.push("(r.scope_key = ? OR substr(r.scope_key, 1, length(? || '::restore:')) = ? || '::restore:')");
    values.push(scope, scope, scope);
  }
  if (selection.startTimes?.length || selection.weekdays?.length) {
    clauses.push("r.kind = 'daily'");
  }
  if (selection.startTimes?.length) {
    clauses.push(`substr(r.start_time, 1, 5) IN (${selection.startTimes.map(() => "?").join(",")})`);
    values.push(...selection.startTimes);
  }
  if (selection.weekdays?.length) {
    const sqliteWeekdays = selection.weekdays.map((weekday) => weekday === 7 ? 0 : weekday);
    clauses.push(`CAST(strftime('%w', r.date) AS INTEGER) IN (${sqliteWeekdays.map(() => "?").join(",")})`);
    values.push(...sqliteWeekdays);
  }

  let statement = env.DB.prepare(
    `SELECT r.*, m.name AS modality_name FROM occupancy_records r
     JOIN occupancy_modalities m ON m.id=r.modality_id
     WHERE ${clauses.join(" AND ")}
     ORDER BY r.month, r.date, m.normalized_name LIMIT 50001`,
  );
  if (values.length) statement = statement.bind(...values);
  const rows = await all(statement);
  return rows.filter((row) => backupMatches(row, selection));
}

function effectiveOccupancyRows(records: Row[]): Row[] {
  const groups = new Map<string, { daily: Row[]; monthly: Row[] }>();
  for (const record of records) {
    const scope = JSON.stringify([
      record.month,
      record.modality_id,
      keyOf(record.class_name === null || record.class_name === undefined ? "" : String(record.class_name)),
    ]);
    const group = groups.get(scope) ?? { daily: [], monthly: [] };
    group[String(record.kind) === "monthly" ? "monthly" : "daily"].push(record);
    groups.set(scope, group);
  }

  const effective: Row[] = [];
  for (const { daily, monthly } of groups.values()) {
    const monthlyMeasured = monthly.filter((record) => record.presences !== null && record.capacity !== null);
    const monthlyLegacy = monthly.filter((record) => record.presences === null || record.capacity === null);
    const dailyMeasured = daily.filter((record) => record.presences !== null && record.capacity !== null);
    const dailyLegacy = daily.filter((record) => record.presences === null || record.capacity === null);
    effective.push(...(monthlyMeasured.length ? monthlyMeasured : dailyMeasured));
    effective.push(...(monthlyLegacy.length ? monthlyLegacy : dailyLegacy));
  }
  return effective;
}

function occupancyPeriodLabel(selection: OccupancyBackupSelection) {
  if (selection.mode === "all") return "Todos os períodos";
  if (selection.mode === "months") return (selection.months ?? []).join(", ");
  if (selection.mode === "quarter") return `${selection.year} — ${selection.quarter}º trimestre`;
  return `${selection.fromDate ?? ""} a ${selection.toDate ?? ""}`;
}

async function createOccupancyBackup(
  request: Request,
  env: WorkerEnv,
): Promise<Response> {
  const input = parse(CreateOccupancyBackupBody, await readJson(request));
  if (
    (input.mode === "months" &&
      (!input.months?.length || new Set(input.months).size !== input.months.length || input.year || input.quarter)) ||
    (input.mode === "quarter" && (!input.year || !input.quarter || input.months)) ||
    (input.mode === "range" &&
      (!input.fromDate || !input.toDate || !validDate(input.fromDate) || !validDate(input.toDate) ||
        input.fromDate > input.toDate || input.months || input.year || input.quarter)) ||
    (input.mode === "all" && (input.months || input.year || input.quarter || input.fromDate || input.toDate))
  ) {
    throw new ApiFailure(400, "A seleção do backup de ocupação é inválida.");
  }
  const records = await selectedOccupancyBackupRows(env, input);
  if (records.length > 50000) throw new ApiFailure(413, "O backup excede o limite de registros.");
  const usedModalityIds = new Set(records.map((row) => String(row.modality_id)));
  const modalities = await all(
    env.DB.prepare("SELECT id, name, version FROM occupancy_modalities ORDER BY normalized_name"),
  );
  const selectedModalities = modalities.filter((row) => usedModalityIds.has(String(row.id)));
  const effectiveRecords = effectiveOccupancyRows(records);
  const measured = effectiveRecords.filter((row) => row.presences !== null && row.capacity !== null);
  const presences = measured.reduce((sum, row) => sum + Number(row.presences), 0);
  const capacity = measured.reduce((sum, row) => sum + Number(row.capacity), 0);
  const selection = {
    mode: input.mode,
    ...(input.months ? { months: input.months } : {}),
    ...(input.year !== undefined ? { year: input.year } : {}),
    ...(input.quarter !== undefined ? { quarter: input.quarter } : {}),
    ...(input.fromDate ? { fromDate: input.fromDate } : {}),
    ...(input.toDate ? { toDate: input.toDate } : {}),
    ...(input.modalityId !== undefined ? { modalityId: input.modalityId } : {}),
    ...(input.startTimes ? { startTimes: input.startTimes } : {}),
    ...(input.weekdays ? { weekdays: input.weekdays } : {}),
    ...(input.className !== undefined ? { className: input.className } : {}),
  };
  const backup = {
    format: "zero3-pro-occupancy-backup",
    schemaVersion: 1,
    module: "occupancy",
    origin: "zero3-pro-occupancy-database",
    generatedAt: nowIso(),
    period: occupancyPeriodLabel(input),
    selection,
    partial: input.mode !== "all" || Boolean(input.modalityId || input.className || input.startTimes?.length || input.weekdays?.length),
    counts: {
      records: records.length,
      dailyRecords: records.filter((row) => row.kind === "daily").length,
      monthlyRecords: records.filter((row) => row.kind === "monthly").length,
      modalities: selectedModalities.length,
      totalRecords: records.length,
    },
    summary: {
      measuredRecords: measured.length,
      legacyRecords: effectiveRecords.length - measured.length,
      presences,
      capacity,
      weightedPercentage: capacity ? Number(((presences / capacity) * 100).toFixed(6)) : null,
    },
    modalities: selectedModalities.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      version: Number(row.version),
    })),
    records: records.map((row) => ({
      scope: "period" as const,
      scopeKey: String(row.scope_key),
      record: recordOut(row),
    })),
  };
  if (new TextEncoder().encode(JSON.stringify(backup)).byteLength > 8 * 1024 * 1024) {
    throw new ApiFailure(413, "O arquivo de backup excede 8 MB.");
  }
  return json(CreateOccupancyBackupResponse.parse(backup));
}

type BackupOccupancy = {
  id: string;
  kind: string;
  period: string;
  month: string;
  modalityId: string;
  modalityName: string;
  percentage: number;
  reportedPercentage: number | null;
  presences: number | null;
  capacity: number | null;
  aggregatorPresences?: number | null;
  startTime: string | null;
  endTime: string | null;
  className: string | null;
  notes: string | null;
  sourceFileHash: string | null;
  sourceSheet: string | null;
  sourceCell: string | null;
  sourceCells: Record<string, string> | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

function backupRecordFromRow(row: BackupOccupancy, scopeKey: string): Row {
  return {
    id: row.id,
    kind: row.kind,
    date: row.kind === "daily" ? row.period : null,
    month: row.month,
    modality_id: row.modalityId,
    modality_name: row.modalityName,
    percentage: String(row.percentage),
    reported_percentage: row.reportedPercentage === null ? null : String(row.reportedPercentage),
    presences: row.presences,
    capacity: row.capacity,
    aggregatorPresences: row.aggregatorPresences ?? null,
    start_time: row.startTime ? `${row.startTime}:00` : null,
    end_time: row.endTime ? `${row.endTime}:00` : null,
    class_name: row.className,
    scope_key: scopeKey,
    notes: row.notes,
    source_file_hash: row.sourceFileHash,
    source_sheet: row.sourceSheet,
    source_cell: row.sourceCell,
    source_cells: row.sourceCells ? JSON.stringify(row.sourceCells) : null,
    version: row.version,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

function backupRecordMatches(existing: Row, backup: BackupOccupancy, backupScope: string) {
  const current = recordOut(existing);
  return (
    current.kind === backup.kind &&
    current.period === backup.period &&
    keyOf(current.modalityName) === keyOf(backup.modalityName) &&
    current.percentage === backup.percentage &&
    current.reportedPercentage === backup.reportedPercentage &&
    current.presences === backup.presences &&
    current.capacity === backup.capacity &&
    current.aggregatorPresences === (backup.aggregatorPresences ?? null) &&
    current.startTime === backup.startTime &&
    current.endTime === backup.endTime &&
    keyOf(current.className ?? "") === keyOf(backup.className ?? "") &&
    String(existing.scope_key) === backupScope
  );
}

async function previewOccupancyBackup(
  request: Request,
  env: WorkerEnv,
): Promise<Response> {
  const input = parse(PreviewOccupancyBackupRestoreBody, await readJson(request));
  const existingRecords = await allOccupancyRecords(env);
  const existingModalities = await all(
    env.DB.prepare("SELECT id, name, normalized_name FROM occupancy_modalities"),
  );
  const conflicts: Array<{
    entityType: "record" | "modality";
    backupId: string;
    existingId: string;
    conflictKind: "id" | "natural-key" | "source";
    reason: string;
    options: Array<"ignore" | "update" | "keep-both">;
  }> = [];
  let recordsToInsert = 0;
  let recordsIdentical = 0;
  const modalityDependencies = new Set<string>();
  for (const modality of input.backup.modalities) {
    const byId = existingModalities.find((item) => item.id === modality.id);
    const byName = existingModalities.find(
      (item) => item.normalized_name === keyOf(modality.name),
    );
    if (!byId && !byName) {
      modalityDependencies.add(modality.id);
    } else if (
      (byId && keyOf(String(byId.name)) !== keyOf(modality.name)) ||
      (!byId && byName && byName.id !== modality.id)
    ) {
      const existing = byId ?? byName!;
      conflicts.push({
        entityType: "modality",
        backupId: modality.id,
        existingId: String(existing.id),
        conflictKind: "id",
        reason: "A modalidade já existe com outro ID ou outro nome.",
        options: ["ignore", "update"],
      });
    }
  }
  for (const item of input.backup.records) {
    const backup = item.record as BackupOccupancy;
    const idMatch = existingRecords.find((row) => row.id === backup.id);
    const sourceMatch = backup.sourceFileHash && backup.sourceSheet && backup.sourceCell
      ? existingRecords.find((row) =>
          row.source_file_hash === backup.sourceFileHash &&
          row.source_sheet === backup.sourceSheet &&
          row.source_cell === backup.sourceCell)
      : undefined;
    const modality = existingModalities.find(
      (row) =>
        row.id === backup.modalityId ||
        row.normalized_name === keyOf(backup.modalityName),
    );
    const naturalMatch = modality
      ? existingRecords.find((row) =>
          row.modality_id === modality.id &&
          row.kind === backup.kind &&
          row.month === backup.month &&
          (row.kind === "daily" ? row.date === backup.period : row.date === null) &&
          (row.scope_key === item.scopeKey ||
            String(row.scope_key).startsWith(`${item.scopeKey}::`)) &&
          (row.start_time === null
            ? backup.startTime === null
            : String(row.start_time).slice(0, 5) === backup.startTime))
      : undefined;
    const conflict = idMatch ?? sourceMatch ?? naturalMatch;
    if (!conflict) {
      recordsToInsert += 1;
      continue;
    }
    if (idMatch && backupRecordMatches(idMatch, backup, item.scopeKey)) {
      recordsIdentical += 1;
      continue;
    }
    conflicts.push({
      entityType: "record",
      backupId: backup.id,
      existingId: String(conflict.id),
      conflictKind: idMatch ? "id" : sourceMatch ? "source" : "natural-key",
      reason: "O registro do backup conflita com dados já existentes.",
      options: ["ignore", "update", "keep-both"],
    });
  }
  return json(
    PreviewOccupancyBackupRestoreResponse.parse({
      period: input.backup.period,
      counts: {
        recordsToInsert,
        recordsIdentical,
        modalityDependencies: modalityDependencies.size,
        conflicts: conflicts.length,
      },
      conflicts,
    }),
  );
}

async function restoreOccupancyBackup(
  request: Request,
  env: WorkerEnv,
  actor: AuthContext,
): Promise<Response> {
  const input = parse(RestoreOccupancyBackupBody, await readJson(request));
  const backup = input.backup;
  const preview = await previewOccupancyBackup(
    new Request("https://worker.local/api/occupancy/backup/restore/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ backup }),
    }),
    env,
  );
  const previewData = (await preview.json()) as {
    period: string;
    conflicts: Array<{ entityType: "record" | "modality"; backupId: string }>;
  };
  const actionMap = new Map(
    input.actions.map((item) => [`${item.entityType}:${item.backupId}`, item.action]),
  );
  for (const conflict of previewData.conflicts) {
    if (!actionMap.has(`${conflict.entityType}:${conflict.backupId}`)) {
      throw new ApiFailure(409, "A prévia encontrou conflitos. Confirme uma ação para cada um antes de restaurar.");
    }
  }

  let insertedModalities = 0;
  let insertedRecords = 0;
  let updatedRecords = 0;
  let identicalRecords = 0;
  let ignoredRecords = 0;
  let keptDistinct = 0;
  const modalityMap = new Map<string, string>();
  const existingModalities = await all(
    env.DB.prepare("SELECT * FROM occupancy_modalities"),
  );
  for (const modality of backup.modalities) {
    const byId = existingModalities.find((row) => row.id === modality.id);
    const byName = existingModalities.find(
      (row) => row.normalized_name === keyOf(modality.name),
    );
    const conflict = byId ?? byName;
    const action = actionMap.get(`modality:${modality.id}`);
    if (conflict) {
      if (keyOf(String(conflict.name)) === keyOf(modality.name)) {
        modalityMap.set(modality.id, String(conflict.id));
        continue;
      }
      if (action === "ignore") {
        modalityMap.set(modality.id, String(conflict.id));
        continue;
      }
      if (action === "update") {
        const now = nowIso();
        const result = await env.DB
          .prepare(
            `UPDATE occupancy_modalities SET name=?, normalized_name=?, version=version+1, updated_at=?
             WHERE id=?`,
          )
          .bind(cleanText(modality.name), keyOf(modality.name), now, conflict.id)
          .run();
        if (Number(result.meta?.changes ?? 0) !== 1) {
          throw new ApiFailure(409, "A modalidade mudou durante a restauração.");
        }
        modalityMap.set(modality.id, String(conflict.id));
        continue;
      }
      throw new ApiFailure(409, "A restauração encontrou conflito de modalidade.");
    }
    const now = nowIso();
    const result = await env.DB
      .prepare(
        `INSERT INTO occupancy_modalities (id, name, normalized_name, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(modality.id, cleanText(modality.name), keyOf(modality.name), modality.version, now, now)
      .run();
    if (Number(result.meta?.changes ?? 0) === 1) {
      insertedModalities += 1;
      modalityMap.set(modality.id, modality.id);
    }
  }

  const currentRecords = await allOccupancyRecords(env);
  for (const item of backup.records) {
    const record = item.record as BackupOccupancy;
    const modalityId = modalityMap.get(record.modalityId);
    if (!modalityId) {
      ignoredRecords += 1;
      continue;
    }
    const idMatch = currentRecords.find((row) => row.id === record.id);
    const sourceMatch = record.sourceFileHash && record.sourceSheet && record.sourceCell
      ? currentRecords.find((row) =>
          row.source_file_hash === record.sourceFileHash &&
          row.source_sheet === record.sourceSheet &&
          row.source_cell === record.sourceCell)
      : undefined;
    const scopeValues = {
      kind: record.kind,
      month: record.month,
      date: record.kind === "daily" ? record.period : null,
      scopeKey: item.scopeKey,
      startTime: record.startTime ? `${record.startTime}:00` : null,
    };
    const scopeMatch = currentRecords.find((row) =>
      row.modality_id === modalityId &&
      row.kind === record.kind &&
      row.month === record.month &&
      (record.kind === "daily" ? row.date === record.period : row.date === null) &&
      (row.scope_key === item.scopeKey ||
        String(row.scope_key).startsWith(`${item.scopeKey}::`)) &&
      (row.start_time === null
        ? record.startTime === null
        : String(row.start_time).slice(0, 5) === record.startTime));
    const existing = idMatch ?? sourceMatch ?? scopeMatch;
    if (idMatch && backupRecordMatches(idMatch, record, item.scopeKey)) {
      identicalRecords += 1;
      continue;
    }
    const action = actionMap.get(`record:${record.id}`);
    if (existing && !action) {
      throw new ApiFailure(409, "Os dados mudaram desde a prévia; faça uma nova conferência.");
    }
    if (existing && action === "ignore") {
      ignoredRecords += 1;
      continue;
    }
    if (existing && action === "update") {
      const now = nowIso();
      const result = await env.DB.batch([
        env.DB.prepare(
          `UPDATE occupancy_records SET modality_id=?, kind=?, date=?, month=?, percentage=?,
             reported_percentage=?, presences=?, capacity=?, aggregator_presences=?, aggregator_origin=NULL,
             aggregator_adjustment_id=NULL, start_time=?, end_time=?, class_name=?,
             scope_key=?, notes=?, source_file_hash=?, source_sheet=?, source_cell=?, source_cells=?,
             version=version+1, updated_by=?, updated_at=?
           WHERE id=? AND deleted_at IS NULL`,
        ).bind(
          modalityId,
          record.kind,
          record.kind === "daily" ? record.period : null,
          record.month,
          String(record.percentage),
          record.reportedPercentage === null ? null : String(record.reportedPercentage),
          record.presences,
          record.capacity,
          record.aggregatorPresences ?? null,
          record.startTime ? `${record.startTime}:00` : null,
          record.endTime ? `${record.endTime}:00` : null,
          record.className,
          item.scopeKey,
          record.notes,
          record.sourceFileHash,
          record.sourceSheet,
          record.sourceCell,
          record.sourceCells ? JSON.stringify(record.sourceCells) : null,
          actor.userId,
          now,
          existing.id,
        ),
        env.DB.prepare(
          `INSERT INTO occupancy_history
            (id, entity_type, entity_id, operation, actor_id, before_data, after_data, created_at)
           SELECT ?, 'record', id, 'restore_update', ?, ?, json_object('id', id,
             'modalityId', modality_id, 'kind', kind, 'date', date, 'month', month,
             'version', version, 'updatedAt', updated_at), ?
           FROM occupancy_records WHERE id=? AND updated_at=?`,
        ).bind(crypto.randomUUID(), actor.userId, JSON.stringify(existing), now, existing.id, now),
      ]);
      if (Number(result[0]?.meta?.changes ?? 0) !== 1) {
        throw new ApiFailure(409, "O registro mudou durante a restauração.");
      }
      updatedRecords += 1;
      continue;
    }
    const keepBoth = Boolean(existing && action === "keep-both");
    const scopeKey = keepBoth
      ? `${item.scopeKey}::restore:${backup.generatedAt.toISOString().replace(/[^0-9]/g, "").slice(0, 14)}:${record.id.slice(0, 8)}`
      : item.scopeKey;
    const now = nowIso();
    try {
      const result = await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO occupancy_records
            (id, modality_id, kind, date, month, percentage, reported_percentage, presences,
             capacity, aggregator_presences, start_time, end_time, class_name, scope_key, notes, source_file_hash,
             source_sheet, source_cell, source_cells, version, created_by, updated_by,
             created_at, updated_at, deleted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, NULL)`,
        ).bind(
          keepBoth ? crypto.randomUUID() : record.id,
          modalityId,
          record.kind,
          record.kind === "daily" ? record.period : null,
          record.month,
          String(record.percentage),
          record.reportedPercentage === null ? null : String(record.reportedPercentage),
          record.presences,
          record.capacity,
          record.aggregatorPresences ?? null,
          record.startTime ? `${record.startTime}:00` : null,
          record.endTime ? `${record.endTime}:00` : null,
          record.className,
          scopeKey,
          record.notes,
          record.sourceFileHash,
          record.sourceSheet,
          record.sourceCell,
          record.sourceCells ? JSON.stringify(record.sourceCells) : null,
          actor.userId,
          actor.userId,
          now,
          now,
        ),
        env.DB.prepare(
          `INSERT INTO occupancy_history
            (id, entity_type, entity_id, operation, actor_id, before_data, after_data, created_at)
           SELECT ?, 'record', id, 'restore', ?, NULL, json_object('id', id,
             'modalityId', modality_id, 'kind', kind, 'date', date, 'month', month,
             'version', version, 'updatedAt', updated_at), ?
           FROM occupancy_records WHERE id=?`,
        ).bind(
          crypto.randomUUID(),
          actor.userId,
          now,
          keepBoth ? "00000000-0000-4000-8000-000000000000" : record.id,
        ),
      ]);
      if (Number(result[0]?.meta?.changes ?? 0) !== 1) {
        throw new ApiFailure(409, "Um registro do backup já existe.");
      }
      insertedRecords += keepBoth ? 0 : 1;
      keptDistinct += keepBoth ? 1 : 0;
    } catch (error) {
      if (error instanceof ApiFailure) throw error;
      throw new ApiFailure(409, "A restauração encontrou um registro duplicado ou incompatível.");
    }
    void scopeValues;
  }
  return json(
    RestoreOccupancyBackupResponse.parse({
      period: backup.period,
      insertedRecords,
      updatedRecords,
      identicalRecords,
      ignoredRecords,
      keptDistinct,
      insertedModalities,
    }),
  );
}

async function restoreOccupancyBackupAtomic(
  request: Request,
  env: WorkerEnv,
  actor: AuthContext,
): Promise<Response> {
  const input = parse(RestoreOccupancyBackupBody, await readJson(request));
  const backup = input.backup;
  const previewResponse = await previewOccupancyBackup(
    new Request("https://worker.local/api/occupancy/backup/restore/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ backup }),
    }),
    env,
  );
  const preview = (await previewResponse.json()) as {
    period: string;
    counts: {
      recordsToInsert: number;
      recordsIdentical: number;
      modalityDependencies: number;
      conflicts: number;
    };
    conflicts: unknown[];
  };
  if (preview.counts.conflicts) {
    throw new ApiFailure(
      409,
      "A restauração encontrou conflitos. Nenhum dado foi alterado; resolva os conflitos antes de tentar novamente.",
    );
  }
  const records = await allOccupancyRecords(env);
  const modalities = await all(
    env.DB.prepare("SELECT id, name, normalized_name FROM occupancy_modalities"),
  );
  const modalityIds = new Map<string, string>();
  const statements: ReturnType<D1Database["prepare"]>[] = [];
  let insertedModalities = 0;

  for (const modality of backup.modalities) {
    const existing =
      modalities.find((row) => row.id === modality.id) ??
      modalities.find((row) => row.normalized_name === keyOf(modality.name));
    if (existing) {
      modalityIds.set(modality.id, String(existing.id));
      continue;
    }
    const now = nowIso();
    modalityIds.set(modality.id, modality.id);
    statements.push(
      env.DB.prepare(
        `INSERT INTO occupancy_modalities (id, name, normalized_name, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(modality.id, cleanText(modality.name), keyOf(modality.name), modality.version, now, now),
      env.DB.prepare(
        `INSERT INTO occupancy_history
          (id, entity_type, entity_id, operation, actor_id, before_data, after_data, created_at)
         SELECT ?, 'modality', id, 'restore', ?, NULL,
           json_object('id', id, 'name', name, 'version', version), ?
         FROM occupancy_modalities WHERE id=?`,
      ).bind(crypto.randomUUID(), actor.userId, now, modality.id),
    );
    insertedModalities += 1;
  }

  let identicalRecords = 0;
  let insertedRecords = 0;
  for (const item of backup.records) {
    const record = item.record as BackupOccupancy;
    const idMatch = records.find((row) => row.id === record.id);
    if (idMatch && backupRecordMatches(idMatch, record, item.scopeKey)) {
      identicalRecords += 1;
      continue;
    }
    const modalityId = modalityIds.get(record.modalityId);
    if (!modalityId) {
      throw new ApiFailure(409, "O backup referencia uma modalidade ausente.");
    }
    const now = nowIso();
    statements.push(
      env.DB.prepare(
        `INSERT INTO occupancy_records
          (id, modality_id, kind, date, month, percentage, reported_percentage, presences,
           capacity, aggregator_presences, start_time, end_time, class_name, scope_key, notes, source_file_hash,
           source_sheet, source_cell, source_cells, version, created_by, updated_by,
           created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, NULL)`,
      ).bind(
        record.id,
        modalityId,
        record.kind,
        record.kind === "daily" ? record.period : null,
        record.month,
        String(record.percentage),
        record.reportedPercentage === null ? null : String(record.reportedPercentage),
        record.presences,
        record.capacity,
        record.aggregatorPresences ?? null,
        record.startTime ? `${record.startTime}:00` : null,
        record.endTime ? `${record.endTime}:00` : null,
        record.className,
        item.scopeKey,
        record.notes,
        record.sourceFileHash,
        record.sourceSheet,
        record.sourceCell,
        record.sourceCells ? JSON.stringify(record.sourceCells) : null,
        actor.userId,
        actor.userId,
        record.createdAt,
        record.updatedAt,
      ),
      env.DB.prepare(
        `INSERT INTO occupancy_history
          (id, entity_type, entity_id, operation, actor_id, before_data, after_data, created_at)
         SELECT ?, 'record', id, 'restore', ?, NULL,
           json_object('id', id, 'modalityId', modality_id, 'kind', kind, 'date', date,
             'month', month, 'version', version, 'updatedAt', updated_at), ?
         FROM occupancy_records WHERE id=?`,
      ).bind(crypto.randomUUID(), actor.userId, now, record.id),
    );
    insertedRecords += 1;
  }
  if (statements.length > 950) {
    throw new ApiFailure(
      413,
      "O backup tem muitos registros para uma restauração atômica neste Worker. Nenhum dado foi alterado.",
    );
  }
  if (statements.length) {
    try {
      await env.DB.batch(statements);
    } catch {
      throw new ApiFailure(
        409,
        "A base mudou durante a restauração. Nenhum dado do lote foi aplicado; gere uma nova prévia.",
      );
    }
  }
  return json(
    RestoreOccupancyBackupResponse.parse({
      period: backup.period,
      insertedRecords,
      updatedRecords: 0,
      identicalRecords,
      ignoredRecords: 0,
      keptDistinct: 0,
      insertedModalities,
    }),
  );
}

async function saveRecord(
  request: Request,
  env: WorkerEnv,
  actor: AuthContext,
  id?: string,
): Promise<Response> {
  const raw = await readJson(request);
  const input = id
    ? parse(UpdateOccupancyRecordBody, raw)
    : parse(CreateOccupancyRecordBody, raw);
  const values = recordValues(input);
  const modality = await resolveModality(env.DB, actor.userId, input.modalityId, input.modalityName);
  const now = nowIso();
  if (!id) {
    const recordId = crypto.randomUUID();
    const result = await env.DB.batch([
      env.DB
        .prepare(
          `INSERT INTO occupancy_records
            (id, modality_id, kind, date, month, percentage, reported_percentage, presences,
             capacity, aggregator_presences, start_time, end_time, class_name, scope_key, notes, version,
             created_by, updated_by, created_at, updated_at, deleted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, NULL)`,
        )
        .bind(
          recordId,
          modality.id,
          values.kind,
          values.date,
          values.month,
          values.percentage,
          values.reportedPercentage,
          values.presences,
          values.capacity,
          values.aggregatorPresences,
          values.startTime,
          values.endTime,
          values.className,
          values.scopeKey,
          values.notes,
          actor.userId,
          actor.userId,
          now,
          now,
        ),
      env.DB
        .prepare(
          `INSERT INTO occupancy_history
            (id, entity_type, entity_id, operation, actor_id, before_data, after_data, created_at)
           SELECT ?, 'record', id, 'create', ?, NULL, json_object('id', id, 'kind', kind,
             'date', date, 'month', month, 'modalityId', modality_id, 'percentage', percentage,
             'version', version, 'createdAt', created_at, 'updatedAt', updated_at), ?
           FROM occupancy_records WHERE id=?`,
        )
        .bind(crypto.randomUUID(), actor.userId, now, recordId),
    ]);
    if (Number(result[0]?.meta?.changes ?? 0) === 0) {
      throw new ApiFailure(409, "Este registro de ocupação já existe.");
    }
    const row = await env.DB
      .prepare(
        `SELECT r.*, m.name AS modality_name FROM occupancy_records r
         JOIN occupancy_modalities m ON m.id=r.modality_id WHERE r.id=?`,
      )
      .bind(recordId)
      .first<Row>();
    return json(recordOut(row!), 201);
  }

  const current = await env.DB
    .prepare("SELECT * FROM occupancy_records WHERE id=? AND deleted_at IS NULL")
    .bind(id)
    .first<Row>();
  if (!current) throw new ApiFailure(404, "Registro não encontrado.");
  const expectedVersion =
    "version" in input
      ? Number((input as unknown as { version: number }).version)
      : Number.NaN;
  if (
    !Number.isSafeInteger(expectedVersion) ||
    Number(current.version) !== Number(expectedVersion)
  ) {
    throw new ApiFailure(409, "Este registro foi alterado. Atualize antes de salvar.");
  }
  const version = expectedVersion;
  const updateValues = input.aggregatorPresences === undefined
    ? recordValues({ ...input, aggregatorPresences: current.aggregator_presences == null ? null : Number(current.aggregator_presences) })
    : values;
  const result = await env.DB.batch([
    env.DB
      .prepare(
          `UPDATE occupancy_records SET modality_id=?, kind=?, date=?, month=?, percentage=?,
           reported_percentage=?, presences=?, capacity=?, aggregator_presences=?, aggregator_origin=NULL,
           aggregator_adjustment_id=NULL, start_time=?, end_time=?, class_name=?,
          scope_key=?, notes=?, version=version+1, updated_by=?, updated_at=?
         WHERE id=? AND version=? AND deleted_at IS NULL`,
      )
      .bind(
        modality.id,
        updateValues.kind,
        updateValues.date,
        updateValues.month,
        updateValues.percentage,
        updateValues.reportedPercentage,
        updateValues.presences,
        updateValues.capacity,
        updateValues.aggregatorPresences,
        updateValues.startTime,
        updateValues.endTime,
        updateValues.className,
        updateValues.scopeKey,
        updateValues.notes,
        actor.userId,
        now,
        id,
        version,
      ),
    env.DB
      .prepare(
        `INSERT INTO occupancy_history
          (id, entity_type, entity_id, operation, actor_id, before_data, after_data, created_at)
         SELECT ?, 'record', id, 'update', ?, ?, json_object('id', id, 'kind', kind,
           'date', date, 'month', month, 'modalityId', modality_id, 'percentage', percentage,
           'version', version, 'updatedAt', updated_at), ?
         FROM occupancy_records WHERE id=? AND version=? AND updated_at=? AND deleted_at IS NULL`,
      )
      .bind(crypto.randomUUID(), actor.userId, JSON.stringify(current), now, id, version + 1, now),
  ]);
  if (Number(result[0]?.meta?.changes ?? 0) === 0) {
    throw new ApiFailure(409, "Este registro foi alterado. Atualize antes de salvar.");
  }
  const updated = await env.DB
    .prepare(
      `SELECT r.*, m.name AS modality_name FROM occupancy_records r
       JOIN occupancy_modalities m ON m.id=r.modality_id WHERE r.id=?`,
    )
    .bind(id)
    .first<Row>();
  return json(recordOut(updated!));
}

export async function handleOccupancyRequest(
  request: Request,
  env: WorkerEnv,
  actor: AuthContext,
  path: string,
): Promise<Response | null> {
  try {
    try {
      const aggregatorAdjustmentResponse = await monthlyAggregatorAdjustmentRoutes(
        request,
        env,
        actor,
        path,
      );
      if (aggregatorAdjustmentResponse) return aggregatorAdjustmentResponse;
    } catch (error) {
      monthlyAggregatorRouteError(error);
    }
    const goalResponse = await monthlyGoalRoutes(request, env, path);
    if (goalResponse) return goalResponse;
    const modalityResponse = await modalityRoutes(request, env, actor, path);
    if (modalityResponse) return modalityResponse;
    if (path === "/occupancy" && request.method === "GET") {
      return await listRecords(request, env);
    }
    if (path === "/occupancy" && request.method === "POST") {
      return await saveRecord(request, env, actor);
    }
    if (path === "/occupancy/import/preview" && request.method === "POST") {
      return await previewOccupancyImport(request, env);
    }
    if (path === "/occupancy/import" && request.method === "POST") {
      return await commitOccupancyImport(request, env, actor);
    }
    if (path === "/occupancy/backup/period" && request.method === "POST") {
      return await createOccupancyBackup(request, env);
    }
    if (path === "/occupancy/backup/restore/preview" && request.method === "POST") {
      return await previewOccupancyBackup(request, env);
    }
    if (path === "/occupancy/backup/restore" && request.method === "POST") {
      return await restoreOccupancyBackupAtomic(request, env, actor);
    }
    const recordId = /^\/occupancy\/([0-9a-f-]+)$/i.exec(path)?.[1];
    if (recordId && request.method === "PATCH") {
      parse(UpdateOccupancyRecordParams, { id: recordId });
      return await saveRecord(request, env, actor, recordId);
    }
    if (recordId && request.method === "DELETE") {
      parse(DeleteOccupancyRecordParams, { id: recordId });
      const input = parse(DeleteOccupancyRecordBody, await readJson(request));
      const current = await env.DB
        .prepare("SELECT * FROM occupancy_records WHERE id=? AND deleted_at IS NULL")
        .bind(recordId)
        .first<Row>();
      if (!current) throw new ApiFailure(404, "Registro não encontrado.");
      if (Number(current.version) !== input.version) {
        throw new ApiFailure(409, "Este registro mudou. Atualize antes de excluir.");
      }
      const now = nowIso();
      const result = await env.DB.batch([
        env.DB
          .prepare(
            `UPDATE occupancy_records SET deleted_at=?, updated_at=?, updated_by=?, version=version+1
             WHERE id=? AND version=? AND deleted_at IS NULL`,
          )
          .bind(now, now, actor.userId, recordId, input.version),
        env.DB
          .prepare(
            `INSERT INTO occupancy_history
              (id, entity_type, entity_id, operation, actor_id, before_data, after_data, created_at)
             SELECT ?, 'record', id, 'delete', ?, ?, json_object('id', id, 'deletedAt', deleted_at,
               'version', version), ? FROM occupancy_records
             WHERE id=? AND version=? AND deleted_at=?`,
          )
          .bind(crypto.randomUUID(), actor.userId, JSON.stringify(current), now, recordId, input.version + 1, now),
      ]);
      if (Number(result[0]?.meta?.changes ?? 0) === 0) {
        throw new ApiFailure(409, "Este registro mudou. Atualize antes de excluir.");
      }
      return new Response(null, { status: 204 });
    }
    return null;
  } catch (error) {
    if (error instanceof ApiFailure) return apiError(error.status, error.message);
    throw error;
  }
}
