export const json = (value: unknown, status = 200): Response =>
  Response.json(value, {
    status,
    headers: { "cache-control": "no-store" },
  });

export function apiError(status: number, message: string, code?: string): Response {
  return json({ error: message, ...(code ? { code } : {}) }, status);
}

export async function readJson(request: Request): Promise<unknown> {
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > 10 * 1024 * 1024) {
    throw Object.assign(new Error("Corpo da solicitação excede 10 MB."), {
      status: 413,
    });
  }

  const text = await request.text();
  if (text.length > 10 * 1024 * 1024) {
    throw Object.assign(new Error("Corpo da solicitação excede 10 MB."), {
      status: 413,
    });
  }
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    throw Object.assign(new Error("JSON inválido."), { status: 400 });
  }
}

type FailureDetails = {
  status: number;
  code: string;
  message: string;
  category: string;
};

function failureDetails(error: unknown): FailureDetails {
  const status =
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof error.status === "number"
      ? error.status
      : 500;
  const originalMessage = error instanceof Error ? error.message : "";
  const errorName = error instanceof Error ? error.name : "";
  const databaseFailure = /D1|SQLITE|database/i.test(`${errorName} ${originalMessage}`);
  const message = originalMessage.toLowerCase();

  if (
    status >= 500 &&
    databaseFailure &&
    /no such (table|column|index)|has no column named|no query solution/.test(message)
  ) {
    return {
      status: 503,
      code: "database_schema_unavailable",
      category: "database_schema_unavailable",
      message: "O banco ainda não está preparado para esta operação. Avise a equipe administrativa.",
    };
  }

  if (
    status >= 500 &&
    databaseFailure &&
    /unique constraint|foreign key constraint|check constraint|constraint failed/.test(message)
  ) {
    return {
      status: 409,
      code: "database_conflict",
      category: "database_constraint",
      message: "Os dados conflitam com um registro existente. Atualize e tente novamente.",
    };
  }

  if (
    status >= 500 &&
    databaseFailure &&
    /busy|locked|timeout|timed out|temporarily unavailable/.test(message)
  ) {
    return {
      status: 503,
      code: "database_temporarily_unavailable",
      category: "database_temporarily_unavailable",
      message: "O banco está temporariamente indisponível. Aguarde e tente novamente.",
    };
  }

  if (status >= 500 && databaseFailure) {
    return {
      status: 503,
      code: "database_operation_failed",
      category: "database_operation_failed",
      message: "Não foi possível confirmar a operação no banco. Recarregue os dados antes de tentar novamente.",
    };
  }

  return {
    status,
    code:
      status >= 500
        ? "api_internal_error"
        : status === 413
          ? "payload_too_large"
          : "invalid_request",
    category: status >= 500 ? "api_internal_error" : "request_error",
    message:
      status >= 500
        ? "Não foi possível concluir esta operação. Tente novamente; se persistir, informe o código da solicitação ao suporte."
        : originalMessage || "Solicitação inválida.",
  };
}

function routeGroup(request?: Request): string {
  if (!request) return "unknown";
  const { pathname } = new URL(request.url);
  if (pathname.startsWith("/api/sales") || pathname.startsWith("/api/products")) return "sales";
  if (pathname.startsWith("/api/occupancy")) return "occupancy";
  if (pathname.startsWith("/api/access-status")) return "access";
  if (pathname.startsWith("/api/__clerk")) return "clerk";
  return pathname.startsWith("/api/") ? "api" : "asset";
}

export function routeError(error: unknown, request?: Request): Response {
  const details = failureDetails(error);
  if (details.status >= 500) {
    const errorName =
      error instanceof Error
        ? error.name.replace(/[^A-Za-z0-9_$]/g, "").slice(0, 40) || "Error"
        : "UnknownError";
    console.error(
      JSON.stringify({
        event: "api.unhandled_error",
        route: routeGroup(request),
        method: request?.method,
        status: details.status,
        code: details.code,
        failureCategory: details.category,
        errorName,
        rayId: request?.headers.get("cf-ray") ?? undefined,
      }),
    );
  }
  return apiError(details.status, details.message, details.code);
}

export function parseQueryList(value: string | null): string[] {
  return value
    ? [...new Set(value.split(",").map((entry) => entry.trim()).filter(Boolean))]
    : [];
}
