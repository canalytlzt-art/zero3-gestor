import {
  CancelSaleBody,
  CreateProductBody,
  CreateSaleBody,
  CreateSalesRefundBody,
  GetSalesImportOriginsQueryParams,
  GetSalesImportOriginsResponse,
  GetSalesPendingDraftsResponse,
  GetProductsResponse,
  GetSaleHistoryParams,
  GetSaleHistoryResponse,
  GetSalesHistoryResponse,
  GetSalesResponse,
  GetSalesScoreboardQueryParams,
  GetSalesScoreboardResponse,
  GetSalesGoalsResponse,
  GetActiveContractsResponse,
  GetSalesRefundCandidatesResponse,
  GetSalesRefundsResponse,
  GetMonthlySalesBackupQueryParams,
  GetMonthlySalesBackupResponse,
  PreviewMonthlySalesBackupRestoreBody,
  PreviewMonthlySalesBackupRestoreResponse,
  RestoreMonthlySalesBackupBody,
  RestoreMonthlySalesBackupResponse,
  GetSalesRefundHistoryParams,
  GetSalesRefundHistoryResponse,
  CreateSalesPeriodBackupBody,
  CreateSalesPeriodBackupResponse,
  ImportSalesBody,
  ImportSalesResponse,
  UpdateSalesPendingDraftBody,
  UpdateSalesPendingDraftParams,
  UpdateSalesPendingDraftResponse,
  UpdateProductBody,
  UpdateSaleBody,
  UpdateSalesRefundBody,
  UpdateSalesRefundParams,
  UpdateSalesRefundResponse,
  UpsertSalesGoalBody,
  UpsertActiveContractsMonthBody,
  UpsertActiveContractsMonthParams,
  UpsertActiveContractsMonthResponse,
  VoidSalesRefundBody,
  VoidSalesRefundParams,
  VoidSalesRefundResponse,
} from "@workspace/api-zod";
import type { AuthContext, D1Database, WorkerEnv } from "./types";
import { apiError, json, readJson } from "./http";
import { ApiFailure, findIdempotent, runIdempotent } from "./idempotency";
import { getIsoWeekStart, getIsoWeekday } from "../lib/occupancy-calendar";

type Row = Record<string, unknown>;

const asRows = async <T extends Row>(
  statement: ReturnType<D1Database["prepare"]>,
): Promise<T[]> => {
  const result = await statement.all<T>();
  return result.results ?? [];
};

const dateOnly = (value: unknown): string | null => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const time = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isNaN(time) || new Date(time).toISOString().slice(0, 10) !== value
    ? null
    : value;
};

const normalizeName = (value: string) => value.trim().replace(/\s+/g, " ");
const nameKey = (value: string) => normalizeName(value).toLocaleLowerCase("pt-BR");
const nowIso = () => new Date().toISOString();

