import { eq, isNull } from "drizzle-orm";
import {
  CreateOccupancyBackupBody,
  CreateOccupancyBackupResponse,
  type OccupancyBackup,
  type OccupancyBackupRestoreAction,
  type OccupancyBackupRestoreConflict,
  type OccupancyBackupRestorePreview,
  type OccupancyBackupRestoreResult,
  type OccupancyBackupSelection,
} from "@workspace/api-zod";
import {
  db,
  occupancyHistoryTable,
  occupancyModalitiesTable,
  occupancyRecordsTable,
} from "@workspace/db";
import {
  cleanOccupancyText,
  occupancyKey,
  serializeOccupancy,
  validOccupancyDay,
  validOccupancyMonth,
} from "./occupancy-data";

type Database = typeof db;
type OccupancyRecordRow = typeof occupancyRecordsTable.$inferSelect;
type BackupRecord = OccupancyBackup["records"][number];

const MAX_BACKUP_RECORDS = 50_000;

export class OccupancyBackupError extends Error {}

function dateMonthEnd(month: string): string {
  const [year, value] = month.split("-").map(Number);
  return new Date(Date.UTC(year, value, 0)).toISOString().slice(0, 10);
}

function hasValidRawBackupDates(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const backup = value as { generatedAt?: unknown; records?: unknown; modalities?: unknown };
  const isDateTime = (input: unknown) => typeof input === "string"
    && Number.isFinite(Date.parse(input)) && /(?:Z|[+-]\d{2}:\d{2})$/.test(input);
  if (!isDateTime(backup.generatedAt) || !Array.isArray(backup.records) || !Array.isArray(backup.modalities)) return false;
  return backup.records.every((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const record = (entry as { record?: { createdAt?: unknown; updatedAt?: unknown } }).record;
    return Boolean(record && isDateTime(record.createdAt) && isDateTime(record.updatedAt));
  });
}

function selectionMonths(selection: OccupancyBackupSelection): string[] {
  if (selection.mode === "months") return selection.months ?? [];
  if (selection.mode === "quarter" && selection.year && selection.quarter) {
    const firstMonth = (selection.quarter - 1) * 3 + 1;
    return [0, 1, 2].map((offset) => `${selection.year}-${String(firstMonth + offset).padStart(2, "0")}`);
  }
  if (selection.mode === "range" && selection.fromDate && selection.toDate) {
    const start = selection.fromDate.slice(0, 7);
    const end = selection.toDate.slice(0, 7);
    const result: string[] = [];
    let [year, month] = start.split("-").map(Number);
    const [endYear, endMonth] = end.split("-").map(Number);
    while (year < endYear || (year === endYear && month <= endMonth)) {
      result.push(`${year}-${String(month).padStart(2, "0")}`);
      month += 1;
      if (month === 13) { year += 1; month = 1; }
    }
    return result;
  }
  return [];
}

export function validateOccupancyBackupSelection(value: unknown): OccupancyBackupSelection {
  const parsed = CreateOccupancyBackupBody.safeParse(value);
  if (!parsed.success) throw new OccupancyBackupError("Revise os filtros do relatório.");
  const selection = parsed.data as OccupancyBackupSelection;
  const hasTimeOrWeekday = Boolean(selection.startTimes?.length || selection.weekdays?.length);
  if (selection.mode === "months") {
    if (!selection.months?.length || selection.months.some((month) => !validOccupancyMonth(month))) {
      throw new OccupancyBackupError("Selecione ao menos um mês válido.");
    }
    if (new Set(selection.months).size !== selection.months.length) throw new OccupancyBackupError("Remova meses repetidos.");
  } else if (selection.mode === "quarter") {
    if (!selection.year || !selection.quarter || selection.year < 1900 || selection.year > 2100
      || selection.quarter < 1 || selection.quarter > 4) throw new OccupancyBackupError("Selecione um trimestre e ano válidos.");
  } else if (selection.mode === "range") {
    if (!selection.fromDate || !selection.toDate || !validOccupancyDay(selection.fromDate)
      || !validOccupancyDay(selection.toDate) || selection.fromDate > selection.toDate) {
      throw new OccupancyBackupError("Informe um intervalo válido, incluindo a data inicial e final.");
    }
  }
  if (selection.modalityId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(selection.modalityId)) {
    throw new OccupancyBackupError("A modalidade selecionada é inválida.");
  }
  if (selection.className && !cleanOccupancyText(selection.className)) throw new OccupancyBackupError("A turma selecionada é inválida.");
  return selection;
}

