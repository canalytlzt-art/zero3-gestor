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

  const auth = await getAuthContext(request, env);
  if (!auth) return apiError(401, "Autenticação necessária.");
  if (path === "/access-status" && request.method === "GET") {
    return json({ authorized: auth.authorized });
  }
  if (!auth.authorized) {
    return apiError(403, "Acesso restrito à equipe autorizada.");
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
