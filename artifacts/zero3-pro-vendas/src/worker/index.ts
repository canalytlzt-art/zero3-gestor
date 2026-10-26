import { getAuthContext, proxyClerkRequest } from "./auth";
import { apiError, json, routeError } from "./http";
import type { WorkerEnv } from "./types";
import { handleSalesRequest } from "./sales";
import { handleOccupancyRequest } from "./occupancy";

const API_PREFIX = "/api";
const CLERK_PROXY_PREFIX = `${API_PREFIX}/__clerk`;

async function handleApi(request: Request, env: WorkerEnv): Promise<Response> {
  const { pathname } = new URL(request.url);
  const path = pathname.slice(API_PREFIX.length) || "/";

  if (path === "/healthz" && request.method === "GET") {
    return json({ status: "ok" });
  }

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS",
        "access-control-allow-headers": "content-type,authorization",
        "access-control-max-age": "600",
      },
    });
  }

  const validation = await getAuthContext(request, env);
  if (!validation.ok) {
    console.warn(JSON.stringify({
      event: "auth.validation_failed",
      route: path === "/access-status" ? "access-status" : "protected-api",
      method: request.method,
      status: validation.status,
      code: validation.code,
      ...(validation.verificationReason
        ? { verificationReason: validation.verificationReason }
        : {}),
      ...(validation.upstreamStatus === undefined
        ? {}
        : { upstreamStatus: validation.upstreamStatus }),
      rayId: request.headers.get("cf-ray") ?? undefined,
    }));
    return apiError(validation.status, validation.message, validation.code);
  }

  const auth = validation.context;
  if (path === "/access-status" && request.method === "GET") {
    if (!auth.authorized) {
      console.warn(JSON.stringify({
        event: "auth.access_denied",
        route: "access-status",
        method: request.method,
        status: 403,
        code: "admin_not_allowlisted",
        rayId: request.headers.get("cf-ray") ?? undefined,
      }));
    }
    return json({
      authorized: auth.authorized,
      code: auth.authorized ? "authorized" : "admin_not_allowlisted",
    });
  }
  if (!auth.authorized) {
    return apiError(
      403,
      "Acesso restrito à equipe autorizada.",
      "admin_not_allowlisted",
    );
  }

  const salesResponse = await handleSalesRequest(request, env, auth, path);
  if (salesResponse) return salesResponse;
  const occupancyResponse = await handleOccupancyRequest(request, env, auth, path);
  if (occupancyResponse) return occupancyResponse;
  return apiError(501, "Esta rota ainda não foi portada para o Worker.");
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const { pathname } = new URL(request.url);
    try {
      if (
        pathname === CLERK_PROXY_PREFIX ||
        pathname.startsWith(`${CLERK_PROXY_PREFIX}/`)
      ) {
        return await proxyClerkRequest(request, env);
      }
      if (pathname === API_PREFIX || pathname.startsWith(`${API_PREFIX}/`)) {
        return await handleApi(request, env);
      }
      return env.ASSETS.fetch(request);
    } catch (error) {
      return routeError(error);
    }
  },
};