function monthIsCompleteInRange(month: string, fromDate: string, toDate: string) {
  return `${month}-01` >= fromDate && dateMonthEnd(month) <= toDate;
}

function recordMatchesSelection(row: OccupancyRecordRow, selection: OccupancyBackupSelection): boolean {
  if (selection.modalityId && row.modalityId !== selection.modalityId) return false;
  if (selection.className && occupancyKey(row.className ?? "") !== occupancyKey(selection.className)) return false;

  if (selection.mode === "months" && !selection.months?.includes(row.month)) return false;
  if (selection.mode === "quarter" && (row.month.slice(0, 4) !== String(selection.year)
    || Math.ceil(Number(row.month.slice(5, 7)) / 3) !== selection.quarter)) return false;
  if (selection.mode === "range") {
    if (row.kind === "monthly") {
      if (!monthIsCompleteInRange(row.month, selection.fromDate!, selection.toDate!)) return false;
    } else if (!row.date || row.date < selection.fromDate! || row.date > selection.toDate!) return false;
  }

  if (selection.startTimes?.length) {
    if (row.kind !== "daily" || !row.startTime || !selection.startTimes.includes(row.startTime.slice(0, 5))) return false;
  }
  if (selection.weekdays?.length) {
    if (row.kind !== "daily" || !row.date) return false;
    const weekday = new Date(`${row.date}T00:00:00.000Z`).getUTCDay() || 7;
    if (!selection.weekdays.includes(weekday)) return false;
  }
  if ((selection.startTimes?.length || selection.weekdays?.length) && row.kind !== "daily") return false;
  if (row.kind === "monthly" && selection.mode === "range"
    && !monthIsCompleteInRange(row.month, selection.fromDate!, selection.toDate!)) return false;
  return true;
}

function labelSelection(selection: OccupancyBackupSelection): string {
  if (selection.mode === "all") return "Todo o histórico";
  if (selection.mode === "months") return selection.months!.length === 1
    ? selection.months![0] : selection.months!.join(", ");
  if (selection.mode === "quarter") return `${selection.quarter}º trimestre de ${selection.year}`;
  return `${selection.fromDate} a ${selection.toDate}`;
}

function isMeasured(record: BackupRecord["record"]) {
  return record.presences !== null && record.presences !== undefined
    && record.capacity !== null && record.capacity !== undefined;
}

function effectiveRecords(records: BackupRecord[], selection: OccupancyBackupSelection): BackupRecord[] {
  const allowMonthly = selection.mode !== "range"
    || (selection.fromDate && selection.toDate && selectionMonths(selection).every((month) =>
      monthIsCompleteInRange(month, selection.fromDate!, selection.toDate!)));
  const filtered = records.filter(({ record }) => {
    if ((selection.startTimes?.length || selection.weekdays?.length) && record.kind !== "daily") return false;
    if (record.kind === "monthly" && !allowMonthly) return false;
    return true;
  });
  const scopes = new Map<string, { daily: BackupRecord[]; monthly: BackupRecord[] }>();
  for (const entry of filtered) {
    const { record } = entry;
    const key = JSON.stringify([record.month, record.modalityId, occupancyKey(record.className ?? "")]);
    const group = scopes.get(key) ?? { daily: [], monthly: [] };
    group[record.kind].push(entry);
    scopes.set(key, group);
  }
  const selected: BackupRecord[] = [];
  for (const group of scopes.values()) {
    const monthlyMeasured = group.monthly.filter(({ record }) => isMeasured(record));
    const monthlyLegacy = group.monthly.filter(({ record }) => !isMeasured(record));
    const dailyMeasured = group.daily.filter(({ record }) => isMeasured(record));
    const dailyLegacy = group.daily.filter(({ record }) => !isMeasured(record));
    selected.push(...(monthlyMeasured.length ? monthlyMeasured : dailyMeasured));
    selected.push(...(monthlyLegacy.length ? monthlyLegacy : dailyLegacy));
  }
  return selected;
}

