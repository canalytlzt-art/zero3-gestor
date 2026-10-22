import { randomUUID } from "node:crypto";
import { getAuth } from "@clerk/express";
import {
  CancelSaleBody,
  CancelSaleParams,
  CancelSaleResponse,
  CreateProductBody,
  CreateProductResponse,
  CreateSalesRefundBody,
  CreateSalesRefundParams,
  CreateSalesRefundResponse,
  CreateSaleBody,
  CreateSaleResponse,
  GetAccessStatusResponse,
  GetProductsResponse,
  GetSaleHistoryParams,
  GetSaleHistoryResponse,
  GetSalesScoreboardQueryParams,
  GetSalesScoreboardResponse,
  GetSalesRefundCandidatesResponse,
  GetSalesRefundHistoryParams,
  GetSalesRefundHistoryResponse,
  GetSalesRefundsResponse,
  GetSalesHistoryResponse,
  GetSalesGoalsResponse,
  GetSalesResponse,
  GetMonthlySalesBackupQueryParams,
  GetMonthlySalesBackupResponse,
  ImportSalesBody,
  ImportSalesResponse,
  MonthlySalesBackupV1,
  MonthlySalesBackupV2,
  PreviewMonthlySalesBackupRestoreBody,
  PreviewMonthlySalesBackupRestoreResponse,
  RestoreMonthlySalesBackupBody,
  RestoreMonthlySalesBackupResponse,
  UpdateProductBody,
  UpdateProductParams,
  UpdateProductResponse,
  UpdateSalesRefundBody,
  UpdateSalesRefundParams,
  UpdateSalesRefundResponse,
  UpsertSalesGoalBody,
  UpsertSalesGoalResponse,
  UpdateSaleBody,
  UpdateSaleParams,
  UpdateSaleResponse,
  VoidSalesRefundBody,
  VoidSalesRefundParams,
  VoidSalesRefundResponse,
} from "@workspace/api-zod";
import {
  db,
  productsTable,
  salesGoalsTable,
  salesHistoryTable,
  salesImportBatchesTable,
  salesRefundsTable,
  salesTable,
} from "@workspace/db";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod/v4";
import { isAuthorizedUser } from "../lib/authorization";
import {
  calculateSaleTotalCents,
  getBusinessMonthKey,
  getOrCreateProduct,
  IdempotencyConflictError,
  lockSaleForRefund,
  monthKeysBetween,
  normalizeProductName,
  parseSaleDate,
  ProductUnavailableError,
  PRODUCT_NAME_LOCK_KEY,
  PRODUCT_NAME_LOCK_NAMESPACE,
  productNameKey,
  recordSalesHistory,
  runIdempotent,
  SaleUnavailableForRefundError,
  VersionConflictError,
} from "../lib/sales-data";

type DatabaseTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type RestoreEntityType = "product" | "sale" | "refund" | "goal" | "history";
type RestoreConflict = {
  entityType: RestoreEntityType;
  id: string;
  reason: string;
  blocking: boolean;
};
type RestoreCounts = {
  products: number;
  sales: number;
  refunds: number;
  goals: number;
  histories: number;
};
type RestoreAnalysis = {
  preview: {
    period: string;
    dependencyMonths: string[];
    toInsert: RestoreCounts;
    identical: RestoreCounts;
    conflicts: RestoreConflict[];
    blocked: boolean;
  };
  rows: {
    products: Array<typeof productsTable.$inferSelect>;
    sales: Array<typeof salesTable.$inferSelect>;
    refunds: Array<typeof salesRefundsTable.$inferSelect>;
    goals: Array<typeof salesGoalsTable.$inferSelect>;
    histories: Array<typeof salesHistoryTable.$inferSelect>;
  };
  snapshot: Record<string, unknown>;
};

const backupProductSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(120),
    normalizedName: z.string().min(1).max(120),
    suggestedPriceCents: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    isActive: z.boolean(),
    version: z.number().int().min(1),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .passthrough();
const backupSaleSchema = z
  .object({
    id: z.string().uuid(),
    productId: z.string().uuid(),
    saleDate: z
      .string()
      .refine((value) => parseSaleDate(value) !== null, "Invalid sale date"),
    productName: z.string().trim().min(1).max(120),
    quantity: z.number().int().min(1).max(2_147_483_647),
    unitAmountCents: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    totalCents: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    customerName: z.string().max(120).nullable().optional(),
    notes: z.string().max(1000).nullable(),
    status: z.enum(["active", "cancelled"]),
    cancellationReason: z.string().nullable(),
    version: z.number().int().min(1),
    createdBy: z.string().nullable(),
    updatedBy: z.string().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .passthrough();
const backupRefundSchema = z
  .object({
    id: z.string().uuid(),
    saleId: z.string().uuid(),
    refundDate: z
      .string()
      .refine((value) => parseSaleDate(value) !== null, "Invalid refund date"),
    amountCents: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    reason: z.string().trim().min(1).max(1000),
    status: z.enum(["active", "voided"]),
    voidReason: z.string().nullable(),
    version: z.number().int().min(1),
    createdBy: z.string().nullable(),
    updatedBy: z.string().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .passthrough();
const backupGoalSchema = z
  .object({
    id: z.string().uuid(),
    month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
    scopeKey: z.string().min(1).max(200),
    productId: z.string().uuid().nullable(),
    productName: z.string().nullable(),
    targetCents: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    version: z.number().int().min(1),
    updatedAt: z.string().datetime(),
  })
  .passthrough();
const backupHistorySchema = z
  .object({
    id: z.string().uuid(),
    entityType: z.enum(["sale", "refund", "product", "goal"]),
    entityId: z.string().uuid(),
    operation: z.string().trim().min(1).max(100),
    actorId: z.string().min(1).max(255),
    beforeData: z.record(z.string(), z.unknown()).nullable(),
    afterData: z.record(z.string(), z.unknown()).nullable(),
    createdAt: z.string().datetime(),
  })
  .passthrough();
const backupEnvelopeSchema = <T extends z.ZodTypeAny>(record: T) =>
  z.object({
    scope: z.enum(["period", "dependency"]),
    record,
  });
const monthlyBackupV2RuntimeSchema = z
  .object({
    schemaVersion: z.literal(2),
    generatedAt: z.string().datetime(),
    period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
    currency: z.literal("BRL"),
    businessTimezone: z.literal("America/Sao_Paulo"),
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
    products: z.array(backupEnvelopeSchema(backupProductSchema)).max(2000),
    sales: z.array(backupEnvelopeSchema(backupSaleSchema)).max(10000),
    refunds: z.array(backupEnvelopeSchema(backupRefundSchema)).max(20000),
    goals: z.array(backupEnvelopeSchema(backupGoalSchema)).max(500),
    histories: z.array(backupEnvelopeSchema(backupHistorySchema)).max(50000),
  })
  .superRefine((backup, context) => {
    const expected = {
      periodSales: backup.sales.filter((item) => item.scope === "period")
        .length,
      periodRefunds: backup.refunds.filter((item) => item.scope === "period")
        .length,
      periodGoals: backup.goals.filter((item) => item.scope === "period")
        .length,
      dependencySales: backup.sales.filter(
        (item) => item.scope === "dependency",
      ).length,
      dependencyRefunds: backup.refunds.filter(
        (item) => item.scope === "dependency",
      ).length,
      products: backup.products.length,
      histories: backup.histories.length,
    };
    const totalRecords = Object.values(expected).reduce(
      (sum, count) => sum + count,
      0,
    );
    for (const [key, value] of Object.entries(expected)) {
      if (backup.counts[key as keyof typeof expected] !== value) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["counts", key],
          message: "Backup record counts do not match the included records",
        });
      }
    }
    if (backup.counts.totalRecords !== totalRecords) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["counts", "totalRecords"],
        message: "Backup total record count does not match its contents",
      });
    }

    const uniqueIds = (
      records: Array<{ record: { id: string } }>,
      path: string,
    ) => {
      const seen = new Set<string>();
      records.forEach(({ record }, index) => {
        if (seen.has(record.id))
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [path, index, "record", "id"],
            message: "Backup contains duplicate IDs",
          });
        seen.add(record.id);
      });
    };
    uniqueIds(backup.products, "products");
    uniqueIds(backup.sales, "sales");
    uniqueIds(backup.refunds, "refunds");
    uniqueIds(backup.goals, "goals");
    uniqueIds(backup.histories, "histories");

    const products = new Map(
      backup.products.map(({ record }) => [record.id, record]),
    );
    const sales = new Map(
      backup.sales.map(({ record }) => [record.id, record]),
    );
    const productNames = new Set<string>();
    backup.products.forEach(({ record }, index) => {
      const normalized = productNameKey(record.name);
      if (
        record.normalizedName !== normalized ||
        productNames.has(normalized)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["products", index, "record", "normalizedName"],
          message: "Backup contains an invalid or duplicate product name",
        });
      }
      productNames.add(normalized);
    });
    backup.sales.forEach(({ scope, record }, index) => {
      if (
        (scope === "period") !==
        (record.saleDate.slice(0, 7) === backup.period)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["sales", index, "scope"],
          message: "Sale scope does not match its date",
        });
      }
      const total = calculateSaleTotalCents(
        record.quantity,
        record.unitAmountCents,
      );
      if (
        total === null ||
        total !== record.totalCents ||
        !products.has(record.productId)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["sales", index, "record"],
          message: "Sale total or product reference is invalid",
        });
      }
      if (
        (record.status === "active" && record.cancellationReason !== null) ||
        (record.status === "cancelled" && !record.cancellationReason?.trim())
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["sales", index, "record", "cancellationReason"],
          message: "Sale cancellation reason does not match its status",
        });
      }
    });
    backup.refunds.forEach(({ scope, record }, index) => {
      if (
        (scope === "period") !==
          (record.refundDate.slice(0, 7) === backup.period) ||
        !sales.has(record.saleId)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["refunds", index, "record"],
          message: "Refund date or linked sale is invalid",
        });
      }
      if (
        (record.status === "active" && record.voidReason !== null) ||
        (record.status === "voided" && !record.voidReason?.trim())
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["refunds", index, "record", "voidReason"],
          message: "Refund void reason does not match its status",
        });
      }
      const sale = sales.get(record.saleId);
      if (
        sale &&
        record.status === "active" &&
        (sale.status !== "active" || record.refundDate < sale.saleDate)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["refunds", index, "record"],
          message:
            "Active refund requires an active sale on or before its date",
        });
      }
    });
    const goalScopes = new Set<string>();
    backup.goals.forEach(({ scope, record }, index) => {
      const key = `${record.month}:${record.scopeKey}`;
      if (
        scope !== "period" ||
        record.month !== backup.period ||
        (record.productId !== null && !products.has(record.productId)) ||
        goalScopes.has(key)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["goals", index, "record"],
          message: "Goal month, product, or scope is invalid",
        });
      }
      if (
        (record.productId === null &&
          (record.scopeKey !== "all-plans" || record.productName !== null)) ||
        (record.productId !== null &&
          (record.scopeKey !== `product:${record.productId}` ||
            !record.productName))
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["goals", index, "record"],
          message: "Goal product scope is inconsistent",
        });
      }
      goalScopes.add(key);
    });
    const refundedBySale = new Map<string, bigint>();
    for (const { record } of backup.refunds) {
      if (record.status !== "active") continue;
      refundedBySale.set(
        record.saleId,
        (refundedBySale.get(record.saleId) ?? 0n) + BigInt(record.amountCents),
      );
    }
    for (const [saleId, refunded] of refundedBySale) {
      const sale = sales.get(saleId);
      if (sale && refunded > BigInt(sale.totalCents)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["refunds"],
          message: "Active refunds exceed the linked sale total",
        });
      }
    }
    const linkedIds = {
      product: new Set(backup.products.map(({ record }) => record.id)),
      sale: new Set(backup.sales.map(({ record }) => record.id)),
      refund: new Set(backup.refunds.map(({ record }) => record.id)),
      goal: new Set(backup.goals.map(({ record }) => record.id)),
    };
    backup.histories.forEach(({ record }, index) => {
      if (!linkedIds[record.entityType].has(record.entityId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["histories", index],
          message: "History record is not associated with an included entity",
        });
      }
    });
  });

