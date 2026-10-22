import { z } from 'zod';
import type {
  MonthlySalesBackupInput,
  Sale,
  SalesGoal,
} from '@workspace/api-client-react';
import { normalizeProductName, productNameKey } from './sales-utils';

const MAX_BACKUP_SALES = 10_000;
const MAX_BACKUP_GOALS = 500;

function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

const monthlyBackupSchema = z.object({
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
    if (normalizeProductName(sale.productName) !== sale.productName) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['sales', index, 'productName'], message: 'O nome do plano contém espaços excedentes.' });
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
    if (goal.productName !== null && normalizeProductName(goal.productName) !== goal.productName) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['goals', index, 'productName'], message: 'O nome do plano da meta contém espaços excedentes.' });
    }
    const scope = goal.productName === null ? 'all-plans' : `plan:${productNameKey(goal.productName)}`;
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

export function parseMonthlySalesBackup(value: unknown): MonthlySalesBackupInput {
  const parsed = monthlyBackupSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(issue?.message ?? 'O arquivo não é um backup mensal válido.');
  }
  return parsed.data;
}

export function createMonthlySalesBackup(
  month: string,
  sales: Sale[],
  goals: SalesGoal[],
): MonthlySalesBackupInput {
  const monthSales = sales
    .filter((sale) => sale.saleDate.slice(0, 7) === month)
    .slice()
    .sort((a, b) => a.saleDate.localeCompare(b.saleDate) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const monthGoals = goals
    .filter((goal) => goal.month === month)
    .slice()
    .sort((a, b) => (a.productName ?? '').localeCompare(b.productName ?? '', 'pt-BR'));

  return {
    format: 'zero3-pro-monthly-backup',
    version: 1,
    month,
    generatedAt: new Date().toISOString(),
    recordCount: monthSales.length,
    goalCount: monthGoals.length,
    sales: monthSales.map((sale) => ({
      id: sale.id,
      saleDate: sale.saleDate,
      productName: sale.productName,
      quantity: sale.quantity,
      unitAmountCents: sale.unitAmountCents,
      totalCents: sale.totalCents,
      notes: sale.notes,
      createdAt: sale.createdAt,
    })),
    goals: monthGoals.map((goal) => ({
      id: goal.id,
      month: goal.month,
      productName: goal.productName,
      targetCents: goal.targetCents,
      updatedAt: goal.updatedAt,
    })),
  };
}

export function downloadMonthlyBackup(backup: MonthlySalesBackupInput) {
  const contents = JSON.stringify(backup, null, 2);
  const blob = new Blob([contents], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `zero3-pro-backup-${backup.month}.json`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