export async function createOccupancyBackup(database: Database, input: unknown): Promise<OccupancyBackup> {
  const selection = validateOccupancyBackupSelection(input);
  const [rows, modalityRows] = await Promise.all([
    database.select().from(occupancyRecordsTable).where(isNull(occupancyRecordsTable.deletedAt)),
    database.select().from(occupancyModalitiesTable),
  ]);
  const modalitiesById = new Map(modalityRows.map((item) => [item.id, item]));
  const selectedRows = rows.filter((row) => recordMatchesSelection(row, selection));
  if (selectedRows.length > MAX_BACKUP_RECORDS) throw new OccupancyBackupError("O backup excede 50.000 registros. Divida a seleção em períodos menores.");
  const records: BackupRecord[] = selectedRows.map((row) => {
    const modality = modalitiesById.get(row.modalityId);
    if (!modality) throw new OccupancyBackupError("Um registro selecionado está sem modalidade vinculada.");
    return {
      scope: "period",
      scopeKey: row.scopeKey,
      record: serializeOccupancy(row, modality.name) as BackupRecord["record"],
    };
  });
  const usedModalityIds = new Set(records.map(({ record }) => record.modalityId!));
  const modalities = modalityRows
    .filter(({ id }) => usedModalityIds.has(id))
    .map(({ id, name, version, createdAt, updatedAt }) => ({
      id, name, version, createdAt: createdAt.toISOString(), updatedAt: updatedAt.toISOString(),
    }));
  const effective = effectiveRecords(records, selection);
  const measured = effective.filter(({ record }) => isMeasured(record));
  const presences = measured.reduce((total, { record }) => total + (record.presences ?? 0), 0);
  const capacity = measured.reduce((total, { record }) => total + (record.capacity ?? 0), 0);
  const months = selectionMonths(selection);
  const unrestricted = selection.mode === "all" && !selection.modalityId
    && !selection.className && !selection.startTimes?.length && !selection.weekdays?.length;
  const backup: OccupancyBackup = {
    format: "zero3-pro-occupancy-backup",
    schemaVersion: 1,
    module: "occupancy",
    origin: "zero3-pro-occupancy-database",
    generatedAt: new Date(),
    period: labelSelection(selection),
    selection,
    partial: !unrestricted,
    counts: {
      records: records.length,
      dailyRecords: records.filter(({ record }) => record.kind === "daily").length,
      monthlyRecords: records.filter(({ record }) => record.kind === "monthly").length,
      modalities: modalities.length,
      totalRecords: records.length,
    },
    summary: {
      measuredRecords: measured.length,
      legacyRecords: effective.length - measured.length,
      presences,
      capacity,
      weightedPercentage: capacity ? (presences / capacity) * 100 : null,
    },
    modalities,
    records,
  };
  const checked = CreateOccupancyBackupResponse.safeParse(backup);
  if (!checked.success) throw new OccupancyBackupError("Não foi possível validar o arquivo de backup gerado.");
  return checked.data as OccupancyBackup;
}

function baseScopeKey(record: BackupRecord["record"]) {
  return occupancyKey(record.className ?? "");
}

