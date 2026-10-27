import assert from "node:assert/strict";
import { generateKeyPairSync, sign as signJwt } from "node:crypto";
import test from "node:test";
import {
  TokenVerificationError,
  TokenVerificationErrorReason,
} from "@clerk/backend/errors";
import { apiError } from "./http";
import { classifyTokenVerificationFailure, getAuthContext } from "./auth";
import worker from "./index";
import type { WorkerEnv } from "./types";

const testIssuer = "https://zero3-development.clerk.accounts.dev";
const testOrigin = "https://zero3.example";
const testKeyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const testPublicKey = testKeyPair.publicKey
  .export({ type: "spki", format: "pem" })
  .toString();

function makeSessionToken(claimOverrides: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", typ: "JWT", kid: "test-key-id" }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      azp: testOrigin,
      exp: now + 300,
      iat: now,
      iss: testIssuer,
      sub: "user_test",
      ...claimOverrides,
    }),
  ).toString("base64url");
  const unsignedToken = `${header}.${payload}`;
  const signature = signJwt(
    "RSA-SHA256",
    Buffer.from(unsignedToken),
    testKeyPair.privateKey,
  ).toString("base64url");
  return `${unsignedToken}.${signature}`;
}

function makeWorkerEnv(overrides: Partial<WorkerEnv> = {}): WorkerEnv {
  return {
    DB: {} as WorkerEnv["DB"],
    ASSETS: {} as WorkerEnv["ASSETS"],
    CLERK_SECRET_KEY: "test-secret-only",
    CLERK_JWT_KEY: testPublicKey,
    CLERK_ISSUER: testIssuer,
    CLERK_AUTHORIZED_PARTIES: testOrigin,
    ZERO3_ALLOWED_EMAILS: "admin@example.test",
    ...overrides,
  };
}

function workerRequest(path: string, token?: string, origin = testOrigin): Request {
  const headers = new Headers({ origin });
  if (token) headers.set("cookie", `__session=${token}`);
  return new Request(`${testOrigin}${path}`, { headers });
}

function requestWithSession(token: string, origin = testOrigin): Request {
  return workerRequest("/api/access-status", token, origin);
}