function stableJson(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (item instanceof Date) return item.toISOString();
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === "object") {
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, nested]) => [key, normalize(nested)]),
      );
    }
    return item;
  };
  return JSON.stringify(normalize(value));
}

function emptyRestoreCounts(): RestoreCounts {
  return { products: 0, sales: 0, refunds: 0, goals: 0, histories: 0 };
}

function uniqueConflicts(conflicts: RestoreConflict[]) {
  return [
    ...new Map(
      conflicts.map((item) => [
        `${item.entityType}:${item.id}:${item.reason}`,
        item,
      ]),
    ).values(),
  ];
}

async function analyzeMonthlyBackupRestore(
  tx: DatabaseTransaction,
  backup: MonthlySalesBackupV2,
): Promise<RestoreAnalysis> {
  const incomingProducts = backup.products.map(
    ({ record }) => record as unknown as typeof productsTable.$inferSelect,
  );
  const incomingSales = backup.sales.map(
    ({ record }) =>
      ({
        ...record,
        customerName: record.customerName ?? null,
      }) as unknown as typeof salesTable.$inferSelect,
  );
  const incomingRefunds = backup.refunds.map(
    ({ record }) => record as unknown as typeof salesRefundsTable.$inferSelect,
  );
  const incomingGoals = backup.goals.map(
    ({ record }) => record as unknown as typeof salesGoalsTable.$inferSelect,
  );
  const incomingHistories = backup.histories.map(
    ({ record }) => record as unknown as typeof salesHistoryTable.$inferSelect,
  );
  const ids = {
    products: [...new Set(incomingProducts.map(({ id }) => id))],
    sales: [...new Set(incomingSales.map(({ id }) => id))],
    refunds: [...new Set(incomingRefunds.map(({ id }) => id))],
    goals: [...new Set(incomingGoals.map(({ id }) => id))],
    histories: [...new Set(incomingHistories.map(({ id }) => id))],
  };
  const saleIdsForRefundCheck = [
    ...new Set([
      ...incomingSales.map(({ id }) => id),
      ...incomingRefunds.map(({ saleId }) => saleId),
    ]),
  ];
  const scopeKeys = [...new Set(incomingGoals.map(({ scopeKey }) => scopeKey))];
  const normalizedNames = [
    ...new Set(incomingProducts.map(({ normalizedName }) => normalizedName)),
  ];
  const existingProductsById = ids.products.length
    ? await tx
        .select()
        .from(productsTable)
        .where(inArray(productsTable.id, ids.products))
    : [];
  const existingSales = ids.sales.length
    ? await tx
        .select()
        .from(salesTable)
        .where(inArray(salesTable.id, ids.sales))
    : [];
  const existingRefundsById = ids.refunds.length
    ? await tx
        .select()
        .from(salesRefundsTable)
        .where(inArray(salesRefundsTable.id, ids.refunds))
    : [];
  const existingGoalsById = ids.goals.length
    ? await tx
        .select()
        .from(salesGoalsTable)
        .where(inArray(salesGoalsTable.id, ids.goals))
    : [];
  const existingHistories = ids.histories.length
    ? await tx
        .select()
        .from(salesHistoryTable)
        .where(inArray(salesHistoryTable.id, ids.histories))
    : [];
  const existingProductsByName = normalizedNames.length
    ? await tx
        .select()
        .from(productsTable)
        .where(inArray(productsTable.normalizedName, normalizedNames))
    : [];
  const existingGoalsByScope = scopeKeys.length
    ? await tx
        .select()
        .from(salesGoalsTable)
        .where(
          and(
            eq(salesGoalsTable.month, backup.period),
            inArray(salesGoalsTable.scopeKey, scopeKeys),
          ),
        )
    : [];
  const existingRefundsForSales = saleIdsForRefundCheck.length
    ? await tx
        .select()
        .from(salesRefundsTable)
        .where(inArray(salesRefundsTable.saleId, saleIdsForRefundCheck))
    : [];

  const existing = {
    products: new Map(existingProductsById.map((row) => [row.id, row])),
    sales: new Map(existingSales.map((row) => [row.id, row])),
    refunds: new Map(existingRefundsById.map((row) => [row.id, row])),
    goals: new Map(existingGoalsById.map((row) => [row.id, row])),
    histories: new Map(existingHistories.map((row) => [row.id, row])),
  };
  const rows: RestoreAnalysis["rows"] = {
    products: [],
    sales: [],
    refunds: [],
    goals: [],
    histories: [],
  };
  const toInsert = emptyRestoreCounts();
  const identical = emptyRestoreCounts();
  const conflicts: RestoreConflict[] = [];

  const compare = <T extends { id: string }>(
    type: RestoreEntityType,
    values: T[],
    current: Map<string, T>,
    key: keyof RestoreCounts,
    insertRows: T[],
  ) => {
    for (const row of values) {
      const existingRow = current.get(row.id);
      if (!existingRow) {
        insertRows.push(row);
        toInsert[key] += 1;
      } else if (stableJson(existingRow) === stableJson(row)) {
        identical[key] += 1;
      } else {
        conflicts.push({
          entityType: type,
          id: row.id,
          reason:
            "O ID já existe com conteúdo diferente; o registro atual será mantido.",
          blocking: false,
        });
      }
    }
  };
  compare(
    "product",
    incomingProducts,
    existing.products,
    "products",
    rows.products,
  );
  compare("sale", incomingSales, existing.sales, "sales", rows.sales);
  compare("refund", incomingRefunds, existing.refunds, "refunds", rows.refunds);
  compare("goal", incomingGoals, existing.goals, "goals", rows.goals);
  compare(
    "history",
    incomingHistories,
    existing.histories,
    "histories",
    rows.histories,
  );

  const productsByName = new Map(
    existingProductsByName.map((row) => [row.normalizedName, row]),
  );
  const blockedProductIds = new Set<string>();
  rows.products = rows.products.filter((row) => {
    const conflict = productsByName.get(row.normalizedName);
    if (!conflict || conflict.id === row.id) return true;
    toInsert.products -= 1;
    blockedProductIds.add(row.id);
    conflicts.push({
      entityType: "product",
      id: row.id,
      reason: `O nome já pertence ao produto ${conflict.id}; IDs de produto não são remapeados.`,
      blocking: true,
    });
    return false;
  });

  const existingGoalScopes = new Map(
    existingGoalsByScope.map((row) => [row.scopeKey, row]),
  );
  rows.goals = rows.goals.filter((row) => {
    const conflict = existingGoalScopes.get(row.scopeKey);
    if (!conflict || conflict.id === row.id) return true;
    toInsert.goals -= 1;
    conflicts.push({
      entityType: "goal",
      id: row.id,
      reason: `Já existe uma meta para este escopo (${conflict.id}); a meta atual será mantida.`,
      blocking: false,
    });
    return false;
  });

  const existingProductIds = new Set(existingProductsById.map(({ id }) => id));
  const restorableProductIds = new Set([
    ...existingProductIds,
    ...rows.products.map(({ id }) => id),
  ]);
  let blocked = blockedProductIds.size > 0;
  for (const sale of rows.sales) {
    if (
      !restorableProductIds.has(sale.productId) ||
      blockedProductIds.has(sale.productId)
    ) {
      blocked = true;
      conflicts.push({
        entityType: "sale",
        id: sale.id,
        reason: "O produto necessário não pode ser restaurado com segurança.",
        blocking: true,
      });
    }
  }
  for (const goal of rows.goals) {
    if (
      goal.productId &&
      (!restorableProductIds.has(goal.productId) ||
        blockedProductIds.has(goal.productId))
    ) {
      blocked = true;
      conflicts.push({
        entityType: "goal",
        id: goal.id,
        reason:
          "O produto necessário à meta não pode ser restaurado com segurança.",
        blocking: true,
      });
    }
  }

  const availableSales = new Map(existingSales.map((sale) => [sale.id, sale]));
  for (const sale of incomingSales)
    if (!availableSales.has(sale.id)) availableSales.set(sale.id, sale);
  for (const refund of incomingRefunds) {
    const sale = availableSales.get(refund.saleId);
    if (!sale) {
      blocked = true;
      conflicts.push({
        entityType: "refund",
        id: refund.id,
        reason: "A venda original não existe e não está incluída no backup.",
        blocking: true,
      });
    } else if (
      rows.refunds.some(({ id }) => id === refund.id) &&
      refund.status === "active" &&
      (sale.status !== "active" || refund.refundDate < sale.saleDate)
    ) {
      blocked = true;
      conflicts.push({
        entityType: "refund",
        id: refund.id,
        reason:
          "O estorno ativo exige uma venda ativa com data anterior ou igual ao estorno.",
        blocking: true,
      });
    }
  }
  const refundsBySale = new Map<
    string,
    Map<string, typeof salesRefundsTable.$inferSelect>
  >();
  for (const refund of existingRefundsForSales) {
    const group = refundsBySale.get(refund.saleId) ?? new Map();
    group.set(refund.id, refund);
    refundsBySale.set(refund.saleId, group);
  }
  for (const refund of rows.refunds) {
    const group = refundsBySale.get(refund.saleId) ?? new Map();
    group.set(refund.id, refund);
    refundsBySale.set(refund.saleId, group);
  }
  for (const [saleId, refunds] of refundsBySale) {
    const sale = availableSales.get(saleId);
    if (!sale) continue;
    const activeTotal = [...refunds.values()]
      .filter(({ status }) => status === "active")
      .reduce((sum, refund) => sum + BigInt(refund.amountCents), 0n);
    if (activeTotal > BigInt(sale.totalCents)) {
      blocked = true;
      conflicts.push({
        entityType: "refund",
        id: saleId,
        reason: "A combinação ultrapassaria o valor da venda original.",
        blocking: true,
      });
    }
  }

  const effectiveEntityIds = {
    product: new Set([
      ...existing.products.keys(),
      ...rows.products.map(({ id }) => id),
    ]),
    sale: new Set([
      ...existing.sales.keys(),
      ...rows.sales.map(({ id }) => id),
    ]),
    refund: new Set([
      ...existing.refunds.keys(),
      ...rows.refunds.map(({ id }) => id),
    ]),
    goal: new Set([
      ...existing.goals.keys(),
      ...rows.goals.map(({ id }) => id),
    ]),
  };
  rows.histories = rows.histories.filter((row) => {
    const idsForType =
      effectiveEntityIds[row.entityType as keyof typeof effectiveEntityIds];
    if (idsForType?.has(row.entityId)) return true;
    toInsert.histories -= 1;
    conflicts.push({
      entityType: "history",
      id: row.id,
      reason:
        "O registro associado não será incluído por conflito; seu histórico também será mantido fora da restauração.",
      blocking: false,
    });
    return false;
  });
  const dependencyMonths = [
    ...new Set([
      ...backup.sales
        .filter(({ scope }) => scope === "dependency")
        .map(({ record }) => String(record.saleDate).slice(0, 7)),
      ...backup.refunds
        .filter(({ scope }) => scope === "dependency")
        .map(({ record }) => String(record.refundDate).slice(0, 7)),
    ]),
  ]
    .filter((month) => month !== backup.period)
    .sort();
  const snapshot = {
    period: backup.period,
    products: [
      ...new Map(
        [...existingProductsById, ...existingProductsByName].map((row) => [
          row.id,
          row,
        ]),
      ).values(),
    ],
    sales: existingSales,
    refunds: existingRefundsForSales,
    goals: [
      ...new Map(
        [...existingGoalsById, ...existingGoalsByScope].map((row) => [
          row.id,
          row,
        ]),
      ).values(),
    ],
    histories: existingHistories,
    plannedInsertIds: Object.fromEntries(
      Object.entries(rows).map(([key, records]) => [
        key,
        records.map(({ id }) => id),
      ]),
    ),
  };
  return {
    preview: {
      period: backup.period,
      dependencyMonths,
      toInsert,
      identical,
      conflicts: uniqueConflicts(conflicts),
      blocked,
    },
    rows,
    snapshot,
  };
}

