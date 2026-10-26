import assert from "node:assert/strict";
import test from "node:test";
import {
  TokenVerificationError,
  TokenVerificationErrorReason,
} from "@clerk/backend/errors";
import { apiError } from "./http";
import { classifyTokenVerificationFailure } from "./auth";

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

test("classifies Clerk key-service failures separately from invalid sessions", () => {
  const failure = classifyTokenVerificationFailure(
    new TokenVerificationError({
      reason: TokenVerificationErrorReason.RemoteJWKFailedToLoad,
      message: "sensitive upstream response must not leave the verifier",
    }),
  );

  assert.equal(failure.status, 503);
  assert.equal(failure.code, "clerk_verification_unavailable");
  assert.equal(
    failure.verificationReason,
    TokenVerificationErrorReason.RemoteJWKFailedToLoad,
  );
  assert.equal(JSON.stringify(failure).includes("sensitive upstream response"), false);
});