function recordNaturalKey(record: BackupRecord["record"], modalityId = record.modalityId, scopeKey = baseScopeKey(record)) {
  return JSON.stringify([
    modalityId,
    record.kind,
    record.period.slice(0, 7),
    record.kind === "daily" ? record.period : null,
    scopeKey,
    record.startTime ?? null,
  ]);
}

function recordSourceKey(record: BackupRecord["record"]) {
  return record.sourceFileHash && record.sourceSheet && record.sourceCell
    ? JSON.stringify([record.sourceFileHash, record.sourceSheet, record.sourceCell])
    : null;
}

function sameRecord(a: BackupRecord["record"], b: BackupRecord["record"], scopeA: string, scopeB: string) {
  const stripSeconds = (value?: string | null) => value?.slice(0, 5) ?? null;
  const logicalScopeMatches = scopeA === scopeB
    || (scopeA === baseScopeKey(a) && scopeB.startsWith(`${scopeA}::restore:`));
  return logicalScopeMatches
    && a.id === b.id && a.modalityId === b.modalityId && a.kind === b.kind && a.period === b.period
    && a.percentage === b.percentage && (a.reportedPercentage ?? null) === (b.reportedPercentage ?? null)
    && (a.presences ?? null) === (b.presences ?? null) && (a.capacity ?? null) === (b.capacity ?? null)
    && stripSeconds(a.startTime) === stripSeconds(b.startTime) && stripSeconds(a.endTime) === stripSeconds(b.endTime)
    && occupancyKey(a.className ?? "") === occupancyKey(b.className ?? "") && (a.notes ?? null) === (b.notes ?? null)
    && (a.sourceFileHash ?? null) === (b.sourceFileHash ?? null)
    && (a.sourceSheet ?? null) === (b.sourceSheet ?? null) && (a.sourceCell ?? null) === (b.sourceCell ?? null);
}

type RestoreAnalysis = {
  conflicts: OccupancyBackupRestoreConflict[];
  identicalIds: Set<string>;
  modalityMap: Map<string, string>;
  insertableModalities: Set<string>;
};

async function analyzeRestore(database: Database, backup: OccupancyBackup): Promise<RestoreAnalysis> {
  const [existingRows, existingModalities] = await Promise.all([
    database.select().from(occupancyRecordsTable),
    database.select().from(occupancyModalitiesTable),
  ]);
  const activeRows = existingRows.filter((row) => row.deletedAt === null);
  const modalityMap = new Map<string, string>();
  const insertableModalities = new Set<string>();
  const conflicts: OccupancyBackupRestoreConflict[] = [];
  for (const modality of backup.modalities) {
    const sameId = existingModalities.find((item) => item.id === modality.id);
    if (sameId) {
      if (occupancyKey(sameId.name) !== occupancyKey(modality.name)) {
        conflicts.push({
          entityType: "modality", backupId: modality.id, existingId: sameId.id, conflictKind: "id",
          reason: `A modalidade "${sameId.name}" já usa esse ID, mas o backup contém "${modality.name}".`,
          options: ["ignore", "update"],
        });
      } else modalityMap.set(modality.id, sameId.id);
      continue;
    }
    const sameName = existingModalities.find((item) => occupancyKey(item.name) === occupancyKey(modality.name));
    if (sameName) modalityMap.set(modality.id, sameName.id);
    else {
      modalityMap.set(modality.id, modality.id);
      insertableModalities.add(modality.id);
    }
  }

  const identicalIds = new Set<string>();
  const usedId = new Map(existingRows.map((row) => [row.id, row]));
  for (const { record: incoming, scopeKey } of backup.records) {
    const mappedModalityId = modalityMap.get(incoming.modalityId ?? "");
    const byId = usedId.get(incoming.id);
    if (byId) {
      const existingRecord = serializeOccupancy(
        byId,
        existingModalities.find((item) => item.id === byId.modalityId)?.name ?? "",
      ) as BackupRecord["record"];
      if (mappedModalityId === byId.modalityId && sameRecord(incoming, existingRecord, scopeKey, byId.scopeKey)) {
        identicalIds.add(incoming.id);
      } else {
        conflicts.push({
          entityType: "record", backupId: incoming.id, existingId: byId.id, conflictKind: "id",
          reason: "O ID do lançamento já existe com informações diferentes.",
          options: ["ignore", "update"],
        });
      }
      continue;
    }
    if (!mappedModalityId) continue;
    const sourceKey = recordSourceKey(incoming);
    const byNaturalKey = activeRows.find((row) => {
      const existingRecord = serializeOccupancy(
        row,
        existingModalities.find((item) => item.id === row.modalityId)?.name ?? "",
      ) as BackupRecord["record"];
      return row.modalityId === mappedModalityId
        && recordNaturalKey(existingRecord, row.modalityId, row.scopeKey) === recordNaturalKey(incoming, mappedModalityId, scopeKey);
    });
    const bySource = sourceKey ? activeRows.find((row) =>
      row.sourceFileHash && JSON.stringify([row.sourceFileHash, row.sourceSheet, row.sourceCell]) === sourceKey,
    ) : undefined;
    const match = bySource ?? byNaturalKey;
    if (match) {
      conflicts.push({
        entityType: "record", backupId: incoming.id, existingId: match.id,
        conflictKind: bySource ? "source" : "natural-key",
        reason: bySource
          ? "A mesma célula de origem já foi importada."
          : "Já existe uma aula com a mesma modalidade, data, turma e horário.",
        options: bySource ? ["ignore", "update"] : ["ignore", "update", "keep-both"],
      });
    }
  }
  return { conflicts, identicalIds, modalityMap, insertableModalities };
}