function mockClerkUserLookup(email: string): {
  requests: string[];
  restore: () => void;
} {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requests.push(String(input));
    return Response.json({
      primary_email_address_id: "email_test",
      email_addresses: [{
        id: "email_test",
        email_address: email,
        verification: { status: "verified" },
      }],
    });
  }) as typeof fetch;
  return {
    requests,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

test("classifies an expired Clerk session without exposing the SDK error message", async () => {
  const failure = classifyTokenVerificationFailure(
    new TokenVerificationError({
      reason: TokenVerificationErrorReason.TokenExpired,
      message: "sensitive token details must not leave the verifier",
    }),
  );

  assert.equal(failure.status, 401);
  assert.equal(failure.code, "session_expired");
  assert.equal(failure.verificationReason, TokenVerificationErrorReason.TokenExpired);
  assert.equal(JSON.stringify(failure).includes("sensitive token details"), false);

  const responseBody = await apiError(failure.status, failure.message, failure.code).json();
  assert.deepEqual(responseBody, {
    error: "Sua sessão expirou. Entre novamente.",
    code: "session_expired",
  });
});

test("classifies invalid signatures as invalid sessions", () => {
  const failure = classifyTokenVerificationFailure(
    new TokenVerificationError({
      reason: TokenVerificationErrorReason.TokenInvalidSignature,
      message: "sensitive token details must not leave the verifier",
    }),
  );

  assert.equal(failure.status, 401);
  assert.equal(failure.code, "session_invalid");
  assert.equal(failure.verificationReason, TokenVerificationErrorReason.TokenInvalidSignature);
  assert.equal(JSON.stringify(failure).includes("sensitive token details"), false);
});

test("classifies Clerk key-service failures and keeps only the safe upstream status", () => {
  const failure = classifyTokenVerificationFailure(
    new TokenVerificationError({
      reason: TokenVerificationErrorReason.RemoteJWKFailedToLoad,
      message:
        "Error loading Clerk JWKS from https://api.clerk.com/v1/jwks with code=503",
    }),
  );

  assert.equal(failure.status, 503);
  assert.equal(failure.code, "clerk_verification_unavailable");
  assert.equal(failure.upstreamStatus, 503);
  assert.equal(
    failure.verificationReason,
    TokenVerificationErrorReason.RemoteJWKFailedToLoad,
  );
  assert.equal(JSON.stringify(failure).includes("api.clerk.com"), false);
  assert.equal(JSON.stringify(failure).includes("CLERK_SECRET_KEY"), false);
});

test("classifies an explicitly rejected Clerk secret without exposing SDK details", () => {
  const failure = classifyTokenVerificationFailure(
    new TokenVerificationError({
      reason: TokenVerificationErrorReason.InvalidSecretKey,
      message: "secret value must never be logged",
    }),
  );

  assert.equal(failure.status, 503);
  assert.equal(failure.verificationReason, TokenVerificationErrorReason.InvalidSecretKey);
  assert.equal(failure.upstreamStatus, undefined);
  assert.equal(JSON.stringify(failure).includes("secret value"), false);
});

test("verifies a local Clerk JWT offline with its signature, issuer, expiry, and request origin", async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requests.push(String(input));
    return Response.json({
      primary_email_address_id: "email_test",
      email_addresses: [{
        id: "email_test",
        email_address: "admin@example.test",
        verification: { status: "verified" },
      }],
    });
  }) as typeof fetch;

  try {
    const result = await getAuthContext(
      requestWithSession(makeSessionToken()),
      makeWorkerEnv(),
    );

    assert.deepEqual(result, {
      ok: true,
      context: {
        userId: "user_test",
        email: "admin@example.test",
        authorized: true,
      },
    });
    // Local JWT verification makes no JWKS request; only the existing user lookup remains.
    assert.deepEqual(requests, ["https://api.clerk.com/v1/users/user_test"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects a local JWT signed for another Clerk issuer before user lookup", async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requests.push(String(input));
    return Response.json({});
  }) as typeof fetch;

  try {
    const result = await getAuthContext(
      requestWithSession(makeSessionToken({
        iss: "https://another-instance.clerk.accounts.dev",
      })),
      makeWorkerEnv(),
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 401);
      assert.equal(result.code, "session_invalid");
    }
    assert.deepEqual(requests, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects expired local JWTs before user lookup", async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requests.push(String(input));
    return Response.json({});
  }) as typeof fetch;

  try {
    const result = await getAuthContext(
      requestWithSession(makeSessionToken({
        exp: Math.floor(Date.now() / 1000) - 60,
      })),
      makeWorkerEnv(),
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 401);
      assert.equal(result.code, "session_expired");
    }
    assert.deepEqual(requests, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects a forged local JWT signature before user lookup", async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requests.push(String(input));
    return Response.json({});
  }) as typeof fetch;

  try {
    const token = makeSessionToken();
    const [header, payload, signature] = token.split(".");
    const changedSignature = `${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
    const result = await getAuthContext(
      requestWithSession(`${header}.${payload}.${changedSignature}`),
      makeWorkerEnv(),
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 401);
      assert.equal(result.code, "session_invalid");
    }
    assert.deepEqual(requests, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects a JWT whose authorized party differs from the request origin", async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requests.push(String(input));
    return Response.json({});
  }) as typeof fetch;

  try {
    const result = await getAuthContext(
      requestWithSession(makeSessionToken({
        azp: "https://untrusted.example",
      })),
      makeWorkerEnv(),
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 401);
      assert.equal(result.code, "session_invalid");
    }
    assert.deepEqual(requests, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects request origins outside the explicit Clerk allowlist", async () => {
  const result = await getAuthContext(
    requestWithSession(makeSessionToken(), "https://untrusted.example"),
    makeWorkerEnv(),
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 403);
    assert.equal(result.code, "request_origin_not_authorized");
  }
});

test("fails closed when the local Clerk public key is not configured", async () => {
  const result = await getAuthContext(
    requestWithSession(makeSessionToken()),
    makeWorkerEnv({ CLERK_JWT_KEY: undefined }),
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 503);
    assert.equal(result.code, "clerk_jwt_key_missing");
  }
});

test("GET /api/access-status grants access to a signed-in allowlisted administrator", async () => {
  const mock = mockClerkUserLookup("admin@example.test");
  try {
    const response = await worker.fetch(
      requestWithSession(makeSessionToken()),
      makeWorkerEnv(),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      authorized: true,
      code: "authorized",
    });
    assert.deepEqual(mock.requests, ["https://api.clerk.com/v1/users/user_test"]);
  } finally {
    mock.restore();
  }
});

test("GET /api/healthz is an unauthenticated JSON health check", async () => {
  const response = await worker.fetch(
    new Request(`${testOrigin}/api/healthz`),
    makeWorkerEnv(),
  );

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /application\/json/);
  assert.deepEqual(await response.json(), { status: "ok" });
});

test("unknown API roots return a JSON 404 without requiring a Clerk session", async () => {
  for (const path of ["/api", "/api/no-such-api"]) {
    const response = await worker.fetch(
      new Request(`${testOrigin}${path}`),
      makeWorkerEnv(),
    );

    assert.equal(response.status, 404);
    assert.match(response.headers.get("content-type") ?? "", /application\/json/);
    assert.deepEqual(await response.json(), {
      error: "Rota não encontrada.",
      code: "route_not_found",
    });
  }
});

test("unknown routes under a protected API root return a JSON 404 after authorization", async () => {
  const mock = mockClerkUserLookup("admin@example.test");
  try {
    const response = await worker.fetch(
      workerRequest("/api/sales/no-such-route", makeSessionToken()),
      makeWorkerEnv(),
    );

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), {
      error: "Rota não encontrada.",
      code: "route_not_found",
    });
  } finally {
    mock.restore();
  }
});

test("GET /api/access-status returns 401 when the session token is absent", async () => {
  const response = await worker.fetch(
    workerRequest("/api/access-status"),
    makeWorkerEnv(),
  );

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), {
    error: "O Worker não recebeu uma sessão Clerk. Entre novamente.",
    code: "session_missing",
  });
});

test("GET /api/access-status rejects invalid and expired session tokens", async () => {
  const validToken = makeSessionToken();
  const [header, payload, signature] = validToken.split(".");
  const tamperedToken =
    `${header}.${payload}.${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
  const invalidResponse = await worker.fetch(
    requestWithSession(tamperedToken),
    makeWorkerEnv(),
  );
  assert.equal(invalidResponse.status, 401);
  assert.deepEqual(await invalidResponse.json(), {
    error: "A sessão não pôde ser validada. Entre novamente.",
    code: "session_invalid",
  });

  const expiredResponse = await worker.fetch(
    requestWithSession(makeSessionToken({
      exp: Math.floor(Date.now() / 1000) - 60,
    })),
    makeWorkerEnv(),
  );
  assert.equal(expiredResponse.status, 401);
  assert.deepEqual(await expiredResponse.json(), {
    error: "Sua sessão expirou. Entre novamente.",
    code: "session_expired",
  });
});

