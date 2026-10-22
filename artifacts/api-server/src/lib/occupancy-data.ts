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
const validClassTime = (value: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(value);

export function occupancyValues(input: OccupancyRecordInput) {
  if (!(input.kind === "daily" ? validOccupancyDay(input.period) : validOccupancyMonth(input.period))) {
    throw new OccupancyError(400, input.kind === "daily" ? "Informe uma data válida." : "Informe mês e ano válidos.");
  }
  const name = cleanOccupancyText(input.modalityName);
  if (!name) throw new OccupancyError(400, "Informe a modalidade.");

  const hasMeasurements = input.presences !== undefined || input.capacity !== undefined
    || input.startTime !== undefined || input.endTime != null;
  let percentage: number;
  let reportedPercentage: number | null = null;
  if (hasMeasurements) {
    if (input.kind !== "daily" || input.presences === undefined || input.capacity === undefined
      || !Number.isSafeInteger(input.presences) || input.presences < 0 || input.presences > 2_147_483_647
      || !Number.isSafeInteger(input.capacity) || input.capacity <= 0 || input.capacity > 2_147_483_647
      || !input.startTime || !validClassTime(input.startTime)
      || (input.endTime != null && !validClassTime(input.endTime))) {
      throw new OccupancyError(400, "Informe data, horário inicial válido, presenças inteiras iguais ou maiores que zero e capacidade inteira maior que zero.");
    }
    percentage = Number(((input.presences / input.capacity) * 100).toFixed(6));
    const suppliedPercentage = input.reportedPercentage ?? input.percentage;
    if (suppliedPercentage !== undefined) {
      if (!Number.isFinite(suppliedPercentage) || suppliedPercentage < 0) {
        throw new OccupancyError(400, "O percentual de referência deve ser um número igual ou maior que zero.");
      }
      reportedPercentage = suppliedPercentage;
    }
  } else {
    if (input.percentage === undefined || !Number.isFinite(input.percentage) || input.percentage < 0) {
      throw new OccupancyError(400, "Informe presenças e capacidade, ou um percentual válido para manter um registro legado.");
    }
    percentage = input.percentage;
  }
  const className = input.className ? cleanOccupancyText(input.className) || null : null;
  return {
    kind: input.kind,
    date: input.kind === "daily" ? input.period : null,
    month: input.period.slice(0, 7),
    percentage: String(percentage),
    reportedPercentage: reportedPercentage === null ? null : String(reportedPercentage),
    presences: hasMeasurements ? input.presences! : null,
    capacity: hasMeasurements ? input.capacity! : null,
    startTime: hasMeasurements ? input.startTime! : null,
    endTime: hasMeasurements ? input.endTime ?? null : null,
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
    percentage: Number(record.percentage),
    reportedPercentage: record.reportedPercentage === null ? null : Number(record.reportedPercentage),
    presences: record.presences, capacity: record.capacity,
    startTime: record.startTime?.slice(0, 5) ?? null, endTime: record.endTime?.slice(0, 5) ?? null,
    className: record.className, notes: record.notes,
    sourceFileHash: record.sourceFileHash, sourceSheet: record.sourceSheet,
    sourceCell: record.sourceCell, sourceCells: record.sourceCells,
    version: record.version, createdAt: record.createdAt.toISOString(), updatedAt: record.updatedAt.toISOString(),
  };
}