export function validateOccupancyBackup(value: unknown): OccupancyBackup {
  if (!hasValidRawBackupDates(value)) {
    throw new OccupancyBackupError("As datas do backup precisam estar serializadas como texto válido, antes da validação.");
  }
  const parsed = CreateOccupancyBackupResponse.safeParse(value);
  if (!parsed.success) throw new OccupancyBackupError("O arquivo não é um backup de ocupação válido ou não é compatível com esta versão.");
  const backup = parsed.data as OccupancyBackup;
  if (backup.records.length > MAX_BACKUP_RECORDS || backup.counts.records !== backup.records.length
    || backup.counts.totalRecords !== backup.records.length
    || backup.counts.dailyRecords !== backup.records.filter(({ record }) => record.kind === "daily").length
    || backup.counts.monthlyRecords !== backup.records.filter(({ record }) => record.kind === "monthly").length
    || backup.counts.modalities !== backup.modalities.length) throw new OccupancyBackupError("As contagens do backup não correspondem aos registros.");
  const modalityIds = new Set(backup.modalities.map((item) => item.id));
  const ids = new Set<string>();
  for (const { scope, scopeKey, record } of backup.records) {
    const normalizedScope = baseScopeKey(record);
    if (scope !== "period" || ids.has(record.id) || !record.modalityId || !modalityIds.has(record.modalityId)
      || (scopeKey !== normalizedScope && !scopeKey.startsWith(`${normalizedScope}::`))) {
      throw new OccupancyBackupError("O backup contém IDs repetidos ou modalidades ausentes.");
    }
    ids.add(record.id);
    if (!validOccupancyMonth(record.month) || (record.kind === "daily"
      ? !validOccupancyDay(record.period) || record.period.slice(0, 7) !== record.month
      : !validOccupancyMonth(record.period) || record.period !== record.month)) {
      throw new OccupancyBackupError("O backup contém um período de ocupação inválido.");
    }
    if (record.kind === "daily" && ((record.presences === undefined) !== (record.capacity === undefined))) {
      throw new OccupancyBackupError("Presenças e vagas do backup precisam estar preenchidas em conjunto.");
    }
    if (record.presences != null && record.capacity != null
      && record.capacity > 0 && Math.abs(record.percentage! - record.presences / record.capacity * 100) > 0.00001) {
      throw new OccupancyBackupError("O percentual calculado não confere com presenças e vagas.");
    }
  }
  return backup;
}

