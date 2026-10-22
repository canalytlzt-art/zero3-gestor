import { z } from 'zod';
import type {
  MonthlySalesBackupInput,
  MonthlySalesBackupV1,
  MonthlySalesBackupV2,
} from '@workspace/api-client-react';
import { normalizeProductName } from './sales-utils';

const MAX_BACKUP_SALES = 10_000;
const MAX_BACKUP_REFUNDS = 20_000;
const MAX_BACKUP_PRODUCTS = 2_000;
const MAX_BACKUP_GOALS = 500;
const MAX_BACKUP_HISTORIES = 50_000;

function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

const legacyBackupSchema = z.object({
  format: z.literal('zero3-pro-monthly-backup'),
  version: z.literal(1),
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  generatedAt: z.string().datetime(),
  recordCount: z.number().int().min(0).max(MAX_BACKUP_SALES),
  goalCount: z.number().int().min(0).max(MAX_BACKUP_GOALS),
  sales: z.array(z.object({
    id: z.string().uuid(),
    saleDate: z.string().refine(isValidDate),
    productName: z.string().min(1).max(120).refine((value) => normalizeProductName(value).length > 0),
    quantity: z.number().int().min(1).max(2_147_483_647),
    unitAmountCents: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    totalCents: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    notes: z.string().max(1000).nullable(),
    createdAt: z.string().datetime(),
  })).max(MAX_BACKUP_SALES),
  goals: z.array(z.object({
    id: z.string().uuid(),
    month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
    productName: z.string().max(120).refine((value) => normalizeProductName(value).length > 0).nullable(),
    targetCents: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    updatedAt: z.string().datetime(),
  })).max(MAX_BACKUP_GOALS),
}).superRefine((backup, context) => {
  if (backup.recordCount !== backup.sales.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['recordCount'], message: 'A quantidade de lançamentos não corresponde ao conteúdo.' });
  }
  if (backup.goalCount !== backup.goals.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['goalCount'], message: 'A quantidade de metas não corresponde ao conteúdo.' });
  }

  const saleIds = new Set<string>();
  backup.sales.forEach((sale, index) => {
    if (sale.saleDate.slice(0, 7) !== backup.month) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['sales', index, 'saleDate'], message: 'A data do lançamento não pertence ao mês do backup.' });
    }
    const calculatedTotal = sale.quantity * sale.unitAmountCents;
    if (!Number.isSafeInteger(calculatedTotal) || calculatedTotal !== sale.totalCents) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['sales', index, 'totalCents'], message: 'O total do lançamento não confere.' });
    }
    if (saleIds.has(sale.id)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['sales', index, 'id'], message: 'O backup contém um ID de lançamento repetido.' });
    }
    saleIds.add(sale.id);
  });

  const goalScopes = new Set<string>();
  const goalIds = new Set<string>();
  backup.goals.forEach((goal, index) => {
    if (goal.month !== backup.month) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['goals', index, 'month'], message: 'A meta não pertence ao mês do backup.' });
    }
    const scope = goal.productName === null ? 'all-plans' : `plan:${goal.productName.trim().toLocaleLowerCase('pt-BR')}`;
    if (goalScopes.has(scope)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['goals', index, 'productName'], message: 'O backup contém metas duplicadas para o mesmo plano.' });
    }
    if (goalIds.has(goal.id)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['goals', index, 'id'], message: 'O backup contém um ID de meta repetido.' });
    }
    goalScopes.add(scope);
    goalIds.add(goal.id);
  });
});

const uuidSchema = z.string().uuid();
const dateSchema = z.string().refine(isValidDate);
const dateTimeSchema = z.string().datetime();
const nullableTextSchema = z.string().nullable();
const nonNegativeCentsSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

const productRecordSchema = z.object({
  id: uuidSchema,
  name: z.string().min(1).max(120),
  normalizedName: z.string().min(1).max(120),
  suggestedPriceCents: nonNegativeCentsSchema,
  isActive: z.boolean(),
  version: z.number().int().min(1),
  createdAt: dateTimeSchema,
  updatedAt: dateTimeSchema,
}).passthrough();

