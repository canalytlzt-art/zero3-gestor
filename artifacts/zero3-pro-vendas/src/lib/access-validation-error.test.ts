import assert from "node:assert/strict";
import test from "node:test";
import { accessValidationError } from "./access-validation-error";

test("identifies missing Cloudflare Worker settings without requesting secret values", () => {
  const cases = [
    ["clerk_secret_missing", "CLERK_SECRET_KEY"],
    ["clerk_jwt_key_missing", "CLERK_JWT_KEY"],
    ["clerk_issuer_missing_or_invalid", "CLERK_ISSUER"],
    ["clerk_authorized_parties_missing", "CLERK_AUTHORIZED_PARTIES"],
    ["admin_allowlist_missing", "ZERO3_ALLOWED_EMAILS"],
  ];

  for (const [code, setting] of cases) {
    const result = accessValidationError({
      status: 503,
      data: { code, error: "sensitive response details must not be displayed" },
    });

    assert.match(result.message, new RegExp(setting));
    assert.match(result.message, /Cloudflare > Workers & Pages/);
    assert.match(result.message, /Variables and Secrets/);
    assert.equal(result.message.includes("sensitive response details"), false);
  }
});

test("distinguishes unauthorized origins and a mismatched Clerk instance", () => {
  const origin = accessValidationError({
    status: 403,
    data: { code: "request_origin_not_authorized" },
  });
  assert.match(origin.message, /CLERK_AUTHORIZED_PARTIES/);

  const mismatch = accessValidationError({
    status: 401,
    data: { code: "clerk_instance_mismatch" },
  });
  assert.match(mismatch.message, /mesma instância Development/);
  assert.match(mismatch.message, /CLERK_JWT_KEY/);
});

test("keeps the user-facing error safe while preserving status and code diagnostics", () => {
  const result = accessValidationError({
    status: 503,
    data: {
      code: "unknown_failure",
      error: "session-cookie=secret-token",
    },
  });

  assert.match(result.message, /Consulte os logs do Worker/);
  assert.equal(result.message.includes("secret-token"), false);
  assert.equal(result.detail, "GET /api/access-status · HTTP 503 · unknown_failure");
});
