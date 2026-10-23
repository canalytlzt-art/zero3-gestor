import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { getAuth } from "@clerk/express";
import { and, asc, desc, eq, gte, inArray, isNull, lte, like, or, sql, type SQL } from "drizzle-orm";
import { db, occupancyHistoryTable, occupancyModalitiesTable, occupancyRecordsTable, productsTable } from "@workspace/db";
import {
  CreateOccupancyModalityBody, CreateOccupancyModalityResponse,
  DeleteOccupancyModalityBody, DeleteOccupancyModalityParams, DeleteOccupancyModalityResponse,
  UpdateOccupancyModalityBody, UpdateOccupancyModalityParams, UpdateOccupancyModalityResponse,
  GetOccupancyModalitiesResponse, GetOccupancyRecordsQueryParams, GetOccupancyRecordsResponse,
  CreateOccupancyRecordBody, CreateOccupancyRecordResponse,
  UpdateOccupancyRecordBody, UpdateOccupancyRecordParams, UpdateOccupancyRecordResponse,
  DeleteOccupancyRecordBody, DeleteOccupancyRecordParams,
  PreviewOccupancyImportBody, PreviewOccupancyImportResponse,
  CommitOccupancyImportBody, CommitOccupancyImportResponse,
  CreateOccupancyBackupBody, CreateOccupancyBackupResponse,
  PreviewOccupancyBackupRestoreBody, PreviewOccupancyBackupRestoreResponse,
  RestoreOccupancyBackupBody, RestoreOccupancyBackupResponse,
  type OccupancyImportRowInput,
} from "@workspace/api-zod";
import { isAuthorizedUser } from "../lib/authorization";
import {
  createOccupancyBackup, OccupancyBackupError, previewOccupancyBackupRestore, restoreOccupancyBackup,
  validateOccupancyBackup,
} from "../lib/occupancy-backup";
import {
  cleanOccupancyText, occupancyKey, occupancyValues, OccupancyError, resolveOccupancyModality,
  serializeOccupancy, validOccupancyDay, validOccupancyMonth,
} from "../lib/occupancy-data";

type Dependencies = {
  database?: typeof db;
  getUserId?: (req: Request) => string | null;
  isAuthorized?: (req: Request) => Promise<boolean>;
};
function parse<T>(schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false } }, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new OccupancyError(400, "Revise data, modalidade, presenças, capacidade, horários ou percentual legado.");
  return result.data;
}
function validateImportOrigin(row: OccupancyImportRowInput) {
  const cells = row.sourceCells;
  const hasCounts = row.presences !== undefined || row.capacity !== undefined;
  const sourceValid = hasCounts
    ? row.presences !== undefined && row.capacity !== undefined && Boolean(row.startTime)
      && Boolean(cells.presences) && Boolean(cells.capacity) && Boolean(cells.startTime)
      && cells.presences === row.sourceCell
      && (row.reportedPercentage === undefined || Boolean(cells.percentage))
    : row.percentage !== undefined && Boolean(cells.percentage) && cells.percentage === row.sourceCell;
  if (!row.sourceSheet.trim() || Object.keys(cells).length < 2 || Object.keys(cells).length > 8
    || !cells.period || !cells.modality || !sourceValid) {
    throw new OccupancyError(400, "A origem deve informar aba, células de período/modalidade e os campos de ocupação reconhecidos.");
  }
}

function scopeMatches(scopeKey: string): SQL {
  const escaped = scopeKey.replace(/[\\%_]/g, "\\$&");
  return or(
    eq(occupancyRecordsTable.scopeKey, scopeKey),
    like(occupancyRecordsTable.scopeKey, `${escaped}::%`),
  )!;
}

function sameLogicalScope(storedScope: string, baseScope: string) {
  return storedScope === baseScope || storedScope.startsWith(`${baseScope}::`);
}