export async function previewOccupancyBackupRestore(database: Database, value: unknown): Promise<OccupancyBackupRestorePreview> {
  const backup = validateOccupancyBackup(value);
  const analysis = await analyzeRestore(database, backup);
  const conflictingIds = new Set(analysis.conflicts.filter((item) => item.entityType === "record").map((item) => item.backupId));
  return {
    period: backup.period,
    counts: {
      recordsToInsert: backup.records.length - analysis.identicalIds.size - conflictingIds.size,
      recordsIdentical: analysis.identicalIds.size,
      modalityDependencies: analysis.insertableModalities.size,
      conflicts: analysis.conflicts.length,
    },
    conflicts: analysis.conflicts,
  };
}

function recordInsertValues(
  envelope: BackupRecord,
  modalityId: string,
  actorId: string,
  scopeKey: string,
  createdAt?: Date,
) {
  const record = envelope.record;
  const time = (value?: string | null) => value ? `${value.slice(0, 5)}:00` : null;
  return {
    id: record.id,
    modalityId,
    kind: record.kind,
    date: record.kind === "daily" ? record.period : null,
    month: record.month,
    percentage: String(record.percentage),
    reportedPercentage: record.reportedPercentage == null ? null : String(record.reportedPercentage),
    presences: record.presences ?? null,
    capacity: record.capacity ?? null,
    startTime: time(record.startTime),
    endTime: time(record.endTime),
    className: record.className ?? null,
    scopeKey,
    notes: record.notes ?? null,
    sourceFileHash: record.sourceFileHash ?? null,
    sourceSheet: record.sourceSheet ?? null,
    sourceCell: record.sourceCell ?? null,
    sourceCells: record.sourceCells ?? null,
    version: record.version ?? 1,
    createdBy: actorId,
    updatedBy: actorId,
    createdAt: createdAt ?? new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
    deletedAt: null,
  };
}

function addRestoreSuffix(scopeKey: string, id: string) {
  return `${scopeKey}::restore:${id.replaceAll("-", "").slice(0, 16)}`;
}

