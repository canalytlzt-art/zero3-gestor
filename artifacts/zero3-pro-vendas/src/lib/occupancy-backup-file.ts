import { z } from 'zod';
import type { OccupancyBackup } from '@workspace/api-client-react';

const isDateTime = (value: string) =>
  Number.isFinite(Date.parse(value)) && /(?:Z|[+-]\d{2}:\d{2})$/.test(value);
const dateTime = z.string().refine(isDateTime, 'Data e hora do backup inválidas.');
const uuid = z.string().uuid();
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).refine((value) => value.slice(0, 4) !== '0000');
const day = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/)
  .refine((value) => new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value);

const selectionSchema = z.object({
  mode: z.enum(['months', 'quarter', 'range', 'all']),
  months: z.array(month).max(120).optional(),
  year: z.number().int().min(1900).max(2100).optional(),
  quarter: z.number().int().min(1).max(4).optional(),
  fromDate: day.optional(),
  toDate: day.optional(),
  modalityId: uuid.nullable().optional(),
  startTimes: z.array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)).optional(),
  weekdays: z.array(z.number().int().min(1).max(7)).optional(),
  className: z.string().max(120).nullable().optional(),
}).passthrough();

const modalitySchema = z.object({
  id: uuid,
  name: z.string().min(1).max(120),
  version: z.number().int().min(1),
}).passthrough();

const recordSchema = z.object({
  id: uuid,
  kind: z.enum(['daily', 'monthly']),
  period: z.string(),
  month,
  modalityId: uuid,
  modalityName: z.string().min(1).max(120),
  percentage: z.number().finite().min(0),
  reportedPercentage: z.number().finite().min(0).nullable(),
  presences: z.number().int().min(0).nullable(),
  capacity: z.number().int().min(1).nullable(),
  aggregatorPresences: z.number().int().min(0).nullable().optional(),
  startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable(),
  endTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable(),
  className: z.string().nullable(),
  notes: z.string().nullable(),
  sourceFileHash: z.string().nullable(),
  sourceSheet: z.string().nullable(),
  sourceCell: z.string().nullable(),
  sourceCells: z.record(z.string(), z.string()).nullable(),
  version: z.number().int().min(1),
  createdAt: dateTime,
  updatedAt: dateTime,
}).passthrough();

const backupSchema = z.object({
  format: z.literal('zero3-pro-occupancy-backup'),
  schemaVersion: z.literal(1),
  module: z.literal('occupancy'),
  origin: z.literal('zero3-pro-occupancy-database'),
  generatedAt: dateTime,
  period: z.string().min(1),
  selection: selectionSchema,
  partial: z.boolean(),
  counts: z.object({
    records: z.number().int().min(0).max(50_000),
    dailyRecords: z.number().int().min(0),
    monthlyRecords: z.number().int().min(0),
    modalities: z.number().int().min(0),
    totalRecords: z.number().int().min(0),
  }),
  summary: z.object({
    measuredRecords: z.number().int().min(0),
    legacyRecords: z.number().int().min(0),
    presences: z.number().int().min(0),
    capacity: z.number().int().min(0),
    weightedPercentage: z.number().finite().min(0).nullable(),
  }),
  modalities: z.array(modalitySchema).max(2000),
  records: z.array(z.object({
    scope: z.literal('period'),
    scopeKey: z.string(),
    record: recordSchema,
  }).passthrough()).max(50_000),
}).passthrough().superRefine((backup, context) => {
  if (backup.counts.records !== backup.records.length
    || backup.counts.totalRecords !== backup.records.length
    || backup.counts.modalities !== backup.modalities.length
    || backup.counts.dailyRecords !== backup.records.filter(({ record }) => record.kind === 'daily').length
    || backup.counts.monthlyRecords !== backup.records.filter(({ record }) => record.kind === 'monthly').length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['counts'], message: 'As contagens não correspondem aos registros.' });
  }
  const modalityIds = new Set(backup.modalities.map(({ id }) => id));
  const recordIds = new Set<string>();
  for (const [index, envelope] of backup.records.entries()) {
    const record = envelope.record;
    const expectedPeriod = record.kind === 'daily' ? day.safeParse(record.period).success
      : month.safeParse(record.period).success;
    if (!expectedPeriod || record.period.slice(0, 7) !== record.month || !modalityIds.has(record.modalityId)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['records', index], message: 'Período ou modalidade inválidos.' });
    }
    if (recordIds.has(record.id)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['records', index, 'record', 'id'], message: 'ID de registro repetido.' });
    }
    recordIds.add(record.id);
    if ((record.presences === null) !== (record.capacity === null)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['records', index, 'record'], message: 'Presenças e vagas devem estar preenchidas juntas.' });
    }
    if ((record.presences === null && record.startTime !== null)
      || (record.kind === 'monthly' && (record.presences !== null || record.capacity !== null || record.startTime !== null || record.endTime !== null))) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['records', index, 'record'], message: 'O tipo de registro não permite os horários ou contagens informados.' });
    }
    if (record.aggregatorPresences != null
      && (record.presences === null || record.aggregatorPresences > record.presences)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['records', index, 'record', 'aggregatorPresences'], message: 'Agregadores deve estar dentro do total de presenças.' });
    }
    if (record.presences !== null && record.capacity !== null
      && Math.abs(record.percentage - record.presences / record.capacity * 100) > 0.00001) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['records', index, 'record', 'percentage'], message: 'Percentual incompatível com presenças e vagas.' });
    }
  }
});

export function parseOccupancyBackupFile(json: string): OccupancyBackup {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error('O arquivo não contém JSON válido.');
  }
  const result = backupSchema.safeParse(value);
  if (!result.success) throw new Error(result.error.issues[0]?.message ?? 'O arquivo não é um backup de ocupação válido.');
  return result.data as OccupancyBackup;
}

export const MAX_OCCUPANCY_BACKUP_BYTES = 8 * 1024 * 1024;