const saleRecordSchema = z.object({
  id: uuidSchema,
  productId: uuidSchema,
  saleDate: dateSchema,
  productName: z.string().min(1).max(120),
  quantity: z.number().int().min(1).max(2_147_483_647),
  unitAmountCents: nonNegativeCentsSchema,
  totalCents: nonNegativeCentsSchema,
  notes: z.string().max(1000).nullable(),
  status: z.enum(['active', 'cancelled']),
  cancellationReason: nullableTextSchema,
  version: z.number().int().min(1),
  createdBy: nullableTextSchema,
  updatedBy: nullableTextSchema,
  createdAt: dateTimeSchema,
  updatedAt: dateTimeSchema,
}).passthrough();

const refundRecordSchema = z.object({
  id: uuidSchema,
  saleId: uuidSchema,
  refundDate: dateSchema,
  amountCents: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  reason: z.string().min(1).max(1000),
  status: z.enum(['active', 'voided']),
  voidReason: nullableTextSchema,
  version: z.number().int().min(1),
  createdBy: nullableTextSchema,
  updatedBy: nullableTextSchema,
  createdAt: dateTimeSchema,
  updatedAt: dateTimeSchema,
}).passthrough();

const goalRecordSchema = z.object({
  id: uuidSchema,
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  scopeKey: z.string().min(1),
  productId: uuidSchema.nullable(),
  productName: z.string().max(120).nullable(),
  targetCents: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  version: z.number().int().min(1),
  updatedAt: dateTimeSchema,
}).passthrough();

const historyRecordSchema = z.object({
  id: uuidSchema,
  entityType: z.string().min(1),
  entityId: uuidSchema,
  operation: z.string().min(1),
  actorId: z.string().min(1),
  beforeData: z.record(z.string(), z.unknown()).nullable(),
  afterData: z.record(z.string(), z.unknown()).nullable(),
  createdAt: dateTimeSchema,
}).passthrough();

const scopedRecordSchema = <T extends z.ZodTypeAny>(record: T) => z.object({
  scope: z.enum(['period', 'dependency']),
  record,
});