test("GET /api/access-status preserves ZERO3_ALLOWED_EMAILS and blocks non-admin routes", async () => {
  const mock = mockClerkUserLookup("staff@example.test");
  try {
    const statusResponse = await worker.fetch(
      requestWithSession(makeSessionToken()),
      makeWorkerEnv({ ZERO3_ALLOWED_EMAILS: "admin@example.test" }),
    );
    assert.equal(statusResponse.status, 200);
    assert.deepEqual(await statusResponse.json(), {
      authorized: false,
      code: "admin_not_allowlisted",
    });

    const protectedResponse = await worker.fetch(
      workerRequest("/api/sales", makeSessionToken()),
      makeWorkerEnv({ ZERO3_ALLOWED_EMAILS: "admin@example.test" }),
    );
    assert.equal(protectedResponse.status, 403);
    assert.deepEqual(await protectedResponse.json(), {
      error: "Acesso restrito à equipe autorizada.",
      code: "admin_not_allowlisted",
    });
    // D1 is a throwing stub with no methods; reaching the route handler would fail this assertion.
    assert.deepEqual(mock.requests, [
      "https://api.clerk.com/v1/users/user_test",
      "https://api.clerk.com/v1/users/user_test",
    ]);
  } finally {
    mock.restore();
  }
});
