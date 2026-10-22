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
