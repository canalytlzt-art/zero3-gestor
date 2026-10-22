import { and, eq } from "drizzle-orm";
import { db, occupancyHistoryTable, occupancyModalitiesTable, type OccupancyRecordRow } from "@workspace/db";
import type { OccupancyRecordInput } from "@workspace/api-zod";

export class OccupancyError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export const cleanOccupancyText = (value: string) => value.trim().replace(/\s+/g, " ");
export const occupancyKey = (value: string) => cleanOccupancyText(value).toLocaleLowerCase("pt-BR");
export const validOccupancyDay = (value: string) => {
  if (!/^[0-9]{4}-(0[1-9]|1[0-2])-[0-9]{2}$/.test(value) || value.startsWith("0000")) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};
export const validOccupancyMonth = (value: string) => /^[0-9]{4}-(0[1-9]|1[0-2])$/.test(value) && !value.startsWith("0000");

export function occupancyValues(input: OccupancyRecordInput) {
  if (!(input.kind === "daily" ? validOccupancyDay(input.period) : validOccupancyMonth(input.period))) {
    throw new OccupancyError(400, input.kind === "daily" ? "Informe uma data válida." : "Informe mês e ano válidos.");
  }
  const name = cleanOccupancyText(input.modalityName);
  if (!name) throw new OccupancyError(400, "Informe a modalidade.");
  if (!Number.isFinite(input.percentage) || input.percentage < 0 || input.percentage > 100) {
    throw new OccupancyError(400, "Percentual pendente de revisão: informe de 0% a 100%, sem ajuste automático.");
  }
  const className = input.className ? cleanOccupancyText(input.className) || null : null;
  return {
    kind: input.kind,
    date: input.kind === "daily" ? input.period : null,
    month: input.period.slice(0, 7),
    percentage: String(input.percentage),
    className,
    scopeKey: className ? occupancyKey(className) : "",
    notes: input.notes?.trim() || null,
  };
}

type OccupancyConnection = Pick<typeof db, "select" | "insert" | "update">;
export async function resolveOccupancyModality(tx: OccupancyConnection, input: OccupancyRecordInput, actorId: string) {
  if (input.modalityId) {
    const [modality] = await tx.select().from(occupancyModalitiesTable).where(eq(occupancyModalitiesTable.id, input.modalityId));
    if (!modality) throw new OccupancyError(404, "Modalidade não encontrada. Atualize a lista.");
    return modality;
  }
  const name = cleanOccupancyText(input.modalityName);
  const key = occupancyKey(name);
  const [created] = await tx.insert(occupancyModalitiesTable).values({ name, normalizedName: key })
    .onConflictDoNothing({ target: occupancyModalitiesTable.normalizedName }).returning();
  if (created) {
    await tx.insert(occupancyHistoryTable).values({
      entityType: "modality", entityId: created.id, operation: "create", actorId, afterData: created,
    });
    return created;
  }
  const [existing] = await tx.select().from(occupancyModalitiesTable).where(and(eq(occupancyModalitiesTable.normalizedName, key)));
  if (!existing) throw new OccupancyError(409, "A modalidade mudou. Atualize e tente novamente.");
  return existing;
}

export function serializeOccupancy(record: OccupancyRecordRow, modalityName: string) {
  return {
    id: record.id, kind: record.kind, period: record.kind === "daily" ? record.date! : record.month,
    month: record.month, modalityId: record.modalityId, modalityName,
    percentage: Number(record.percentage), className: record.className, notes: record.notes,
    version: record.version, createdAt: record.createdAt.toISOString(), updatedAt: record.updatedAt.toISOString(),
  };
}
