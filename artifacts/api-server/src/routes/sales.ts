import { getAuth } from "@clerk/express";
import {
  CreateSaleBody,
  CreateSaleResponse,
  DeleteSaleParams,
  GetAccessStatusResponse,
  GetSalesGoalsResponse,
  GetSalesResponse,
  RestoreMonthlySalesBackupBody,
  RestoreMonthlySalesBackupResponse,
  UpsertSalesGoalBody,
  UpsertSalesGoalResponse,
  UpdateSaleBody,
  UpdateSaleParams,
  UpdateSaleResponse,
} from "@workspace/api-zod";
import { db, salesGoalsTable, salesTable } from "@workspace/db";
import { asc, desc, eq, sql } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import { isAuthorizedUser } from "../lib/authorization";

const router: IRouter = Router();
const MAX_SAFE_CENTS = Number.MAX_SAFE_INTEGER;
const PRODUCT_NAME_LOCK_NAMESPACE = 5062;
const PRODUCT_NAME_LOCK_KEY = 1;

function normalizeProductName(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function productNameKey(value: string): string {
  return normalizeProductName(value).toLocaleLowerCase("pt-BR");
}

function saleDateFromRequest(body: unknown): string | null {
  if (!body || typeof body !== "object" || !("saleDate" in body)) {
    return null;
  }

  const value = body.saleDate;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }

  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (Number.isNaN(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) {
    return null;
  }

  return value;
}

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

router.get("/sales", async (req, res): Promise<void> => {
  if (!(await requireSalesAccess(req, res))) return;

  const sales = await db
    .select()
    .from(salesTable)
    .orderBy(desc(salesTable.saleDate), desc(salesTable.createdAt));

  res.json(GetSalesResponse.parse(sales));
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

  let productName: string | null = null;
  let scopeKey = "all-plans";
  if (parsed.data.productName !== null) {
    const requestedName = normalizeProductName(parsed.data.productName);
    if (!requestedName) {
      res.status(400).json({ error: "Select a plan from recorded sales" });
      return;
    }

    const existingNames = await db
      .select({ productName: salesTable.productName })
      .from(salesTable)
      .orderBy(asc(salesTable.createdAt), asc(salesTable.id));
    const existing = existingNames.find(
      ({ productName: existingName }) => productNameKey(existingName) === productNameKey(requestedName),
    );
    if (!existing) {
      res.status(400).json({ error: "Select a plan from recorded sales" });
      return;
    }

    productName = normalizeProductName(existing.productName);
    scopeKey = `plan:${productNameKey(productName)}`;
  }

  const [goal] = await db
    .insert(salesGoalsTable)
    .values({
      month: parsed.data.month,
      scopeKey,
      productName,
      targetCents: parsed.data.targetCents,
    })
    .onConflictDoUpdate({
      target: [salesGoalsTable.month, salesGoalsTable.scopeKey],
      set: {
        productName,
        targetCents: parsed.data.targetCents,
        updatedAt: new Date(),
      },
    })
    .returning();

  res.json(UpsertSalesGoalResponse.parse(goal));
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
    const saleDate = saleDateFromRequest(rawSales[index]);
    const totalCents = sale.quantity * sale.unitAmountCents;
    if (
      !saleDate
      || saleDate.slice(0, 7) !== backup.month
      || !Number.isSafeInteger(totalCents)
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

  const restored = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${PRODUCT_NAME_LOCK_NAMESPACE}, ${PRODUCT_NAME_LOCK_KEY})`);
    const existingNames = await tx
      .select({ productName: salesTable.productName })
      .from(salesTable)
      .orderBy(asc(salesTable.createdAt), asc(salesTable.id));
    const canonicalNames = new Map<string, string>();
    for (const row of existingNames) {
      const normalized = normalizeProductName(row.productName);
      const key = productNameKey(normalized);
      if (!canonicalNames.has(key)) canonicalNames.set(key, normalized);
    }

    const importedProductNames = backup.sales.map((sale) => {
      const normalized = normalizeProductName(sale.productName);
      const key = productNameKey(normalized);
      const canonical = canonicalNames.get(key) ?? normalized;
      canonicalNames.set(key, canonical);
      return canonical;
    });

    let insertedSales = 0;
    for (let offset = 0; offset < backup.sales.length; offset += 500) {
      const rows = backup.sales.slice(offset, offset + 500).map((sale, chunkIndex) => ({
        id: sale.id,
        saleDate: saleDates[offset + chunkIndex],
        productName: importedProductNames[offset + chunkIndex],
        quantity: sale.quantity,
        unitAmountCents: sale.unitAmountCents,
        totalCents: sale.totalCents,
        notes: sale.notes,
        createdAt: sale.createdAt,
      }));
      if (rows.length === 0) continue;
      const inserted = await tx
        .insert(salesTable)
        .values(rows)
        .onConflictDoNothing({ target: salesTable.id })
        .returning({ id: salesTable.id });
      insertedSales += inserted.length;
    }

    for (const goal of backup.goals) {
      const normalizedProduct = goal.productName === null
        ? null
        : normalizeProductName(goal.productName);
      const productName = normalizedProduct === null
        ? null
        : canonicalNames.get(productNameKey(normalizedProduct)) ?? normalizedProduct;
      const scopeKey = productName === null
        ? "all-plans"
        : `plan:${productNameKey(productName)}`;
      await tx
        .insert(salesGoalsTable)
        .values({
          id: goal.id,
          month: goal.month,
          scopeKey,
          productName,
          targetCents: goal.targetCents,
          updatedAt: goal.updatedAt,
        })
        .onConflictDoUpdate({
          target: [salesGoalsTable.month, salesGoalsTable.scopeKey],
          set: {
            productName,
            targetCents: goal.targetCents,
            updatedAt: goal.updatedAt,
          },
        });
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

  const saleDate = saleDateFromRequest(req.body);
  const productName = normalizeProductName(parsed.data.productName);
  if (!saleDate || !productName) {
    res.status(400).json({ error: "Enter a valid sale date and product name" });
    return;
  }

  const totalCents = parsed.data.quantity * parsed.data.unitAmountCents;
  if (!Number.isSafeInteger(totalCents) || totalCents > MAX_SAFE_CENTS) {
    res.status(400).json({ error: "The calculated sale total is too large" });
    return;
  }

  const sale = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${PRODUCT_NAME_LOCK_NAMESPACE}, ${PRODUCT_NAME_LOCK_KEY})`);
    const existingNames = await tx
      .select({ productName: salesTable.productName })
      .from(salesTable)
      .orderBy(asc(salesTable.createdAt), asc(salesTable.id));
    const existing = existingNames.find(
      ({ productName: existingName }) => productNameKey(existingName) === productNameKey(productName),
    );
    const [created] = await tx
      .insert(salesTable)
      .values({
        saleDate,
        productName: existing ? normalizeProductName(existing.productName) : productName,
        quantity: parsed.data.quantity,
        unitAmountCents: parsed.data.unitAmountCents,
        totalCents,
        notes: parsed.data.notes?.trim() || null,
      })
      .returning();
    return created;
  });

  res.status(201).json(CreateSaleResponse.parse(sale));
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

  const saleDate = saleDateFromRequest(req.body);
  const productName = normalizeProductName(parsed.data.productName);
  if (!saleDate || !productName) {
    res.status(400).json({ error: "Enter a valid sale date and product name" });
    return;
  }

  const totalCents = parsed.data.quantity * parsed.data.unitAmountCents;
  if (!Number.isSafeInteger(totalCents) || totalCents > MAX_SAFE_CENTS) {
    res.status(400).json({ error: "The calculated sale total is too large" });
    return;
  }

  const sale = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${PRODUCT_NAME_LOCK_NAMESPACE}, ${PRODUCT_NAME_LOCK_KEY})`);
    const [current] = await tx
      .select({ id: salesTable.id })
      .from(salesTable)
      .where(eq(salesTable.id, params.data.id))
      .limit(1);
    if (!current) return null;

    const existingNames = await tx
      .select({ productName: salesTable.productName })
      .from(salesTable)
      .orderBy(asc(salesTable.createdAt), asc(salesTable.id));
    const existing = existingNames.find(
      ({ productName: existingName }) => productNameKey(existingName) === productNameKey(productName),
    );
    const [updated] = await tx
      .update(salesTable)
      .set({
        saleDate,
        productName: existing ? normalizeProductName(existing.productName) : productName,
        quantity: parsed.data.quantity,
        unitAmountCents: parsed.data.unitAmountCents,
        totalCents,
        notes: parsed.data.notes?.trim() || null,
      })
      .where(eq(salesTable.id, params.data.id))
      .returning();
    return updated ?? null;
  });

  if (!sale) {
    res.status(404).json({ error: "Sale not found" });
    return;
  }

  res.json(UpdateSaleResponse.parse(sale));
});

router.delete("/sales/:id", async (req, res): Promise<void> => {
  if (!(await requireSalesAccess(req, res))) return;

  const params = DeleteSaleParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [sale] = await db
    .delete(salesTable)
    .where(eq(salesTable.id, params.data.id))
    .returning({ id: salesTable.id });

  if (!sale) {
    res.status(404).json({ error: "Sale not found" });
    return;
  }

  res.sendStatus(204);
});

export default router;
