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
  GetSalesRefundCandidatesResponse,
  GetSalesRefundHistoryParams,
  GetSalesRefundHistoryResponse,
  GetSalesRefundsResponse,
  GetSalesHistoryResponse,
  GetSalesGoalsResponse,
  GetSalesResponse,
  ImportSalesBody,
  ImportSalesResponse,
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
import { db, productsTable, salesGoalsTable, salesHistoryTable, salesImportBatchesTable, salesRefundsTable, salesTable } from "@workspace/db";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import { isAuthorizedUser } from "../lib/authorization";
import {
  calculateSaleTotalCents,
  getOrCreateProduct,
  IdempotencyConflictError,
  lockSaleForRefund,
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

const router: IRouter = Router();

async function requireSalesAccess(
  req: Request,
  res: Response,
): Promise<boolean> {
  const { userId } = getAuth(req);
  if (!userId) {
    res.status(401).json({ error: "Authentication required" });
    return false;
  }

  if (!(await isAuthorizedUser(req))) {
    res.status(403).json({ error: "Access is restricted to authorized users" });
    return false;
  }

  return true;
}

router.get("/access-status", async (req, res): Promise<void> => {
  const { userId } = getAuth(req);
  if (!userId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const data = GetAccessStatusResponse.parse({
    authorized: await isAuthorizedUser(req),
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
    const result = await db.transaction(async (tx) => runIdempotent(
      tx,
      {
        actorId,
        operation: "product-create",
        key: parsed.data.idempotencyKey,
        request: { ...parsed.data, name, normalizedName },
      },
      async () => {
        await tx.execute(sql`select pg_advisory_xact_lock(${PRODUCT_NAME_LOCK_NAMESPACE}, ${PRODUCT_NAME_LOCK_KEY})`);
        const [existing] = await tx.select().from(productsTable)
          .where(eq(productsTable.normalizedName, normalizedName)).limit(1);
        if (existing) throw new Error("A product with this name already exists");

        const [product] = await tx.insert(productsTable).values({
          name,
          normalizedName,
          suggestedPriceCents: parsed.data.suggestedPriceCents,
          isActive: parsed.data.isActive,
        }).returning();
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
    ));
    res.status(result.replayed ? 200 : 201).json(CreateProductResponse.parse(result.value));
  } catch (error) {
    if (error instanceof IdempotencyConflictError || (error instanceof Error && error.message.includes("already exists"))) {
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
    const result = await db.transaction(async (tx) => runIdempotent(
      tx,
      {
        actorId,
        operation: `product-update:${params.data.id}`,
        key: parsed.data.idempotencyKey,
        request: { ...parsed.data, name, normalizedName },
      },
      async () => {
        await tx.execute(sql`select pg_advisory_xact_lock(${PRODUCT_NAME_LOCK_NAMESPACE}, ${PRODUCT_NAME_LOCK_KEY})`);
        const [current] = await tx.select().from(productsTable)
          .where(eq(productsTable.id, params.data.id)).for("update").limit(1);
        if (!current) throw new Error("Product not found");
        if (current.version !== parsed.data.expectedVersion) throw new VersionConflictError();

        const [duplicate] = await tx.select({ id: productsTable.id }).from(productsTable)
          .where(eq(productsTable.normalizedName, normalizedName)).limit(1);
        if (duplicate && duplicate.id !== current.id) throw new Error("A product with this name already exists");

        const [updated] = await tx.update(productsTable).set({
          name,
          normalizedName,
          suggestedPriceCents: parsed.data.suggestedPriceCents,
          isActive: parsed.data.isActive,
          version: current.version + 1,
          updatedAt: new Date(),
        }).where(eq(productsTable.id, current.id)).returning();
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
    ));
    res.json(UpdateProductResponse.parse(result.value));
  } catch (error) {
    if (error instanceof IdempotencyConflictError || error instanceof VersionConflictError
      || (error instanceof Error && error.message.includes("already exists"))) {
      res.status(409).json({ error: error.message });
    } else if (error instanceof Error && error.message === "Product not found") {
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
  const sales = await db.select().from(salesTable)
    .orderBy(desc(salesTable.saleDate), desc(salesTable.createdAt));
  res.json(GetSalesHistoryResponse.parse(sales));
});

router.get("/sales/refund-candidates", async (req, res): Promise<void> => {
  if (!(await requireSalesAccess(req, res))) return;
  const rows = await db.select({
    sale: salesTable,
    refundedCents: sql<string>`coalesce(sum(${salesRefundsTable.amountCents}), 0)::text`,
  }).from(salesTable)
    .leftJoin(salesRefundsTable, and(
      eq(salesRefundsTable.saleId, salesTable.id),
      eq(salesRefundsTable.status, "active"),
    ))
    .where(eq(salesTable.status, "active"))
    .groupBy(salesTable.id)
    .orderBy(desc(salesTable.saleDate), desc(salesTable.createdAt), desc(salesTable.id));

  const candidates = rows.flatMap(({ sale, refundedCents }) => {
    const refunded = BigInt(refundedCents);
    const total = BigInt(sale.totalCents);
    if (refunded > total) {
      throw new Error(`Active refunds exceed sale ${sale.id}`);
    }
    const remaining = total - refunded;
    if (remaining <= 0n) return [];
    return [{
      saleId: sale.id,
      saleDate: sale.saleDate,
      productId: sale.productId,
      productName: sale.productName,
      quantity: sale.quantity,
      totalCents: sale.totalCents,
      refundedCents: Number(refunded),
      remainingCents: Number(remaining),
      version: sale.version,
    }];
  });
  res.json(GetSalesRefundCandidatesResponse.parse(candidates));
});

router.get("/sales/refunds", async (req, res): Promise<void> => {
  if (!(await requireSalesAccess(req, res))) return;
  const rows = await db.select({
    refund: salesRefundsTable,
    sale: salesTable,
  }).from(salesRefundsTable)
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
  const [refund] = await db.select({ id: salesRefundsTable.id })
    .from(salesRefundsTable)
    .where(eq(salesRefundsTable.id, params.data.id))
    .limit(1);
  if (!refund) {
    res.status(404).json({ error: "Refund not found" });
    return;
  }
  const history = await db.select().from(salesHistoryTable)
    .where(sql`${salesHistoryTable.entityType} = 'refund' and ${salesHistoryTable.entityId} = ${params.data.id}`)
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
  const [sale] = await db.select({ id: salesTable.id }).from(salesTable)
    .where(eq(salesTable.id, params.data.id)).limit(1);
  if (!sale) {
    res.status(404).json({ error: "Sale not found" });
    return;
  }
  const history = await db.select().from(salesHistoryTable)
    .where(sql`${salesHistoryTable.entityType} = 'sale' and ${salesHistoryTable.entityId} = ${params.data.id}`)
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
    notes: string | null;
    sourceRow: number;
    totalCents: number;
  }> = [];
  for (const row of parsed.data.rows) {
    const saleDate = row.saleDate instanceof Date
      ? row.saleDate.toISOString().slice(0, 10)
      : parseSaleDate(row.saleDate);
    const productName = normalizeProductName(row.productName);
    const totalCents = calculateSaleTotalCents(row.quantity, row.unitAmountCents);
    if (!saleDate || !productName || productName.length > 120 || totalCents === null) {
      res.status(400).json({ error: `Invalid import data in row ${row.sourceRow}` });
      return;
    }
    normalizedRows.push({ ...row, saleDate, productName, totalCents, notes: row.notes?.trim() || null });
  }
  const actorId = getAuth(req).userId!;
  try {
    const result = await db.transaction(async (tx) => runIdempotent(
      tx,
      {
        actorId,
        operation: "sales-import",
        key: parsed.data.fileHash,
        request: { rows: normalizedRows },
      },
      async () => {
        const [batch] = await tx.insert(salesImportBatchesTable).values({
          actorId,
          source: "sales-file",
          fileHash: parsed.data.fileHash,
          status: "completed",
          rowCount: normalizedRows.length,
          completedAt: new Date(),
        }).returning();
        if (!batch) throw new Error("Could not create import batch");

        const importedSales = [];
        for (const row of normalizedRows) {
          const product = await getOrCreateProduct(tx, row.productName, row.unitAmountCents, actorId);
          const [sale] = await tx.insert(salesTable).values({
            productId: product.id,
            saleDate: row.saleDate,
            productName: product.name,
            quantity: row.quantity,
            unitAmountCents: row.unitAmountCents,
            totalCents: row.totalCents,
            notes: row.notes,
            createdBy: actorId,
            updatedBy: actorId,
          }).returning();
          if (!sale) throw new Error(`Could not import row ${row.sourceRow}`);
          await recordSalesHistory(tx, {
            entityType: "sale",
            entityId: sale.id,
            operation: "import",
            actorId,
            afterData: { ...sale, importBatchId: batch.id, sourceRow: row.sourceRow },
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
    ));
    res.status(result.replayed ? 200 : 201).json(ImportSalesResponse.parse({
      ...result.value,
      replayed: result.replayed,
    }));
  } catch (error) {
    if (error instanceof IdempotencyConflictError) {
      res.status(409).json({ error: error.message });
    } else if (error instanceof Error && error.message.startsWith("Invalid import data")) {
      res.status(400).json({ error: error.message });
    } else {
      throw error;
    }
  }
});

router.get("/sales-goals", async (req, res): Promise<void> => {
  if (!(await requireSalesAccess(req, res))) return;

  const goals = await db
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

  const actorId = getAuth(req).userId!;
  try {
    const result = await db.transaction(async (tx) => runIdempotent(
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
          if (!normalizedName) throw new Error("Select a plan from recorded sales");
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
          .where(sql`${salesGoalsTable.month} = ${parsed.data.month} and ${salesGoalsTable.scopeKey} = ${scopeKey}`)
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
    ));
    res.json(UpsertSalesGoalResponse.parse(result.value));
  } catch (error) {
    if (error instanceof IdempotencyConflictError) {
      res.status(409).json({ error: error.message });
    } else if (error instanceof Error && error.message === "Select a plan from recorded sales") {
      res.status(400).json({ error: error.message });
    } else {
      throw error;
    }
  }
});

router.post("/sales/restore", async (req, res): Promise<void> => {
  if (!(await requireSalesAccess(req, res))) return;

  const parsed = RestoreMonthlySalesBackupBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const backup = parsed.data;
  const rawSales = (req.body as { sales?: unknown[] }).sales;
  if (
    !Array.isArray(rawSales)
    || rawSales.length !== backup.sales.length
    || backup.recordCount !== backup.sales.length
    || backup.goalCount !== backup.goals.length
  ) {
    res.status(400).json({ error: "Backup counts do not match the included records" });
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
    const totalCents = calculateSaleTotalCents(sale.quantity, sale.unitAmountCents);
    if (
      !saleDate
      || saleDate.slice(0, 7) !== backup.month
      || totalCents === null
      || totalCents !== sale.totalCents
      || !normalizeProductName(sale.productName)
      || salesIds.has(sale.id)
    ) {
      res.status(400).json({ error: "Backup contains an invalid or duplicate sale record" });
      return;
    }
    salesIds.add(sale.id);
    saleDates.push(saleDate);
  }

  for (const goal of backup.goals) {
    const normalizedProduct = goal.productName === null
      ? null
      : normalizeProductName(goal.productName);
    const scopeKey = normalizedProduct === null
      ? "all-plans"
      : `plan:${productNameKey(normalizedProduct)}`;
    if (
      goal.month !== backup.month
      || (goal.productName !== null && !normalizedProduct)
      || productScopes.has(scopeKey)
      || goalIds.has(goal.id)
    ) {
      res.status(400).json({ error: "Backup contains an invalid or duplicate monthly goal" });
      return;
    }
    productScopes.add(scopeKey);
    goalIds.add(goal.id);
  }

  const actorId = getAuth(req).userId!;
  const restored = await db.transaction(async (tx) => {
    const productCache = new Map<string, Awaited<ReturnType<typeof getOrCreateProduct>>>();
    const getBackupProduct = async (name: string, initialPriceCents = 0) => {
      const normalized = normalizeProductName(name);
      const key = productNameKey(normalized);
      const cached = productCache.get(key);
      if (cached) return cached;
      const product = await getOrCreateProduct(tx, normalized, initialPriceCents, actorId, true);
      productCache.set(key, product);
      return product;
    };

    const preparedSales = [];
    for (let index = 0; index < backup.sales.length; index += 1) {
      const sale = backup.sales[index];
      const product = await getBackupProduct(sale.productName, sale.unitAmountCents);
      preparedSales.push({
        sale,
        saleDate: parseSaleDate((rawSales[index] as { saleDate?: unknown }).saleDate)!,
        productId: product.id,
        productName: normalizeProductName(sale.productName),
      });
    }

    let insertedSales = 0;
    for (let offset = 0; offset < preparedSales.length; offset += 500) {
      const rows = preparedSales.slice(offset, offset + 500).map(({ sale, saleDate, productId, productName }) => ({
        id: sale.id,
        productId,
        saleDate,
        productName,
        quantity: sale.quantity,
        unitAmountCents: sale.unitAmountCents,
        totalCents: sale.totalCents,
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

    for (const goal of backup.goals) {
      const normalizedProduct = goal.productName === null
        ? null
        : normalizeProductName(goal.productName);
      const product = normalizedProduct === null
        ? null
        : await getBackupProduct(normalizedProduct);
      const productName = product?.name ?? null;
      const scopeKey = product ? `product:${product.id}` : "all-plans";
      const [before] = await tx
        .select()
        .from(salesGoalsTable)
        .where(sql`${salesGoalsTable.month} = ${goal.month} and ${salesGoalsTable.scopeKey} = ${scopeKey}`)
        .limit(1);
      const [savedGoal] = await tx
        .insert(salesGoalsTable)
        .values({
          id: goal.id,
          month: goal.month,
          scopeKey,
          productId: product?.id ?? null,
          productName,
          targetCents: goal.targetCents,
          version: before ? before.version + 1 : 1,
          updatedAt: goal.updatedAt,
        })
        .onConflictDoUpdate({
          target: [salesGoalsTable.month, salesGoalsTable.scopeKey],
          set: {
            productId: product?.id ?? null,
            productName,
            targetCents: goal.targetCents,
            version: sql`${salesGoalsTable.version} + 1`,
            updatedAt: goal.updatedAt,
          },
        })
        .returning();
      if (savedGoal) {
        await recordSalesHistory(tx, {
          entityType: "goal",
          entityId: savedGoal.id,
          operation: before ? "restore-update" : "restore",
          actorId,
          beforeData: before ?? null,
          afterData: savedGoal,
        });
      }
    }

    return {
      insertedSales,
      skippedSales: backup.sales.length - insertedSales,
      restoredGoals: backup.goals.length,
    };
  });

  res.json(RestoreMonthlySalesBackupResponse.parse({
    month: backup.month,
    ...restored,
  }));
});

router.post("/sales", async (req, res): Promise<void> => {
  if (!(await requireSalesAccess(req, res))) return;

  const parsed = CreateSaleBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const saleDate = parseSaleDate((req.body as { saleDate?: unknown }).saleDate);
  const productName = normalizeProductName(parsed.data.productName);
  if (!saleDate || !productName) {
    res.status(400).json({ error: "Enter a valid sale date and product name" });
    return;
  }

  const totalCents = calculateSaleTotalCents(parsed.data.quantity, parsed.data.unitAmountCents);
  if (totalCents === null) {
    res.status(400).json({ error: "The calculated sale total is too large" });
    return;
  }

  const actorId = getAuth(req).userId!;
  try {
    const result = await db.transaction(async (tx) => runIdempotent(
      tx,
      {
        actorId,
        operation: "sale-create",
        key: parsed.data.idempotencyKey,
        request: parsed.data,
      },
      async () => {
        const product = await getOrCreateProduct(tx, productName, parsed.data.unitAmountCents, actorId);
        const [created] = await tx
          .insert(salesTable)
          .values({
            productId: product.id,
            saleDate,
            productName: product.name,
            quantity: parsed.data.quantity,
            unitAmountCents: parsed.data.unitAmountCents,
            totalCents,
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
    ));
    res.status(result.replayed ? 200 : 201).json(CreateSaleResponse.parse(result.value));
  } catch (error) {
    if (error instanceof IdempotencyConflictError || error instanceof ProductUnavailableError) {
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

  const saleDate = parseSaleDate((req.body as { saleDate?: unknown }).saleDate);
  const productName = normalizeProductName(parsed.data.productName);
  if (!saleDate || !productName) {
    res.status(400).json({ error: "Enter a valid sale date and product name" });
    return;
  }

  const totalCents = calculateSaleTotalCents(parsed.data.quantity, parsed.data.unitAmountCents);
  if (totalCents === null) {
    res.status(400).json({ error: "The calculated sale total is too large" });
    return;
  }

  const actorId = getAuth(req).userId!;
  try {
    const result = await db.transaction(async (tx) => runIdempotent(
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
          throw new Error("A sale with an active refund cannot be moved to another product");
        }
        if (BigInt(totalCents) < BigInt(refundSummary.refundedCents)) {
          throw new Error("Sale total cannot be lower than active refunds");
        }
        if (refundSummary.latestRefundDate && saleDate > refundSummary.latestRefundDate) {
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
    ));
    res.json(UpdateSaleResponse.parse(result.value));
  } catch (error) {
    if (error instanceof IdempotencyConflictError || error instanceof VersionConflictError
      || error instanceof ProductUnavailableError) {
      res.status(409).json({ error: error.message });
    } else if (error instanceof Error && error.message === "Sale not found") {
      res.status(404).json({ error: error.message });
    } else if (error instanceof SaleUnavailableForRefundError
      || (error instanceof Error && error.message.toLowerCase().includes("refund"))) {
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
    const result = await db.transaction(async (tx) => runIdempotent(
      tx,
      {
        actorId,
        operation: `sale-cancel:${params.data.id}`,
        key: parsed.data.idempotencyKey,
        request: { reason, expectedVersion: parsed.data.expectedVersion },
      },
      async () => {
        const [current] = await tx.select().from(salesTable)
          .where(eq(salesTable.id, params.data.id)).for("update").limit(1);
        if (!current || current.status !== "active") throw new Error("Sale not found");
        if (current.version !== parsed.data.expectedVersion) throw new VersionConflictError();

        const [activeRefund] = await tx.select({ id: salesRefundsTable.id }).from(salesRefundsTable)
          .where(sql`${salesRefundsTable.saleId} = ${current.id} and ${salesRefundsTable.status} = 'active'`)
          .limit(1);
        if (activeRefund) throw new Error("A sale with an active refund cannot be cancelled");

        const [updated] = await tx.update(salesTable).set({
          status: "cancelled",
          cancellationReason: reason,
          version: current.version + 1,
          updatedBy: actorId,
          updatedAt: new Date(),
        }).where(eq(salesTable.id, current.id)).returning();
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
    ));
    res.json(CancelSaleResponse.parse(result.value));
  } catch (error) {
    if (error instanceof IdempotencyConflictError || error instanceof VersionConflictError
      || (error instanceof Error && error.message.includes("active refund"))) {
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
  if (!refundDate || !reason || reason.length > 500
    || !Number.isSafeInteger(parsed.data.amountCents) || parsed.data.amountCents <= 0) {
    res.status(400).json({ error: "Enter a valid refund date, positive amount, and reason" });
    return;
  }

  const actorId = getAuth(req).userId!;
  try {
    const result = await db.transaction(async (tx) => runIdempotent(
      tx,
      {
        actorId,
        operation: `sales-refund-create:${params.data.id}`,
        key: parsed.data.idempotencyKey,
        request: { refundDate, amountCents: parsed.data.amountCents, reason },
      },
      async () => {
        const balance = await lockSaleForRefund(tx, params.data.id);
        if (refundDate < balance.sale.saleDate) {
          throw new Error("Refund date cannot be before the sale date");
        }
        if (parsed.data.amountCents > balance.remainingCents) {
          throw new SaleUnavailableForRefundError("Refund amount exceeds the available sale balance");
        }
        const [refund] = await tx.insert(salesRefundsTable).values({
          saleId: balance.sale.id,
          refundDate,
          amountCents: parsed.data.amountCents,
          reason,
          createdBy: actorId,
          updatedBy: actorId,
        }).returning();
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
    ));
    res.status(result.replayed ? 200 : 201).json(CreateSalesRefundResponse.parse(result.value));
  } catch (error) {
    if (error instanceof IdempotencyConflictError || error instanceof SaleUnavailableForRefundError) {
      if (error instanceof SaleUnavailableForRefundError && error.message === "Sale not found") {
        res.status(404).json({ error: error.message });
      } else {
        res.status(409).json({ error: error.message });
      }
    } else if (error instanceof Error && error.message.includes("Refund date cannot be before")) {
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
  if (!refundDate || !reason || reason.length > 500
    || !Number.isSafeInteger(parsed.data.amountCents) || parsed.data.amountCents <= 0) {
    res.status(400).json({ error: "Enter a valid refund date, positive amount, and reason" });
    return;
  }

  const actorId = getAuth(req).userId!;
  try {
    const result = await db.transaction(async (tx) => runIdempotent(
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
        const [before] = await tx.select().from(salesRefundsTable)
          .where(eq(salesRefundsTable.id, params.data.id)).limit(1);
        if (!before) throw new Error("Refund not found");
        const balance = await lockSaleForRefund(tx, before.saleId);
        const [current] = await tx.select().from(salesRefundsTable)
          .where(eq(salesRefundsTable.id, params.data.id)).for("update").limit(1);
        if (!current) throw new Error("Refund not found");
        if (current.status !== "active") throw new Error("Only active refunds can be corrected");
        if (current.version !== parsed.data.expectedVersion) throw new VersionConflictError();
        if (refundDate < balance.sale.saleDate) {
          throw new Error("Refund date cannot be before the sale date");
        }
        const otherRefundsCents = BigInt(balance.refundedCents) - BigInt(current.amountCents);
        const maximumRefundCents = BigInt(balance.sale.totalCents) - otherRefundsCents;
        if (otherRefundsCents < 0n || BigInt(parsed.data.amountCents) > maximumRefundCents) {
          throw new SaleUnavailableForRefundError("Corrected refund exceeds the available sale balance");
        }
        const [updated] = await tx.update(salesRefundsTable).set({
          refundDate,
          amountCents: parsed.data.amountCents,
          reason,
          version: current.version + 1,
          updatedBy: actorId,
          updatedAt: new Date(),
        }).where(eq(salesRefundsTable.id, current.id)).returning();
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
    ));
    res.json(UpdateSalesRefundResponse.parse(result.value));
  } catch (error) {
    if (error instanceof IdempotencyConflictError || error instanceof VersionConflictError
      || error instanceof SaleUnavailableForRefundError
      || (error instanceof Error && error.message === "Only active refunds can be corrected")) {
      res.status(409).json({ error: error.message });
    } else if (error instanceof Error && error.message === "Refund not found") {
      res.status(404).json({ error: error.message });
    } else if (error instanceof Error && error.message.includes("Refund date cannot be before")) {
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
    const result = await db.transaction(async (tx) => runIdempotent(
      tx,
      {
        actorId,
        operation: `sales-refund-void:${params.data.id}`,
        key: parsed.data.idempotencyKey,
        request: { reason, expectedVersion: parsed.data.expectedVersion },
      },
      async () => {
        const [before] = await tx.select().from(salesRefundsTable)
          .where(eq(salesRefundsTable.id, params.data.id)).limit(1);
        if (!before) throw new Error("Refund not found");
        await lockSaleForRefund(tx, before.saleId);
        const [current] = await tx.select().from(salesRefundsTable)
          .where(eq(salesRefundsTable.id, params.data.id)).for("update").limit(1);
        if (!current) throw new Error("Refund not found");
        if (current.status !== "active") throw new Error("Only active refunds can be voided");
        if (current.version !== parsed.data.expectedVersion) throw new VersionConflictError();
        const [updated] = await tx.update(salesRefundsTable).set({
          status: "voided",
          voidReason: reason,
          version: current.version + 1,
          updatedBy: actorId,
          updatedAt: new Date(),
        }).where(eq(salesRefundsTable.id, current.id)).returning();
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
    ));
    res.json(VoidSalesRefundResponse.parse(result.value));
  } catch (error) {
    if (error instanceof IdempotencyConflictError || error instanceof VersionConflictError
      || error instanceof SaleUnavailableForRefundError
      || (error instanceof Error && error.message === "Only active refunds can be voided")) {
      res.status(409).json({ error: error.message });
    } else if (error instanceof Error && error.message === "Refund not found") {
      res.status(404).json({ error: error.message });
    } else {
      throw error;
    }
  }
});

export default router;
