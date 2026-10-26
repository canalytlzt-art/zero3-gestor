export const json = (value: unknown, status = 200): Response =>
  Response.json(value, {
    status,
    headers: { "cache-control": "no-store" },
  });

export function apiError(status: number, message: string): Response {
  return json({ error: message }, status);
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

export function routeError(error: unknown): Response {
  const status =
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof error.status === "number"
      ? error.status
      : 500;
  const message =
    error instanceof Error ? error.message : "Erro interno da API.";
  return apiError(status, status >= 500 ? "Erro interno da API." : message);
}

export function parseQueryList(value: string | null): string[] {
  return value
    ? [...new Set(value.split(",").map((entry) => entry.trim()).filter(Boolean))]
    : [];
}