export async function restoreOccupancyBackup(
  database: Database,
  value: unknown,
  actions: OccupancyBackupRestoreAction[],
  actorId: string,
): Promise<OccupancyBackupRestoreResult> {
  const backup = validateOccupancyBackup(value);
  const actionMap = new Map(actions.map((item) => [`${item.entityType}:${item.backupId}`, item.action]));
  const result: OccupancyBackupRestoreResult = {
    period: backup.period, insertedRecords: 0, updatedRecords: 0, identicalRecords: 0,
    ignoredRecords: 0, keptDistinct: 0, insertedModalities: 0,
  };
  await database.transaction(async (tx) => {
    const analysis = await analyzeRestore(tx as unknown as Database, backup);
    const modalityMap = new Map(analysis.modalityMap);
    const ignoredModalities = new Set<string>();
    for (const conflict of analysis.conflicts.filter((item) => item.entityType === "modality")) {
      const action = actionMap.get(`modality:${conflict.backupId}`) ?? "ignore";
      const incoming = backup.modalities.find((item) => item.id === conflict.backupId)!;
      if (action === "update") {
        await tx.update(occupancyModalitiesTable).set({
          name: incoming.name,
          normalizedName: occupancyKey(incoming.name),
          version: (await tx.select().from(occupancyModalitiesTable).where(eq(occupancyModalitiesTable.id, conflict.existingId)).limit(1))[0]?.version! + 1,
          updatedAt: new Date(),
        }).where(eq(occupancyModalitiesTable.id, conflict.existingId));
        modalityMap.set(incoming.id, conflict.existingId);
      } else {
        ignoredModalities.add(incoming.id);
      }
    }
    for (const modality of backup.modalities) {
      if (ignoredModalities.has(modality.id) || !analysis.insertableModalities.has(modality.id)) continue;
      await tx.insert(occupancyModalitiesTable).values({
        id: modality.id,
        name: cleanOccupancyText(modality.name),
        normalizedName: occupancyKey(modality.name),
        version: modality.version,
        createdAt: new Date(),
        updatedAt: new Date(),
      }).onConflictDoNothing();
      const current = (await tx.select().from(occupancyModalitiesTable).where(eq(occupancyModalitiesTable.id, modality.id)).limit(1))[0];
      if (current) {
        modalityMap.set(modality.id, current.id);
        if (current.id === modality.id) result.insertedModalities += 1;
      } else ignoredModalities.add(modality.id);
    }

    const currentRows = await tx.select().from(occupancyRecordsTable);
    const activeRows = currentRows.filter((row) => row.deletedAt === null);
    for (const envelope of backup.records) {
      const incoming = envelope.record;
      const originalModalityId = incoming.modalityId!;
      const mappedModalityId = modalityMap.get(originalModalityId);
      if (!mappedModalityId || ignoredModalities.has(originalModalityId)) {
        result.ignoredRecords += 1;
        continue;
      }
      if (analysis.identicalIds.has(incoming.id)) {
        result.identicalRecords += 1;
        continue;
      }
      const conflict = analysis.conflicts.find((item) => item.entityType === "record" && item.backupId === incoming.id);
      const action = conflict ? actionMap.get(`record:${incoming.id}`) ?? "ignore" : undefined;
      if (conflict && action === "ignore") {
        result.ignoredRecords += 1;
        continue;
      }
      const idConflict = currentRows.find((row) => row.id === incoming.id);
      let target = idConflict;
      if (!target && conflict) target = activeRows.find((row) => row.id === conflict.existingId);
      if (conflict && !target) {
        result.ignoredRecords += 1;
        continue;
      }
      if (conflict && action === "keep-both" && conflict.options.includes("keep-both")) target = undefined;
      const scopeKey = conflict && action === "keep-both"
        ? addRestoreSuffix(envelope.scopeKey, incoming.id)
        : envelope.scopeKey || baseScopeKey(incoming);
      if (target) {
        const before = serializeOccupancy(
          target,
          (await tx.select().from(occupancyModalitiesTable).where(eq(occupancyModalitiesTable.id, target.modalityId)).limit(1))[0]?.name ?? "",
        );
        const values = recordInsertValues(envelope, mappedModalityId, actorId, scopeKey, target.createdAt);
        const { id: _id, createdAt: _createdAt, ...updateValues } = values;
        await tx.update(occupancyRecordsTable).set({
          ...updateValues,
          version: target.version + 1,
          updatedAt: new Date(),
        }).where(eq(occupancyRecordsTable.id, target.id));
        const updated = { ...values, id: target.id, version: target.version + 1, createdAt: target.createdAt, updatedAt: new Date() };
        await tx.insert(occupancyHistoryTable).values({
          entityType: "record", entityId: target.id, operation: "backup_update", actorId,
          beforeData: before as Record<string, unknown>, afterData: updated as Record<string, unknown>,
        });
        result.updatedRecords += 1;
      } else {
        const values = recordInsertValues(envelope, mappedModalityId, actorId, scopeKey);
        const inserted = await tx.insert(occupancyRecordsTable).values(values).onConflictDoNothing().returning({ id: occupancyRecordsTable.id });
        if (inserted.length) {
          result.insertedRecords += 1;
          if (conflict && action === "keep-both") result.keptDistinct += 1;
          await tx.insert(occupancyHistoryTable).values({
            entityType: "record", entityId: incoming.id, operation: "backup_restore", actorId,
            beforeData: null, afterData: values as Record<string, unknown>,
          });
        } else {
          result.ignoredRecords += 1;
        }
      }
    }
  });
  return result;
}
