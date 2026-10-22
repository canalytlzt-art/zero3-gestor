import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { getAuth } from "@clerk/express";
import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { db, occupancyHistoryTable, occupancyModalitiesTable, occupancyRecordsTable } from "@workspace/db";
import {
  CreateOccupancyModalityBody, CreateOccupancyModalityResponse,
  UpdateOccupancyModalityBody, UpdateOccupancyModalityParams, UpdateOccupancyModalityResponse,
  GetOccupancyModalitiesResponse, GetOccupancyRecordsQueryParams, GetOccupancyRecordsResponse,
  CreateOccupancyRecordBody, CreateOccupancyRecordResponse,
  UpdateOccupancyRecordBody, UpdateOccupancyRecordParams, UpdateOccupancyRecordResponse,
  DeleteOccupancyRecordBody, DeleteOccupancyRecordParams,
  PreviewOccupancyImportBody, PreviewOccupancyImportResponse,
  CommitOccupancyImportBody, CommitOccupancyImportResponse,
  type OccupancyImportRowInput,
} from "@workspace/api-zod";
import { isAuthorizedUser } from "../lib/authorization";
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
  if (!result.success) throw new OccupancyError(400, "Revise os campos obrigatórios, o percentual (0% a 100%) e os formatos informados.");
  return result.data;
}
function validateImportOrigin(row: OccupancyImportRowInput) {
  const cells = row.sourceCells;
  if (!row.sourceSheet.trim() || Object.keys(cells).length < 2 || Object.keys(cells).length > 4
    || !cells.period || !cells.modality || !cells.percentage || cells.percentage !== row.sourceCell) {
    throw new OccupancyError(400, "A origem deve informar aba, células de período/modalidade/percentual e a célula percentual identificada.");
  }
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
      const naturalKey = `${occupancyKey(entry.modalityName)}\u0000${entry.kind}\u0000${values.month}\u0000${values.date ?? ""}\u0000${values.scopeKey}`;
      if (seen.has(sourceKey) || seen.has(naturalKey)) {
        rows.push({ index: entry.index, status: "duplicate_in_file" as const, message: "Esta célula ou escopo já aparece na prévia deste lote.", existingRecord: null });
        continue;
      }
      seen.add(sourceKey);
      seen.add(naturalKey);

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
          && existing.percentage === entry.percentage
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
          eq(occupancyRecordsTable.scopeKey, values.scopeKey),
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
        const naturalKey = `${occupancyKey(entry.modalityName)}\u0000${entry.kind}\u0000${values.month}\u0000${values.date ?? ""}\u0000${values.scopeKey}`;
        if (seen.has(sourceKey) || seen.has(naturalKey)) {
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
              && existing.percentage === entry.percentage
              && occupancyKey(existing.className ?? "") === occupancyKey(entry.className ?? "");
            if (same) {
              output.push({ index: entry.index, status: "already_imported", id: existing.id, message: "Já importado; mantido sem duplicação." });
              alreadyImported += 1;
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

          if (item.existingRecordId || item.expectedVersion !== undefined) {
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
              && before!.scopeKey === values.scopeKey);
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
            eq(occupancyRecordsTable.scopeKey, values.scopeKey),
            entry.kind === "daily" ? eq(occupancyRecordsTable.date, values.date!) : isNull(occupancyRecordsTable.date),
            isNull(occupancyRecordsTable.deletedAt),
          )).for("update").limit(1) : [];
          if (scopeMatch) {
            const [scopeModality] = await tx.select().from(occupancyModalitiesTable).where(eq(occupancyModalitiesTable.id, scopeMatch.modalityId)).limit(1);
            const sameSource = scopeMatch.sourceFileHash === input.fileHash
              && scopeMatch.sourceSheet === entry.sourceSheet && scopeMatch.sourceCell === entry.sourceCell;
            const samePayload = scopeMatch.kind === entry.kind && scopeMatch.month === values.month
              && scopeMatch.date === values.date && occupancyKey(scopeModality?.name ?? "") === occupancyKey(entry.modalityName)
              && Number(scopeMatch.percentage) === entry.percentage && scopeMatch.scopeKey === values.scopeKey;
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
                && existing.percentage === entry.percentage
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
  router.get("/occupancy", async (req, res): Promise<void> => {
    const input = parse(GetOccupancyRecordsQueryParams, req.query);
    const filters: SQL[] = [isNull(occupancyRecordsTable.deletedAt)];
    if (input.months !== undefined && (input.fromDate !== undefined || input.toDate !== undefined)) {
      throw new OccupancyError(400, "Escolha meses ou intervalo, não ambos.");
    }
    if (input.months !== undefined) {
      const months = [...new Set(input.months.split(",").map((m) => m.trim()))];
      if (!months.length || months.some((m) => !validOccupancyMonth(m))) throw new OccupancyError(400, "Selecione meses e anos válidos.");
      filters.push(inArray(occupancyRecordsTable.month, months));
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
    if (input.modalityId) filters.push(eq(occupancyRecordsTable.modalityId, input.modalityId));
    if (input.className !== undefined) filters.push(eq(occupancyRecordsTable.scopeKey, occupancyKey(input.className)));
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
  router.use((error: unknown, req: Request, res: Response, next: NextFunction) => {
    if (!req.path.startsWith("/occupancy")) { next(error); return; }
    if (error instanceof OccupancyError) { res.status(error.status).json({ error: error.message }); return; }
    const cause = error as { code?: string; cause?: { code?: string } };
    if (cause.code === "23505" || cause.cause?.code === "23505") {
      res.status(409).json({ error: "Já existe modalidade com esse nome ou ocupação para essa modalidade, período e turma/horário. Edite o registro existente; os percentuais não serão somados." }); return;
    }
    req.log?.error({ code: cause.code ?? cause.cause?.code }, "Falha na operação de ocupação");
    res.status(500).json({ error: "Não foi possível concluir a operação de ocupação. Tente novamente." });
  });
  return router;
}
export default createOccupancyRouter();
