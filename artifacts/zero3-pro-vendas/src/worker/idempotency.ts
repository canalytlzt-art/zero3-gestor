import type { AuthContext, D1Database, D1PreparedStatement } from "./types";

export class ApiFailure extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

interface IdempotencyRow {
  id: string;
  request_hash: string;
  resource_id: string | null;
}

export async function findIdempotent(
  db: D1Database,
  actor: AuthContext,
  operation: string,
  key: string,
  request: unknown,
): Promise<{ resourceId: string } | null> {
  const requestHash = await sha256(request);
  const previous = await db
    .prepare(
      "SELECT id, request_hash, resource_id FROM idempotency_keys WHERE actor_id = ? AND operation = ? AND key = ?",
    )
    .bind(actor.userId, operation, key)
    .first<IdempotencyRow>();
  if (!previous) return null;
  if (previous.request_hash !== requestHash) {
    throw new ApiFailure(409, "A idempotency key was already used with different data.");
  }
  if (!previous.resource_id) {
    throw new ApiFailure(409, "A operação idempotente anterior está incompleta.");
  }
  return { resourceId: previous.resource_id };
}

export async function runIdempotent(
  db: D1Database,
  actor: AuthContext,
  operation: string,
  key: string,
  request: unknown,
  resourceId: string,
  createStatements: (operationId: string, requestHash: string) => D1PreparedStatement[],
): Promise<{ replayed: boolean; resourceId: string }> {
  const requestHash = await sha256(request);
  const findExisting = () =>
    db
      .prepare(
        "SELECT id, request_hash, resource_id FROM idempotency_keys WHERE actor_id = ? AND operation = ? AND key = ?",
      )
      .bind(actor.userId, operation, key)
      .first<IdempotencyRow>();

  const previous = await findExisting();
  if (previous) {
    if (previous.request_hash !== requestHash) {
      throw new ApiFailure(409, "A idempotency key was already used with different data.");
    }
    if (!previous.resource_id) {
      throw new ApiFailure(409, "A operação idempotente anterior está incompleta.");
    }
    return { replayed: true, resourceId: previous.resource_id };
  }

  const operationId = crypto.randomUUID();
  const now = new Date().toISOString();
  const insertKey = db
    .prepare(
      `INSERT INTO idempotency_keys
        (id, actor_id, operation, key, request_hash, response_payload, resource_id, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
       ON CONFLICT(actor_id, operation, key) DO NOTHING`,
    )
    .bind(
      operationId,
      actor.userId,
      operation,
      key,
      requestHash,
      resourceId,
      now,
    );

  await db.batch([
    insertKey,
    ...createStatements(operationId, requestHash),
  ]);

  const persisted = await findExisting();
  if (!persisted) throw new Error("Idempotency record was not persisted.");
  if (persisted.request_hash !== requestHash) {
    throw new ApiFailure(409, "A idempotency key was already used with different data.");
  }
  if (!persisted.resource_id) {
    throw new ApiFailure(409, "A operação idempotente anterior está incompleta.");
  }
  return {
    replayed: persisted.id !== operationId,
    resourceId: persisted.resource_id,
  };
}