export class RestoreBlockedError extends Error {}

export async function applyMonthlyBackupRestore(
  tx: DatabaseTransaction,
  backup: MonthlySalesBackupV2,
  actorId: string,
) {
  await tx.execute(
    sql`lock table products, sales, sales_refunds, sales_goals, sales_history in share row exclusive mode`,
  );
  const analysis = await analyzeMonthlyBackupRestore(tx, backup);
  if (analysis.preview.blocked)
    throw new RestoreBlockedError(
      "A restauração foi bloqueada: confira os conflitos de vínculos ou saldo na prévia.",
    );
  await tx.insert(salesHistoryTable).values({
    id: randomUUID(),
    entityType: "restore-snapshot",
    entityId: randomUUID(),
    operation: "pre-restore-backup",
    actorId,
    beforeData: null,
    afterData: analysis.snapshot,
  });
  const inserted = emptyRestoreCounts();
  for (const row of analysis.rows.products) {
    await tx.insert(productsTable).values({
      ...row,
      createdAt: new Date(String(row.createdAt)),
      updatedAt: new Date(String(row.updatedAt)),
    });
    inserted.products += 1;
  }
  for (const row of analysis.rows.sales) {
    await tx.insert(salesTable).values({
      ...row,
      createdAt: new Date(String(row.createdAt)),
      updatedAt: new Date(String(row.updatedAt)),
    });
    inserted.sales += 1;
  }
  for (const row of analysis.rows.refunds) {
    await tx.insert(salesRefundsTable).values({
      ...row,
      createdAt: new Date(String(row.createdAt)),
      updatedAt: new Date(String(row.updatedAt)),
    });
    inserted.refunds += 1;
  }
  for (const row of analysis.rows.goals) {
    await tx
      .insert(salesGoalsTable)
      .values({ ...row, updatedAt: new Date(String(row.updatedAt)) });
    inserted.goals += 1;
  }
  for (const row of analysis.rows.histories) {
    await tx
      .insert(salesHistoryTable)
      .values({ ...row, createdAt: new Date(String(row.createdAt)) });
    inserted.histories += 1;
  }
  return {
    period: backup.period,
    inserted,
    identical: analysis.preview.identical,
    conflicts: analysis.preview.conflicts,
  };
}

function serializeBackupRow<T extends Record<string, unknown>>(
  row: T,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      value instanceof Date ? value.toISOString() : value,
    ]),
  );
}

function backupEnvelope(
  scope: "period" | "dependency",
  row: Record<string, unknown>,
) {
  return { scope, record: serializeBackupRow(row) };
}

export async function buildMonthlySalesBackup(
  period: string,
  executor?: DatabaseTransaction,
) {
  const [year, month] = period.split("-").map(Number);
  const fromDate = `${period}-01`;
  const toDate = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);

  const read = async (tx: DatabaseTransaction) => {
    const periodSales = await tx
      .select()
      .from(salesTable)
      .where(
        and(
          gte(salesTable.saleDate, fromDate),
          lte(salesTable.saleDate, toDate),
        ),
      );
    const periodRefunds = await tx
      .select()
      .from(salesRefundsTable)
      .where(
        and(
          gte(salesRefundsTable.refundDate, fromDate),
          lte(salesRefundsTable.refundDate, toDate),
        ),
      );
    const periodGoals = await tx
      .select()
      .from(salesGoalsTable)
      .where(eq(salesGoalsTable.month, period));

    const saleIds = [
      ...new Set([
        ...periodSales.map(({ id }) => id),
        ...periodRefunds.map(({ saleId }) => saleId),
      ]),
    ];
    const allSales = saleIds.length
      ? await tx
          .select()
          .from(salesTable)
          .where(inArray(salesTable.id, saleIds))
      : [];
    const refundsForIncludedSales = saleIds.length
      ? await tx
          .select()
          .from(salesRefundsTable)
          .where(inArray(salesRefundsTable.saleId, saleIds))
      : [];
    const allProductIds = [
      ...new Set([
        ...allSales.map(({ productId }) => productId),
        ...periodGoals.flatMap(({ productId }) =>
          productId ? [productId] : [],
        ),
      ]),
    ];
    const products = allProductIds.length
      ? await tx
          .select()
          .from(productsTable)
          .where(inArray(productsTable.id, allProductIds))
      : [];
    const entityIds = [
      ...new Set([
        ...allSales.map(({ id }) => id),
        ...refundsForIncludedSales.map(({ id }) => id),
        ...products.map(({ id }) => id),
        ...periodGoals.map(({ id }) => id),
      ]),
    ];
    const historyConditions: SQL[] = [];
    for (const [type, ids] of [
      ["sale", allSales.map(({ id }) => id)],
      ["refund", refundsForIncludedSales.map(({ id }) => id)],
      ["product", products.map(({ id }) => id)],
      ["goal", periodGoals.map(({ id }) => id)],
    ] as Array<[string, string[]]>) {
      if (ids.length) {
        historyConditions.push(
          and(
            eq(salesHistoryTable.entityType, type),
            inArray(salesHistoryTable.entityId, ids),
          )!,
        );
      }
    }
    const histories = entityIds.length
      ? await tx
          .select()
          .from(salesHistoryTable)
          .where(or(...historyConditions))
      : [];

    const periodSaleIds = new Set(periodSales.map(({ id }) => id));
    const periodRefundIds = new Set(periodRefunds.map(({ id }) => id));
    const sales = allSales.map((row) =>
      backupEnvelope(
        periodSaleIds.has(row.id) ? "period" : "dependency",
        row as unknown as Record<string, unknown>,
      ),
    );
    const refunds = refundsForIncludedSales.map((row) =>
      backupEnvelope(
        periodRefundIds.has(row.id) ? "period" : "dependency",
        row as unknown as Record<string, unknown>,
      ),
    );
    const goals = periodGoals.map((row) =>
      backupEnvelope("period", row as unknown as Record<string, unknown>),
    );
    const productRecords = products.map((row) =>
      backupEnvelope("dependency", row as unknown as Record<string, unknown>),
    );
    const historyRecords = histories.map((row) =>
      backupEnvelope("dependency", row as unknown as Record<string, unknown>),
    );
    const counts = {
      periodSales: sales.filter(({ scope }) => scope === "period").length,
      periodRefunds: refunds.filter(({ scope }) => scope === "period").length,
      periodGoals: goals.length,
      dependencySales: sales.filter(({ scope }) => scope === "dependency")
        .length,
      dependencyRefunds: refunds.filter(({ scope }) => scope === "dependency")
        .length,
      products: productRecords.length,
      histories: historyRecords.length,
      totalRecords:
        sales.length +
        refunds.length +
        goals.length +
        productRecords.length +
        historyRecords.length,
    };

    return {
      schemaVersion: 2,
      generatedAt: new Date().toISOString(),
      period,
      currency: "BRL",
      businessTimezone: "America/Sao_Paulo",
      counts,
      products: productRecords,
      sales,
      refunds,
      goals,
      histories: historyRecords,
    };
  };
  return executor
    ? read(executor)
    : db.transaction(async (tx) => {
        await tx.execute(sql`set transaction isolation level repeatable read`);
        return read(tx);
      });
}

export type SalesRouterDependencies = {
  database?: typeof db;
  getUserId?: (req: Request) => string | null;
  isAuthorized?: (req: Request) => Promise<boolean>;
};

