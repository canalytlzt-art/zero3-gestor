import { verifyToken } from "@clerk/backend";
import {
  TokenVerificationError,
  TokenVerificationErrorReason,
} from "@clerk/backend/errors";
import type { AuthContext, WorkerEnv } from "./types";

type AuthFailure = {
  ok: false;
  status: number;
  code: string;
  message: string;
  upstreamStatus?: number;
  verificationReason?: string;
};

type AuthValidation =
  | { ok: true; context: AuthContext }
  | AuthFailure;

type EmailValidation =
  | { ok: true; email: string }
  | AuthFailure;

const authFailure = (
  status: number,
  code: string,
  message: string,
  upstreamStatus?: number,
  verificationReason?: string,
): AuthFailure => ({
  ok: false,
  status,
  code,
  message,
  ...(upstreamStatus === undefined ? {} : { upstreamStatus }),
  ...(verificationReason === undefined ? {} : { verificationReason }),
});

const verifierInfrastructureReasons = new Set<string>([
  TokenVerificationErrorReason.InvalidSecretKey,
  TokenVerificationErrorReason.RemoteJWKFailedToLoad,
  TokenVerificationErrorReason.RemoteJWKInvalid,
  TokenVerificationErrorReason.RemoteJWKMissing,
  TokenVerificationErrorReason.JWKFailedToResolve,
]);

function safeJwksUpstreamStatus(error: TokenVerificationError): number | undefined {
  const match = /^Error loading Clerk JWKS from https:\/\/\S+ with code=(\d{3})$/.exec(
    error.message,
  );
  if (!match) return undefined;
  const status = Number(match[1]);
  return status >= 100 && status <= 599 ? status : undefined;
}

export function classifyTokenVerificationFailure(error: unknown): AuthFailure {
  if (!(error instanceof TokenVerificationError)) {
    return authFailure(
      503,
      "clerk_verification_unavailable",
      "Não foi possível validar a sessão no momento. Tente novamente mais tarde.",
      undefined,
      "unclassified_verifier_error",
    );
  }

  const verificationReason = error.reason;

  if (verificationReason === TokenVerificationErrorReason.TokenExpired) {
    return authFailure(
      401,
      "session_expired",
      "Sua sessão expirou. Entre novamente.",
      undefined,
      verificationReason,
    );
  }

  if (verifierInfrastructureReasons.has(verificationReason)) {
    return authFailure(
      503,
      "clerk_verification_unavailable",
      "Não foi possível validar a sessão no momento. Tente novamente mais tarde.",
      safeJwksUpstreamStatus(error),
      verificationReason,
    );
  }

  return authFailure(
    401,
    "session_invalid",
    "A sessão não pôde ser validada. Entre novamente.",
    undefined,
    verificationReason,
  );
}

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

