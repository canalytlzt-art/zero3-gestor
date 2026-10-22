import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  idempotencyKeysTable,
  productsTable,
  salesHistoryTable,
  salesRefundsTable,
  salesTable,
  type DatabaseTransaction,
} from "@workspace/db";

export const MAX_SAFE_CENTS = Number.MAX_SAFE_INTEGER;
export const PRODUCT_NAME_LOCK_NAMESPACE = 5062;
export const PRODUCT_NAME_LOCK_KEY = 1;

export function normalizeProductName(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function productNameKey(value: string): string {
  return normalizeProductName(value).toLocaleLowerCase("pt-BR");
}

export function parseSaleDate(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }

  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (Number.isNaN(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) {
    return null;
  }

  return value;
}

export function calculateSaleTotalCents(quantity: number, unitAmountCents: number): number | null {
  if (!Number.isSafeInteger(quantity) || quantity <= 0
    || !Number.isSafeInteger(unitAmountCents) || unitAmountCents < 0) {
    return null;
  }
  const total = BigInt(quantity) * BigInt(unitAmountCents);
  if (total < 0n || total > BigInt(MAX_SAFE_CENTS)) return null;
  return Number(total);
}

export class IdempotencyConflictError extends Error {
  constructor() {
    super("This idempotency key was already used with different data");
    this.name = "IdempotencyConflictError";
  }
}

export class VersionConflictError extends Error {
  constructor() {
    super("This record changed after it was loaded. Refresh it before saving again.");
    this.name = "VersionConflictError";
  }
}

export class ProductUnavailableError extends Error {
  constructor() {
    super("This product is inactive or unavailable");
    this.name = "ProductUnavailableError";
  }
}

export class SaleUnavailableForRefundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SaleUnavailableForRefundError";
  }
}

export async function lockSaleForRefund(tx: DatabaseTransaction, saleId: string) {
  const [sale] = await tx
    .select()
    .from(salesTable)
    .where(eq(salesTable.id, saleId))
    .for("update")
    .limit(1);
  if (!sale) {
    throw new SaleUnavailableForRefundError("Sale not found");
  }
  if (sale.status !== "active") {
    throw new SaleUnavailableForRefundError("Only an active sale can receive a refund");
  }

  const activeRefunds = await tx
    .select({
      amountCents: salesRefundsTable.amountCents,
      refundDate: salesRefundsTable.refundDate,
    })
    .from(salesRefundsTable)
    .where(and(
      eq(salesRefundsTable.saleId, sale.id),
      eq(salesRefundsTable.status, "active"),
    ));
  const refundedCents = activeRefunds.reduce(
    (total, refund) => total + BigInt(refund.amountCents),
    0n,
  );
  const totalCents = BigInt(sale.totalCents);
  if (refundedCents > totalCents) {
    throw new SaleUnavailableForRefundError("Recorded refunds exceed this sale total");
  }

  return {
    sale,
    refundedCents: Number(refundedCents),
    remainingCents: Number(totalCents - refundedCents),
    activeRefundCount: activeRefunds.length,
    latestRefundDate: activeRefunds.reduce<string | null>(
      (latest, refund) => !latest || refund.refundDate > latest ? refund.refundDate : latest,
      null,
    ),
  };
}

export async function getOrCreateProduct(
  tx: DatabaseTransaction,
  name: string,
  initialPriceCents: number,
  actorId: string,
  allowInactive = false,
) {
  const normalizedName = normalizeProductName(name);
  const normalizedKey = productNameKey(normalizedName);
  if (!normalizedName || !normalizedKey) {
    throw new Error("Product name cannot be blank");
  }

  await tx.execute(sql`select pg_advisory_xact_lock(${PRODUCT_NAME_LOCK_NAMESPACE}, ${PRODUCT_NAME_LOCK_KEY})`);
  const [existing] = await tx
    .select()
    .from(productsTable)
    .where(eq(productsTable.normalizedName, normalizedKey))
    .limit(1);
  if (existing) {
    if (!existing.isActive && !allowInactive) throw new ProductUnavailableError();
    return existing;
  }

  const [product] = await tx
    .insert(productsTable)
    .values({
      name: normalizedName,
      normalizedName: normalizedKey,
      suggestedPriceCents: initialPriceCents,
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
}

export async function recordSalesHistory(
  tx: DatabaseTransaction,
  input: {
    entityType: string;
    entityId: string;
    operation: string;
    actorId: string;
    beforeData?: Record<string, unknown> | null;
    afterData?: Record<string, unknown> | null;
  },
) {
  await tx.insert(salesHistoryTable).values({
    entityType: input.entityType,
    entityId: input.entityId,
    operation: input.operation,
    actorId: input.actorId,
    beforeData: input.beforeData ?? null,
    afterData: input.afterData ?? null,
  });
}

export async function runIdempotent<T extends object>(
  tx: DatabaseTransaction,
  input: {
    actorId: string;
    operation: string;
    key: string;
    request: unknown;
  },
  action: () => Promise<T>,
): Promise<{ value: T; replayed: boolean }> {
  const hashKey = `${input.actorId}:${input.operation}:${input.key}`;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${hashKey}, 0))`);

  const requestHash = createHash("sha256")
    .update(JSON.stringify(input.request))
    .digest("hex");
  const [existing] = await tx
    .select()
    .from(idempotencyKeysTable)
    .where(and(
      eq(idempotencyKeysTable.actorId, input.actorId),
      eq(idempotencyKeysTable.operation, input.operation),
      eq(idempotencyKeysTable.key, input.key),
    ))
    .limit(1);

  if (existing) {
    if (existing.requestHash !== requestHash) throw new IdempotencyConflictError();
    if (!existing.responsePayload) {
      throw new Error("Stored idempotency result is unavailable");
    }
    return { value: existing.responsePayload as T, replayed: true };
  }

  const value = await action();
  const serialized = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  const resourceId = typeof serialized.id === "string" ? serialized.id : null;
  await tx.insert(idempotencyKeysTable).values({
    actorId: input.actorId,
    operation: input.operation,
    key: input.key,
    requestHash,
    responsePayload: serialized,
    resourceId,
  });
  return { value, replayed: false };
}