function productOut(row: Row) {
  return {
    id: String(row.id),
    name: String(row.name),
    normalizedName: String(row.normalized_name),
    modalityId: row.modality_id === null ? null : String(row.modality_id),
    suggestedPriceCents: Number(row.suggested_price_cents),
    isActive: Boolean(row.is_active),
    version: Number(row.version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function saleOut(row: Row) {
  return {
    id: String(row.id),
    productId: row.product_id === null ? null : String(row.product_id),
    modalityId: row.modality_id === null ? null : String(row.modality_id),
    modalityOverride: Boolean(row.modality_override),
    saleDate: String(row.sale_date),
    productName: String(row.product_name),
    quantity: Number(row.quantity),
    unitAmountCents: Number(row.unit_amount_cents),
    totalCents: Number(row.total_cents),
    customerName: row.customer_name === null ? null : String(row.customer_name),
    notes: row.notes === null ? null : String(row.notes),
    status: String(row.status),
    cancellationReason:
      row.cancellation_reason === null ? null : String(row.cancellation_reason),
    version: Number(row.version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function refundOut(row: Row) {
  return {
    id: String(row.id),
    saleId: String(row.sale_id),
    refundDate: String(row.refund_date),
    amountCents: Number(row.amount_cents),
    reason: String(row.reason),
    status: String(row.status),
    voidReason: row.void_reason === null ? null : String(row.void_reason),
    version: Number(row.version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

async function recordHistory(
  db: D1Database,
  entityType: string,
  entityId: string,
  operation: string,
  actorId: string,
  beforeData: unknown,
  afterData: unknown,
) {
  await db
    .prepare(
      `INSERT INTO sales_history
        (id, entity_type, entity_id, operation, actor_id, before_data, after_data, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      entityType,
      entityId,
      operation,
      actorId,
      beforeData === null ? null : JSON.stringify(beforeData),
      afterData === null ? null : JSON.stringify(afterData),
      nowIso(),
    )
    .run();
}

async function getProduct(db: D1Database, id: string) {
  return db
    .prepare("SELECT * FROM products WHERE id = ?")
    .bind(id)
    .first<Row>();
}

async function getSale(db: D1Database, id: string) {
  return db.prepare("SELECT * FROM sales WHERE id = ?").bind(id).first<Row>();
}

function bodyParse<T>(
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { message: string } } },
  value: unknown,
): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiFailure(400, result.error.message);
  return result.data;
}

function conflictIfChanged(result: { meta?: { changes?: number } }, message: string) {
  if (Number(result.meta?.changes ?? 0) === 0) throw new ApiFailure(409, message);
}

async function createProduct(
  request: Request,
  env: WorkerEnv,
  actor: AuthContext,
): Promise<Response> {
  const input = bodyParse(CreateProductBody, await readJson(request));
  const name = normalizeName(input.name);
  const normalizedName = nameKey(name);
  if (!name) throw new ApiFailure(400, "Informe um nome de produto válido.");
  const previous = await findIdempotent(
    env.DB,
    actor,
    "product-create",
    input.idempotencyKey,
    { ...input, name, normalizedName },
  );
  if (previous) {
    const replayedProduct = await getProduct(env.DB, previous.resourceId);
    if (!replayedProduct) throw new ApiFailure(409, "O produto idempotente não foi encontrado.");
    return json(productOut(replayedProduct));
  }
  if (input.modalityId) {
    const modality = await env.DB
      .prepare("SELECT id FROM occupancy_modalities WHERE id = ?")
      .bind(input.modalityId)
      .first();
    if (!modality) throw new ApiFailure(400, "A modalidade selecionada não existe.");
  }
  const duplicate = await env.DB
    .prepare("SELECT id FROM products WHERE normalized_name = ?")
    .bind(normalizedName)
    .first();
  if (duplicate) throw new ApiFailure(409, "Já existe um produto com esse nome.");

  const id = crypto.randomUUID();
  const now = nowIso();
  await runIdempotent(
    env.DB,
    actor,
    "product-create",
    input.idempotencyKey,
    { ...input, name, normalizedName },
    id,
    (operationId) => [
      env.DB
        .prepare(
          `INSERT INTO products
            (id, name, normalized_name, modality_id, suggested_price_cents, is_active, version, created_at, updated_at)
           SELECT ?, ?, ?, ?, ?, ?, 1, ?, ?
           WHERE EXISTS (SELECT 1 FROM idempotency_keys WHERE id = ?)
           ON CONFLICT(normalized_name) DO NOTHING`,
        )
        .bind(
          id,
          name,
          normalizedName,
          input.modalityId ?? null,
          input.suggestedPriceCents,
          Number(input.isActive),
          now,
          now,
          operationId,
        ),
      env.DB.prepare(
        `INSERT INTO sales_history
          (id, entity_type, entity_id, operation, actor_id, before_data, after_data, created_at)
         SELECT ?, 'product', id, 'create', ?, NULL, json_object('id', id, 'name', name,
           'normalizedName', normalized_name, 'modalityId', modality_id,
           'suggestedPriceCents', suggested_price_cents, 'isActive', is_active,
           'version', version, 'createdAt', created_at, 'updatedAt', updated_at), ?
         FROM products WHERE id=? AND EXISTS (SELECT 1 FROM idempotency_keys WHERE id=?)`,
      ).bind(crypto.randomUUID(), actor.userId, now, id, operationId),
    ],
  );
  const row = await getProduct(env.DB, id);
  if (!row) throw new ApiFailure(409, "Já existe um produto com esse nome.");
  return json(productOut(row), 201);
}

async function updateProduct(
  request: Request,
  env: WorkerEnv,
  actor: AuthContext,
  id: string,
): Promise<Response> {
  const input = bodyParse(UpdateProductBody, await readJson(request));
  const name = normalizeName(input.name);
  const normalizedName = nameKey(name);
  const previous = await findIdempotent(
    env.DB,
    actor,
    `product-update:${id}`,
    input.idempotencyKey,
    { ...input, name, normalizedName },
  );
  if (previous) {
    const replayed = await getProduct(env.DB, previous.resourceId);
    if (!replayed) throw new ApiFailure(409, "O produto idempotente não foi encontrado.");
    return json(productOut(replayed));
  }
  const current = await getProduct(env.DB, id);
  if (!current) throw new ApiFailure(404, "Produto não encontrado.");
  if (Number(current.version) !== input.expectedVersion) {
    throw new ApiFailure(409, "O produto foi alterado. Atualize antes de salvar.");
  }
  if (input.modalityId) {
    const modality = await env.DB
      .prepare("SELECT id FROM occupancy_modalities WHERE id = ?")
      .bind(input.modalityId)
      .first();
    if (!modality) throw new ApiFailure(400, "A modalidade selecionada não existe.");
  }
  const duplicate = await env.DB
    .prepare("SELECT id FROM products WHERE normalized_name = ? AND id <> ?")
    .bind(normalizedName, id)
    .first();
  if (duplicate) throw new ApiFailure(409, "Já existe um produto com esse nome.");
  const updatedAt = nowIso();
  const responseId = crypto.randomUUID();
  await runIdempotent(
    env.DB,
    actor,
    `product-update:${id}`,
    input.idempotencyKey,
    { ...input, name, normalizedName },
    id,
    (operationId) => [
      env.DB
        .prepare(
          `UPDATE products SET name = ?, normalized_name = ?, suggested_price_cents = ?,
             is_active = ?, modality_id = ?, version = version + 1, updated_at = ?
           WHERE id = ? AND version = ?
             AND EXISTS (SELECT 1 FROM idempotency_keys WHERE id = ?)`,
        )
        .bind(
          name,
          normalizedName,
          input.suggestedPriceCents,
          Number(input.isActive),
          input.modalityId === undefined ? current.modality_id : input.modalityId,
          updatedAt,
          id,
          input.expectedVersion,
          operationId,
        ),
      env.DB
        .prepare(
          `INSERT INTO sales_history
            (id, entity_type, entity_id, operation, actor_id, before_data, after_data, created_at)
           SELECT ?, 'product', ?, 'update', ?, ?, json_object('id', id, 'name', name,
             'normalizedName', normalized_name, 'suggestedPriceCents', suggested_price_cents,
             'isActive', is_active, 'modalityId', modality_id, 'version', version,
             'createdAt', created_at, 'updatedAt', updated_at), ?
           FROM products WHERE id = ? AND version = ? AND updated_at = ?
             AND EXISTS (SELECT 1 FROM idempotency_keys WHERE id = ?)`,
        )
        .bind(
          responseId,
          id,
          actor.userId,
          JSON.stringify(current),
          updatedAt,
          id,
          input.expectedVersion + 1,
          updatedAt,
          operationId,
        ),
    ],
  );
  const row = await getProduct(env.DB, id);
  if (!row) throw new ApiFailure(404, "Produto não encontrado.");
  if (Number(row.version) !== input.expectedVersion + 1) {
    throw new ApiFailure(409, "O produto foi alterado. Atualize antes de salvar.");
  }
  return json(productOut(row));
}

async function createSale(
  request: Request,
  env: WorkerEnv,
  actor: AuthContext,
): Promise<Response> {
  const raw = await readJson(request);
  const input = bodyParse(CreateSaleBody, raw);
  const saleDate =
    typeof (raw as { saleDate?: unknown } | null)?.saleDate === "string"
      ? dateOnly((raw as { saleDate: string }).saleDate)
      : null;
  const productName = normalizeName(input.productName);
  const productKey = nameKey(productName);
  if (!saleDate || !productName) {
    throw new ApiFailure(400, "Informe uma data de venda e um produto válidos.");
  }
  const total = BigInt(input.quantity) * BigInt(input.unitAmountCents);
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ApiFailure(400, "O total calculado para a venda é muito alto.");
  }
  const totalCents = Number(total);
  const id = crypto.randomUUID();
  const productId = crypto.randomUUID();
  const now = nowIso();
  const customerName = input.customerName?.trim().replace(/\s+/g, " ") || null;
  const notes = input.notes?.trim() || null;
  if (input.modalityId) {
    const modality = await env.DB
      .prepare("SELECT id FROM occupancy_modalities WHERE id=?")
      .bind(input.modalityId)
      .first<Row>();
    if (!modality) throw new ApiFailure(400, "A modalidade selecionada não existe.");
  }
  const modalityOverride = input.modalityId === undefined ? 0 : 1;

  const operation = await runIdempotent(
    env.DB,
    actor,
    "sale-create",
    input.idempotencyKey,
    { ...input, saleDate, productName },
    id,
    (operationId) => [
      env.DB
        .prepare(
          `INSERT INTO products
            (id, name, normalized_name, suggested_price_cents, is_active, version, created_at, updated_at)
           SELECT ?, ?, ?, 0, 1, 1, ?, ?
           WHERE EXISTS (SELECT 1 FROM idempotency_keys WHERE id = ?)
           ON CONFLICT(normalized_name) DO NOTHING`,
        )
        .bind(productId, productName, productKey, now, now, operationId),
      env.DB
        .prepare(
          `INSERT INTO sales
            (id, product_id, sale_date, product_name, quantity, unit_amount_cents, total_cents,
             modality_id, modality_override,
             customer_name, notes, status, cancellation_reason, version, created_by, updated_by, created_at, updated_at)
           SELECT ?, id, ?, name, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, 1, ?, ?, ?, ?
           FROM products
           WHERE normalized_name = ? AND is_active = 1
             AND EXISTS (SELECT 1 FROM idempotency_keys WHERE id = ?)`,
        )
        .bind(
          id,
          saleDate,
          input.quantity,
          input.unitAmountCents,
          totalCents,
          input.modalityId ?? null,
          modalityOverride,
          customerName,
          notes,
          actor.userId,
          actor.userId,
          now,
          now,
          productKey,
          operationId,
        ),
      env.DB
        .prepare(
          `INSERT INTO sales_history
            (id, entity_type, entity_id, operation, actor_id, before_data, after_data, created_at)
           SELECT ?, 'sale', id, 'create', ?, NULL, json_object('id', id, 'productId', product_id,
             'saleDate', sale_date, 'productName', product_name, 'quantity', quantity,
             'unitAmountCents', unit_amount_cents, 'totalCents', total_cents,
              'modalityId', modality_id, 'modalityOverride', modality_override,
              'customerName', customer_name, 'notes', notes, 'status', status,
             'version', version, 'createdAt', created_at, 'updatedAt', updated_at), ?
           FROM sales WHERE id = ? AND EXISTS (SELECT 1 FROM idempotency_keys WHERE id = ?)`,
        )
        .bind(crypto.randomUUID(), actor.userId, now, id, operationId),
    ],
  );
  const row = await getSale(env.DB, operation.resourceId);
  if (!row) throw new ApiFailure(409, "O plano está inativo ou não foi possível registrar a venda.");
  if (operation.replayed) return json(saleOut(row));
  return json(saleOut(row), 201);
}

async function updateSale(
  request: Request,
  env: WorkerEnv,
  actor: AuthContext,
  id: string,
): Promise<Response> {
  const raw = await readJson(request);
  const input = bodyParse(UpdateSaleBody, raw);
  const saleDate =
    typeof (raw as { saleDate?: unknown } | null)?.saleDate === "string"
      ? dateOnly((raw as { saleDate: string }).saleDate)
      : null;
  const productName = normalizeName(input.productName);
  if (!saleDate || !productName) {
    throw new ApiFailure(400, "Informe uma data de venda e um produto válidos.");
  }
  const customerName = input.customerName?.trim().replace(/\s+/g, " ") || null;
  const notes = input.notes?.trim() || null;
  if (input.modalityId) {
    const modality = await env.DB
      .prepare("SELECT id FROM occupancy_modalities WHERE id=?")
      .bind(input.modalityId)
      .first<Row>();
    if (!modality) throw new ApiFailure(400, "A modalidade selecionada não existe.");
  }
  const hasModalityOverride = input.modalityId !== undefined;
  const requestData = { ...input, saleDate, productName, customerName, notes };
  const previous = await findIdempotent(
    env.DB,
    actor,
    `sale-update:${id}`,
    input.idempotencyKey,
    requestData,
  );
  if (previous) {
    const replayed = await getSale(env.DB, previous.resourceId);
    if (!replayed) throw new ApiFailure(409, "A venda idempotente não foi encontrada.");
    return json(saleOut(replayed));
  }
  const total = BigInt(input.quantity) * BigInt(input.unitAmountCents);
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ApiFailure(400, "O total calculado para a venda é muito alto.");
  }
  const current = await getSale(env.DB, id);
  if (!current || current.status !== "active") throw new ApiFailure(404, "Venda não encontrada.");
  if (Number(current.version) !== input.expectedVersion) {
    throw new ApiFailure(409, "A venda foi alterada. Atualize antes de salvar.");
  }

  const productNameNormalized = nameKey(productName);
  const existingProduct = await env.DB
    .prepare("SELECT id, is_active FROM products WHERE normalized_name = ?")
    .bind(productNameNormalized)
    .first<Row>();
  if (existingProduct && !Boolean(existingProduct.is_active)) {
    throw new ApiFailure(409, "O produto está inativo.");
  }
  const productId = String(existingProduct?.id ?? crypto.randomUUID());
  const now = nowIso();
  const operation = await runIdempotent(
    env.DB,
    actor,
    `sale-update:${id}`,
    input.idempotencyKey,
    requestData,
    id,
    (operationId) => [
      env.DB
        .prepare(
          `INSERT INTO products
            (id, name, normalized_name, suggested_price_cents, is_active, version, created_at, updated_at)
           SELECT ?, ?, ?, 0, 1, 1, ?, ?
           WHERE EXISTS (SELECT 1 FROM idempotency_keys WHERE id = ?)
           ON CONFLICT(normalized_name) DO NOTHING`,
        )
        .bind(productId, productName, productNameNormalized, now, now, operationId),
      env.DB
        .prepare(
          `UPDATE sales SET product_id = (SELECT id FROM products WHERE normalized_name = ?),
             product_name = (SELECT name FROM products WHERE normalized_name = ?),
              modality_id = CASE WHEN ?=1 THEN ? ELSE modality_id END,
              modality_override = CASE WHEN ?=1 THEN 1 ELSE modality_override END,
             sale_date = ?, quantity = ?, unit_amount_cents = ?, total_cents = ?,
             customer_name = ?, notes = ?, version = version + 1, updated_by = ?, updated_at = ?
           WHERE id = ? AND status = 'active' AND version = ?
             AND EXISTS (SELECT 1 FROM idempotency_keys WHERE id = ?)`,
        )
        .bind(
          productNameNormalized,
          productNameNormalized,
          hasModalityOverride ? 1 : 0,
          input.modalityId ?? null,
          hasModalityOverride ? 1 : 0,
          saleDate,
          input.quantity,
          input.unitAmountCents,
          Number(total),
          customerName,
          notes,
          actor.userId,
          now,
          id,
          input.expectedVersion,
          operationId,
        ),
      env.DB
        .prepare(
          `INSERT INTO sales_history
            (id, entity_type, entity_id, operation, actor_id, before_data, after_data, created_at)
           SELECT ?, 'sale', id, 'update', ?, ?, json_object('id', id, 'productId', product_id,
             'saleDate', sale_date, 'productName', product_name, 'quantity', quantity,
             'unitAmountCents', unit_amount_cents, 'totalCents', total_cents,
              'modalityId', modality_id, 'modalityOverride', modality_override,
              'customerName', customer_name, 'notes', notes, 'status', status,
             'version', version, 'createdAt', created_at, 'updatedAt', updated_at), ?
           FROM sales WHERE id = ? AND version = ? AND updated_at = ?
             AND EXISTS (SELECT 1 FROM idempotency_keys WHERE id = ?)`,
        )
        .bind(crypto.randomUUID(), actor.userId, JSON.stringify(current), now, id, input.expectedVersion + 1, now, operationId),
    ],
  );
  const row = await getSale(env.DB, operation.resourceId);
  if (!row || Number(row.version) !== input.expectedVersion + 1) {
    throw new ApiFailure(409, "A venda foi alterada. Atualize antes de salvar.");
  }
  return json(saleOut(row), operation.replayed ? 200 : 200);
}

async function cancelSale(
  request: Request,
  env: WorkerEnv,
  actor: AuthContext,
  id: string,
): Promise<Response> {
  const input = bodyParse(CancelSaleBody, await readJson(request));
  const reason = input.reason.trim().replace(/\s+/g, " ");
  const operation = `sale-cancel:${id}`;
  const requestData = { reason, expectedVersion: input.expectedVersion };
  const previous = await findIdempotent(
    env.DB,
    actor,
    operation,
    input.idempotencyKey,
    requestData,
  );
  if (previous) {
    const replayed = await getSale(env.DB, previous.resourceId);
    if (!replayed) throw new ApiFailure(409, "A venda cancelada não foi encontrada.");
    if (replayed.status !== "cancelled") {
      const activeRefund = await env.DB
        .prepare("SELECT id FROM sales_refunds WHERE sale_id=? AND status='active' LIMIT 1")
        .bind(previous.resourceId)
        .first<{ id: string }>();
      if (activeRefund) {
        throw new ApiFailure(409, "Esta venda possui estorno ativo. Anule os estornos antes de cancelar.");
      }
      throw new ApiFailure(409, "A venda foi alterada. Atualize antes de cancelar.");
    }
    return json(saleOut(replayed));
  }
  const current = await getSale(env.DB, id);
  if (!current || current.status !== "active") throw new ApiFailure(404, "Venda não encontrada.");
  if (Number(current.version) !== input.expectedVersion) {
    throw new ApiFailure(409, "A venda foi alterada. Atualize antes de cancelar.");
  }
  const activeRefund = await env.DB
    .prepare("SELECT id FROM sales_refunds WHERE sale_id=? AND status='active' LIMIT 1")
    .bind(id)
    .first<{ id: string }>();
  if (activeRefund) {
    throw new ApiFailure(409, "Esta venda possui estorno ativo. Anule os estornos antes de cancelar.");
  }
  const now = nowIso();
  let operationIdForCleanup: string | undefined;
  const result = await runIdempotent(
    env.DB,
    actor,
    operation,
    input.idempotencyKey,
    requestData,
    id,
    (operationId) => {
      operationIdForCleanup = operationId;
      return [
      env.DB.prepare(
         `UPDATE sales SET status='cancelled', cancellation_reason=?, version=version+1,
            updated_by=?, updated_at=? WHERE id=? AND status='active' AND version=?
              AND EXISTS (SELECT 1 FROM idempotency_keys WHERE id=?)
              AND NOT EXISTS (
                SELECT 1 FROM sales_refunds WHERE sale_id=? AND status='active'
              )`,
      ).bind(reason, actor.userId, now, id, input.expectedVersion, operationId, id),
      env.DB.prepare(
        `INSERT INTO sales_history
          (id, entity_type, entity_id, operation, actor_id, before_data, after_data, created_at)
         SELECT ?, 'sale', id, 'cancel', ?, ?, json_object('id', id, 'status', status,
           'cancellationReason', cancellation_reason, 'version', version, 'updatedAt', updated_at), ?
         FROM sales WHERE id=? AND status='cancelled' AND version=? AND updated_at=?
           AND EXISTS (SELECT 1 FROM idempotency_keys WHERE id=?)`,
      ).bind(
        crypto.randomUUID(),
        actor.userId,
        JSON.stringify(current),
        now,
        id,
        input.expectedVersion + 1,
        now,
        operationId,
      ),
      ];
    },
  );
  const updated = await getSale(env.DB, result.resourceId);
  if (!updated || updated.status !== "cancelled") {
    const refundAfterRead = await env.DB
      .prepare("SELECT id FROM sales_refunds WHERE sale_id=? AND status='active' LIMIT 1")
      .bind(id)
      .first<{ id: string }>();
    if (operationIdForCleanup && !result.replayed) {
      await env.DB.prepare("DELETE FROM idempotency_keys WHERE id=?")
        .bind(operationIdForCleanup)
        .run();
    }
    if (refundAfterRead) {
      throw new ApiFailure(409, "Esta venda possui estorno ativo. Anule os estornos antes de cancelar.");
    }
    throw new ApiFailure(409, "A venda foi alterada. Atualize antes de cancelar.");
  }
  return json(saleOut(updated));
}

async function getScoreboard(request: Request, env: WorkerEnv): Promise<Response> {
  const url = new URL(request.url);
  const rawMonths = url.searchParams.getAll("months").flatMap((value) => value.split(","));
  const rawFromDate = url.searchParams.get("fromDate");
  const rawToDate = url.searchParams.get("toDate");
  const rawWeekdays = url.searchParams.getAll("weekdays").flatMap((value) => value.split(","));
  if (
    (rawFromDate !== null && !dateOnly(rawFromDate)) ||
    (rawToDate !== null && !dateOnly(rawToDate))
  ) {
    throw new ApiFailure(400, "Informe datas válidas no formato AAAA-MM-DD.");
  }
  const params = bodyParse(GetSalesScoreboardQueryParams, {
    fromDate: rawFromDate ? new Date(`${rawFromDate}T00:00:00.000Z`) : undefined,
    toDate: rawToDate ? new Date(`${rawToDate}T00:00:00.000Z`) : undefined,
    months: rawMonths.length ? rawMonths : undefined,
    weekdays: rawWeekdays.length ? rawWeekdays : undefined,
    productId: url.searchParams.get("productId") ?? undefined,
    modalityId: url.searchParams.get("modalityId") ?? undefined,
  });
  const fromDate = params.fromDate?.toISOString().slice(0, 10);
  const toDate = params.toDate?.toISOString().slice(0, 10);
  const months = [...new Set(params.months ?? [])].sort();
  const weekdays = [...new Set(params.weekdays ?? [])];
  if (
    Boolean(fromDate) !== Boolean(toDate) ||
    (fromDate && toDate && fromDate > toDate) ||
    (months.length > 0 && (fromDate || toDate))
  ) {
    throw new ApiFailure(400, "Escolha datas completas ou meses, sem combinar os filtros.");
  }
  if (months.some((month) => !dateOnly(`${month}-01`))) {
    throw new ApiFailure(400, "Selecione meses válidos.");
  }
  const sales = await asRows(
    env.DB.prepare(
      `SELECT s.*, p.name AS current_product_name,
         CASE WHEN s.modality_override=1 THEN s.modality_id ELSE p.modality_id END AS effective_modality_id,
         m.name AS modality_name
       FROM sales s LEFT JOIN products p ON p.id=s.product_id
       LEFT JOIN occupancy_modalities m
         ON m.id=CASE WHEN s.modality_override=1 THEN s.modality_id ELSE p.modality_id END
       WHERE s.status='active'`,
    ),
  );
  const refunds = await asRows(
    env.DB.prepare(
      `SELECT r.*, s.product_id, s.product_name, p.name AS current_product_name,
         CASE WHEN s.modality_override=1 THEN s.modality_id ELSE p.modality_id END AS effective_modality_id,
         m.name AS modality_name, s.sale_date, s.quantity,
         s.unit_amount_cents, s.total_cents, s.status AS sale_status
       FROM sales_refunds r JOIN sales s ON s.id=r.sale_id
       LEFT JOIN products p ON p.id=s.product_id
       LEFT JOIN occupancy_modalities m
         ON m.id=CASE WHEN s.modality_override=1 THEN s.modality_id ELSE p.modality_id END
        WHERE r.status='active' AND s.status='active'`,
    ),
  );
  const dateMatches = (value: string) => {
    if (fromDate && toDate && (value < fromDate || value > toDate)) return false;
    if (months.length && !months.includes(value.slice(0, 7))) return false;
    return !weekdays.length || weekdays.includes(getIsoWeekday(value) ?? 0);
  };
  const productMatches = (row: Row) =>
    (!params.productId || row.product_id === params.productId) &&
    (!params.modalityId || row.effective_modality_id === params.modalityId);

  type Aggregate = {
    productId: string | null;
    productName: string;
    modalityId: string | null;
    modalityName: string | null;
    saleCount: bigint;
    quantity: bigint;
    salesCents: bigint;
    refundCents: bigint;
  };
  const products = new Map<string, Aggregate>();
  const monthly = new Map<
    string,
    { month: string; saleCount: bigint; quantity: bigint; salesCents: bigint; refundCents: bigint }
  >();
  type CalendarAggregate = { saleCount: bigint; quantity: bigint; salesCents: bigint; refundCents: bigint };
  const daily = new Map<string, CalendarAggregate & { weekday: number }>();
  const weekly = new Map<string, CalendarAggregate>();
  const getProduct = (row: Row) => {
    const id = row.product_id === null ? null : String(row.product_id);
    const modalityValue = Object.hasOwn(row, "effective_modality_id")
      ? row.effective_modality_id
      : row.modality_id;
    const modalityId = modalityValue === null || modalityValue === undefined ? null : String(modalityValue);
    const key = `${id ?? `name:${String(row.product_name ?? "Não categorizado")}`}|${modalityId ?? "unlinked"}`;
    let aggregate = products.get(key);
    if (!aggregate) {
      aggregate = {
        productId: id,
        productName: String(row.current_product_name ?? row.product_name ?? "Não categorizado"),
        modalityId,
        modalityName: row.modality_name === null ? null : String(row.modality_name),
        saleCount: 0n,
        quantity: 0n,
        salesCents: 0n,
        refundCents: 0n,
      };
      products.set(key, aggregate);
    }
    return aggregate;
  };
  const getMonth = (month: string) => {
    let value = monthly.get(month);
    if (!value) {
      value = { month, saleCount: 0n, quantity: 0n, salesCents: 0n, refundCents: 0n };
      monthly.set(month, value);
    }
    return value;
  };
  const getDay = (date: string) => {
    let value = daily.get(date);
    if (!value) {
      value = { weekday: getIsoWeekday(date) ?? 0, saleCount: 0n, quantity: 0n, salesCents: 0n, refundCents: 0n };
      daily.set(date, value);
    }
    return value;
  };
  const getWeek = (date: string) => {
    const weekStart = getIsoWeekStart(date);
    if (!weekStart) throw new ApiFailure(500, "Não foi possível agrupar a data da movimentação.");
    let value = weekly.get(weekStart);
    if (!value) {
      value = { saleCount: 0n, quantity: 0n, salesCents: 0n, refundCents: 0n };
      weekly.set(weekStart, value);
    }
    return value;
  };
  for (const sale of sales) {
    if (!dateMatches(String(sale.sale_date)) || !productMatches(sale)) continue;
    const quantity = BigInt(String(sale.quantity));
    const cents = BigInt(String(sale.total_cents));
    const month = String(sale.sale_date).slice(0, 7);
    const product = getProduct(sale);
    product.saleCount += 1n;
    product.quantity += quantity;
    product.salesCents += cents;
    const monthTotal = getMonth(month);
    monthTotal.saleCount += 1n;
    monthTotal.quantity += quantity;
    monthTotal.salesCents += cents;
    const dayTotal = getDay(String(sale.sale_date));
    dayTotal.saleCount += 1n;
    dayTotal.quantity += quantity;
    dayTotal.salesCents += cents;
    const weekTotal = getWeek(String(sale.sale_date));
    weekTotal.saleCount += 1n;
    weekTotal.quantity += quantity;
    weekTotal.salesCents += cents;
  }
  for (const refund of refunds) {
    if (!dateMatches(String(refund.refund_date)) || !productMatches(refund)) continue;
    const cents = BigInt(String(refund.amount_cents));
    const month = String(refund.refund_date).slice(0, 7);
    getProduct(refund).refundCents += cents;
    getMonth(month).refundCents += cents;
    getDay(String(refund.refund_date)).refundCents += cents;
    getWeek(String(refund.refund_date)).refundCents += cents;
  }
  if (params.productId && ![...products.values()].some((item) => item.productId === params.productId)) {
    const product = await env.DB
      .prepare(
        `SELECT p.id, p.name, p.modality_id, m.name AS modality_name
         FROM products p LEFT JOIN occupancy_modalities m ON m.id=p.modality_id
         WHERE p.id=?`,
      )
      .bind(params.productId)
      .first<Row>();
    if (product && (!params.modalityId || product.modality_id === params.modalityId)) {
      getProduct({
        product_id: product.id,
        product_name: product.name,
        current_product_name: product.name,
        modality_id: product.modality_id,
        modality_name: product.modality_name,
      });
    }
  }
  const safeNumber = (value: bigint, label: string) => {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new ApiFailure(500, `O total de ${label} ultrapassa a precisão suportada.`);
    }
    return Number(value);
  };
  const productResults = [...products.values()]
    .map((item) => ({
      productId: item.productId,
      productName: item.productName,
      modalityId: item.modalityId,
      modalityName: item.modalityName,
      saleCount: safeNumber(item.saleCount, "vendas"),
      quantity: safeNumber(item.quantity, "quantidade"),
      salesCents: safeNumber(item.salesCents, "vendas"),
      refundCents: safeNumber(item.refundCents, "estornos"),
      netCents: safeNumber(item.salesCents - item.refundCents, "faturamento líquido"),
    }))
    .sort((a, b) => a.productName.localeCompare(b.productName, "pt-BR"));
  const monthKeyBetween = (start: string, end: string) => {
    const result: string[] = [];
    const [startYear, startMonth] = start.split("-").map(Number);
    const [endYear, endMonth] = end.split("-").map(Number);
    let year = startYear;
    let month = startMonth;
    while (year < endYear || (year === endYear && month <= endMonth)) {
      result.push(`${year}-${String(month).padStart(2, "0")}`);
      month += 1;
      if (month === 13) {
        month = 1;
        year += 1;
      }
    }
    return result;
  };
  const currentMonthParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date());
  const currentMonth =
    `${currentMonthParts.find((part) => part.type === "year")?.value ?? "1970"}-` +
    `${currentMonthParts.find((part) => part.type === "month")?.value ?? "01"}`;
  const observedMonths = [...monthly.keys()].sort();
  let outputMonths: string[];
  if (months.length) {
    outputMonths = months;
  } else if (fromDate && toDate) {
    outputMonths = monthKeyBetween(fromDate.slice(0, 7), toDate.slice(0, 7));
  } else {
    const first = observedMonths[0] && observedMonths[0] < currentMonth
      ? observedMonths[0]
      : currentMonth;
    const lastObserved = observedMonths.at(-1);
    const last = lastObserved && lastObserved > currentMonth ? lastObserved : currentMonth;
    outputMonths = monthKeyBetween(first, last);
  }
  const monthResults = outputMonths
    .map((month) => {
      const item = monthly.get(month) ?? {
        month,
        saleCount: 0n,
        quantity: 0n,
        salesCents: 0n,
        refundCents: 0n,
      };
      return {
        month,
        saleCount: safeNumber(item.saleCount, "vendas mensais"),
        quantity: safeNumber(item.quantity, "quantidade mensal"),
        salesCents: safeNumber(item.salesCents, "vendas mensais"),
        refundCents: safeNumber(item.refundCents, "estornos mensais"),
        netCents: safeNumber(item.salesCents - item.refundCents, "faturamento líquido mensal"),
      };
    })
    .sort((a, b) => a.month.localeCompare(b.month));
  const dayResults = [...daily.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, item]) => ({
      date,
      weekday: item.weekday,
      saleCount: safeNumber(item.saleCount, "vendas diárias"),
      quantity: safeNumber(item.quantity, "quantidade diária"),
      salesCents: safeNumber(item.salesCents, "vendas diárias"),
      refundCents: safeNumber(item.refundCents, "estornos diários"),
      netCents: safeNumber(item.salesCents - item.refundCents, "faturamento líquido diário"),
    }));
  const weekResults = [...weekly.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([weekStart, item]) => ({
      weekStart,
      saleCount: safeNumber(item.saleCount, "vendas semanais"),
      quantity: safeNumber(item.quantity, "quantidade semanal"),
      salesCents: safeNumber(item.salesCents, "vendas semanais"),
      refundCents: safeNumber(item.refundCents, "estornos semanais"),
      netCents: safeNumber(item.salesCents - item.refundCents, "faturamento líquido semanal"),
    }));
  const totalQuantity = [...products.values()].reduce((sum, item) => sum + item.quantity, 0n);
  const totalSaleCount = [...products.values()].reduce((sum, item) => sum + item.saleCount, 0n);
  const totalSales = [...products.values()].reduce((sum, item) => sum + item.salesCents, 0n);
  const totalRefunds = [...products.values()].reduce((sum, item) => sum + item.refundCents, 0n);
  return json(
    GetSalesScoreboardResponse.parse({
      totals: {
        saleCount: safeNumber(totalSaleCount, "vendas totais"),
        quantity: safeNumber(totalQuantity, "quantidade total"),
        salesCents: safeNumber(totalSales, "vendas totais"),
        refundCents: safeNumber(totalRefunds, "estornos totais"),
        netCents: safeNumber(totalSales - totalRefunds, "faturamento líquido total"),
      },
      products: productResults,
      months: monthResults,
      days: dayResults,
      weeks: weekResults,
    }),
  );
}

async function getGoals(env: WorkerEnv): Promise<Response> {
  const rows = await asRows(
    env.DB.prepare(
      `SELECT g.*, p.name AS current_product_name
       FROM sales_goals g LEFT JOIN products p ON p.id=g.product_id
       ORDER BY g.month DESC, g.scope_key`,
    ),
  );
  return json(
    GetSalesGoalsResponse.parse(
      rows.map((row) => ({
        id: row.id,
        month: row.month,
        productId: row.product_id,
        productName: row.product_id === null
          ? null
          : row.current_product_name ?? row.product_name,
        targetCents: Number(row.target_cents),
        version: Number(row.version),
        updatedAt: row.updated_at,
      })),
    ),
  );
}

function activeContractsOut(row: Row) {
  return {
    month: String(row.month),
    activeCount: Number(row.active_count),
    targetCount: row.target_count == null ? null : Number(row.target_count),
    notes: row.notes == null ? null : String(row.notes),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

async function getActiveContracts(env: WorkerEnv): Promise<Response> {
  const rows = await asRows(
    env.DB.prepare("SELECT * FROM active_contracts_monthly ORDER BY month"),
  );
  return json(GetActiveContractsResponse.parse(rows.map(activeContractsOut)));
}

async function upsertActiveContractsMonth(
  request: Request,
  env: WorkerEnv,
  rawMonth: string,
): Promise<Response> {
  const { month } = bodyParse(UpsertActiveContractsMonthParams, { month: rawMonth });
  const input = bodyParse(UpsertActiveContractsMonthBody, await readJson(request));
  const now = nowIso();
  await env.DB.prepare(
    `INSERT INTO active_contracts_monthly
       (month, active_count, target_count, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(month) DO UPDATE SET
       active_count=excluded.active_count,
       target_count=excluded.target_count,
       notes=excluded.notes,
       updated_at=excluded.updated_at`,
  ).bind(month, input.activeCount, input.targetCount, input.notes, now, now).run();

  const row = await env.DB.prepare(
    "SELECT * FROM active_contracts_monthly WHERE month=?",
  ).bind(month).first<Row>();
  if (!row) throw new Error("O saldo mensal de contratos ativos não foi salvo.");
  return json(UpsertActiveContractsMonthResponse.parse(activeContractsOut(row)));
}

async function salesImportOrigins(env: WorkerEnv, fileHash: string) {
  return asRows(
    env.DB
      .prepare(
        `SELECT source_sheet, source_row, state, sale_id, draft_id
         FROM (
           SELECT source_sheet, source_row,
             CASE WHEN status='completed' THEN 'sale' ELSE 'pending' END AS state,
             linked_sale_id AS sale_id,
             CASE WHEN status='pending' THEN id ELSE NULL END AS draft_id
           FROM sales_pending_drafts
           WHERE source_file_hash=?
           UNION ALL
           SELECT
             json_extract(h.after_data, '$.sourceSheet') AS source_sheet,
             CAST(json_extract(h.after_data, '$.sourceRow') AS INTEGER) AS source_row,
             'sale' AS state,
             h.entity_id AS sale_id,
             NULL AS draft_id
           FROM sales_history h
           WHERE h.entity_type='sale' AND h.operation='import'
             AND json_valid(h.after_data)
             AND json_extract(h.after_data, '$.sourceFileHash')=?
             AND NOT EXISTS (
               SELECT 1 FROM sales_pending_drafts d
               WHERE d.source_file_hash=?
                 AND d.source_sheet=json_extract(h.after_data, '$.sourceSheet')
                 AND d.source_row=CAST(json_extract(h.after_data, '$.sourceRow') AS INTEGER)
             )
         )
         ORDER BY source_sheet, source_row`,
      )
      .bind(fileHash, fileHash, fileHash),
  );
}

function pendingDraftOut(row: Row) {
  const missingFields: Array<"saleDate" | "totalCents"> = [];
  if (row.sale_date === null) missingFields.push("saleDate");
  if (row.total_cents === null) missingFields.push("totalCents");
  return {
    id: String(row.id),
    status: String(row.status),
    customerName: row.customer_name === null ? null : String(row.customer_name),
    saleDate: row.sale_date === null ? null : String(row.sale_date),
    saleDateText: row.sale_date_text === null ? null : String(row.sale_date_text),
    productName: row.product_name === null ? null : String(row.product_name),
    totalCents: row.total_cents === null ? null : Number(row.total_cents),
    amountText: row.amount_text === null ? null : String(row.amount_text),
    notes: row.notes === null ? null : String(row.notes),
    sourceFileName: row.source_file_name === null ? null : String(row.source_file_name),
    sourceSheet: row.source_sheet === null ? null : String(row.source_sheet),
    sourceRow: row.source_row === null ? null : Number(row.source_row),
    missingFields,
    linkedSaleId: row.linked_sale_id === null ? null : String(row.linked_sale_id),
    version: Number(row.version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

async function importSales(
  request: Request,
  env: WorkerEnv,
  actor: AuthContext,
): Promise<Response> {
  const raw = await readJson(request);
  const rawRows = raw && typeof raw === "object" && "rows" in raw
    ? (raw as { rows?: unknown }).rows
    : undefined;
  if (Array.isArray(rawRows)) {
    const invalidDateRow = rawRows.find((candidate) =>
      !candidate
      || typeof candidate !== "object"
      || !dateOnly((candidate as Row).saleDate),
    );
    if (invalidDateRow) {
      const row = typeof invalidDateRow === "object" && invalidDateRow !== null
        ? invalidDateRow as Row
        : {};
      throw new ApiFailure(
        400,
        `Data da venda inválida na aba ${String(row.sourceSheet ?? "Planilha")}, linha ${String(row.sourceRow ?? "?")}.`,
      );
    }
  }
  const input = bodyParse(ImportSalesBody, raw);
  const normalizedRows = input.rows.map((row) => {
    const rawRow = row as typeof row & { saleDate: Date | string };
    const saleDate =
      rawRow.saleDate instanceof Date
        ? rawRow.saleDate.toISOString().slice(0, 10)
        : dateOnly(rawRow.saleDate);
    const productName = row.productName ? normalizeName(row.productName) : null;
    const customerName = row.customerName?.trim().replace(/\s+/g, " ") || null;
    const notes = row.notes?.trim() || null;
    if (
      !saleDate ||
      (productName !== null && productName.length > 120) ||
      (customerName !== null && customerName.length > 120) ||
      (notes !== null && notes.length > 1000) ||
      !row.sourceSheet.trim() ||
      row.sourceSheet.length > 255
    ) {
      throw new ApiFailure(400, `Dados inválidos na aba ${row.sourceSheet || "Planilha"}, linha ${row.sourceRow}.`);
    }
    return {
      id: crypto.randomUUID(),
      saleDate,
      productName,
      productKey: productName ? nameKey(productName) : null,
      modalityId: row.modalityId,
      quantity: 1,
      unitAmountCents: row.totalCents,
      totalCents: row.totalCents,
      customerName,
      notes,
      sourceSheet: row.sourceSheet,
      sourceRow: row.sourceRow,
    };
  });
  const normalizedDraftRows = (input.pendingRows ?? []).map((row) => {
    const saleDate = row.saleDate instanceof Date
      ? row.saleDate.toISOString().slice(0, 10)
      : row.saleDate
        ? dateOnly(row.saleDate)
        : null;
    const customerName = row.customerName?.trim().replace(/\s+/g, " ") || null;
    const productName = row.productName ? normalizeName(row.productName) : null;
    const notes = row.notes?.trim() || null;
    if (
      (row.saleDate !== null && !saleDate) ||
      (customerName !== null && customerName.length > 1000) ||
      (productName !== null && productName.length > 500) ||
      (notes !== null && notes.length > 1000) ||
      (row.saleDateText !== null && row.saleDateText.length > 200) ||
      (row.amountText !== null && row.amountText.length > 120) ||
      !row.sourceSheet.trim() ||
      row.sourceSheet.length > 255 ||
      (saleDate !== null && row.totalCents !== null)
    ) {
      throw new ApiFailure(400, `Pendência inválida na aba ${row.sourceSheet || "Planilha"}, linha ${row.sourceRow}.`);
    }
    if (
      !saleDate && row.totalCents === null && !customerName && !productName
      && !notes && !row.saleDateText && !row.amountText
    ) {
      throw new ApiFailure(400, `A linha ${row.sourceRow} não contém informações para salvar como pendência.`);
    }
    return {
      id: crypto.randomUUID(),
      saleDate,
      saleDateText: row.saleDateText?.trim() || null,
      totalCents: row.totalCents,
      amountText: row.amountText?.trim() || null,
      customerName,
      productName,
      notes,
      sourceSheet: row.sourceSheet,
      sourceRow: row.sourceRow,
    };
  });
  if (!normalizedRows.length && !normalizedDraftRows.length) {
    throw new ApiFailure(400, "Selecione ao menos uma venda pronta ou pendência para salvar.");
  }
  const availableModalityIds = new Set(
    (await asRows(env.DB.prepare("SELECT id FROM occupancy_modalities"))).map((row) => String(row.id)),
  );
  const invalidModalityRow = normalizedRows.find(
    (row) => row.modalityId && !availableModalityIds.has(row.modalityId),
  );
  if (invalidModalityRow) {
    throw new ApiFailure(
      400,
      `A modalidade selecionada não existe na aba ${invalidModalityRow.sourceSheet}, linha ${invalidModalityRow.sourceRow}.`,
    );
  }
  if (normalizedRows.length + normalizedDraftRows.length > 500) {
    throw new ApiFailure(400, "O limite é de 500 linhas por importação.");
  }
  const sourceKeys = [
    ...normalizedRows.map((row) => `${row.sourceSheet}:${row.sourceRow}`),
    ...normalizedDraftRows.map((row) => `${row.sourceSheet}:${row.sourceRow}`),
  ];
  if (new Set(sourceKeys).size !== sourceKeys.length) {
    throw new ApiFailure(400, "O envio contém a mesma aba/linha mais de uma vez.");
  }

  const now = nowIso();
  const existingBatch = await env.DB
    .prepare("SELECT id FROM sales_import_batches WHERE source='sales-file' AND file_hash=? LIMIT 1")
    .bind(input.fileHash)
    .first<{ id: string }>();
  const batchId = existingBatch?.id ?? crypto.randomUUID();
  if (!existingBatch) {
    await env.DB
      .prepare(
        `INSERT INTO sales_import_batches
          (id, actor_id, source, file_hash, status, row_count, created_at, completed_at)
         VALUES (?, ?, 'sales-file', ?, 'previewed', 0, ?, NULL)
         ON CONFLICT(actor_id, source, file_hash) DO NOTHING`,
      )
      .bind(batchId, actor.userId, input.fileHash, now)
      .run();
  }

  let origins = await salesImportOrigins(env, input.fileHash);
  let originMap = new Map(
    origins.map((origin) => [
      `${String(origin.source_sheet)}:${String(origin.source_row)}`,
      {
        state: String(origin.state),
        saleId: origin.sale_id === null ? null : String(origin.sale_id),
        draftId: origin.draft_id === null ? null : String(origin.draft_id),
      },
    ]),
  );
  const newRows = normalizedRows.filter(
    (row) => !originMap.has(`${row.sourceSheet}:${row.sourceRow}`),
  );
  const newDraftRows = normalizedDraftRows.filter(
    (row) => !originMap.has(`${row.sourceSheet}:${row.sourceRow}`),
  );

  for (let offset = 0; offset < newRows.length; offset += 250) {
    const chunk = newRows.slice(offset, offset + 250);
    const statements = chunk.flatMap((row) => {
      const productId = row.productName ? crypto.randomUUID() : null;
      const createdAt = nowIso();
      const productName = row.productName ?? "Não categorizado";
      const productKey = row.productKey;
      const saleInsert = env.DB
        .prepare(
          `INSERT INTO sales
            (id, product_id, sale_date, product_name, quantity, unit_amount_cents, total_cents,
             modality_id, modality_override,
             customer_name, notes, status, cancellation_reason, version, created_by, updated_by, created_at, updated_at)
           VALUES (?, ${
             productKey ? "(SELECT id FROM products WHERE normalized_name=?)" : "NULL"
            }, ?, ${
             productKey ? "(SELECT name FROM products WHERE normalized_name=?)" : "?"
            }, 1, ?, ?, ?, ?, ?, ?, 'active', NULL, 1, ?, ?, ?, ?)`,
        )
        .bind(
          ...(productKey
            ? [
                row.id,
                productKey,
                row.saleDate,
                productKey,
                row.unitAmountCents,
                row.totalCents,
                row.modalityId ?? null,
                row.modalityId === undefined ? 0 : 1,
                row.customerName,
                row.notes,
                actor.userId,
                actor.userId,
                createdAt,
                createdAt,
              ]
            : [
                row.id,
                row.saleDate,
                productName,
                row.unitAmountCents,
                row.totalCents,
                row.modalityId ?? null,
                row.modalityId === undefined ? 0 : 1,
                row.customerName,
                row.notes,
                actor.userId,
                actor.userId,
                createdAt,
                createdAt,
              ]),
        );
      const insertProduct = productKey
        ? [
            env.DB
              .prepare(
                `INSERT INTO products
                  (id, name, normalized_name, suggested_price_cents, is_active, version, created_at, updated_at)
                 VALUES (?, ?, ?, 0, 1, 1, ?, ?)
                 ON CONFLICT(normalized_name) DO NOTHING`,
              )
              .bind(
                productId,
                productName,
                productKey,
                createdAt,
                createdAt,
              ),
          ]
        : [];
      const history = env.DB
        .prepare(
          `INSERT INTO sales_history
            (id, entity_type, entity_id, operation, actor_id, before_data, after_data, created_at)
           SELECT ?, 'sale', s.id, 'import', ?, NULL,
             json_object('id', s.id, 'productId', s.product_id, 'saleDate', s.sale_date,
               'productName', s.product_name, 'quantity', s.quantity,
               'unitAmountCents', s.unit_amount_cents, 'totalCents', s.total_cents,
                'modalityId', s.modality_id, 'modalityOverride', s.modality_override,
               'customerName', s.customer_name, 'notes', s.notes, 'status', s.status,
               'version', s.version, 'createdAt', s.created_at, 'updatedAt', s.updated_at,
               'importBatchId', ?, 'sourceFileHash', ?, 'sourceFileName', ?,
               'sourceSheet', ?, 'sourceRow', ?), ?
           FROM sales s WHERE s.id=?`,
        )
        .bind(
          crypto.randomUUID(),
          actor.userId,
          batchId,
          input.fileHash,
          input.filename,
          row.sourceSheet,
          row.sourceRow,
          createdAt,
          row.id,
        );
      return [...insertProduct, saleInsert, history];
    });
    try {
      await env.DB.batch(statements);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (!/unique constraint failed/i.test(errorMessage)) {
        throw error;
      }
      const refreshed = await salesImportOrigins(env, input.fileHash);
      const known = new Set(
        refreshed.map((origin) => `${origin.source_sheet}:${origin.source_row}`),
      );
      if (chunk.some((row) => !known.has(`${row.sourceSheet}:${row.sourceRow}`))) {
        throw new ApiFailure(
          409,
          "A planilha teve conflito ao gravar. Atualize a prévia e tente novamente.",
        );
      }
    }
    origins = await salesImportOrigins(env, input.fileHash);
    originMap = new Map(
      origins.map((origin) => [
        `${String(origin.source_sheet)}:${String(origin.source_row)}`,
        {
          state: String(origin.state),
          saleId: origin.sale_id === null ? null : String(origin.sale_id),
          draftId: origin.draft_id === null ? null : String(origin.draft_id),
        },
      ]),
    );
  }

  for (let offset = 0; offset < newDraftRows.length; offset += 250) {
    const chunk = newDraftRows.slice(offset, offset + 250);
    const statements = chunk.map((row) => env.DB.prepare(
      `INSERT OR IGNORE INTO sales_pending_drafts
        (id, status, customer_name, sale_date, sale_date_text, product_name,
         total_cents, amount_text, notes, source_file_hash, source_file_name,
         source_sheet, source_row, linked_sale_id, version, created_by, updated_by,
         created_at, updated_at)
       VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, ?, ?, ?)
       `,
    ).bind(
      row.id,
      row.customerName,
      row.saleDate,
      row.saleDateText,
      row.productName,
      row.totalCents,
      row.amountText,
      row.notes,
      input.fileHash,
      input.filename,
      row.sourceSheet,
      row.sourceRow,
      actor.userId,
      actor.userId,
      now,
      now,
    ));
    await env.DB.batch(statements);
    origins = await salesImportOrigins(env, input.fileHash);
    originMap = new Map(
      origins.map((origin) => [
        `${String(origin.source_sheet)}:${String(origin.source_row)}`,
        {
          state: String(origin.state),
          saleId: origin.sale_id === null ? null : String(origin.sale_id),
          draftId: origin.draft_id === null ? null : String(origin.draft_id),
        },
      ]),
    );
  }

  const selectedIds = normalizedRows.flatMap((row) => {
    const origin = originMap.get(`${row.sourceSheet}:${row.sourceRow}`);
    return origin?.saleId ? [origin.saleId] : [];
  });
  const sales = selectedIds.length
    ? await asRows(
        env.DB
          .prepare(
            `SELECT * FROM sales WHERE id IN (${selectedIds.map(() => "?").join(",")})`,
          )
          .bind(...selectedIds),
      )
    : [];
  const byId = new Map(sales.map((sale) => [String(sale.id), sale]));
  const orderedSales = selectedIds.flatMap((id) => {
    const row = byId.get(id);
    return row ? [saleOut(row)] : [];
  });
  const importedCount = newRows.filter((row) =>
    originMap.get(`${row.sourceSheet}:${row.sourceRow}`)?.saleId === row.id,
  ).length;
  const pendingCount = newDraftRows.filter((row) =>
    originMap.get(`${row.sourceSheet}:${row.sourceRow}`)?.draftId === row.id,
  ).length;
  const completedAt = nowIso();
  await env.DB
    .prepare(
      `UPDATE sales_import_batches SET row_count=?, status='completed', completed_at=? WHERE id=?`,
    )
    .bind(originMap.size, completedAt, batchId)
    .run();
  return json(
    ImportSalesResponse.parse({
      batchId,
      fileName: input.filename,
      importedCount,
      skippedCount: normalizedRows.length - importedCount,
      pendingCount,
      skippedPendingCount: normalizedDraftRows.length - pendingCount,
      replayed: importedCount === 0 && pendingCount === 0,
      sales: orderedSales,
    }),
    importedCount === 0 && pendingCount === 0 ? 200 : 201,
  );
}

async function listSalesPendingDrafts(env: WorkerEnv): Promise<Response> {
  const rows = await asRows(
    env.DB.prepare(
      "SELECT * FROM sales_pending_drafts WHERE status='pending' ORDER BY created_at DESC, id",
    ),
  );
  return json(GetSalesPendingDraftsResponse.parse(rows.map(pendingDraftOut)));
}

async function updateSalesPendingDraft(
  request: Request,
  env: WorkerEnv,
  actor: AuthContext,
  id: string,
): Promise<Response> {
  const params = bodyParse(UpdateSalesPendingDraftParams, { id });
  const input = bodyParse(UpdateSalesPendingDraftBody, await readJson(request));
  const saleDate = input.saleDate instanceof Date
    ? input.saleDate.toISOString().slice(0, 10)
    : input.saleDate === null
      ? null
      : dateOnly(input.saleDate);
  const customerName = input.customerName?.trim().replace(/\s+/g, " ") || null;
  const productName = input.productName ? normalizeName(input.productName) : null;
  const notes = input.notes?.trim() || null;
  if (
    (input.saleDate !== null && !saleDate) ||
    (customerName !== null && customerName.length > 120) ||
    (productName !== null && productName.length > 120) ||
    (notes !== null && notes.length > 1000)
  ) {
    throw new ApiFailure(400, "Confira os dados informados para a pendência.");
  }

  const current = await env.DB
    .prepare("SELECT * FROM sales_pending_drafts WHERE id=?")
    .bind(params.id)
    .first<Row>();
  if (!current) throw new ApiFailure(404, "Pendência não encontrada.");
  if (String(current.status) === "completed" && current.linked_sale_id) {
    const completedSale = await env.DB
      .prepare("SELECT * FROM sales WHERE id=?")
      .bind(String(current.linked_sale_id))
      .first<Row>();
    return json(UpdateSalesPendingDraftResponse.parse({
      status: "completed",
      draft: pendingDraftOut(current),
      sale: completedSale ? saleOut(completedSale) : null,
    }));
  }
  if (Number(current.version) !== input.expectedVersion) {
    throw new ApiFailure(409, "A pendência foi alterada. Atualize a lista antes de salvar.");
  }

  const amountText = input.totalCents === null
    ? input.amountText?.trim() || null
    : null;
  const dateText = saleDate === null
    ? input.saleDateText?.trim() || null
    : null;
  const updatedAt = nowIso();

  if (!saleDate || input.totalCents === null) {
    await env.DB.prepare(
      `UPDATE sales_pending_drafts
       SET customer_name=?, sale_date=?, sale_date_text=?, product_name=?,
           total_cents=?, amount_text=?, notes=?, version=version+1,
           updated_by=?, updated_at=?
       WHERE id=? AND status='pending' AND version=?`,
    ).bind(
      customerName,
      saleDate,
      dateText,
      productName,
      input.totalCents,
      amountText,
      notes,
      actor.userId,
      updatedAt,
      params.id,
      input.expectedVersion,
    ).run();
    const updated = await env.DB
      .prepare("SELECT * FROM sales_pending_drafts WHERE id=?")
      .bind(params.id)
      .first<Row>();
    if (!updated) throw new ApiFailure(404, "Pendência não encontrada.");
    if (Number(updated.version) !== input.expectedVersion + 1 || String(updated.status) !== "pending") {
      throw new ApiFailure(409, "A pendência foi alterada. Atualize a lista antes de salvar.");
    }
    return json(UpdateSalesPendingDraftResponse.parse({
      status: "pending",
      draft: pendingDraftOut(updated),
      sale: null,
    }));
  }

  const saleId = crypto.randomUUID();
  const productKey = productName ? nameKey(productName) : null;
  const displayName = productName ?? "Não categorizado";
  const productId = productKey ? crypto.randomUUID() : null;
  const batch = [];
  if (productKey) {
    batch.push(env.DB.prepare(
      `INSERT INTO products
        (id, name, normalized_name, suggested_price_cents, is_active, version, created_at, updated_at)
       SELECT ?, ?, ?, 0, 1, 1, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM sales_pending_drafts WHERE id=? AND status='pending' AND version=?
       )
       ON CONFLICT(normalized_name) DO NOTHING`,
    ).bind(productId, productName, productKey, updatedAt, updatedAt, params.id, input.expectedVersion));
  }
  batch.push(env.DB.prepare(
    `INSERT INTO sales
      (id, product_id, sale_date, product_name, quantity, unit_amount_cents, total_cents,
       customer_name, notes, status, cancellation_reason, version, created_by, updated_by, created_at, updated_at)
     SELECT ?, ${
       productKey ? "(SELECT id FROM products WHERE normalized_name=?)" : "NULL"
     }, ?, ${
       productKey ? "(SELECT name FROM products WHERE normalized_name=?)" : "?"
     }, 1, ?, ?, ?, ?, 'active', NULL, 1, ?, ?, ?, ?
     WHERE EXISTS (
       SELECT 1 FROM sales_pending_drafts WHERE id=? AND status='pending' AND version=?
     )`,
  ).bind(
    ...(productKey
      ? [
          saleId, productKey, saleDate, productKey, input.totalCents, input.totalCents,
          customerName, notes, actor.userId, actor.userId, updatedAt, updatedAt,
          params.id, input.expectedVersion,
        ]
      : [
          saleId, saleDate, displayName, input.totalCents, input.totalCents,
          customerName, notes, actor.userId, actor.userId, updatedAt, updatedAt,
          params.id, input.expectedVersion,
        ]),
  ));
  batch.push(env.DB.prepare(
    `INSERT INTO sales_history
      (id, entity_type, entity_id, operation, actor_id, before_data, after_data, created_at)
     SELECT ?, 'sale', s.id,
       CASE WHEN d.source_file_hash IS NULL THEN 'create' ELSE 'import' END,
       ?, NULL,
       json_object('id', s.id, 'productId', s.product_id, 'saleDate', s.sale_date,
         'productName', s.product_name, 'quantity', s.quantity,
         'unitAmountCents', s.unit_amount_cents, 'totalCents', s.total_cents,
        'modalityId', s.modality_id, 'modalityOverride', s.modality_override,
         'customerName', s.customer_name, 'notes', s.notes, 'status', s.status,
         'version', s.version, 'createdAt', s.created_at, 'updatedAt', s.updated_at,
         'importBatchId', (SELECT id FROM sales_import_batches WHERE file_hash=d.source_file_hash AND source='sales-file' LIMIT 1),
         'sourceFileHash', d.source_file_hash, 'sourceFileName', d.source_file_name,
         'sourceSheet', d.source_sheet, 'sourceRow', d.source_row), ?
     FROM sales s JOIN sales_pending_drafts d ON d.id=?
     WHERE s.id=? AND d.status='pending' AND d.version=?`,
  ).bind(crypto.randomUUID(), actor.userId, updatedAt, params.id, saleId, input.expectedVersion));
  batch.push(env.DB.prepare(
    `UPDATE sales_pending_drafts
     SET status='completed', customer_name=?, sale_date=?, sale_date_text=NULL,
         product_name=?, total_cents=?, amount_text=NULL, notes=?,
         linked_sale_id=?, version=version+1, updated_by=?, updated_at=?
     WHERE id=? AND status='pending' AND version=? AND EXISTS (SELECT 1 FROM sales WHERE id=?)`,
  ).bind(
    customerName,
    saleDate,
    productName,
    input.totalCents,
    notes,
    saleId,
    actor.userId,
    updatedAt,
    params.id,
    input.expectedVersion,
    saleId,
  ));
  await env.DB.batch(batch);

  const updated = await env.DB
    .prepare("SELECT * FROM sales_pending_drafts WHERE id=?")
    .bind(params.id)
    .first<Row>();
  if (!updated) throw new ApiFailure(404, "Pendência não encontrada.");
  if (String(updated.status) !== "completed" || String(updated.linked_sale_id) !== saleId) {
    if (String(updated.status) === "completed" && updated.linked_sale_id) {
      const existingSale = await env.DB
        .prepare("SELECT * FROM sales WHERE id=?")
        .bind(String(updated.linked_sale_id))
        .first<Row>();
      return json(UpdateSalesPendingDraftResponse.parse({
        status: "completed",
        draft: pendingDraftOut(updated),
        sale: existingSale ? saleOut(existingSale) : null,
      }));
    }
    throw new ApiFailure(409, "A pendência foi alterada. Atualize a lista antes de salvar.");
  }
  const completedSale = await env.DB
    .prepare("SELECT * FROM sales WHERE id=?")
    .bind(saleId)
    .first<Row>();
  return json(UpdateSalesPendingDraftResponse.parse({
    status: "completed",
    draft: pendingDraftOut(updated),
    sale: completedSale ? saleOut(completedSale) : null,
  }));
}

function monthEnd(month: string) {
  const [year, number] = month.split("-").map(Number);
  return new Date(Date.UTC(year, number, 0)).toISOString().slice(0, 10);
}

function monthKeysBetween(start: string, end: string) {
  const result: string[] = [];
  const [startYear, startMonth] = start.split("-").map(Number);
  const [endYear, endMonth] = end.split("-").map(Number);
  let year = startYear;
  let month = startMonth;
  while (year < endYear || (year === endYear && month <= endMonth)) {
    result.push(`${year}-${String(month).padStart(2, "0")}`);
    month += 1;
    if (month === 13) {
      month = 1;
      year += 1;
    }
  }
  return result;
}

function jsonRecord(value: unknown) {
  if (typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function financialRecord(entityType: string, row: Row): Row {
  if (entityType === "product") {
    return {
      id: row.id,
      name: row.name,
      normalizedName: row.normalized_name,
      modalityId: row.modality_id,
      suggestedPriceCents: Number(row.suggested_price_cents),
      isActive: Boolean(row.is_active),
      version: Number(row.version),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
  if (entityType === "sale") {
    return {
      id: row.id,
      productId: row.product_id,
      saleDate: row.sale_date,
      productName: row.product_name,
      quantity: Number(row.quantity),
      unitAmountCents: Number(row.unit_amount_cents),
      totalCents: Number(row.total_cents),
      customerName: row.customer_name,
      notes: row.notes,
      status: row.status,
      cancellationReason: row.cancellation_reason,
      version: Number(row.version),
      createdBy: row.created_by,
      updatedBy: row.updated_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
  if (entityType === "refund") {
    return {
      id: row.id,
      saleId: row.sale_id,
      refundDate: row.refund_date,
      amountCents: Number(row.amount_cents),
      reason: row.reason,
      status: row.status,
      voidReason: row.void_reason,
      version: Number(row.version),
      createdBy: row.created_by,
      updatedBy: row.updated_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
  if (entityType === "goal") {
    return {
      id: row.id,
      month: row.month,
      scopeKey: row.scope_key,
      productId: row.product_id,
      productName: row.product_name,
      targetCents: Number(row.target_cents),
      version: Number(row.version),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
  return {
    id: row.id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    operation: row.operation,
    actorId: row.actor_id,
    beforeData: jsonRecord(row.before_data),
    afterData: jsonRecord(row.after_data),
    createdAt: row.created_at,
  };
}

function backupEnvelope(scope: "period" | "dependency", entityType: string, row: Row) {
  return { scope, record: financialRecord(entityType, row) };
}

async function buildFinancialBackup(
  env: WorkerEnv,
  selected: {
    mode: "months" | "range" | "all";
    months?: string[];
    fromDate?: string;
    toDate?: string;
    productName?: string | null;
    cadastralStatus?: "all" | "needs-review" | "complete";
  },
  monthlyPeriod?: string,
) {
  const [allSales, allRefunds, allGoals, allProducts, allHistories] = await Promise.all([
    asRows(env.DB.prepare("SELECT * FROM sales")),
    asRows(env.DB.prepare("SELECT * FROM sales_refunds")),
    asRows(env.DB.prepare("SELECT * FROM sales_goals")),
    asRows(env.DB.prepare("SELECT * FROM products")),
    asRows(env.DB.prepare("SELECT * FROM sales_history")),
  ]);
  const productById = new Map(allProducts.map((row) => [String(row.id), row]));
  const saleById = new Map(allSales.map((row) => [String(row.id), row]));
  const dateInPeriod = (date: string) => {
    if (monthlyPeriod) return date >= `${monthlyPeriod}-01` && date <= monthEnd(monthlyPeriod);
    if (selected.mode === "all") return true;
    if (selected.mode === "months") {
      return (selected.months ?? []).some(
        (month) => date >= `${month}-01` && date <= monthEnd(month),
      );
    }
    return Boolean(selected.fromDate && selected.toDate && date >= selected.fromDate && date <= selected.toDate);
  };
  const productMatchesSale = (sale: Row | undefined) => {
    if (!sale || !selected.productName) return true;
    const product = sale.product_id ? productById.get(String(sale.product_id)) : undefined;
    return nameKey(String(product?.name ?? sale.product_name)) === nameKey(selected.productName);
  };
  const saleNeedsReview = (sale: Row | undefined) =>
    !String(sale?.customer_name ?? "").trim() || !sale?.product_id;
  const cadastralStatusMatchesSale = (sale: Row | undefined) => {
    if (selected.cadastralStatus === "needs-review") return saleNeedsReview(sale);
    if (selected.cadastralStatus === "complete") return !saleNeedsReview(sale);
    return true;
  };
  const periodSales = allSales.filter(
    (row) => dateInPeriod(String(row.sale_date))
      && productMatchesSale(row)
      && cadastralStatusMatchesSale(row),
  );
  const periodRefunds = allRefunds.filter((row) => {
    const sale = saleById.get(String(row.sale_id));
    return dateInPeriod(String(row.refund_date))
      && productMatchesSale(sale)
      && cadastralStatusMatchesSale(sale);
  });
  const includedSaleIds = new Set([
    ...periodSales.map((row) => String(row.id)),
    ...periodRefunds.map((row) => String(row.sale_id)),
  ]);
  const includedSales = allSales.filter((row) => includedSaleIds.has(String(row.id)));
  const includedRefunds = allRefunds.filter((row) => includedSaleIds.has(String(row.sale_id)));
  const goalsMonths = monthlyPeriod
    ? [monthlyPeriod]
    : selected.mode === "all"
      ? null
      : selected.mode === "months"
        ? selected.months ?? []
        : monthKeysBetween(selected.fromDate!.slice(0, 7), selected.toDate!.slice(0, 7));
  const periodGoals = allGoals.filter((goal) => {
    if (goalsMonths && !goalsMonths.includes(String(goal.month))) return false;
    if (!selected.productName) return true;
    return (
      goal.product_id === null ||
      nameKey(String(goal.product_name ?? "")) === nameKey(selected.productName)
    );
  });
  const includedProductIds = new Set([
    ...includedSales.flatMap((row) => row.product_id ? [String(row.product_id)] : []),
    ...periodGoals.flatMap((row) => row.product_id ? [String(row.product_id)] : []),
  ]);
  const products = allProducts.filter((row) => includedProductIds.has(String(row.id)));
  const historyEntities = new Set([
    ...includedSales.map((row) => `sale:${row.id}`),
    ...includedRefunds.map((row) => `refund:${row.id}`),
    ...products.map((row) => `product:${row.id}`),
    ...periodGoals.map((row) => `goal:${row.id}`),
  ]);
  const histories = allHistories.filter((row) =>
    historyEntities.has(`${String(row.entity_type)}:${String(row.entity_id)}`),
  );
  const periodSaleIds = new Set(periodSales.map((row) => String(row.id)));
  const periodRefundIds = new Set(periodRefunds.map((row) => String(row.id)));
  return {
    allSales,
    allRefunds,
    periodSales,
    periodRefunds,
    includedSales,
    includedRefunds,
    periodGoals,
    products,
    histories,
    periodSaleIds,
    periodRefundIds,
  };
}

async function monthlySalesBackup(request: Request, env: WorkerEnv) {
  const url = new URL(request.url);
  const input = bodyParse(GetMonthlySalesBackupQueryParams, {
    month: url.searchParams.get("month"),
  });
  const data = await buildFinancialBackup(
    env,
    { mode: "months", months: [input.month] },
    input.month,
  );
  const backup = {
    schemaVersion: 2,
    generatedAt: nowIso(),
    period: input.month,
    currency: "BRL",
    businessTimezone: "America/Sao_Paulo",
    counts: {
      periodSales: data.periodSales.length,
      periodRefunds: data.periodRefunds.length,
      periodGoals: data.periodGoals.length,
      dependencySales: data.includedSales.length - data.periodSales.length,
      dependencyRefunds: data.includedRefunds.length - data.periodRefunds.length,
      products: data.products.length,
      histories: data.histories.length,
      totalRecords:
        data.includedSales.length +
        data.includedRefunds.length +
        data.periodGoals.length +
        data.products.length +
        data.histories.length,
    },
    products: data.products.map((row) => backupEnvelope("dependency", "product", row)),
    sales: data.includedSales.map((row) =>
      backupEnvelope(
        data.periodSaleIds.has(String(row.id)) ? "period" : "dependency",
        "sale",
        row,
      ),
    ),
    refunds: data.includedRefunds.map((row) =>
      backupEnvelope(
        data.periodRefundIds.has(String(row.id)) ? "period" : "dependency",
        "refund",
        row,
      ),
    ),
    goals: data.periodGoals.map((row) => backupEnvelope("period", "goal", row)),
    histories: data.histories.map((row) => backupEnvelope("dependency", "history", row)),
  };
  if (new TextEncoder().encode(JSON.stringify(backup)).byteLength > 10 * 1024 * 1024) {
    throw new ApiFailure(413, "O backup do mês excede 10 MB.");
  }
  return json(GetMonthlySalesBackupResponse.parse(backup));
}

async function periodSalesBackup(request: Request, env: WorkerEnv) {
  const input = bodyParse(CreateSalesPeriodBackupBody, await readJson(request));
  if (
    (input.mode === "months" && !input.months?.length) ||
    (input.mode === "range" &&
      (!input.fromDate ||
        !input.toDate ||
        !dateOnly(input.fromDate) ||
        !dateOnly(input.toDate) ||
        input.fromDate > input.toDate)) ||
    (input.mode === "all" && (input.months || input.fromDate || input.toDate))
  ) {
    throw new ApiFailure(400, "A seleção do período do backup é inválida.");
  }
  const selected = {
    mode: input.mode,
    months: input.months,
    fromDate: input.fromDate,
    toDate: input.toDate,
    productName: input.productName?.trim().replace(/\s+/g, " ") || null,
    cadastralStatus: input.cadastralStatus ?? "all",
  };
  const data = await buildFinancialBackup(env, selected);
  const salesCents = data.periodSales.reduce((sum, row) => sum + BigInt(String(row.total_cents)), 0n);
  const refundsCents = data.periodRefunds.reduce((sum, row) => sum + BigInt(String(row.amount_cents)), 0n);
  const quantity = data.periodSales.reduce((sum, row) => sum + BigInt(String(row.quantity)), 0n);
  const safe = (value: bigint, label: string) => {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new ApiFailure(413, `O total de ${label} excede a precisão segura.`);
    }
    return Number(value);
  };
  const selection = {
    mode: input.mode,
    ...(input.months ? { months: input.months } : {}),
    ...(input.fromDate ? { fromDate: input.fromDate } : {}),
    ...(input.toDate ? { toDate: input.toDate } : {}),
    ...(selected.productName ? { productName: selected.productName } : {}),
    cadastralStatus: selected.cadastralStatus,
  };
  const period =
    input.mode === "all"
      ? "Todo o histórico"
      : input.mode === "range"
        ? `${input.fromDate} a ${input.toDate}`
        : [...(input.months ?? [])].sort().join(", ");
  const backup = {
    format: "zero3-pro-financial-backup",
    schemaVersion: 3,
    module: "sales",
    origin: "zero3-pro-financial-database",
    generatedAt: nowIso(),
    period,
    selection,
    partial: input.mode !== "all"
      || Boolean(selected.productName)
      || selected.cadastralStatus !== "all",
    currency: "BRL",
    businessTimezone: "America/Sao_Paulo",
    counts: {
      periodSales: data.periodSales.length,
      periodRefunds: data.periodRefunds.length,
      periodGoals: data.periodGoals.length,
      dependencySales: data.includedSales.length - data.periodSales.length,
      dependencyRefunds: data.includedRefunds.length - data.periodRefunds.length,
      products: data.products.length,
      histories: data.histories.length,
      totalRecords:
        data.includedSales.length +
        data.includedRefunds.length +
        data.periodGoals.length +
        data.products.length +
        data.histories.length,
    },
    totals: {
      salesCents: safe(salesCents, "vendas"),
      refundsCents: safe(refundsCents, "estornos"),
      netCents: safe(salesCents - refundsCents, "valor líquido"),
      quantity: safe(quantity, "quantidade"),
    },
    products: data.products.map((row) => backupEnvelope("dependency", "product", row)),
    sales: data.includedSales.map((row) =>
      backupEnvelope(
        data.periodSaleIds.has(String(row.id)) ? "period" : "dependency",
        "sale",
        row,
      ),
    ),
    refunds: data.includedRefunds.map((row) =>
      backupEnvelope(
        data.periodRefundIds.has(String(row.id)) ? "period" : "dependency",
        "refund",
        row,
      ),
    ),
    goals: data.periodGoals.map((row) => backupEnvelope("period", "goal", row)),
    histories: data.histories.map((row) => backupEnvelope("dependency", "history", row)),
  };
  if (new TextEncoder().encode(JSON.stringify(backup)).byteLength > 10 * 1024 * 1024) {
    throw new ApiFailure(413, "O arquivo de backup excede 10 MB.");
  }
  return json(CreateSalesPeriodBackupResponse.parse(backup));
}

type FinancialBackup = Row & {
  schemaVersion?: number;
  period?: string;
  generatedAt?: Date | string;
  products?: unknown[];
  sales?: unknown[];
  refunds?: unknown[];
  goals?: unknown[];
  histories?: unknown[];
};

const financialTables = {
  products: "products",
  sales: "sales",
  refunds: "sales_refunds",
  goals: "sales_goals",
  histories: "sales_history",
} as const;

function backupEntries(backup: FinancialBackup, type: keyof typeof financialTables) {
  const value = backup[type];
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = (item as { record?: unknown }).record;
    return record && typeof record === "object" && !Array.isArray(record)
      ? [record as Row]
      : [];
  });
}

function financialDbValues(type: keyof typeof financialTables, record: Row): Row {
  if (type === "products") {
    const name = normalizeName(String(record.name ?? ""));
    return {
      id: record.id,
      name,
      normalized_name: record.normalizedName ?? nameKey(name),
      modality_id: record.modalityId ?? null,
      suggested_price_cents: Number(record.suggestedPriceCents ?? 0),
      is_active: Number(Boolean(record.isActive)),
      version: Number(record.version ?? 1),
      created_at: record.createdAt,
      updated_at: record.updatedAt,
    };
  }
  if (type === "sales") {
    return {
      id: record.id,
      product_id: record.productId ?? null,
      sale_date: typeof record.saleDate === "string" ? record.saleDate.slice(0, 10) : record.saleDate,
      product_name: record.productName,
      quantity: Number(record.quantity),
      unit_amount_cents: Number(record.unitAmountCents),
      total_cents: Number(record.totalCents),
      modality_id: record.modalityId ?? null,
      modality_override: Number(Boolean(record.modalityOverride)),
      customer_name: record.customerName ?? null,
      notes: record.notes ?? null,
      status: record.status ?? "active",
      cancellation_reason: record.cancellationReason ?? null,
      version: Number(record.version ?? 1),
      created_by: record.createdBy ?? null,
      updated_by: record.updatedBy ?? null,
      created_at: record.createdAt,
      updated_at: record.updatedAt,
    };
  }
  if (type === "refunds") {
    return {
      id: record.id,
      sale_id: record.saleId,
      refund_date: typeof record.refundDate === "string" ? record.refundDate.slice(0, 10) : record.refundDate,
      amount_cents: Number(record.amountCents),
      reason: record.reason,
      status: record.status ?? "active",
      void_reason: record.voidReason ?? null,
      version: Number(record.version ?? 1),
      created_by: record.createdBy ?? null,
      updated_by: record.updatedBy ?? null,
      created_at: record.createdAt,
      updated_at: record.updatedAt,
    };
  }
  if (type === "goals") {
    return {
      id: record.id,
      month: record.month,
      scope_key: record.scopeKey ?? (record.productId ? nameKey(String(record.productName ?? "")) : "all"),
      product_id: record.productId ?? null,
      product_name: record.productName ?? null,
      target_cents: Number(record.targetCents),
      version: Number(record.version ?? 1),
      created_at: record.createdAt ?? record.updatedAt,
      updated_at: record.updatedAt,
    };
  }
  return {
    id: record.id,
    entity_type: record.entityType,
    entity_id: record.entityId,
    operation: record.operation,
    actor_id: record.actorId,
    before_data:
      record.beforeData == null ? null : JSON.stringify(record.beforeData),
    after_data:
      record.afterData == null ? null : JSON.stringify(record.afterData),
    created_at: record.createdAt,
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function analyzeFinancialRestore(env: WorkerEnv, backup: FinancialBackup) {
  if (backup.schemaVersion !== 2 && backup.schemaVersion !== 3) {
    throw new ApiFailure(
      400,
      "Este formato de backup não é aceito pelo Worker. Use um backup financeiro versão 2 ou 3.",
    );
  }
  const inserts = { products: 0, sales: 0, refunds: 0, goals: 0, histories: 0 };
  const identical = { products: 0, sales: 0, refunds: 0, goals: 0, histories: 0 };
  const conflicts: Array<{
    entityType: "product" | "sale" | "refund" | "goal" | "history";
    id: string;
    reason: string;
    blocking: boolean;
  }> = [];
  const allByTable = new Map<string, Row[]>();
  for (const type of Object.keys(financialTables) as (keyof typeof financialTables)[]) {
    const existingRows = await asRows(
      env.DB.prepare(`SELECT * FROM ${financialTables[type]}`),
    );
    allByTable.set(type, existingRows);
    const incomingIds = new Set<string>();
    const incomingProducts = new Set(
      existingRows.map((row) => String(row.normalized_name ?? "")),
    );
    const incomingGoals = new Set(
      existingRows.map((row) => `${String(row.month ?? "")}:${String(row.scope_key ?? "")}`),
    );
    for (const incoming of backupEntries(backup, type)) {
      const id = String(incoming.id ?? "");
      if (!id) {
        conflicts.push({
          entityType: type === "sales" ? "sale" : type === "refunds" ? "refund" : type === "histories" ? "history" : type === "goals" ? "goal" : "product",
          id: "missing-id",
          reason: "Um registro do backup não contém ID.",
          blocking: true,
        });
        continue;
      }
      if (incomingIds.has(id)) {
        conflicts.push({
          entityType: type === "sales" ? "sale" : type === "refunds" ? "refund" : type === "histories" ? "history" : type === "goals" ? "goal" : "product",
          id,
          reason: "O backup contém o mesmo ID mais de uma vez.",
          blocking: true,
        });
        continue;
      }
      incomingIds.add(id);
      const existing = (allByTable.get(type) ?? []).find((row) => String(row.id) === id);
      const incomingValues = financialDbValues(type, incoming);
      if (existing) {
        const comparableExisting = { ...existing };
        if (type === "histories") {
          comparableExisting.before_data = jsonRecord(existing.before_data);
          comparableExisting.after_data = jsonRecord(existing.after_data);
        }
        const comparableIncoming = { ...incomingValues };
        if (type === "histories") {
          comparableIncoming.before_data = jsonRecord(incomingValues.before_data);
          comparableIncoming.after_data = jsonRecord(incomingValues.after_data);
        }
        if (stableJson(comparableExisting) === stableJson(comparableIncoming)) {
          identical[type] += 1;
        } else {
          conflicts.push({
            entityType: type === "sales" ? "sale" : type === "refunds" ? "refund" : type === "histories" ? "history" : type === "goals" ? "goal" : "product",
            id,
            reason: "O ID já existe com conteúdo diferente.",
            blocking: true,
          });
        }
        continue;
      }
      if (type === "products" && incomingValues.normalized_name) {
        if (incomingProducts.has(String(incomingValues.normalized_name))) {
          conflicts.push({
            entityType: "product",
            id,
            reason: "Já existe outro produto com o mesmo nome normalizado.",
            blocking: true,
          });
          continue;
        }
        incomingProducts.add(String(incomingValues.normalized_name));
      }
      if (type === "goals") {
        const naturalKey = `${String(incomingValues.month)}:${String(incomingValues.scope_key)}`;
        if (incomingGoals.has(naturalKey)) {
          conflicts.push({
            entityType: "goal",
            id,
            reason: "Já existe uma meta para este mês e escopo.",
            blocking: true,
          });
          continue;
        }
        incomingGoals.add(naturalKey);
      }
      inserts[type] += 1;
    }
  }
  const dependencyMonths = new Set<string>();
  for (const type of ["sales", "refunds"] as const) {
    for (const entry of backupEntries(backup, type)) {
      if (type === "sales" && entry.saleDate) dependencyMonths.add(String(entry.saleDate).slice(0, 7));
      if (type === "refunds" && entry.refundDate) dependencyMonths.add(String(entry.refundDate).slice(0, 7));
    }
  }
  return {
    period: String(backup.period ?? ""),
    dependencyMonths: [...dependencyMonths].sort(),
    toInsert: inserts,
    identical,
    conflicts,
    blocked: conflicts.some((item) => item.blocking),
  };
}

async function previewFinancialRestore(request: Request, env: WorkerEnv) {
  const raw = await readJson(request);
  const backupRaw =
    raw && typeof raw === "object" && "backup" in raw
      ? (raw as { backup: unknown }).backup
      : raw;
  const backup = bodyParse(PreviewMonthlySalesBackupRestoreBody, backupRaw) as FinancialBackup;
  const preview = await analyzeFinancialRestore(env, backup);
  return json(PreviewMonthlySalesBackupRestoreResponse.parse(preview));
}

async function restoreFinancialBackup(request: Request, env: WorkerEnv) {
  const raw = await readJson(request);
  const backupRaw =
    raw && typeof raw === "object" && "backup" in raw
      ? (raw as { backup: unknown }).backup
      : raw;
  const backup = bodyParse(RestoreMonthlySalesBackupBody, backupRaw) as FinancialBackup;
  const preview = await analyzeFinancialRestore(env, backup);
  if (preview.blocked) {
    return json(
      RestoreMonthlySalesBackupResponse.parse({
        period: preview.period,
        inserted: { products: 0, sales: 0, refunds: 0, goals: 0, histories: 0 },
        identical: preview.identical,
        conflicts: preview.conflicts,
      }),
      409,
    );
  }
  const statements: ReturnType<D1Database["prepare"]>[] = [];
  for (const type of Object.keys(financialTables) as (keyof typeof financialTables)[]) {
    const existing = await asRows(
      env.DB.prepare(`SELECT id FROM ${financialTables[type]}`),
    );
    const existingIds = new Set(existing.map((row) => String(row.id)));
    for (const record of backupEntries(backup, type)) {
      if (existingIds.has(String(record.id))) continue;
      const values = financialDbValues(type, record);
      const columns = Object.keys(values);
      const placeholders = columns.map(() => "?").join(", ");
      statements.push(
        env.DB.prepare(
          `INSERT INTO ${financialTables[type]} (${columns.join(", ")}) VALUES (${placeholders})`,
        ).bind(...columns.map((column) => values[column] as string | number | null)),
      );
    }
  }
  if (statements.length > 900) {
    throw new ApiFailure(
      413,
      "O backup é grande demais para uma restauração atômica neste Worker. Nenhum dado foi alterado.",
    );
  }
  if (statements.length) {
    try {
      await env.DB.batch(statements);
    } catch {
      throw new ApiFailure(
        409,
        "A base mudou durante a restauração. Nenhum dado do lote foi aplicado; gere uma nova prévia.",
      );
    }
  }
  return json(
    RestoreMonthlySalesBackupResponse.parse({
      period: String(backup.period ?? ""),
      inserted: preview.toInsert,
      identical: preview.identical,
      conflicts: [],
    }),
  );
}

async function upsertGoal(
  request: Request,
  env: WorkerEnv,
  actor: AuthContext,
): Promise<Response> {
  const input = bodyParse(UpsertSalesGoalBody, await readJson(request));
  const productName = input.productName ? normalizeName(input.productName) : null;
  const product = productName
    ? await env.DB
        .prepare("SELECT id, name FROM products WHERE normalized_name = ?")
        .bind(nameKey(productName))
        .first<Row>()
    : null;
  if (productName && !product) throw new ApiFailure(404, "Produto não encontrado.");
  const productId = product ? String(product.id) : null;
  const scopeKey = productId ? `product:${productId}` : "all-plans";
  const existing = await env.DB
    .prepare("SELECT * FROM sales_goals WHERE month=? AND scope_key=?")
    .bind(input.month, scopeKey)
    .first<Row>();
  const id = String(existing?.id ?? crypto.randomUUID());
  const now = nowIso();
  const operation = await runIdempotent(
    env.DB,
    actor,
    `sales-goal:${input.month}:${scopeKey}`,
    input.idempotencyKey,
    input,
    id,
    (operationId) => [
      env.DB
        .prepare(
          `INSERT INTO sales_goals
            (id, month, scope_key, product_id, product_name, target_cents, version, updated_at)
           SELECT ?, ?, ?, ?, ?, ?, 1, ?
           WHERE EXISTS (SELECT 1 FROM idempotency_keys WHERE id=?)
           ON CONFLICT(month, scope_key) DO UPDATE SET
             target_cents=excluded.target_cents,
             version=sales_goals.version+1,
             updated_at=excluded.updated_at`,
        )
        .bind(id, input.month, scopeKey, productId, product ? String(product.name) : null, input.targetCents, now, operationId),
      env.DB.prepare(
        `INSERT INTO sales_history
          (id, entity_type, entity_id, operation, actor_id, before_data, after_data, created_at)
         SELECT ?, 'goal', id, ?, ?, ?, json_object('id', id, 'month', month,
           'scopeKey', scope_key, 'productId', product_id, 'productName', product_name,
           'targetCents', target_cents, 'version', version, 'updatedAt', updated_at), ?
         FROM sales_goals WHERE id=? AND EXISTS (SELECT 1 FROM idempotency_keys WHERE id=?)`,
      ).bind(
        crypto.randomUUID(),
        existing ? "update" : "create",
        actor.userId,
        existing ? JSON.stringify(existing) : null,
        now,
        id,
        operationId,
      ),
    ],
  );
  const row = await env.DB
    .prepare("SELECT * FROM sales_goals WHERE id=?")
    .bind(operation.resourceId)
    .first<Row>();
  if (!row) throw new Error("Meta não foi salva.");
  return json({
    id: row.id,
    month: row.month,
    productId: row.product_id,
    productName: row.product_name,
    targetCents: Number(row.target_cents),
    version: Number(row.version),
    updatedAt: row.updated_at,
  });
}

async function listRefunds(env: WorkerEnv, candidates: boolean): Promise<Response> {
  if (candidates) {
    const rows = await asRows(
      env.DB.prepare(
        `SELECT s.id AS sale_id, s.sale_date, s.product_id, s.product_name,
          s.quantity, s.unit_amount_cents, s.total_cents,
          s.version,
          COALESCE(SUM(CASE WHEN r.status='active' THEN r.amount_cents ELSE 0 END),0) AS refunded_cents
         FROM sales s LEFT JOIN sales_refunds r ON r.sale_id=s.id
         WHERE s.status='active' GROUP BY s.id ORDER BY s.sale_date DESC, s.created_at DESC`,
      ),
    );
    return json(
      GetSalesRefundCandidatesResponse.parse(
        rows
          .map((row) => {
            const totalCents = Number(row.total_cents);
            const refundedCents = Number(row.refunded_cents);
            return {
              saleId: row.sale_id,
              saleDate: row.sale_date,
              productId: row.product_id,
              productName: row.product_name,
              quantity: Number(row.quantity),
              totalCents,
              refundedCents,
              remainingCents: totalCents - refundedCents,
              version: Number(row.version),
            };
          })
          .filter((item) => item.remainingCents > 0),
      ),
    );
  }
  const rows = await asRows(
    env.DB.prepare(
      `SELECT r.*, s.sale_date, s.product_id, s.product_name, s.quantity,
         s.unit_amount_cents, s.total_cents, s.status AS sale_status
       FROM sales_refunds r JOIN sales s ON s.id=r.sale_id
       ORDER BY r.refund_date DESC, r.created_at DESC`,
    ),
  );
  return json(
    GetSalesRefundsResponse.parse(
      rows.map((row) => ({
        ...refundOut(row),
        saleDate: row.sale_date,
        productId: row.product_id,
        productName: row.product_name,
        quantity: Number(row.quantity),
        unitAmountCents: Number(row.unit_amount_cents),
        totalCents: Number(row.total_cents),
        saleStatus: row.sale_status,
      })),
    ),
  );
}

async function createRefund(
  request: Request,
  env: WorkerEnv,
  actor: AuthContext,
  saleId: string,
): Promise<Response> {
  const raw = await readJson(request);
  const input = bodyParse(CreateSalesRefundBody, raw);
  const refundDate =
    typeof (raw as { refundDate?: unknown } | null)?.refundDate === "string"
      ? dateOnly((raw as { refundDate: string }).refundDate)
      : null;
  if (!refundDate) throw new ApiFailure(400, "Informe uma data de estorno válida.");
  const requestData = { ...input, refundDate, reason: input.reason.trim().replace(/\s+/g, " ") };
  const previous = await findIdempotent(
    env.DB,
    actor,
    `refund-create:${saleId}`,
    input.idempotencyKey,
    requestData,
  );
  if (previous) {
    const replayed = await env.DB
      .prepare("SELECT * FROM sales_refunds WHERE id=?")
      .bind(previous.resourceId)
      .first<Row>();
    if (!replayed) throw new ApiFailure(409, "O estorno idempotente não foi encontrado.");
    return json(refundOut(replayed));
  }
  const sale = await getSale(env.DB, saleId);
  if (!sale || sale.status !== "active") throw new ApiFailure(404, "Venda não encontrada.");
  if (refundDate < String(sale.sale_date)) {
    throw new ApiFailure(400, "A data do estorno não pode ser anterior à venda.");
  }
  const totals = await env.DB
    .prepare(
      "SELECT COALESCE(SUM(amount_cents),0) AS refunded FROM sales_refunds WHERE sale_id=? AND status='active'",
    )
    .bind(saleId)
    .first<{ refunded: number }>();
  const refunded = Number(totals?.refunded ?? 0);
  if (input.amountCents > Number(sale.total_cents) - refunded) {
    throw new ApiFailure(409, "O valor do estorno excede o saldo disponível.");
  }
  const id = crypto.randomUUID();
  const now = nowIso();
  let operationIdForCleanup: string | undefined;
  const operation = await runIdempotent(
    env.DB,
    actor,
    `refund-create:${saleId}`,
    input.idempotencyKey,
    requestData,
    id,
    (operationId) => {
      operationIdForCleanup = operationId;
      return [
        env.DB
        .prepare(
          `INSERT INTO sales_refunds
            (id, sale_id, refund_date, amount_cents, reason, status, void_reason, version, created_by, updated_by, created_at, updated_at)
           SELECT ?, ?, ?, ?, ?, 'active', NULL, 1, ?, ?, ?, ?
           WHERE EXISTS (SELECT 1 FROM idempotency_keys WHERE id=?)
             AND EXISTS (
               SELECT 1 FROM sales s WHERE s.id=? AND s.status='active'
                 AND ? >= s.sale_date
                 AND ? <= s.total_cents - COALESCE(
                   (SELECT SUM(amount_cents) FROM sales_refunds r
                    WHERE r.sale_id=s.id AND r.status='active'), 0
                 )
             )`,
        )
        .bind(
          id,
          saleId,
          refundDate,
          input.amountCents,
          requestData.reason,
          actor.userId,
          actor.userId,
          now,
          now,
          operationId,
          saleId,
          refundDate,
          input.amountCents,
        ),
      env.DB.prepare(
        `INSERT INTO sales_history
          (id, entity_type, entity_id, operation, actor_id, before_data, after_data, created_at)
         SELECT ?, 'refund', id, 'create', ?, NULL, json_object('id', id, 'saleId', sale_id,
           'refundDate', refund_date, 'amountCents', amount_cents, 'reason', reason,
           'status', status, 'version', version, 'createdAt', created_at, 'updatedAt', updated_at), ?
         FROM sales_refunds WHERE id=? AND EXISTS (SELECT 1 FROM idempotency_keys WHERE id=?)`,
      ).bind(crypto.randomUUID(), actor.userId, now, id, operationId),
      ];
    },
  );
  const row = await env.DB.prepare("SELECT * FROM sales_refunds WHERE id=?")
    .bind(operation.resourceId).first<Row>();
  if (!row) {
    if (operationIdForCleanup && !operation.replayed) {
      await env.DB.prepare("DELETE FROM idempotency_keys WHERE id=?").bind(operationIdForCleanup).run();
    }
    throw new ApiFailure(409, "O valor do estorno excede o saldo disponível.");
  }
  return json(refundOut(row), operation.replayed ? 200 : 201);
}

async function updateRefund(
  request: Request,
  env: WorkerEnv,
  actor: AuthContext,
  id: string,
): Promise<Response> {
  const raw = await readJson(request);
  const input = bodyParse(UpdateSalesRefundBody, raw);
  const refundDate =
    typeof (raw as { refundDate?: unknown } | null)?.refundDate === "string"
      ? dateOnly((raw as { refundDate: string }).refundDate)
      : null;
  const reason = input.reason.trim().replace(/\s+/g, " ");
  if (!refundDate || !reason || input.amountCents <= 0) {
    throw new ApiFailure(400, "Informe data, valor positivo e motivo válidos.");
  }
  const requestData = {
    refundDate,
    amountCents: input.amountCents,
    reason,
    expectedVersion: input.expectedVersion,
  };
  const operation = `sales-refund-update:${id}`;
  const previous = await findIdempotent(env.DB, actor, operation, input.idempotencyKey, requestData);
  if (previous) {
    const replayed = await env.DB.prepare("SELECT * FROM sales_refunds WHERE id=?")
      .bind(previous.resourceId).first<Row>();
    if (!replayed) throw new ApiFailure(409, "O estorno idempotente não foi encontrado.");
    return json(UpdateSalesRefundResponse.parse(refundOut(replayed)));
  }
  const current = await env.DB.prepare("SELECT * FROM sales_refunds WHERE id=?")
    .bind(id).first<Row>();
  if (!current) throw new ApiFailure(404, "Estorno não encontrado.");
  if (current.status !== "active") throw new ApiFailure(409, "Somente estornos ativos podem ser corrigidos.");
  if (Number(current.version) !== input.expectedVersion) {
    throw new ApiFailure(409, "O estorno foi alterado. Atualize antes de corrigir.");
  }
  const now = nowIso();
  let operationIdForCleanup: string | undefined;
  const result = await runIdempotent(
    env.DB,
    actor,
    operation,
    input.idempotencyKey,
    requestData,
    id,
    (operationId) => {
      operationIdForCleanup = operationId;
      return [
        env.DB.prepare(
          `UPDATE sales_refunds SET refund_date=?, amount_cents=?, reason=?, version=version+1,
             updated_by=?, updated_at=?
           WHERE id=? AND status='active' AND version=?
             AND EXISTS (SELECT 1 FROM idempotency_keys WHERE id=?)
             AND EXISTS (
               SELECT 1 FROM sales s WHERE s.id=sale_id AND s.status='active'
                 AND ? >= s.sale_date
                 AND ? <= s.total_cents - COALESCE(
                   (SELECT SUM(r.amount_cents) FROM sales_refunds r
                    WHERE r.sale_id=s.id AND r.status='active' AND r.id<>?), 0
                 )
             )`,
        ).bind(
          refundDate,
          input.amountCents,
          reason,
          actor.userId,
          now,
          id,
          input.expectedVersion,
          operationId,
          refundDate,
          input.amountCents,
          id,
        ),
        env.DB.prepare(
          `INSERT INTO sales_history
            (id, entity_type, entity_id, operation, actor_id, before_data, after_data, created_at)
           SELECT ?, 'refund', id, 'update', ?, ?, json_object('id', id, 'saleId', sale_id,
             'refundDate', refund_date, 'amountCents', amount_cents, 'reason', reason,
             'status', status, 'version', version, 'updatedAt', updated_at), ?
           FROM sales_refunds WHERE id=? AND version=? AND updated_at=?
             AND EXISTS (SELECT 1 FROM idempotency_keys WHERE id=?)`,
        ).bind(
          crypto.randomUUID(),
          actor.userId,
          JSON.stringify(current),
          now,
          id,
          input.expectedVersion + 1,
          now,
          operationId,
        ),
      ];
    },
  );
  const updated = await env.DB.prepare("SELECT * FROM sales_refunds WHERE id=?")
    .bind(id).first<Row>();
  if (!updated || Number(updated.version) !== input.expectedVersion + 1) {
    if (operationIdForCleanup && !result.replayed) {
      await env.DB.prepare("DELETE FROM idempotency_keys WHERE id=?").bind(operationIdForCleanup).run();
    }
    throw new ApiFailure(409, "O estorno não pode ser corrigido com os dados informados.");
  }
  return json(UpdateSalesRefundResponse.parse(refundOut(updated)));
}

async function voidRefund(
  request: Request,
  env: WorkerEnv,
  actor: AuthContext,
  id: string,
): Promise<Response> {
  const input = bodyParse(VoidSalesRefundBody, await readJson(request));
  const reason = input.reason.trim().replace(/\s+/g, " ");
  const requestData = { reason, expectedVersion: input.expectedVersion };
  const operation = `sales-refund-void:${id}`;
  const previous = await findIdempotent(env.DB, actor, operation, input.idempotencyKey, requestData);
  if (previous) {
    const replayed = await env.DB.prepare("SELECT * FROM sales_refunds WHERE id=?")
      .bind(previous.resourceId).first<Row>();
    if (!replayed) throw new ApiFailure(409, "O estorno idempotente não foi encontrado.");
    return json(VoidSalesRefundResponse.parse(refundOut(replayed)));
  }
  const current = await env.DB.prepare("SELECT * FROM sales_refunds WHERE id=?")
    .bind(id).first<Row>();
  if (!current) throw new ApiFailure(404, "Estorno não encontrado.");
  if (current.status !== "active") throw new ApiFailure(409, "Somente estornos ativos podem ser anulados.");
  if (Number(current.version) !== input.expectedVersion) {
    throw new ApiFailure(409, "O estorno foi alterado. Atualize antes de anular.");
  }
  const now = nowIso();
  let operationIdForCleanup: string | undefined;
  const result = await runIdempotent(
    env.DB,
    actor,
    operation,
    input.idempotencyKey,
    requestData,
    id,
    (operationId) => {
      operationIdForCleanup = operationId;
      return [
        env.DB.prepare(
          `UPDATE sales_refunds SET status='voided', void_reason=?, version=version+1,
             updated_by=?, updated_at=?
           WHERE id=? AND status='active' AND version=?
             AND EXISTS (SELECT 1 FROM idempotency_keys WHERE id=?)`,
        ).bind(reason, actor.userId, now, id, input.expectedVersion, operationId),
        env.DB.prepare(
          `INSERT INTO sales_history
            (id, entity_type, entity_id, operation, actor_id, before_data, after_data, created_at)
           SELECT ?, 'refund', id, 'void', ?, ?, json_object('id', id, 'saleId', sale_id,
             'status', status, 'voidReason', void_reason, 'amountCents', amount_cents,
             'version', version, 'updatedAt', updated_at), ?
           FROM sales_refunds WHERE id=? AND status='voided' AND version=? AND updated_at=?
             AND EXISTS (SELECT 1 FROM idempotency_keys WHERE id=?)`,
        ).bind(
          crypto.randomUUID(),
          actor.userId,
          JSON.stringify(current),
          now,
          id,
          input.expectedVersion + 1,
          now,
          operationId,
        ),
      ];
    },
  );
  const updated = await env.DB.prepare("SELECT * FROM sales_refunds WHERE id=?")
    .bind(id).first<Row>();
  if (!updated || Number(updated.version) !== input.expectedVersion + 1) {
    if (operationIdForCleanup && !result.replayed) {
      await env.DB.prepare("DELETE FROM idempotency_keys WHERE id=?").bind(operationIdForCleanup).run();
    }
    throw new ApiFailure(409, "O estorno não pode ser anulado. Atualize e tente novamente.");
  }
  return json(VoidSalesRefundResponse.parse(refundOut(updated)));
}

function historyData(value: unknown) {
  if (typeof value !== "string") return value ?? null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function historyOut(row: Row) {
  return {
    id: String(row.id),
    entityType: String(row.entity_type),
    entityId: String(row.entity_id),
    operation: String(row.operation),
    actorId: String(row.actor_id),
    beforeData: historyData(row.before_data),
    afterData: historyData(row.after_data),
    createdAt: String(row.created_at),
  };
}

async function getHistory(
  env: WorkerEnv,
  entityType: "sale" | "refund",
  id: string,
): Promise<Response> {
  const table = entityType === "sale" ? "sales" : "sales_refunds";
  const entityExists = await env.DB.prepare(`SELECT id FROM ${table} WHERE id=?`)
    .bind(id).first();
  if (!entityExists) throw new ApiFailure(404, entityType === "sale" ? "Venda não encontrada." : "Estorno não encontrado.");
  const rows = await asRows(
    env.DB.prepare(
      `SELECT * FROM sales_history WHERE entity_type=? AND entity_id=?
       ORDER BY created_at DESC, id DESC`,
    ).bind(entityType, id),
  );
  return entityType === "sale"
    ? json(GetSaleHistoryResponse.parse(rows.map(historyOut)))
    : json(GetSalesRefundHistoryResponse.parse(rows.map(historyOut)));
}

export async function handleSalesRequest(
  request: Request,
  env: WorkerEnv,
  actor: AuthContext,
  path: string,
): Promise<Response | null> {
  try {
    if (path === "/sales/active-contracts" && request.method === "GET") {
      return await getActiveContracts(env);
    }
    const activeContractsMonth = /^\/sales\/active-contracts\/([^/]+)$/.exec(path)?.[1];
    if (activeContractsMonth && request.method === "PUT") {
      return await upsertActiveContractsMonth(request, env, activeContractsMonth);
    }
    if (path === "/sales/pending" && request.method === "GET") {
      return await listSalesPendingDrafts(env);
    }
    const pendingDraftId = /^\/sales\/pending\/([0-9a-f-]+)$/i.exec(path)?.[1];
    if (pendingDraftId && request.method === "PATCH") {
      return await updateSalesPendingDraft(request, env, actor, pendingDraftId);
    }
    if (path === "/sales/import/origins" && request.method === "GET") {
      const url = new URL(request.url);
      const query = bodyParse(GetSalesImportOriginsQueryParams, {
        fileHash: url.searchParams.get("fileHash"),
      });
      const origins = await salesImportOrigins(env, query.fileHash);
      return json(
        GetSalesImportOriginsResponse.parse({
          origins: origins.map((origin) => ({
            sourceSheet: String(origin.source_sheet),
            sourceRow: Number(origin.source_row),
            state: String(origin.state),
            saleId: origin.sale_id === null ? null : String(origin.sale_id),
            draftId: origin.draft_id === null ? null : String(origin.draft_id),
          })),
        }),
      );
    }
    if (path === "/sales/import" && request.method === "POST") {
      return await importSales(request, env, actor);
    }
    if (path === "/sales/backup" && request.method === "GET") {
      return await monthlySalesBackup(request, env);
    }
    if (path === "/sales/backup/period" && request.method === "POST") {
      return await periodSalesBackup(request, env);
    }
    if (path === "/sales/restore/preview" && request.method === "POST") {
      return await previewFinancialRestore(request, env);
    }
    if (path === "/sales/restore" && request.method === "POST") {
      return await restoreFinancialBackup(request, env);
    }
    if (path === "/sales/restore/preview" && request.method === "POST") {
      return await previewFinancialRestore(request, env);
    }
    if (path === "/sales/restore" && request.method === "POST") {
      return await restoreFinancialBackup(request, env);
    }
    if (path === "/products" && request.method === "GET") {
      const rows = await asRows(
        env.DB.prepare("SELECT * FROM products ORDER BY normalized_name"),
      );
      return json(GetProductsResponse.parse(rows.map(productOut)));
    }
    if (path === "/products" && request.method === "POST") {
      return await createProduct(request, env, actor);
    }
    const productId = /^\/products\/([0-9a-f-]+)$/i.exec(path)?.[1];
    if (productId && request.method === "PATCH") {
      return await updateProduct(request, env, actor, productId);
    }
    if (path === "/sales" && request.method === "GET") {
      const rows = await asRows(
        env.DB.prepare(
          "SELECT * FROM sales WHERE status='active' ORDER BY sale_date DESC, created_at DESC",
        ),
      );
      return json(GetSalesResponse.parse(rows.map(saleOut)));
    }
    if (path === "/sales/history" && request.method === "GET") {
      const rows = await asRows(
        env.DB.prepare("SELECT * FROM sales ORDER BY sale_date DESC, created_at DESC"),
      );
      return json(GetSalesHistoryResponse.parse(rows.map(saleOut)));
    }
    if (path === "/sales" && request.method === "POST") {
      return await createSale(request, env, actor);
    }
    const saleId = /^\/sales\/([0-9a-f-]+)$/.exec(path)?.[1];
    if (saleId && request.method === "PATCH") {
      return await updateSale(request, env, actor, saleId);
    }
    const cancelId = /^\/sales\/([0-9a-f-]+)\/cancel$/.exec(path)?.[1];
    if (cancelId && request.method === "POST") {
      return await cancelSale(request, env, actor, cancelId);
    }
    if (path === "/sales/scoreboard" && request.method === "GET") {
      return await getScoreboard(request, env);
    }
    if (path === "/sales-goals" && request.method === "GET") {
      return await getGoals(env);
    }
    if (path === "/sales-goals" && request.method === "PUT") {
      return await upsertGoal(request, env, actor);
    }
    if (path === "/sales/refund-candidates" && request.method === "GET") {
      return await listRefunds(env, true);
    }
    if (path === "/sales/refunds" && request.method === "GET") {
      return await listRefunds(env, false);
    }
    const createRefundId = /^\/sales\/([0-9a-f-]+)\/refunds$/.exec(path)?.[1];
    if (createRefundId && request.method === "POST") {
      return await createRefund(request, env, actor, createRefundId);
    }
    const refundHistoryId = /^\/sales\/refunds\/([0-9a-f-]+)\/history$/i.exec(path)?.[1];
    if (refundHistoryId && request.method === "GET") {
      const params = bodyParse(GetSalesRefundHistoryParams, { id: refundHistoryId });
      return await getHistory(env, "refund", params.id);
    }
    const refundVoidId = /^\/sales\/refunds\/([0-9a-f-]+)\/void$/i.exec(path)?.[1];
    if (refundVoidId && request.method === "POST") {
      const params = bodyParse(VoidSalesRefundParams, { id: refundVoidId });
      return await voidRefund(request, env, actor, params.id);
    }
    const refundId = /^\/sales\/refunds\/([0-9a-f-]+)$/i.exec(path)?.[1];
    if (refundId && request.method === "PATCH") {
      const params = bodyParse(UpdateSalesRefundParams, { id: refundId });
      return await updateRefund(request, env, actor, params.id);
    }
    const saleHistoryId = /^\/sales\/([0-9a-f-]+)\/history$/i.exec(path)?.[1];
    if (saleHistoryId && request.method === "GET") {
      const params = bodyParse(GetSaleHistoryParams, { id: saleHistoryId });
      return await getHistory(env, "sale", params.id);
    }
    if (path.startsWith("/sales/") && request.method === "GET") {
      if (path.endsWith("/history")) return apiError(404, "Rota não encontrada.");
    }
    return null;
  } catch (error) {
    if (error instanceof ApiFailure) return apiError(error.status, error.message);
    throw error;
  }
}