const monthlyBackupV2Schema = z.object({
  schemaVersion: z.literal(2),
  generatedAt: dateTimeSchema,
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  currency: z.literal('BRL'),
  businessTimezone: z.literal('America/Sao_Paulo'),
  counts: z.object({
    periodSales: z.number().int().min(0),
    periodRefunds: z.number().int().min(0),
    periodGoals: z.number().int().min(0),
    dependencySales: z.number().int().min(0),
    dependencyRefunds: z.number().int().min(0),
    products: z.number().int().min(0),
    histories: z.number().int().min(0),
    totalRecords: z.number().int().min(0),
  }),
  products: z.array(scopedRecordSchema(productRecordSchema)).max(MAX_BACKUP_PRODUCTS),
  sales: z.array(scopedRecordSchema(saleRecordSchema)).max(MAX_BACKUP_SALES),
  refunds: z.array(scopedRecordSchema(refundRecordSchema)).max(MAX_BACKUP_REFUNDS),
  goals: z.array(scopedRecordSchema(goalRecordSchema)).max(MAX_BACKUP_GOALS),
  histories: z.array(scopedRecordSchema(historyRecordSchema)).max(MAX_BACKUP_HISTORIES),
}).superRefine((backup, context) => {
  const expectedCounts = {
    periodSales: backup.sales.filter(({ scope }) => scope === 'period').length,
    periodRefunds: backup.refunds.filter(({ scope }) => scope === 'period').length,
    periodGoals: backup.goals.filter(({ scope }) => scope === 'period').length,
    dependencySales: backup.sales.filter(({ scope }) => scope === 'dependency').length,
    dependencyRefunds: backup.refunds.filter(({ scope }) => scope === 'dependency').length,
    products: backup.products.length,
    histories: backup.histories.length,
  };
  const totalRecords = Object.values(expectedCounts).reduce((sum, count) => sum + count, 0);
  for (const [key, expected] of Object.entries(expectedCounts)) {
    if (backup.counts[key as keyof typeof expectedCounts] !== expected) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['counts', key], message: 'A quantidade de registros não corresponde ao conteúdo do backup.' });
    }
  }
  if (backup.counts.totalRecords !== totalRecords) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['counts', 'totalRecords'], message: 'A quantidade total não corresponde ao conteúdo do backup.' });
  }

  const uniqueIds = (items: Array<{ record: { id: string } }>, path: string) => {
    const seen = new Set<string>();
    items.forEach(({ record }, index) => {
      if (seen.has(record.id)) context.addIssue({ code: z.ZodIssueCode.custom, path: [path, index, 'record', 'id'], message: 'O backup contém um ID repetido.' });
      seen.add(record.id);
    });
  };
  uniqueIds(backup.products, 'products');
  uniqueIds(backup.sales, 'sales');
  uniqueIds(backup.refunds, 'refunds');
  uniqueIds(backup.goals, 'goals');
  uniqueIds(backup.histories, 'histories');

  const productIds = new Set(backup.products.map(({ record }) => record.id));
  const saleIds = new Set(backup.sales.map(({ record }) => record.id));
  const goalScopes = new Set<string>();
  backup.sales.forEach(({ scope, record }, index) => {
    if ((scope === 'period') !== (record.saleDate.slice(0, 7) === backup.period)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['sales', index, 'scope'], message: 'A classificação do lançamento não corresponde ao mês do backup.' });
    }
    const total = record.quantity * record.unitAmountCents;
    if (!Number.isSafeInteger(total) || total !== record.totalCents) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['sales', index, 'record', 'totalCents'], message: 'O total do lançamento não confere.' });
    }
    if (!productIds.has(record.productId)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['sales', index, 'record', 'productId'], message: 'O produto associado não está incluído no backup.' });
    }
    if ((record.status === 'active' && record.cancellationReason !== null) || (record.status === 'cancelled' && !record.cancellationReason?.trim())) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['sales', index, 'record', 'cancellationReason'], message: 'O motivo de cancelamento não corresponde à situação da venda.' });
    }
  });
  backup.refunds.forEach(({ scope, record }, index) => {
    if ((scope === 'period') !== (record.refundDate.slice(0, 7) === backup.period)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['refunds', index, 'scope'], message: 'A classificação do estorno não corresponde ao mês do backup.' });
    }
    if (!saleIds.has(record.saleId)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['refunds', index, 'record', 'saleId'], message: 'A venda vinculada não está incluída no backup.' });
    }
    if ((record.status === 'active' && record.voidReason !== null) || (record.status === 'voided' && !record.voidReason?.trim())) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['refunds', index, 'record', 'voidReason'], message: 'O motivo de anulação não corresponde à situação do estorno.' });
    }
  });
  backup.goals.forEach(({ scope, record }, index) => {
    if (scope !== 'period' || record.month !== backup.period) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['goals', index, 'scope'], message: 'As metas do backup devem pertencer ao mês selecionado.' });
    }
    if (record.productId !== null && !productIds.has(record.productId)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['goals', index, 'record', 'productId'], message: 'O produto associado à meta não está incluído no backup.' });
    }
    const scopeKey = `${record.month}:${record.scopeKey}`;
    if (goalScopes.has(scopeKey)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['goals', index, 'record', 'scopeKey'], message: 'O backup contém metas repetidas para o mesmo escopo.' });
    }
    goalScopes.add(scopeKey);
  });
});

export function parseMonthlySalesBackup(value: unknown): MonthlySalesBackupInput {
  if (value && typeof value === 'object' && 'schemaVersion' in value && value.schemaVersion === 2) {
    const parsed = monthlyBackupV2Schema.safeParse(value);
    if (!parsed.success) {
      throw new Error(parsed.error.issues[0]?.message ?? 'O arquivo não é um backup mensal válido.');
    }
    return parsed.data as MonthlySalesBackupV2;
  }
  const legacy = legacyBackupSchema.safeParse(value);
  if (legacy.success) return legacy.data as MonthlySalesBackupV1;
  throw new Error('O arquivo não é um backup mensal válido ou sua versão não é suportada.');
}

export function downloadMonthlyBackup(backup: MonthlySalesBackupV2) {
  const contents = JSON.stringify(backup, null, 2);
  const blob = new Blob([contents], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `zero3-pro-backup-${backup.period}.json`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
