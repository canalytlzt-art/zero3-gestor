import assert from "node:assert/strict";
import test from "node:test";
import { sessionToken } from "./auth";

test("prefers the Clerk session cookie over an Authorization bearer token", () => {
  const request = new Request("https://zero3.example/api/access-status", {
    headers: {
      cookie: "__session=clerk-session",
      authorization: "Bearer unrelated-bearer",
    },
  });

  assert.equal(sessionToken(request), "clerk-session");
});

test("prefers the legacy Clerk session cookie over a bearer token", () => {
  const request = new Request("https://zero3.example/api/access-status", {
    headers: {
      cookie: "__session_legacy=legacy-session",
      authorization: "Bearer unrelated-bearer",
    },
  });

  assert.equal(sessionToken(request), "legacy-session");
});

test("uses the bearer token when no Clerk session cookie is present", () => {
  const request = new Request("https://zero3.example/api/access-status", {
    headers: { authorization: "Bearer native-client-token" },
  });

  assert.equal(sessionToken(request), "native-client-token");
});

test("returns null when neither a Clerk cookie nor bearer token exists", () => {
  const request = new Request("https://zero3.example/api/access-status");

  assert.equal(sessionToken(request), null);
});