function parseHttpsOrigin(value: string, allowLocalHttp = false): string | null {
  try {
    const parsed = new URL(value);
    const isLoopback = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
    if (
      (parsed.protocol !== "https:" &&
        !(allowLocalHttp && parsed.protocol === "http:" && isLoopback)) ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

function configuredAuthorizedOrigins(value: string | undefined): Set<string> {
  const entries = (value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
  const origins = new Set<string>();
  for (const entry of entries) {
    const origin = parseHttpsOrigin(entry, true);
    if (!origin) return new Set();
    origins.add(origin);
  }
  return origins;
}

function requestOrigin(
  request: Request,
  env: WorkerEnv,
): string | AuthFailure {
  const configuredOrigins = configuredAuthorizedOrigins(env.CLERK_AUTHORIZED_PARTIES);
  if (configuredOrigins.size === 0) {
    return authFailure(
      503,
      "clerk_authorized_parties_missing",
      "As origens autorizadas do Clerk não estão configuradas no Worker.",
    );
  }

  const originHeader = request.headers.get("origin");
  const stateChangingMethod = ["POST", "PUT", "PATCH", "DELETE"].includes(
    request.method.toUpperCase(),
  );
  const hasClerkSessionCookie = Boolean(
    cookieValue(request, "__session") ??
      cookieValue(request, "__session_legacy"),
  );
  if (stateChangingMethod && hasClerkSessionCookie && !originHeader) {
    return authFailure(
      403,
      "request_origin_required",
      "Operações com sessão Clerk por cookie exigem uma origem explícita.",
    );
  }

  let origin: string | null = null;
  if (originHeader) {
    origin = parseHttpsOrigin(originHeader, true);
  } else {
    origin = parseHttpsOrigin(new URL(request.url).origin, true);
  }
  if (!origin || !configuredOrigins.has(origin)) {
    return authFailure(
      403,
      "request_origin_not_authorized",
      "A origem desta requisição não está autorizada.",
    );
  }
  return origin;
}

export function sessionToken(request: Request): string | null {
  // The web app authenticates with Clerk's same-origin session cookie.
  // Prefer it over an incidental Authorization header; bearer remains a fallback
  // for clients that cannot send browser cookies.
  const cookie = cookieValue(request, "__session") ??
    cookieValue(request, "__session_legacy");
  if (cookie) return cookie;

  const bearer = request.headers.get("authorization");
  if (bearer?.startsWith("Bearer ")) return bearer.slice(7).trim() || null;
  return null;
}

async function verifiedUserId(
  request: Request,
  jwtKey: string,
  issuer: string,
  authorizedOrigin: string,
): Promise<string | AuthFailure> {
  const token = sessionToken(request);
  if (!token) {
    return authFailure(
      401,
      "session_missing",
      "O Worker não recebeu uma sessão Clerk. Entre novamente.",
    );
  }

  try {
    const claims = await verifyToken(token, {
      jwtKey,
      issuer,
      authorizedParties: [authorizedOrigin],
    });
    return typeof claims.sub === "string" && claims.sub
      ? claims.sub
      : authFailure(401, "session_invalid", "A sessão Clerk não contém um usuário válido. Entre novamente.");
  } catch (error) {
    return classifyTokenVerificationFailure(error);
  }
}

async function verifiedPrimaryEmail(
  userId: string,
  secretKey: string,
): Promise<EmailValidation> {
  let response: Response;
  try {
    response = await fetch(
      `https://api.clerk.com/v1/users/${encodeURIComponent(userId)}`,
      { headers: { authorization: `Bearer ${secretKey}` } },
    );
  } catch {
    return authFailure(
      503,
      "clerk_unavailable",
      "Não foi possível conectar à API do Clerk para verificar o usuário.",
    );
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      return authFailure(
        503,
        "clerk_secret_rejected",
        "O Clerk rejeitou a chave secreta configurada no Worker.",
        response.status,
      );
    }
    if (response.status === 404) {
      return authFailure(
        401,
        "clerk_instance_mismatch",
        "O usuário da sessão não existe na instância Clerk consultada pelo Worker.",
        response.status,
      );
    }
    if (response.status === 429 || response.status >= 500) {
      return authFailure(
        503,
        "clerk_unavailable",
        "A API do Clerk está temporariamente indisponível.",
        response.status,
      );
    }
    return authFailure(
      502,
      "clerk_user_lookup_failed",
      "O Clerk não conseguiu confirmar o usuário autenticado.",
      response.status,
    );
  }

  let user: {
    primary_email_address_id?: unknown;
    email_addresses?: Array<{
      id?: unknown;
      email_address?: unknown;
      verification?: { status?: unknown } | null;
    }>;
  };
  try {
    user = (await response.json()) as typeof user;
  } catch {
    return authFailure(
      502,
      "clerk_user_response_invalid",
      "O Clerk retornou uma resposta inválida ao consultar o usuário.",
      response.status,
    );
  }

  const primary = user.email_addresses?.find(
    (email) => email.id === user.primary_email_address_id,
  );
  if (
    typeof primary?.email_address !== "string" ||
    primary.verification?.status !== "verified"
  ) {
    return authFailure(
      403,
      "verified_email_required",
      "A conta Clerk precisa ter um e-mail principal verificado.",
    );
  }
  return {
    ok: true,
    email: primary.email_address.trim().toLocaleLowerCase("en-US"),
  };
}

export async function getAuthContext(
  request: Request,
  env: WorkerEnv,
): Promise<AuthValidation> {
  const secretKey = env.CLERK_SECRET_KEY;
  if (!secretKey) {
    return authFailure(
      503,
      "clerk_secret_missing",
      "A chave secreta do Clerk não está configurada no Worker.",
    );
  }

  const jwtKey = env.CLERK_JWT_KEY?.trim();
  if (!jwtKey) {
    return authFailure(
      503,
      "clerk_jwt_key_missing",
      "A chave pública JWT do Clerk não está configurada no Worker.",
    );
  }

  const issuer = parseHttpsOrigin(env.CLERK_ISSUER ?? "");
  if (!issuer) {
    return authFailure(
      503,
      "clerk_issuer_missing_or_invalid",
      "O emissor Clerk não está configurado corretamente no Worker.",
    );
  }

  const authorizedOrigin = requestOrigin(request, env);
  if (typeof authorizedOrigin !== "string") return authorizedOrigin;

  const verifiedId = await verifiedUserId(
    request,
    jwtKey,
    issuer,
    authorizedOrigin,
  );
  if (typeof verifiedId !== "string") return verifiedId;

  const emailResult = await verifiedPrimaryEmail(verifiedId, secretKey);
  if (!emailResult.ok) return emailResult;

  const allowedEmails = new Set(
    (env.ZERO3_ALLOWED_EMAILS ?? "")
      .split(",")
      .map((value) => value.trim().toLocaleLowerCase("en-US"))
      .filter(Boolean),
  );
  if (allowedEmails.size === 0) {
    return authFailure(
      503,
      "admin_allowlist_missing",
      "A lista de administradores não está configurada no Worker.",
    );
  }

  return {
    ok: true,
    context: {
      userId: verifiedId,
      email: emailResult.email,
      authorized: allowedEmails.has(emailResult.email),
    },
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