export function createOccupancyRouter(dependencies: Dependencies = {}): IRouter {
  const router: IRouter = Router();
  const database = dependencies.database ?? db;
  const getUserId = dependencies.getUserId ?? ((req: Request) => getAuth(req).userId ?? null);
  router.use("/occupancy", async (req, res, next): Promise<void> => {
    if (!getUserId(req)) { res.status(401).json({ error: "Autenticação necessária." }); return; }
    if (!(await (dependencies.isAuthorized ?? isAuthorizedUser)(req))) {
      res.status(403).json({ error: "Acesso restrito à equipe autorizada." }); return;
    }
    next();
  });
  router.post("/occupancy/import/preview", async (req, res): Promise<void> => {
    const input = parse(PreviewOccupancyImportBody, req.body);
    const seen = new Set<string>();
    const rows = [];
    for (const entry of input.entries) {
      validateImportOrigin(entry);
      const values = occupancyValues(entry);
      const sourceKey = `${entry.sourceSheet}\u0000${entry.sourceCell}`;
      if (seen.has(sourceKey)) {
        rows.push({ index: entry.index, status: "duplicate_in_file" as const, message: "Esta célula já aparece na prévia deste lote.", existingRecord: null });
        continue;
      }
      seen.add(sourceKey);

      const [sourceMatch] = await database.select({ record: occupancyRecordsTable, name: occupancyModalitiesTable.name })
        .from(occupancyRecordsTable).innerJoin(occupancyModalitiesTable, eq(occupancyModalitiesTable.id, occupancyRecordsTable.modalityId))
        .where(and(
          eq(occupancyRecordsTable.sourceFileHash, input.fileHash),
          eq(occupancyRecordsTable.sourceSheet, entry.sourceSheet),
          eq(occupancyRecordsTable.sourceCell, entry.sourceCell),
          isNull(occupancyRecordsTable.deletedAt),
        )).limit(1);
      if (sourceMatch) {
        const existing = serializeOccupancy(sourceMatch.record, sourceMatch.name);
        const same = existing.kind === entry.kind && existing.period === entry.period
          && occupancyKey(existing.modalityName) === occupancyKey(entry.modalityName)
          && Number(existing.percentage) === Number(values.percentage)
          && existing.presences === values.presences && existing.capacity === values.capacity
          && existing.startTime === values.startTime && existing.endTime === values.endTime
          && existing.reportedPercentage === (values.reportedPercentage === null ? null : Number(values.reportedPercentage))
          && occupancyKey(existing.className ?? "") === occupancyKey(entry.className ?? "");
        rows.push({
          index: entry.index, status: same ? "already_imported" as const : "conflict" as const,
          message: same ? "Esta célula deste arquivo já foi importada e não será duplicada." : "Esta célula já existe, mas os dados mudaram desde a importação anterior.",
          existingRecord: existing,
        });
        continue;
      }

      const [modality] = await database.select().from(occupancyModalitiesTable)
        .where(eq(occupancyModalitiesTable.normalizedName, occupancyKey(entry.modalityName))).limit(1);
      const [scopeMatch] = modality ? await database.select({ record: occupancyRecordsTable, name: occupancyModalitiesTable.name })
        .from(occupancyRecordsTable).innerJoin(occupancyModalitiesTable, eq(occupancyModalitiesTable.id, occupancyRecordsTable.modalityId))
        .where(and(
          eq(occupancyRecordsTable.modalityId, modality.id),
          eq(occupancyRecordsTable.kind, entry.kind),
          eq(occupancyRecordsTable.month, values.month),
          scopeMatches(values.scopeKey),
          values.startTime === null ? isNull(occupancyRecordsTable.startTime) : eq(occupancyRecordsTable.startTime, values.startTime),
          entry.kind === "daily" ? eq(occupancyRecordsTable.date, values.date!) : isNull(occupancyRecordsTable.date),
          isNull(occupancyRecordsTable.deletedAt),
        )).limit(1) : [];
      if (scopeMatch) {
        rows.push({ index: entry.index, status: "conflict" as const, message: "Já existe um registro para esta modalidade, período e turma/horário. Confira a versão atual antes de autorizar a atualização.", existingRecord: serializeOccupancy(scopeMatch.record, scopeMatch.name) });
      } else {
        rows.push({ index: entry.index, status: "new" as const, message: "Novo registro. Ainda não foi gravado.", existingRecord: null });
      }
    }
    res.json(PreviewOccupancyImportResponse.parse({ rows }));
  });
  router.post("/occupancy/import", async (req, res): Promise<void> => {
    const input = parse(CommitOccupancyImportBody, req.body);
    const rows = await database.transaction(async (tx) => {
      const output: Array<{ index: number; status: "inserted" | "updated" | "already_imported" | "conflict" | "duplicate_in_batch"; id: string | null; message: string }> = [];
      const seen = new Set<string>();
      let inserted = 0;
      let updated = 0;
      let alreadyImported = 0;
      let conflicts = 0;
      for (let i = 0; i < input.entries.length; i += 1) {
        const item = input.entries[i];
        const entry = item.record;
        validateImportOrigin(entry);
        const values = occupancyValues(entry);
        const sourceKey = `${entry.sourceSheet}\u0000${entry.sourceCell}`;
        const naturalKey = `${occupancyKey(entry.modalityName)}\u0000${entry.kind}\u0000${values.month}\u0000${values.date ?? ""}\u0000${values.scopeKey}\u0000${values.startTime ?? ""}`;
        const duplicateInBatch = seen.has(naturalKey);
        if (seen.has(sourceKey) || (duplicateInBatch && !item.keepBothConfirmed)) {
          output.push({ index: entry.index, status: "duplicate_in_batch", id: null, message: "Escopo ou célula repetidos neste lote; nenhum dado foi somado." });
          conflicts += 1;
          continue;
        }
        seen.add(sourceKey);
        seen.add(naturalKey);

        const savepoint = `occupancy_import_row_${i}`;
        await tx.execute(sql.raw(`SAVEPOINT ${savepoint}`));
        try {
          const [sourceMatch] = await tx.select({ record: occupancyRecordsTable, name: occupancyModalitiesTable.name })
            .from(occupancyRecordsTable).innerJoin(occupancyModalitiesTable, eq(occupancyModalitiesTable.id, occupancyRecordsTable.modalityId))
            .where(and(
              eq(occupancyRecordsTable.sourceFileHash, input.fileHash),
              eq(occupancyRecordsTable.sourceSheet, entry.sourceSheet),
              eq(occupancyRecordsTable.sourceCell, entry.sourceCell),
              isNull(occupancyRecordsTable.deletedAt),
            )).limit(1);
          if (sourceMatch) {
            const existing = serializeOccupancy(sourceMatch.record, sourceMatch.name);
            const same = existing.kind === entry.kind && existing.period === entry.period
              && occupancyKey(existing.modalityName) === occupancyKey(entry.modalityName)
              && Number(existing.percentage) === Number(values.percentage)
              && existing.presences === values.presences && existing.capacity === values.capacity
              && existing.startTime === values.startTime && existing.endTime === values.endTime
              && existing.reportedPercentage === (values.reportedPercentage === null ? null : Number(values.reportedPercentage))
              && occupancyKey(existing.className ?? "") === occupancyKey(entry.className ?? "");
            if (same) {
              output.push({ index: entry.index, status: "already_imported", id: existing.id, message: "Já importado; mantido sem duplicação." });
              alreadyImported += 1;
              await tx.execute(sql.raw(`RELEASE SAVEPOINT ${savepoint}`));
              continue;
            }
            if (item.keepBothConfirmed) {
              output.push({ index: entry.index, status: "conflict", id: existing.id, message: "Esta mesma célula já foi importada com outros dados. Use Atualizar registro, não Manter ambos." });
              conflicts += 1;
              await tx.execute(sql.raw(`RELEASE SAVEPOINT ${savepoint}`));
              continue;
            }
            if (item.existingRecordId !== existing.id || item.expectedVersion !== sourceMatch.record.version) {
              output.push({ index: entry.index, status: "conflict", id: existing.id, message: "A origem já existe com dados diferentes. Autorize explicitamente a atualização desta versão." });
              conflicts += 1;
              await tx.execute(sql.raw(`RELEASE SAVEPOINT ${savepoint}`));
              continue;
            }
          }

          if ((item.existingRecordId || item.expectedVersion !== undefined) && !item.keepBothConfirmed) {
            if (!item.existingRecordId || item.expectedVersion === undefined) {
              output.push({ index: entry.index, status: "conflict", id: null, message: "A atualização explícita exige o registro e a versão que foram exibidos na prévia." });
              conflicts += 1;
              await tx.execute(sql.raw(`RELEASE SAVEPOINT ${savepoint}`));
              continue;
            }
            const [target] = await tx.select({ record: occupancyRecordsTable, name: occupancyModalitiesTable.name })
              .from(occupancyRecordsTable).innerJoin(occupancyModalitiesTable, eq(occupancyModalitiesTable.id, occupancyRecordsTable.modalityId))
              .where(and(eq(occupancyRecordsTable.id, item.existingRecordId), isNull(occupancyRecordsTable.deletedAt))).for("update");
            const before = target?.record;
            const sameNaturalScope = Boolean(target && occupancyKey(target.name) === occupancyKey(entry.modalityName)
              && before!.kind === entry.kind && before!.month === values.month && before!.date === values.date
              && sameLogicalScope(before!.scopeKey, values.scopeKey) && (before!.startTime?.slice(0, 5) ?? null) === values.startTime);
            const sameSourceCell = Boolean(before && before.sourceFileHash === input.fileHash
              && before.sourceSheet === entry.sourceSheet && before.sourceCell === entry.sourceCell);
            if (!before || before.version !== item.expectedVersion || (!sameNaturalScope && !sameSourceCell)) {
              output.push({ index: entry.index, status: "conflict", id: before?.id ?? null, message: "O registro mudou desde a prévia ou não corresponde a este conflito. Atualize a conferência." });
              conflicts += 1;
              await tx.execute(sql.raw(`RELEASE SAVEPOINT ${savepoint}`));
              continue;
            }
            const modality = await resolveOccupancyModality(tx, entry, getUserId(req)!);
            const [changed] = await tx.update(occupancyRecordsTable).set({
              ...values, modalityId: modality.id,
              sourceFileHash: input.fileHash, sourceSheet: entry.sourceSheet, sourceCell: entry.sourceCell, sourceCells: entry.sourceCells,
              version: before.version + 1, updatedBy: getUserId(req)!, updatedAt: new Date(),
            }).where(and(eq(occupancyRecordsTable.id, before.id), eq(occupancyRecordsTable.version, item.expectedVersion), isNull(occupancyRecordsTable.deletedAt))).returning();
            if (!changed) {
              output.push({ index: entry.index, status: "conflict", id: before.id, message: "O registro mudou durante a atualização. Nenhuma alteração foi aplicada." });
              conflicts += 1;
              await tx.execute(sql.raw(`RELEASE SAVEPOINT ${savepoint}`));
              continue;
            }
            await tx.insert(occupancyHistoryTable).values({ entityType: "record", entityId: changed.id, operation: "import_update", actorId: getUserId(req)!, beforeData: before, afterData: changed });
            output.push({ index: entry.index, status: "updated", id: changed.id, message: "Registro atualizado com a versão conferida." });
            updated += 1;
            await tx.execute(sql.raw(`RELEASE SAVEPOINT ${savepoint}`));
            continue;
          }

          const [existingModality] = await tx.select().from(occupancyModalitiesTable)
            .where(eq(occupancyModalitiesTable.normalizedName, occupancyKey(entry.modalityName))).limit(1);
          const [scopeMatch] = existingModality ? await tx.select().from(occupancyRecordsTable).where(and(
            eq(occupancyRecordsTable.modalityId, existingModality.id),
            eq(occupancyRecordsTable.kind, entry.kind),
            eq(occupancyRecordsTable.month, values.month),
            scopeMatches(values.scopeKey),
            values.startTime === null ? isNull(occupancyRecordsTable.startTime) : eq(occupancyRecordsTable.startTime, values.startTime),
            entry.kind === "daily" ? eq(occupancyRecordsTable.date, values.date!) : isNull(occupancyRecordsTable.date),
            isNull(occupancyRecordsTable.deletedAt),
          )).for("update").limit(1) : [];
          if (scopeMatch) {
            if (item.keepBothConfirmed) {
              if (item.existingRecordId || item.expectedVersion !== undefined) {
                const [confirmedTarget] = item.existingRecordId && item.expectedVersion !== undefined
                  ? await tx.select().from(occupancyRecordsTable).where(and(
                    eq(occupancyRecordsTable.id, item.existingRecordId),
                    eq(occupancyRecordsTable.version, item.expectedVersion),
                    isNull(occupancyRecordsTable.deletedAt),
                  )).for("update").limit(1)
                  : [];
                if (!confirmedTarget || confirmedTarget.id !== scopeMatch.id) {
                  output.push({ index: entry.index, status: "conflict", id: scopeMatch.id, message: "O registro comparado mudou desde a prévia. Atualize a conferência antes de manter ambos." });
                  conflicts += 1;
                  await tx.execute(sql.raw(`RELEASE SAVEPOINT ${savepoint}`));
                  continue;
                }
              }
              const duplicateScopeKey = `${values.scopeKey}::import:${input.fileHash.slice(0, 20)}:${encodeURIComponent(entry.sourceSheet)}:${entry.sourceCell}`;
              const modality = existingModality ?? await resolveOccupancyModality(tx, entry, getUserId(req)!);
              const [created] = await tx.insert(occupancyRecordsTable).values({
                ...values, scopeKey: duplicateScopeKey, modalityId: modality.id,
                createdBy: getUserId(req)!, updatedBy: getUserId(req)!,
                sourceFileHash: input.fileHash, sourceSheet: entry.sourceSheet, sourceCell: entry.sourceCell, sourceCells: entry.sourceCells,
              }).onConflictDoNothing().returning();
              if (!created) {
                output.push({ index: entry.index, status: "conflict", id: null, message: "Não foi possível manter a aula distinta sem duplicar a origem. Atualize a prévia." });
                conflicts += 1;
                await tx.execute(sql.raw(`RELEASE SAVEPOINT ${savepoint}`));
                continue;
              }
              await tx.insert(occupancyHistoryTable).values({ entityType: "record", entityId: created.id, operation: "import_create", actorId: getUserId(req)!, afterData: created });
              output.push({ index: entry.index, status: "inserted", id: created.id, message: "Aula distinta importada conforme confirmação; o registro existente foi preservado." });
              inserted += 1;
              await tx.execute(sql.raw(`RELEASE SAVEPOINT ${savepoint}`));
              continue;
            }
            const [scopeModality] = await tx.select().from(occupancyModalitiesTable).where(eq(occupancyModalitiesTable.id, scopeMatch.modalityId)).limit(1);
            const sameSource = scopeMatch.sourceFileHash === input.fileHash
              && scopeMatch.sourceSheet === entry.sourceSheet && scopeMatch.sourceCell === entry.sourceCell;
            const samePayload = scopeMatch.kind === entry.kind && scopeMatch.month === values.month
              && scopeMatch.date === values.date && occupancyKey(scopeModality?.name ?? "") === occupancyKey(entry.modalityName)
              && Number(scopeMatch.percentage) === Number(values.percentage) && sameLogicalScope(scopeMatch.scopeKey, values.scopeKey)
              && scopeMatch.presences === values.presences && scopeMatch.capacity === values.capacity
              && (scopeMatch.startTime?.slice(0, 5) ?? null) === values.startTime
              && (scopeMatch.endTime?.slice(0, 5) ?? null) === values.endTime;
            const alreadyExists = sameSource && samePayload;
            output.push({
              index: entry.index, status: alreadyExists ? "already_imported" : "conflict", id: scopeMatch.id,
              message: alreadyExists ? "Importação simultânea concluída; mantido sem duplicação." : "O escopo já foi preenchido após a prévia. Atualize a conferência; nada foi sobrescrito.",
            });
            if (alreadyExists) alreadyImported += 1; else conflicts += 1;
            await tx.execute(sql.raw(`RELEASE SAVEPOINT ${savepoint}`));
            continue;
          }
          const modality = await resolveOccupancyModality(tx, entry, getUserId(req)!);
          const [created] = await tx.insert(occupancyRecordsTable).values({
            ...values, modalityId: modality.id, createdBy: getUserId(req)!, updatedBy: getUserId(req)!,
            sourceFileHash: input.fileHash, sourceSheet: entry.sourceSheet, sourceCell: entry.sourceCell, sourceCells: entry.sourceCells,
          }).onConflictDoNothing().returning();
          if (!created) {
            const [raced] = await tx.select({ record: occupancyRecordsTable, name: occupancyModalitiesTable.name })
              .from(occupancyRecordsTable).innerJoin(occupancyModalitiesTable, eq(occupancyModalitiesTable.id, occupancyRecordsTable.modalityId))
              .where(and(
                eq(occupancyRecordsTable.sourceFileHash, input.fileHash),
                eq(occupancyRecordsTable.sourceSheet, entry.sourceSheet),
                eq(occupancyRecordsTable.sourceCell, entry.sourceCell),
                isNull(occupancyRecordsTable.deletedAt),
              )).limit(1);
            if (raced) {
              const existing = serializeOccupancy(raced.record, raced.name);
              const same = existing.kind === entry.kind && existing.period === entry.period
                && occupancyKey(existing.modalityName) === occupancyKey(entry.modalityName)
                && Number(existing.percentage) === Number(values.percentage)
                && existing.presences === values.presences && existing.capacity === values.capacity
                && existing.startTime === values.startTime && existing.endTime === values.endTime
                && existing.reportedPercentage === (values.reportedPercentage === null ? null : Number(values.reportedPercentage))
                && occupancyKey(existing.className ?? "") === occupancyKey(entry.className ?? "");
              output.push({
                index: entry.index, status: same ? "already_imported" : "conflict", id: existing.id,
                message: same ? "Importação simultânea concluída; mantido sem duplicação." : "A origem foi gravada com dados diferentes.",
              });
              if (same) alreadyImported += 1; else conflicts += 1;
            } else {
              output.push({ index: entry.index, status: "conflict", id: null, message: "O escopo foi gravado em paralelo. Atualize a prévia antes de continuar." });
              conflicts += 1;
            }
            await tx.execute(sql.raw(`RELEASE SAVEPOINT ${savepoint}`));
            continue;
          }
          await tx.insert(occupancyHistoryTable).values({ entityType: "record", entityId: created.id, operation: "import_create", actorId: getUserId(req)!, afterData: created });
          output.push({ index: entry.index, status: "inserted", id: created.id, message: "Registro importado." });
          inserted += 1;
          await tx.execute(sql.raw(`RELEASE SAVEPOINT ${savepoint}`));
        } catch (error) {
          await tx.execute(sql.raw(`ROLLBACK TO SAVEPOINT ${savepoint}`));
          await tx.execute(sql.raw(`RELEASE SAVEPOINT ${savepoint}`));
          const cause = error as { code?: string; cause?: { code?: string } };
          if (cause.code === "23505" || cause.cause?.code === "23505") {
            output.push({ index: entry.index, status: "conflict", id: null, message: "Registro em conflito com uma gravação simultânea. Nenhum valor foi somado." });
            conflicts += 1;
          } else throw error;
        }
      }
      return { rows: output, inserted, updated, alreadyImported, conflicts };
    });
    res.json(CommitOccupancyImportResponse.parse(rows));
  });
  router.get("/occupancy/modalities", async (_req, res): Promise<void> => {
    const rows = await database.select().from(occupancyModalitiesTable).orderBy(asc(occupancyModalitiesTable.normalizedName));
    res.json(GetOccupancyModalitiesResponse.parse(rows));
  });
  router.post("/occupancy/modalities", async (req, res): Promise<void> => {
    const input = parse(CreateOccupancyModalityBody, req.body);
    const name = cleanOccupancyText(input.name);
    if (!name) throw new OccupancyError(400, "Informe o nome da modalidade.");
    const modality = await database.transaction(async (tx) => {
      const [created] = await tx.insert(occupancyModalitiesTable).values({ name, normalizedName: occupancyKey(name) }).returning();
      await tx.insert(occupancyHistoryTable).values({ entityType: "modality", entityId: created.id, operation: "create", actorId: getUserId(req)!, afterData: created });
      return created;
    });
    res.status(201).json(CreateOccupancyModalityResponse.parse(modality));
  });
  router.patch("/occupancy/modalities/:id", async (req, res): Promise<void> => {
    const { id } = parse(UpdateOccupancyModalityParams, req.params);
    const input = parse(UpdateOccupancyModalityBody, req.body);
    const name = cleanOccupancyText(input.name);
    if (!name) throw new OccupancyError(400, "Informe o nome da modalidade.");
    const modality = await database.transaction(async (tx) => {
      const [before] = await tx.select().from(occupancyModalitiesTable).where(eq(occupancyModalitiesTable.id, id)).for("update");
      if (!before) throw new OccupancyError(404, "Modalidade não encontrada.");
      if (before.version !== input.version) throw new OccupancyError(409, "A modalidade foi alterada. Atualize antes de renomear.");
      const [updated] = await tx.update(occupancyModalitiesTable).set({
        name, normalizedName: occupancyKey(name), version: input.version + 1, updatedAt: new Date(),
      }).where(and(eq(occupancyModalitiesTable.id, id), eq(occupancyModalitiesTable.version, input.version))).returning();
      if (!updated) throw new OccupancyError(409, "A modalidade foi alterada. Atualize antes de renomear.");
      await tx.insert(occupancyHistoryTable).values({ entityType: "modality", entityId: id, operation: "rename", actorId: getUserId(req)!, beforeData: before, afterData: updated });
      return updated;
    });
    res.json(UpdateOccupancyModalityResponse.parse(modality));
  });
  router.delete("/occupancy/modalities/:id", async (req, res): Promise<void> => {
    const { id } = parse(DeleteOccupancyModalityParams, req.params);
    const { version } = parse(DeleteOccupancyModalityBody, req.body);
    const result = await database.transaction(async (tx) => {
      const [modality] = await tx.select().from(occupancyModalitiesTable)
        .where(eq(occupancyModalitiesTable.id, id)).for("update");
      if (!modality) throw new OccupancyError(404, "Modalidade não encontrada. Atualize a lista.");
      if (modality.version !== version) throw new OccupancyError(409, "A modalidade foi alterada. Atualize antes de excluir.");

      const records = await tx.select().from(occupancyRecordsTable)
        .where(eq(occupancyRecordsTable.modalityId, id)).for("update");
      const linkedProducts = await tx.select({ id: productsTable.id }).from(productsTable)
        .where(eq(productsTable.modalityId, id)).for("update");

      if (records.length) {
        for (let offset = 0; offset < records.length; offset += 500) {
          await tx.insert(occupancyHistoryTable).values(records.slice(offset, offset + 500).map((record) => ({
            entityType: "record",
            entityId: record.id,
            operation: "delete",
            actorId: getUserId(req)!,
            beforeData: record,
            afterData: null,
          })));
        }
        await tx.delete(occupancyRecordsTable).where(eq(occupancyRecordsTable.modalityId, id));
      }
      if (linkedProducts.length) {
        await tx.update(productsTable).set({
          modalityId: null,
          version: sql`${productsTable.version} + 1`,
          updatedAt: new Date(),
        }).where(eq(productsTable.modalityId, id));
      }

      await tx.insert(occupancyHistoryTable).values({
        entityType: "modality",
        entityId: id,
        operation: "delete",
        actorId: getUserId(req)!,
        beforeData: {
          ...modality,
          deletedRecords: records.length,
          unlinkedProductIds: linkedProducts.map((product) => product.id),
        },
      });
      const [deleted] = await tx.delete(occupancyModalitiesTable)
        .where(and(eq(occupancyModalitiesTable.id, id), eq(occupancyModalitiesTable.version, version)))
        .returning({ id: occupancyModalitiesTable.id });
      if (!deleted) throw new OccupancyError(409, "A modalidade foi alterada. Atualize antes de excluir.");
      return { modalityId: id, deletedRecords: records.length, unlinkedProducts: linkedProducts.length };
    });
    res.json(DeleteOccupancyModalityResponse.parse(result));
  });
  router.get("/occupancy", async (req, res): Promise<void> => {
    const input = parse(GetOccupancyRecordsQueryParams, req.query);
    const filters: SQL[] = [isNull(occupancyRecordsTable.deletedAt)];
    if (input.months !== undefined && (input.fromDate !== undefined || input.toDate !== undefined)
      || input.fromDate !== undefined && (input.year !== undefined || input.quarter !== undefined)) {
      throw new OccupancyError(400, "Escolha meses/ano/trimestre ou intervalo personalizado, não ambos.");
    }
    if (input.months !== undefined) {
      const months = [...new Set(input.months.split(",").map((m) => m.trim()))];
      if (!months.length || months.some((m) => !validOccupancyMonth(m))) throw new OccupancyError(400, "Selecione meses e anos válidos.");
      filters.push(inArray(occupancyRecordsTable.month, months));
    }
    if (input.year !== undefined) {
      if (!Number.isInteger(input.year) || input.year < 1900 || input.year > 2100) throw new OccupancyError(400, "Selecione um ano entre 1900 e 2100.");
      filters.push(sql`substring(${occupancyRecordsTable.month}, 1, 4) = ${String(input.year)}`);
    }
    if (input.quarter !== undefined) {
      if (!Number.isInteger(input.quarter) || input.quarter < 1 || input.quarter > 4) throw new OccupancyError(400, "Selecione um trimestre válido, de 1 a 4.");
      filters.push(sql`extract(quarter from (${occupancyRecordsTable.month} || '-01')::date) = ${input.quarter}`);
    }
    if (input.fromDate !== undefined || input.toDate !== undefined) {
      if (!input.fromDate || !input.toDate || !validOccupancyDay(input.fromDate) || !validOccupancyDay(input.toDate) || input.fromDate > input.toDate) {
        throw new OccupancyError(400, "Informe um intervalo válido com início e fim.");
      }
      filters.push(or(
        and(eq(occupancyRecordsTable.kind, "daily"), gte(occupancyRecordsTable.date, input.fromDate), lte(occupancyRecordsTable.date, input.toDate)),
        and(eq(occupancyRecordsTable.kind, "monthly"),
          sql`(${occupancyRecordsTable.month} || '-01')::date >= ${input.fromDate}::date`,
          sql`((${occupancyRecordsTable.month} || '-01')::date + interval '1 month - 1 day')::date <= ${input.toDate}::date`),
      )!);
    }
    const startTimes = input.startTimes === undefined ? [] : [...new Set(input.startTimes.split(",").map((value) => value.trim()))];
    if (startTimes.some((value) => !/^([01]\d|2[0-3]):[0-5]\d$/.test(value))) {
      throw new OccupancyError(400, "Selecione horários iniciais válidos no formato HH:mm.");
    }
    const weekdays = input.weekdays === undefined ? [] : [...new Set(input.weekdays.split(",").map((value) => value.trim()))];
    if (weekdays.some((value) => !/^[1-7]$/.test(value))) {
      throw new OccupancyError(400, "Selecione dias da semana entre 1 (segunda-feira) e 7 (domingo).");
    }
    if (startTimes.length || weekdays.length) {
      if (input.kind === "monthly") throw new OccupancyError(400, "Horário e dia da semana só se aplicam a aulas diárias.");
      filters.push(eq(occupancyRecordsTable.kind, "daily"));
    }
    if (startTimes.length) filters.push(inArray(occupancyRecordsTable.startTime, startTimes.map((value) => `${value}:00`)));
    if (weekdays.length) filters.push(sql`extract(isodow from ${occupancyRecordsTable.date})::int in (${sql.join(weekdays.map((day) => sql`${Number(day)}`), sql`, `)})`);
    if (input.modalityId) filters.push(eq(occupancyRecordsTable.modalityId, input.modalityId));
    if (input.className !== undefined) filters.push(scopeMatches(occupancyKey(input.className)));
    if (input.kind && input.kind !== "all") filters.push(eq(occupancyRecordsTable.kind, input.kind));
    const rows = await database.select({ record: occupancyRecordsTable, name: occupancyModalitiesTable.name })
      .from(occupancyRecordsTable).innerJoin(occupancyModalitiesTable, eq(occupancyModalitiesTable.id, occupancyRecordsTable.modalityId))
      .where(and(...filters)).orderBy(desc(occupancyRecordsTable.month), desc(occupancyRecordsTable.date), asc(occupancyModalitiesTable.name));
    res.json(GetOccupancyRecordsResponse.parse(rows.map(({ record, name }) => serializeOccupancy(record, name))));
  });
  router.post("/occupancy", async (req, res): Promise<void> => {
    const input = parse(CreateOccupancyRecordBody, req.body);
    const values = occupancyValues(input);
    const record = await database.transaction(async (tx) => {
      const modality = await resolveOccupancyModality(tx, input, getUserId(req)!);
      const [created] = await tx.insert(occupancyRecordsTable).values({ ...values, modalityId: modality.id, createdBy: getUserId(req)!, updatedBy: getUserId(req)! }).returning();
      await tx.insert(occupancyHistoryTable).values({ entityType: "record", entityId: created.id, operation: "create", actorId: getUserId(req)!, afterData: created });
      return serializeOccupancy(created, modality.name);
    });
    res.status(201).json(CreateOccupancyRecordResponse.parse(record));
  });
  router.patch("/occupancy/:id", async (req, res): Promise<void> => {
    const { id } = parse(UpdateOccupancyRecordParams, req.params);
    const input = parse(UpdateOccupancyRecordBody, req.body);
    const values = occupancyValues(input);
    const record = await database.transaction(async (tx) => {
      const [before] = await tx.select().from(occupancyRecordsTable).where(and(eq(occupancyRecordsTable.id, id), isNull(occupancyRecordsTable.deletedAt))).for("update");
      if (!before) throw new OccupancyError(404, "Registro não encontrado. Atualize o histórico.");
      if (before.version !== input.version) throw new OccupancyError(409, "Este registro foi alterado. Atualize o histórico e reabra a edição.");
      const modality = await resolveOccupancyModality(tx, input, getUserId(req)!);
      const [updated] = await tx.update(occupancyRecordsTable).set({ ...values, modalityId: modality.id, version: input.version + 1, updatedBy: getUserId(req)!, updatedAt: new Date() })
        .where(and(eq(occupancyRecordsTable.id, id), eq(occupancyRecordsTable.version, input.version), isNull(occupancyRecordsTable.deletedAt))).returning();
      if (!updated) throw new OccupancyError(409, "Este registro foi alterado. Atualize o histórico e reabra a edição.");
      await tx.insert(occupancyHistoryTable).values({ entityType: "record", entityId: id, operation: "update", actorId: getUserId(req)!, beforeData: before, afterData: updated });
      return serializeOccupancy(updated, modality.name);
    });
    res.json(UpdateOccupancyRecordResponse.parse(record));
  });
  router.delete("/occupancy/:id", async (req, res): Promise<void> => {
    const { id } = parse(DeleteOccupancyRecordParams, req.params);
    const { version } = parse(DeleteOccupancyRecordBody, req.body);
    await database.transaction(async (tx) => {
      const [before] = await tx.select().from(occupancyRecordsTable).where(and(eq(occupancyRecordsTable.id, id), isNull(occupancyRecordsTable.deletedAt))).for("update");
      if (!before) throw new OccupancyError(404, "Registro não encontrado. Atualize o histórico.");
      if (before.version !== version) throw new OccupancyError(409, "Este registro mudou. Atualize antes de excluir.");
      const [updated] = await tx.update(occupancyRecordsTable).set({ deletedAt: new Date(), updatedAt: new Date(), updatedBy: getUserId(req)!, version: version + 1 })
        .where(and(eq(occupancyRecordsTable.id, id), eq(occupancyRecordsTable.version, version), isNull(occupancyRecordsTable.deletedAt))).returning();
      if (!updated) throw new OccupancyError(409, "Este registro mudou. Atualize antes de excluir.");
      await tx.insert(occupancyHistoryTable).values({ entityType: "record", entityId: id, operation: "delete", actorId: getUserId(req)!, beforeData: before, afterData: updated });
    });
    res.status(204).end();
  });
  router.post("/occupancy/backup/period", async (req, res): Promise<void> => {
    const input = parse(CreateOccupancyBackupBody, req.body);
    try {
      const backup = await createOccupancyBackup(database, input);
      res.json(CreateOccupancyBackupResponse.parse(backup));
    } catch (error) {
      if (error instanceof OccupancyBackupError) throw new OccupancyError(400, error.message);
      throw error;
    }
  });
  router.post("/occupancy/backup/restore/preview", async (req, res): Promise<void> => {
    const rawBackup = (req.body as { backup?: unknown } | null)?.backup;
    try { validateOccupancyBackup(rawBackup); }
    catch (error) {
      if (error instanceof OccupancyBackupError) throw new OccupancyError(400, error.message);
      throw error;
    }
    const input = parse(PreviewOccupancyBackupRestoreBody, req.body);
    try {
      const preview = await previewOccupancyBackupRestore(database, rawBackup);
      res.json(PreviewOccupancyBackupRestoreResponse.parse(preview));
    } catch (error) {
      if (error instanceof OccupancyBackupError) throw new OccupancyError(400, error.message);
      throw error;
    }
  });
  router.post("/occupancy/backup/restore", async (req, res): Promise<void> => {
    const rawBackup = (req.body as { backup?: unknown } | null)?.backup;
    try { validateOccupancyBackup(rawBackup); }
    catch (error) {
      if (error instanceof OccupancyBackupError) throw new OccupancyError(400, error.message);
      throw error;
    }
    const input = parse(RestoreOccupancyBackupBody, req.body);
    try {
      const restored = await restoreOccupancyBackup(database, rawBackup, input.actions, getUserId(req)!);
      res.json(RestoreOccupancyBackupResponse.parse(restored));
    } catch (error) {
      if (error instanceof OccupancyBackupError) throw new OccupancyError(400, error.message);
      throw error;
    }
  });
  router.use((error: unknown, req: Request, res: Response, next: NextFunction) => {
    if (!req.path.startsWith("/occupancy")) { next(error); return; }
    if (error instanceof OccupancyError) { res.status(error.status).json({ error: error.message }); return; }
    const cause = error as { code?: string; cause?: { code?: string } };
    if (cause.code === "23505" || cause.cause?.code === "23505") {
      res.status(409).json({ error: "Já existe um registro para essa modalidade, data, horário e turma. Atualize a base antes de tentar novamente." }); return;
    }
    if (cause.code === "23503" || cause.cause?.code === "23503") {
      res.status(409).json({ error: "A modalidade recebeu novos vínculos durante a exclusão. Atualize a lista e tente novamente." }); return;
    }
    req.log?.error({ code: cause.code ?? cause.cause?.code }, "Falha na operação de ocupação");
    res.status(500).json({ error: "Não foi possível concluir a operação de ocupação. Tente novamente." });
  });
  return router;
}
export default createOccupancyRouter();
