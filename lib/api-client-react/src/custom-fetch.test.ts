import assert from "node:assert/strict";
import test from "node:test";
import { customFetch, setAuthTokenGetter } from "./custom-fetch";

test("uses same-origin credentials and sends no bearer header by default", async () => {
  const originalFetch = globalThis.fetch;
  let capturedInit: RequestInit | undefined;
  setAuthTokenGetter(null);
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    capturedInit = init;
    return new Response(JSON.stringify({ authorized: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const response = await customFetch<{ authorized: boolean }>("/api/access-status");

    assert.deepEqual(response, { authorized: true });
    assert.equal(capturedInit?.credentials, "same-origin");
    assert.equal(new Headers(capturedInit?.headers).has("authorization"), false);
  } finally {
    globalThis.fetch = originalFetch;
    setAuthTokenGetter(null);
  }
});

test("adds a bearer token only when an explicit token getter is configured", async () => {
  const originalFetch = globalThis.fetch;
  let capturedInit: RequestInit | undefined;
  setAuthTokenGetter(() => "explicit-mobile-token");
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    capturedInit = init;
    return new Response(JSON.stringify({ authorized: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    await customFetch<{ authorized: boolean }>("/api/access-status");

    assert.equal(
      new Headers(capturedInit?.headers).get("authorization"),
      "Bearer explicit-mobile-token",
    );
  } finally {
    globalThis.fetch = originalFetch;
    setAuthTokenGetter(null);
  }
});
