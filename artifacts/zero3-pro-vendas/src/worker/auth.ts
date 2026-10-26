import { verifyToken } from "@clerk/backend";
import type { AuthContext, WorkerEnv } from "./types";

function cookieValue(request: Request, name: string): string | null {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

function sessionToken(request: Request): string | null {
  const bearer = request.headers.get("authorization");
  if (bearer?.startsWith("Bearer ")) return bearer.slice(7).trim() || null;
  return cookieValue(request, "__session") ??
    cookieValue(request, "__session_legacy");
}

async function verifiedUserId(
  request: Request,
  env: WorkerEnv,
): Promise<string | null> {
  const token = sessionToken(request);
  const secretKey = env.CLERK_SECRET_KEY;
  if (!token || !secretKey) return null;

  const parties = (env.CLERK_AUTHORIZED_PARTIES ?? new URL(request.url).origin)
    .split(",")
    .map((party) => party.trim())
    .filter(Boolean);

  try {
    const claims = await verifyToken(token, {
      secretKey,
      authorizedParties: parties,
    });
    return typeof claims.sub === "string" && claims.sub ? claims.sub : null;
  } catch {
    return null;
  }
}

async function verifiedPrimaryEmail(
  userId: string,
  secretKey: string,
): Promise<string | null> {
  const response = await fetch(
    `https://api.clerk.com/v1/users/${encodeURIComponent(userId)}`,
    { headers: { authorization: `Bearer ${secretKey}` } },
  );
  if (!response.ok) return null;
  const user = (await response.json()) as {
    primary_email_address_id?: unknown;
    email_addresses?: Array<{
      id?: unknown;
      email_address?: unknown;
      verification?: { status?: unknown } | null;
    }>;
  };
  const primary = user.email_addresses?.find(
    (email) => email.id === user.primary_email_address_id,
  );
  if (
    typeof primary?.email_address !== "string" ||
    primary.verification?.status !== "verified"
  ) {
    return null;
  }
  return primary.email_address.trim().toLocaleLowerCase("en-US");
}

export async function getAuthContext(
  request: Request,
  env: WorkerEnv,
): Promise<AuthContext | null> {
  const userId = await verifiedUserId(request, env);
  if (!userId) return null;

  const secretKey = env.CLERK_SECRET_KEY;
  if (!secretKey) return null;
  const email = await verifiedPrimaryEmail(userId, secretKey);
  const allowedEmails = new Set(
    (env.ZERO3_ALLOWED_EMAILS ?? "")
      .split(",")
      .map((value) => value.trim().toLocaleLowerCase("en-US"))
      .filter(Boolean),
  );

  return {
    userId,
    email,
    authorized: Boolean(email && allowedEmails.has(email)),
  };
}

export async function proxyClerkRequest(
  request: Request,
  env: WorkerEnv,
): Promise<Response> {
  if (!env.CLERK_SECRET_KEY) {
    return Response.json({ error: "Proxy Clerk não configurado." }, { status: 503 });
  }

  const incomingUrl = new URL(request.url);
  const proxyPath = "/api/__clerk";
  const upstreamPath = incomingUrl.pathname.slice(proxyPath.length) || "/";
  const upstream = new URL(upstreamPath + incomingUrl.search, "https://frontend-api.clerk.dev");
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.set("Clerk-Proxy-Url", `${incomingUrl.origin}${proxyPath}`);
  headers.set("Clerk-Secret-Key", env.CLERK_SECRET_KEY);

  const clientIp = request.headers.get("cf-connecting-ip");
  if (clientIp) headers.set("X-Forwarded-For", clientIp);

  return fetch(
    new Request(upstream, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      redirect: "manual",
    }),
  );
}