export function createSalesRouter(
  dependencies: SalesRouterDependencies = {},
): IRouter {
  const router: IRouter = Router();
  const database = dependencies.database ?? db;
  const getUserId =
    dependencies.getUserId ?? ((req) => getAuth(req).userId ?? null);
  const isAuthorized = dependencies.isAuthorized ?? isAuthorizedUser;

  async function requireSalesAccess(
    req: Request,
    res: Response,
  ): Promise<boolean> {
    const userId = getUserId(req);
    if (!userId) {
      res.status(401).json({ error: "Authentication required" });
      return false;
    }

    if (!(await isAuthorized(req))) {
      res
        .status(403)
        .json({ error: "Access is restricted to authorized users" });
      return false;
    }

    return true;
  }

  router.get("/access-status", async (req, res): Promise<void> => {
    const userId = getUserId(req);
    if (!userId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    const data = GetAccessStatusResponse.parse({
      authorized: await isAuthorized(req),
    });
    res.json(data);
  });

  router.get("/products", async (req, res): Promise<void> => {
    if (!(await requireSalesAccess(req, res))) return;

    const products = await db
      .select()
      .from(productsTable)
      .orderBy(asc(productsTable.normalizedName));

    res.json(GetProductsResponse.parse(products));
  });

  router.post("/products", async (req, res): Promise<void> => {
    if (!(await requireSalesAccess(req, res))) return;
    const parsed = CreateProductBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const name = normalizeProductName(parsed.data.name);
    const normalizedName = productNameKey(name);
    if (!name || name.length > 120) {
      res.status(400).json({ error: "Enter a valid product name" });
      return;
    }
    const actorId = getAuth(req).userId!;
    try {
      const result = await db.transaction(async (tx) =>
        runIdempotent(
          tx,
          {
            actorId,
            operation: "product-create",
            key: parsed.data.idempotencyKey,
            request: { ...parsed.data, name, normalizedName },
          },
          async () => {
            await tx.execute(
              sql`select pg_advisory_xact_lock(${PRODUCT_NAME_LOCK_NAMESPACE}, ${PRODUCT_NAME_LOCK_KEY})`,
            );
            const [existing] = await tx
              .select()
              .from(productsTable)
              .where(eq(productsTable.normalizedName, normalizedName))
              .limit(1);
            if (existing)
              throw new Error("A product with this name already exists");

            const [product] = await tx
              .insert(productsTable)
              .values({
                name,
                normalizedName,
                suggestedPriceCents: parsed.data.suggestedPriceCents,
                isActive: parsed.data.isActive,
              })
              .returning();
            if (!product) throw new Error("Could not create product");
            await recordSalesHistory(tx, {
              entityType: "product",
              entityId: product.id,
              operation: "create",
              actorId,
              afterData: product,
            });
            return product;
          },
        ),
      );
      res
        .status(result.replayed ? 200 : 201)
        .json(CreateProductResponse.parse(result.value));
    } catch (error) {
      if (
        error instanceof IdempotencyConflictError ||
        (error instanceof Error && error.message.includes("already exists"))
      ) {
        res.status(409).json({ error: error.message });
      } else {
        throw error;
      }
    }
  });

  router.patch("/products/:id", async (req, res): Promise<void> => {
    if (!(await requireSalesAccess(req, res))) return;
    const params = UpdateProductParams.safeParse(req.params);
    const parsed = UpdateProductBody.safeParse(req.body);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const name = normalizeProductName(parsed.data.name);
    const normalizedName = productNameKey(name);
    if (!name || name.length > 120) {
      res.status(400).json({ error: "Enter a valid product name" });
      return;
    }
    const actorId = getAuth(req).userId!;
    try {
      const result = await db.transaction(async (tx) =>
        runIdempotent(
          tx,
          {
            actorId,
            operation: `product-update:${params.data.id}`,
            key: parsed.data.idempotencyKey,
            request: { ...parsed.data, name, normalizedName },
          },
          async () => {
            await tx.execute(
              sql`select pg_advisory_xact_lock(${PRODUCT_NAME_LOCK_NAMESPACE}, ${PRODUCT_NAME_LOCK_KEY})`,
            );
            const [current] = await tx
              .select()
              .from(productsTable)
              .where(eq(productsTable.id, params.data.id))
              .for("update")
              .limit(1);
            if (!current) throw new Error("Product not found");
            if (current.version !== parsed.data.expectedVersion)
              throw new VersionConflictError();

            const [duplicate] = await tx
              .select({ id: productsTable.id })
              .from(productsTable)
              .where(eq(productsTable.normalizedName, normalizedName))
              .limit(1);
            if (duplicate && duplicate.id !== current.id)
              throw new Error("A product with this name already exists");

            const [updated] = await tx
              .update(productsTable)
              .set({
                name,
                normalizedName,
                suggestedPriceCents: parsed.data.suggestedPriceCents,
                isActive: parsed.data.isActive,
                version: current.version + 1,
                updatedAt: new Date(),
              })
              .where(eq(productsTable.id, current.id))
              .returning();
            if (!updated) throw new Error("Product not found");
            await recordSalesHistory(tx, {
              entityType: "product",
              entityId: updated.id,
              operation: "update",
              actorId,
              beforeData: current,
              afterData: updated,
            });
            return updated;
          },
        ),
      );
      res.json(UpdateProductResponse.parse(result.value));
    } catch (error) {
      if (
        error instanceof IdempotencyConflictError ||
        error instanceof VersionConflictError ||
        (error instanceof Error && error.message.includes("already exists"))
      ) {
        res.status(409).json({ error: error.message });
      } else if (
        error instanceof Error &&
        error.message === "Product not found"
      ) {
        res.status(404).json({ error: error.message });
      } else {
        throw error;
      }
    }
  });

  router.get("/sales", async (req, res): Promise<void> => {
    if (!(await requireSalesAccess(req, res))) return;

    const sales = await db
      .select()
      .from(salesTable)
      .where(eq(salesTable.status, "active"))
      .orderBy(desc(salesTable.saleDate), desc(salesTable.createdAt));

    res.json(GetSalesResponse.parse(sales));
  });

  router.get("/sales/history", async (req, res): Promise<void> => {
    if (!(await requireSalesAccess(req, res))) return;
    const sales = await db
      .select()
      .from(salesTable)
      .orderBy(desc(salesTable.saleDate), desc(salesTable.createdAt));
    res.json(GetSalesHistoryResponse.parse(sales));
  });

  router.get("/sales/scoreboard", async (req, res): Promise<void> => {
    if (!(await requireSalesAccess(req, res))) return;
    const rawMonths = req.query.months;
    const monthsInput =
      typeof rawMonths === "string"
        ? rawMonths.split(",")
        : Array.isArray(rawMonths)
          ? rawMonths.flatMap((value) =>
              typeof value === "string" ? value.split(",") : [],
            )
          : undefined;
    const queryDate = (value: unknown) =>
      typeof value === "string" && parseSaleDate(value)
        ? new Date(`${value}T00:00:00.000Z`)
        : value;
    const parsed = GetSalesScoreboardQueryParams.safeParse({
      fromDate: queryDate(req.query.fromDate),
      toDate: queryDate(req.query.toDate),
      months: monthsInput,
      productId: req.query.productId,
    });
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const fromDate = parsed.data.fromDate?.toISOString().slice(0, 10);
    const toDate = parsed.data.toDate?.toISOString().slice(0, 10);
    const selectedMonths = [...new Set(parsed.data.months ?? [])].sort();
    if (
      (fromDate && !toDate) ||
      (!fromDate && toDate) ||
      (selectedMonths.length > 0 && (fromDate || toDate)) ||
      (fromDate && toDate && fromDate > toDate)
    ) {
      res.status(400).json({
        error: "Choose either complete date bounds or month keys, not both",
      });
      return;
    }
    if (selectedMonths.some((month) => !parseSaleDate(`${month}-01`))) {
      res.status(400).json({ error: "Choose valid year-month values" });
      return;
    }

    const saleFilters: SQL[] = [eq(salesTable.status, "active")];
    const refundFilters: SQL[] = [eq(salesRefundsTable.status, "active")];
    if (fromDate && toDate) {
      saleFilters.push(
        gte(salesTable.saleDate, fromDate),
        lte(salesTable.saleDate, toDate),
      );
      refundFilters.push(
        gte(salesRefundsTable.refundDate, fromDate),
        lte(salesRefundsTable.refundDate, toDate),
      );
    } else if (selectedMonths.length) {
      saleFilters.push(
        inArray(
          sql<string>`to_char(${salesTable.saleDate}, 'YYYY-MM')`,
          selectedMonths,
        ),
      );
      refundFilters.push(
        inArray(
          sql<string>`to_char(${salesRefundsTable.refundDate}, 'YYYY-MM')`,
          selectedMonths,
        ),
      );
    }
    if (parsed.data.productId) {
      saleFilters.push(eq(salesTable.productId, parsed.data.productId));
      refundFilters.push(eq(salesTable.productId, parsed.data.productId));
    }

    const saleMonth = sql<string>`to_char(${salesTable.saleDate}, 'YYYY-MM')`;
    const saleRows = await db
      .select({
        productId: salesTable.productId,
        productName: productsTable.name,
        month: saleMonth,
        quantity: sql<string>`coalesce(sum(${salesTable.quantity}), 0)::text`,
        salesCents: sql<string>`coalesce(sum(${salesTable.totalCents}), 0)::text`,
      })
      .from(salesTable)
      .innerJoin(productsTable, eq(productsTable.id, salesTable.productId))
      .where(and(...saleFilters))
      .groupBy(salesTable.productId, productsTable.name, saleMonth);

    const refundMonth = sql<string>`to_char(${salesRefundsTable.refundDate}, 'YYYY-MM')`;
    const refundRows = await db
      .select({
        productId: salesTable.productId,
        productName: productsTable.name,
        month: refundMonth,
        refundCents: sql<string>`coalesce(sum(${salesRefundsTable.amountCents}), 0)::text`,
      })
      .from(salesRefundsTable)
      .innerJoin(salesTable, eq(salesTable.id, salesRefundsTable.saleId))
      .innerJoin(productsTable, eq(productsTable.id, salesTable.productId))
      .where(and(...refundFilters))
      .groupBy(salesTable.productId, productsTable.name, refundMonth);

    type ProductAggregate = {
      productId: string;
      productName: string;
      quantity: bigint;
      salesCents: bigint;
      refundCents: bigint;
    };
    type MonthAggregate = {
      quantity: bigint;
      salesCents: bigint;
      refundCents: bigint;
    };
    const productTotals = new Map<string, ProductAggregate>();
    const monthTotals = new Map<string, MonthAggregate>();
    const getProduct = (
      productId: string,
      productName: string,
    ): ProductAggregate => {
      const current = productTotals.get(productId);
      if (current) return current;
      const created = {
        productId,
        productName,
        quantity: 0n,
        salesCents: 0n,
        refundCents: 0n,
      };
      productTotals.set(productId, created);
      return created;
    };
    const getMonth = (month: string): MonthAggregate => {
      const current = monthTotals.get(month);
      if (current) return current;
      const created = { quantity: 0n, salesCents: 0n, refundCents: 0n };
      monthTotals.set(month, created);
      return created;
    };

    for (const row of saleRows) {
      const quantity = BigInt(row.quantity);
      const salesCents = BigInt(row.salesCents);
      const product = getProduct(row.productId, row.productName);
      product.quantity += quantity;
      product.salesCents += salesCents;
      const month = getMonth(row.month);
      month.quantity += quantity;
      month.salesCents += salesCents;
    }
    for (const row of refundRows) {
      const refundCents = BigInt(row.refundCents);
      getProduct(row.productId, row.productName).refundCents += refundCents;
      getMonth(row.month).refundCents += refundCents;
    }

    let monthKeys = selectedMonths;
    if (!monthKeys.length && fromDate && toDate) {
      monthKeys = monthKeysBetween(fromDate.slice(0, 7), toDate.slice(0, 7));
    } else if (!monthKeys.length) {
      const observed = [...monthTotals.keys()].sort();
      const currentMonth = getBusinessMonthKey();
      const firstMonth =
        observed.length && observed[0] < currentMonth
          ? observed[0]
          : currentMonth;
      const lastObserved = observed.at(-1);
      const lastMonth =
        lastObserved && lastObserved > currentMonth
          ? lastObserved
          : currentMonth;
      monthKeys = monthKeysBetween(firstMonth, lastMonth);
    }
    if (parsed.data.productId && !productTotals.has(parsed.data.productId)) {
      const [product] = await db
        .select({ id: productsTable.id, name: productsTable.name })
        .from(productsTable)
        .where(eq(productsTable.id, parsed.data.productId))
        .limit(1);
      if (product) getProduct(product.id, product.name);
    }

    const safeNumber = (value: bigint, label: string): number => {
      if (
        value > BigInt(Number.MAX_SAFE_INTEGER) ||
        value < BigInt(Number.MIN_SAFE_INTEGER)
      ) {
        throw new Error(`Scoreboard ${label} exceeds the safe integer range`);
      }
      return Number(value);
    };
    const products = [...productTotals.values()]
      .sort(
        (a, b) =>
          a.productName.localeCompare(b.productName, "pt-BR", {
            sensitivity: "base",
          }) || a.productId.localeCompare(b.productId),
      )
      .map((row) => ({
        productId: row.productId,
        productName: row.productName,
        quantity: safeNumber(row.quantity, "quantity"),
        salesCents: safeNumber(row.salesCents, "sales"),
        refundCents: safeNumber(row.refundCents, "refunds"),
        netCents: safeNumber(row.salesCents - row.refundCents, "net revenue"),
      }));
    const months = monthKeys.map((month) => {
      const row = monthTotals.get(month) ?? {
        quantity: 0n,
        salesCents: 0n,
        refundCents: 0n,
      };
      return {
        month,
        quantity: safeNumber(row.quantity, "monthly quantity"),
        salesCents: safeNumber(row.salesCents, "monthly sales"),
        refundCents: safeNumber(row.refundCents, "monthly refunds"),
        netCents: safeNumber(
          row.salesCents - row.refundCents,
          "monthly net revenue",
        ),
      };
    });
    const totals = products.reduce(
      (total, row) => ({
        quantity: total.quantity + BigInt(row.quantity),
        salesCents: total.salesCents + BigInt(row.salesCents),
        refundCents: total.refundCents + BigInt(row.refundCents),
      }),
      { quantity: 0n, salesCents: 0n, refundCents: 0n },
    );
    res.json(
      GetSalesScoreboardResponse.parse({
        totals: {
          quantity: safeNumber(totals.quantity, "total quantity"),
          salesCents: safeNumber(totals.salesCents, "total sales"),
          refundCents: safeNumber(totals.refundCents, "total refunds"),
          netCents: safeNumber(
            totals.salesCents - totals.refundCents,
            "total net revenue",
          ),
        },
        products,
        months,
      }),
    );
  });

  router.get("/sales/refund-candidates", async (req, res): Promise<void> => {
    if (!(await requireSalesAccess(req, res))) return;
    const rows = await db
      .select({
        sale: salesTable,
        refundedCents: sql<string>`coalesce(sum(${salesRefundsTable.amountCents}), 0)::text`,
      })
      .from(salesTable)
      .leftJoin(
        salesRefundsTable,
        and(
          eq(salesRefundsTable.saleId, salesTable.id),
          eq(salesRefundsTable.status, "active"),
        ),
      )
      .where(eq(salesTable.status, "active"))
      .groupBy(salesTable.id)
      .orderBy(
        desc(salesTable.saleDate),
        desc(salesTable.createdAt),
        desc(salesTable.id),
      );

    const candidates = rows.flatMap(({ sale, refundedCents }) => {
      const refunded = BigInt(refundedCents);
      const total = BigInt(sale.totalCents);
      if (refunded > total) {
        throw new Error(`Active refunds exceed sale ${sale.id}`);
      }
      const remaining = total - refunded;
      if (remaining <= 0n) return [];
      return [
        {
          saleId: sale.id,
          saleDate: sale.saleDate,
          productId: sale.productId,
          productName: sale.productName,
          quantity: sale.quantity,
          totalCents: sale.totalCents,
          refundedCents: Number(refunded),
          remainingCents: Number(remaining),
          version: sale.version,
        },
      ];
    });
    res.json(GetSalesRefundCandidatesResponse.parse(candidates));
  });

  router.get("/sales/refunds", async (req, res): Promise<void> => {
    if (!(await requireSalesAccess(req, res))) return;
    const rows = await db
      .select({
        refund: salesRefundsTable,
        sale: salesTable,
      })
      .from(salesRefundsTable)
      .innerJoin(salesTable, eq(salesRefundsTable.saleId, salesTable.id))
      .orderBy(
        desc(salesRefundsTable.refundDate),
        desc(salesRefundsTable.createdAt),
        desc(salesRefundsTable.id),
      );
    const records = rows.map(({ refund, sale }) => ({
      ...refund,
      saleDate: sale.saleDate,
      productId: sale.productId,
      productName: sale.productName,
      quantity: sale.quantity,
      unitAmountCents: sale.unitAmountCents,
      totalCents: sale.totalCents,
      saleStatus: sale.status,
    }));
    res.json(GetSalesRefundsResponse.parse(records));
  });

  router.get("/sales/refunds/:id/history", async (req, res): Promise<void> => {
    if (!(await requireSalesAccess(req, res))) return;
    const params = GetSalesRefundHistoryParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const [refund] = await db
      .select({ id: salesRefundsTable.id })
      .from(salesRefundsTable)
      .where(eq(salesRefundsTable.id, params.data.id))
      .limit(1);
    if (!refund) {
      res.status(404).json({ error: "Refund not found" });
      return;
    }
    const history = await db
      .select()
      .from(salesHistoryTable)
      .where(
        sql`${salesHistoryTable.entityType} = 'refund' and ${salesHistoryTable.entityId} = ${params.data.id}`,
      )
      .orderBy(desc(salesHistoryTable.createdAt), desc(salesHistoryTable.id));
    res.json(GetSalesRefundHistoryResponse.parse(history));
  });

  router.get("/sales/:id/history", async (req, res): Promise<void> => {
    if (!(await requireSalesAccess(req, res))) return;
    const params = GetSaleHistoryParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const [sale] = await db
      .select({ id: salesTable.id })
      .from(salesTable)
      .where(eq(salesTable.id, params.data.id))
      .limit(1);
    if (!sale) {
      res.status(404).json({ error: "Sale not found" });
      return;
    }
    const history = await db
      .select()
      .from(salesHistoryTable)
      .where(
        sql`${salesHistoryTable.entityType} = 'sale' and ${salesHistoryTable.entityId} = ${params.data.id}`,
      )
      .orderBy(desc(salesHistoryTable.createdAt));
    res.json(GetSaleHistoryResponse.parse(history));
  });

  router.post("/sales/import", async (req, res): Promise<void> => {
    if (!(await requireSalesAccess(req, res))) return;
    const parsed = ImportSalesBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const normalizedRows: Array<{
      saleDate: string;
      productName: string;
      quantity: number;
      unitAmountCents: number;
      customerName: string | null;
      notes: string | null;
      sourceRow: number;
      totalCents: number;
    }> = [];
    for (const row of parsed.data.rows) {
      const saleDate =
        row.saleDate instanceof Date
          ? row.saleDate.toISOString().slice(0, 10)
          : parseSaleDate(row.saleDate);
      const productName = normalizeProductName(row.productName);
      const totalCents = calculateSaleTotalCents(
        row.quantity,
        row.unitAmountCents,
      );
      if (
        !saleDate ||
        !productName ||
        productName.length > 120 ||
        totalCents === null
      ) {
        res
          .status(400)
          .json({ error: `Invalid import data in row ${row.sourceRow}` });
        return;
      }
      const customerName =
        row.customerName?.trim().replace(/\s+/g, " ") || null;
      if (customerName && customerName.length > 120) {
        res.status(400).json({
          error: `Customer name exceeds 120 characters in row ${row.sourceRow}`,
        });
        return;
      }
      normalizedRows.push({
        ...row,
        saleDate,
        productName,
        totalCents,
        customerName,
        notes: row.notes?.trim() || null,
      });
    }
    const actorId = getAuth(req).userId!;
    try {
      const result = await db.transaction(async (tx) =>
        runIdempotent(
          tx,
          {
            actorId,
            operation: "sales-import",
            key: parsed.data.fileHash,
            request: { rows: normalizedRows },
          },
          async () => {
            const [batch] = await tx
              .insert(salesImportBatchesTable)
              .values({
                actorId,
                source: "sales-file",
                fileHash: parsed.data.fileHash,
                status: "completed",
                rowCount: normalizedRows.length,
                completedAt: new Date(),
              })
              .returning();
            if (!batch) throw new Error("Could not create import batch");

            const importedSales = [];
            for (const row of normalizedRows) {
              const product = await getOrCreateProduct(
                tx,
                row.productName,
                row.unitAmountCents,
                actorId,
              );
              const [sale] = await tx
                .insert(salesTable)
                .values({
                  productId: product.id,
                  saleDate: row.saleDate,
                  productName: product.name,
                  quantity: row.quantity,
                  unitAmountCents: row.unitAmountCents,
                  totalCents: row.totalCents,
                  customerName: row.customerName,
                  notes: row.notes,
                  createdBy: actorId,
                  updatedBy: actorId,
                })
                .returning();
              if (!sale)
                throw new Error(`Could not import row ${row.sourceRow}`);
              await recordSalesHistory(tx, {
                entityType: "sale",
                entityId: sale.id,
                operation: "import",
                actorId,
                afterData: {
                  ...sale,
                  importBatchId: batch.id,
                  sourceRow: row.sourceRow,
                },
              });
              importedSales.push(sale);
            }
            return {
              batchId: batch.id,
              fileName: parsed.data.filename,
              importedCount: importedSales.length,
              sales: importedSales,
            };
          },
        ),
      );
      res.status(result.replayed ? 200 : 201).json(
        ImportSalesResponse.parse({
          ...result.value,
          replayed: result.replayed,
        }),
      );
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        res.status(409).json({ error: error.message });
      } else if (
        error instanceof Error &&
        error.message.startsWith("Invalid import data")
      ) {
        res.status(400).json({ error: error.message });
      } else {
        throw error;
      }
    }
  });

  router.get("/sales-goals", async (req, res): Promise<void> => {
    if (!(await requireSalesAccess(req, res))) return;

    const goals = await database
      .select()
      .from(salesGoalsTable)
      .orderBy(desc(salesGoalsTable.month), asc(salesGoalsTable.scopeKey));

    res.json(GetSalesGoalsResponse.parse(goals));
  });

  router.put("/sales-goals", async (req, res): Promise<void> => {
    if (!(await requireSalesAccess(req, res))) return;

    const parsed = UpsertSalesGoalBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const actorId = getUserId(req)!;
    try {
      const result = await database.transaction(async (tx) =>
        runIdempotent(
          tx,
          {
            actorId,
            operation: "sales-goal-upsert",
            key: parsed.data.idempotencyKey,
            request: parsed.data,
          },
          async () => {
            let product: typeof productsTable.$inferSelect | null = null;
            if (parsed.data.productName !== null) {
              const normalizedName = productNameKey(parsed.data.productName);
              if (!normalizedName)
                throw new Error("Select a plan from recorded sales");
              const [found] = await tx
                .select()
                .from(productsTable)
                .where(eq(productsTable.normalizedName, normalizedName))
                .limit(1);
              if (!found) throw new Error("Select a plan from recorded sales");
              product = found;
            }

            const scopeKey = product ? `product:${product.id}` : "all-plans";
            const [before] = await tx
              .select()
              .from(salesGoalsTable)
              .where(
                sql`${salesGoalsTable.month} = ${parsed.data.month} and ${salesGoalsTable.scopeKey} = ${scopeKey}`,
              )
              .limit(1);
            const [goal] = await tx
              .insert(salesGoalsTable)
              .values({
                month: parsed.data.month,
                scopeKey,
                productId: product?.id ?? null,
                productName: product?.name ?? null,
                targetCents: parsed.data.targetCents,
              })
              .onConflictDoUpdate({
                target: [salesGoalsTable.month, salesGoalsTable.scopeKey],
                set: {
                  productId: product?.id ?? null,
                  productName: product?.name ?? null,
                  targetCents: parsed.data.targetCents,
                  version: sql`${salesGoalsTable.version} + 1`,
                  updatedAt: new Date(),
                },
              })
              .returning();
            if (!goal) throw new Error("Could not save monthly goal");
            await recordSalesHistory(tx, {
              entityType: "goal",
              entityId: goal.id,
              operation: before ? "update" : "create",
              actorId,
              beforeData: before ?? null,
              afterData: goal,
            });
            return goal;
          },
        ),
      );
      res.json(UpsertSalesGoalResponse.parse(result.value));
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        res.status(409).json({ error: error.message });
      } else if (
        error instanceof Error &&
        error.message === "Select a plan from recorded sales"
      ) {
        res.status(400).json({ error: error.message });
      } else {
        throw error;
      }
    }
  });

  router.get("/sales/backup", async (req, res): Promise<void> => {
    if (!(await requireSalesAccess(req, res))) return;
    const parsed = GetMonthlySalesBackupQueryParams.safeParse(req.query);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "Informe um mês válido no formato AAAA-MM." });
      return;
    }
    const backup = await buildMonthlySalesBackup(parsed.data.month);
    const validated = monthlyBackupV2RuntimeSchema.safeParse(backup);
    if (
      !validated.success ||
      Buffer.byteLength(JSON.stringify(backup, null, 2), "utf8") >
        10 * 1024 * 1024
    ) {
      res.status(413).json({
        error:
          "O mês e suas dependências excedem os limites do backup ou contêm dados inconsistentes. Nenhum arquivo incompleto foi gerado.",
      });
      return;
    }
    res.json(GetMonthlySalesBackupResponse.parse(backup));
  });

  async function previewLegacyBackup(backup: MonthlySalesBackupV1) {
    const saleIds = backup.sales.map(({ id }) => id);
    const existingSales = saleIds.length
      ? await db
          .select()
          .from(salesTable)
          .where(inArray(salesTable.id, saleIds))
      : [];
    const existingSalesById = new Map(
      existingSales.map((sale) => [sale.id, sale]),
    );
    const productNames = [
      ...new Set(
        [
          ...backup.sales.map(({ productName }) =>
            normalizeProductName(productName),
          ),
          ...backup.goals.flatMap(({ productName }) =>
            productName ? [normalizeProductName(productName)] : [],
          ),
        ].filter(Boolean),
      ),
    ];
    const productKeys = productNames.map((name) => productNameKey(name));
    const existingProducts = productKeys.length
      ? await db
          .select()
          .from(productsTable)
          .where(inArray(productsTable.normalizedName, productKeys))
      : [];
    const existingProductsByName = new Map(
      existingProducts.map((product) => [product.normalizedName, product]),
    );
    const existingGoals = await db
      .select()
      .from(salesGoalsTable)
      .where(
        or(
          eq(salesGoalsTable.month, backup.month),
          backup.goals.length
            ? inArray(
                salesGoalsTable.id,
                backup.goals.map(({ id }) => id),
              )
            : undefined,
        ),
      );
    const existingGoalsById = new Map(
      existingGoals.map((goal) => [goal.id, goal]),
    );
    const goalsByScope = new Map(
      existingGoals
        .filter(({ month }) => month === backup.month)
        .map((goal) => [goal.scopeKey, goal]),
    );
    const toInsert = emptyRestoreCounts();
    const identical = emptyRestoreCounts();
    const conflicts: RestoreConflict[] = [];

    for (const sale of backup.sales) {
      const existing = existingSalesById.get(sale.id);
      if (!existing) {
        toInsert.sales += 1;
      } else if (
        existing.saleDate ===
          (sale.saleDate instanceof Date
            ? sale.saleDate.toISOString().slice(0, 10)
            : sale.saleDate) &&
        existing.productName === sale.productName &&
        existing.quantity === sale.quantity &&
        existing.unitAmountCents === sale.unitAmountCents &&
        existing.totalCents === sale.totalCents &&
        existing.notes === sale.notes
      ) {
        identical.sales += 1;
      } else {
        conflicts.push({
          entityType: "sale",
          id: sale.id,
          reason:
            "O ID já existe com conteúdo diferente; o registro atual será mantido.",
          blocking: false,
        });
      }
    }
    for (const name of productNames) {
      if (!existingProductsByName.has(productNameKey(name)))
        toInsert.products += 1;
    }
    for (const goal of backup.goals) {
      const normalizedName =
        goal.productName === null
          ? null
          : normalizeProductName(goal.productName);
      const product =
        normalizedName === null
          ? null
          : existingProductsByName.get(productNameKey(normalizedName));
      const scopeKey =
        normalizedName === null
          ? "all-plans"
          : product
            ? `product:${product.id}`
            : `missing:${normalizedName}`;
      const existingById = existingGoalsById.get(goal.id);
      const existingByScope = goalsByScope.get(scopeKey);
      if (
        existingById &&
        existingById.month === goal.month &&
        existingById.scopeKey === scopeKey &&
        existingById.targetCents === goal.targetCents
      ) {
        identical.goals += 1;
      } else if (existingById || existingByScope) {
        conflicts.push({
          entityType: "goal",
          id: goal.id,
          reason:
            "Já existe uma meta diferente para este ID ou escopo; a meta atual será mantida.",
          blocking: false,
        });
      } else {
        toInsert.goals += 1;
      }
    }

    return PreviewMonthlySalesBackupRestoreResponse.parse({
      period: backup.month,
      dependencyMonths: [],
      toInsert,
      identical,
      conflicts: uniqueConflicts(conflicts),
      blocked: false,
    });
  }

  router.post("/sales/restore/preview", async (req, res): Promise<void> => {
    if (!(await requireSalesAccess(req, res))) return;
    const parsed = PreviewMonthlySalesBackupRestoreBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    if (!("schemaVersion" in parsed.data)) {
      res.json(await previewLegacyBackup(parsed.data));
      return;
    }
    const backup = monthlyBackupV2RuntimeSchema.safeParse(req.body);
    if (!backup.success) {
      res.status(400).json({
        error: backup.error.issues[0]?.message ?? "O backup está inválido.",
      });
      return;
    }
    const analysis = await db.transaction((tx) =>
      analyzeMonthlyBackupRestore(
        tx,
        backup.data as unknown as MonthlySalesBackupV2,
      ),
    );
    res.json(PreviewMonthlySalesBackupRestoreResponse.parse(analysis.preview));
  });

  router.post("/sales/restore", async (req, res): Promise<void> => {
    if (!(await requireSalesAccess(req, res))) return;

    const parsed = RestoreMonthlySalesBackupBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    if ("schemaVersion" in parsed.data) {
      const validated = monthlyBackupV2RuntimeSchema.safeParse(req.body);
      if (!validated.success) {
        res.status(400).json({
          error:
            validated.error.issues[0]?.message ?? "O backup está inválido.",
        });
        return;
      }
      const backup = validated.data as unknown as MonthlySalesBackupV2;
      const actorId = getAuth(req).userId!;
      try {
        const result = await db.transaction((tx) =>
          applyMonthlyBackupRestore(tx, backup, actorId),
        );
        res.json(RestoreMonthlySalesBackupResponse.parse(result));
      } catch (error) {
        if (error instanceof RestoreBlockedError)
          res.status(409).json({ error: error.message });
        else throw error;
      }
      return;
    }

    const backup = parsed.data;
    const rawSales = (req.body as { sales?: unknown[] }).sales;
    if (
      !Array.isArray(rawSales) ||
      rawSales.length !== backup.sales.length ||
      backup.recordCount !== backup.sales.length ||
      backup.goalCount !== backup.goals.length
    ) {
      res
        .status(400)
        .json({ error: "Backup counts do not match the included records" });
      return;
    }

    const salesIds = new Set<string>();
    const productScopes = new Set<string>();
    const goalIds = new Set<string>();
    const saleDates: string[] = [];
    for (let index = 0; index < backup.sales.length; index += 1) {
      const sale = backup.sales[index];
      const rawRecord = rawSales[index] as { saleDate?: unknown } | undefined;
      const saleDate = parseSaleDate(rawRecord?.saleDate);
      const totalCents = calculateSaleTotalCents(
        sale.quantity,
        sale.unitAmountCents,
      );
      if (
        !saleDate ||
        saleDate.slice(0, 7) !== backup.month ||
        totalCents === null ||
        totalCents !== sale.totalCents ||
        !normalizeProductName(sale.productName) ||
        salesIds.has(sale.id)
      ) {
        res.status(400).json({
          error: "Backup contains an invalid or duplicate sale record",
        });
        return;
      }
      salesIds.add(sale.id);
      saleDates.push(saleDate);
    }

    for (const goal of backup.goals) {
      const normalizedProduct =
        goal.productName === null
          ? null
          : normalizeProductName(goal.productName);
      const scopeKey =
        normalizedProduct === null
          ? "all-plans"
          : `plan:${productNameKey(normalizedProduct)}`;
      if (
        goal.month !== backup.month ||
        (goal.productName !== null && !normalizedProduct) ||
        productScopes.has(scopeKey) ||
        goalIds.has(goal.id)
      ) {
        res.status(400).json({
          error: "Backup contains an invalid or duplicate monthly goal",
        });
        return;
      }
      productScopes.add(scopeKey);
      goalIds.add(goal.id);
    }

    const actorId = getUserId(req)!;
    const legacyPreview = await previewLegacyBackup(backup);
    const restored = await db.transaction(async (tx) => {
      await tx.execute(
        sql`lock table products, sales, sales_refunds, sales_goals, sales_history in share row exclusive mode`,
      );
      const previousSales = backup.sales.length
        ? await tx
            .select()
            .from(salesTable)
            .where(
              inArray(
                salesTable.id,
                backup.sales.map(({ id }) => id),
              ),
            )
        : [];
      const previousGoals = await tx
        .select()
        .from(salesGoalsTable)
        .where(eq(salesGoalsTable.month, backup.month));
      await tx.insert(salesHistoryTable).values({
        entityType: "restore-snapshot",
        entityId: randomUUID(),
        operation: "pre-restore-backup",
        actorId,
        beforeData: null,
        afterData: {
          period: backup.month,
          sales: previousSales,
          goals: previousGoals,
        },
      });
      const productCache = new Map<
        string,
        Awaited<ReturnType<typeof getOrCreateProduct>>
      >();
      const getBackupProduct = async (name: string, initialPriceCents = 0) => {
        const normalized = normalizeProductName(name);
        const key = productNameKey(normalized);
        const cached = productCache.get(key);
        if (cached) return cached;
        const product = await getOrCreateProduct(
          tx,
          normalized,
          initialPriceCents,
          actorId,
          true,
        );
        productCache.set(key, product);
        return product;
      };

      const preparedSales = [];
      for (let index = 0; index < backup.sales.length; index += 1) {
        const sale = backup.sales[index];
        const product = await getBackupProduct(
          sale.productName,
          sale.unitAmountCents,
        );
        preparedSales.push({
          sale,
          saleDate: parseSaleDate(
            (rawSales[index] as { saleDate?: unknown }).saleDate,
          )!,
          productId: product.id,
          productName: normalizeProductName(sale.productName),
        });
      }

      let insertedSales = 0;
      for (let offset = 0; offset < preparedSales.length; offset += 500) {
        const rows = preparedSales
          .slice(offset, offset + 500)
          .map(({ sale, saleDate, productId, productName }) => ({
            id: sale.id,
            productId,
            saleDate,
            productName,
            quantity: sale.quantity,
            unitAmountCents: sale.unitAmountCents,
            totalCents: sale.totalCents,
            customerName:
              sale.customerName?.trim().replace(/\s+/g, " ") || null,
            notes: sale.notes,
            createdAt: sale.createdAt,
            updatedAt: sale.createdAt,
          }));
        if (rows.length === 0) continue;
        const inserted = await tx
          .insert(salesTable)
          .values(rows)
          .onConflictDoNothing({ target: salesTable.id })
          .returning({ id: salesTable.id });
        insertedSales += inserted.length;
        const insertedIds = new Set(inserted.map(({ id }) => id));
        for (const row of rows) {
          if (!insertedIds.has(row.id)) continue;
          await recordSalesHistory(tx, {
            entityType: "sale",
            entityId: row.id,
            operation: "restore",
            actorId,
            afterData: row,
          });
        }
      }

      let insertedGoals = 0;
      for (const goal of backup.goals) {
        const normalizedProduct =
          goal.productName === null
            ? null
            : normalizeProductName(goal.productName);
        const product =
          normalizedProduct === null
            ? null
            : await getBackupProduct(normalizedProduct);
        const productName = product?.name ?? null;
        const scopeKey = product ? `product:${product.id}` : "all-plans";
        const [before] = await tx
          .select()
          .from(salesGoalsTable)
          .where(
            sql`${salesGoalsTable.month} = ${goal.month} and ${salesGoalsTable.scopeKey} = ${scopeKey}`,
          )
          .limit(1);
        if (before) continue;
        const [savedGoal] = await tx
          .insert(salesGoalsTable)
          .values({
            id: goal.id,
            month: goal.month,
            scopeKey,
            productId: product?.id ?? null,
            productName,
            targetCents: goal.targetCents,
            version: 1,
            updatedAt: goal.updatedAt,
          })
          .onConflictDoNothing()
          .returning();
        if (savedGoal) {
          insertedGoals += 1;
          await recordSalesHistory(tx, {
            entityType: "goal",
            entityId: savedGoal.id,
            operation: "restore",
            actorId,
            beforeData: before ?? null,
            afterData: savedGoal,
          });
        }
      }

      return {
        insertedSales,
        skippedSales: backup.sales.length - insertedSales,
        restoredGoals: insertedGoals,
      };
    });

    res.json(
      RestoreMonthlySalesBackupResponse.parse({
        period: backup.month,
        inserted: {
          products: 0,
          sales: restored.insertedSales,
          refunds: 0,
          goals: restored.restoredGoals,
          histories: 0,
        },
        identical: legacyPreview.identical,
        conflicts: legacyPreview.conflicts,
      }),
    );
  });

  router.post("/sales", async (req, res): Promise<void> => {
    if (!(await requireSalesAccess(req, res))) return;

    const parsed = CreateSaleBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const saleDate = parseSaleDate(
      (req.body as { saleDate?: unknown }).saleDate,
    );
    const productName = normalizeProductName(parsed.data.productName);
    if (!saleDate || !productName) {
      res
        .status(400)
        .json({ error: "Enter a valid sale date and product name" });
      return;
    }

    const totalCents = calculateSaleTotalCents(
      parsed.data.quantity,
      parsed.data.unitAmountCents,
    );
    if (totalCents === null) {
      res.status(400).json({ error: "The calculated sale total is too large" });
      return;
    }

    const actorId = getUserId(req)!;
    try {
      const result = await database.transaction(async (tx) =>
        runIdempotent(
          tx,
          {
            actorId,
            operation: "sale-create",
            key: parsed.data.idempotencyKey,
            request: parsed.data,
          },
          async () => {
            const product = await getOrCreateProduct(
              tx,
              productName,
              parsed.data.unitAmountCents,
              actorId,
            );
            const [created] = await tx
              .insert(salesTable)
              .values({
                productId: product.id,
                saleDate,
                productName: product.name,
                quantity: parsed.data.quantity,
                unitAmountCents: parsed.data.unitAmountCents,
                totalCents,
                customerName:
                  parsed.data.customerName?.trim().replace(/\s+/g, " ") || null,
                notes: parsed.data.notes?.trim() || null,
                status: "active",
                createdBy: actorId,
                updatedBy: actorId,
              })
              .returning();
            if (!created) throw new Error("Could not create sale");
            await recordSalesHistory(tx, {
              entityType: "sale",
              entityId: created.id,
              operation: "create",
              actorId,
              afterData: created,
            });
            return created;
          },
        ),
      );
      res
        .status(result.replayed ? 200 : 201)
        .json(CreateSaleResponse.parse(result.value));
    } catch (error) {
      if (
        error instanceof IdempotencyConflictError ||
        error instanceof ProductUnavailableError
      ) {
        res.status(409).json({ error: error.message });
      } else {
        throw error;
      }
    }
  });

  router.patch("/sales/:id", async (req, res): Promise<void> => {
    if (!(await requireSalesAccess(req, res))) return;

    const params = UpdateSaleParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }

    const parsed = UpdateSaleBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const saleDate = parseSaleDate(
      (req.body as { saleDate?: unknown }).saleDate,
    );
    const productName = normalizeProductName(parsed.data.productName);
    if (!saleDate || !productName) {
      res
        .status(400)
        .json({ error: "Enter a valid sale date and product name" });
      return;
    }

    const totalCents = calculateSaleTotalCents(
      parsed.data.quantity,
      parsed.data.unitAmountCents,
    );
    if (totalCents === null) {
      res.status(400).json({ error: "The calculated sale total is too large" });
      return;
    }

    const actorId = getAuth(req).userId!;
    try {
      const result = await db.transaction(async (tx) =>
        runIdempotent(
          tx,
          {
            actorId,
            operation: `sale-update:${params.data.id}`,
            key: parsed.data.idempotencyKey,
            request: parsed.data,
          },
          async () => {
            const [current] = await tx
              .select()
              .from(salesTable)
              .where(eq(salesTable.id, params.data.id))
              .for("update")
              .limit(1);
            if (!current || current.status !== "active") {
              throw new Error("Sale not found");
            }
            if (current.version !== parsed.data.expectedVersion) {
              throw new VersionConflictError();
            }

            let product = await getOrCreateProduct(
              tx,
              productName,
              parsed.data.unitAmountCents,
              actorId,
            );
            const refundSummary = await lockSaleForRefund(tx, current.id);
            if (current.productId === product.id) {
              const [currentProduct] = await tx
                .select()
                .from(productsTable)
                .where(eq(productsTable.id, current.productId))
                .limit(1);
              if (currentProduct) product = currentProduct;
            } else if (refundSummary.activeRefundCount > 0) {
              throw new Error(
                "A sale with an active refund cannot be moved to another product",
              );
            }
            if (BigInt(totalCents) < BigInt(refundSummary.refundedCents)) {
              throw new Error("Sale total cannot be lower than active refunds");
            }
            if (
              refundSummary.latestRefundDate &&
              saleDate > refundSummary.latestRefundDate
            ) {
              throw new Error("Sale date cannot be after an active refund");
            }

            const [updated] = await tx
              .update(salesTable)
              .set({
                productId: product.id,
                saleDate,
                productName: product.name,
                quantity: parsed.data.quantity,
                unitAmountCents: parsed.data.unitAmountCents,
                totalCents,
                customerName:
                  parsed.data.customerName?.trim().replace(/\s+/g, " ") || null,
                notes: parsed.data.notes?.trim() || null,
                version: current.version + 1,
                updatedBy: actorId,
                updatedAt: new Date(),
              })
              .where(eq(salesTable.id, params.data.id))
              .returning();
            if (!updated) throw new Error("Sale not found");
            await recordSalesHistory(tx, {
              entityType: "sale",
              entityId: updated.id,
              operation: "update",
              actorId,
              beforeData: current,
              afterData: updated,
            });
            return updated;
          },
        ),
      );
      res.json(UpdateSaleResponse.parse(result.value));
    } catch (error) {
      if (
        error instanceof IdempotencyConflictError ||
        error instanceof VersionConflictError ||
        error instanceof ProductUnavailableError
      ) {
        res.status(409).json({ error: error.message });
      } else if (error instanceof Error && error.message === "Sale not found") {
        res.status(404).json({ error: error.message });
      } else if (
        error instanceof SaleUnavailableForRefundError ||
        (error instanceof Error &&
          error.message.toLowerCase().includes("refund"))
      ) {
        res.status(409).json({ error: error.message });
      } else {
        throw error;
      }
    }
  });

  router.post("/sales/:id/cancel", async (req, res): Promise<void> => {
    if (!(await requireSalesAccess(req, res))) return;

    const params = CancelSaleParams.safeParse(req.params);
    const parsed = CancelSaleBody.safeParse(req.body);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const reason = normalizeProductName(parsed.data.reason);
    if (!reason) {
      res.status(400).json({ error: "A cancellation reason is required" });
      return;
    }

    const actorId = getAuth(req).userId!;
    try {
      const result = await db.transaction(async (tx) =>
        runIdempotent(
          tx,
          {
            actorId,
            operation: `sale-cancel:${params.data.id}`,
            key: parsed.data.idempotencyKey,
            request: { reason, expectedVersion: parsed.data.expectedVersion },
          },
          async () => {
            const [current] = await tx
              .select()
              .from(salesTable)
              .where(eq(salesTable.id, params.data.id))
              .for("update")
              .limit(1);
            if (!current || current.status !== "active")
              throw new Error("Sale not found");
            if (current.version !== parsed.data.expectedVersion)
              throw new VersionConflictError();

            const [activeRefund] = await tx
              .select({ id: salesRefundsTable.id })
              .from(salesRefundsTable)
              .where(
                sql`${salesRefundsTable.saleId} = ${current.id} and ${salesRefundsTable.status} = 'active'`,
              )
              .limit(1);
            if (activeRefund)
              throw new Error(
                "A sale with an active refund cannot be cancelled",
              );

            const [updated] = await tx
              .update(salesTable)
              .set({
                status: "cancelled",
                cancellationReason: reason,
                version: current.version + 1,
                updatedBy: actorId,
                updatedAt: new Date(),
              })
              .where(eq(salesTable.id, current.id))
              .returning();
            if (!updated) throw new Error("Sale not found");
            await recordSalesHistory(tx, {
              entityType: "sale",
              entityId: updated.id,
              operation: "cancel",
              actorId,
              beforeData: current,
              afterData: updated,
            });
            return updated;
          },
        ),
      );
      res.json(CancelSaleResponse.parse(result.value));
    } catch (error) {
      if (
        error instanceof IdempotencyConflictError ||
        error instanceof VersionConflictError ||
        (error instanceof Error && error.message.includes("active refund"))
      ) {
        res.status(409).json({ error: error.message });
      } else if (error instanceof Error && error.message === "Sale not found") {
        res.status(404).json({ error: error.message });
      } else {
        throw error;
      }
    }
  });

  router.post("/sales/:id/refunds", async (req, res): Promise<void> => {
    if (!(await requireSalesAccess(req, res))) return;
    const params = CreateSalesRefundParams.safeParse(req.params);
    const parsed = CreateSalesRefundBody.safeParse(req.body);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const refundDate = parseSaleDate(parsed.data.refundDate);
    const reason = parsed.data.reason.trim().replace(/\s+/g, " ");
    if (
      !refundDate ||
      !reason ||
      reason.length > 500 ||
      !Number.isSafeInteger(parsed.data.amountCents) ||
      parsed.data.amountCents <= 0
    ) {
      res.status(400).json({
        error: "Enter a valid refund date, positive amount, and reason",
      });
      return;
    }

    const actorId = getAuth(req).userId!;
    try {
      const result = await db.transaction(async (tx) =>
        runIdempotent(
          tx,
          {
            actorId,
            operation: `sales-refund-create:${params.data.id}`,
            key: parsed.data.idempotencyKey,
            request: {
              refundDate,
              amountCents: parsed.data.amountCents,
              reason,
            },
          },
          async () => {
            const balance = await lockSaleForRefund(tx, params.data.id);
            if (refundDate < balance.sale.saleDate) {
              throw new Error("Refund date cannot be before the sale date");
            }
            if (parsed.data.amountCents > balance.remainingCents) {
              throw new SaleUnavailableForRefundError(
                "Refund amount exceeds the available sale balance",
              );
            }
            const [refund] = await tx
              .insert(salesRefundsTable)
              .values({
                saleId: balance.sale.id,
                refundDate,
                amountCents: parsed.data.amountCents,
                reason,
                createdBy: actorId,
                updatedBy: actorId,
              })
              .returning();
            if (!refund) throw new Error("Could not create refund");
            await recordSalesHistory(tx, {
              entityType: "refund",
              entityId: refund.id,
              operation: "create",
              actorId,
              afterData: refund,
            });
            return refund;
          },
        ),
      );
      res
        .status(result.replayed ? 200 : 201)
        .json(CreateSalesRefundResponse.parse(result.value));
    } catch (error) {
      if (
        error instanceof IdempotencyConflictError ||
        error instanceof SaleUnavailableForRefundError
      ) {
        if (
          error instanceof SaleUnavailableForRefundError &&
          error.message === "Sale not found"
        ) {
          res.status(404).json({ error: error.message });
        } else {
          res.status(409).json({ error: error.message });
        }
      } else if (
        error instanceof Error &&
        error.message.includes("Refund date cannot be before")
      ) {
        res.status(400).json({ error: error.message });
      } else {
        throw error;
      }
    }
  });

  router.patch("/sales/refunds/:id", async (req, res): Promise<void> => {
    if (!(await requireSalesAccess(req, res))) return;
    const params = UpdateSalesRefundParams.safeParse(req.params);
    const parsed = UpdateSalesRefundBody.safeParse(req.body);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const refundDate = parseSaleDate(parsed.data.refundDate);
    const reason = parsed.data.reason.trim().replace(/\s+/g, " ");
    if (
      !refundDate ||
      !reason ||
      reason.length > 500 ||
      !Number.isSafeInteger(parsed.data.amountCents) ||
      parsed.data.amountCents <= 0
    ) {
      res.status(400).json({
        error: "Enter a valid refund date, positive amount, and reason",
      });
      return;
    }

    const actorId = getAuth(req).userId!;
    try {
      const result = await db.transaction(async (tx) =>
        runIdempotent(
          tx,
          {
            actorId,
            operation: `sales-refund-update:${params.data.id}`,
            key: parsed.data.idempotencyKey,
            request: {
              refundDate,
              amountCents: parsed.data.amountCents,
              reason,
              expectedVersion: parsed.data.expectedVersion,
            },
          },
          async () => {
            const [before] = await tx
              .select()
              .from(salesRefundsTable)
              .where(eq(salesRefundsTable.id, params.data.id))
              .limit(1);
            if (!before) throw new Error("Refund not found");
            const balance = await lockSaleForRefund(tx, before.saleId);
            const [current] = await tx
              .select()
              .from(salesRefundsTable)
              .where(eq(salesRefundsTable.id, params.data.id))
              .for("update")
              .limit(1);
            if (!current) throw new Error("Refund not found");
            if (current.status !== "active")
              throw new Error("Only active refunds can be corrected");
            if (current.version !== parsed.data.expectedVersion)
              throw new VersionConflictError();
            if (refundDate < balance.sale.saleDate) {
              throw new Error("Refund date cannot be before the sale date");
            }
            const otherRefundsCents =
              BigInt(balance.refundedCents) - BigInt(current.amountCents);
            const maximumRefundCents =
              BigInt(balance.sale.totalCents) - otherRefundsCents;
            if (
              otherRefundsCents < 0n ||
              BigInt(parsed.data.amountCents) > maximumRefundCents
            ) {
              throw new SaleUnavailableForRefundError(
                "Corrected refund exceeds the available sale balance",
              );
            }
            const [updated] = await tx
              .update(salesRefundsTable)
              .set({
                refundDate,
                amountCents: parsed.data.amountCents,
                reason,
                version: current.version + 1,
                updatedBy: actorId,
                updatedAt: new Date(),
              })
              .where(eq(salesRefundsTable.id, current.id))
              .returning();
            if (!updated) throw new Error("Refund not found");
            await recordSalesHistory(tx, {
              entityType: "refund",
              entityId: updated.id,
              operation: "update",
              actorId,
              beforeData: current,
              afterData: updated,
            });
            return updated;
          },
        ),
      );
      res.json(UpdateSalesRefundResponse.parse(result.value));
    } catch (error) {
      if (
        error instanceof IdempotencyConflictError ||
        error instanceof VersionConflictError ||
        error instanceof SaleUnavailableForRefundError ||
        (error instanceof Error &&
          error.message === "Only active refunds can be corrected")
      ) {
        res.status(409).json({ error: error.message });
      } else if (
        error instanceof Error &&
        error.message === "Refund not found"
      ) {
        res.status(404).json({ error: error.message });
      } else if (
        error instanceof Error &&
        error.message.includes("Refund date cannot be before")
      ) {
        res.status(400).json({ error: error.message });
      } else {
        throw error;
      }
    }
  });

  router.post("/sales/refunds/:id/void", async (req, res): Promise<void> => {
    if (!(await requireSalesAccess(req, res))) return;
    const params = VoidSalesRefundParams.safeParse(req.params);
    const parsed = VoidSalesRefundBody.safeParse(req.body);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const reason = parsed.data.reason.trim().replace(/\s+/g, " ");
    if (!reason || reason.length > 500) {
      res.status(400).json({ error: "A reason is required to void a refund" });
      return;
    }

    const actorId = getAuth(req).userId!;
    try {
      const result = await db.transaction(async (tx) =>
        runIdempotent(
          tx,
          {
            actorId,
            operation: `sales-refund-void:${params.data.id}`,
            key: parsed.data.idempotencyKey,
            request: { reason, expectedVersion: parsed.data.expectedVersion },
          },
          async () => {
            const [before] = await tx
              .select()
              .from(salesRefundsTable)
              .where(eq(salesRefundsTable.id, params.data.id))
              .limit(1);
            if (!before) throw new Error("Refund not found");
            await lockSaleForRefund(tx, before.saleId);
            const [current] = await tx
              .select()
              .from(salesRefundsTable)
              .where(eq(salesRefundsTable.id, params.data.id))
              .for("update")
              .limit(1);
            if (!current) throw new Error("Refund not found");
            if (current.status !== "active")
              throw new Error("Only active refunds can be voided");
            if (current.version !== parsed.data.expectedVersion)
              throw new VersionConflictError();
            const [updated] = await tx
              .update(salesRefundsTable)
              .set({
                status: "voided",
                voidReason: reason,
                version: current.version + 1,
                updatedBy: actorId,
                updatedAt: new Date(),
              })
              .where(eq(salesRefundsTable.id, current.id))
              .returning();
            if (!updated) throw new Error("Refund not found");
            await recordSalesHistory(tx, {
              entityType: "refund",
              entityId: updated.id,
              operation: "void",
              actorId,
              beforeData: current,
              afterData: updated,
            });
            return updated;
          },
        ),
      );
      res.json(VoidSalesRefundResponse.parse(result.value));
    } catch (error) {
      if (
        error instanceof IdempotencyConflictError ||
        error instanceof VersionConflictError ||
        error instanceof SaleUnavailableForRefundError ||
        (error instanceof Error &&
          error.message === "Only active refunds can be voided")
      ) {
        res.status(409).json({ error: error.message });
      } else if (
        error instanceof Error &&
        error.message === "Refund not found"
      ) {
        res.status(404).json({ error: error.message });
      } else {
        throw error;
      }
    }
  });

  return router;
}

export { analyzeMonthlyBackupRestore, monthlyBackupV2RuntimeSchema };
export default createSalesRouter();
