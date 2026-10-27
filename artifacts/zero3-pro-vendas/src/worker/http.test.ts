import assert from "node:assert/strict";
import test from "node:test";
import { routeError } from "./http";

test("database schema failures have a useful safe response and structured diagnostics", async () => {
  const logged: string[] = [];
  const previousError = console.error;
  console.error = (entry?: unknown) => logged.push(String(entry));

  try {
    const request = new Request(
      "https://zero3.test/api/sales?customer=private-query-value",
      {
        method: "POST",
        headers: { "cf-ray": "test-ray-id" },
      },
    );
    const response = routeError(new Error("D1_ERROR: no such table: sales"), request);
    const payload = await response.json() as { error: string; code: string };

    assert.equal(response.status, 503);
    assert.equal(payload.code, "database_schema_unavailable");
    assert.match(payload.error, /banco ainda não está preparado/i);
    assert.doesNotMatch(JSON.stringify(payload), /no such table|sales/);
    assert.equal(logged.length, 1);
    assert.match(logged[0]!, /"route":"sales"/);
    assert.match(logged[0]!, /"failureCategory":"database_schema_unavailable"/);
    assert.match(logged[0]!, /"rayId":"test-ray-id"/);
    assert.doesNotMatch(logged[0]!, /private-query-value|no such table|D1_ERROR/);
  } finally {
    console.error = previousError;
  }
});

test("unexpected internal errors get a request-safe message and correlation code", async () => {
  const logged: string[] = [];
  const previousError = console.error;
  console.error = (entry?: unknown) => logged.push(String(entry));

  try {
    const response = routeError(
      new Error("unexpected detail with private value"),
      new Request("https://zero3.test/api/occupancy", {
        method: "POST",
        headers: { "cf-ray": "occupancy-ray-id" },
      }),
    );
    const payload = await response.json() as { error: string; code: string };

    assert.equal(response.status, 500);
    assert.equal(payload.code, "api_internal_error");
    assert.match(payload.error, /não foi possível concluir esta operação/i);
    assert.doesNotMatch(JSON.stringify(payload), /unexpected detail|private value/);
    assert.match(logged[0]!, /"route":"occupancy"/);
    assert.doesNotMatch(logged[0]!, /unexpected detail|private value/);
  } finally {
    console.error = previousError;
  }
});
