export interface D1Result<T = unknown> {
  success: boolean;
  results?: T[];
  meta?: {
    changes?: number;
    last_row_id?: number;
    duration?: number;
  };
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(columnName?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  raw<T = unknown[]>(): Promise<T[]>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(query: string): Promise<D1Result>;
}

export interface WorkerAssets {
  fetch(request: Request): Promise<Response>;
}

export interface WorkerEnv {
  DB: D1Database;
  ASSETS: WorkerAssets;
  CLERK_SECRET_KEY?: string;
  CLERK_JWT_KEY?: string;
  CLERK_ISSUER?: string;
  ZERO3_ALLOWED_EMAILS?: string;
  CLERK_AUTHORIZED_PARTIES?: string;
}

export interface AuthContext {
  userId: string;
  email: string | null;
  authorized: boolean;
}
